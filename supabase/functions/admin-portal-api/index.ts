import { corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';
import { dispatchAirtimeTopup } from '../_shared/airtimeProvider.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import { hubtelRequest } from '../_shared/hubtelClient.ts';
import { activeDataProvider, fetchDataOrderStatus } from '../_shared/dataProvider.ts';

// Commission Services path segment: the DISBURSEMENT (prepaid deposit) account.
// Distinct from the merchant/collection account used to receive money.
const DISBURSEMENT_ACCOUNT = Deno.env.get('HUBTEL_DISBURSEMENT_ACCOUNT')?.trim() || '';
const ECG_SERVICE_ID = 'e6d6bac062b5499cb1ece1ac3d742a84';

// Helper to query the Hubtel live balance for the disbursement account
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
    const { admin, user: caller, role } = await requireAdmin(request);
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
            instant_data: 0,
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

      // 2. DATA BUNDLES & INSTANT DATA
      if (section === 'data-management') {
        const [instantOrdersRes, agentOrdersRes, publicOrdersRes, bundlesRes, catalogRes] = await Promise.all([
          admin
            .from('data_transactions')
            .select('id, reference, short_code, recipient_phone, amount, status, failure_reason, created_at, network_id, bundle_key')
            .order('created_at', { ascending: false })
            .limit(100),
          admin
            .from('agent_data_orders')
            .select('id, provider_reference, phone, network_type, volume_mb, amount, status, created_at')
            .order('created_at', { ascending: false })
            .limit(100),
          admin
            .from('public_data_orders')
            .select('id, payment_reference, customer_phone, customer_name, network_type, volume_mb, sale_amount, status, created_at')
            .order('created_at', { ascending: false })
            .limit(100),
          admin
            .from('bundles')
            .select('id, bundle_key, network_id, title, data_amount, volume_mb, price, provider_cost, is_available, unavailable_reason, category')
            .order('network_id')
            .order('volume_mb'),
          admin
            .from('bundle_catalog')
            .select('bundle_id, network, title, volume_mb, price, provider_cost, active, inactive_reason')
            .order('network')
            .order('volume_mb'),
        ]);

        const instantOrders = (instantOrdersRes.data || []).map((o) => ({
          id: o.id,
          reference: o.reference,
          shortCode: o.short_code,
          phone: o.recipient_phone,
          network: o.network_id,
          amount: Number(o.amount || 0),
          status: o.status,
          failureReason: o.failure_reason,
          createdAt: o.created_at,
          type: 'Instant Data',
          details: o.bundle_key || '',
        }));

        const agentOrders = (agentOrdersRes.data || []).map((o) => ({
          id: o.id,
          reference: o.provider_reference,
          shortCode: '',
          phone: o.phone,
          network: o.network_type,
          amount: Number(o.amount || 0),
          status: o.status,
          failureReason: '',
          createdAt: o.created_at,
          type: 'Standard Bundle (Agent)',
          details: `${o.volume_mb}MB`,
        }));

        const publicOrders = (publicOrdersRes.data || []).map((o) => ({
          id: o.id,
          reference: o.payment_reference,
          shortCode: '',
          phone: o.customer_phone,
          network: o.network_type,
          amount: Number(o.sale_amount || 0),
          status: o.status,
          failureReason: '',
          createdAt: o.created_at,
          type: 'Standard Bundle (Public)',
          details: `${o.volume_mb}MB (${o.customer_name || 'Customer'})`,
        }));

        const orders = [...instantOrders, ...agentOrders, ...publicOrders].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );

        return json({
          success: true,
          orders,
          bundles: bundlesRes.data || [],
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
            .select('id, store_id, agent_id, reference, short_code, product_type, product_name, sale_amount, agent_earning, platform_revenue, payment_status, fulfilment_status, customer_name, customer_phone, created_at')
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
              u.fullName.toLowerCase().includes(query) ||
              u.phone.toLowerCase().includes(query) ||
              u.agentCode.toLowerCase().includes(query) ||
              u.id.toLowerCase().includes(query)
          );
        }

        return json({ success: true, wallets: list });
      }

      // 7. WALLET HISTORY FOR SPECIFIC USER
      if (section === 'wallet-history') {
        const userId = String(body.userId || url.searchParams.get('userId') || '');
        if (!userId) return json({ error: 'userId is required' }, 400);

        const [topupsRes, cashoutsRes, txRes] = await Promise.all([
          admin
            .from('wallet_topups')
            .select('id, amount, payment_reference, status, provider, created_at, paid_at')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .limit(50),
          admin
            .from('cashout_deposit_requests')
            .select('id, amount, status, admin_notes, created_at, processed_at')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .limit(50),
          admin
            .from('transactions')
            .select('id, type, amount, balance_before, balance_after, description, status, created_at, metadata')
            .eq('agent_id', userId)
            .order('created_at', { ascending: false })
            .limit(50),
        ]);

        return json({
          success: true,
          topups: topupsRes.data || [],
          cashouts: cashoutsRes.data || [],
          transactions: txRes.data || [],
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

      if (catalogType === 'bundle_catalog') {
        const { error } = await admin
          .from('bundle_catalog')
          .update({ active: isAvailable, inactive_reason: isAvailable ? null : 'Toggled by admin' })
          .eq('bundle_id', bundleId);
        if (error) throw error;
      } else {
        const { error } = await admin
          .from('bundles')
          .update({ is_available: isAvailable, unavailable_reason: isAvailable ? null : 'Toggled by admin' })
          .eq('id', bundleId);
        if (error) throw error;
      }

      return json({ success: true, bundleId, isAvailable });
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
      const accountNumber = String(body.accountNumber || '').trim();
      const rawService = String(body.service || 'ecg_prepaid').trim().toLowerCase();
      const service = rawService.startsWith('ecg') ? 'ecg' : rawService;

      if (!accountNumber) return json({ error: 'Account/meter number is required.' }, 400);

      try {
        const verifyResult = await callUtilityProvider('verify', {
          service,
          accountNumber,
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
      const accountNumber = String(body.accountNumber || '').trim();
      const amount = Number(body.amount);
      const customerName = String(body.customerName || 'Customer').trim();
      const packageName = String(body.packageName || '').trim();
      const phone = String(body.phone || '0500000000').trim();

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
        const payResult = await callUtilityProvider('purchase', {
          service: billType,
          accountNumber,
          amount,
          reference: clientRef,
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

      const payResult = await callUtilityProvider('purchase', {
        service: order.bill_type || 'ecg',
        accountNumber: order.account_number,
        amount: Number(order.amount),
        reference: order.payment_reference,
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
        status: payResult.status,
        token: payResult.token,
      });
    }

    // ACTION: RETRY DATA ORDER
    if (action === 'retry-data-order') {
      const orderId = String(body.orderId || '').trim();
      const orderType = String(body.orderType || '').trim();

      if (!orderId) return json({ error: 'orderId is required' }, 400);

      if (orderType === 'Instant Data') {
        await admin
          .from('data_transactions')
          .update({ status: 'pending', failure_reason: 'Admin triggered retry' })
          .eq('id', orderId);
      } else if (orderType.includes('Agent')) {
        await admin
          .from('agent_data_orders')
          .update({ status: 'processing' })
          .eq('id', orderId);
      } else {
        await admin
          .from('public_data_orders')
          .update({ status: 'processing' })
          .eq('id', orderId);
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
      const merchantShare = Number(body.merchantShare || 70);
      const hubtelShare = Number(body.hubtelShare || 30);

      if (!serviceName) return json({ error: 'serviceName is required' }, 400);

      const { error } = await admin
        .from('service_commission_rates')
        .upsert({
          service_name: serviceName,
          commission_percent: commissionPercent,
          merchant_share_percent: merchantShare,
          hubtel_share_percent: hubtelShare,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'service_name' });

      if (error) throw error;
      return json({ success: true, serviceName, commissionPercent });
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

    // ACTION: SYNC ORDER STATUS WITH PROVIDER (SWIFT / GRANDTECH)
    if (action === 'sync-order-status') {
      const orderType = String(body.orderType || 'data').trim().toLowerCase();
      const orderId = String(body.orderId || '').trim();
      if (!orderId) return json({ error: 'Order ID is required' }, 400);

      if (orderType === 'data' || orderType === 'agent_data_orders') {
        const { data: order, error: fetchErr } = await admin
          .from('agent_data_orders')
          .select('id, agent_id, provider_name, provider_order_id, provider_reference, network_type, volume_mb, status, amount, provider_response')
          .or(`id.eq.${orderId},provider_reference.eq.${orderId},short_code.eq.${orderId}`)
          .maybeSingle();

        if (fetchErr) throw fetchErr;
        if (!order) return json({ error: 'Data order not found' }, 404);

        const provider = String(order.provider_name || activeDataProvider(order.network_type, Number(order.volume_mb)));
        const providerOrderId = String(order.provider_order_id || '');
        const ref = String(order.provider_reference || '');

        const live = await fetchDataOrderStatus(provider as 'grandtech' | 'swift', providerOrderId, ref).catch((err) => {
          console.error('Data status check failed:', err);
          return null;
        });

        if (!live) {
          return json({
            success: false,
            message: `Provider (${provider}) did not return a definitive status. Order remains in current state.`,
            status: order.status,
            provider,
          });
        }

        const stored = (order.provider_response && typeof order.provider_response === 'object') ? order.provider_response : {};
        const updatedResponse = {
          ...stored,
          lastProviderStatus: live.status,
          livePayload: live.payload || null,
          syncedAt: new Date().toISOString(),
        };

        if (live.state === 'successful' || live.state === 'failed' || live.state === 'cancelled') {
          await admin.from('agent_data_orders').update({
            status: live.state,
            provider_response: updatedResponse,
            completed_at: new Date().toISOString(),
          }).eq('id', order.id);

          // If failed/cancelled and previous status was not failed/cancelled, refund
          if ((live.state === 'failed' || live.state === 'cancelled') && !['failed', 'cancelled'].includes(order.status) && order.agent_id) {
            await admin.rpc('admin_adjust_wallet', {
              p_user_id: order.agent_id,
              p_amount: order.amount,
              p_type: 'credit',
              p_reason: `Refund: Order ${ref} failed with provider (${live.status})`,
              p_admin_id: caller.id,
            });
          }
        } else {
          await admin.from('agent_data_orders').update({
            provider_response: updatedResponse,
          }).eq('id', order.id);
        }

        return json({
          success: true,
          provider,
          providerStatus: live.status,
          orderState: live.state,
          message: `Synchronized with ${provider}: Status is ${live.status} (${live.state})`,
        });
      }

      if (orderType === 'instant_data' || orderType === 'data_transactions') {
        const { data: order, error: fetchErr } = await admin
          .from('data_transactions')
          .select('id, user_id, provider, reference, network_id, amount, status, metadata')
          .or(`id.eq.${orderId},reference.eq.${orderId},short_code.eq.${orderId}`)
          .maybeSingle();

        if (fetchErr) throw fetchErr;
        if (!order) return json({ error: 'Instant data transaction not found' }, 404);

        const provider = String(order.provider || 'swift');
        const ref = String(order.reference || '');

        const live = await fetchDataOrderStatus(provider as 'grandtech' | 'swift', '', ref).catch(() => null);

        if (!live) {
          return json({
            success: false,
            message: `Provider (${provider}) did not return status for ${ref}.`,
            status: order.status,
          });
        }

        const meta = (order.metadata && typeof order.metadata === 'object') ? order.metadata : {};
        const updatedMeta = {
          ...meta,
          lastProviderStatus: live.status,
          syncedAt: new Date().toISOString(),
        };

        const nextStatus = live.state === 'successful' ? 'completed' : live.state === 'failed' ? 'failed' : order.status;
        await admin.from('data_transactions').update({
          status: nextStatus,
          metadata: updatedMeta,
          updated_at: new Date().toISOString(),
        }).eq('id', order.id);

        if (nextStatus === 'failed' && order.status !== 'failed' && order.user_id) {
          await admin.rpc('admin_adjust_wallet', {
            p_user_id: order.user_id,
            p_amount: order.amount,
            p_type: 'credit',
            p_reason: `Refund: Instant data ${ref} failed with provider (${live.status})`,
            p_admin_id: caller.id,
          });
        }

        return json({
          success: true,
          provider,
          providerStatus: live.status,
          orderState: nextStatus,
          message: `Instant data synchronized with ${provider}: ${live.status}`,
        });
      }

      return json({ error: `Unsupported sync order type: ${orderType}` }, 400);
    }

    // ACTION: CANCEL ORDER (Pending/Processing across services)
    if (action === 'cancel-order') {
      const orderType = String(body.orderType || '').trim();
      const orderId = String(body.orderId || '').trim();
      const reason = String(body.reason || 'Cancelled by Admin').trim();

      if (!orderType || !orderId) {
        return json({ error: 'orderType and orderId are required.' }, 400);
      }

      const { data, error } = await admin.rpc('admin_cancel_order', {
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

    // ACTION: UPLOAD RESULT CHECKER PINS
    if (action === 'upload-result-checkers') {
      const examType = String(body.examType || '').trim().toUpperCase();
      const rawPins = body.pins;

      if (!['BECE', 'WASSCE', 'NOV/DEC'].includes(examType) || !Array.isArray(rawPins) || !rawPins.length) {
        return json({ error: 'A valid exam type (BECE, WASSCE, NOV/DEC) and array of PINs are required.' }, 400);
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

    // ACTION: UPDATE AFA REGISTRATION FEE
    if (action === 'update-afa-fee') {
      const fee = Number(body.fee);
      if (!Number.isFinite(fee) || fee <= 0) {
        return json({ error: 'A positive fee amount is required.' }, 400);
      }

      const { error } = await admin
        .from('service_pricing')
        .upsert({ service: 'afa', price: fee, description: 'AFA Registration Fee' }, { onConflict: 'service' });

      if (error) throw error;
      return json({ success: true, fee });
    }

    return json({ error: `Unknown action or section` }, 400);
  } catch (err: unknown) {
    const error = err as Error;
    return json({ error: error.message || 'Server error occurred in admin-portal-api.' }, 500);
  }
});
