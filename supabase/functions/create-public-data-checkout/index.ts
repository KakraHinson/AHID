import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { resolveDataPackage } from '../_shared/dataProvider.ts';

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function customerCoveredGrossAmount(netAmount: number) {
  const configured = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
  const feeRate = Number.isFinite(configured) && configured >= 0 && configured < 1 ? configured : 0.0195;
  return roundMoney(netAmount * (1 + feeRate));
}

/** Creates a Paystack checkout for a guest; no agent session or wallet is used. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json().catch(() => ({}));
    const bundleId = String(body.bundleId || '').trim().toLowerCase();
    const phone = String(body.phone || '').trim();
    if (!bundleId || !/^0\d{9}$/.test(phone)) {
      return json({ error: 'Select a bundle and enter a valid 10-digit Ghana customer number.' }, 400);
    }

    const siteUrl = Deno.env.get('SITE_URL')?.trim();
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')?.trim();
    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID')?.trim();
    if (!siteUrl || !/^https?:\/\//i.test(siteUrl) || !paystackSecret || !companyAgentId) {
      return json({ error: 'Guest data checkout is not configured yet. Please try again later.' }, 503);
    }

    const admin = adminClient();
    const { data: bundle, error: bundleError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, volume_mb, price, active, title')
      .eq('bundle_id', bundleId)
      .eq('active', true)
      .maybeSingle();
    if (bundleError) throw bundleError;
    if (!bundle) return json({ error: 'That bundle is no longer available. Refresh and choose another bundle.' }, 409);

    const { data: control, error: controlError } = await admin
      .from('non_agent_data_prices')
      .select('price_override, active')
      .eq('bundle_id', bundleId)
      .maybeSingle();
    if (controlError) throw controlError;
    if (control?.active === false) return json({ error: 'That bundle is temporarily unavailable.' }, 409);

    const saleAmount = roundMoney(control?.price_override == null ? Number(bundle.price) : Number(control.price_override));
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) return json({ error: 'This bundle has no valid selling price.' }, 409);

    // Confirm provider availability before taking payment. The provider cost is
    // still resolved again after Paystack verification before fulfilment.
    const dataPackage = await resolveDataPackage(String(bundle.network), Number(bundle.volume_mb));
    if (!dataPackage) {
      return json({ error: 'This bundle is temporarily unavailable from its provider. No payment was started.' }, 409);
    }

    const reference = `PUB-GUEST-${crypto.randomUUID()}`;
    const accessToken = crypto.randomUUID();
    const grossAmount = customerCoveredGrossAmount(saleAmount);
    const feeAmount = roundMoney(grossAmount - saleAmount);
    const callbackUrl = `${siteUrl.replace(/\/$/, '')}/nonAgentBuyers.html?reference=${encodeURIComponent(reference)}`;
    const customerEmail = `guest-${reference.toLowerCase().replace(/[^a-z0-9-]/g, '')}@customers.skaitechgh.app`;

    const { data: order, error: orderError } = await admin.from('public_data_orders').insert({
      payment_reference: reference,
      public_access_token: accessToken,
      customer_name: 'Guest Customer',
      customer_email: customerEmail,
      customer_phone: phone,
      network_type: String(bundle.network).toLowerCase(),
      volume_mb: Number(bundle.volume_mb),
      sale_amount: saleAmount,
      paystack_fee_amount: feeAmount,
      paystack_gross_amount: grossAmount,
      payment_provider: 'paystack',
      provider_name: dataPackage.provider,
      provider_package_id: dataPackage.id,
      status: 'pending_payment',
    }).select('id, short_code').single();
    if (orderError) throw orderError;

    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${paystackSecret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: customerEmail,
        amount: Math.round(grossAmount * 100),
        currency: 'GHS',
        reference,
        callback_url: callbackUrl,
        metadata: {
          payment_type: 'public_data',
          public_data_order_id: order.id,
          guest_checkout: true,
          bundle_id: bundleId,
          customer_phone: phone,
        },
      }),
    });
    const payment = await response.json().catch(() => ({}));
    if (!response.ok || payment.status !== true || !payment.data?.authorization_url) {
      await admin.from('public_data_orders').update({
        status: 'failed',
        provider_response: { paymentInitialization: payment.message || `Paystack returned HTTP ${response.status}` },
        completed_at: new Date().toISOString(),
      }).eq('id', order.id);
      return json({ error: payment.message || 'Paystack could not start checkout. No payment was taken.' }, 502);
    }

    return json({
      success: true,
      authorizationUrl: payment.data.authorization_url,
      reference,
      accessToken,
      orderCode: order.short_code,
      amount: saleAmount,
      grossAmount,
    });
  } catch (error) {
    console.error('create-public-data-checkout failed:', error);
    return json({ error: errorMessage(error, 'Unable to start checkout. Please try again.') }, 500);
  }
});
