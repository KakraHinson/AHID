import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { settleHubtelAirtimeOrder } from '../_shared/hubtelSettlement.ts';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function responseState(payload: Record<string, unknown>): 'success' | 'pending' | 'failed' {
  const code = firstString(payload.ResponseCode, payload.responseCode);
  if (code === '0000') return 'success';
  if (code === '0001') return 'pending';
  const status = (firstString(payload.Status, payload.status, payload.Message, payload.message) || '').toLowerCase();
  if (['success', 'successful', 'delivered', 'completed'].some((word) => status.includes(word))) return 'success';
  if (['pending', 'processing', 'accepted'].some((word) => status.includes(word))) return 'pending';
  return 'failed';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = asRecord(await request.json());
    const nested = asRecord(payload.Data ?? payload.data);
    const reference = firstString(
      payload.ClientReference,
      payload.clientReference,
      nested.ClientReference,
      nested.clientReference,
    );
    if (!reference) return json({ received: false, error: 'Client reference is required.' }, 400);

    const admin = adminClient();
    const { data: order, error } = await admin
      .from('airtime_orders')
      .select('id, agent_id, payment_reference, amount, airtime_status')
      .eq('payment_reference', reference)
      .maybeSingle();
    if (error || !order) return json({ received: true });

    if (order.airtime_status === 'delivered' || order.airtime_status === 'failed') {
      return json({ received: true, duplicate: true });
    }

    const providerReference = firstString(
      payload.TransactionId,
      payload.transactionId,
      nested.TransactionId,
      nested.transactionId,
    );
    const state = responseState(payload);

    if (state === 'pending') {
      await admin.from('airtime_orders').update({
        provider_reference: providerReference,
        provider_response: payload,
        airtime_status: 'pending_provider',
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);
      return json({ received: true, pending: true });
    }

    // Both terminal states settle through the shared helper, so a callback and
    // the reconcile sweep cannot disagree about what "delivered" means.
    const outcome = await settleHubtelAirtimeOrder(admin, {
      id: String(order.id),
      agent_id: order.agent_id ? String(order.agent_id) : null,
      payment_reference: String(order.payment_reference),
      amount: Number(order.amount),
      provider_reference: providerReference,
    }, {
      state,
      payload,
      providerReference,
      failureReason: firstString(payload.Message, payload.message, payload.Description, payload.description) ?? undefined,
    });

    return json({ received: true, settled: outcome });
  } catch (error) {
    console.error('hubtel-airtime-webhook error:', error);
    return json({ received: false, error: 'Unable to process callback.' }, 500);
  }
});
