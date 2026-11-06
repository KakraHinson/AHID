import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet } from '../_shared/wallet.ts';
import { resolveServicePrice } from '../_shared/pricing.ts';

const fallbackPrices: Record<'BECE' | 'WASSCE', number> = { BECE: 19, WASSCE: 22 };

function normalizeCheckerExamType(value: unknown): 'BECE' | 'WASSCE' | null {
  const normalized = String(value || '').trim().toUpperCase().replace(/\s+/g, '');
  if (normalized === 'BECE') return 'BECE';
  if (normalized === 'WASSCE' || normalized === 'NOV/DEC' || normalized === 'NOVDEC' || normalized === 'NOV-DEC') return 'WASSCE';
  return null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let orderId: string | null = null;
  let walletCharged = false;

  try {
    const { examType: requestedExamType, quantity, phone } = await request.json();
    const examType = normalizeCheckerExamType(requestedExamType);
    const count = Number(quantity);
    if (!examType || !Number.isInteger(count) || count < 1 || count > 10 || !/^0\d{9}$/.test(String(phone || '').trim())) {
      return json({ error: 'Enter a valid exam type, quantity, and 10-digit Ghana phone number.' }, 400);
    }

    // WALLET-FIRST: results checker is paid from the verified agent's wallet.
    const { admin, user } = await requireAgent(request);
    const agentId = user.id;
    const email = String(user.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return json({ error: 'Add a valid email address to your agent account before purchasing a checker PIN.' }, 400);
    }

    const price = await resolveServicePrice(`result_checker_${examType.toLowerCase()}`, {
      supabase: admin,
      envVar: `RESULT_CHECKER_${examType}_PRICE`,
      fallback: fallbackPrices[examType],
    });
    if (!(price > 0)) return json({ error: 'This result checker is not currently priced for sale.' }, 503);

    const stockTypes = examType === 'BECE' ? ['BECE'] : ['WASSCE', 'NOV/DEC'];
    const { count: stock, error: stockError } = await admin.from('result_checker_pins')
      .select('*', { count: 'exact', head: true }).in('exam_type', stockTypes).eq('status', 'available');
    if (stockError) throw stockError;
    if ((stock || 0) < count) return json({ error: `Only ${stock || 0} ${examType} PIN(s) are available.` }, 409);

    const amount = price * count;
    reference = `RC-${crypto.randomUUID()}`;

    const { data: order, error: orderError } = await admin.from('results_orders').insert({
      exam_type: examType, quantity: count, amount, recipient_phone: phone.trim(),
      email: email.trim().toLowerCase(), payment_reference: reference, status: 'pending_payment',
      serial_pin: null, agent_id: agentId,
    }).select('id').single();
    if (orderError) throw orderError;
    orderId = order.id;

    const walletBalance = await chargeWallet(agentId, reference, amount, 'Results checker purchase', {
      service: 'result_checker',
      exam_type: examType,
      quantity: count,
    });
    walletCharged = true;

    const { data: pins, error: fulfilError } = await admin.rpc('fulfil_result_checker_order', { p_order_id: order.id });
    if (fulfilError) throw fulfilError;

    return json({
      success: true,
      walletBalance,
      reference,
      amount,
      status: 'paid',
      pins: Array.isArray(pins) ? pins : [],
      message: `Payment confirmed. ${count} ${examType} PIN(s) assigned.`,
    });
  } catch (error) {
    console.error('Results checker payment error:', error);
    if (orderId && reference) {
      try {
        const admin = adminClient();
        const { data: order } = await admin.from('results_orders')
          .select('amount, status, agent_id')
          .eq('id', orderId)
          .maybeSingle();
        if (order && order.status !== 'paid') {
          if (walletCharged) {
            await refundWallet(
              String(order.agent_id ?? ''),
              reference,
              Number(order.amount),
              'Results checker fulfilment failed',
            );
          }
          await admin.from('results_orders').update({ status: 'failed' }).eq('id', orderId);
        }
      } catch (innerError) {
        console.error('Results checker refund failed:', innerError);
      }
    }
    const message = error instanceof Error ? error.message : 'Unable to process results checker purchase.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : message.toLowerCase().includes('insufficient')
      ? 400
      : /insufficient pin stock/i.test(message)
      ? 409
      : 500;
    return json({ error: message, insufficientFunds: message.toLowerCase().includes('insufficient') || undefined }, status);
  }
});
