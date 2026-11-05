import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';
import type { adminClient } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import { hubtelRequest } from '../_shared/hubtelClient.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';

// Commission Services path segment: the DISBURSEMENT (prepaid deposit) account.
// Distinct from the merchant/collection account used to receive money.
const DISBURSEMENT_ACCOUNT = Deno.env.get('HUBTEL_DISBURSEMENT_ACCOUNT')?.trim() || '';
const ECG_SERVICE_ID = 'e6d6bac062b5499cb1ece1ac3d742a84';

type LiveOrderStatus = {
  state: 'successful' | 'failed' | 'cancelled' | 'processing';
  status: string;
  payload?: Record<string, unknown>;
};

type Admin = ReturnType<typeof adminClient>;

function normalizeCheckerExamType(value: unknown): 'BECE' | 'WASSCE' | null {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (normalized === 'BECE') return 'BECE';
  if (normalized === 'WASSCE' || normalized === 'NOV/DEC' || normalized === 'NOVDEC' || normalized === 'NOV-DEC') return 'WASSCE';
  return null;
}

async function fetchLiveOrderStatus(
  provider: string,
  providerOrderId: string,
  reference: string,
): Promise<LiveOrderStatus | null> {
  const normalized = provider.trim().toLowerCase();
  if (normalized !== 'swift' && normalized !== 'grandtech') return null;
  return await fetchDataOrderStatus(normalized as 'swift' | 'grandtech', providerOrderId, reference);
}

async function recordProviderStatus(
  admin: Admin,
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
    p_source: 'admin_provider_sync',
    p_payload: event.payload || {},
  });
  if (error) throw error;
}

async function fetchAllRows<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

// Helper to query Hubtel live balance for disbursement account 2027124
async function fetchHubtelDisbursementBalance(): Promise<{ balance: number; currency: string; status: string }> {
  try {
    const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
    const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
    if (!clientId || !clientSecret) {
      return { balance: 0, currency: 'GHS', status: 'unconfigured' };
    }

    const endpoint = `https://cs.hubtel.com/commissionservices/${encodeURIComponent(DISBURSEMENT_ACCOUNT)}/balance`;
    const res = await hubtelRequest(endpoint, {
      method: 'GET',
    });

    if (res.ok && res.payload && typeof res.payload === 'object') {
      const data = res.payload as Record<string, unknown>;
      const rawBal = data.Balance ?? data.balance ?? (data.Data as Record<string, unknown>)?.Balance ?? 0;
      return {
        balance: Number(rawBal) || 0,
        currency: 'GHS',
        status: 'live',
      };
    }

    return { balance: 0, currency: 'GHS', status: 'unavailable' };
  } catch (_e) {
    return { balance: 0, currency: 'GHS', status: 'error' };
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user: caller } = await requireAdmin(request);
    const url = new URL(request.url);

    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      body = await request.json().catch(() => ({})) as Record<string, unknown>;
    }

    const action = String(body.action || url.searchParams.get('action') || '').trim();
    const section = String(body.section || url.searchParams.get('section') || (action ? '' : 'overview')).trim();

    // -------------------------------------------------------------------------
    // SECTION DATA QUERIES (Handled for both GET and POST with section)
    // -------------------------------------------------------------------------
    if (section && !action) {
      // 1. OVERVIEW & ANALYTICS DASHBOARD
      if (section === 'overview') {
        const [rpcMetrics, balanceData, activityRes] = await Promise.all([
          admin.rpc('get_admin_dashboard_metrics'),
          fetchHubtelDisbursementBalance(),
          admin
            .from('activity_log')
            .select('id, summary, metadata, created_at, actor_user_id')
            .order('created_at', { ascending: false })
            .limit(12),
        ]);

        const metrics = rpcMetrics.data || {
          total_revenue: 0,
          agent_store_sales: 0,
          disbursement_account_id: DISBURSEMENT_ACCOUNT,
          pending_transactions: 0,
          successful_transactions: 0,
          breakdown: {
            data_bundles: 0,
            airtime: 0,
            utility_bills: 0,
            agent_store: 0,
          },
        };

        return json({
          success: true,
          metrics,
          disbursement: {
            account: DISBURSEMENT_ACCOUNT,
            balance: balanceData.balance,
            status: balanceData.status,
            currency: balanceData.currency,
          },
          recentActivity: activityRes.data || [],
        });
      }

      // 2. STANDARD DATA BUNDLES
      if (section === 'data-management') {
        const [agentOrders, publicOrders, legacyOrders, storeOrders, catalogRes] = await Promise.all([
          fetchAllRows((from, to) => admin
            .from('agent_data_orders')
            .select('id, provider_reference, short_code, provider_name, provider_order_id, provider_response, phone, network_type, volume_mb, amount, status, created_at')
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('public_data_orders')
            .select('id, payment_reference, short_code, provider_name, provider_reference, provider_response, customer_phone, customer_name, network_type, volume_mb, sale_amount, status, created_at')
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('orders')
            .select('id, reference, short_code, network, bundle_size, recipient_phone, amount, status, created_at')
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('store_orders')
            .select('id, reference, short_code, product_type, product_label, network, recipient, platform_price, fulfilment_status, payment_status, provider, provider_reference, provider_response, created_at')
            .eq('product_type', 'data_bundle')
            .order('created_at', { ascending: false })
            .range(from, to)),
          admin
            .from('bundle_catalog')
            .select('bundle_id, network, title, volume_mb, price, provider_cost, active, inactive_reason, updated_at')
            .order('network')
            .order('volume_mb'),
        ]);

        const agentOrderRows = agentOrders.map((o) => ({
          id: o.id,
          reference: o.provider_reference,
          shortCode: o.short_code || '',
          phone: o.phone,
          network: o.network_type,
          amount: Number(o.amount || 0),
          status: o.status,
          provider: o.provider_name || 'Swift',
          providerStatus: o.provider_response?.lastProviderStatus || o.provider_response?.providerStatus || o.status,
          providerReference: o.provider_order_id || o.provider_reference || '',
          failureReason: '',
          createdAt: o.created_at,
          type: 'Data Bundle (Agent Dashboard)',
          details: `${o.volume_mb}MB`,
        }));

        const publicOrderRows = publicOrders.map((o) => ({
          id: o.id,
          reference: o.payment_reference,
          shortCode: o.short_code || '',
          phone: o.customer_phone,
          network: o.network_type,
          amount: Number(o.sale_amount || 0),
          status: o.status,
          provider: o.provider_name || 'Swift',
          providerStatus: o.provider_response?.lastProviderStatus || o.provider_response?.providerStatus || o.status,
          providerReference: o.provider_reference || '',
          failureReason: '',
          createdAt: o.created_at,
          type: 'Data Bundle (Agent Dashboard, Public)',
          details: `${o.volume_mb}MB (${o.customer_name || 'Customer'})`,
        }));

        const legacyOrderRows = legacyOrders.map((o) => ({
          id: o.id,
          reference: o.reference || o.id,
          shortCode: o.short_code || '',
          phone: o.recipient_phone,
          network: o.network,
          amount: Number(o.amount || 0),
          status: o.status || 'completed',
          provider: 'Swift',
          providerStatus: o.status || 'completed',
          failureReason: '',
          createdAt: o.created_at,
          type: 'Data Bundle (Wallet)',
          details: o.bundle_size || 'Data bundle',
        }));

        const storeOrderRows = storeOrders.map((o) => ({
          id: o.id,
          reference: o.reference,
          shortCode: o.short_code || '',
          phone: o.recipient,
          network: o.network,
          amount: Number(o.platform_price || 0),
          status: o.fulfilment_status || (o.payment_status === 'paid' ? 'processing' : o.payment_status),
          provider: o.provider || 'Swift',
          providerStatus: o.provider_response?.lastProviderStatus || o.provider_response?.providerStatus || o.fulfilment_status,
          providerReference: o.provider_reference || '',
          failureReason: '',
          createdAt: o.created_at,
          // Store orders are reconciled by the agent order page and remain
          // visible here as durable wallet fulfilment records.
          kind: 'legacy',
          type: 'Data Bundle (Agent Wallet)',
          details: o.product_label || 'Data bundle',
        }));

        const orders = [...agentOrderRows, ...publicOrderRows, ...legacyOrderRows, ...storeOrderRows].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return json({
          success: true,
          orders,
          bundleCatalog: catalogRes.data || [],
        });
      }

      // 3. AIRTIME DISPATCH MODULE
      if (section === 'airtime-management') {
        const { data: airtimeOrders, error: airtimeErr } = await admin
          .from('airtime_orders')
          .select('id, payment_reference, recipient_phone, network, amount, fee_amount, gross_amount, payment_method, payment_status, airtime_status, provider_reference, failure_reason, customer_name, customer_email, created_at')
          .order('created_at', { ascending: false })
          .limit(200);

        if (airtimeErr) throw airtimeErr;

        return json({
          success: true,
          commissionAccount: DISBURSEMENT_ACCOUNT,
          serviceIds: {
            mtn: 'fdd76c884e614b1c8f669a3207b09a98',
            telecel: 'f4be83ad74c742e185224fdae1304800',
            at: 'dae2142eb5a14c298eace60240c09e4b',
          },
          orders: airtimeOrders || [],
        });
      }

      // 4. UTILITY BILLS MODULE (ECG Prepaid, ECG Postpaid, Ghana Water, DStv, GOtv, StarTimes)
      if (section === 'utility-management') {
        const { data: utilityOrders, error: utilityErr } = await admin
          .from('utility_orders')
          .select('id, payment_reference, bill_type, bill_category, account_number, meter_type, package_name, customer_name, customer_phone, amount, fee_amount, gross_amount, status, token_code, provider_reference, created_at')
          .order('created_at', { ascending: false })
          .limit(200);

        if (utilityErr) throw utilityErr;

        return json({
          success: true,
          serviceId: ECG_SERVICE_ID,
          merchantAccount: DISBURSEMENT_ACCOUNT,
          orders: utilityOrders || [],
        });
      }

      // 5. AGENT STORE MANAGEMENT MODULE
      if (section === 'agent-store-management') {
        const [storesRes, ordersRes, ratesRes, pricingRes] = await Promise.all([
          admin
            .from('agent_stores')
            .select('id, agent_id, slug, display_name, is_active, suspended_reason, created_at, agents(full_name, phone, agent_code)')
            .order('created_at', { ascending: false }),
          admin
            .from('store_orders')
            .select('id, store_id, agent_id, reference, short_code, product_type, product_label, sale_amount, agent_earning, platform_revenue, payment_status, fulfilment_status, customer_name, customer_phone, created_at')
            .order('created_at', { ascending: false })
            .limit(100),
          admin
            .from('service_commission_rates')
            .select('*'),
          admin
            .from('agent_pricing')
            .select('*')
            .limit(100),
        ]);

        return json({
          success: true,
          stores: storesRes.data || [],
          orders: ordersRes.data || [],
          commissionRates: ratesRes.data || [],
          pricing: pricingRes.data || [],
        });
      }

      // 6. USER & AGENT WALLETS MODULE
      if (section === 'wallets') {
        const query = (String(body.q || url.searchParams.get('q') || '')).trim().toLowerCase();

        const [walletsRes, agentsRes, profilesRes] = await Promise.all([
          admin.from('wallets').select('id, balance, sales, deposits, commission_balance, total_commission_earned, updated_at'),
          admin.from('agents').select('id, full_name, phone, agent_code, role, created_at'),
          admin.from('profiles').select('id, full_name, phone, agent_code'),
        ]);

        const agentMap = new Map();
        for (const a of agentsRes.data || []) agentMap.set(a.id, a);

        const profileMap = new Map();
        for (const p of profilesRes.data || []) profileMap.set(p.id, p);

        let list = (walletsRes.data || []).map((w) => {
          const a = agentMap.get(w.id);
          const p = profileMap.get(w.id);
          return {
            id: w.id,
            fullName: a?.full_name || p?.full_name || 'Agent/User',
            phone: a?.phone || p?.phone || '',
            agentCode: a?.agent_code || p?.agent_code || '',
            role: a?.role || 'agent',
            balance: Number(w.balance || 0),
            sales: Number(w.sales || 0),
            deposits: Number(w.deposits || 0),
            commissionBalance: Number(w.commission_balance || 0),
            totalCommissionEarned: Number(w.total_commission_earned || 0),
            updatedAt: w.updated_at,
          };
        });

        if (query) {
          list = list.filter(
            (u) =>
              String(u.fullName || '').toLowerCase().includes(query) ||
              String(u.phone || '').toLowerCase().includes(query) ||
              String(u.agentCode || '').toLowerCase().includes(query) ||
              String(u.id || '').toLowerCase().includes(query)
          );
        }

        return json({ success: true, wallets: list });
      }

      // 7. WALLET HISTORY FOR SPECIFIC USER
      if (section === 'wallet-history') {
        const userId = String(body.userId || url.searchParams.get('userId') || '');
        if (!userId) return json({ error: 'userId is required' }, 400);

        const [topups, cashouts, transactions, refunds] = await Promise.all([
          fetchAllRows((from, to) => admin
            .from('wallet_topups')
            .select('id, amount, payment_reference, status, provider, created_at, paid_at')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('cashout_deposit_requests')
            .select('id, amount, status, admin_notes, created_at, processed_at')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('transactions')
            .select('id, type, amount, balance_before, balance_after, description, status, created_at, metadata')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .range(from, to)),
          fetchAllRows((from, to) => admin
            .from('agent_wallet_refunds')
            .select('id, amount, reference, reason, admin_id, created_at')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .range(from, to)),
        ]);

        return json({
          success: true,
          topups,
          cashouts,
          transactions,
          refunds,
        });
      }

      // 8. AGENT NOTIFICATIONS
      if (section === 'notifications') {
        const [agentsRes, noticesRes] = await Promise.all([
          admin
            .from('agents')
            .select('id, full_name, agent_code, phone, role, status, is_active, created_at')
            .order('full_name', { ascending: true }),
          admin
            .from('notifications')
            .select('id, user_id, title, body, kind, read_at, created_at, order_id')
            .eq('order_table', 'admin_broadcast')
            .order('created_at', { ascending: false })
            .limit(2000),
        ]);

        if (agentsRes.error) throw agentsRes.error;
        if (noticesRes.error) throw noticesRes.error;

        const agents = (agentsRes.data || []).filter((agent) => {
          const roleName = String(agent.role || 'agent').toLowerCase();
          const status = String(agent.status || 'active').toLowerCase();
          return !['admin', 'super_admin'].includes(roleName)
            && !['cancelled', 'suspended'].includes(status)
            && agent.is_active !== false;
        });

        const agentMap = new Map((agentsRes.data || []).map((agent) => [String(agent.id), agent]));
        const campaigns = new Map<string, Record<string, unknown>>();
        for (const notice of noticesRes.data || []) {
          const campaignId = String(notice.order_id || notice.id);
          const existing = campaigns.get(campaignId);
          const recipient = agentMap.get(String(notice.user_id));
          if (existing) {
            existing.recipientCount = Number(existing.recipientCount || 0) + 1;
            if (!notice.read_at) existing.unreadCount = Number(existing.unreadCount || 0) + 1;
            continue;
          }
          campaigns.set(campaignId, {
            id: campaignId,
            title: notice.title,
            body: notice.body,
            kind: notice.kind,
            createdAt: notice.created_at,
            recipientCount: 1,
            unreadCount: notice.read_at ? 0 : 1,
            sampleRecipient: recipient?.full_name || recipient?.agent_code || 'Agent',
          });
        }

        return json({
          success: true,
          agents: agents.map((agent) => ({
            id: agent.id,
            fullName: agent.full_name || 'Agent',
            agentCode: agent.agent_code || '',
            phone: agent.phone || '',
          })),
          campaigns: Array.from(campaigns.values()),
        });
      }
    }

    // -------------------------------------------------------------------------
    // ACTION HANDLERS (POST)
    // -------------------------------------------------------------------------

    // ACTION: TOGGLE DATA BUNDLE STOCK / AVAILABILITY
    if (action === 'toggle-data-stock') {
      const bundleId = String(body.bundleId || '').trim();
      const isAvailable = Boolean(body.isAvailable);
      const catalogType = String(body.catalogType || 'bundles').trim();

      if (!bundleId) return json({ error: 'bundleId is required.' }, 400);

      if (catalogType !== 'bundle_catalog') return json({ error: 'Only Standard Data bundles can be managed here.' }, 400);
      const { error } = await admin
        .from('bundle_catalog')
        .update({ active: isAvailable, inactive_reason: isAvailable ? null : 'Toggled by admin' })
        .eq('bundle_id', bundleId);
      if (error) throw error;

      return json({ success: true, bundleId, isAvailable });
    }

    // ACTION: UPDATE DATA BUNDLE PRICE
    if (action === 'update-bundle-price') {
      const bundleId = String(body.bundleId || '').trim();
      const newPrice = Number(body.newPrice);
      const catalogType = String(body.catalogType || 'bundle_catalog').trim();

      if (!bundleId) return json({ error: 'bundleId is required.' }, 400);
      if (!Number.isFinite(newPrice) || newPrice <= 0) {
        return json({ error: 'A valid positive price is required.' }, 400);
      }

      const formattedPrice = Math.round(newPrice * 100) / 100;

      if (catalogType !== 'bundle_catalog') return json({ error: 'Only Standard Data bundles can be managed here.' }, 400);
      const { data: updatedBundle, error } = await admin
        .from('bundle_catalog')
        .update({ price: formattedPrice, updated_at: new Date().toISOString() })
        .eq('bundle_id', bundleId)
        .select('bundle_id, price, updated_at')
        .maybeSingle();
      if (error) throw error;
      if (!updatedBundle) return json({ error: 'The selected data bundle no longer exists.' }, 404);

      return json({
        success: true,
        bundleId: updatedBundle.bundle_id,
        newPrice: Number(updatedBundle.price),
        updatedAt: updatedBundle.updated_at,
        catalogType,
      });
    }

    // ACTION: SEND AN AGENT NOTIFICATION
    if (action === 'send-agent-notification') {
      const recipientId = String(body.recipientId || 'all').trim();
      const title = String(body.title || '').trim().slice(0, 120);
      const message = String(body.message || '').trim().slice(0, 2000);
      const kind = String(body.kind || 'info').trim().toLowerCase();

      if (!title) return json({ error: 'A notification title is required.' }, 400);
      if (!message) return json({ error: 'A notification message is required.' }, 400);
      if (!['info', 'success', 'warning', 'error'].includes(kind)) {
        return json({ error: 'Notification type must be info, success, warning, or error.' }, 400);
      }

      const { data: agentRows, error: agentsError } = await admin
        .from('agents')
        .select('id, role, status, is_active')
        .order('created_at', { ascending: true });
      if (agentsError) throw agentsError;

      const eligibleAgents = (agentRows || []).filter((agent) => {
        const roleName = String(agent.role || 'agent').toLowerCase();
        const status = String(agent.status || 'active').toLowerCase();
        return !['admin', 'super_admin'].includes(roleName)
          && !['cancelled', 'suspended'].includes(status)
          && agent.is_active !== false;
      });
      const recipients = recipientId === 'all'
        ? eligibleAgents
        : eligibleAgents.filter((agent) => String(agent.id) === recipientId);

      if (!recipients.length) return json({ error: 'No eligible agent matched the selected recipient.' }, 404);

      const campaignId = crypto.randomUUID();
      const rows = recipients.map((agent) => ({
        user_id: agent.id,
        title,
        body: message,
        kind,
        order_table: 'admin_broadcast',
        order_id: campaignId,
      }));
      const { error: insertError } = await admin.from('notifications').insert(rows);
      if (insertError) throw insertError;

      return json({ success: true, campaignId, recipientCount: rows.length });
    }

    // ACTION: DISPATCH AIRTIME (MTN, Telecel, AirtelTigo via Hubtel Commission Services)
    if (action === 'dispatch-airtime') {
      const phone = String(body.phone || '').trim();
      const network = String(body.network || '').trim().toLowerCase() as 'mtn' | 'telecel' | 'at';
      const amount = Number(body.amount);

      if (!phone || !['mtn', 'telecel', 'at'].includes(network) || !amount || amount <= 0) {
        return json({ error: 'Valid phone, network (mtn, telecel, at), and positive amount are required.' }, 400);
      }

      const clientRef = `ADM-AIR-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      // Create pending order row
      const { data: orderRow, error: insertErr } = await admin
        .from('airtime_orders')
        .insert({
          user_id: caller.id,
          agent_id: caller.id,
          payment_reference: clientRef,
          recipient_phone: phone,
          network,
          amount,
          fee_amount: 0,
          gross_amount: amount,
          payment_method: 'wallet',
          payment_status: 'paid',
          airtime_status: 'processing',
          customer_name: 'Admin Manual Dispatch',
        })
        .select('id')
        .single();

      if (insertErr || !orderRow) {
        return json({ error: insertErr?.message || 'Failed to record airtime order.' }, 400);
      }

      // Call Hubtel Commission Services endpoint
      const dispatchResult = await dispatchAirtimeTopup({
        phone,
        network,
        amount,
        reference: clientRef,
      });

      // Update airtime_orders row with result
      await admin
        .from('airtime_orders')
        .update({
          airtime_status: dispatchResult.status,
          provider_reference: dispatchResult.providerReference || null,
          provider_response: dispatchResult.providerResponse || null,
          failure_reason: dispatchResult.failureReason || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderRow.id);

      return json({
        success: dispatchResult.success,
        status: dispatchResult.status,
        reference: clientRef,
        providerReference: dispatchResult.providerReference,
        failureReason: dispatchResult.failureReason,
      });
    }

    // ACTION: RETRY AIRTIME ORDER
    if (action === 'retry-airtime-order') {
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return json({ error: 'orderId is required' }, 400);

      const { data: order, error: fetchErr } = await admin
        .from('airtime_orders')
        .select('*')
        .eq('id', orderId)
        .single();

      if (fetchErr || !order) return json({ error: 'Airtime order not found.' }, 404);

      const dispatchResult = await dispatchAirtimeTopup({
        phone: order.recipient_phone,
        network: order.network as 'mtn' | 'telecel' | 'at',
        amount: Number(order.amount),
        reference: order.payment_reference,
      });

      await admin
        .from('airtime_orders')
        .update({
          airtime_status: dispatchResult.status,
          provider_reference: dispatchResult.providerReference || order.provider_reference,
          provider_response: dispatchResult.providerResponse || order.provider_response,
          failure_reason: dispatchResult.failureReason || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      return json({
        success: dispatchResult.success,
        status: dispatchResult.status,
        providerReference: dispatchResult.providerReference,
      });
    }

    // ACTION: VERIFY UTILITY / METER / ACCOUNT (ECG, Water, TV)
    if (action === 'verify-utility-meter' || action === 'verify-utility-account') {
      let accountNumber = String(body.accountNumber || body.meterNumber || '').trim();
      if (/^\+?233([A-Za-z].*)$/.test(accountNumber)) {
        accountNumber = accountNumber.replace(/^\+?233/, '');
      } else if (/^\+?233(\d{8,16})$/.test(accountNumber)) {
        accountNumber = accountNumber.replace(/^\+?233/, '');
      }
      const rawService = String(body.service || 'ecg_prepaid').trim().toLowerCase();
      const service = rawService.startsWith('ecg') ? 'ecg' : rawService;

      if (!accountNumber) return json({ error: 'Account/meter number is required.' }, 400);

      const phone = String(body.phone || body.customerPhone || '').trim();
      if ((service === 'ecg' || service === 'ecg_postpaid' || service === 'ghana_water') && !/^0\d{9}$/.test(phone)) {
        return json({ success: false, message: 'A valid Ghana phone number linked to the account is required.' }, 400);
      }

      try {
        const verifyResult = await callUtilityProvider('verify', {
          service,
          accountNumber,
          customerPhone: phone,
          reference: `VRF-${Date.now()}`,
        });

        return json({
          success: verifyResult.success,
          verified: verifyResult.verified,
          customerName: verifyResult.customerName || 'Verified Customer',
          message: verifyResult.message,
        });
      } catch (e: unknown) {
        const err = e as Error;
        return json({ success: false, message: err.message || 'Verification failed.' }, 400);
      }
    }

    // ACTION: DISPATCH UTILITY (ECG Prepaid, ECG Postpaid, Ghana Water, DStv, GOtv, StarTimes)
    if (action === 'dispatch-utility') {
      const rawService = String(body.service || 'ecg_prepaid').trim().toLowerCase();
      let accountNumber = String(body.accountNumber || body.meterNumber || '').trim();
      if (/^\+?233([A-Za-z].*)$/.test(accountNumber)) {
        accountNumber = accountNumber.replace(/^\+?233/, '');
      } else if (/^\+?233(\d{8,16})$/.test(accountNumber)) {
        accountNumber = accountNumber.replace(/^\+?233/, '');
      }
      const amount = Number(body.amount);
      const customerName = String(body.customerName || 'Customer').trim();
      const packageName = String(body.packageName || '').trim();
      const requestedPhone = String(body.phone || '').trim();
      let phone = requestedPhone || '0500000000';

      // Resolve category & bill_type
      let billType = 'ecg';
      let billCategory = 'electricity';
      let meterType: string | null = null;

      if (rawService === 'ecg_prepaid') {
        billType = 'ecg';
        billCategory = 'electricity';
        meterType = String(body.meterType || 'prepaid').trim();
      } else if (rawService === 'ecg_postpaid') {
        billType = 'ecg';
        billCategory = 'electricity';
        meterType = 'postpaid';
      } else if (rawService === 'ghana_water' || rawService === 'water') {
        billType = 'ghana_water';
        billCategory = 'water';
      } else if (['dstv', 'gotv', 'startimes'].includes(rawService)) {
        billType = rawService;
        billCategory = 'tv';
      }

      if ((billType === 'ecg' || billType === 'ghana_water') && !/^0\d{9}$/.test(requestedPhone)) {
        return json({ error: 'A valid Ghana phone number linked to the account is required.' }, 400);
      }
      if (billType === 'ecg' || billType === 'ghana_water') phone = requestedPhone;

      if (!accountNumber || !amount || amount <= 0) {
        return json({ error: 'Valid account/meter number and positive amount are required.' }, 400);
      }

      const clientRef = `ADM-UTL-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;

      // Insert pending utility order
      const { data: orderRow, error: insertErr } = await admin
        .from('utility_orders')
        .insert({
          bill_type: billType,
          bill_category: billCategory,
          account_number: accountNumber,
          meter_type: meterType,
          package_name: packageName || null,
          customer_name: customerName,
          customer_phone: phone,
          customer_email: 'admin@skaitech.com',
          amount,
          fee_amount: 0,
          gross_amount: amount,
          payment_reference: clientRef,
          status: 'processing',
          agent_id: caller.id,
        })
        .select('id')
        .single();

      if (insertErr || !orderRow) {
        return json({ error: insertErr?.message || 'Failed to create utility order.' }, 400);
      }

      try {
        // ECG keys meters by phone and Ghana Water needs the session id minted
        // by its meter query, so the account is queried before the top-up.
        const accountCheck = await callUtilityProvider('verify', {
          service: billType,
          accountNumber,
          meterType,
          customerPhone: phone,
        });
        if (!accountCheck.success || !accountCheck.verified) {
          throw new Error(accountCheck.message || 'The utility provider could not verify this account.');
        }

        const payResult = await callUtilityProvider('purchase', {
          service: billType,
          accountNumber,
          meterType,
          amount,
          reference: clientRef,
          customerPhone: phone,
          customerEmail: 'admin@skaitech.com',
          sessionId: accountCheck.sessionId,
        });

        await admin
          .from('utility_orders')
          .update({
            status: payResult.status,
            token_code: payResult.token || null,
            provider_reference: payResult.providerReference || null,
            provider_response: (payResult.raw as Record<string, unknown>) || null,
            completed_at: payResult.status === 'completed' ? new Date().toISOString() : null,
          })
          .eq('id', orderRow.id);

        return json({
          success: payResult.success,
          pending: payResult.pending,
          status: payResult.status,
          token: payResult.token,
          providerReference: payResult.providerReference,
          message: payResult.message,
        });
      } catch (e: unknown) {
        const err = e as Error;
        await admin
          .from('utility_orders')
          .update({ status: 'failed', provider_response: { error: err.message } })
          .eq('id', orderRow.id);

        return json({ success: false, status: 'failed', message: err.message });
      }
    }

    // ACTION: RETRY UTILITY ORDER
    if (action === 'retry-utility-order') {
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return json({ error: 'orderId is required' }, 400);

      const { data: order, error: fetchErr } = await admin
        .from('utility_orders')
        .select('*')
        .eq('id', orderId)
        .single();

      if (fetchErr || !order) return json({ error: 'Utility order not found.' }, 404);

      const service = String(order.bill_type || 'ecg').trim().toLowerCase();
      const accountCheck = await callUtilityProvider('verify', {
        service,
        accountNumber: order.account_number,
        meterType: order.meter_type,
        customerPhone: order.customer_phone,
        customerEmail: order.customer_email,
        reference: `VRF-${Date.now()}`,
      });
      if (!accountCheck.success || !accountCheck.verified) {
        return json({ success: false, status: 'failed', message: accountCheck.message || 'The utility provider could not verify this account.' }, 422);
      }

      const payResult = await callUtilityProvider('purchase', {
        service,
        accountNumber: order.account_number,
        meterType: order.meter_type,
        amount: Number(order.amount),
        reference: order.payment_reference,
        customerPhone: order.customer_phone,
        customerEmail: order.customer_email,
        sessionId: accountCheck.sessionId,
      });

      await admin
        .from('utility_orders')
        .update({
          status: payResult.status,
          token_code: payResult.token || order.token_code,
          provider_reference: payResult.providerReference || order.provider_reference,
          provider_response: (payResult.raw as Record<string, unknown>) || order.provider_response,
          completed_at: payResult.status === 'completed' ? new Date().toISOString() : order.completed_at,
        })
        .eq('id', orderId);

      return json({
        success: payResult.success,
        pending: payResult.pending,
        status: payResult.status,
        token: payResult.token,
        message: payResult.message,
      });
    }

    // ACTION: RETRY DATA ORDER
    if (action === 'retry-data-order') {
      const orderId = String(body.orderId || '').trim();
      const orderType = String(body.orderType || '').trim();

      if (!orderId) return json({ error: 'orderId is required' }, 400);

      if (orderType.includes('Public')) {
        await admin
          .from('public_data_orders')
          .update({ status: 'processing' })
          .eq('id', orderId);
      } else if (orderType.includes('Agent')) {
        await admin
          .from('agent_data_orders')
          .update({ status: 'processing' })
          .eq('id', orderId);
      } else {
        return json({ error: 'Only Standard Data orders can be retried.' }, 400);
      }

      return json({ success: true, message: 'Order marked for reprocessing.' });
    }

    // ACTION: TOGGLE AGENT STORE STATUS (OPEN / PAUSE)
    if (action === 'toggle-store-status') {
      const storeId = String(body.storeId || '').trim();
      const isActive = Boolean(body.isActive);
      const reason = String(body.reason || (isActive ? '' : 'Paused by Admin')).trim();

      if (!storeId) return json({ error: 'storeId is required' }, 400);

      const { error } = await admin
        .from('agent_stores')
        .update({
          is_active: isActive,
          suspended_reason: isActive ? null : reason,
          updated_at: new Date().toISOString(),
        })
        .eq('id', storeId);

      if (error) throw error;
      return json({ success: true, storeId, isActive });
    }

    // ACTION: SET AGENT COMMISSION RATES
    if (action === 'update-commission-rates') {
      const serviceName = String(body.serviceName || '').trim();
      const commissionPercent = Number(body.commissionPercent);
      const requestedAgentShare = body.agentSharePercent ?? body.merchantShare;
      const merchantShare = Number(requestedAgentShare ?? 0);
      const requestedPlatformShare = body.platformSharePercent ?? body.hubtelShare;
      const hubtelShare = Number(requestedPlatformShare ?? (100 - merchantShare));

      if (!serviceName) return json({ error: 'serviceName is required' }, 400);
      if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
        return json({ error: 'Commission rate must be between 0 and 100 percent.' }, 400);
      }
      if (!Number.isFinite(merchantShare) || merchantShare < 0 || merchantShare > 100) {
        return json({ error: 'Agent share must be between 0 and 100 percent.' }, 400);
      }
      if (!Number.isFinite(hubtelShare) || hubtelShare < 0 || hubtelShare > 100) {
        return json({ error: 'Platform share must be between 0 and 100 percent.' }, 400);
      }

      const { data: updatedRate, error } = await admin
        .from('service_commission_rates')
        .upsert({
          service: serviceName,
          label: serviceName,
          commission_percent: commissionPercent,
          agent_share_percent: merchantShare,
          merchant_share_percent: merchantShare,
          hubtel_share_percent: hubtelShare,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'service' })
        .select('service, commission_percent, agent_share_percent, merchant_share_percent, hubtel_share_percent, updated_at')
        .single();

      if (error) throw error;
      return json({
        success: true,
        serviceName: updatedRate.service,
        commissionPercent: Number(updatedRate.commission_percent),
        agentSharePercent: Number(updatedRate.agent_share_percent ?? updatedRate.merchant_share_percent ?? merchantShare),
        platformSharePercent: Number(updatedRate.hubtel_share_percent ?? hubtelShare),
        updatedAt: updatedRate.updated_at,
      });
    }

    // ACTION: ADJUST WALLET (CREDIT / DEBIT)
    if (action === 'adjust-wallet') {
      const userId = String(body.userId || '').trim();
      const amount = Number(body.amount);
      const type = String(body.type || '').trim().toLowerCase();
      const reason = String(body.reason || 'Admin manual balance adjustment').trim();

      if (!userId || !amount || amount <= 0 || !['credit', 'debit'].includes(type)) {
        return json({ error: 'Valid userId, positive amount, and type (credit/debit) are required.' }, 400);
      }

      const { data, error } = await admin.rpc('admin_adjust_wallet', {
        p_user_id: userId,
        p_amount: amount,
        p_type: type,
        p_reason: reason,
        p_admin_id: caller.id,
      });

      if (error) return json({ error: error.message }, 400);
      return json({ success: true, data });
    }

    // ACTION: REFUND AGENT WALLET (explicit, auditable credit)
    if (action === 'refund-agent') {
      const agentId = String(body.agentId || body.userId || '').trim();
      const amount = Number(body.amount);
      const reason = String(body.reason || '').trim();

      if (!agentId || !Number.isFinite(amount) || amount <= 0 || !reason) {
        return json({ error: 'Valid agentId, positive amount, and refund reason are required.' }, 400);
      }

      const { data, error } = await admin.rpc('admin_refund_agent_wallet', {
        p_agent_id: agentId,
        p_amount: Math.round(amount * 100) / 100,
        p_reason: reason,
        p_admin_id: caller.id,
      });
      if (error) return json({ error: error.message }, 400);
      return json({ success: true, data });
    }

    // ACTION: SYNC ORDER STATUS WITH PROVIDER (SWIFT / GRANDTECH)
    if (action === 'sync-order-status') {
      // Wrap the entire sync action in its own try/catch so that any provider
      // error (missing API key, network timeout, unexpected payload) is caught
      // here and returned as HTTP 200 with success:false rather than bubbling
      // up to the outer catch which would emit an HTTP 500 and cause the
      // Supabase client to surface "Edge Function returned a non-2xx status code".
      try {
        const orderType = String(body.orderType || 'data').trim().toLowerCase();
        const orderId = String(body.orderId || '').trim();
        if (!orderId) return json({ error: 'Order ID is required', success: false }, 400);

        if (orderType === 'data' || orderType === 'agent_data_orders') {
          // Use individual eq filters instead of .or() to avoid PostgREST
          // injection issues when orderId contains special characters.
          let order: Record<string, unknown> | null = null;
          let fetchErr: unknown = null;

          // Try by UUID id first, then by provider_reference, then by short_code
          const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (uuidPattern.test(orderId)) {
            const res = await admin
              .from('agent_data_orders')
              .select('id, agent_id, provider_name, provider_order_id, provider_reference, network_type, volume_mb, status, amount, provider_response')
              .eq('id', orderId)
              .maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = res.error;
          }
          if (!order && !fetchErr) {
            const res = await admin
              .from('agent_data_orders')
              .select('id, agent_id, provider_name, provider_order_id, provider_reference, network_type, volume_mb, status, amount, provider_response')
              .eq('provider_reference', orderId)
              .maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = fetchErr || res.error;
          }
          if (!order && !fetchErr) {
            const res = await admin
              .from('agent_data_orders')
              .select('id, agent_id, provider_name, provider_order_id, provider_reference, network_type, volume_mb, status, amount, provider_response')
              .eq('short_code', orderId)
              .maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = fetchErr || res.error;
          }

          if (fetchErr) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String((fetchErr as { message?: string }).message || fetchErr);
            return json({ success: false, error: `Database lookup failed: ${msg}` });
          }
          if (!order) return json({ success: false, error: 'Data order not found' }, 404);

          const providerName = String(order.provider_name || activeDataProvider(
            order.network_type as string,
            Number(order.volume_mb),
          ));
          const storedProviderResponse = (order.provider_response && typeof order.provider_response === 'object')
            ? order.provider_response as Record<string, unknown>
            : {};
          const providerOrderId = String(
            order.provider_order_id || storedProviderResponse.providerOrderId ||
            storedProviderResponse.providerReference || '',
          );
          const ref = String(order.provider_reference || '');

          // Fetch live status – catch any error (missing API key, network
          // failure) and return a graceful 200 rather than propagating a 500.
          let live: { state: string; status: string; payload?: Record<string, unknown> } | null = null;
          let providerError: string | null = null;
          try {
            live = await fetchLiveOrderStatus(providerName, providerOrderId, ref);
          } catch (provErr) {
            providerError = provErr instanceof Error ? provErr.message : String(provErr);
            console.error('Provider status fetch error:', providerError);
          }

          if (!live) {
            return json({
              success: false,
              message: providerError
                ? `Provider (${providerName}) API error: ${providerError}`
                : `Provider (${providerName}) did not return a definitive status. Order remains in current state.`,
              status: order.status,
              provider: providerName,
              providerError,
            });
          }

          const stored = (order.provider_response && typeof order.provider_response === 'object')
            ? order.provider_response as Record<string, unknown>
            : {};
          const updatedResponse = {
            ...stored,
            lastProviderStatus: live.status,
            livePayload: live.payload || null,
            syncedAt: new Date().toISOString(),
          };

          // Map provider states to our internal status values
          // DELIVERED/SUCCESSFUL/SUCCESS → successful
          // PENDING/PROCESSING → processing (no change)
          // FAILED → failed
          const terminalState = live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled';
          if (terminalState) {
            const { data: settledState, error: settleError } = await admin.rpc('settle_agent_data_order', {
              p_order_id: order.id,
              p_status: live.state,
              p_provider_response: updatedResponse,
            });
            if (settleError) throw settleError;
            await recordProviderStatus(admin, {
              orderType: 'agent_data_orders',
              orderId: String(order.id),
              agentId: String(order.agent_id || ''),
              provider: providerName,
              providerStatus: live.status,
              internalStatus: String(settledState || live.state),
              payload: live.payload,
            });
          } else {
            // Still processing – update the response timestamp so we know the check ran
            const { error: updateError } = await admin.from('agent_data_orders').update({
              provider_response: updatedResponse,
            }).eq('id', order.id);
            if (updateError) throw updateError;
            await recordProviderStatus(admin, {
              orderType: 'agent_data_orders',
              orderId: String(order.id),
              agentId: String(order.agent_id || ''),
              provider: providerName,
              providerStatus: live.status,
              internalStatus: String(order.status || 'processing'),
              payload: live.payload,
            });
          }

          return json({
            success: true,
            provider: providerName,
            providerStatus: live.status,
            orderState: live.state,
            message: `Synchronized with ${providerName}: Status is ${live.status} (${live.state})`,
          });
        }

        if (orderType === 'public_data' || orderType === 'public_data_orders') {
          let order: Record<string, unknown> | null = null;
          let fetchErr: unknown = null;
          const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          const select = 'id, agent_id, payment_reference, network_type, volume_mb, sale_amount, status, provider_response';

          if (uuidPattern.test(orderId)) {
            const res = await admin.from('public_data_orders').select(select).eq('id', orderId).maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = res.error;
          }
          if (!order && !fetchErr) {
            const res = await admin.from('public_data_orders').select(select).eq('payment_reference', orderId).maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = res.error;
          }
          if (!order && !fetchErr) {
            const res = await admin.from('public_data_orders').select(select).eq('short_code', orderId).maybeSingle();
            order = res.data as Record<string, unknown> | null;
            fetchErr = res.error;
          }

          if (fetchErr) throw fetchErr;
          if (!order) return json({ success: false, error: 'Public data order not found' }, 404);

          const stored = (order.provider_response && typeof order.provider_response === 'object')
            ? order.provider_response as Record<string, unknown>
            : {};
          const provider = String(stored.provider || activeDataProvider(
            order.network_type as string,
            Number(order.volume_mb),
          ));
          const providerOrderId = String(stored.providerOrderId || stored.orderId || stored.provider_order_id || '');
          const ref = String(order.payment_reference || '');
          const live = await fetchLiveOrderStatus(provider, providerOrderId, ref);
          if (!live) {
            return json({
              success: false,
              message: `Provider (${provider}) did not return a definitive status. Order remains in current state.`,
              status: order.status,
              provider,
            });
          }

          const updatedResponse = {
            ...stored,
            lastProviderStatus: live.status,
            livePayload: live.payload || null,
            syncedAt: new Date().toISOString(),
          };
          const nextStatus = live.state === 'successful'
            ? 'successful'
            : live.state === 'failed' || live.state === 'cancelled'
              ? 'failed'
              : String(order.status || 'processing');
          const isOpen = ['pending_payment', 'processing'].includes(String(order.status));

          if (nextStatus === 'failed' && isOpen && order.agent_id) {
            const { error: refundError } = await admin.rpc('refund_agent_wallet', {
              p_agent_id: order.agent_id,
              p_debit_reference: ref,
              p_amount: order.sale_amount,
              p_reason: `Refund: Public data order failed with provider (${live.status})`,
            });
            if (refundError) throw refundError;
          }

          const { error: updateError } = await admin.from('public_data_orders').update({
            status: nextStatus,
            provider_response: updatedResponse,
            completed_at: nextStatus === 'successful' || nextStatus === 'failed' ? new Date().toISOString() : null,
          }).eq('id', order.id).in('status', ['pending_payment', 'processing']);
          if (updateError) throw updateError;

          await recordProviderStatus(admin, {
            orderType: 'public_data_orders',
            orderId: String(order.id),
            agentId: String(order.agent_id || ''),
            provider,
            providerStatus: live.status,
            internalStatus: nextStatus,
            payload: live.payload,
          });

          return json({
            success: true,
            provider,
            providerStatus: live.status,
            orderState: nextStatus,
            message: `Public data synchronized with ${provider}: ${live.status}`,
          });
        }

        return json({ success: false, error: `Unsupported sync order type: ${orderType}` }, 400);
      } catch (syncErr: unknown) {
        // Catch any unexpected error from within the sync block and return
        // HTTP 200 with success:false so the Supabase client does not surface
        // "Edge Function returned a non-2xx status code" to the frontend.
        const errMsg = syncErr instanceof Error ? syncErr.message : String(syncErr);
        console.error('sync-order-status unexpected error:', errMsg);
        return json({
          success: false,
          error: errMsg,
          message: `Provider sync failed: ${errMsg}`,
        });
      }
    }

    // ACTION: CANCEL ORDER (Pending/Processing across services)
    if (action === 'cancel-order') {
      const orderType = String(body.orderType || '').trim();
      const orderId = String(body.orderId || '').trim();
      const reason = String(body.reason || 'Cancelled by Admin').trim();

      if (!orderType || !orderId) {
        return json({ error: 'orderType and orderId are required.' }, 400);
      }

      const { data, error } = orderType === 'public_data' || orderType === 'public_data_orders'
        ? await admin.rpc('admin_cancel_public_data_order', {
          p_order_id: orderId,
          p_reason: reason,
          p_admin_id: caller.id,
        })
        : await admin.rpc('admin_cancel_order', {
          p_order_type: orderType,
          p_order_id: orderId,
          p_reason: reason,
          p_admin_id: caller.id,
        });

      if (error) return json({ error: error.message }, 400);
      return json({ success: true, ...data });
    }

    // ACTION: MANAGE AGENT (Cancel, Suspend, Reactivate)
    if (action === 'manage-agent') {
      const agentId = String(body.agentId || '').trim();
      const status = String(body.status || 'active').trim().toLowerCase();
      const reason = String(body.reason || '').trim();

      if (!agentId || !['active', 'suspended', 'cancelled'].includes(status)) {
        return json({ error: 'Valid agentId and status (active, suspended, cancelled) are required.' }, 400);
      }

      const { data, error } = await admin.rpc('admin_manage_agent', {
        p_agent_id: agentId,
        p_status: status,
        p_reason: reason,
      });

      if (error) return json({ error: error.message }, 400);
      return json({ success: true, ...data });
    }

    // ACTION: DECIDE COMMISSION PAYOUT (Approve & Mark Paid / Reject & Refund / Mark Processing)
    if (action === 'decide-payout') {
      const payoutId = String(body.payoutId || '').trim();
      const decision = String(body.decision || '').trim().toLowerCase();
      const note = String(body.note || '').trim();

      if (!payoutId || !['paid', 'processing', 'rejected'].includes(decision)) {
        return json({ error: 'Valid payoutId and decision (paid, processing, rejected) are required.' }, 400);
      }

      const { data, error } = await admin.rpc('admin_decide_payout', {
        p_payout_id: payoutId,
        p_decision: decision,
        p_note: note,
      });

      if (error) return json({ error: error.message }, 400);
      return json({ success: true, ...data });
    }

    // ACTION: LOAD RESULT CHECKER STOCK AND ORDERS
    if (action === 'load-result-checkers') {
      const [pinsRes, ordersRes] = await Promise.all([
        admin
          .from('result_checker_pins')
          .select('id, exam_type, pin, serial, status, result_order_id, created_at, sold_at')
          .order('created_at', { ascending: false })
          .limit(500),
        admin
          .from('results_orders')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      if (pinsRes.error) throw pinsRes.error;
      if (ordersRes.error) throw ordersRes.error;
      return json({ success: true, pins: pinsRes.data || [], orders: ordersRes.data || [] });
    }

    // ACTION: DELETE AN AVAILABLE RESULT CHECKER PIN
    if (action === 'delete-result-checker-pin') {
      const pinId = String(body.pinId || '').trim();
      if (!pinId) return json({ error: 'pinId is required.' }, 400);

      const { data, error } = await admin
        .from('result_checker_pins')
        .delete()
        .eq('id', pinId)
        .eq('status', 'available')
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: 'Only an available PIN can be removed.' }, 404);
      return json({ success: true, pinId });
    }

    // ACTION: UPLOAD RESULT CHECKER PINS
    if (action === 'upload-result-checkers') {
      const examType = normalizeCheckerExamType(body.examType);
      const rawPins = body.pins;

      if (!examType || !Array.isArray(rawPins) || !rawPins.length) {
        return json({ error: 'A valid exam type (BECE or WASSCE / NOV/DEC) and array of PINs are required.' }, 400);
      }

      const rows = (rawPins as Array<unknown>).slice(0, 5000).map((item) => {
        if (typeof item === 'string') {
          const parts = item.split(/[,;\t]/).map(s => s.trim());
          return { exam_type: examType, pin: parts[0] || '', serial: parts[1] || null };
        }
        const obj = item as { pin?: string; serial?: string };
        return {
          exam_type: examType,
          pin: String(obj.pin || '').trim(),
          serial: String(obj.serial || '').trim() || null,
        };
      }).filter((item) => item.pin.length > 0);

      if (!rows.length) return json({ error: 'No valid PINs provided.' }, 400);

      const { data, error } = await admin
        .from('result_checker_pins')
        .upsert(rows, { onConflict: 'exam_type,pin', ignoreDuplicates: true })
        .select('id');

      if (error) throw error;
      const added = data?.length || 0;
      const skipped = rows.length - added;

      return json({ success: true, examType, added, skipped, totalProcessed: rows.length });
    }

    // ACTION: LOAD AFA REGISTRATIONS AND LIVE FEE
    if (action === 'load-afa-registrations') {
      const [registrationsRes, pricingRes] = await Promise.all([
        admin
          .from('afa_registrations')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(500),
        admin
          .from('service_pricing')
          .select('price')
          .eq('service', 'afa')
          .maybeSingle(),
      ]);

      if (registrationsRes.error) throw registrationsRes.error;
      if (pricingRes.error) throw pricingRes.error;
      return json({
        success: true,
        registrations: registrationsRes.data || [],
        fee: Number(pricingRes.data?.price ?? 11),
      });
    }

    // ACTION: UPDATE AFA REGISTRATION FEE
    if (action === 'update-afa-fee') {
      const fee = Number(body.fee);
      if (!Number.isFinite(fee) || fee <= 0) {
        return json({ error: 'A positive fee amount is required.' }, 400);
      }

      const { data, error } = await admin
        .from('service_pricing')
        .upsert({ service: 'afa', price: fee, label: 'AFA Registration Fee' }, { onConflict: 'service' })
        .select('service, price, label, updated_at')
        .single();

      if (error) throw error;
      return json({ success: true, fee: Number(data.price), pricing: data });
    }

    return json({ error: `Unknown action or section` }, 400);
  } catch (err: unknown) {
    const error = err as Error;
    const message = error.message || 'Server error occurred in admin-portal-api.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /administrator access|super admin access/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
