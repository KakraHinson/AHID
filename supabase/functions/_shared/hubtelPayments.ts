/**
 * Hubtel Online Checkout (collections) adapter — the Hubtel half of wallet
 * funding, the Paystack half being inlined in `create-agent-wallet-payment` /
 * `paystack-webhook`.
 *
 * Skaitech accepts wallet top-ups through either gateway and credits them the
 * same way ("Paystack and Hubtel work together and the same"). Both are reduced
 * to the shared model in `paymentGateway.ts`, and both settle through the one
 * idempotent `fulfil_wallet_topup` RPC. This file only speaks to Hubtel; it does
 * not touch the wallet.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANY URL IN THIS FILE
 * ---------------------------------------------------------------------------
 * No endpoint is hardcoded. Hubtel's developer portal is a login-gated SPA, the
 * public docs disagree with each other about hosts and auth, and a probe of
 * `POST https://payproxyapi.hubtel.com/items/initiate` returned HTTP 401 for
 * every auth shape tried (including with no Authorization header at all, which
 * means those 401s cannot tell a wrong key from a wrong auth style). A URL
 * guessed into the source would be a guess against a live merchant account.
 *
 * So the shape is configured once via `supabase secrets set` (see
 * HUBTEL_API_REFERENCE.md) and this module fails closed when it is not
 * configured: `hubtelPaymentsConfigured()` returns false and the caller refuses
 * the top-up *before* a `wallet_topups` row is created.
 *
 * The initiate body below follows the Hubtel Online Checkout shape implied by
 * the payloads Hubtel supplied (a `0001` "pending" response carrying
 * `data.orderId`, confirmed later by callback): `totalAmount`, `description`,
 * `callbackUrl`, `returnUrl`, `merchantAccountNumber`, `clientReference`. The
 * redirect URL is read from the first of several candidate field names, because
 * which one Hubtel uses varies by product.
 */

import { normalizeHubtel, type PaymentState } from './paymentGateway.ts';
import { hubtelBasicAuthHeader, resetHubtelAuthTokenCache } from './hubtelAuth.ts';
import { hubtelRequest, pickString } from './hubtelClient.ts';

interface HubtelPayConfig {
  clientId: string;
  clientSecret: string;
  merchantAccount: string;
  merchantAccountNumber: string;
  checkoutUrl?: string;
  statusUrl?: string;
  tokenUrl?: string;
  scope?: string;
}

function readConfig(): HubtelPayConfig | null {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    merchantAccount: Deno.env.get('HUBTEL_MERCHANT_ACCOUNT')?.trim() || '',
    merchantAccountNumber: Deno.env.get('HUBTEL_MERCHANT_ACCOUNT_NUMBER')?.trim() || '',
    checkoutUrl: Deno.env.get('HUBTEL_CHECKOUT_URL')?.trim() || undefined,
    statusUrl: Deno.env.get('HUBTEL_CHECKOUT_STATUS_URL')?.trim() || undefined,
    tokenUrl: Deno.env.get('HUBTEL_TOKEN_URL')?.trim() || undefined,
    scope: Deno.env.get('HUBTEL_SCOPE')?.trim() || undefined,
  };
}

/**
 * True when a Hubtel checkout can be started. Callers must check this before
 * creating a wallet_topups row: "Hubtel not switched on" and "Hubtel declined"
 * are different outcomes.
 */
export function hubtelPaymentsConfigured(): boolean {
  const config = readConfig();
  return Boolean(config?.checkoutUrl && (config.merchantAccountNumber || config.merchantAccount));
}

/** True when a callback can be re-verified server-side before crediting. */
export function hubtelPaymentsVerifyConfigured(): boolean {
  const config = readConfig();
  return Boolean(config?.statusUrl);
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface HubtelCollectionInit {
  /** Where to send the browser, when Hubtel returns a hosted page. */
  authorizationUrl?: string;
  /** Hubtel's own order id, stored for the callback/status lookup. */
  orderId?: string;
  state: PaymentState;
  reference: string;
  payload: Record<string, unknown>;
}

export interface HubtelCollectionRequest {
  /** Our own reference, sent as the provider's client reference. */
  reference: string;
  /** Amount in GHS. */
  amountGhs: number;
  /** Where Hubtel returns the customer after payment. Also the callback target. */
  returnUrl: string;
  /** Server-to-server callback endpoint used to verify and settle the top-up. */
  callbackUrl?: string;
  description?: string;
}

/**
 * Starts a Hubtel checkout. Throws when Hubtel is not configured or cannot be
 * reached, so the caller refuses the top-up rather than creating a dead row.
 */
export async function initializeHubtelCollection(request: HubtelCollectionRequest): Promise<HubtelCollectionInit> {
  const config = readConfig();
  if (!config?.checkoutUrl) {
    throw new Error('Hubtel payments are not switched on yet.');
  }
  const merchantAccountNumber = config.merchantAccountNumber || config.merchantAccount;
  if (!merchantAccountNumber) {
    throw new Error('Hubtel collection account number is not configured.');
  }

  const body: Record<string, unknown> = {
    totalAmount: Number(request.amountGhs.toFixed(2)),
    description: request.description || `Skaitech wallet top-up ${request.reference}`,
    clientReference: request.reference,
    callbackUrl: request.callbackUrl || request.returnUrl,
    returnUrl: request.returnUrl,
    cancellationUrl: request.returnUrl,
  };
  body.merchantAccountNumber = merchantAccountNumber;

  let response;
  try {
    response = await hubtelRequest(config.checkoutUrl, {
      method: 'POST',
      body,
      // Hubtel's Online Checkout documentation specifies HTTP Basic auth using
      // API ID:API key. Do not switch this endpoint to an OAuth bearer token.
      authorization: hubtelBasicAuthHeader(config.clientId, config.clientSecret),
    });
  } catch (err) {
    console.error('Hubtel checkout request failed to complete:', { reference: request.reference, error: String(err) });
    throw new Error('Could not reach Hubtel to start the payment.');
  }

  const payload = response.payload;
  const normalized = normalizeHubtel(payload);
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;

  const authorizationUrl = pickString(data, ['checkoutUrl', 'checkoutDirectUrl', 'paylink', 'paymentUrl', 'redirectUrl'])
    || pickString(payload, ['checkoutUrl', 'checkoutDirectUrl', 'paylink', 'paymentUrl', 'redirectUrl']);
  const orderId = normalized.orderId ?? pickString(data, ['orderId']);

  if (!response.ok && normalized.state === 'failed') {
    console.error('[Hubtel Online Checkout rejected]', JSON.stringify({
      status: response.status,
      reference: request.reference,
      response: payload,
    }, null, 2));
    throw new Error(normalized.message || `Hubtel declined checkout initialization (HTTP ${response.status}).`);
  }
  if (!authorizationUrl) {
    console.error('[Hubtel Online Checkout missing checkout URL]', JSON.stringify({
      status: response.status,
      reference: request.reference,
      response: payload,
    }, null, 2));
    throw new Error('Hubtel did not return a checkout URL.');
  }

  return { authorizationUrl, orderId, state: normalized.state, reference: request.reference, payload };
}

export interface HubtelCollectionStatus {
  state: PaymentState;
  orderId?: string;
  amountGhs?: number;
  payload: Record<string, unknown>;
}

/**
 * Re-reads a Hubtel checkout server-side by order id. Returns null when no
 * status endpoint is configured or the provider cannot be consulted, which the
 * caller must treat as "not confirmed" and must not credit on.
 */
export async function verifyHubtelCollection(clientReference: string): Promise<HubtelCollectionStatus | null> {
  const config = readConfig();
  if (!config?.statusUrl || !clientReference) return null;

  const url = config.statusUrl.includes('{clientReference}')
    ? config.statusUrl.replace('{clientReference}', encodeURIComponent(clientReference))
    : config.statusUrl.includes('{orderId}')
      ? config.statusUrl.replace('{orderId}', encodeURIComponent(clientReference))
      : `${config.statusUrl}${config.statusUrl.includes('?') ? '&' : '?'}clientReference=${encodeURIComponent(clientReference)}`;

  let response;
  try {
    response = await hubtelRequest(url, {
      // Hubtel's transaction-status endpoint also uses API ID/API key Basic
      // auth, and the lookup key is the original clientReference.
      authorization: hubtelBasicAuthHeader(config.clientId, config.clientSecret),
    });
  } catch (err) {
    console.warn('Hubtel status request failed:', { error: String(err) });
    return null;
  }
  if (!response.ok) {
    console.warn('[Hubtel wallet status rejected]', JSON.stringify({
      status: response.status,
      clientReference,
      response: response.payload,
    }, null, 2));
    return null;
  }

  const payload = response.payload;
  const normalized = normalizeHubtel(payload);
  return {
    state: normalized.state,
    orderId: normalized.orderId ?? clientReference,
    amountGhs: normalized.amountGhs,
    payload,
  };
}

/** Resets the cached OAuth token. Used by tests and after a credential rotation. */
export function resetHubtelPaymentTokenCache(): void {
  resetHubtelAuthTokenCache();
}
