import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { refundWallet, getWalletBalance, WalletError } from '../_shared/wallet.ts';
import { friendlyProviderMessage } from '../_shared/providerMessages.ts';

const VALID_NETWORKS = new Set(['mtn', 'telecel', 'at']);

async function findIdempotentOrder(admin: ReturnType<typeof adminClient>, key: string, agentId: string) {
  if (!key) return null;
  const { data } = await admin
    .from('airtime_orders')
    .select('*')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (!data || data.agent_id !== agentId) return null;
  return data;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method not allowed', message: 'Method not allowed' }, 405);
  }

  let agentId = '';
  let reference = '';
  let netAmount = 0;
  let serviceName = '';
  let network = '';

  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    network = String(body.network ?? '').trim().toLowerCase();
    const phone = String(body.phone ?? body.recipient ?? '').trim().replace(/[\s-]/g, '');
    const rawAmount = Number(body.amount);
    const paymentMethod = String(body.paymentMethod ?? 'wallet').trim().toLowerCase();
    const customerName = String(body.customerName ?? body.name ?? '').trim();
    let customerEmail = String(body.customerEmail ?? body.email ?? '').trim().toLowerCase();
    const clientRequestId = String(body.clientRequestId ?? body.idempotencyKey ?? '').trim() || null;

    console.log('[create-airtime-payment] Request received:', {
      network,
      phone,
      amount: rawAmount,
      paymentMethod,
      clientRequestId,
    });

    // 1. Parameter Validation
    if (!network || !VALID_NETWORKS.has(network)) {
      return json({
        success: false,
        error: 'Invalid network selection. Please select MTN, Telecel, or AT.',
        message: 'Invalid network selection. Please select MTN, Telecel, or AT.',
      }, 400);
    }

    if (!phone || !/^0\d{9}$/.test(phone)) {
      return json({
        success: false,
        error: 'Please enter a valid 10-digit Ghanaian mobile number (e.g. 0244123456).',
        message: 'Please enter a valid 10-digit Ghanaian mobile number (e.g. 0244123456).',
      }, 400);
    }

    if (!Number.isFinite(rawAmount) || rawAmount < 1.00 || rawAmount > 500.00) {
      return json({
        success: false,
        error: 'Airtime amount must be between GHS 1.00 and GHS 500.00.',
        message: 'Airtime amount must be between GHS 1.00 and GHS 500.00.',
      }, 400);
    }

    if (paymentMethod !== 'wallet') {
      return json({
        success: false,
        error: 'Only wallet payments are currently supported for airtime.',
        message: 'Only wallet payments are currently supported for airtime.',
      }, 400);
    }

    // 2. Verified Agent Authentication & Authorization
    const { admin, user } = await requireAgent(request);
    agentId = user.id;
    netAmount = Math.round(rawAmount * 100) / 100;
    customerEmail = customerEmail || user.email || 'agent@skaitechgh.wasmer.app';
    serviceName = network === 'at' ? 'AT' : network.charAt(0).toUpperCase() + network.slice(1);

    // 3. Idempotency Check
    if (clientRequestId) {
      const existing = await findIdempotentOrder(admin, clientRequestId, agentId);
      if (existing && existing.payment_method === 'wallet') {
        console.log('[create-airtime-payment] Found existing order for clientRequestId:', clientRequestId);
        return json({
          success: true,
          idempotent: true,
          paymentMethod: 'wallet',
          reference: existing.payment_reference,
          amount: existing.amount,
          network: existing.network,
          phone: existing.recipient_phone,
          airtimeStatus: existing.airtime_status,
          message: existing.airtime_status === 'failed'
            ? 'This airtime attempt already failed and was refunded.'
            : 'This airtime purchase was already submitted. No duplicate charge was made.',
        });
      }
    }

    reference = `AIR-${crypto.randomUUID()}`;

    // 4. Atomically Deduct from Agent Wallet and Record Order
    console.log('[create-airtime-payment] Charging wallet for agent:', agentId, 'Amount:', netAmount);
    const { data: orderData, error: orderError } = await admin.rpc('purchase_agent_airtime', {
      p_agent_id: agentId,
      p_reference: reference,
      p_phone: phone,
      p_network: network,
      p_amount: netAmount,
      p_customer_name: customerName || user.user_metadata?.full_name || 'Agent',
      p_customer_email: customerEmail,
    });

    if (orderError) {
      console.error('[create-airtime-payment] Wallet debit failed:', orderError);
      const isInsufficient = String(orderError.message || '').toLowerCase().includes('insufficient');
      const errorMsg = isInsufficient
        ? `Insufficient wallet balance to purchase GHS ${netAmount.toFixed(2)} airtime. Please deposit funds.`
        : (orderError.message || 'Failed to process wallet payment.');
      return json({
        success: false,
        error: errorMsg,
        message: errorMsg,
        insufficientFunds: isInsufficient || undefined,
      }, 400);
    }

    if (clientRequestId && orderData?.id) {
      await admin.from('airtime_orders').update({ idempotency_key: clientRequestId }).eq('id', orderData.id);
    }

    // 5. Dispatch Airtime to Hubtel Provider
    console.log('[create-airtime-payment] Dispatching airtime to Hubtel:', { phone, network, amount: netAmount, reference });
    const dispatchResult = await dispatchAirtimeTopup({
      phone,
      network: network as 'mtn' | 'telecel' | 'at',
      amount: netAmount,
      reference,
    });
    console.log('[create-airtime-payment] Hubtel response:', dispatchResult);

    // 6a. Fulfilled & Delivered
    if (dispatchResult.success && dispatchResult.status === 'delivered') {
      await admin.rpc('fulfil_airtime_order', {
        p_order_id: orderData.id,
        p_airtime_status: 'delivered',
        p_provider_reference: dispatchResult.providerReference ?? null,
        p_provider_response: dispatchResult.providerResponse ?? null,
        p_failure_reason: null,
      });
      const walletBalance = await getWalletBalance(agentId);
      return json({
        success: true,
        paymentMethod: 'wallet',
        walletBalance,
        reference,
        amount: netAmount,
        network,
        phone,
        airtimeStatus: 'delivered',
        message: `${serviceName} airtime top-up of GHS ${netAmount.toFixed(2)} to ${phone} was successful!`,
      });
    }

    // 6b. Pending Provider Confirmation
    if (dispatchResult.status === 'pending_provider') {
      await admin.from('airtime_orders').update({
        payment_status: 'paid',
        airtime_status: 'pending_provider',
        provider_reference: dispatchResult.providerReference ?? null,
        provider_response: dispatchResult.providerResponse ?? null,
        failure_reason: dispatchResult.failureReason ?? null,
        updated_at: new Date().toISOString(),
      }).eq('id', orderData.id);

      const walletBalance = await getWalletBalance(agentId);
      return json({
        success: true,
        pending: true,
        paymentMethod: 'wallet',
        walletBalance,
        reference,
        amount: netAmount,
        network,
        phone,
        airtimeStatus: 'pending_provider',
        message: 'Hubtel accepted the airtime request. Delivery is being confirmed; please do not resend.',
      }, 202);
    }

    // 6c. Provider Rejected / Failed -> Auto-refund Wallet
    const failureReason = friendlyProviderMessage(dispatchResult.failureReason, network) ||
      'The airtime provider did not accept the top-up.';
    console.warn('[create-airtime-payment] Provider dispatch failed, issuing refund:', failureReason);

    await admin.from('airtime_orders').update({
      payment_status: 'failed',
      airtime_status: 'failed',
      provider_reference: dispatchResult.providerReference ?? null,
      provider_response: dispatchResult.providerResponse ?? null,
      failure_reason: failureReason,
      updated_at: new Date().toISOString(),
    }).eq('id', orderData.id);

    const walletBalance = await refundWallet(agentId, reference, netAmount, `${serviceName} airtime provider failed`);

    const userFacingMsg = `Airtime delivery failed: ${failureReason}. Your wallet has been refunded.`;
    return json({
      success: false,
      refunded: true,
      paymentMethod: 'wallet',
      walletBalance,
      reference,
      amount: netAmount,
      network,
      phone,
      airtimeStatus: 'failed',
      error: userFacingMsg,
      message: userFacingMsg,
    }, 400);
  } catch (error) {
    console.error('[create-airtime-payment] Unexpected error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process airtime purchase.';
    const isInsufficient = error instanceof WalletError && error.code === 'insufficient';
    const status = isInsufficient
      ? 400
      : /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({
      success: false,
      error: message,
      message,
      insufficientFunds: isInsufficient || undefined,
    }, status);
  }
});
