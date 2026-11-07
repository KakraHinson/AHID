import { adminClient, json } from '../_shared/supabase.ts';

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
    // Online Checkout callbacks use a flat root payload. Keep the fallback
    // camelCase names for status probes/replayed legacy callbacks, but do not
    // require a nested Data object to settle a wallet top-up.
    const responseCode = String(payload.ResponseCode ?? payload.responseCode ?? '').trim();
    const status = String(payload.Status ?? payload.status ?? '').trim().toUpperCase();
    const reference = String(payload.ClientReference ?? payload.clientReference ?? '').trim();
    const orderId = String(
      payload.CheckoutId ?? payload.checkoutId ?? payload.SalesInvoiceId
      ?? payload.salesInvoiceId ?? payload.OrderId ?? payload.orderId ?? ''
    ).trim();
    const amount = Number(payload.Amount ?? payload.amount);
    const isSuccessfulCallback = responseCode === '0000' && status === 'SUCCESS';
    const isFailedCallback = responseCode === '2001' || ['FAILED', 'DECLINED', 'CANCELLED', 'CANCELED'].includes(status);

    console.log('[Hubtel wallet callback]', JSON.stringify({
      responseCode,
      status,
      reference,
      amount,
      checkoutId: orderId,
    }, null, 2));

    if (!reference && !orderId) {
      console.error('[Hubtel wallet callback] Missing ClientReference and CheckoutId', payload);
      return json({ received: true, settled: false });
    }

    const admin = adminClient();
    const match = reference
      ? await admin.from('wallet_topups').select('*').eq('payment_reference', reference).maybeSingle()
      : { data: null, error: null };
    if (match.error) {
      console.error('[Hubtel wallet callback] Top-up lookup by ClientReference failed', match.error);
      return json({ received: true, settled: false }, 200);
    }
    let topup = match.data;
    if (!topup && orderId) {
      const byOrder = await admin.from('wallet_topups').select('*').eq('provider_order_id', orderId).maybeSingle();
      if (byOrder.error) {
        console.error('[Hubtel wallet callback] Top-up lookup by CheckoutId failed', byOrder.error);
        return json({ received: true, settled: false }, 200);
      }
      topup = byOrder.data;
    }
    if (!topup) {
      console.error('[Hubtel wallet callback] No matching wallet top-up', { reference, orderId });
      return json({ received: true, settled: false });
    }
    if (topup.provider !== 'hubtel' || topup.status === 'paid') return json({ received: true, settled: topup.status === 'paid' });

    const callbackUpdate: Record<string, unknown> = { provider_response: payload };
    if (orderId && !topup.provider_order_id) callbackUpdate.provider_order_id = orderId;
    const { error: callbackSaveError } = await admin
      .from('wallet_topups')
      .update(callbackUpdate)
      .eq('id', topup.id);
    if (callbackSaveError) {
      console.error('[Hubtel wallet callback] Callback persistence failed', callbackSaveError);
      return json({ received: true, settled: false }, 200);
    }

    if (isFailedCallback) {
      const { error: failedUpdateError } = await admin.from('wallet_topups')
        .update({ status: 'failed' })
        .eq('id', topup.id)
        .eq('status', 'pending_payment');
      if (failedUpdateError) console.error('[Hubtel wallet callback] Failed-status update failed', failedUpdateError);
      return json({ received: true, settled: false });
    }

    if (!isSuccessfulCallback) return json({ received: true, settled: false });
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== Math.round(Number(topup.amount) * 100)) {
      console.error('[Hubtel wallet callback] Amount mismatch', {
        reference,
        callbackAmount: amount,
        expectedAmount: Number(topup.amount),
      });
      return json({ received: true, settled: false });
    }

    const { error: creditError } = await admin.rpc('fulfil_wallet_topup', { p_topup_id: topup.id });
    if (creditError) {
      console.error('[Hubtel wallet callback] Wallet credit RPC failed', creditError);
      return json({ received: true, settled: false }, 200);
    }
    return json({ received: true, settled: true });
  } catch (error) {
    console.error('[Hubtel wallet callback] Unexpected processing failure', error);
    // Acknowledge the callback so Hubtel does not retry an already-recorded
    // event forever; the persisted payload/log identifies the failed step.
    return json({ received: true, settled: false }, 200);
  }
});
