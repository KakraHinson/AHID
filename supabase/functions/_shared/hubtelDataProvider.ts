/**
 * Hubtel data vending provider.
 *
 * ---------------------------------------------------------------------------
 * THE TWO COMMISSION SERVICES ENDPOINTS
 * ---------------------------------------------------------------------------
 * There are exactly two, and they are both derived from the account numbers
 * rather than typed in:
 *
 *   1. The service endpoint, where a data order is placed and where the
 *      bundle catalog is queried. One URL does both - POST to buy, GET with
 *      `?destination={msisdn}` to query what is sellable for that number:
 *        {BaseUrl}/{Disbursement_Account_Number}/{ServiceID}
 *      The path segment is the DISBURSEMENT (prepaid deposit) account, and
 *      each network's Data ServiceID is substituted per request.
 *
 *   2. The Status Check API, which is a different host and takes the
 *      COLLECTION account number, not the disbursement one:
 *        https://rmsc.hubtel.com/v1/merchantaccount/merchants/{Collection_Account_Number}/transactions/status
 *      The published Commission Services reference instead documents
 *      `https://api-txnstatus.hubtel.com/transactions/{Collection_Account_Number}/status`,
 *      but that host only answers requests from public IPs submitted to Hubtel
 *      in advance (a maximum of four per service). An Edge Function has no
 *      fixed egress IP to whitelist, so it cannot use that host at all. The
 *      `rmsc` host carries the same parameters and response body and does not
 *      require whitelisting. This is a deliberate, documented deviation;
 *      `HUBTEL_DATA_STATUS_URL` overrides it if Hubtel issues a whitelisted
 *      endpoint later.
 *
 * Both can still be overridden by `supabase secrets set` (see
 * HUBTEL_DATA_SETUP.md) for a non-standard account, but the defaults are the
 * documented shapes, matching how `airtimeProvider.ts` already works. This
 * module fails closed when the account numbers or credentials are missing:
 * `hubtelConfigured()` returns false and every purchase is refused *before*
 * the wallet is touched.
 *
 * Authentication is HTTP Basic over the account credentials, which is what
 * Hubtel documents and what was verified against the live catalog endpoint. If
 * the account is issued an OAuth2 token endpoint (HUBTEL_TOKEN_URL) the same
 * credentials mint a bearer token instead; `hubtelAuth.ts` owns that choice.
 *
 * Nothing in this module logs a credential, and nothing returns a provider
 * body that has not been through `safeHubtelFields()` - the raw payloads have
 * carried an `identity` object with the API key in them before, and storing
 * one verbatim is how that key ended up in a database.
 */

import { hubtelResponseState } from './paymentGateway.ts';
import { getHubtelAuthorizationHeader, resetHubtelAuthTokenCache } from './hubtelAuth.ts';
import { hubtelRequest, pickNumber, pickString } from './hubtelClient.ts';

export interface HubtelConfig {
  clientId: string;
  clientSecret: string;
  // Commission Services takes its account number in the URL path
  // (`/{account}/{ServiceID}`), so it arrives inside the configured endpoints
  // rather than as a field here. That account is the DISBURSEMENT (prepaid
  // deposit) number; the merchant/collection number is a different one and
  // belongs to the wallet-checkout module.
  /** Hubtel commission-service ids, one per mobile network. */
  serviceIds: Partial<Record<'mtn' | 'telecel' | 'airteltigo', string>>;
  tokenUrl?: string;
  bundlesUrl?: string;
  purchaseUrl?: string;
  statusUrl?: string;
  /** Optional callback URL Hubtel calls when a commission transaction settles. */
  callbackUrl?: string;
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
  /** Hubtel accepted the order, but delivery is not final yet. */
  pending?: boolean;
  state?: 'success' | 'pending' | 'failed';
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

/** Maps the parsed provider config onto the shared auth options. */
function authOptions(config: HubtelConfig) {
  return {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    tokenUrl: config.tokenUrl,
    scope: config.scope,
  };
}

/**
 * True when enough secrets are present to attempt a provider call. Callers must
 * check this before charging anything: "provider not configured" and "provider
 * declined" are different outcomes and only the second one is worth a refund
 * after a delivery attempt.
 */
export function hubtelConfigured(): boolean {
  const config = readHubtelConfig();
  if (!config?.clientId || !config.clientSecret || !config.purchaseUrl) return false;

  // A single `{ServiceID}` URL is valid only when every Instant Data network
  // has its own service id. This prevents the storefront from appearing live
  // while one network would still resolve to a literal placeholder.
  if (config.purchaseUrl.includes('{ServiceID}')) {
    const networks = ['mtn', 'telecel', 'airteltigo'] as const;
    return networks.every((network) => Boolean(config.serviceIds[network]));
  }
  return isResolvedEndpoint(config.purchaseUrl);
}

const COMMISSION_SERVICES_BASE = 'https://cs.hubtel.com/commissionservices';

/** The non-whitelisted Status Check host. See the header comment. */
const STATUS_CHECK_BASE = 'https://rmsc.hubtel.com/v1/merchantaccount/merchants';

/** Documented Data ServiceIDs, one per network, from the Commission Services reference. */
const DEFAULT_DATA_SERVICE_IDS: Record<'mtn' | 'telecel' | 'airteltigo', string> = {
  mtn: 'b230733cd56b4a0fad820e39f66bc27c',
  telecel: 'fa27127ba039455da04a2ac8a1613e00',
  airteltigo: '06abd92da459428496967612463575ca',
};

/**
 * The DISBURSEMENT (prepaid deposit) account. It is the Commission Services
 * URL path segment, and deliberately falls back to nothing else: the
 * merchant/collection account is a different number, and substituting it
 * surfaces as ResponseCode 4101, not as a working call.
 */
function disbursementAccount(): string | undefined {
  return Deno.env.get('HUBTEL_DISBURSEMENT_ACCOUNT')?.trim() || undefined;
}

/**
 * The COLLECTION (merchant) account, used only by the Status Check API.
 *
 * `HUBTEL_MERCHANT_ACCOUNT_NUMBER` is read first, matching `hubtelPayments.ts`.
 * `HUBTEL_MERCHANT_ACCOUNT` is the older key and on some deployments holds the
 * sender id instead of the account number, which would build the status URL as
 * `/merchants/<sender id>/transactions/status`.
 */
function collectionAccount(): string | undefined {
  return Deno.env.get('HUBTEL_MERCHANT_ACCOUNT_NUMBER')?.trim()
    || Deno.env.get('HUBTEL_MERCHANT_ACCOUNT')?.trim()
    || undefined;
}

/** `{BaseUrl}/{Disbursement_Account_Number}/{ServiceID}` - buy (POST) and query (GET). */
function defaultServiceEndpoint(): string | undefined {
  const account = disbursementAccount();
  if (!account) return undefined;
  return `${COMMISSION_SERVICES_BASE}/${encodeURIComponent(account)}/{ServiceID}`;
}

/** `{StatusBase}/{Collection_Account_Number}/transactions/status` - correlates on clientReference. */
function defaultStatusUrl(): string | undefined {
  const account = collectionAccount();
  if (!account) return undefined;
  return `${STATUS_CHECK_BASE}/${encodeURIComponent(account)}/transactions/status`;
}

/**
 * Where Hubtel should call back with the final state. Defaults to this
 * project's own `hubtel-data-webhook` function, which is the only thing that
 * can settle an order - a purchase sent without it never receives the
 * callback and has to be reconciled by a status poll.
 */
function defaultCallbackUrl(): string | undefined {
  const projectUrl = Deno.env.get('SUPABASE_URL')?.trim();
  return projectUrl ? `${projectUrl}/functions/v1/hubtel-data-webhook` : undefined;
}

function readHubtelConfig(): HubtelConfig | null {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    serviceIds: {
      mtn: Deno.env.get('HUBTEL_DATA_SERVICE_ID_MTN')?.trim() || DEFAULT_DATA_SERVICE_IDS.mtn,
      telecel: Deno.env.get('HUBTEL_DATA_SERVICE_ID_TELECEL')?.trim() || DEFAULT_DATA_SERVICE_IDS.telecel,
      airteltigo: Deno.env.get('HUBTEL_DATA_SERVICE_ID_AIRTELTIGO')?.trim() || DEFAULT_DATA_SERVICE_IDS.airteltigo,
    },
    tokenUrl: Deno.env.get('HUBTEL_TOKEN_URL')?.trim() || undefined,
    // The bundle catalog is the same URL as the purchase: Hubtel answers it
    // with the sellable packages when queried with a destination number.
    bundlesUrl: Deno.env.get('HUBTEL_DATA_BUNDLES_URL')?.trim() || defaultServiceEndpoint(),
    purchaseUrl: Deno.env.get('HUBTEL_DATA_PURCHASE_URL')?.trim() || defaultServiceEndpoint(),
    statusUrl: Deno.env.get('HUBTEL_DATA_STATUS_URL')?.trim() || defaultStatusUrl(),
    callbackUrl: Deno.env.get('HUBTEL_DATA_CALLBACK_URL')?.trim() || defaultCallbackUrl(),
    scope: Deno.env.get('HUBTEL_SCOPE')?.trim() || undefined,
  };
}

/**
 * Fills the `{Collection_Account_Number}` placeholder when an operator
 * overrode HUBTEL_DATA_STATUS_URL with the documented template. Returns null
 * if a placeholder survives, so a literal `{...}` is never requested.
 */
function resolveStatusEndpoint(template: string): string | null {
  const account = collectionAccount();
  const resolved = template
    .replaceAll('{Collection_Account_Number}', account ? encodeURIComponent(account) : '')
    .replaceAll('{COLLECTION_ACCOUNT_NUMBER}', account ? encodeURIComponent(account) : '');
  return isResolvedEndpoint(resolved) ? resolved : null;
}

function isResolvedEndpoint(value: string | undefined): value is string {
  return Boolean(value && !/[{][^}]+[}]/.test(value));
}

function normalizeNetwork(value: unknown): 'mtn' | 'telecel' | 'airteltigo' | null {
  const network = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (network === 'mtn') return 'mtn';
  if (network === 'telecel' || network === 'vodafone') return 'telecel';
  if (network === 'at' || network === 'airteltigo') return 'airteltigo';
  return null;
}

function resolveServiceEndpoint(
  template: string | undefined,
  config: HubtelConfig,
  network: unknown,
): string | null {
  if (!template) return null;
  if (!template.includes('{ServiceID}')) return isResolvedEndpoint(template) ? template : null;

  const normalized = normalizeNetwork(network);
  const serviceId = normalized ? config.serviceIds[normalized] : undefined;
  if (!serviceId) return null;

  const resolved = template.replaceAll('{ServiceID}', encodeURIComponent(serviceId));
  return isResolvedEndpoint(resolved) ? resolved : null;
}

/** Throws with an operator-readable reason rather than calling a wrong URL. */
function requireConfig(): HubtelConfig {
  const config = readHubtelConfig();
  if (!config) {
    throw new Error('Hubtel is not configured. Set HUBTEL_CLIENT_ID, HUBTEL_CLIENT_SECRET and the Instant Data service IDs.');
  }
  if (!config.purchaseUrl) {
    throw new Error('Hubtel data purchase endpoint is not configured. Set HUBTEL_DATA_PURCHASE_URL.');
  }
  return config;
}

// Auth + transport live in `hubtelAuth.ts` / `hubtelClient.ts` and are shared
// with the wallet-checkout module, so there is exactly one Basic-auth
// implementation and one timeout-aware request helper across Hubtel calls.

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
    'response_code', 'ResponseCode', 'responseCode', 'date', 'Date',
    'transaction_id', 'TransactionId',
    'transactionId', 'order_id', 'OrderId', 'orderId', 'reference', 'Reference',
    'client_reference', 'ClientReference', 'clientReference', 'amount', 'Amount',
    'amount_debited', 'AmountDebited', 'is_fulfilled', 'isFulfilled',
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
    return { success: state === 'success', status: state === 'failed' ? code : state, state };
  }

  const status = pickString(payload, ['status', 'Status', 'response_code', 'ResponseCode', 'description', 'Description', 'message', 'Message']) || '';
  const normalized = status.toLowerCase();

  if (FAILURE_WORDS.some((word) => normalized.includes(word))) return { success: false, status, state: 'failed' };
  if (SUCCESS_WORDS.some((word) => normalized.includes(word))) return { success: true, status, state: 'success' };
  if (normalized) return { success: false, status, state: 'failed' };
  return httpOk
    ? { success: false, status: 'accepted', state: 'pending' }
    : { success: false, status: 'no response', state: 'failed' };
}

/**
 * Classifies a Status Check API response.
 *
 * This is deliberately not `classify()`. The Status Check host answers
 * `responseCode: "0000"` to mean "the lookup succeeded", for a transaction that
 * may itself be `Unpaid` - so treating a code as the transaction's outcome
 * would mark every failed order as delivered. The transaction's own status
 * field (`Paid` / `Unpaid`) and `isFulfilled` are authoritative; the response
 * code is only consulted when neither is present.
 */
function classifyStatus(payload: unknown): { success: boolean; status: string; state: 'success' | 'pending' | 'failed' } {
  const data = (() => {
    if (!payload || typeof payload !== 'object') return undefined;
    const body = payload as Record<string, unknown>;
    const nested = body.data ?? body.Data;
    return nested && typeof nested === 'object' && !Array.isArray(nested)
      ? nested as Record<string, unknown>
      : undefined;
  })();

  // Only the transaction's own status field counts. `message` is deliberately
  // not consulted: on this endpoint it describes *the lookup* ("Invalid client
  // reference"), and reading it as the transaction would turn a bad query into
  // a refund.
  const statusText = pickString(data, ['status', 'Status'])
    || pickString(payload, ['status', 'Status'])
    || '';
  const normalized = statusText.toLowerCase();
  const topLevel = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const fulfilled = data?.isFulfilled ?? data?.IsFulfilled ?? topLevel.isFulfilled ?? topLevel.IsFulfilled;

  // Unpaid is a decline even though the lookup answers 0000. Match it first,
  // before the generic success words, so "Unpaid" cannot be read as "paid".
  if (normalized.includes('unpaid') || normalized.includes('reversed') || normalized.includes('refund')) {
    return { success: false, status: statusText, state: 'failed' };
  }
  if (fulfilled === false && normalized.includes('paid')) {
    // Contradictory body: trust the boolean that says it was not fulfilled.
    return { success: false, status: statusText, state: 'failed' };
  }
  if (normalized.includes('paid') || fulfilled === true) {
    return { success: true, status: statusText || 'Paid', state: 'success' };
  }
  if (FAILURE_WORDS.some((word) => normalized.includes(word))) {
    return { success: false, status: statusText, state: 'failed' };
  }
  if (fulfilled === false) return { success: false, status: statusText || 'Unpaid', state: 'failed' };
  if (normalized.includes('pending') || normalized.includes('process')) {
    return { success: false, status: statusText, state: 'pending' };
  }

  // The body carried no transaction-level status, so the lookup did not
  // resolve a transaction. That is inconclusive, not a decline: a non-`0000`
  // code here means *the lookup* failed, and the doc's "anything but 0000 is
  // FAILED" rule governs the transaction, not the query. Reporting a decline
  // would refund a sale that may still be in flight, so this stays pending and
  // the money stays held until a later poll resolves it.
  return { success: false, status: statusText || 'Unresolved', state: 'pending' };
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
export async function fetchHubtelBundles(network?: string, destination?: string): Promise<HubtelBundle[]> {
  const config = readHubtelConfig();
  if (!config) return [];
  const endpoint = resolveServiceEndpoint(config.bundlesUrl, config, network);
  if (!endpoint) return [];

  // The catalog is the service endpoint itself, queried with the number the
  // bundle would be bought for - Hubtel answers with the packages that number
  // is eligible for, as `Data: [{ Display, Value, Amount }]`.
  const url = new URL(endpoint);
  if (destination) url.searchParams.set('destination', hubtelDestination(destination));

  const response = await hubtelRequest(url.toString(), {
    authorization: await getHubtelAuthorizationHeader(authOptions(config)),
  });

  if (!response.ok) {
    console.error('Hubtel bundle catalog request failed:', { status: response.status, network });
    throw new Error('Hubtel bundle catalog request failed.');
  }

  const rows = packageRows(response.payload);
  if (!rows) {
    console.error('Hubtel bundle catalog shape was not recognised:', { network });
    throw new Error('Hubtel returned an unsupported bundle catalog response.');
  }

  return rows.map((row) => ({
    packageId: String(pickString(row, ['package_id', 'PackageId', 'bundle_id', 'BundleId', 'id', 'Id', 'value', 'Value']) || ''),
    name: String(pickString(row, ['name', 'Name', 'description', 'Description', 'bundle', 'Bundle', 'title', 'Display']) || ''),
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
 * Commission-services expects a Ghanaian MSISDN in international format. The
 * storefront and database deliberately keep the familiar local form
 * (024XXXXXXX), so convert only at the provider boundary.
 */
function hubtelDestination(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('233')) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `233${digits.slice(1)}`;
  return digits;
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

  const endpoint = resolveServiceEndpoint(config.purchaseUrl, config, request.hubtelNetwork);
  if (!endpoint) {
    const network = normalizeNetwork(request.hubtelNetwork) || 'requested network';
    return {
      success: false,
      payload: { configuration: `No Hubtel service ID is configured for ${network}.` },
      failureReason: `No Hubtel service ID is configured for ${network}.`,
    };
  }

  // This is the commission-services wire format supplied by Hubtel. The
  // service id belongs in the URL; the package Value belongs in
  // Extradata.bundle. Do not send the generic Bundle/PhoneNumber fields used
  // by older integrations, because Hubtel accepts the request but can route it
  // to the wrong product.
  const body: Record<string, unknown> = {
    Destination: hubtelDestination(request.phone),
    ClientReference: request.reference,
    Extradata: { bundle: request.packageId },
  };
  if (Number.isFinite(request.amountGhs)) body.Amount = Number(request.amountGhs);
  if (config.callbackUrl) body.CallbackUrl = config.callbackUrl;

  let response;
  try {
    response = await hubtelRequest(endpoint, {
      method: 'POST',
      body,
      authorization: await getHubtelAuthorizationHeader(authOptions(config)),
    });
  } catch (err) {
    // Re-thrown, not converted to a decline: we do not know whether Hubtel took
    // the order, so this must not silently refund and let a bundle go free.
    console.error('Hubtel purchase request failed to complete:', { error: String(err), reference: request.reference });
    throw new Error('Could not reach Hubtel to place the data order.');
  }

  const payload = response.payload;
  const verdict = classify(payload, response.ok);
  const safe = safeHubtelFields(payload);

  return {
    success: verdict.success,
    pending: verdict.state === 'pending',
    state: verdict.state,
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
export async function fetchHubtelStatus(clientReference: string): Promise<HubtelStatusResult | null> {
  const config = readHubtelConfig();
  if (!config?.statusUrl || !clientReference) return null;

  // The Status Check API correlates on the client reference sent with the
  // purchase, not on Hubtel's own transaction id, and takes the COLLECTION
  // account in the URL path - which is why it is a different URL from the
  // service endpoint above.
  const endpoint = resolveStatusEndpoint(config.statusUrl);
  if (!endpoint) return null;

  let response;
  try {
    response = await hubtelRequest(endpoint, {
      query: { clientReference },
      authorization: await getHubtelAuthorizationHeader(authOptions(config)),
    });
  } catch (err) {
    console.warn('Hubtel status request failed:', { error: String(err) });
    return null;
  }

  if (!response.ok) {
    console.warn('Hubtel status request returned an error:', { status: response.status });
    return null;
  }

  const payload = response.payload;
  const verdict = classifyStatus(payload);

  return {
    state: verdict.state,
    status: verdict.status,
    orderId: pickOrderId(payload),
    payload: safeHubtelFields(payload),
  };
}

/** Resets the cached OAuth token. Used by tests and after a credential rotation. */
export function resetHubtelTokenCache(): void {
  resetHubtelAuthTokenCache();
}
