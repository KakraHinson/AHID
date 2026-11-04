import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import {
  commissionQuote,
  resolveCommissionConfig,
  utilityCommissionService,
} from '../_shared/commissionConfig.ts';

const VALID_BILL_TYPES: Record<string, 'electricity' | 'water' | 'tv'> = {
  ecg: 'electricity',
  ecg_postpaid: 'electricity',
  ghana_water: 'water',
  dstv: 'tv',
  gotv: 'tv',
  startimes: 'tv',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;
  let agentId = '';
  let chargedAmount = 0;
  let chargedAgentId = '';
  let chargedReference = '';
  let providerAccepted = false;
  let providerAttempted = false;
  let providerRejected = false;
  let providerReply: unknown = null;
  let updatedWalletBalance: number | null = null;
  let commission = commissionQuote(0, {
    service: 'unknown',
    label: 'Unknown',
    ratePercent: 0,
    agentSharePercent: 0,
    platformSharePercent: 100,
  });

  try {
    const body = await request.json();
    const billType = String(body.billType ?? '').trim().toLowerCase();
    // Meter numbers are strictly alphanumeric strings (e.g. "P241759005") and must not have country codes prepended
    let accountNumber = String(body.accountNumber ?? body.meterNumber ?? '').trim();
    if (/^\+?233([A-Za-z].*)$/.test(accountNumber)) {
      accountNumber = accountNumber.replace(/^\+?233/, '');
    } else if (/^\+?233(\d{8,16})$/.test(accountNumber)) {
      accountNumber = accountNumber.replace(/^\+?233/, '');
    }
    const meterType = body.meterType ? String(body.meterType).trim() : null;
    const packageName = body.packageName ? String(body.packageName).trim() : null;
    const customerPhone = String(body.customerPhone ?? '').trim();
    const amountVal = Number(body.amount);

    const billCategory = VALID_BILL_TYPES[billType];
    if (!billCategory) {
      return json({ error: 'Invalid utility bill type selected.' }, 400);
    }

    if (!accountNumber || accountNumber.length < 4 || accountNumber.length > 30) {
      return json({ error: 'Please enter a valid meter, account, or smartcard number.' }, 400);
    }

    if (!/^0\d{9}$/.test(customerPhone)) {
      return json({ error: 'Please enter a valid 10-digit Ghanaian phone number (e.g., 024XXXXXXX).' }, 400);
    }

    if (!Number.isFinite(amountVal) || amountVal < 1 || amountVal > 10000) {
      return json({ error: 'Please enter an amount between GHS 1.00 and GHS 10,000.00.' }, 400);
    }

    // WALLET-FIRST: utilities are paid from the verified agent's wallet.
    // The customer name and email are never collected from the form; they are
    // resolved from the signed-in agent so orders stay attributable.
    const { admin, user, agent } = await requireAgent(request);
    agentId = user.id;
    const customerName = String(agent.full_name || user.user_metadata?.full_name || '').trim() || null;
    const customerEmail = String(user.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(customerEmail)) {
      return json({ error: 'Your agent account has no valid email address. Add one in your profile settings to pay utility bills.' }, 400);
    }

    // Charge the exact entered amount: the Paystack checkout fee applies only
    // when funding the wallet, never to this purchase.
    const netAmount = Math.round(amountVal * 100) / 100;
    const feeAmount = 0;
    const grossAmount = netAmount;
    const commissionService = utilityCommissionService(billType);
    commission = commissionQuote(
      netAmount,
      await resolveCommissionConfig(admin, commissionService),
    );

    // ECG and Ghana Water need the customer's phone to query the account (ECG
    // keys meters by phone); Ghana Water's query also mints the session id its
    // top-up requires, so the reply is reused for the purchase below.
    const accountCheck = await callUtilityProvider('verify', { service: billType, accountNumber, meterType, customerPhone });
    if (!accountCheck.success || !accountCheck.verified) {
      return json({ error: accountCheck.message || 'The utility provider could not verify this account.' }, 422);
    }

    reference = `UTIL-${crypto.randomUUID()}`;

    updatedWalletBalance = await chargeWallet(agentId, reference, commission.walletChargeAmount, 'Utility bill payment', {
      service: 'utility_bill',
      bill_type: billType,
      account_number: accountNumber,
      commission_service: commissionService,
      commission_amount: commission.commissionAmount,
      agent_commission_amount: commission.agentCommissionAmount,
    });
    chargedAmount = commission.walletChargeAmount;
    chargedAgentId = agentId;
    chargedReference = reference;

    const { data: order, error: orderError } = await admin.from('utility_orders').insert({
      bill_type: billType,
      bill_category: billCategory,
      account_number: accountNumber,
      meter_type: meterType,
      package_name: packageName,
      amount: netAmount,
      fee_amount: feeAmount,
      gross_amount: grossAmount,
      wallet_charge_amount: commission.walletChargeAmount,
      commission_service: commissionService,
      commission_rate_percent: commission.ratePercent,
      commission_amount: commission.commissionAmount,
      agent_commission_amount: commission.agentCommissionAmount,
      platform_commission_amount: commission.platformCommissionAmount,
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      payment_reference: reference,
      status: 'processing',
      agent_id: agentId,
    }).select('id').single();

    if (orderError) throw orderError;
    orderId = order.id;

    const { error: ledgerError } = await admin.from('service_commission_ledger').upsert({
      order_table: 'utility_orders',
      order_id: order.id,
      reference,
      agent_id: agentId,
      service: commission.service,
      transaction_amount: commission.transactionAmount,
      commission_rate_percent: commission.ratePercent,
      commission_amount: commission.commissionAmount,
      agent_share_percent: commission.agentSharePercent,
      agent_commission_amount: commission.agentCommissionAmount,
      platform_commission_amount: commission.platformCommissionAmount,
      wallet_charge_amount: commission.walletChargeAmount,
      status: 'pending',
      metadata: { billType, accountNumber },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'order_table,order_id' });
    if (ledgerError) throw ledgerError;

    providerAttempted = true;
    const providerResult = await callUtilityProvider('purchase', {
      service: billType,
      accountNumber,
      meterType,
      packageName,
      amount: netAmount,
      customerName: customerName || accountCheck.customerName || null,
      customerPhone,
      phone: customerPhone,
      mobile: customerPhone,
      customerEmail,
      sessionId: accountCheck.sessionId,
      reference,
    });
    providerReply = providerResult.raw;
    if (providerResult.pending) {
      providerAccepted = true;
      await admin.from('utility_orders').update({
        status: 'processing',
        provider_reference: providerResult.providerReference ?? null,
        provider_response: providerResult.raw,
        paid_at: new Date().toISOString(),
      }).eq('id', order.id).eq('status', 'processing');
      return json({
        success: true,
        pending: true,
        walletBalance: updatedWalletBalance,
        reference,
        amount: netAmount,
        grossAmount,
        feeAmount,
        walletChargeAmount: commission.walletChargeAmount,
        commissionAmount: commission.commissionAmount,
        agentCommissionAmount: commission.agentCommissionAmount,
        commissionRatePercent: commission.ratePercent,
        billType,
        status: 'processing',
        token: null,
        customerName,
        customerPhone,
        message: 'Hubtel accepted the utility payment. The provider is confirming delivery; do not submit it again.',
      }, 202);
    }
    if (!providerResult.success) {
      providerRejected = true;
      throw new Error(providerResult.message || 'The utility provider declined this payment.');
    }
    providerAccepted = true;
    const completedAt = new Date().toISOString();
    const { error: completionError } = await admin.from('utility_orders').update({
      status: 'completed', token_code: providerResult.token ?? null,
      provider_reference: providerResult.providerReference ?? null,
      provider_response: providerResult.raw,
      paid_at: completedAt, completed_at: completedAt,
      customer_name: customerName || accountCheck.customerName || null,
    }).eq('id', order.id);
    if (completionError) throw completionError;
    await admin.from('service_commission_ledger').update({
      status: 'earned',
      settled_at: completedAt,
      updated_at: completedAt,
    }).eq('order_table', 'utility_orders').eq('order_id', order.id);

    return json({
      success: true,
      walletBalance: updatedWalletBalance,
      reference,
      amount: netAmount,
      grossAmount,
      feeAmount,
      walletChargeAmount: commission.walletChargeAmount,
      commissionAmount: commission.commissionAmount,
      agentCommissionAmount: commission.agentCommissionAmount,
      commissionRatePercent: commission.ratePercent,
      billType,
      status: 'completed',
      token: providerResult.token ?? null,
      customerName,
      customerPhone,
      message: billType === 'ecg'
        ? (providerResult.token
          ? 'Your electricity token has been generated successfully.'
          : 'Your ECG top-up was completed. The token is sent to the customer by SMS.')
        : 'Your utility bill payment has been completed successfully.',
    });
  } catch (error) {
    console.error('Utility bill payment error:', error);
    if (chargedAmount > 0 && chargedAgentId && chargedReference) {
      try {
        const admin = adminClient();
        const { data: order } = orderId ? await admin.from('utility_orders')
          .select('amount, status')
          .eq('id', orderId)
          .maybeSingle() : { data: null };
        if (providerAccepted || (providerAttempted && !providerRejected)) {
          if (order) await admin.from('utility_orders').update({
            status: 'processing', provider_response: providerReply ?? { message: error instanceof Error ? error.message : 'Provider response is pending.' },
            provider_reference: (providerReply as Record<string, unknown> | null)?.providerReference ?? null,
          }).eq('id', orderId);
        } else if (!order || !['paid', 'completed'].includes(order.status)) {
          await refundWallet(chargedAgentId, chargedReference, chargedAmount, 'Utility bill fulfilment failed');
        }
        if (!providerAccepted && providerRejected && orderId) {
          await admin.from('service_commission_ledger').update({
            status: 'reversed',
            settled_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('order_table', 'utility_orders').eq('order_id', orderId);
        }
        if (!providerAccepted && order && !['paid', 'completed'].includes(order.status)) {
          await admin.from('utility_orders').update({
            status: 'failed',
            provider_response: { error: error instanceof Error ? error.message : 'Fulfilment failed' },
            completed_at: new Date().toISOString(),
          }).eq('id', orderId);
        }
      } catch (innerError) {
        console.error('Utility refund/rollback failed:', innerError);
      }
    }
    const message = error instanceof Error ? error.message : 'Unable to process utility bill payment.';
    if (providerAccepted || (providerAttempted && !providerRejected)) {
      return json({
        success: true,
        status: 'processing',
        reference,
        walletBalance: updatedWalletBalance,
        walletChargeAmount: commission.walletChargeAmount,
        commissionAmount: commission.commissionAmount,
        agentCommissionAmount: commission.agentCommissionAmount,
        commissionRatePercent: commission.ratePercent,
        message: 'The provider response is pending. Your payment is recorded; check Orders or contact support if the status does not update.',
      }, 202);
    }
    const insufficient = message.toLowerCase().includes('insufficient');
    // An absent, expired or malformed session must surface as 401, or the
    // client shows a generic failure instead of sending the agent to log in.
    const status = /utility provider API is not configured|provider API is not configured|not configured/i.test(message)
      ? 503
      : /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : insufficient
          ? 400
          : 500;
    return json({
      error: message,
      providerConfigured: status !== 503,
      insufficientFunds: insufficient || undefined,
    }, status);
  }
});
