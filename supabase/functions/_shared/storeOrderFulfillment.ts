import { adminClient } from './supabase.ts';
import { buyDataPackage, resolveDataPackage, type DataBuyResult } from './dataProvider.ts';
import { chargeWallet, getWalletBalance, refundWallet } from './wallet.ts';
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
 * and debits the owner agent's wallet for the platform fulfilment price.
 * Store margin is recorded for the payout workflow and is never added to the
 * spendable wallet automatically.
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

  // Idempotency: if already paid & fulfilled, do not re-dispatch or re-charge.
  if (order.payment_status === 'paid' && order.wallet_debited === true && order.fulfilment_status !== 'pending') {
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

  // 3. Calculate the customer margin and reserve the platform fulfilment price
  // from the owner wallet before dispatching the bundle.
  const saleAmount = Number(order.sale_amount || 0);
  const platformPrice = Number(order.platform_price || 0);
  const profitMargin = Math.max(0, round2(saleAmount - platformPrice));
  let walletDebited = order.wallet_debited === true;
  if (!walletDebited) {
    const ownerBalance = order.agent_id ? await getWalletBalance(order.agent_id) : Number.NaN;
    if (order.agent_id && (!Number.isFinite(ownerBalance) || ownerBalance < platformPrice)) {
      const reason = 'The store owner wallet does not have enough balance to fulfil this order.';
      const refundResult = await requestPaystackRefund(secret, reference);
      await admin.from('store_orders').update({
        payment_status: refundResult ? 'refunded' : 'paid',
        fulfilment_status: 'failed',
        refund_amount: refundResult ? saleAmount : 0,
        failure_reason: refundResult ? reason : `${reason} Paystack refund is pending manual review.`,
        updated_at: new Date().toISOString(),
      }).eq('id', order.id);
      return {
        success: false,
        orderReference: order.reference,
        paymentStatus: refundResult ? 'refunded' : 'paid',
        fulfilmentStatus: 'failed',
        profitMargin: 0,
        message: refundResult ? reason : `${reason} Contact support with reference ${reference}.`,
        recipient: order.recipient,
        bundleTitle: order.product_label,
      };
    }
    if (order.agent_id) {
      try {
        await chargeWallet(
          order.agent_id,
          reference,
          platformPrice,
          `Store fulfilment: ${order.product_label || 'Data bundle'} (${order.recipient})`,
          { order_id: order.id, sale_amount: saleAmount, platform_price: platformPrice },
        );
      } catch (chargeError) {
        const reason = chargeError instanceof Error ? chargeError.message : 'Unable to reserve the store wallet balance.';
        const refundResult = await requestPaystackRefund(secret, reference);
        await admin.from('store_orders').update({
          payment_status: refundResult ? 'refunded' : 'paid',
          fulfilment_status: 'failed',
          refund_amount: refundResult ? saleAmount : 0,
          failure_reason: refundResult ? reason : `${reason} Paystack refund is pending manual review.`,
          updated_at: new Date().toISOString(),
        }).eq('id', order.id);
        return {
          success: false,
          orderReference: order.reference,
          paymentStatus: refundResult ? 'refunded' : 'paid',
          fulfilmentStatus: 'failed',
          profitMargin: 0,
          message: refundResult ? reason : `${reason} Contact support with reference ${reference}.`,
          recipient: order.recipient,
          bundleTitle: order.product_label,
        };
      }
      walletDebited = true;
    }
  }

  const paidAt = new Date().toISOString();
  await admin.from('store_orders').update({
    payment_status: 'paid',
    wallet_debited: walletDebited,
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
      provider: 'swift',
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

  // 5. Update order fulfilment status. A failed provider call reverses the
  // wallet debit; the public customer payment is refunded when Paystack allows.
  const providerResponse = {
    ...dispatch.payload,
    provider: dataPackage?.provider || 'unknown',
    providerOrderId: dispatch.orderId ?? null,
  };

  const fulfilmentStatus = dispatch.success ? 'successful' : 'failed';
  let walletRefunded = false;
  let walletRefundError: string | null = null;
  if (!dispatch.success && order.agent_id && walletDebited) {
    try {
      await refundWallet(order.agent_id, reference, platformPrice, `Refund for failed store order ${reference}`);
      walletRefunded = true;
    } catch (error) {
      walletRefundError = error instanceof Error ? error.message : 'Wallet refund could not be completed.';
      console.error('Store order wallet refund failed:', error);
    }
  }
  const paystackRefunded = !dispatch.success ? await requestPaystackRefund(secret, reference) : false;
  await admin.from('store_orders').update({
    payment_status: !dispatch.success && paystackRefunded ? 'refunded' : 'paid',
    wallet_debited: dispatch.success ? walletDebited : !walletRefunded,
    fulfilment_status: fulfilmentStatus,
    provider: dataPackage?.provider || null,
    provider_reference: dispatch.orderId ?? null,
    provider_response: providerResponse,
    failure_reason: dispatch.success ? null : [
      dispatch.failureReason || 'Provider could not deliver bundle.',
      walletRefundError ? `Wallet refund failed: ${walletRefundError}` : null,
      paystackRefunded ? null : 'Customer payment refund is pending manual review.',
    ].filter(Boolean).join(' '),
    agent_earning: profitMargin,
    completed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', order.id);

  return {
    success: dispatch.success,
    orderReference: order.reference,
    paymentStatus: dispatch.success ? 'paid' : (paystackRefunded ? 'refunded' : 'paid'),
    fulfilmentStatus,
    profitMargin,
    message: dispatch.success
      ? `Payment verified! ${order.product_label || 'Bundle'} is being delivered to ${order.recipient}.`
      : `Payment verified. Delivery notice: ${dispatch.failureReason || 'Pending provider confirmation.'}`,
    recipient: order.recipient,
    bundleTitle: order.product_label,
  };
}

async function requestPaystackRefund(secret: string, reference: string): Promise<boolean> {
  try {
    const response = await fetch('https://api.paystack.co/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction: reference }),
    });
    const payload = await response.json().catch(() => null);
    return response.ok && payload?.status === true;
  } catch (error) {
    console.error('Paystack store-order refund request failed:', error);
    return false;
  }
}
