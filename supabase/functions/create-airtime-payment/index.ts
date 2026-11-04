import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { refundWallet, getWalletBalance, WalletError } from '../_shared/wallet.ts';
import { friendlyProviderMessage } from '../_shared/providerMessages.ts';
import {
  airtimeCommissionService,
  commissionQuote,
  resolveCommissionConfig,
} from '../_shared/commissionConfig.ts';

const VALID_NETWORKS = new Set(['mtn', 'telecel', 'at']);

function generateShortCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (let i = 0; i < 5; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

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
  let walletChargeAmount = 0;
  let chargedAmount = 0;
  let orderId: string | null = null;
  let providerAccepted = false;
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

    // Hubtel Commission Services caps a single airtime top-up at 100 cedis
    // ("The maximum airtime top-up amount per request is 100 cedis"). Enforced
    // here so an over-cap request is refused before the wallet is debited,
    // rather than being accepted locally and declined by Hubtel afterwards.
    if (!Number.isFinite(rawAmount) || rawAmount < 1.00 || rawAmount > 100.00) {
      return json({
        success: false,
        error: 'Airtime amount must be between GHS 1.00 and GHS 100.00.',
        message: 'Airtime amount must be between GHS 1.00 and GHS 100.00.',
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
    const { admin, user, agent } = await requireAgent(request);
    agentId = user.id;
    netAmount = Math.round(rawAmount * 100) / 100;
    const commissionService = airtimeCommissionService(network);
    const commission = commissionQuote(
      netAmount,
      await resolveCommissionConfig(admin, commissionService),
    );
    walletChargeAmount = commission.walletChargeAmount;
    customerEmail = customerEmail || user.email || 'agent@skaitechgh.wasmer.app';
    serviceName = network === 'at' ? 'AT' : network.charAt(0).toUpperCase() + network.slice(1);

    // 2b. Fallback Auto-provision: ensure profiles, agents, and wallets rows exist
    try {
      const fallbackName = agent?.full_name || customerName || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent';
      const fallbackPhone = agent?.phone || phone || user.user_metadata?.phone || null;
      const fallbackCode = agent?.agent_code || user.user_metadata?.agent_code || null;

      await admin.from('profiles').upsert({
        id: agentId,
        full_name: fallbackName,
        phone: fallbackPhone,
        agent_code: fallbackCode,
      }, { onConflict: 'id' });

      await admin.from('agents').upsert({
        id: agentId,
        full_name: fallbackName,
        phone: fallbackPhone,
        agent_code: fallbackCode,
        role: agent?.role || user.user_metadata?.role || 'agent',
      }, { onConflict: 'id' });

      await admin.from('wallets').upsert({
        id: agentId,
        balance: 0,
      }, { onConflict: 'id', ignoreDuplicates: true });
    } catch (provisionErr) {
      console.warn('[create-airtime-payment] Auto-provision pre-check note:', provisionErr);
    }

    // 3. Idempotency Check
    if (clientRequestId) {
      const existing = await findIdempotentOrder(admin, clientRequestId, agentId);
      if (existing && existing.payment_method === 'wallet') {
        console.log('[create-airtime-payment] Found existing order for clientRequestId:', clientRequestId);
        const code = existing.short_code || generateShortCode();
        return json({
          success: true,
          idempotent: true,
          paymentMethod: 'wallet',
          orderId: code,
          shortCode: code,
          reference: code,
          paymentReference: existing.payment_reference,
          amount: existing.amount,
          network: existing.network,
          phone: existing.recipient_phone,
          airtimeStatus: existing.airtime_status,
          message: existing.airtime_status === 'failed'
            ? `This airtime attempt already failed and was refunded. (Order #${code})`
            : `This airtime purchase was already submitted. No duplicate charge was made. (Order #${code})`,
        });
      }
    }

    reference = `AIR-${crypto.randomUUID()}`;

    // 4. Atomically Deduct from Agent Wallet and Record Order
    console.log('[create-airtime-payment] Charging wallet for agent:', agentId, {
      requestedAmount: netAmount,
      walletChargeAmount,
      commissionService,
      agentCommissionAmount: commission.agentCommissionAmount,
    });
    const { data: orderData, error: orderError } = await admin.rpc('purchase_agent_airtime', {
      p_agent_id: agentId,
      p_reference: reference,
      p_phone: phone,
      p_network: network,
      p_amount: netAmount,
      p_customer_name: customerName || agent?.full_name || user.user_metadata?.full_name || 'Agent',
      p_customer_email: customerEmail,
      p_commission_service: commissionService,
    });

    if (orderError) {
      console.error('[create-airtime-payment] Wallet debit failed:', orderError);
      const isInsufficient = String(orderError.message || '').toLowerCase().includes('insufficient');
      const isFkError = String(orderError.message || '').includes('violates foreign key constraint') ||
                        String(orderError.message || '').includes('airtime_orders_agent_id_fkey');
      const errorMsg = isInsufficient
        ? `Insufficient wallet balance to purchase this GHS ${netAmount.toFixed(2)} airtime order. Required after commission sharing: GHS ${walletChargeAmount.toFixed(2)}.`
        : (isFkError
          ? 'Agent profile is currently synchronizing. Please retry in a few seconds.'
          : (orderError.message || 'Failed to process wallet payment.'));
      return json({
        success: false,
        error: errorMsg,
        message: errorMsg,
        insufficientFunds: isInsufficient || undefined,
      }, 400);
    }

    orderId = orderData?.id ? String(orderData.id) : null;
    chargedAmount = Number(orderData?.wallet_charge_amount ?? walletChargeAmount);
    walletChargeAmount = chargedAmount;

    const { error: ledgerError } = await admin.from('service_commission_ledger').upsert({
      order_table: 'airtime_orders',
      order_id: orderId,
      reference,
      agent_id: agentId,
      service: commission.service,
      transaction_amount: commission.transactionAmount,
      commission_rate_percent: commission.ratePercent,
      commission_amount: commission.commissionAmount,
      agent_share_percent: commission.agentSharePercent,
      agent_commission_amount: commission.agentCommissionAmount,
      platform_commission_amount: commission.platformCommissionAmount,
      wallet_charge_amount: chargedAmount,
      status: 'pending',
      metadata: { network, phone },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'order_table,order_id' });
    if (ledgerError) throw ledgerError;

    if (clientRequestId && orderData?.id) {
      await admin.from('airtime_orders').update({ idempotency_key: clientRequestId }).eq('id', orderData.id);
    }

    // Resolve the 5-character order ID
    let shortCode = (orderData as Record<string, unknown>)?.short_code as string | undefined;
    if (!shortCode && orderData?.id) {
      const { data: row } = await admin
        .from('airtime_orders')
        .select('short_code')
        .eq('id', orderData.id)
        .maybeSingle();
      shortCode = row?.short_code;
    }
    if (!shortCode || shortCode.length !== 5) {
      shortCode = generateShortCode();
      if (orderData?.id) {
        await admin.from('airtime_orders').update({ short_code: shortCode }).eq('id', orderData.id);
      }
    }

    // 5. Dispatch Airtime to Hubtel Provider
    console.log('[create-airtime-payment] Dispatching airtime to Hubtel:', { phone, network, amount: netAmount, reference });
    let dispatchResult;
    try {
      dispatchResult = await dispatchAirtimeTopup({
        phone,
        network: network as 'mtn' | 'telecel' | 'at',
        amount: netAmount,
        reference,
      });
    } catch (providerError) {
      // A transport error is not proof that Hubtel rejected the order. Keep the
      // wallet debit pending and let the callback/reconciliation path settle it.
      console.error('[create-airtime-payment] Hubtel transport error:', providerError);
      await admin.from('airtime_orders').update({
        airtime_status: 'pending_provider',
        provider_response: { error: providerError instanceof Error ? providerError.message : String(providerError) },
        updated_at: new Date().toISOString(),
      }).eq('id', orderData.id);
      return json({
        success: true,
        pending: true,
        paymentMethod: 'wallet',
        walletBalance: await getWalletBalance(agentId),
        orderId: shortCode,
        shortCode,
        reference: shortCode,
        orderReference: reference,
        paymentReference: reference,
        amount: netAmount,
        walletChargeAmount,
        commissionAmount: commission.commissionAmount,
        agentCommissionAmount: commission.agentCommissionAmount,
        commissionRatePercent: commission.ratePercent,
        network,
        phone,
        airtimeStatus: 'pending_provider',
        status: 'processing',
        message: 'Hubtel is confirming this airtime order. Your wallet debit is on hold; do not submit it again.',
      }, 202);
    }
    console.log('[create-airtime-payment] Hubtel response:', dispatchResult);

    // 6a. Fulfilled & Successfully Dispatched
    if (dispatchResult.success && dispatchResult.status === 'delivered') {
      providerAccepted = true;
      await admin.rpc('fulfil_airtime_order', {
        p_order_id: orderData.id,
        p_airtime_status: 'successful',
        p_provider_reference: dispatchResult.providerReference ?? null,
        p_provider_response: dispatchResult.providerResponse ?? null,
        p_failure_reason: null,
      });
      await admin.from('service_commission_ledger').update({
        status: 'earned',
        settled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('order_table', 'airtime_orders').eq('order_id', orderData.id);
      const walletBalance = await getWalletBalance(agentId);
      return json({
        success: true,
        paymentMethod: 'wallet',
        walletBalance,
        orderId: shortCode,
        shortCode,
        reference: shortCode,
        orderReference: reference,
        paymentReference: reference,
        amount: netAmount,
        walletChargeAmount,
        commissionAmount: commission.commissionAmount,
        agentCommissionAmount: commission.agentCommissionAmount,
        commissionRatePercent: commission.ratePercent,
        network,
        phone,
        airtimeStatus: 'successful',
        status: 'successful',
        message: `${serviceName} airtime top-up of GHS ${netAmount.toFixed(2)} to ${phone} was successful! (Order #${shortCode})`,
      });
    }

    // 6b. Provider accepted but not terminal. Keep it pending so a later
    // callback/status sweep can mark it delivered or refund it exactly once.
    if (dispatchResult.status === 'pending_provider') {
      providerAccepted = true;
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
        orderId: shortCode,
        shortCode,
        reference: shortCode,
        orderReference: reference,
        paymentReference: reference,
        amount: netAmount,
        walletChargeAmount,
        commissionAmount: commission.commissionAmount,
        agentCommissionAmount: commission.agentCommissionAmount,
        commissionRatePercent: commission.ratePercent,
        network,
        phone,
        airtimeStatus: 'pending_provider',
        status: 'processing',
        message: `${serviceName} airtime top-up of GHS ${netAmount.toFixed(2)} to ${phone} was accepted and is being confirmed. Do not submit it again. (Order #${shortCode})`,
      });
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

    await admin.from('service_commission_ledger').update({
      status: 'reversed',
      settled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('order_table', 'airtime_orders').eq('order_id', orderData.id);
    const walletBalance = await refundWallet(agentId, reference, chargedAmount, `${serviceName} airtime provider failed`);

    const userFacingMsg = `Airtime delivery failed: ${failureReason}. Your wallet has been refunded. (Order #${shortCode})`;
    return json({
      success: false,
      refunded: true,
      paymentMethod: 'wallet',
      walletBalance,
      orderId: shortCode,
      shortCode,
      reference: shortCode,
      orderReference: reference,
      paymentReference: reference,
      amount: netAmount,
      walletChargeAmount,
      commissionAmount: commission.commissionAmount,
      agentCommissionAmount: commission.agentCommissionAmount,
      commissionRatePercent: commission.ratePercent,
      network,
      phone,
      airtimeStatus: 'failed',
      error: userFacingMsg,
      message: userFacingMsg,
    }, 400);
  } catch (error) {
    console.error('[create-airtime-payment] Unexpected error:', error);
    if (chargedAmount > 0 && agentId && reference && !providerAccepted) {
      try {
        if (orderId) {
          await adminClient().from('airtime_orders').update({
            payment_status: 'failed',
            airtime_status: 'failed',
            failure_reason: 'Airtime purchase failed before provider confirmation.',
            updated_at: new Date().toISOString(),
          }).eq('id', orderId).in('airtime_status', ['pending', 'processing']);
          await adminClient().from('service_commission_ledger').update({
            status: 'reversed',
            settled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('order_table', 'airtime_orders').eq('order_id', orderId);
        }
        await refundWallet(agentId, reference, chargedAmount, 'Airtime purchase failed before provider confirmation');
      } catch (refundError) {
        console.error('[create-airtime-payment] Unexpected failure refund failed:', refundError);
      }
    }
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
