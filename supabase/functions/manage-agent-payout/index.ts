import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

/**
 * Payout capture for an agent store (captured now, executed later).
 *
 * An agent saves a payout destination once, then may request a payout up to the
 * earnings that have actually settled on their store. Nothing is transferred
 * here - a request lands as `requested` for an admin to approve and settle from
 * the console, so the money movement stays a deliberate manual step.
 *
 * Available balance = settled store earnings (fulfilment `successful`, payment
 * `paid`) minus everything already requested or paid out.
 */

const round2 = (value: number) => Math.round(value * 100) / 100;

const OPEN_STATUSES = ['requested', 'approved', 'processing', 'paid'];

function text(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    const { data: account } = await admin
      .from('agent_payout_accounts')
      .select('method, account_name, account_number, bank_name, momo_network')
      .eq('agent_id', user.id)
      .maybeSingle();

    if (request.method === 'GET') {
      const [ordersRes, payoutsRes] = await Promise.all([
        admin.from('store_orders')
          .select('agent_earning')
          .eq('agent_id', user.id)
          .eq('payment_status', 'paid')
          .eq('fulfilment_status', 'successful'),
        admin.from('agent_payouts')
          .select('id, amount, status, method, reference, admin_note, requested_at, paid_at')
          .eq('agent_id', user.id)
          .order('requested_at', { ascending: false })
          .limit(100),
      ]);
      if (ordersRes.error) throw ordersRes.error;
      if (payoutsRes.error) throw payoutsRes.error;

      const settled = (ordersRes.data ?? []).reduce((sum, row) => sum + Number(row.agent_earning || 0), 0);
      const committed = (payoutsRes.data ?? [])
        .filter((row) => OPEN_STATUSES.includes(String(row.status)))
        .reduce((sum, row) => sum + Number(row.amount || 0), 0);

      return json({
        account: account ?? null,
        balance: {
          settled: round2(settled),
          committed: round2(committed),
          available: round2(Math.max(0, settled - committed)),
        },
        payouts: payoutsRes.data ?? [],
      });
    }

    if (request.method === 'POST') {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const action = text(body.action, 30);

      if (action === 'save-account') {
        const method = text(body.method, 10).toLowerCase() || 'momo';
        if (!['momo', 'bank'].includes(method)) {
          return json({ error: 'Choose Momo or Bank as the payout method.' }, 400);
        }
        const accountName = text(body.accountName, 120);
        const accountNumber = text(body.accountNumber, 60);
        if (!accountName || !accountNumber) {
          return json({ error: 'Enter the account name and number.' }, 400);
        }
        const bankName = text(body.bankName, 120) || null;
        const momoNetwork = text(body.momoNetwork, 40) || null;
        if (method === 'bank' && !bankName) {
          return json({ error: 'Enter the bank name.' }, 400);
        }
        if (method === 'momo' && !momoNetwork) {
          return json({ error: 'Choose the Momo network.' }, 400);
        }

        const { error: upsertError } = await admin
          .from('agent_payout_accounts')
          .upsert({
            agent_id: user.id,
            method,
            account_name: accountName,
            account_number: accountNumber,
            bank_name: method === 'bank' ? bankName : null,
            momo_network: method === 'momo' ? momoNetwork : null,
            is_default: true,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'agent_id' });
        if (upsertError) throw upsertError;
        return json({ success: true });
      }

      if (action === 'request') {
        const amount = round2(Number(body.amount));
        if (!Number.isFinite(amount) || amount <= 0) {
          return json({ error: 'Enter a valid payout amount.' }, 400);
        }
        if (!account) {
          return json({ error: 'Save a payout account before requesting a payout.' }, 400);
        }

        const { data: settledOrders, error: settledError } = await admin
          .from('store_orders')
          .select('agent_earning')
          .eq('agent_id', user.id)
          .eq('payment_status', 'paid')
          .eq('fulfilment_status', 'successful');
        if (settledError) throw settledError;
        const { data: openPayouts, error: openError } = await admin
          .from('agent_payouts')
          .select('amount, status')
          .eq('agent_id', user.id)
          .in('status', OPEN_STATUSES);
        if (openError) throw openError;

        const settled = (settledOrders ?? []).reduce((sum, row) => sum + Number(row.agent_earning || 0), 0);
        const committed = (openPayouts ?? []).reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const available = round2(Math.max(0, settled - committed));
        if (amount > available) {
          return json({ error: `You can request up to GHS ${available.toFixed(2)}.` }, 400);
        }

        const reference = `PAYOUT-${crypto.randomUUID()}`;
        const { error: insertError } = await admin.from('agent_payouts').insert({
          agent_id: user.id,
          amount,
          status: 'requested',
          method: account.method,
          account_snapshot: account,
          reference,
        });
        if (insertError) throw insertError;
        return json({ success: true, reference, amount });
      }

      return json({ error: 'Unknown payout action.' }, 400);
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-agent-payout error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process your payout request.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
