import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';

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

  try {
    const body = await request.json();
    const billType = String(body.billType ?? '').trim().toLowerCase();
    const accountNumber = String(body.accountNumber ?? '').trim();
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

    if (!Number.isFinite(amountVal) || amountVal < 5 || amountVal > 10000) {
      return json({ error: 'Please enter an amount between GHS 5.00 and GHS 10,000.00.' }, 400);
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

    const accountCheck = await callUtilityProvider('verify', { service: billType, accountNumber, meterType });
    if (!accountCheck.success || !accountCheck.verified) {
      return json({ error: accountCheck.message || 'The utility provider could not verify this account.' }, 422);
    }

    reference = `UTIL-${crypto.randomUUID()}`;

    updatedWalletBalance = await chargeWallet(agentId, reference, grossAmount, 'Utility bill payment', {
      service: 'utility_bill',
      bill_type: billType,
      account_number: accountNumber,
    });
    chargedAmount = grossAmount;
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
      customer_name: customerName,
      customer_phone: customerPhone,
      customer_email: customerEmail,
      payment_reference: reference,
      status: 'processing',
      agent_id: agentId,
    }).select('id').single();

    if (orderError) throw orderError;
    orderId = order.id;

    providerAttempted = true;
    const providerResult = await callUtilityProvider('purchase', {
      service: billType,
      accountNumber,
      meterType,
      packageName,
      amount: netAmount,
      customerName: customerName || accountCheck.customerName || null,
      customerPhone,
      customerEmail,
      reference,
    });
    if (!providerResult.success) {
      providerRejected = true;
      throw new Error(providerResult.message || 'The utility provider declined this payment.');
    }
    providerAccepted = true;
    providerReply = providerResult.raw;
    if (billType === 'ecg' && !providerResult.token) {
      throw new Error('The provider accepted the payment but did not return an electricity token. Contact support.');
    }
    const completedAt = new Date().toISOString();
    const { error: completionError } = await admin.from('utility_orders').update({
      status: 'completed', token_code: providerResult.token ?? null,
      provider_reference: providerResult.providerReference ?? null,
      provider_response: providerResult.raw,
      paid_at: completedAt, completed_at: completedAt,
      customer_name: customerName || accountCheck.customerName || null,
    }).eq('id', order.id);
    if (completionError) throw completionError;

    return json({
      success: true,
      walletBalance: updatedWalletBalance,
      reference,
      amount: netAmount,
      grossAmount,
      feeAmount,
      billType,
      status: 'completed',
      token: providerResult.token ?? null,
      customerName,
      customerPhone,
      message: billType === 'ecg'
        ? 'Your electricity token has been generated successfully.'
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
      return json({ success: true, status: 'processing', reference, walletBalance: updatedWalletBalance, message: 'The provider response is pending. Your payment is recorded; check Orders or contact support if the status does not update.' }, 202);
    }
    const insufficient = message.toLowerCase().includes('insufficient');
    // An absent, expired or malformed session must surface as 401, or the
    // client shows a generic failure instead of sending the agent to log in.
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : insufficient
          ? 400
          : 500;
    return json({ error: message, insufficientFunds: insufficient || undefined }, status);
  }
});
