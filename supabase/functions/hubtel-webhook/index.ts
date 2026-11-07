import { adminClient, json } from '../_shared/supabase.ts';
import { normalizeHubtel } from '../_shared/paymentGateway.ts';

/**
 * Hubtel checkout callback — the Hubtel half of the wallet-funding webhook, the
 * Paystack half being `paystack-webhook`. Both credit the wallet through the one
 * idempotent `fulfil_wallet_topup`, so either gateway settles the same.
 *
 * Hubtel does not sign production callbacks. New checkouts carry an
 * application callback token; legacy callbacks may pass only from Hubtel's
 * documented Online Checkout callback address. The reference and exact amount
 * must match the durable top-up before the wallet is credited.
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
      const sourceIp = request.headers.get('cf-connecting-ip')?.trim()
        || request.headers.get('x-real-ip')?.trim()
        || '';
      const isDocumentedHubtelSource = sourceIp === '108.129.40.25';
      if (suppliedToken !== callbackSecret && !isDocumentedHubtelSource) {
        return json({ error: 'Invalid callback token.' }, 401);
      }
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

    const callbackUpdate: Record<string, unknown> = { provider_response: payload };
    if (orderId && !topup.provider_order_id) callbackUpdate.provider_order_id = orderId;
    const { error: callbackSaveError } = await admin
      .from('wallet_topups')
      .update(callbackUpdate)
      .eq('id', topup.id);
    if (callbackSaveError) console.error('[Hubtel callback persistence failed]', callbackSaveError);

    // Hubtel's final Online Checkout callback is ResponseCode=0000 and
    // Status=Success. Settle that final callback immediately after checking
    // the private callback token, stored reference, and exact amount. Waiting
    // for the IP-allowlisted status host here can make Hubtel time out and
    // retry the callback before the wallet is credited.
    const clientReference = String(topup.payment_reference || reference || '');
    if (!clientReference) return json({ error: 'No Hubtel client reference to verify against.' }, 400);

    if (normalized.state === 'failed') {
      await admin.from('wallet_topups').update({ status: 'failed' }).eq('id', topup.id).eq('status', 'pending_payment');
      return json({ received: true });
    }
    const callbackAmount = normalized.amountGhs;
    if (normalized.state !== 'success') return json({ received: true });
    if (callbackAmount === undefined || Math.round(callbackAmount * 100) !== Math.round(Number(topup.amount) * 100)) {
      return json({ error: 'Hubtel amount does not match the top-up.' }, 400);
    }

    const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (creditError) throw creditError;
    return json({ received: true, settled: true });
  } catch (error) {
    console.error(error);
    return json({ error: 'Webhook processing failed.' }, 500);
  }
});
