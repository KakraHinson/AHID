import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { activeDataProvider, dataOrderStuckMinutes, fetchDataOrderStatus } from '../_shared/dataProvider.ts';
import { refundWallet } from '../_shared/wallet.ts';

/**
 * Reconciles the agent's own data orders against the provider.
 *
 * The agent dashboard calls this whenever the orders page is opened, because a
 * data bundle is delivered asynchronously: the provider accepting the order only
 * means it reserved our balance, so the order sits in 'processing' until this
 * confirms the real outcome. Delivered bundles settle as 'successful'; failed or
 * cancelled ones settle as failed/cancelled, which refunds the agent's wallet
 * exactly once inside settle_agent_data_order.
 *
 * Two tables are covered because the two storefronts buy the same product
 * through different rows:
 *   - agent_data_orders: whole-GB "Data Bundle" bundles from dashboard.html
 *   - public_data_orders: "Instant Data" top-ups from instantData.html
 * Without the second loop an instant data order would read "Processing" on the
 * orders page forever, because only get-public-data-order (customer polling,
 * reference + email) used to settle it.
 */

const MAX_ORDERS_PER_SYNC = 20;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin, user } = await requireAgent(request);

    const body = await request.json().catch(() => ({}));
    const orderReference = body?.orderReference ? String(body.orderReference) : null;

    const supabase = adminClient();

    let query = supabase
      .from('agent_data_orders')
      .select('id, provider_reference, provider_name, provider_order_id, network_type, volume_mb, amount, status, created_at, provider_response')
      .eq('agent_id', user.id)
      .in('status', ['pending', 'processing'])
      .order('created_at', { ascending: true })
      .limit(MAX_ORDERS_PER_SYNC);

    if (orderReference) query = query.eq('provider_reference', orderReference);

    const { data: orders, error } = await query;
    if (error) throw error;

    const stuckMinutes = dataOrderStuckMinutes();
    let changed = 0;

    for (const order of orders ?? []) {
      const providerName = String(order.provider_name || activeDataProvider(order.network_type, Number(order.volume_mb)));
      const providerOrderId = String(order.provider_order_id || '');
      const ref = String(order.provider_reference || '');

      const live = (providerOrderId || ref)
        ? await fetchDataOrderStatus(providerName as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
          console.error('Data status check failed:', err);
          return null;
        })
        : null;

      const existingResp = (order.provider_response && typeof order.provider_response === 'object') ? order.provider_response : {};

      if (live && (live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled')) {
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: live.state,
          p_provider_response: { ...existingResp, lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Settle failed:', settleError);
        else changed += 1;
        continue;
      }

      // No live answer from the provider. If it has had long enough, the bundle
      // is never going to land, so release the agent's money rather than leaving
      // them paid and waiting.
      const ageMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;
      if (ageMinutes > stuckMinutes) {
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: 'failed',
          p_provider_response: { ...existingResp, lastProviderStatus: live?.status ?? 'TIMED_OUT', checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Stuck-order settle failed:', settleError);
        else changed += 1;
      }
    }

    changed += await syncInstantDataOrders(supabase, user.id, orderReference, stuckMinutes);

    const { data: fresh } = await supabase
      .from('agent_data_orders')
      .select('id, provider_reference, short_code, provider_order_id, network_type, volume_mb, amount, status, created_at, completed_at')
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100);

    // Provider reconciliation is not a row write of its own, so record it
    // explicitly in the activity log alongside the table triggers.
    //
    // A Supabase query builder is PromiseLike, not a Promise, so it has no
    // .catch(). Calling one threw a TypeError that the outer handler turned into
    // a 500, which is why this used to fail whenever anything actually settled.
    // Auditing must never break the sync, so it is wrapped instead.
    if (changed > 0) {
      try {
        await admin.rpc('log_activity', {
          p_summary: `Reconciled ${changed} data bundle order${changed === 1 ? '' : 's'} with the provider`,
          p_meta: { changed, stuckMinutes },
          p_actor_user_id: user.id,
        });
      } catch (err) {
        console.error('Activity log write failed:', err);
      }
    }

    return json({ success: true, changed, orders: fresh ?? [] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sync data orders.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});

/**
 * The same reconciliation for the agent's instant data orders.
 *
 * create-public-data-payment stores the provider's own order id inside
 * provider_response rather than in a column, because public_data_orders has no
 * provider_order_id. mark_public_data_order only moves a row out of
 * pending_payment/processing, so a repeated sync is naturally idempotent here,
 * and refundWallet is itself idempotent on the payment reference - so a bundle
 * that fails is refunded exactly once no matter how often this runs.
 */
async function syncInstantDataOrders(
  supabase: ReturnType<typeof adminClient>,
  agentId: string,
  orderReference: string | null,
  stuckMinutes: number,
): Promise<number> {
  let query = supabase
    .from('public_data_orders')
    .select('id, payment_reference, agent_id, network_type, volume_mb, sale_amount, status, created_at, provider_response')
    .eq('agent_id', agentId)
    .in('status', ['pending_payment', 'processing'])
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SYNC);

  if (orderReference) query = query.eq('payment_reference', orderReference);

  const { data: orders, error } = await query;
  if (error) {
    console.error('Instant data sync read failed:', error);
    return 0;
  }

  let changed = 0;

  for (const order of orders ?? []) {
    const stored = (order.provider_response || {}) as Record<string, unknown>;
    const provider = String(stored.provider || activeDataProvider(order.network_type, Number(order.volume_mb)));
    const providerOrderId = String(stored.providerOrderId ?? '');

    const live = providerOrderId
      ? await fetchDataOrderStatus(provider as 'grandtech', providerOrderId).catch((err) => {
        console.error('Instant data status check failed:', err);
        return null;
      })
      : null;

    let nextStatus: 'successful' | 'failed' | 'cancelled' | null = null;

    if (live?.state === 'successful') {
      nextStatus = 'successful';
    } else if (live?.state === 'failed' || live?.state === 'cancelled') {
      nextStatus = 'failed';
    } else {
      const ageMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;
      if (ageMinutes > stuckMinutes) nextStatus = 'failed';
    }

    if (!nextStatus) continue;

    const { error: settleError } = await supabase.rpc('mark_public_data_order', {
      p_order_id: order.id,
      p_status: nextStatus,
      p_provider_amount: null,
      p_provider_reference: null,
      p_provider_response: { ...stored, lastProviderStatus: live?.status ?? 'TIMED_OUT', checkedAt: new Date().toISOString() },
    });
    if (settleError) {
      console.error('Instant data settle failed:', settleError);
      continue;
    }
    changed += 1;

    if (nextStatus === 'failed' && order.agent_id) {
      await refundWallet(
        order.agent_id,
        String(order.payment_reference),
        Number(order.sale_amount),
        'Instant data bundle not delivered',
      ).catch((err) => console.error('Instant data refund failed:', err));
    }
  }

  return changed;
}
