import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';
import { refundWallet } from '../_shared/wallet.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { reference, email } = await request.json();
    if (!reference || !email) {
      return json({ error: 'Payment reference and customer email are required.' }, 400);
    }

    const admin = adminClient();
    const { data: order, error } = await admin
      .from('utility_orders')
      .select('id, bill_type, bill_category, account_number, meter_type, package_name, amount, fee_amount, gross_amount, customer_name, customer_phone, customer_email, payment_reference, status, token_code, provider_reference, agent_id, created_at, paid_at, completed_at')
      .eq('payment_reference', String(reference).trim())
      .eq('customer_email', String(email).trim().toLowerCase())
      .single();

    if (error || !order) {
      return json({ error: 'Utility bill order not found.' }, 404);
    }

    if (order.status === 'processing') {
      try {
        const providerStatus = await callUtilityProvider('status', {
          service: order.bill_type, accountNumber: order.account_number,
          reference: order.payment_reference, providerReference: order.provider_reference,
        });
        const state = String(providerStatus.status || '').toLowerCase();
        if (['completed', 'successful', 'delivered', 'paid'].includes(state) && providerStatus.success) {
          const completedAt = new Date().toISOString();
          await admin.from('utility_orders').update({
            status: 'completed', token_code: providerStatus.token ?? null,
            provider_reference: providerStatus.providerReference ?? order.provider_reference,
            provider_response: providerStatus.raw, paid_at: completedAt, completed_at: completedAt,
          }).eq('id', order.id).eq('status', 'processing');
          order.status = 'completed';
          order.token_code = providerStatus.token ?? null;
        } else if (['failed', 'declined', 'rejected'].includes(state)) {
          await admin.from('utility_orders').update({ status: 'failed', provider_response: providerStatus.raw, completed_at: new Date().toISOString() }).eq('id', order.id).eq('status', 'processing');
          if (order.agent_id) {
            await refundWallet(order.agent_id, order.payment_reference, Number(order.gross_amount), 'Utility provider reported a failed payment').catch((refundError) => console.error('Utility wallet refund failed:', refundError));
          }
          order.status = 'failed';
        }
      } catch (statusError) {
        console.warn('Utility provider status is not available yet:', statusError);
      }
    }

    const { agent_id: _agentId, ...publicOrder } = order;
    return json({ order: publicOrder });
  } catch (error) {
    console.error('get-utility-bill-order error:', error);
    const message = error instanceof Error ? error.message : 'Unable to retrieve this order.';
    return json({ error: message }, 500);
  }
});
