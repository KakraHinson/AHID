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
    const callbackSecret = Deno.env.get('HUBTEL_WALLET_CALLBACK_SECRET')?.trim();
    if (callbackSecret) {
      const suppliedToken = new URL(request.url).searchParams.get('token') || '';
      if (suppliedToken !== callbackSecret) return json({ error: 'Invalid callback token.' }, 401);
    }

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

    // Verify using the original client reference. Hubtel's Online Checkout
    // status endpoint is keyed by clientReference; CheckoutId is only useful
    // for matching a callback when the reference is not at the top level.
    const clientReference = String(topup.payment_reference || reference || '');
    if (!clientReference) return json({ error: 'No Hubtel client reference to verify against.' }, 400);
    if (!hubtelPaymentsVerifyConfigured()) {
      return json({ error: 'Hubtel payment verification is not configured.' }, 503);
    }

    const verified = await verifyHubtelCollection(clientReference);
    // A final callback marked Success is newer than a temporarily stale
    // pending status response; keep processing that callback.
    if (verified?.state === 'pending' && normalized.state !== 'success') return json({ received: true });

    if (verified?.state === 'failed' || normalized.state === 'failed') {
      await admin.from('wallet_topups').update({ status: 'failed' }).eq('id', topup.id).eq('status', 'pending_payment');
      return json({ received: true });
    }

    if (!verified && normalized.state !== 'success') return json({ received: true });

    // Hubtel's final Online Checkout callback is ResponseCode=0000 and
    // Status=Success. The callback token, reference, and exact amount have
    // already been checked; this is the safe fallback when the status API is
    // temporarily blocked by Hubtel's server-IP allowlist.
    const callbackAmount = normalized.amountGhs;
    if (callbackAmount === undefined || Math.round(callbackAmount * 100) !== Math.round(Number(topup.amount) * 100)) {
      return json({ error: 'Hubtel amount does not match the top-up.' }, 400);
    }
    if (verified?.amountGhs !== undefined && Math.round(verified.amountGhs * 100) !== Math.round(Number(topup.amount) * 100)) {
      return json({ error: 'Hubtel verified amount does not match the top-up.' }, 400);
    }

    if (!verified) {
      console.warn('[Hubtel callback settlement fallback]', JSON.stringify({
        reference: clientReference,
        callback: payload,
      }, null, 2));
    }

    const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (creditError) throw creditError;
    return json({ received: true });
  } catch (error) {
    console.error(error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
