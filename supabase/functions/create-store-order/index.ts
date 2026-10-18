import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { resolveDataPackage } from '../_shared/dataProvider.ts';
import { resolveAgentBundlePrice, type AgentPricingLike } from '../_shared/pricing.ts';
import { catalogPrice, formatBundleVolume, volumeForBundleId } from '../_shared/dataCatalog.ts';
import { fulfilStoreOrder } from '../_shared/storeOrderFulfillment.ts';

const round2 = (value: number) => Math.round(value * 100) / 100;
const NETWORK_LABELS: Record<string, string> = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json() as Record<string, unknown>;

    // 1. Payment Verification Handler (called by storefront inline popup callback or on-return)
    if (body.action === 'verify') {
      const reference = String(body.reference || '').trim();
      if (!reference) return json({ error: 'Order reference is required.' }, 400);

      const result = await fulfilStoreOrder(reference);
      return json(result, result.success ? 200 : 400);
    }

    // 2. Order Checkout Initialization (Paystack Direct Checkout)
    const rawSlug = String(body.slug || body.ref || body.agent || body.code || '').trim();
    const bundleId = String(body.bundleId || '').trim().toLowerCase();
    const recipient = String(body.recipient || body.phone || '').trim();
    const customerName = String(body.customerName || body.name || '').trim();
    const customerPhone = String(body.customerPhone || body.phone || '').trim();
    const customerEmail = String(body.customerEmail || body.email || '').trim().toLowerCase();
    const idempotencyKey = String(body.idempotencyKey || '').trim() || crypto.randomUUID();

    if (!bundleId) return json({ error: 'Select a data package.' }, 400);
    if (!/^0\d{9}$/.test(recipient)) return json({ error: 'Enter a valid 10-digit recipient phone number.' }, 400);
    if (!customerName || customerName.length > 120) return json({ error: 'Enter your name.' }, 400);
    if (customerEmail && !/^\S+@\S+\.\S+$/.test(customerEmail)) {
      return json({ error: 'Enter a valid email address.' }, 400);
    }

    const admin = adminClient();

    // 3. Resolve Store and Owner Agent (by slug, agent code, agent UUID, or agent full name)
    let store = null;
    if (rawSlug) {
      // 1. By store slug
      const { data: storeBySlug } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, is_active')
        .ilike('slug', rawSlug)
        .maybeSingle();
      if (storeBySlug) store = storeBySlug;

      // 2. By agent code
      if (!store) {
        const { data: agentByCode } = await admin
          .from('agents')
          .select('id')
          .ilike('agent_code', rawSlug)
          .maybeSingle();
        if (agentByCode) {
          const { data: storeByAgent } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, is_active')
            .eq('agent_id', agentByCode.id)
            .maybeSingle();
          if (storeByAgent) store = storeByAgent;
        }
      }

      // 3. By agent id UUID
      if (!store && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawSlug)) {
        const { data: storeByAgentId } = await admin
          .from('agent_stores')
          .select('id, agent_id, slug, is_active')
          .eq('agent_id', rawSlug)
          .maybeSingle();
        if (storeByAgentId) store = storeByAgentId;
      }

      // 4. By agent full name (e.g. AHIDU_MOBIRI_SEIDU -> AHIDU MOBIRI SEIDU)
      if (!store) {
        const cleanedName = rawSlug.replace(/[_-]+/g, ' ').trim();
        const { data: agentByName } = await admin
          .from('agents')
          .select('id')
          .ilike('full_name', cleanedName)
          .maybeSingle();
        if (agentByName) {
          const { data: storeByAgent } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, is_active')
            .eq('agent_id', agentByName.id)
            .maybeSingle();
          if (storeByAgent) store = storeByAgent;
        }
      }
    }

    // Fallback to active store if slug wasn't found
    if (!store || !store.is_active) {
      const { data: fallbackStore } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, is_active')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackStore) store = fallbackStore;
    }

    if (!store || !store.is_active) {
      return json({ error: 'This store is currently not available.', code: 'store_unavailable' }, 404);
    }

    const ownerId = String(store.agent_id);

    // 4. Idempotency Check
    const { data: existing } = await admin
      .from('store_orders')
      .select('reference, payment_status, fulfilment_status, sale_amount')
      .eq('agent_id', ownerId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();

    if (existing && existing.payment_status === 'paid') {
      return json({
        success: existing.fulfilment_status !== 'failed',
        orderReference: existing.reference,
        status: existing.fulfilment_status,
        replayed: true,
      });
    }

    // 5. Look up Package from bundle_catalog or canonical catalog
    const { data: catalogBundle } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, title, volume_mb, price')
      .eq('bundle_id', bundleId)
      .eq('active', true)
      .maybeSingle();

    let bundle = catalogBundle;
    if (!bundle) {
      const parsed = volumeForBundleId(bundleId);
      const catalogSalePrice = parsed ? catalogPrice(parsed.network, parsed.volumeInMB) : null;
      if (!parsed || catalogSalePrice === null) {
        return json({ error: 'That package is not available. Choose another.' }, 400);
      }
      bundle = {
        bundle_id: bundleId,
        network: parsed.network,
        title: `${NETWORK_LABELS[parsed.network] ?? parsed.network.toUpperCase()} ${formatBundleVolume(parsed.volumeInMB)}`,
        volume_mb: parsed.volumeInMB,
        price: catalogSalePrice,
      };
    }

    const networkType = String(bundle.network).toLowerCase();
    const volumeInMB = Number(bundle.volume_mb);
    const platformPrice = round2(Number(bundle.price));

    if (!Number.isFinite(platformPrice) || platformPrice <= 0) {
      return json({ error: 'That package is not available. Choose another.' }, 400);
    }

    // 6. Look up Agent's custom selling price (checks both agent_pricing and store_products)
    const { data: override } = await admin
      .from('store_products')
      .select('price, is_enabled')
      .eq('store_id', store.id)
      .eq('product_type', 'data_bundle')
      .eq('product_ref', bundleId)
      .maybeSingle();

    if (override && override.is_enabled === false) {
      return json({ error: 'This package is not sold on this store.' }, 400);
    }

    const gb = volumeInMB / 1024;
    const candidateKeys = [
      Number.isInteger(gb) && gb > 0 ? `price_${networkType}_${gb}gb` : null,
      `price_${networkType}_${volumeInMB}mb`,
      `price_${bundleId.replace(/[- ]+/g, '_')}`,
      bundleId,
    ].filter(Boolean) as string[];

    const { data: pricingRows } = await admin
      .from('agent_pricing')
      .select('pricing_key, price')
      .eq('agent_id', ownerId)
      .in('pricing_key', candidateKeys);

    let customPrice: number | null = null;
    if (pricingRows && pricingRows.length > 0) {
      for (const key of candidateKeys) {
        const found = pricingRows.find((r) => String(r.pricing_key).toLowerCase() === key.toLowerCase());
        if (found && Number.isFinite(Number(found.price)) && Number(found.price) > 0) {
          customPrice = round2(Number(found.price));
          break;
        }
      }
    }

    let saleAmount = platformPrice;
    if (override && Number.isFinite(Number(override.price)) && Number(override.price) > 0 && Number(override.price) !== platformPrice) {
      saleAmount = round2(Number(override.price));
    } else if (customPrice !== null) {
      saleAmount = round2(customPrice);
    } else if (override && Number.isFinite(Number(override.price)) && Number(override.price) > 0) {
      saleAmount = round2(Number(override.price));
    }

    if (saleAmount < platformPrice) saleAmount = platformPrice;

    // Confirm upstream package availability
    const dataPackage = await resolveDataPackage(networkType, volumeInMB);
    if (!dataPackage) {
      return json({ error: 'This bundle is temporarily unavailable from provider.' }, 409);
    }
    const providerCost = round2(dataPackage.costGhs);

    // Automatic Paystack Fee Calculation (1.95% transaction processing fee)
    const feeRate = Number(Deno.env.get('PAYSTACK_FEE_PERCENT') ?? '0.0195');
    const safeRate = Number.isFinite(feeRate) && feeRate > 0 && feeRate < 1 ? feeRate : 0.0195;
    const grossAmount = Math.round(((saleAmount / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
    const feeAmount = Math.round((grossAmount - saleAmount) * 100) / 100;

    // Calculate agent profit margin
    const profitMargin = Math.max(0, round2(saleAmount - platformPrice));

    // 7. Initialize Paystack Transaction
    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) {
      return json({ error: 'Paystack checkout is not configured yet.' }, 500);
    }

    const reference = `STR-${crypto.randomUUID()}`;
    const payerEmail = customerEmail || `${recipient}@skaitechgh.com`;
    const siteUrl = Deno.env.get('SITE_URL') || 'https://skaitechgh.wasmer.app';
    const callbackUrl = `${siteUrl}/storefront.html?ref=${encodeURIComponent(rawSlug || store.slug)}&agent=${encodeURIComponent(rawSlug || store.slug)}&reference=${encodeURIComponent(reference)}`;

    // Create pending store order record
    const { data: order, error: orderError } = await admin.from('store_orders').insert({
      store_id: store.id,
      agent_id: ownerId,
      reference,
      idempotency_key: idempotencyKey,
      product_type: 'data_bundle',
      product_ref: bundleId,
      product_label: String(bundle.title),
      network: networkType,
      recipient,
      customer_name: customerName,
      customer_phone: customerPhone || recipient,
      customer_email: customerEmail || payerEmail,
      quantity: 1,
      sale_amount: saleAmount,
      platform_price: platformPrice,
      provider_cost: providerCost,
      payment_fee: feeAmount,
      agent_earning: profitMargin,
      platform_revenue: round2(platformPrice - providerCost),
      wallet_debited: false,
      payment_status: 'pending',
      fulfilment_status: 'pending',
      provider: dataPackage.provider,
      meta: {
        slug: rawSlug || store.slug,
        bundle_id: bundleId,
        network_type: networkType,
        volume_mb: volumeInMB,
        profit_margin: profitMargin,
        package_price: saleAmount,
        processing_fee: feeAmount,
        gross_amount: grossAmount,
        fee_rate: safeRate,
      },
    }).select('id').single();

    if (orderError) throw orderError;

    // Call Paystack API charging the total grossAmount (package price + Paystack processing fee)
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: payerEmail,
        amount: Math.round(grossAmount * 100), // in pesewas
        currency: 'GHS',
        reference,
        callback_url: callbackUrl,
        metadata: {
          payment_type: 'store_order',
          order_reference: reference,
          store_order_id: order.id,
          store_id: store.id,
          agent_id: ownerId,
          bundle_id: bundleId,
          network: networkType,
          volume_mb: volumeInMB,
          recipient,
          customer_name: customerName,
          customer_phone: customerPhone || recipient,
          package_price: saleAmount,
          processing_fee: feeAmount,
          gross_amount: grossAmount,
          platform_price: platformPrice,
          profit_margin: profitMargin,
        },
      }),
    });

    const payment = await paystackRes.json().catch(() => null);
    if (!paystackRes.ok || !payment?.status || !payment.data?.authorization_url) {
      const msg = payment?.message || `Paystack checkout initialization failed (${paystackRes.status})`;
      throw new Error(msg);
    }

    return json({
      success: true,
      orderReference: reference,
      authorizationUrl: payment.data.authorization_url,
      accessCode: payment.data.access_code,
      paystackPublicKey: Deno.env.get('PAYSTACK_PUBLIC_KEY') || null,
      packagePrice: saleAmount,
      feeAmount,
      grossAmount,
      saleAmount: grossAmount,
      customerEmail: payerEmail,
      recipient,
      bundleTitle: bundle.title,
    });
  } catch (error) {
    console.error('Store order checkout error:', error);
    const message = error instanceof Error ? error.message : 'Unable to initialize checkout.';
    return json({ error: message }, 500);
  }
});
