import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { buyDataPackage, resolveDataPackage, type DataBuyResult } from '../_shared/dataProvider.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import {
  resolveAgentBundlePrice,
  resolveAgentProfitShare,
  customerPriceWithProfitShare,
  type AgentPricingLike,
} from '../_shared/pricing.ts';
import {
  DATA_NETWORKS,
  catalogPrice,
  volumeForBundleId,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return fallback;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;
  // Set only after chargeWallet resolves, so a failure that happens between the
  // debit and the order insert (or before either) still knows what to refund.
  let chargedAgentId = '';
  let chargedAmount = 0;

  try {
    const body = await request.json();
    const customerName = String(body.name || '').trim();
    const customerEmail = String(body.email || '').trim().toLowerCase();
    const customerPhone = String(body.phone || '').trim();
    const requestedBundleId = String(body.bundleId || '').trim().toLowerCase();

    if (!customerName || customerName.length > 120 ||
      !/^\S+@\S+\.\S+$/.test(customerEmail) || !/^0\d{9}$/.test(customerPhone)) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    // WALLET-FIRST: instant data is paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    let networkType = '';
    let volumeInMB = 0;
    let salePrice: number | null = null;

    if (requestedBundleId) {
      // Preferred path: the client picked a bundle_id from the catalog, so the
      // network, volume and price are read from the row it came from. The
      // storefront can never make us charge a price or size it chose itself.
      const { data: bundle, error: bundleError } = await admin
        .from('bundle_catalog')
        .select('bundle_id, network, volume_mb, price')
        .eq('bundle_id', requestedBundleId)
        .eq('active', true)
        .maybeSingle();

      if (bundleError) {
        // The browser selected this stable network/size id from the catalog.
        // If the catalog read is temporarily unavailable, resolve the sale
        // price from the server-owned price table below and verify deliverability
        // against the assigned provider's live catalog before charging.
        console.error('bundle_catalog lookup failed; using server sale catalog:', bundleError.message);
      }

      if (bundle) {
        networkType = String(bundle.network);
        volumeInMB = Number(bundle.volume_mb);
        salePrice = Number(bundle.price);
      } else {
        const parsed = volumeForBundleId(requestedBundleId);
        if (!parsed) return json({ error: 'That package is not recognized. Please choose a listed bundle.' }, 400);
        networkType = parsed.network;
        volumeInMB = parsed.volumeInMB;
        salePrice = catalogPrice(networkType, volumeInMB);
      }
    } else {
      // Legacy path for the pages that still post a network and a volume.
      networkType = String(body.networkType || '').trim().toLowerCase();
      volumeInMB = Number(body.volumeInMB);
      salePrice = catalogPrice(networkType, volumeInMB);
    }

    if (!DATA_NETWORKS.includes(networkType as DataNetwork) ||
      !Number.isInteger(volumeInMB) || volumeInMB <= 0 ||
      salePrice === null || !Number.isFinite(salePrice) || salePrice <= 0) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    const listPrice: number = salePrice;

    // The pricing helper only reads one row, but TypeScript cannot expand the
    // real client's generics that far and reports the type instantiation as
    // infinitely deep. Narrow it to the structural type the helper declares.
    const pricingClient = admin as unknown as AgentPricingLike;

    // The agent's own price from the Store > Pricing tab wins over the catalog,
    // so editing a price there actually changes what customers are charged.
    const agentPrice = await resolveAgentBundlePrice(
      pricingClient, agentId, networkType, volumeInMB, listPrice,
    );
    if (!Number.isFinite(agentPrice) || agentPrice <= 0) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    // If the agent shares part of their commission profit with customers, the
    // storefront price is discounted by the same helper the page uses.
    const profitShare = await resolveAgentProfitShare(pricingClient, agentId);
    const saleAmount = customerPriceWithProfitShare(agentPrice, networkType, profitShare);
    if (!Number.isFinite(saleAmount) || saleAmount <= 0) {
      return json({ error: 'Enter valid customer details and select a supported package.' }, 400);
    }

    // Confirm the live provider package before touching either wallet. The
    // resolver routes only MTN 1GB and Telecel 5GB to GrandTech; all other
    // bundles in this place must resolve through Swift.
    const dataPackage = await resolveDataPackage(networkType, volumeInMB);
    if (!dataPackage) {
      return json({ error: 'This bundle is not currently available from its assigned data provider. No wallet charge was made.' }, 409);
    }

    reference = `PUB-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(agentId, reference, saleAmount, 'Instant data purchase', {
      service: 'instant_data',
      network_type: networkType,
      volume_mb: volumeInMB,
    });
    chargedAgentId = agentId;
    chargedAmount = saleAmount;

    const { data: order, error: orderError } = await admin.from('public_data_orders').insert({
      payment_reference: reference, customer_name: customerName, customer_email: customerEmail,
      customer_phone: customerPhone, network_type: networkType, volume_mb: volumeInMB,
      sale_amount: saleAmount, status: 'pending_payment', agent_id: agentId,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    const companyAgentId = Deno.env.get('PUBLIC_DATA_AGENT_ID');
    if (!companyAgentId) throw new Error('Public data provider funding is not configured.');

    const providerCost = dataPackage.costGhs;
    if (!Number.isFinite(providerCost) || providerCost <= 0) throw new Error('The assigned provider did not return a valid current bundle price.');

    const providerReference = `PUB-DATA-${crypto.randomUUID()}`;
    const { data: providerOrderId, error: reserveError } = await admin.rpc('reserve_agent_data_order', {
      p_agent_id: companyAgentId, p_reference: providerReference, p_network_type: networkType,
      p_phone: customerPhone, p_volume_mb: volumeInMB, p_amount: Math.round(providerCost * 100) / 100,
    });
    if (reserveError) throw reserveError;

    // A provider call that throws (timeout, DNS, malformed reply) must not skip
    // complete_agent_data_order, otherwise the company's reserve_agent_data_order
    // debit is never settled and stays stuck as an open processing order.
    let dispatch: DataBuyResult;
    try {
      dispatch = await buyDataPackage(dataPackage, networkType, customerPhone);
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
    await admin.rpc('complete_agent_data_order', {
      p_order_id: providerOrderId, p_success: dispatch.success, p_provider_response: dispatch.payload,
    });
    // The provider accepting the order is not delivery: GrandTechHub fulfils
    // asynchronously and can leave an order PENDING/PROCESSING indefinitely.
    // Stay in 'processing' and let get-public-data-order reconcile, so a dropped
    // order is refunded instead of being reported as delivered.
    await admin.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: dispatch.success ? 'processing' : 'failed',
      p_provider_amount: providerCost,
      p_provider_reference: providerReference,
      p_provider_response: { ...dispatch.payload, provider: dataPackage.provider, providerOrderId: dispatch.orderId ?? null },
    });

    if (!dispatch.success) {
      const refundedBalance = await refundWallet(agentId, reference, saleAmount, 'Instant data provider failed');
      return json({
        success: false,
        refunded: true,
        walletBalance: refundedBalance,
        orderReference: reference,
        message: `Bundle delivery failed: ${dispatch.failureReason || 'The provider did not accept the order.'} Your wallet has been refunded.`,
      }, 502);
    }

    return json({
      success: true,
      walletBalance,
      orderReference: reference,
      status: 'processing',
      message: `Your ${Math.round(volumeInMB / 1024)}GB bundle order was accepted and is being delivered to ${customerPhone}.`,
    });
  } catch (error) {
    console.error('Public data payment error:', error);
    // Refund whenever the wallet was actually debited, even if the order row was
    // never inserted (previously that left the agent charged with no refund).
    if (reference && chargedAmount > 0) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('public_data_orders')
          .select('sale_amount, status, agent_id')
          .eq('payment_reference', reference)
          .maybeSingle();
        const saleAmount = order ? Number(order.sale_amount) : chargedAmount;
        const buyerAgentId = order?.agent_id ?? chargedAgentId;
        if (!order || !['successful'].includes(order.status)) {
          if (buyerAgentId && saleAmount > 0) {
            await refundWallet(buyerAgentId, reference, saleAmount, 'Instant data purchase failed').catch(() => {});
          }
          if (orderId) {
            await admin.rpc('mark_public_data_order', {
              p_order_id: orderId, p_status: 'failed', p_provider_amount: null,
              p_provider_reference: null, p_provider_response: { error: errorMessage(error, 'Unexpected error') },
            });
          }
        }
      } catch (innerError) {
        console.error('Instant data refund/rollback failed:', innerError);
      }
    }
    const msg = errorMessage(error, 'Unable to complete data purchase.');
    const status = /authentication is required|session is invalid/i.test(msg)
      ? 401
      : /agent account required/i.test(msg)
      ? 403
      : msg.toLowerCase().includes('insufficient')
      ? 400
      : 500;
    return json({ error: msg, insufficientFunds: msg.toLowerCase().includes('insufficient') || undefined }, status);
  }
});
