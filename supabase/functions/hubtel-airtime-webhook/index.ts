import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { refundWallet } from '../_shared/wallet.ts';

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

    if (state === 'success') {
      await admin.rpc('fulfil_airtime_order', {
        p_order_id: order.id,
        p_airtime_status: 'delivered',
        p_provider_reference: providerReference,
        p_provider_response: payload,
        p_failure_reason: null,
      });
      return json({ received: true, settled: 'delivered' });
    }

    const reason = firstString(payload.Message, payload.message, payload.Description, payload.description)
      || 'Hubtel reported that the airtime delivery failed.';
    await admin.from('airtime_orders').update({
      payment_status: 'failed',
      airtime_status: 'failed',
      provider_reference: providerReference,
      provider_response: payload,
      failure_reason: reason,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id).in('airtime_status', ['pending', 'pending_provider', 'processing']);

    if (order.agent_id) {
      await refundWallet(order.agent_id, order.payment_reference, Number(order.amount), 'Hubtel airtime delivery failed')
        .catch((refundError) => console.error('Airtime callback refund failed:', refundError));
    }
    return json({ received: true, settled: 'failed' });
  } catch (error) {
    console.error('hubtel-airtime-webhook error:', error);
    return json({ received: false, error: 'Unable to process callback.' }, 500);
  }
});
