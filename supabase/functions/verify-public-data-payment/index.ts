import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

async function refundPaystack(reference: string) {
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
  if (!secret) return { requested: false, ok: false };
  const response = await fetch('https://api.paystack.co/refund', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ transaction: reference }),
  });
  const payload = await response.json().catch(() => ({}));
  return { requested: true, ok: response.ok && payload.status !== false, payload };
}

async function currentOrder(admin: ReturnType<typeof adminClient>, reference: string) {
  const { data, error } = await admin.from('public_data_orders')
    .select('id, payment_reference, public_access_token, short_code, customer_phone, network_type, volume_mb, sale_amount, status, provider_response, created_at')
    .eq('payment_reference', reference)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Verifies a guest Paystack payment and dispatches the same provider path used by webhooks. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const admin = adminClient();
  let reference = '';
  try {
    const body = await request.json().catch(() => ({}));
    reference = String(body.reference || '').trim();
    if (!/^PUB-GUEST-[0-9a-f-]{36}$/i.test(reference)) return json({ error: 'A valid payment reference is required.' }, 400);

    const order = await currentOrder(admin, reference);
    if (!order) return json({ error: 'Order not found.' }, 404);
    if (['successful', 'failed', 'cancelled'].includes(String(order.status))) {
      return json({ success: order.status === 'successful', status: order.status, order });
    }

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
    if (!secret) return json({ error: 'Payment verification is not configured.' }, 503);
    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const transaction = await verified.json().catch(() => ({}));
    const feeRateValue = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
    const feeRate = Number.isFinite(feeRateValue) && feeRateValue >= 0 && feeRateValue < 1 ? feeRateValue : 0.0195;
    const expectedGross = Math.round(roundMoney(Number(order.sale_amount) * (1 + feeRate)) * 100);
    if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== expectedGross || transaction.data.currency !== 'GHS') {
      return json({ success: false, status: 'pending_payment', message: 'Payment is not confirmed yet. Please wait a moment and try again.' });
    }

    const { data: claimed, error: claimError } = await admin.rpc('claim_public_data_order', { p_order_id: order.id });
    if (claimError) throw claimError;
    if (!claimed) {
      const fresh = await currentOrder(admin, reference);
      return json({ success: fresh?.status === 'successful', status: fresh?.status || 'processing', order: fresh });
    }

    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID')?.trim();
    if (!companyAgentId) throw new Error('Public data provider funding is not configured.');
    const dataPackage = await resolveDataPackage(String(order.network_type), Number(order.volume_mb));
    if (!dataPackage || !Number.isFinite(dataPackage.costGhs) || dataPackage.costGhs <= 0) {
      throw new Error('The selected bundle is no longer available from its provider.');
    }

    const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
    const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: companyAgentId,
      p_reference: providerReference,
      p_network_type: order.network_type,
      p_phone: order.customer_phone,
      p_volume_mb: order.volume_mb,
      p_amount: roundMoney(dataPackage.costGhs),
    });
    if (reserveError) throw reserveError;

    let dispatch;
    try {
      dispatch = await buyDataPackage(dataPackage, String(order.network_type), String(order.customer_phone || ''));
    } catch (error) {
      dispatch = {
        success: false,
        provider: dataPackage.provider,
        status: 'failed',
        payload: { error: error instanceof Error ? error.message : 'Provider request failed.' },
        failureReason: error instanceof Error ? error.message : 'Provider request failed.',
      };
    }

    const providerPayload = {
      ...(dispatch.payload || {}),
      provider: dataPackage.provider,
      providerOrderId: dispatch.orderId || null,
      providerReference: dispatch.providerReference || providerReference,
    };
    const { error: completeError } = await admin.rpc('complete_agent_data_order', {
      p_order_id: providerOrderId,
      p_success: dispatch.success,
      p_provider_response: providerPayload,
    });
    if (completeError) throw completeError;

    if (dispatch.success) {
      await admin.rpc('mark_public_data_order', {
        p_order_id: order.id,
        p_status: 'processing',
        p_provider_amount: roundMoney(dataPackage.costGhs),
        p_provider_reference: providerReference,
        p_provider_response: providerPayload,
      });
      await admin.from('public_data_orders').update({ provider_name: dataPackage.provider, provider_package_id: dataPackage.id }).eq('id', order.id);
      return json({ success: true, status: 'processing', orderReference: reference, orderCode: order.short_code });
    }

    const refund = await refundPaystack(reference);
    await admin.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: 'failed',
      p_provider_amount: roundMoney(dataPackage.costGhs),
      p_provider_reference: providerReference,
      p_provider_response: { ...providerPayload, refundRequested: refund.requested, refundSucceeded: refund.ok },
    });
    await admin.from('public_data_orders').update({
      provider_name: dataPackage.provider,
      provider_package_id: dataPackage.id,
      paystack_refund_status: refund.ok ? 'initiated' : 'failed',
    }).eq('id', order.id);
    return json({
      success: false,
      status: 'failed',
      refunded: refund.ok,
      message: refund.ok ? 'The bundle could not be delivered. Your payment has been refunded.' : 'The bundle could not be delivered. Refund processing needs administrator attention.',
    });
  } catch (error) {
    console.error('verify-public-data-payment failed:', error);
    if (reference) {
      await admin.from('public_data_orders').update({
        status: 'failed',
        provider_response: { error: error instanceof Error ? error.message : 'Guest checkout failed.' },
        completed_at: new Date().toISOString(),
      }).eq('payment_reference', reference).eq('status', 'processing');
      const refund = await refundPaystack(reference).catch(() => ({ requested: false, ok: false }));
      if (refund.ok) await admin.from('public_data_orders').update({ paystack_refund_status: 'initiated' }).eq('payment_reference', reference);
    }
    return json({ error: error instanceof Error ? error.message : 'Unable to complete this purchase.' }, 500);
  }
});
