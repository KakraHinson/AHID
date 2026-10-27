import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import {
  fetchHubtelStatus,
  safeHubtelFields,
} from '../_shared/hubtelDataProvider.ts';
import { settleHubtelDataOrder } from '../_shared/hubtelSettlement.ts';
import { hubtelResponseState } from '../_shared/paymentGateway.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringField(value: unknown, names: string[]): string | undefined {
  const body = record(value);
  for (const name of names) {
    const candidate = body[name];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  return undefined;
}

function numberField(value: unknown, names: string[]): number | undefined {
  const raw = stringField(value, names);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readPayload(request: Request): Promise<JsonRecord> {
  const raw = await request.text();
  try {
    return record(JSON.parse(raw));
  } catch {
    const form = new URLSearchParams(raw);
    const body: JsonRecord = {};
    for (const [key, value] of form.entries()) body[key] = value;
    return body;
  }
}

/**
 * Settles a commission-services data order after Hubtel calls its callback.
 * The callback is only a notification: the final state is re-read from the
 * configured status endpoint before a wallet order is marked successful or
 * refunded.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = await readPayload(request);
    const data = record(payload.Data ?? payload.data);
    const reference = stringField(data, ['ClientReference', 'clientReference', 'reference'])
      || stringField(payload, ['ClientReference', 'clientReference', 'reference']);
    const orderId = stringField(data, ['TransactionId', 'transactionId', 'OrderId', 'orderId'])
      || stringField(payload, ['TransactionId', 'transactionId', 'OrderId', 'orderId']);

    if (!reference && !orderId) return json({ error: 'No client reference or transaction id.' }, 400);

    const admin = adminClient();
    let order: JsonRecord | null = null;
    if (reference) {
      const result = await admin
        .from('data_transactions')
        .select('id, reference, user_id, amount, status')
        .eq('reference', reference)
        .maybeSingle();
      if (result.error) throw result.error;
      order = result.data as JsonRecord | null;
    }

    // A pending response may arrive before the callback that carries the
    // client reference. The purchase function stores the provider transaction
    // id in hubtel_response, so use it as a safe fallback lookup - under either
    // the flat `TransactionId` spelling or the nested `data.orderId` one it was
    // flattened from.
    if (!order && orderId) {
      for (const key of ['TransactionId', 'orderId']) {
        const result = await admin
          .from('data_transactions')
          .select('id, reference, user_id, amount, status')
          .contains('hubtel_response', { [key]: orderId })
          .maybeSingle();
        if (result.error) throw result.error;
        if (result.data) {
          order = result.data as JsonRecord | null;
          break;
        }
      }
    }

    // Hubtel retries callbacks. Returning success for an unknown reference
    // prevents a retry storm without allowing an unlinked payload to move money.
    if (!order) return json({ received: true });
    if (order.status === 'success' || order.status === 'failed') return json({ received: true });

    const callbackCode = stringField(payload, ['ResponseCode', 'responseCode', 'response_code']);
    const callbackState = hubtelResponseState(callbackCode);
    const safeCallback = safeHubtelFields(payload);

    if (callbackState === 'pending') {
      await admin.from('data_transactions').update({
        hubtel_response: safeCallback,
        failure_reason: 'Hubtel accepted the order; delivery is pending confirmation.',
      }).eq('id', order.id);
      return json({ received: true, pending: true });
    }

    // The Status Check API correlates on the client reference, not on the
    // provider's transaction id, so re-read delivery by our own reference.
    const correlation = String(order.reference || reference || '').trim();
    if (!correlation) return json({ error: 'Callback carries no correlatable reference.' }, 400);

    const verified = await fetchHubtelStatus(correlation);
    if (!verified || verified.state === 'pending') {
      // Keep the wallet hold and let Hubtel retry or a reconciliation job settle
      // it. A callback alone is not trusted to release or refund money.
      return json({ received: true, pending: true }, 202);
    }

    const callbackAmount = numberField(data, ['Amount', 'AmountDebited']);
    if (callbackAmount !== undefined && Math.round(callbackAmount * 100) !== Math.round(Number(order.amount) * 100)) {
      return json({ error: 'Hubtel amount does not match the order.' }, 400);
    }

    // The refund and the status write live in one place, shared with the
    // reconcile sweep - see `_shared/hubtelSettlement.ts`.
    const outcome = await settleHubtelDataOrder(admin, {
      id: String(order.id),
      reference: correlation,
      user_id: String(order.user_id),
      amount: Number(order.amount),
    }, verified);

    return json({ received: true, status: outcome });
  } catch (error) {
    console.error('hubtel-data-webhook failed:', error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
