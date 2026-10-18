import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { refundWallet } from '../_shared/wallet.ts';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function rows(payload: JsonRecord): JsonRecord[] {
  const data = payload.Data ?? payload.data;
  if (Array.isArray(data)) return data.map(record);
  const item = record(data);
  return Object.keys(item).length ? [item] : [];
}

function providerReference(payload: JsonRecord, nested: JsonRecord): string | null {
  return firstString(
    payload.TransactionId, payload.transactionId, payload.OrderId, payload.orderId,
    nested.TransactionId, nested.transactionId, nested.OrderId, nested.orderId,
  );
}

function token(payload: JsonRecord, nested: JsonRecord): string | null {
  const values: unknown[] = [
    payload.Token, payload.token, payload.TokenCode, payload.tokenCode, payload.token_code,
    nested.Token, nested.token, nested.TokenCode, nested.tokenCode, nested.token_code,
  ];
  for (const row of rows(payload)) {
    values.push(row.Token, row.token, row.TokenCode, row.tokenCode, row.token_code, row.PIN, row.Pin, row.pin);
  }
  return firstString(...values);
}

function state(payload: JsonRecord): 'success' | 'pending' | 'failed' {
  const code = firstString(payload.ResponseCode, payload.responseCode, payload.response_code);
  if (code === '0000') return 'success';
  if (code === '0001') return 'pending';
  const message = (firstString(payload.Message, payload.message, payload.Status, payload.status) || '').toLowerCase();
  if (['success', 'successful', 'completed', 'delivered', 'paid'].some((word) => message.includes(word))) return 'success';
  if (['pending', 'processing', 'accepted'].some((word) => message.includes(word))) return 'pending';
  return 'failed';
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const payload = record(await request.json());
    const nested = record(payload.Data ?? payload.data);
    const reference = firstString(
      payload.ClientReference, payload.clientReference, payload.reference,
      nested.ClientReference, nested.clientReference, nested.reference,
    );
    if (!reference) return json({ received: false, error: 'Client reference is required.' }, 400);

    const admin = adminClient();
    const { data: order, error } = await admin.from('utility_orders')
      .select('id, agent_id, payment_reference, bill_category, gross_amount, status, token_code, provider_reference')
      .eq('payment_reference', reference)
      .maybeSingle();
    if (error) throw error;
    if (!order) return json({ received: true });
    if (order.status === 'completed' || order.status === 'failed') {
      return json({ received: true, duplicate: true });
    }

    const providerRef = providerReference(payload, nested);
    const currentState = state(payload);
    if (currentState === 'pending') {
      await admin.from('utility_orders').update({
        status: 'processing',
        provider_reference: providerRef ?? order.provider_reference,
        provider_response: payload,
        paid_at: new Date().toISOString(),
      }).eq('id', order.id).in('status', ['paid', 'processing']);
      return json({ received: true, pending: true });
    }

    if (currentState === 'success') {
      const tokenCode = token(payload, nested);
      // ECG must receive a real token from Hubtel. Keep the wallet debit on
      // hold when a callback is incomplete rather than generating a fake token.
      if (order.bill_category === 'electricity' && !tokenCode) {
        await admin.from('utility_orders').update({
          status: 'processing',
          provider_reference: providerRef ?? order.provider_reference,
          provider_response: payload,
          paid_at: new Date().toISOString(),
        }).eq('id', order.id).in('status', ['paid', 'processing']);
        return json({ received: true, pending: true }, 202);
      }

      const completedAt = new Date().toISOString();
      const { error: updateError } = await admin.from('utility_orders').update({
        status: 'completed',
        token_code: tokenCode,
        provider_reference: providerRef ?? order.provider_reference,
        provider_response: payload,
        paid_at: completedAt,
        completed_at: completedAt,
      }).eq('id', order.id).in('status', ['paid', 'processing']);
      if (updateError) throw updateError;
      return json({ received: true, settled: 'completed' });
    }

    const reason = firstString(payload.Message, payload.message, payload.Description, payload.description)
      || 'Hubtel reported that the utility payment failed.';
    await admin.from('utility_orders').update({
      status: 'failed',
      provider_reference: providerRef ?? order.provider_reference,
      provider_response: payload,
      completed_at: new Date().toISOString(),
    }).eq('id', order.id).in('status', ['paid', 'processing']);
    if (order.agent_id) {
      await refundWallet(order.agent_id, order.payment_reference, Number(order.gross_amount), 'Hubtel utility payment failed')
        .catch((refundError) => console.error('Utility callback refund failed:', refundError));
    }
    return json({ received: true, settled: 'failed', reason });
  } catch (error) {
    console.error('hubtel-utility-webhook error:', error);
    return json({ received: false, error: 'Unable to process callback.' }, 500);
  }
});
