import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage, type DataBuyResult } from '../_shared/dataProvider.ts';
import { chargeWallet, getWalletBalance, refundWallet } from '../_shared/wallet.ts';
import { resolveAgentBundlePrice, type AgentPricingLike } from '../_shared/pricing.ts';
import { catalogPrice, formatBundleVolume, volumeForBundleId } from '../_shared/dataCatalog.ts';

/**
 * Places a Data Bundle order on an agent's public store.
 *
 * WALLET-FUNDED MODEL (per the agreed design): the store is a projection of a
 * real agent, and every order is funded from THAT agent's prepaid wallet. The
 * customer pays the agent directly (cash / MoMo) for the store price; the agent
 * wallet is debited the platform price (what Skaitech charges for the bundle).
 * The difference is the agent's earning. If the owner wallet cannot cover the
 * platform price the store refuses the order outright - the store genuinely does
 * not work without money in the agent account.
 *
 * Routing is fixed by providerForBundle() in dataProvider.ts: MTN 1GB and
 * Telecel 5GB are fulfilled by GrandTechHub (as is AFA); EVERY other Data Bundle
 * is fulfilled by Swift. AFA is a separate product and is not sold here.
 *
 * This function is public (no agent session) because customers never sign up,
 * but it only ever touches the OWNER's wallet, keyed off the store slug, and it
 * is idempotent per (owner, idempotency_key) so a retry cannot double-charge.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

const NETWORK_LABELS: Record<string, string> = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;
  let chargedOwnerId = '';
  let chargedAmount = 0;

  try {
    const body = await request.json() as Record<string, unknown>;
    const slug = String(body.slug || body.ref || '').trim().toLowerCase();
    const bundleId = String(body.bundleId || '').trim().toLowerCase();
    const recipient = String(body.recipient || body.phone || '').trim();
    const customerName = String(body.customerName || body.name || '').trim();
    const customerPhone = String(body.customerPhone || body.phone || '').trim();
    const customerEmail = String(body.customerEmail || body.email || '').trim().toLowerCase();
    const idempotencyKey = String(body.idempotencyKey || '').trim();

    if (!slug) return json({ error: 'A store link is required.' }, 400);
    if (!bundleId) return json({ error: 'Select a package.' }, 400);
    if (!/^0\d{9}$/.test(recipient)) return json({ error: 'Enter a valid recipient number.' }, 400);
    if (!customerName || customerName.length > 120) return json({ error: 'Enter the customer name.' }, 400);
    if (customerEmail && !/^\S+@\S+\.\S+$/.test(customerEmail)) {
      return json({ error: 'Enter a valid email address or leave it blank.' }, 400);
    }
    if (!idempotencyKey || idempotencyKey.length > 100) {
      return json({ error: 'This order is missing its idempotency key. Refresh and try again.' }, 400);
    }

    const admin = adminClient();

    const { data: store, error: storeError } = await admin
      .from('agent_stores')
      .select('id, agent_id, slug, is_active')
      .eq('slug', slug)
      .maybeSingle();
    if (storeError) throw storeError;
    if (!store || !store.is_active) {
      return json({ error: 'This store is not available.', code: 'store_unavailable' }, 404);
    }

    const ownerId = String(store.agent_id);

    // Idempotency: the same client attempt can never create a second order.
    const { data: existing } = await admin
      .from('store_orders')
      .select('reference, payment_status, fulfilment_status, sale_amount, wallet_debited')
      .eq('agent_id', ownerId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      return json({
        success: existing.fulfilment_status !== 'failed',
        orderReference: existing.reference,
        status: existing.fulfilment_status,
        replayed: true,
      });
    }

    const { data: catalogBundle, error: bundleError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, title, volume_mb, price')
      .eq('bundle_id', bundleId)
      .eq('active', true)
      .maybeSingle();
    if (bundleError) throw bundleError;

    // Fall back to the canonical sale catalog when the provider-confirmed table
    // has no row (a fresh project, or before the provider sync has run). The
    // price and volume still come from the server-owned catalog, never from the
    // request body, and the live provider is consulted before any charge.
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

    const networkType = String(bundle.network);
    const volumeInMB = Number(bundle.volume_mb);
    // The platform price is what the owner agent is charged (their cost of
    // goods); the sale price is what their store charges the customer.
    const platformPrice = round2(Number(bundle.price));
    if (!Number.isFinite(platformPrice) || platformPrice <= 0) {
      return json({ error: 'That package is not available. Choose another.' }, 400);
    }

    const pricingClient = admin as unknown as AgentPricingLike;

    // A per-store price override wins, then the owner's global pricing.
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

    const customPrice = await resolveAgentBundlePrice(
      pricingClient, ownerId, networkType, volumeInMB, platformPrice,
    );
    let saleAmount = override && Number(override.price) > 0 ? round2(Number(override.price)) : round2(customPrice);
    // Selling below cost would lose the agent money on every order; refuse it
    // rather than silently record a loss.
    if (saleAmount < platformPrice) saleAmount = platformPrice;

    // Confirm the live provider package BEFORE charging anyone. MTN 1GB and
    // Telecel 5GB resolve through GrandTech; every other bundle through Swift.
    const dataPackage = await resolveDataPackage(networkType, volumeInMB);
    if (!dataPackage) {
      return json({ error: 'This bundle is not currently available from its data provider. No charge was made.' }, 409);
    }
    const providerCost = round2(dataPackage.costGhs);
    if (!Number.isFinite(providerCost) || providerCost <= 0) {
      return json({ error: 'The data provider did not return a valid price. No charge was made.' }, 409);
    }

    // WALLET GATE: the store does not work without money in the agent account.
    const { data: settings } = await admin
      .from('platform_settings')
      .select('store_wallet_gate_enabled')
      .eq('id', 1)
      .maybeSingle();
    const gateEnabled = settings ? settings.store_wallet_gate_enabled !== false : true;

    if (gateEnabled) {
      const balance = await getWalletBalance(ownerId);
      if (!Number.isFinite(balance)) {
        return json({ error: 'This store is temporarily unavailable. Please try again shortly.', code: 'store_wallet_unavailable' }, 503);
      }
      if (balance < platformPrice) {
        return json({
          error: 'This store is temporarily unavailable because its wallet balance is too low. Please contact the store owner.',
          code: 'store_wallet_low',
        }, 402);
      }
    }

    reference = `STORE-${crypto.randomUUID()}`;
    const walletBalance = await chargeWallet(ownerId, reference, platformPrice, 'Store data bundle order', {
      service: 'store_data_bundle',
      store_slug: slug,
      network_type: networkType,
      volume_mb: volumeInMB,
    });
    chargedOwnerId = ownerId;
    chargedAmount = platformPrice;

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
      customer_phone: customerPhone || null,
      customer_email: customerEmail || null,
      quantity: 1,
      sale_amount: saleAmount,
      platform_price: platformPrice,
      provider_cost: providerCost,
      payment_fee: 0,
      agent_earning: round2(saleAmount - platformPrice),
      platform_revenue: round2(platformPrice - providerCost),
      wallet_debited: true,
      payment_status: 'paid',
      fulfilment_status: 'pending',
      provider: dataPackage.provider,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    let dispatch: DataBuyResult;
    try {
      dispatch = await buyDataPackage(dataPackage, networkType, recipient);
    } catch (providerError) {
      const reason = errorMessage(providerError, 'The data provider request failed.');
      dispatch = {
        success: false,
        provider: dataPackage.provider,
        status: 'failed',
        payload: { error: reason },
        failureReason: reason,
      };
    }

    const providerResponse = {
      ...dispatch.payload,
      provider: dataPackage.provider,
      providerOrderId: dispatch.orderId ?? null,
    };

    // GrandTech accepting the order is not delivery, so a success stays in
    // 'processing' until it is reconciled; only a hard failure settles now.
    await admin.from('store_orders').update({
      fulfilment_status: dispatch.success ? 'processing' : 'failed',
      provider_reference: dispatch.orderId ?? null,
      provider_response: providerResponse,
      failure_reason: dispatch.success ? null : (dispatch.failureReason || 'The provider did not accept the order.'),
      completed_at: dispatch.success ? null : new Date().toISOString(),
    }).eq('id', order.id);

    if (!dispatch.success) {
      const refundedBalance = await refundWallet(ownerId, reference, platformPrice, 'Store bundle not delivered');
      await admin.from('store_orders').update({
        payment_status: 'refunded',
        refund_amount: platformPrice,
      }).eq('id', order.id);
      return json({
        success: false,
        refunded: true,
        walletBalance: refundedBalance,
        orderReference: reference,
        status: 'failed',
        message: `Bundle delivery failed: ${dispatch.failureReason || 'the provider did not accept the order.'} The store owner has been refunded.`,
      }, 502);
    }

    return json({
      success: true,
      walletBalance,
      orderReference: reference,
      status: 'processing',
      message: `Your ${String(bundle.title)} order was accepted and is being delivered to ${recipient}.`,
    });
  } catch (error) {
    console.error('Store order error:', error);
    // Refund whenever the wallet was actually debited, even if the order row was
    // never written (mirrors the public data payment safety net).
    if (reference && chargedAmount > 0) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('store_orders')
          .select('payment_status, agent_id')
          .eq('reference', reference)
          .maybeSingle();
        const ownerId = order?.agent_id ? String(order.agent_id) : chargedOwnerId;
        if (!order || order.payment_status !== 'paid') {
          if (ownerId) {
            await refundWallet(ownerId, reference, chargedAmount, 'Store order failed').catch(() => {});
          }
          if (orderId) {
            await admin.from('store_orders').update({
              payment_status: 'refunded',
              refund_amount: chargedAmount,
              fulfilment_status: 'failed',
              failure_reason: errorMessage(error, 'Unexpected error'),
              completed_at: new Date().toISOString(),
            }).eq('id', orderId);
          }
        }
      } catch (innerError) {
        console.error('Store order refund/rollback failed:', innerError);
      }
    }
    const message = errorMessage(error, 'Unable to complete the order.');
    const status = /insufficient/i.test(message) ? 402 : 500;
    return json({ error: message, insufficientFunds: /insufficient/i.test(message) || undefined }, status);
  }
});
