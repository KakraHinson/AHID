import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage } from '../_shared/dataProvider.ts';
import { resolveAgentBundlePrice, type AgentPricingLike } from '../_shared/pricing.ts';
import {
  bundleIdFor,
  catalogPrice,
  formatBundleVolume,
  volumeForBundleId,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';
import { chargeWallet, refundWallet, getWalletBalance } from '../_shared/wallet.ts';

const NETWORK_ALIASES: Record<string, DataNetwork> = {
  mtn: 'mtn',
  telecel: 'telecel',
  vodafone: 'telecel',
  airteltigo: 'airteltigo',
  at: 'airteltigo',
};

function messageFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function normalizeNetwork(value: unknown): DataNetwork | null {
  return NETWORK_ALIASES[String(value ?? '').trim().toLowerCase()] ?? null;
}

function volumeFromBundleSize(value: unknown): number {
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*gb$/i);
  if (!match) return 0;
  const gb = Number(match[1]);
  return Number.isFinite(gb) ? Math.round(gb * 1024) : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Places a Standard Data sale from the signed-in agent's wallet.
 *
 * This is the wallet-page counterpart to the public storefront checkout:
 * the agent's wallet pays the platform price, the selected provider fulfils
 * the bundle, and any custom selling-price margin is recorded as store
 * earnings for the payout workflow. No fake commission percentage is used.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let orderId: string | null = null;
  let ownerId = '';
  let reference = '';
  let charged = false;
  let refunded = false;
  let debitAmount = 0;

  try {
    const { admin, user, agent } = await requireAgent(request);
    ownerId = user.id;
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const requestedBundleId = String(body.bundleId ?? '').trim().toLowerCase();
    const parsed = requestedBundleId ? volumeForBundleId(requestedBundleId) : null;
    const network = normalizeNetwork(body.networkType ?? body.network) || parsed?.network;
    const volumeInMB = parsed?.volumeInMB || Number(body.volumeInMB) || volumeFromBundleSize(body.bundleSize);
    const phone = String(body.phone ?? body.recipient ?? '').replace(/[\s()-]/g, '').trim();
    const idempotencyKey = String(body.idempotencyKey ?? '').trim() || crypto.randomUUID();

    if (!network) return json({ error: 'Choose a supported network.' }, 400);
    if (!Number.isInteger(volumeInMB) || volumeInMB < 1024 || volumeInMB > 204800) {
      return json({ error: 'Choose a valid whole-GB bundle.' }, 400);
    }
    if (!/^0\d{9}$/.test(phone)) {
      return json({ error: 'Enter a valid 10-digit Ghanaian recipient number.' }, 400);
    }

    const bundleId = bundleIdFor(network, volumeInMB);
    const { data: existing, error: existingError } = await admin
      .from('store_orders')
      .select('id, reference, payment_status, fulfilment_status, sale_amount, platform_price, agent_earning, refund_amount, provider_reference')
      .eq('agent_id', user.id)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingError) throw existingError;
    if (existing) {
      const balance = await getWalletBalance(user.id);
      return json({
        success: !['failed', 'cancelled'].includes(String(existing.fulfilment_status)),
        replayed: true,
        orderReference: existing.reference,
        status: existing.fulfilment_status,
        paymentStatus: existing.payment_status,
        amount: Number(existing.platform_price || 0),
        saleAmount: Number(existing.sale_amount || 0),
        storeEarning: Number(existing.agent_earning || 0),
        providerReference: existing.provider_reference ?? null,
        refunded: existing.payment_status === 'refunded',
        walletBalance: Number.isFinite(balance) ? balance : null,
      });
    }

    const { data: catalogRow, error: catalogError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, title, volume_mb, price, active')
      .eq('bundle_id', bundleId)
      .maybeSingle();
    if (catalogError) throw catalogError;

    const platformPrice = catalogRow
      ? Number(catalogRow.active ? catalogRow.price : Number.NaN)
      : Number(catalogPrice(network, volumeInMB));
    if (!Number.isFinite(platformPrice) || platformPrice <= 0) {
      return json({ error: 'This bundle is not available at the current platform price.' }, 400);
    }

    const pricingClient = admin as unknown as AgentPricingLike;
    const saleAmount = await resolveAgentBundlePrice(
      pricingClient,
      user.id,
      network,
      volumeInMB,
      platformPrice,
    );
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
      return json({ error: 'This bundle is not available at your current store price.' }, 400);
    }

    let dataPackage;
    try {
      dataPackage = await resolveDataPackage(network, volumeInMB);
    } catch (error) {
      return json({ error: messageFor(error, 'The provider package could not be resolved.') }, 502);
    }
    if (!dataPackage) return json({ error: 'This bundle is temporarily unavailable from the provider.' }, 409);

    const storeIdResult = await admin.rpc('ensure_agent_store', { p_agent_id: user.id });
    if (storeIdResult.error) throw storeIdResult.error;
    const storeId = String(storeIdResult.data || '');
    if (!storeId) throw new Error('Your agent store could not be prepared.');

    reference = `AGENT-STORE-${crypto.randomUUID()}`;
    const bundleTitle = String(catalogRow?.title || `${String(network).toUpperCase()} ${formatBundleVolume(volumeInMB)}`);
    const providerCost = round2(Number(dataPackage.costGhs));
    const storeEarning = Math.max(0, round2(saleAmount - platformPrice));
    const platformRevenue = Math.max(0, round2(platformPrice - providerCost));

    const { data: order, error: orderError } = await admin.from('store_orders').insert({
      store_id: storeId,
      agent_id: user.id,
      reference,
      idempotency_key: idempotencyKey,
      product_type: 'data_bundle',
      product_ref: bundleId,
      product_label: bundleTitle,
      network,
      recipient: phone,
      customer_name: agent.full_name || user.user_metadata?.full_name || null,
      customer_phone: phone,
      customer_email: user.email || null,
      quantity: 1,
      sale_amount: round2(saleAmount),
      platform_price: round2(platformPrice),
      provider_cost: providerCost,
      payment_fee: 0,
      agent_earning: storeEarning,
      platform_revenue: platformRevenue,
      wallet_debited: false,
      payment_status: 'paid',
      fulfilment_status: 'processing',
      provider: dataPackage.provider,
      meta: {
        source: 'agent_wallet',
        bundle_id: bundleId,
        network_type: network,
        volume_mb: volumeInMB,
        sale_amount: saleAmount,
        platform_price: platformPrice,
      },
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;
    debitAmount = round2(platformPrice);

    const walletBalance = await chargeWallet(
      user.id,
      reference,
      debitAmount,
      `Store sale fulfilment: ${bundleTitle}`,
      { order_id: orderId, bundle_id: bundleId, recipient: phone, source: 'agent_wallet_store_order' },
    );
    charged = true;

    await admin.from('store_orders').update({ wallet_debited: true, updated_at: new Date().toISOString() }).eq('id', orderId);
    await admin.from('transactions').insert({
      agent_id: user.id,
      agent_code: agent.agent_code || null,
      reference,
      amount: debitAmount,
      type: 'Order Purchase',
      balance_before: round2(walletBalance + debitAmount),
      balance_after: walletBalance,
      status: 'success',
      description: `Store sale fulfilment: ${bundleTitle}`,
      metadata: { order_id: orderId, sale_amount: saleAmount, store_earning: storeEarning, recipient: phone },
    });

    const dispatch = await buyDataPackage(dataPackage, network, phone);
    const dispatchPayload = {
      ...dispatch.payload,
      ...(dispatch.providerReference ? { providerReference: dispatch.providerReference } : {}),
    };
    const providerReference = dispatch.orderId ?? dispatch.providerReference ?? null;

    if (!dispatch.success) {
      let refundError: unknown = null;
      try {
        await refundWallet(user.id, reference, debitAmount, `Refund for failed store sale ${reference}`);
        refunded = true;
      } catch (error) {
        refundError = error;
      }
      await admin.from('store_orders').update({
        payment_status: refundError ? 'paid' : 'refunded',
        fulfilment_status: 'failed',
        refund_amount: refundError ? 0 : debitAmount,
        provider_reference: providerReference,
        provider_response: dispatchPayload,
        failure_reason: dispatch.failureReason || 'The provider declined the bundle.',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', orderId);
      if (refundError) throw new Error('The provider failed and the wallet refund could not be completed automatically. Contact support with reference ' + reference + '.');
      return json({
        error: dispatch.failureReason || 'The provider declined the bundle.',
        orderReference: reference,
        refunded: true,
        walletBalance: await getWalletBalance(user.id),
      }, 502);
    }

    const fulfilmentStatus = dispatch.status === 'processing' ? 'processing' : 'successful';
    await admin.from('store_orders').update({
      fulfilment_status: fulfilmentStatus,
      provider: dispatch.provider,
      provider_reference: providerReference,
      provider_response: dispatchPayload,
      failure_reason: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', orderId);

    return json({
      success: true,
      orderReference: reference,
      status: fulfilmentStatus,
      amount: debitAmount,
      saleAmount: round2(saleAmount),
      storeEarning,
      providerReference,
      walletBalance,
      message: `${bundleTitle} accepted for delivery to ${phone}.`,
    });
  } catch (error) {
    console.error('place-agent-store-order error:', error);
    if (orderId) {
      const admin = adminClient();
      if (charged && !refunded && ownerId && debitAmount > 0) {
        try {
          await refundWallet(ownerId, reference, debitAmount, `Refund for failed store sale ${reference}`);
          refunded = true;
        } catch (_) {
          // Keep the order failed and surface the reference for support if the
          // compensating wallet refund itself cannot be completed.
        }
      }
      await admin.from('store_orders').update({
        payment_status: refunded ? 'refunded' : 'paid',
        refund_amount: refunded ? debitAmount : 0,
        fulfilment_status: 'failed',
        failure_reason: messageFor(error, 'Unable to complete store sale.'),
        updated_at: new Date().toISOString(),
      }).eq('id', orderId).eq('fulfilment_status', 'processing');
    }
    const message = messageFor(error, 'Unable to complete store sale.');
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : /insufficient wallet/i.test(message.toLowerCase())
          ? 402
          : 500;
    return json({ error: message, refunded }, status);
  }
});
