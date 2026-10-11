import { adminClient, corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';

/**
 * Admin console backend for the multi-agent store system.
 *
 * Lists every store with its order/revenue totals, lets an admin pause or
 * re-open a store, and reviews payout requests (approve / reject / mark paid).
 * All access is gated by `requireAdmin`; the browser never writes these tables
 * directly.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

const DECISIONS = ['approved', 'rejected', 'processing', 'paid', 'failed'];

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAdmin(request);

    if (request.method === 'GET') {
      const [storesRes, ordersRes, payoutsRes] = await Promise.all([
        admin.from('agent_stores')
          .select('id, slug, display_name, is_active, suspended_reason, created_at, agents(full_name, agent_code)')
          .order('created_at', { ascending: false }),
        admin.from('store_orders')
          .select('store_id, sale_amount, agent_earning, platform_revenue, payment_status, fulfilment_status'),
        admin.from('agent_payouts')
          .select('id, agent_id, amount, status, method, reference, admin_note, account_snapshot, requested_at, paid_at, agents(full_name, agent_code)')
          .order('requested_at', { ascending: false })
          .limit(200),
      ]);
      if (storesRes.error) throw storesRes.error;
      if (ordersRes.error) throw ordersRes.error;
      if (payoutsRes.error) throw payoutsRes.error;

      const stats = new Map<string, { orders: number; delivered: number; sales: number; earnings: number; revenue: number }>();
      for (const row of ordersRes.data ?? []) {
        const key = String(row.store_id);
        const entry = stats.get(key) ?? { orders: 0, delivered: 0, sales: 0, earnings: 0, revenue: 0 };
        entry.orders += 1;
        if (row.fulfilment_status === 'successful') entry.delivered += 1;
        if (row.payment_status === 'paid') {
          entry.sales += Number(row.sale_amount || 0);
          entry.earnings += Number(row.agent_earning || 0);
          entry.revenue += Number(row.platform_revenue || 0);
        }
        stats.set(key, entry);
      }

      const stores = (storesRes.data ?? []).map((store) => {
        const owner = Array.isArray(store.agents) ? store.agents[0] : store.agents;
        const s = stats.get(String(store.id)) ?? { orders: 0, delivered: 0, sales: 0, earnings: 0, revenue: 0 };
        return {
          id: store.id,
          slug: store.slug,
          displayName: store.display_name,
          isActive: store.is_active !== false,
          suspendedReason: store.suspended_reason || '',
          ownerName: owner?.full_name || owner?.agent_code || '',
          ownerCode: owner?.agent_code || '',
          createdAt: store.created_at,
          orders: s.orders,
          delivered: s.delivered,
          sales: round2(s.sales),
          earnings: round2(s.earnings),
          revenue: round2(s.revenue),
        };
      });

      const payouts = (payoutsRes.data ?? []).map((payout) => {
        const owner = Array.isArray(payout.agents) ? payout.agents[0] : payout.agents;
        return {
          id: payout.id,
          amount: round2(Number(payout.amount || 0)),
          status: payout.status,
          method: payout.method || '',
          reference: payout.reference || '',
          adminNote: payout.admin_note || '',
          account: payout.account_snapshot || null,
          requestedAt: payout.requested_at,
          paidAt: payout.paid_at,
          ownerName: owner?.full_name || owner?.agent_code || '',
          ownerCode: owner?.agent_code || '',
        };
      });

      return json({ stores, payouts });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const action = text(body.action, 40);

      if (action === 'set-store-active') {
        const storeId = text(body.storeId, 60);
        if (!storeId) return json({ error: 'A store is required.' }, 400);
        const isActive = body.isActive === true || body.isActive === 'true';
        const { error } = await admin
          .from('agent_stores')
          .update({
            is_active: isActive,
            suspended_reason: isActive ? null : (text(body.reason, 200) || 'Suspended by admin'),
          })
          .eq('id', storeId);
        if (error) throw error;
        return json({ success: true, isActive });
      }

      if (action === 'payout-decision') {
        const payoutId = text(body.payoutId, 60);
        const decision = text(body.decision, 20).toLowerCase();
        if (!payoutId) return json({ error: 'A payout is required.' }, 400);
        if (!DECISIONS.includes(decision)) {
          return json({ error: 'Choose a valid payout decision.' }, 400);
        }
        const updates: Record<string, unknown> = {
          status: decision,
          admin_note: text(body.note, 300) || null,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user.id,
        };
        if (decision === 'paid') updates.paid_at = new Date().toISOString();
        const { error } = await admin.from('agent_payouts').update(updates).eq('id', payoutId);
        if (error) throw error;
        return json({ success: true, status: decision });
      }

      return json({ error: 'Unknown admin action.' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-store-admin error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process the admin request.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /administrator access/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
