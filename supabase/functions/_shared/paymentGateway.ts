/**
 * One payment model for two gateways.
 *
 * Skaitech settles wallet top-ups (and, later, store orders) through either
 * Paystack or Hubtel, together. The two report the same event in different
 * dialects:
 *
 *   Paystack  { "status": true, "message": "Success",
 *               "data": { "status": "success", "reference": "WAL-...",
 *                         "amount": 15050, "currency": "GHS" } }
 *
 *   Hubtel    { "message": "Success", "responseCode": "0000",
 *               "data": { "orderId": "b230733c..." } }
 *
 * Downstream code must not care which one settled, so both shapes are reduced
 * here to a single `NormalizedPayment`. "Paystack and Hubtel work together and
 * the same" means exactly this: one state machine (`success | pending |
 * failed`), two adapters.
 *
 * Same fail-safe rule as the rest of the codebase: a status we do not
 * recognise is never guessed into `success`. Unknown Paystack/Hubtel states map
 * to `pending`, so an unclear event can hold a wallet but never release goods.
 */

export type PaymentProvider = 'paystack' | 'hubtel';
export type PaymentState = 'success' | 'pending' | 'failed';

export interface NormalizedPayment {
  provider: PaymentProvider;
  state: PaymentState;
  /** Our own reference (Paystack `reference` / Hubtel client reference). */
  reference?: string;
  /** The gateway's own transaction id, when it returns one. */
  orderId?: string;
  /** Amount in GHS (Paystack reports kobo, so it is divided by 100). */
  amountGhs?: number;
  currency?: string;
  message?: string;
}

const PAYSTACK_FAILED = ['failed', 'failure', 'reversed', 'abandoned', 'revoked', 'declined', 'cancelled', 'canceled', 'error'];
const PAYSTACK_SUCCESS = ['success', 'successful', 'completed', 'complete', 'paid'];
const PAYSTACK_PENDING = ['pending', 'ongoing', 'processing', 'queued', 'initiated', 'incomplete', 'ongoing'];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function num(value: unknown): number | undefined {
  const raw = str(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Paystack's status wording to the shared state. The webhook event name
 * (`charge.success`) is used when `data.status` is not present.
 */
export function paystackState(status: string): PaymentState {
  const normalized = status.toLowerCase();
  if (PAYSTACK_FAILED.some((word) => normalized.includes(word))) return 'failed';
  if (PAYSTACK_SUCCESS.some((word) => normalized.includes(word))) return 'success';
  if (PAYSTACK_PENDING.some((word) => normalized.includes(word))) return 'pending';
  return 'pending';
}

/**
 * Hubtel's 4-digit `responseCode` to the shared state. "0000" = success,
 * "0001" = accepted/pending (final state arrives on a callback), everything
 * else is a decline. Returns undefined for an empty code so callers can fall
 * back to a wording-based read.
 */
export function hubtelResponseState(code: string | undefined): PaymentState | undefined {
  if (!code) return undefined;
  if (code === '0000') return 'success';
  if (code === '0001') return 'pending';
  return 'failed';
}

export function normalizePaystack(payload: unknown): NormalizedPayment {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const event = str(body.event);
  const status = str(data.status) || (event ? event.split('.').pop() ?? '' : '');

  return {
    provider: 'paystack',
    state: paystackState(status),
    reference: str(data.reference) || str(body.reference),
    orderId: str(data.id) || str(data.reference),
    amountGhs: (() => {
      const kobo = num(data.amount);
      return kobo === undefined ? undefined : Math.round(kobo) / 100;
    })(),
    currency: str(data.currency),
    message: str(body.message) || str(data.gateway_response),
  };
}

export function normalizeHubtel(payload: unknown): NormalizedPayment {
  const body = asRecord(payload);
  const data = asRecord(body.data);
  const code = str(body.responseCode) || str(body.response_code) || str(body.ResponseCode);

  let state = hubtelResponseState(code);
  if (state === undefined) {
    const word = (str(body.message) || str(body.Message) || str(body.status) || str(body.Status) || '').toLowerCase();
    state = word.includes('pending') ? 'pending' : 'failed';
  }

  return {
    provider: 'hubtel',
    state,
    reference: str(body.reference) || str(body.clientReference) || str(body.ClientReference),
    orderId: str(data.orderId) || str(body.orderId) || str(body.order_id) || str(body.transaction_id) || str(body.TransactionId),
    amountGhs: num(data.amount) ?? num(data.Amount) ?? num(body.amount) ?? num(body.Amount),
    currency: str(data.currency) || str(body.currency) || (body.responseCode || body.response_code ? 'GHS' : undefined),
    message: str(body.message) || str(body.Message),
  };
}

/** Dispatches to the adapter for a known gateway. */
export function normalizePayment(provider: PaymentProvider, payload: unknown): NormalizedPayment {
  return provider === 'hubtel' ? normalizeHubtel(payload) : normalizePaystack(payload);
}
