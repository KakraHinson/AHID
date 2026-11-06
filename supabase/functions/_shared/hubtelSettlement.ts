/**
 * Terminal settlement for Hubtel airtime and utility orders.
 *
 * Airtime and utility each have a webhook that Hubtel calls with the final
 * state. A callback can be lost, so the scheduled
 * `reconcile-hubtel-orders` sweep settles the same rows from the Status Check
 * API. Both paths therefore settle through these functions, so the rules that
 * decide whether an agent's money moves live in one place instead of in two
 * files that drift apart.
 *
 * The rules that matter:
 *   - `pending` settles nothing. An order Hubtel has not closed keeps the
 *     agent's wallet debited, because "unknown" is not "declined".
 *   - Every settle is guarded with `.eq`/`.in` on the status the row must still
 *     have, so a row the callback already moved cannot be moved again by a
 *     later, staler poll.
 *   - Refunds go through `refund_agent_wallet`, which is idempotent on the
 *     debit reference, so a callback and a sweep racing each other still refund
 *     exactly once.
 */

import type { adminClient } from './supabase.ts';
import { refundWallet } from './wallet.ts';

type Admin = ReturnType<typeof adminClient>;

async function settleCommissionLedger(
  admin: Admin,
  orderTable: 'airtime_orders' | 'utility_orders',
  orderId: string,
  status: 'earned' | 'reversed',
): Promise<void> {
  const { error } = await admin.from('service_commission_ledger').update({
    status,
    settled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('order_table', orderTable).eq('order_id', orderId).eq('status', 'pending');
  if (error) console.error('Commission ledger settlement failed:', error);
}

/** The one shape both a callback and a status poll can be reduced to. */
export interface HubtelVerdict {
  state: 'success' | 'failed';
  /** Credential-free body to persist. */
  payload: Record<string, unknown>;
  providerReference?: string | null;
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Airtime - public.airtime_orders
// ---------------------------------------------------------------------------

export interface HubtelAirtimeOrderRow {
  id: string;
  agent_id: string | null;
  payment_reference: string;
  amount: number;
  wallet_charge_amount?: number | null;
  provider_reference?: string | null;
}

export async function settleHubtelAirtimeOrder(
  admin: Admin,
  order: HubtelAirtimeOrderRow,
  verdict: HubtelVerdict,
): Promise<'delivered' | 'failed'> {
  const providerReference = verdict.providerReference ?? order.provider_reference ?? null;

  if (verdict.state === 'success') {
    // `fulfil_airtime_order` is the same RPC the purchase path uses, so payment
    // status, provider reference and the idempotency check on an already
    // delivered row all stay consistent with a synchronous success.
    const { error } = await admin.rpc('fulfil_airtime_order', {
      p_order_id: order.id,
      p_airtime_status: 'delivered',
      p_provider_reference: providerReference,
      p_provider_response: verdict.payload,
      p_failure_reason: null,
    });
    if (error) throw new Error(`Could not record the delivered airtime order: ${error.message}`);
    await settleCommissionLedger(admin, 'airtime_orders', order.id, 'earned');
    return 'delivered';
  }

  const { error } = await admin.from('airtime_orders').update({
    payment_status: 'failed',
    airtime_status: 'failed',
    provider_reference: providerReference,
    provider_response: verdict.payload,
    failure_reason: verdict.failureReason || 'Hubtel reported that the airtime delivery failed.',
    updated_at: new Date().toISOString(),
  }).eq('id', order.id).in('airtime_status', ['pending', 'pending_provider', 'processing']);
  if (error) throw new Error(`Could not record the failed airtime order: ${error.message}`);

  if (order.agent_id) {
    await refundWallet(
      order.agent_id,
      order.payment_reference,
      order.wallet_charge_amount ?? order.amount,
      'Hubtel airtime delivery failed',
    ).catch((refundError) => console.error('Airtime refund failed:', refundError));
  }

  await settleCommissionLedger(admin, 'airtime_orders', order.id, 'reversed');

  return 'failed';
}

// ---------------------------------------------------------------------------
// Utility bills - public.utility_orders
// ---------------------------------------------------------------------------

export interface HubtelUtilityOrderRow {
  id: string;
  agent_id: string | null;
  payment_reference: string;
  gross_amount: number;
  wallet_charge_amount?: number | null;
  bill_category: string;
  provider_reference?: string | null;
}

export async function settleHubtelUtilityOrder(
  admin: Admin,
  order: HubtelUtilityOrderRow,
  verdict: HubtelVerdict & { tokenCode?: string | null },
): Promise<'completed' | 'processing' | 'failed'> {
  const providerReference = verdict.providerReference ?? order.provider_reference ?? null;
  const now = new Date().toISOString();

  if (verdict.state === 'success') {
    // ECG tops up asynchronously and Hubtel reports the payment without a
    // token — its callback carries none and the Status Check API returns only
    // Paid/Unpaid. The token reaches the customer by SMS, so a success must
    // close the order; holding it at 'processing' would strand the wallet debit
    // on a state nothing can advance.
    const { error } = await admin.from('utility_orders').update({
      status: 'completed',
      token_code: verdict.tokenCode ?? null,
      provider_reference: providerReference,
      provider_response: verdict.payload,
      paid_at: now,
      completed_at: now,
    }).eq('id', order.id).in('status', ['paid', 'processing']);
    if (error) throw new Error(`Could not complete the utility order: ${error.message}`);
    await settleCommissionLedger(admin, 'utility_orders', order.id, 'earned');
    return 'completed';
  }

  const { error } = await admin.from('utility_orders').update({
    status: 'failed',
    provider_reference: providerReference,
    provider_response: verdict.payload,
    completed_at: now,
  }).eq('id', order.id).in('status', ['paid', 'processing']);
  if (error) throw new Error(`Could not record the failed utility order: ${error.message}`);

  if (order.agent_id) {
    await refundWallet(
      order.agent_id,
      order.payment_reference,
      order.wallet_charge_amount ?? order.gross_amount,
      'Hubtel utility payment failed',
    ).catch((refundError) => console.error('Utility refund failed:', refundError));
  }

  await settleCommissionLedger(admin, 'utility_orders', order.id, 'reversed');

  return 'failed';
}
