import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { hubtelPaymentsConfigured, initializeHubtelCollection } from '../_shared/hubtelPayments.ts';

/**
 * Starts a wallet top-up through either gateway. Paystack and Hubtel are used
 * together: the agent picks one, and whichever settles credits the wallet the
 * same way (both webhooks call the one idempotent `fulfil_wallet_topup`).
 *
 * Paystack charges the customer the amount grossed up for its 1.5% fee, so the
 * wallet receives the round amount entered. Hubtel's fee is not yet known, so a
 * Hubtel top-up charges the exact amount entered and credits the same.
 */

function getCustomerCoveredGrossAmount(netAmount: number) {
  const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.015');
  const safeRate = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1 ? feeRate : 0.015;
  return Math.round(((netAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin, user } = await requireAgent(request);
    if (!user.email) return json({ error: 'An email is required on your agent account.' }, 400);

    const body = await request.json().catch(() => ({}));
    const value = Number(body.amount);
    if (!Number.isFinite(value) || value < 1 || value > 10000) return json({ error: 'Enter an amount between GHS 1.00 and GHS 10,000.00.' }, 400);

    const provider: 'paystack' | 'hubtel' = String(body.provider).toLowerCase() === 'hubtel' ? 'hubtel' : 'paystack';
    const netAmount = Math.round(value * 100) / 100;
    const siteUrl = Deno.env.get('SITE_URL');
    if (!siteUrl) throw new Error('Wallet payments are not configured yet.');
    if (!/^https?:\/\//i.test(siteUrl)) throw new Error('SITE_URL must be a complete http or https URL.');
    const reference = `WAL-${crypto.randomUUID()}`;
    const callbackUrl = `${siteUrl}/deposit.html?reference=${encodeURIComponent(reference)}`;

    if (provider === 'hubtel') {
      // Refuse before creating a row when Hubtel is not switched on.
      if (!hubtelPaymentsConfigured()) {
        return json({ error: 'Hubtel payments are not switched on yet. Please use Paystack.' }, 503);
      }
      const { data: topup, error: topupError } = await admin.from('wallet_topups').insert({
        agent_id: user.id,
        amount: netAmount,
        payment_reference: reference,
        provider: 'hubtel',
      }).select('id').single();
      if (topupError) throw topupError;

      const init = await initializeHubtelCollection({
        reference,
        amountGhs: netAmount,
        returnUrl: callbackUrl,
        description: `Skaitech wallet top-up for ${user.email}`,
      });
      if (init.orderId) {
        await admin.from('wallet_topups').update({ provider_order_id: init.orderId }).eq('id', topup.id);
      }
      return json({
        authorizationUrl: init.authorizationUrl,
        reference,
        provider,
        netAmount,
        feeAmount: 0,
        grossAmount: netAmount,
      });
    }

    // Paystack (default).
    const grossAmount = getCustomerCoveredGrossAmount(netAmount);
    const feeAmount = Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100;
    const { data: topup, error: topupError } = await admin.from('wallet_topups').insert({
      agent_id: user.id,
      amount: netAmount,
      payment_reference: reference,
      provider: 'paystack',
    }).select('id').single();
    if (topupError) throw topupError;

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) throw new Error('Wallet payments are not configured yet.');
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(grossAmount * 100),
        currency: 'GHS',
        reference,
        callback_url: callbackUrl,
        metadata: {
          payment_type: 'wallet_topup',
          wallet_topup_id: topup.id,
          agent_id: user.id,
          net_amount: netAmount,
          fee_amount: feeAmount,
          gross_amount: grossAmount,
        },
      }),
    });
    const payment = await response.json();
    if (!response.ok || payment.status !== true || !payment.data?.authorization_url) {
      throw new Error(payment.message || `Paystack rejected checkout initialization (${response.status}).`);
    }
    return json({
      authorizationUrl: payment.data.authorization_url,
      accessCode: payment.data.access_code || null,
      reference,
      provider,
      netAmount,
      feeAmount,
      grossAmount,
      customerEmail: user.email,
      paystackPublicKey: Deno.env.get('PAYSTACK_PUBLIC_KEY') || null,
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Unable to start wallet payment.';
    const status = /authentication is required|session is invalid|sign in again/i.test(message) ? 401 : 500;
    return json({ error: message }, status);
  }
});
