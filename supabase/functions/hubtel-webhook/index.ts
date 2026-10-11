import { adminClient, json } from '../_shared/supabase.ts';
import { normalizeHubtel } from '../_shared/paymentGateway.ts';
import { hubtelPaymentsVerifyConfigured, verifyHubtelCollection } from '../_shared/hubtelPayments.ts';

/**
 * Hubtel checkout callback — the Hubtel half of the wallet-funding webhook, the
 * Paystack half being `paystack-webhook`. Both credit the wallet through the one
 * idempotent `fulfil_wallet_topup`, so either gateway settles the same.
 *
 * Hubtel does not sign callbacks the way Paystack does, so a callback is never
 * trusted on its own: the transaction is re-read server-side by order id and the
 * wallet is credited only when that re-read says `success`. Without a configured
 * status endpoint the callback is refused (503) rather than credited blind.
 */

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // Fall through to form-encoded handling below.
  }
  const form = new URLSearchParams(raw);
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) body[key] = value;
  return body;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const payload = await readJson(request);
    const normalized = normalizeHubtel(payload);
    const reference = normalized.reference;
    const orderId = normalized.orderId;

    if (!reference && !orderId) return json({ error: 'No reference or order id in the callback.' }, 400);

    const admin = adminClient();
    const match = reference
      ? await admin.from('wallet_topups').select('*').eq('payment_reference', reference).maybeSingle()
      : { data: null, error: null };
    let topup = match.data;
    if (!topup && orderId) {
      const byOrder = await admin.from('wallet_topups').select('*').eq('provider_order_id', orderId).maybeSingle();
      topup = byOrder.data;
    }
    if (!topup) return json({ received: true });
    if (topup.provider !== 'hubtel') return json({ received: true });
    if (topup.status === 'paid') return json({ received: true });

    const resolvedOrderId = orderId || topup.provider_order_id;
    if (!resolvedOrderId) return json({ error: 'No Hubtel order id to verify against.' }, 400);
    if (!hubtelPaymentsVerifyConfigured()) {
      return json({ error: 'Hubtel payment verification is not configured.' }, 503);
    }

    const verified = await verifyHubtelCollection(resolvedOrderId);
    if (!verified) return json({ error: 'Could not verify the Hubtel transaction.' }, 503);
    if (verified.state === 'pending') return json({ received: true });

    if (verified.state === 'failed') {
      await admin.from('wallet_topups').update({ status: 'failed' }).eq('id', topup.id).eq('status', 'pending_payment');
      return json({ received: true });
    }

    // state === 'success'. When the gateway reports an amount, it must match.
    if (verified.amountGhs !== undefined && Math.round(verified.amountGhs * 100) !== Math.round(Number(topup.amount) * 100)) {
      return json({ error: 'Hubtel amount does not match the top-up.' }, 400);
    }

    const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (creditError) throw creditError;
    return json({ received: true });
  } catch (error) {
    console.error(error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
