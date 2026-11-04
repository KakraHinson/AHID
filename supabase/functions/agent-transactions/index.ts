import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

const NETWORK_LABELS: Record<string, string> = {
  mtn: 'MTN',
  telecel: 'Telecel',
  at: 'AT (AirtelTigo)',
};

const BILL_LABELS: Record<string, string> = {
  ecg: 'ECG Prepaid',
  ecg_postpaid: 'ECG Postpaid',
  ghana_water: 'Ghana Water',
  dstv: 'DStv',
  gotv: 'GOtv',
  startimes: 'StarTimes',
};

function maskPhone(phone: string): string {
  const clean = String(phone ?? '').replace(/\D/g, '');
  if (!clean) return '';
  if (clean.length <= 6) return clean.length <= 2 ? clean : clean.slice(0, 1) + '*'.repeat(Math.max(1, clean.length - 2)) + clean.slice(-1);
  return clean.slice(0, 3) + '*'.repeat(clean.length - 7) + clean.slice(-4);
}

function maskAccount(account: string): string {
  const s = String(account ?? '');
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-4);
}

function airtimeStatusLabel(order: { payment_status: string; airtime_status: string }): string {
  if (order.airtime_status === 'delivered') return 'Completed';
  if (order.airtime_status === 'failed' || order.payment_status === 'failed') return 'Failed';
  return 'Pending';
}

function utilityStatusLabel(status: string): string {
  if (status === 'completed' || status === 'paid') return 'Completed';
  if (status === 'failed') return 'Failed';
  return 'Pending';
}

function providerStatus(response: unknown, fallback: string): string {
  const payload = response && typeof response === 'object' ? response as Record<string, unknown> : {};
  const value = payload.lastProviderStatus ?? payload.providerStatus ?? payload.status;
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || fallback;
}

async function fetchAllRows(queryFactory: (from: number, to: number) => any, pageSize = 1000): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // Server-side agent verification + scoping. Any id sent from the client is
    // ignored: we always scope to the authenticated user.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    const [airtimeOrders, utilityOrders] = await Promise.all([
      fetchAllRows((from, to) => admin
        .from('airtime_orders')
        .select('id, payment_reference, recipient_phone, network, amount, fee_amount, gross_amount, payment_method, payment_status, airtime_status, provider_reference, short_code, provider_response, failure_reason, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .range(from, to)),
      fetchAllRows((from, to) => admin
        .from('utility_orders')
        .select('id, bill_type, bill_category, account_number, package_name, amount, fee_amount, gross_amount, customer_name, customer_phone, payment_reference, status, token_code, provider_reference, short_code, provider_response, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .range(from, to)),
    ]);

    const airtime = airtimeOrders.map((o) => {
      const statusLabel = airtimeStatusLabel(o);
      const details =
        `${o.payment_method === 'wallet' ? 'Wallet' : 'Paystack'} • GHS ${Number(o.amount).toFixed(2)}`;
      return {
        type: 'airtime',
        id: o.id,
        reference: o.payment_reference,
        shortCode: o.short_code,
        network: o.network,
        networkLabel: NETWORK_LABELS[o.network] || String(o.network).toUpperCase(),
        phone: o.recipient_phone,
        phoneMasked: maskPhone(o.recipient_phone),
        amount: Number(o.amount),
        feeAmount: Number(o.fee_amount ?? 0),
        grossAmount: Number(o.gross_amount ?? o.amount),
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        status: o.airtime_status,
        statusLabel,
        providerStatus: providerStatus(o.provider_response, statusLabel),
        details,
        providerReference: o.provider_reference,
        failureReason: o.failure_reason,
        createdAt: o.created_at,
      };
    });

    const utility = utilityOrders.map((o) => {
      const statusLabel = utilityStatusLabel(o.status);
      const isEcg = o.bill_type === 'ecg';
      const packageName = o.package_name ? ` • ${o.package_name}` : '';
      const details = `GHS ${Number(o.amount).toFixed(2)}${packageName}`;

      return {
        type: 'utility',
        id: o.id,
        reference: o.payment_reference,
        shortCode: o.short_code,
        billType: o.bill_type,
        billLabel: BILL_LABELS[o.bill_type] || o.bill_type,
        billCategory: o.bill_category,
        accountNumber: o.account_number,
        accountMasked: maskAccount(o.account_number),
        packageName: o.package_name,
        customerName: o.customer_name,
        customerPhone: o.customer_phone,
        phone: o.customer_phone,
        phoneMasked: maskPhone(o.customer_phone),
        amount: Number(o.amount),
        feeAmount: Number(o.fee_amount ?? 0),
        grossAmount: Number(o.gross_amount ?? o.amount),
        status: o.status,
        statusLabel,
        providerStatus: providerStatus(o.provider_response, statusLabel),
        details,
        tokenCode: isEcg ? (o.token_code || null) : null,
        providerReference: o.provider_reference,
        createdAt: o.created_at,
      };
    });

    return json({
      success: true,
      airtime,
      utility,
    });
  } catch (error) {
    console.error('agent-transactions error:', error);
    const message = error instanceof Error ? error.message : 'Unable to load transactions.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
