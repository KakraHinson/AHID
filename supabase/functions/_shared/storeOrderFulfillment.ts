import { adminClient } from './supabase.ts';
import { buyDataPackage, resolveDataPackage, type DataBuyResult } from './dataProvider.ts';
import { creditWallet } from './wallet.ts';
import { volumeForBundleId } from './dataCatalog.ts';

const round2 = (value: number) => Math.round(value * 100) / 100;

export interface StoreOrderFulfillmentResult {
  success: boolean;
  orderReference: string;
  paymentStatus: string;
  fulfilmentStatus: string;
  profitMargin: number;
  message: string;
  recipient?: string;
  bundleTitle?: string;
}

/**
 * Idempotently verifies payment with Paystack, fulfills bundle dispatch,
 * and credits the owner agent's wallet balance with the earned profit margin.
 */
export async function fulfilStoreOrder(reference: string): Promise<StoreOrderFulfillmentResult> {
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
  if (!secret) {
    throw new Error('Paystack secret key is not configured.');
  }

  const admin = adminClient();

  // 1. Fetch store order
  const { data: order, error: orderError } = await admin
    .from('store_orders')
    .select('*')
    .eq('reference', reference)
    .maybeSingle();

  if (orderError || !order) {
    throw new Error('Store order not found.');
  }

  // Idempotency: if already paid & fulfilled, do not re-dispatch or re-credit
  if (order.payment_status === 'paid') {
    return {
      success: order.fulfilment_status !== 'failed',
      orderReference: order.reference,
      paymentStatus: order.payment_status,
      fulfilmentStatus: order.fulfilment_status,
      profitMargin: Number(order.agent_earning || 0),
      message: order.fulfilment_status === 'failed'
        ? (order.failure_reason || 'Order delivery could not be completed.')
        : `Order fulfilled. Bundle delivered to ${order.recipient}.`,
      recipient: order.recipient,
      bundleTitle: order.product_label,
    };
  }

  // 2. Verify payment status with Paystack
  const verifiedRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const paystackData = await verifiedRes.json().catch(() => null);

  if (!verifiedRes.ok || paystackData?.data?.status !== 'success' || paystackData.data.currency !== 'GHS') {
    const reason = paystackData?.data?.gateway_response || paystackData?.message || 'Payment verification failed.';
    await admin.from('store_orders').update({
      payment_status: 'failed',
      fulfilment_status: 'failed',
      failure_reason: reason,
      updated_at: new Date().toISOString(),
    }).eq('id', order.id);

    return {
      success: false,
      orderReference: order.reference,
      paymentStatus: 'failed',
      fulfilmentStatus: 'failed',
      profitMargin: 0,
      message: reason,
      recipient: order.recipient,
      bundleTitle: order.product_label,
    };
  }

  // 3. Mark payment as paid
  const paidAt = new Date().toISOString();
  await admin.from('store_orders').update({
    payment_status: 'paid',
    paid_at: paidAt,
    updated_at: paidAt,
  }).eq('id', order.id);

  // 4. Resolve package & dispatch data bundle to recipient
  const networkType = String(order.network || '').toLowerCase();
  const parsed = volumeForBundleId(order.product_ref || '');
  const volumeInMB = parsed?.volumeInMB || Number(order.meta?.volume_mb) || 1024;

  const dataPackage = await resolveDataPackage(networkType, volumeInMB);
  let dispatch: DataBuyResult;

  if (!dataPackage) {
    dispatch = {
      success: false,
      provider: 'unknown',
      status: 'failed',
      payload: { error: 'Package temporarily unavailable from provider.' },
      failureReason: 'Package temporarily unavailable from provider.',
    };
  } else {
    try {
      dispatch = await buyDataPackage(dataPackage, networkType, order.recipient);
    } catch (err) {
      const errStr = err instanceof Error ? err.message : 'Provider dispatch error';
      dispatch = {
        success: false,
        provider: dataPackage.provider,
        status: 'failed',
        payload: { error: errStr },
        failureReason: errStr,
      };
    }
  }

  // 5. Calculate profit margin: sale_amount - platform_price
  const saleAmount = Number(order.sale_amount || 0);
  const platformPrice = Number(order.platform_price || 0);
  const profitMargin = Math.max(0, round2(saleAmount - platformPrice));

  // 6. Credit the Agent's account balance with the profit margin
  if (profitMargin > 0 && order.agent_id) {
    try {
      await creditWallet(
        order.agent_id,
        `${order.reference}-COMM`,
        profitMargin,
        `Store sales profit: ${order.product_label || 'Data bundle'} (${order.recipient})`,
        {
          order_id: order.id,
          order_reference: order.reference,
          sale_amount: saleAmount,
          platform_price: platformPrice,
          profit_margin: profitMargin,
          customer_phone: order.customer_phone,
        },
      );
    } catch (creditErr) {
      console.error('Failed to credit agent wallet for store order:', creditErr);
    }
  }

  // 7. Update order fulfilment status
  const providerResponse = {
    ...dispatch.payload,
    provider: dataPackage?.provider || 'unknown',
    providerOrderId: dispatch.orderId ?? null,
  };

  const fulfilmentStatus = dispatch.success ? 'successful' : 'failed';
  await admin.from('store_orders').update({
    fulfilment_status: fulfilmentStatus,
    provider: dataPackage?.provider || null,
    provider_reference: dispatch.orderId ?? null,
    provider_response: providerResponse,
    failure_reason: dispatch.success ? null : (dispatch.failureReason || 'Provider could not deliver bundle.'),
    agent_earning: profitMargin,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);

  return {
    success: dispatch.success,
    orderReference: order.reference,
    paymentStatus: 'paid',
    fulfilmentStatus,
    profitMargin,
    message: dispatch.success
      ? `Payment verified! ${order.product_label || 'Bundle'} is being delivered to ${order.recipient}.`
      : `Payment verified. Delivery notice: ${dispatch.failureReason || 'Pending provider confirmation.'}`,
    recipient: order.recipient,
    bundleTitle: order.product_label,
  };
}
