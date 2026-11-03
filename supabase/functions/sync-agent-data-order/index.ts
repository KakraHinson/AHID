import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';
import { fetchHubtelStatus } from '../_shared/hubtelDataProvider.ts';
import { refundWallet } from '../_shared/wallet.ts';

/**
 * Reconciles the agent's own data orders against the provider.
 *
 * Checks live delivery status directly from the provider (GrandTech / Swift).
 * Delivered bundles settle as 'successful'.
 * Orders ONLY settle as 'failed' or 'cancelled' (and refund the wallet) when the
 * provider explicitly confirms that the order failed or was cancelled.
 *
 * Crucially: In-flight or unconfirmed orders are NEVER arbitrarily timed out
 * or auto-refunded to ensure the agent's wallet remains properly charged
 * for accepted orders.
 */

const MAX_ORDERS_PER_SYNC = 100;

async function recordStatusEvent(
  admin: any,
  event: {
    orderType: string;
    orderId: string;
    agentId?: string | null;
    provider: string;
    providerStatus: string;
    internalStatus: string;
    payload?: Record<string, unknown>;
  },
) {
  const { error } = await admin.rpc('record_provider_order_status', {
    p_order_type: event.orderType,
    p_order_id: event.orderId,
    p_agent_id: event.agentId || null,
    p_provider: event.provider,
    p_provider_status: event.providerStatus || 'UNKNOWN',
    p_internal_status: event.internalStatus,
    p_source: 'agent_reconciliation',
    p_payload: event.payload || {},
  });
  if (error) console.error('Provider status event write failed:', error);
}

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

    let changed = 0;

    for (const order of orders ?? []) {
      const existingResp = (order.provider_response && typeof order.provider_response === 'object') ? order.provider_response as Record<string, unknown> : {};
      const providerName = String(order.provider_name || existingResp.provider || activeDataProvider(order.network_type, Number(order.volume_mb)));
      const providerOrderId = String(
        order.provider_order_id || existingResp.orderId || existingResp.provider_order_id ||
        existingResp.order_id || existingResp.providerReference || '',
      );
      const ref = String(order.provider_reference || '');

      const live = (providerOrderId || ref)
        ? await fetchDataOrderStatus(providerName as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
          console.error('Data status check failed:', err);
          return null;
        })
        : null;

      if (live && (live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled')) {
        const { error: settleError } = await supabase.rpc('settle_agent_data_order', {
          p_order_id: order.id,
          p_status: live.state,
          p_provider_response: { ...existingResp, lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
        });
        if (settleError) console.error('Settle failed:', settleError);
        else {
          changed += 1;
          await recordStatusEvent(supabase, {
            orderType: 'agent_data_orders',
            orderId: String(order.id),
            agentId: user.id,
            provider: providerName,
            providerStatus: live.status,
            internalStatus: live.state,
            payload: live.payload,
          });
        }
        continue;
      }

      // If live answer is still processing or unavailable, update provider_response with check timestamp
      // DO NOT auto-refund or mark failed without provider confirmation.
      if (live?.status) {
        await supabase
          .from('agent_data_orders')
          .update({
            provider_response: { ...existingResp, lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
          })
          .eq('id', order.id);
        await recordStatusEvent(supabase, {
          orderType: 'agent_data_orders',
          orderId: String(order.id),
          agentId: user.id,
          provider: providerName,
          providerStatus: live.status,
          internalStatus: String(order.status || 'processing'),
          payload: live.payload,
        });
      }
    }

    // Instant Data is a separate Hubtel flow. Keep the older public-data
    // reconciliation below for legacy rows, but never route data_transactions
    // through Swift/GrandTech.
    changed += await syncHubtelInstantDataOrders(supabase, user.id, orderReference);
    changed += await syncLegacyPublicDataOrders(supabase, user.id, orderReference);

    const { data: fresh } = await supabase
      .from('agent_data_orders')
      .select('id, provider_reference, short_code, provider_order_id, network_type, volume_mb, amount, status, created_at, completed_at')
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (changed > 0) {
      try {
        await admin.rpc('log_activity', {
          p_summary: `Reconciled ${changed} data bundle order${changed === 1 ? '' : 's'} with provider`,
          p_meta: { changed },
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
 * Reconciliation for current Instant Data orders.
 * Only settles and refunds when Hubtel explicitly confirms failure.
 */
async function syncHubtelInstantDataOrders(
  supabase: ReturnType<typeof adminClient>,
  agentId: string,
  orderReference: string | null,
): Promise<number> {
  let query = supabase
    .from('data_transactions')
    .select('id, user_id, reference, amount, status, metadata, hubtel_response, created_at')
    .eq('user_id', agentId)
    .in('status', ['pending', 'processing'])
    .order('created_at', { ascending: true })
    .limit(MAX_ORDERS_PER_SYNC);

  if (orderReference) query = query.eq('reference', orderReference);

  const { data: orders, error } = await query;
  if (error) {
    console.error('Hubtel instant data sync read failed:', error);
    return 0;
  }

  let changed = 0;
  for (const order of orders ?? []) {
    const storedResponse = (order.hubtel_response && typeof order.hubtel_response === 'object')
      ? order.hubtel_response as Record<string, unknown>
      : {};
    const storedMetadata = (order.metadata && typeof order.metadata === 'object')
      ? order.metadata as Record<string, unknown>
      : {};
    const providerOrderId = String(
      storedResponse.TransactionId || storedResponse.transactionId || storedResponse.OrderId || storedResponse.orderId ||
      storedMetadata.providerOrderId || storedMetadata.orderId || '',
    );

    const live = (providerOrderId || String(order.reference || ''))
      ? await fetchHubtelStatus(providerOrderId || String(order.reference || '')).catch((err) => {
        console.error('Hubtel instant data status check failed:', err);
        return null;
      })
      : null;

    if (!live) continue;

    const checkedResponse = {
      ...storedResponse,
      lastProviderStatus: live.status,
      checkedAt: new Date().toISOString(),
    };

    if (live.state === 'success' || live.state === 'failed') {
      const nextStatus = live.state === 'success' ? 'success' : 'failed';
      if (nextStatus === 'failed') {
        await refundWallet(
          agentId,
          String(order.reference),
          Number(order.amount),
          `Refund: Hubtel reported Instant Data failure (${live.status || 'failed'})`,
        );
      }

      const { error: updateError } = await supabase
        .from('data_transactions')
        .update({
          status: nextStatus,
          hubtel_response: { ...checkedResponse, ...live.payload },
          failure_reason: nextStatus === 'failed' ? `Hubtel reported ${live.status || 'failed'}` : null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)
        .in('status', ['pending', 'processing']);
      if (updateError) {
        console.error('Hubtel instant data settle failed:', updateError);
        continue;
      }

      changed += 1;
      await recordStatusEvent(supabase, {
        orderType: 'data_transactions',
        orderId: String(order.id),
        agentId,
        provider: 'hubtel',
        providerStatus: live.status,
        internalStatus: nextStatus,
        payload: live.payload,
      });
    } else {
      await supabase
        .from('data_transactions')
        .update({
          hubtel_response: { ...checkedResponse, ...live.payload },
          metadata: { ...storedMetadata, lastProviderStatus: live.status, checkedAt: checkedResponse.checkedAt },
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id)
        .in('status', ['pending', 'processing']);
    }
  }

  return changed;
}

/**
 * Reconciliation for legacy public-data orders. These rows predate the
 * Hubtel Instant Data storefront and remain on the Standard provider facade.
 */
async function syncLegacyPublicDataOrders(
  supabase: ReturnType<typeof adminClient>,
  agentId: string,
  orderReference: string | null,
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
    const providerOrderId = String(stored.providerOrderId ?? stored.orderId ?? stored.providerReference ?? '');
    const ref = String(order.payment_reference ?? '');

    const live = (providerOrderId || ref)
      ? await fetchDataOrderStatus(provider as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
        console.error('Instant data status check failed:', err);
        return null;
      })
      : null;

    let nextStatus: 'successful' | 'failed' | 'cancelled' | null = null;

    if (live?.state === 'successful') {
      nextStatus = 'successful';
    } else if (live?.state === 'failed' || live?.state === 'cancelled') {
      nextStatus = 'failed';
    }

    // If provider confirmed terminal state
    if (nextStatus) {
      const { error: settleError } = await supabase.rpc('mark_public_data_order', {
        p_order_id: order.id,
        p_status: nextStatus,
        p_provider_amount: null,
        p_provider_reference: null,
        p_provider_response: { ...stored, lastProviderStatus: live?.status, checkedAt: new Date().toISOString() },
      });
      if (settleError) {
        console.error('Instant data settle failed:', settleError);
        continue;
      }
      changed += 1;

      await recordStatusEvent(supabase, {
        orderType: 'public_data_orders',
        orderId: String(order.id),
        agentId,
        provider,
        providerStatus: live?.status || nextStatus,
        internalStatus: nextStatus,
        payload: live?.payload,
      });

      // Only refund if provider explicitly failed
      if (nextStatus === 'failed' && order.agent_id) {
        await refundWallet(
          order.agent_id,
          String(order.payment_reference),
          Number(order.sale_amount),
          `Instant data bundle rejected by provider: ${live?.status || 'Failed'}`,
        ).catch((err) => console.error('Instant data refund failed:', err));
      }
    } else if (live?.status) {
      // Still in progress: update provider_response timestamp
      await supabase
        .from('public_data_orders')
        .update({
          provider_response: { ...stored, lastProviderStatus: live.status, checkedAt: new Date().toISOString() },
        })
        .eq('id', order.id);
    }
  }

  return changed;
}
