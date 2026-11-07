import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from '../_shared/hubtelPayments.ts';

function getExpectedGrossAmount(netAmount: number): number {
  const configuredRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
  const feeRate = Number.isFinite(configuredRate) && configuredRate >= 0 && configuredRate < 1
    ? configuredRate
    : 0.0195;
  return Math.round(((netAmount * (1 + feeRate)) + Number.EPSILON) * 100) / 100;
}

/**
 * Verifies a Paystack wallet top-up server-side for the signed-in agent.
 * The browser may request verification, but it never supplies the amount or
 * wallet owner and it can never fulfil a top-up that was not initialized by
 * create-agent-wallet-payment.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = await requireAgent(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reference = String(body.reference ?? '').trim();
    if (!/^WAL-?[0-9a-f-]{20,}$/i.test(reference)) {
      return json({ error: 'A valid wallet payment reference is required.' }, 400);
    }

    const { data: topup, error: topupError } = await admin
      .from('wallet_topups')
      .select('id, agent_id, amount, provider, provider_order_id, status, payment_reference')
      .eq('agent_id', user.id)
      .eq('payment_reference', reference)
      .maybeSingle();
    if (topupError) throw topupError;
    if (!topup) return json({ error: 'Wallet top-up not found.' }, 404);
    if (topup.status === 'paid') {
      return json({ success: true, credited: true, status: 'paid', amount: Number(topup.amount) });
    }
    const provider = String(topup.provider || 'paystack').toLowerCase();
    if (provider === 'hubtel') {
      if (!hubtelPaymentsVerifyConfigured()) {
        return json({ success: false, pending: true, status: 'pending', message: 'Hubtel payment is still being confirmed.' });
      }
      // Hubtel's official status endpoint identifies an Online Checkout by the
      // original clientReference, not by the hosted checkout URL/id.
      const verified = await verifyHubtelCollection(String(topup.payment_reference));
      if (!verified || verified.state === 'pending') {
        return json({ success: false, pending: true, status: 'pending', message: 'Hubtel payment is still being confirmed.' });
      }
      if (verified.state === 'failed') {
        await admin.from('wallet_topups').update({ status: 'failed' }).eq('id', topup.id).eq('status', 'pending_payment');
        return json({ success: false, credited: false, status: 'failed', message: 'Hubtel payment was not successful.' });
      }
      if (verified.amountGhs !== undefined && Math.round(verified.amountGhs * 100) !== Math.round(Number(topup.amount) * 100)) {
        return json({ error: 'The verified Hubtel amount does not match this wallet top-up.' }, 400);
      }

      const { error: fulfilError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
      if (fulfilError) throw fulfilError;
      const { data: wallet, error: walletError } = await admin.from('wallets').select('balance').eq('id', user.id).maybeSingle();
      if (walletError) throw walletError;
      return json({ success: true, credited: true, status: 'paid', amount: Number(topup.amount), walletBalance: Number(wallet?.balance ?? 0) });
    }
    if (provider !== 'paystack') {
      return json({ error: 'This top-up provider is not supported.' }, 400);
    }

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) return json({ error: 'Payment verification is not configured.' }, 503);

    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    const transaction = (payload.data && typeof payload.data === 'object')
      ? payload.data as Record<string, unknown>
      : {};
    const amount = Number(topup.amount);
    const expectedGross = getExpectedGrossAmount(amount);

    if (!response.ok || transaction.status !== 'success') {
      return json({ success: false, pending: true, status: 'pending', message: 'Payment is still being confirmed.' });
    }
    if (Number(transaction.amount) !== Math.round(expectedGross * 100)
      || String(transaction.currency || '').toUpperCase() !== 'GHS') {
      return json({ error: 'The verified payment amount does not match this wallet top-up.' }, 400);
    }

    const { error: fulfilError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (fulfilError) throw fulfilError;

    const { data: wallet, error: walletError } = await admin
      .from('wallets')
      .select('balance')
      .eq('id', user.id)
      .maybeSingle();
    if (walletError) throw walletError;

    return json({
      success: true,
      credited: true,
      status: 'paid',
      amount,
      walletBalance: Number(wallet?.balance ?? 0),
    });
  } catch (error) {
    console.error('verify-wallet-topup error:', error);
    const message = error instanceof Error ? error.message : 'Unable to verify the wallet top-up.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
