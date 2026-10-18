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
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    const network = String(body.network ?? '').trim().toLowerCase();
    const phone = String(body.phone ?? '').trim();
    const rawAmount = Number(body.amount);
    const customerName = String(body.customerName ?? body.name ?? '').trim();
    let customerEmail = String(body.customerEmail ?? body.email ?? '').trim().toLowerCase();
    const clientRequestId = String(body.clientRequestId ?? body.idempotencyKey ?? '').trim() || null;

    // Validation
    if (!VALID_NETWORKS.has(network)) {
      return json({ error: 'Invalid network selection. Choose MTN, Telecel, or AT.' }, 400);
    }

    if (!/^0[235]\d{8}$/.test(phone)) {
      return json({ error: 'Please enter a valid 10-digit Ghanaian phone number (e.g. 024XXXXXXX).' }, 400);
    }

    if (!Number.isFinite(rawAmount) || rawAmount < 1.00 || rawAmount > 500.00) {
      return json({ error: 'Airtime amount must be between GHS 1.00 and GHS 500.00.' }, 400);
    }

    // WALLET-FIRST: airtime is an AGENTS-ONLY service paid from the agent wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;
    const netAmount = Math.round(rawAmount * 100) / 100;
    customerEmail = customerEmail || user.email || 'agent@skaitechgh.com';

    if (clientRequestId) {
      const existing = await findIdempotentOrder(admin, clientRequestId, agentId);
      if (existing && existing.payment_method === 'wallet') {
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

    const reference = `AIR-${crypto.randomUUID()}`;
    const serviceName = network === 'at' ? 'AT' : network.charAt(0).toUpperCase() + network.slice(1);

    // 1. Atomically deduct from wallet, create order, and log the ledger debit.
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
      console.error('Wallet deduction error:', orderError);
      const isInsufficient = String(orderError.message || '').toLowerCase().includes('insufficient');
      return json({ error: orderError.message || 'Failed to process wallet payment.', insufficientFunds: isInsufficient || undefined }, 400);
    }

    if (clientRequestId) {
      await admin.from('airtime_orders').update({ idempotency_key: clientRequestId }).eq('id', orderData.id);
    }

    // 2. Dispatch airtime to the provider (Hubtel).
    const dispatchResult = await dispatchAirtimeTopup({
      phone,
      network: network as 'mtn' | 'telecel' | 'at',
      amount: netAmount,
      reference,
    });

    // 3a. DELIVERED -> mark order fulfilled.
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
        message: `${serviceName} airtime top-up successful!`,
      });
    }

    // Commission Services returns 0001 when it accepted the request but has
    // not finished delivery. Keep the wallet debit and let the callback settle
    // the order; refunding here could deliver airtime for free later.
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
        message: 'Hubtel accepted the airtime request. Delivery is being confirmed; do not resend.',
      }, 202);
    }

    // 3b. A definitive provider failure refunds the wallet and marks the order failed.
    const failureReason = friendlyProviderMessage(dispatchResult.failureReason, network) ||
      'The airtime provider did not accept the top-up.';
    await admin.from('airtime_orders').update({
      payment_status: 'failed',
      airtime_status: 'failed',
      provider_reference: dispatchResult.providerReference ?? null,
      provider_response: dispatchResult.providerResponse ?? null,
      failure_reason: failureReason,
      updated_at: new Date().toISOString(),
    }).eq('id', orderData.id);

    const walletBalance = await refundWallet(agentId, reference, netAmount, `${serviceName} airtime provider failed`);

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
      message: `Airtime delivery failed: ${failureReason} Your wallet has been refunded.`,
    }, 502);
  } catch (error) {
    console.error('Airtime payment error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process airtime purchase.';
    const isInsufficient = error instanceof WalletError && error.code === 'insufficient';
    const status = isInsufficient
      ? 400
      : /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({ error: message, insufficientFunds: isInsufficient || undefined }, status);
  }
});
