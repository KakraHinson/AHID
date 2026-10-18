import { adminClient, json } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import { fulfilStoreOrder } from '../_shared/storeOrderFulfillment.ts';

async function signatureFor(payload: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!secret) return json({ error: 'Payment webhook is not configured.' }, 500);
  const payload = await request.text();
  if (request.headers.get('x-paystack-signature') !== await signatureFor(payload, secret)) return json({ error: 'Invalid signature' }, 401);
  try {
    const event = JSON.parse(payload);
    if (event.event !== 'charge.success') return json({ received: true });
    const reference = event.data?.reference;
    const admin = adminClient();

    // 0. Store Data Bundle Order (direct customer purchase with agent profit margin credit)
    if (event.data?.metadata?.payment_type === 'store_order' || String(reference).startsWith('STR-')) {
      await fulfilStoreOrder(reference);
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'wallet_topup') {
      const { data: topup, error: topupError } = await admin.from('wallet_topups')
        .select('*').eq('payment_reference', reference).single();
      if (topupError || !topup || topup.status === 'paid') return json({ received: true });
      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(topup.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }
      const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
      if (creditError) throw creditError;
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'public_data') {
      const { data: order, error: orderError } = await admin.from('public_data_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || order.status !== 'pending_payment') return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(order.sale_amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }

      const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID');
      if (!companyAgentId) throw new Error('Public data provider funding is not configured.');
      await admin.from('public_data_orders').update({ status: 'processing' }).eq('id', order.id).eq('status', 'pending_payment');

      const dataPackage = await resolveDataPackage(order.network_type, order.volume_mb);
      if (!dataPackage) throw new Error('Unable to confirm the provider bundle price.');
      const providerCost = dataPackage.costGhs;
      if (!Number.isFinite(providerCost) || providerCost <= 0) throw new Error('Unable to confirm the provider bundle price.');

      const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
      const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
        p_agent_id: companyAgentId, p_reference: providerReference, p_network_type: order.network_type,
        p_phone: order.customer_phone, p_volume_mb: order.volume_mb, p_amount: Math.round(providerCost * 100) / 100,
      });
      if (reserveError) throw reserveError;

      let providerPayload: Record<string, unknown> = {};
      let success = false;
      try {
        const dispatch = await buyDataPackage(dataPackage, order.network_type, order.customer_phone);
        providerPayload = dispatch.payload;
        success = dispatch.success;
      } catch (providerError) {
        providerPayload = { error: providerError instanceof Error ? providerError.message : 'Provider request failed.' };
      }
      const { error: completeError } = await admin.rpc('complete_agent_data_order', {
        p_order_id: providerOrderId, p_success: success, p_provider_response: providerPayload,
      });
      if (completeError) throw completeError;
      await admin.rpc('mark_public_data_order', {
        p_order_id: order.id, p_status: success ? 'successful' : 'failed', p_provider_amount: providerCost,
        p_provider_reference: providerReference,
        p_provider_response: { ...providerPayload, provider: dataPackage.provider, providerOrderId: providerPayload.order_id ?? providerPayload.orderId ?? null },
      });
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'utility_bill' || String(reference).startsWith('UTIL-')) {
      const { data: order, error: orderError } = await admin.from('utility_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || ['paid', 'completed', 'processing', 'failed'].includes(order.status)) return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Number(order.gross_amount) > 0
        ? Math.round(Number(order.gross_amount) * 100)
        : Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100 * 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== expectedGross || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }
      const accountCheck = await callUtilityProvider('verify', {
        service: order.bill_type, accountNumber: order.account_number, meterType: order.meter_type,
      });
      if (!accountCheck.success || !accountCheck.verified) {
        const refund = await fetch('https://api.paystack.co/refund', {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: reference }),
        });
        await admin.from('utility_orders').update({ status: 'failed', provider_response: { error: accountCheck.message || 'Account verification failed.', refund_requested: refund.ok } }).eq('id', order.id);
        return json({ received: true });
      }
      const providerResult = await callUtilityProvider('purchase', {
        service: order.bill_type, accountNumber: order.account_number, meterType: order.meter_type,
        packageName: order.package_name, amount: Number(order.amount), customerName: order.customer_name,
        customerPhone: order.customer_phone, customerEmail: order.customer_email, reference,
      });
      if (providerResult.pending) {
        await admin.from('utility_orders').update({
          status: 'processing',
          provider_reference: providerResult.providerReference ?? null,
          provider_response: { provider: providerResult.raw, paystack_reference: reference },
          paid_at: new Date().toISOString(),
        }).eq('id', order.id);
        return json({ received: true, pending: true });
      }
      if (!providerResult.success || (order.bill_type === 'ecg' && !providerResult.token)) {
        const refund = await fetch('https://api.paystack.co/refund', {
          method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ transaction: reference }),
        });
        await admin.from('utility_orders').update({ status: 'failed', provider_response: { ...providerResult.raw as Record<string, unknown>, refund_requested: refund.ok } }).eq('id', order.id);
        return json({ received: true });
      }
      const completedAt = new Date().toISOString();
      const { error: fulfilError } = await admin.from('utility_orders').update({
        status: 'completed', token_code: providerResult.token ?? null,
        provider_reference: providerResult.providerReference ?? null,
        provider_response: { provider: providerResult.raw, paystack_reference: reference },
        paid_at: completedAt, completed_at: completedAt,
      }).eq('id', order.id);
      if (fulfilError) throw fulfilError;
      return json({ received: true });
    }

    if (event.data?.metadata?.payment_type === 'airtime' || String(reference).startsWith('AIR-')) {
      const { data: order, error: orderError } = await admin.from('airtime_orders')
        .select('*').eq('payment_reference', reference).single();
      if (orderError || !order || order.payment_status === 'paid') return json({ received: true });

      const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const transaction = await verified.json();
      const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
      const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
      const expectedGross = Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
      if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
        return json({ error: 'Payment verification failed.' }, 400);
      }

      await admin.from('airtime_orders').update({
        payment_status: 'paid',
        airtime_status: 'processing',
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);

      const dispatchResult = await dispatchAirtimeTopup({
        phone: order.recipient_phone,
        network: order.network,
        amount: Number(order.amount),
        reference,
      });

      const { error: fulfilError } = await admin.rpc('fulfil_airtime_order', {
        p_order_id: order.id,
        p_airtime_status: dispatchResult.status,
        p_provider_reference: dispatchResult.providerReference ?? null,
        p_provider_response: dispatchResult.providerResponse ?? null,
        p_failure_reason: dispatchResult.failureReason ?? null,
      });
      if (fulfilError) throw fulfilError;
      return json({ received: true });
    }

    const { data: order, error } = await admin.from('results_orders').select('*').eq('payment_reference', reference).single();
    if (error || !order) return json({ received: true });
    if (order.status === 'paid') return json({ received: true });

    const verified = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const transaction = await verified.json();
    const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
    const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
    const expectedGross = Math.round(((Number(order.amount) / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
    if (!verified.ok || transaction.data?.status !== 'success' || transaction.data.amount !== Math.round(expectedGross * 100) || transaction.data.currency !== 'GHS') {
      return json({ error: 'Payment verification failed.' }, 400);
    }
    const { error: fulfilError } = await admin.rpc('fulfil_result_checker_order', { p_order_id: order.id });
    if (fulfilError) throw fulfilError;
    return json({ received: true });
  } catch (error) {
    console.error(error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
