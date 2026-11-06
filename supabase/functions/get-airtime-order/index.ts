import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const body = await request.json();
    const reference = String(body.reference ?? '').trim();

    if (!reference) {
      return json({ error: 'Transaction reference is required.' }, 400);
    }

    // Only authenticated Skaitech Agents can retrieve airtime orders.
    const { admin, agent } = await requireAgent(request);

    const { data: order, error } = await admin
      .from('airtime_orders')
      .select('id, agent_id, user_id, payment_reference, recipient_phone, network, amount, fee_amount, gross_amount, wallet_charge_amount, commission_amount, agent_commission_amount, commission_rate_percent, payment_method, payment_status, airtime_status, provider_reference, failure_reason, customer_name, customer_email, created_at, updated_at')
      .eq('payment_reference', reference)
      .maybeSingle();

    if (error || !order) {
      return json({ error: 'Order not found.' }, 404);
    }

    // Ownership check: an agent may only read orders they placed (admins may read all).
    const isOwner = order.agent_id === agent.id || order.user_id === agent.id;
    if (!isOwner && agent.role !== 'admin') {
      return json({ error: 'Order not found.' }, 404);
    }

    return json({
      order: {
        id: order.id,
        reference: order.payment_reference,
        phone: order.recipient_phone,
        network: order.network,
        amount: order.amount,
        feeAmount: order.fee_amount,
        grossAmount: order.gross_amount,
        walletChargeAmount: order.wallet_charge_amount,
        commissionAmount: order.commission_amount,
        agentCommissionAmount: order.agent_commission_amount,
        commissionRatePercent: order.commission_rate_percent,
        paymentMethod: order.payment_method,
        paymentStatus: order.payment_status,
        airtimeStatus: order.airtime_status,
        providerReference: order.provider_reference,
        failureReason: order.failure_reason,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      }
    });
  } catch (err) {
    console.error('get-airtime-order error:', err);
    const message = err instanceof Error ? err.message : 'Failed to retrieve order status.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({ error: message }, status);
  }
});
