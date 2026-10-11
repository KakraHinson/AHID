/**
 * Hubtel data vending provider.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANY URL IN THIS FILE
 * ---------------------------------------------------------------------------
 * Every endpoint here is read from an environment secret. None of them is
 * hardcoded, and that is deliberate rather than cautious:
 *
 * Hubtel's developer portal is a login-gated SPA, so the data-vending
 * endpoints cannot be read without an account. What is publicly documented
 * disagrees with itself - the merchant/pay-point API is at
 * payproxyapi.hubtel.com, the mobile-money API is at api.hubtel.com, the
 * gateway sample credential is base64 of a bare token, and the commission
 * services document describes per-network bundle endpoints with opaque
 * network-specific path segments. A probe of
 * `POST https://payproxyapi.hubtel.com/items/initiate` with merchant account
 * 11684 returned HTTP 401 for every auth shape tried (basic base64(key),
 * base64(key + ':'), base64(key + ':' + key), bearer, and no Authorization
 * header at all) - and 401 with no header means those responses cannot even
 * distinguish "wrong key" from "wrong auth style".
 *
 * So a URL written into this file would be a guess, and a guessed URL against
 * a live merchant account is how you spend real money on nothing. Instead the
 * shape is configured once via `supabase secrets set` (see
 * HUBTEL_DATA_SETUP.md) and this module fails closed when it is not
 * configured: `hubtelConfigured()` returns false and every purchase is
 * refused *before* the wallet is touched.
 *
 * Both plausible auth schemes are supported, because which one applies is a
 * property of the account we were issued:
 *   - OAuth2 client_credentials, when HUBTEL_TOKEN_URL is set.
 *   - Direct credentials on the resource call, when it is not, selected by
 *     HUBTEL_AUTH_SCHEME (basic | bearer).
 *
 * Nothing in this module logs a credential, and nothing returns a provider
 * body that has not been through `safeHubtelFields()` - the raw payloads have
 * carried an `identity` object with the API key in them before, and storing
 * one verbatim is how that key ended up in a database.
 */

import { hubtelResponseState } from './paymentGateway.ts';

export interface HubtelConfig {
  clientId: string;
  clientSecret: string;
  merchantAccount: string;
  tokenUrl?: string;
  bundlesUrl?: string;
  purchaseUrl?: string;
  statusUrl?: string;
  authScheme: 'basic' | 'bearer';
  scope?: string;
}

export interface HubtelBundle {
  /** The provider's own bundle identifier. This is what a purchase sends. */
  packageId: string;
  name: string;
  network: string;
  /** What Hubtel charges us, in GHS. */
  costGhs: number;
  raw: Record<string, unknown>;
}

export interface HubtelPurchaseResult {
  success: boolean;
  /** Hubtel's own order/transaction identifier, when it returns one. */
  orderId?: string;
  /** Hubtel's own status wording, passed through untouched. */
  status?: string;
  /** Whitelisted, credential-free copy of the response. Safe to persist. */
  payload: Record<string, unknown>;
  failureReason?: string;
}

export interface HubtelStatusResult {
  state: 'success' | 'failed' | 'pending';
  status: string;
  orderId?: string;
  payload: Record<string, unknown>;
}

const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * True when enough secrets are present to attempt a provider call. Callers must
 * check this before charging anything: "provider not configured" and "provider
 * declined" are different outcomes and only the second one is worth a refund
 * after a delivery attempt.
 */
export function hubtelConfigured(): boolean {
  const config = readHubtelConfig();
  return Boolean(config?.clientId && config.clientSecret && config.purchaseUrl);
}

function readHubtelConfig(): HubtelConfig | null {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;

  const scheme = String(Deno.env.get('HUBTEL_AUTH_SCHEME')?.trim() || 'basic').toLowerCase();

  return {
    clientId,
    clientSecret,
    merchantAccount: Deno.env.get('HUBTEL_MERCHANT_ACCOUNT')?.trim() || '',
    tokenUrl: Deno.env.get('HUBTEL_TOKEN_URL')?.trim() || undefined,
    bundlesUrl: Deno.env.get('HUBTEL_DATA_BUNDLES_URL')?.trim() || undefined,
    purchaseUrl: Deno.env.get('HUBTEL_DATA_PURCHASE_URL')?.trim() || undefined,
    statusUrl: Deno.env.get('HUBTEL_DATA_STATUS_URL')?.trim() || undefined,
    authScheme: scheme === 'bearer' ? 'bearer' : 'basic',
    scope: Deno.env.get('HUBTEL_SCOPE')?.trim() || undefined,
  };
}

/** Throws with an operator-readable reason rather than calling a wrong URL. */
function requireConfig(): HubtelConfig {
  const config = readHubtelConfig();
  if (!config) {
    throw new Error('Hubtel is not configured. Set HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET and HUBTEL_DATA_PURCHASE_URL.');
  }
  if (!config.purchaseUrl) {
    throw new Error('Hubtel data purchase endpoint is not configured. Set HUBTEL_DATA_PURCHASE_URL.');
  }
  return config;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const timeoutMs = Number(Deno.env.get('HUBTEL_TIMEOUT_MS'));
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/**
 * Resolves the Authorization header for a resource call. Obtains an OAuth2
 * bearer token first when a token endpoint is configured, otherwise it puts the
 * account credentials straight on the request.
 */
async function authorizationHeader(config: HubtelConfig, url: string): Promise<string> {
  if (config.tokenUrl) {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
      return `Bearer ${cachedToken.value}`;
    }

    const form = new URLSearchParams({ grant_type: 'client_credentials' });
    if (config.scope) form.set('scope', config.scope);

    const response = await fetchWithTimeout(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      },
      body: form.toString(),
    });

    const payload = await readJson(response);
    const token = pickString(payload, ['access_token', 'accessToken', 'token']);
    if (!response.ok || !token) {
      // Logged without the body: a failed token response can echo the
      // submitted credential back, and this is a log the provider reads.
      console.error('Hubtel token request failed:', { status: response.status, url });
      throw new Error('Could not authenticate with Hubtel.');
    }

    const expiresIn = Number(pickString(payload, ['expires_in', 'expiresIn']));
    cachedToken = {
      value: token,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn - 60 : 300) * 1000,
    };
    return `Bearer ${token}`;
  }

  if (config.authScheme === 'bearer') return `Bearer ${config.clientId}`;
  return basicAuthHeader(config.clientId, config.clientSecret);
}

// ---------------------------------------------------------------------------
// Response handling
// ---------------------------------------------------------------------------

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

function pickString(payload: unknown, fields: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function pickNumber(payload: unknown, fields: string[]): number | undefined {
  const raw = pickString(payload, fields);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Finds the provider's order id, which Hubtel returns top-level on some
 * services and nested under `data` on others, e.g.
 * `{ "responseCode": "0001", "data": { "orderId": "..." } }`.
 */
function pickOrderId(payload: unknown): string | undefined {
  const direct = pickString(payload, ['transaction_id', 'TransactionId', 'transactionId', 'order_id', 'OrderId', 'reference', 'Reference']);
  if (direct) return direct;
  if (payload && typeof payload === 'object') {
    const body = payload as Record<string, unknown>;
    const data = body.data ?? body.Data;
    return pickString(data, ['orderId', 'OrderId', 'order_id', 'transactionId', 'TransactionId', 'reference', 'Reference']);
  }
  return undefined;
}

/**
 * Reduce a provider body to the fields we are willing to store.
 *
 * Everything else is dropped, including anything whose key looks like a
 * credential. This is not defensive formatting: the GrandTechHub integration
 * stored a whole response containing an `identity` object, and the resulting
 * leaked key had to be rotated and the stored rows scrubbed by migration
 * 20260930060000.
 */
export function safeHubtelFields(payload: unknown): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return safe;

  const allowed = [
    'status', 'Status', 'description', 'Description', 'message', 'Message',
    'response_code', 'ResponseCode', 'transaction_id', 'TransactionId',
    'transactionId', 'order_id', 'OrderId', 'reference', 'Reference',
    'client_reference', 'ClientReference', 'amount', 'Amount',
    'recipient', 'Recipient', 'network', 'Network', 'bundle', 'Bundle',
    'data_amount', 'DataAmount', 'phone_number', 'PhoneNumber',
  ];

  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    if (/(secret|password|api[-_]?key|token|identity|credential|authorization)/.test(lowered)) continue;

    // Some Hubtel services nest the order id under `data`, e.g.
    // `{ "responseCode": "0001", "data": { "orderId": "..." } }`. Flatten one
    // level so that survives, while still dropping anything credential-shaped.
    if (lowered === 'data' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
        const innerLower = innerKey.toLowerCase();
        if (/(secret|password|api[-_]?key|token|identity|credential|authorization)/.test(innerLower)) continue;
        if (!allowed.some((candidate) => candidate.toLowerCase() === innerLower)) continue;
        if (innerValue === null || typeof innerValue === 'object') continue;
        safe[innerKey] = innerValue;
      }
      continue;
    }

    if (!allowed.some((candidate) => candidate.toLowerCase() === lowered)) continue;
    if (value === null || typeof value === 'object') continue;
    safe[key] = value;
  }

  return safe;
}

const SUCCESS_WORDS = ['success', 'successful', 'accepted', 'completed', 'complete', 'delivered', 'ok'];
const FAILURE_WORDS = ['fail', 'failed', 'failure', 'declined', 'rejected', 'cancelled', 'canceled', 'error', 'invalid'];

/**
 * Classifies a Hubtel response. Prefers an explicit status field over the HTTP
 * code, because Hubtel returns 200 with a failure status for declined
 * transactions - trusting the HTTP code alone would mark undelivered bundles as
 * successful and keep the customer's money.
 */
function classify(payload: unknown, httpOk: boolean): { success: boolean; status: string; state: 'success' | 'pending' | 'failed' } {
  // Hubtel's newer services return a 4-digit `responseCode` where "0000" is
  // success and "0001" means accepted/pending - the final state arrives on a
  // callback. Any other code on an HTTP 200 is still a decline, so the code is
  // checked before the HTTP-status fallback. `0001` is not a failure: refunding
  // it would let a bundle that Hubtel is still delivering go out for free.
  const code = pickString(payload, ['responseCode', 'response_code', 'ResponseCode']);
  if (code) {
    // The 0000/0001 rule lives in one place (`paymentGateway.ts`) so the data
    // path and the payment path cannot disagree about what a code means.
    const state = hubtelResponseState(code) ?? 'failed';
    return { success: state !== 'failed', status: state === 'failed' ? code : state, state };
  }

  const status = pickString(payload, ['status', 'Status', 'response_code', 'ResponseCode', 'description', 'Description', 'message', 'Message']) || '';
  const normalized = status.toLowerCase();

  if (FAILURE_WORDS.some((word) => normalized.includes(word))) return { success: false, status, state: 'failed' };
  if (SUCCESS_WORDS.some((word) => normalized.includes(word))) return { success: true, status, state: 'success' };
  if (normalized) return { success: false, status, state: 'failed' };
  return httpOk
    ? { success: true, status: 'accepted', state: 'pending' }
    : { success: false, status: 'no response', state: 'failed' };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function packageRows(payload: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== 'object') return null;

  const body = payload as Record<string, unknown>;
  for (const field of ['data', 'Data', 'bundles', 'Bundles', 'packages', 'Packages', 'results', 'Results', 'items']) {
    if (Array.isArray(body[field])) return body[field] as Record<string, unknown>[];
  }
  return null;
}

/**
 * Reads Hubtel's bundle catalog, when a catalog endpoint is configured.
 *
 * This is advisory. The sellable catalog is `public.bundles`, which is only
 * marked available once a `hubtel_package_id` from *this* response has been
 * mapped onto a row, so an unexpected shape here cannot put an undeliverable
 * bundle on the storefront.
 */
export async function fetchHubtelBundles(network?: string): Promise<HubtelBundle[]> {
  const config = readHubtelConfig();
  if (!config?.bundlesUrl) return [];

  const url = new URL(config.bundlesUrl);
  if (network) url.searchParams.set('network', network);
  if (config.merchantAccount) url.searchParams.set('account', config.merchantAccount);

  const response = await fetchWithTimeout(url.toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: await authorizationHeader(config, url.toString()),
    },
  });

  const payload = await readJson(response);
  if (!response.ok) {
    console.error('Hubtel bundle catalog request failed:', { status: response.status, network });
    throw new Error('Hubtel bundle catalog request failed.');
  }

  const rows = packageRows(payload);
  if (!rows) {
    console.error('Hubtel bundle catalog shape was not recognised:', { network });
    throw new Error('Hubtel returned an unsupported bundle catalog response.');
  }

  return rows.map((row) => ({
    packageId: String(pickString(row, ['package_id', 'PackageId', 'bundle_id', 'BundleId', 'id', 'Id', 'value']) || ''),
    name: String(pickString(row, ['name', 'Name', 'description', 'Description', 'bundle', 'Bundle', 'title']) || ''),
    network: String(pickString(row, ['network', 'Network', 'operator']) || network || ''),
    costGhs: pickNumber(row, ['price', 'Price', 'amount', 'Amount', 'cost']) ?? Number.NaN,
    raw: row,
  })).filter((bundle) => bundle.packageId && bundle.name && Number.isFinite(bundle.costGhs) && bundle.costGhs > 0);
}

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

export interface HubtelPurchaseRequest {
  /** Our own reference. Sent as the provider's client reference for correlation. */
  reference: string;
  /** Ghanaian recipient in 0XXXXXXXXX form, as validated by the caller. */
  phone: string;
  /** Hubtel's bundle identifier, from bundles.hubtel_package_id. */
  packageId: string;
  /** Operator hint in Hubtel's own wording, when known. */
  hubtelNetwork?: string;
  /** What the customer is charged. Sent when the endpoint requires an amount. */
  amountGhs?: number;
}

/**
 * Places one data order with Hubtel.
 *
 * Never throws for a declined order: a decline is a normal outcome that the
 * caller turns into a refund plus a `failed` data_transactions row, so it is
 * returned as `success: false` with a reason. It does throw when the provider
 * cannot be reached or is not configured, because that is an infrastructure
 * problem and the caller must not treat it as a delivery failure.
 */
export async function buyHubtelBundle(request: HubtelPurchaseRequest): Promise<HubtelPurchaseResult> {
  let config: HubtelConfig;
  try {
    config = requireConfig();
  } catch (err) {
    // Not an infrastructure failure - it is a deployment failure. Surfaced so
    // the order is refused and the wallet is never debited for it.
    return {
      success: false,
      payload: { configuration: String((err as Error).message) },
      failureReason: String((err as Error).message),
    };
  }

  const body: Record<string, unknown> = {
    Destination: request.phone,
    PhoneNumber: request.phone,
    Bundle: request.packageId,
    ClientReference: request.reference,
  };
  if (config.merchantAccount) body.AccountNumber = config.merchantAccount;
  if (request.hubtelNetwork) body.Network = request.hubtelNetwork;
  if (Number.isFinite(request.amountGhs)) body.Amount = Number(request.amountGhs).toFixed(2);

  let response: Response;
  try {
    response = await fetchWithTimeout(config.purchaseUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: await authorizationHeader(config, config.purchaseUrl!),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Re-thrown, not converted to a decline: we do not know whether Hubtel took
    // the order, so this must not silently refund and let a bundle go free.
    console.error('Hubtel purchase request failed to complete:', { error: String(err), reference: request.reference });
    throw new Error('Could not reach Hubtel to place the data order.');
  }

  const payload = await readJson(response);
  const verdict = classify(payload, response.ok);
  const safe = safeHubtelFields(payload);

  return {
    success: verdict.success,
    orderId: pickOrderId(payload),
    status: verdict.status,
    payload: safe,
    failureReason: verdict.success
      ? undefined
      : pickString(payload, ['Description', 'description', 'Message', 'message', 'status', 'Status']) ||
        `Hubtel declined the data order (HTTP ${response.status}).`,
  };
}

/**
 * Polls delivery for an order already placed.
 *
 * Returns null when no status endpoint is configured or the provider cannot be
 * consulted, which the caller must read as "still unknown" and not as a
 * failure - refunding on an unknown status is how a delivered bundle gets paid
 * for twice.
 */
export async function fetchHubtelStatus(orderId: string): Promise<HubtelStatusResult | null> {
  const config = readHubtelConfig();
  if (!config?.statusUrl || !orderId) return null;

  const url = new URL(config.statusUrl);
  url.searchParams.set('transaction_id', orderId);
  if (config.merchantAccount) url.searchParams.set('account', config.merchantAccount);

  let response: Response;
  try {
    response = await fetchWithTimeout(url.toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: await authorizationHeader(config, url.toString()),
      },
    });
  } catch (err) {
    console.warn('Hubtel status request failed:', { error: String(err) });
    return null;
  }

  if (!response.ok) {
    console.warn('Hubtel status request returned an error:', { status: response.status });
    return null;
  }

  const payload = await readJson(response);
  const verdict = classify(payload, true);

  return { state: verdict.state, status: verdict.status, orderId, payload: safeHubtelFields(payload) };
}

/** Resets the cached OAuth token. Used by tests and after a credential rotation. */
export function resetHubtelTokenCache(): void {
  cachedToken = null;
}