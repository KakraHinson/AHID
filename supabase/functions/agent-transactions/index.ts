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

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // Server-side agent verification + scoping. Any id sent from the client is
    // ignored: we always scope to the authenticated user.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;

    const [airtimeRes, utilityRes] = await Promise.all([
      admin
        .from('airtime_orders')
        .select('id, payment_reference, recipient_phone, network, amount, fee_amount, gross_amount, payment_method, payment_status, airtime_status, provider_reference, short_code, failure_reason, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(200),
      admin
        .from('utility_orders')
        .select('id, bill_type, bill_category, account_number, package_name, amount, fee_amount, gross_amount, customer_name, customer_phone, payment_reference, status, token_code, provider_reference, short_code, created_at')
        .eq('agent_id', agentId)
        .order('created_at', { ascending: false })
        .limit(200),
    ]);

    if (airtimeRes.error) console.error('agent-transactions airtime error:', airtimeRes.error);
    if (utilityRes.error) console.error('agent-transactions utility error:', utilityRes.error);

    const airtimeOrders = (airtimeRes.data ?? []).map((o) => {
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
        details,
        providerReference: o.provider_reference,
        failureReason: o.failure_reason,
        createdAt: o.created_at,
      };
    });

    const utilityOrders = (utilityRes.data ?? []).map((o) => {
      const statusLabel = utilityStatusLabel(o.status);
      const label = BILL_LABELS[o.bill_type] || String(o.bill_type).toUpperCase();
      const account = maskAccount(o.account_number);
      const details =
        `${label}${o.package_name ? ` • ${o.package_name}` : ''} • Acct ${account}`;
      return {
        type: 'utility',
        id: o.id,
        reference: o.payment_reference,
        shortCode: o.short_code,
        billType: o.bill_type,
        billLabel: label,
        account: o.account_number,
        accountMasked: account,
        packageName: o.package_name,
        customerName: o.customer_name,
        phone: o.customer_phone,
        phoneMasked: maskPhone(o.customer_phone),
        amount: Number(o.amount),
        feeAmount: Number(o.fee_amount ?? 0),
        grossAmount: Number(o.gross_amount ?? o.amount),
        status: o.status,
        statusLabel,
        details,
        tokenCode: o.token_code,
        providerReference: o.provider_reference,
        createdAt: o.created_at,
      };
    });

    const all = [...airtimeOrders, ...utilityOrders];
    let successful = 0;
    let failed = 0;
    let pending = 0;
    all.forEach((t) => {
      if (t.statusLabel === 'Completed') successful += 1;
      else if (t.statusLabel === 'Failed') failed += 1;
      else pending += 1;
    });

    const summary = {
      airtimeTransactions: airtimeOrders.length,
      utilityTransactions: utilityOrders.length,
      successful,
      failed,
      pending,
      airtimeGhs: Math.round(airtimeOrders.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
      utilityGhs: Math.round(utilityOrders.reduce((sum, o) => sum + o.amount, 0) * 100) / 100,
    };

    return json({
      success: true,
      agent: { id: user.id, email: user.email },
      airtime: airtimeOrders,
      utility: utilityOrders,
      summary,
    });
  } catch (err) {
    console.error('agent-transactions error:', err);
    const message = err instanceof Error ? err.message : 'Unable to load transactions.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({ error: message }, status);
  }
});