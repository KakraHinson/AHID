import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { chargeWallet, refundWallet, WalletError } from '../_shared/wallet.ts';
import { submitAfaRegistration } from '../_shared/afaProvider.ts';
import { resolveServicePrice } from '../_shared/pricing.ts';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let reference = '';
  let agentId = '';
  let walletDebited = false;
  let registrationId: string | null = null;
  let feeAmount = 0;

  try {
    const body = await request.json();
    const fullName = String(body.fullName || '').trim();
    const phone = String(body.phone || '').trim();
    const town = String(body.town || '').trim();
    const idType = String(body.idType || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const occupation = String(body.occupation || '').trim();
    const priceId = String(body.priceId || '').trim();
    // Price is server-side only. A client-supplied `amount` is ignored so an
    // agent cannot underpay for a registration.
    feeAmount = await resolveServicePrice('afa', {
      supabase: adminClient(),
      envVar: 'AFA_FEE_AMOUNT',
      fallback: 11,
    });

    if (!fullName || !phone || !town || !idType || !idNumber || !occupation) {
      return json({ error: 'All registration fields are required.' }, 400);
    }
    if (!/^0\d{9}$/.test(phone)) {
      return json({ error: 'Please enter a valid 10-digit Ghanaian phone number.' }, 400);
    }

    const { admin, user } = await requireAgent(request);
    agentId = user.id;

    reference = `AFA-${crypto.randomUUID()}`;

    const walletBalance = await chargeWallet(user.id, reference, feeAmount, 'AFA Registration Fee', {
      service: 'afa_registration',
      id_number: idNumber,
    });
    walletDebited = true;

    const { data: registration, error: insertError } = await admin
      .from('afa_registrations')
      .insert({
        reference,
        full_name: fullName,
        phone,
        town,
        id_type: idType,
        id_number: idNumber,
        occupation,
        price_id: priceId || null,
        amount: feeAmount,
        status: 'Pending',
        source: 'agent',
        created_by: user.id,
      })
      .select('id, reference, full_name, phone, town, id_type, id_number, occupation, price_id, amount, status, source, created_at, updated_at')
      .single();
    if (insertError) throw insertError;
    registrationId = registration.id;

    const submitResult = await submitAfaRegistration({
      fullName,
      phoneNumber: phone,
      town,
      occupation,
      priceId,
      idNumber,
      idType,
      reference,
    });

    if (!submitResult.success) {
      await admin
        .from('afa_registrations')
        .update({
          status: 'Cancelled',
          failure_reason: submitResult.failureReason,
          provider_response: submitResult.providerResponse ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', registrationId);

      const refundedBalance = await refundWallet(
        user.id,
        reference,
        feeAmount,
        'AFA registration rejected by provider',
      );

      return json({
        success: false,
        refunded: true,
        walletBalance: refundedBalance,
        message: `AFA registration was not accepted: ${submitResult.failureReason || 'Provider declined.'} Your wallet has been refunded.`,
      }, 502);
    }

    const { data: updated } = await admin
      .from('afa_registrations')
      .update({
        status: 'Processing',
        provider_reference: submitResult.providerReference ?? null,
        provider_response: submitResult.providerResponse ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', registrationId)
      .select('reference, full_name, phone, town, id_type, id_number, occupation, price_id, amount, status, source, created_at, updated_at, provider_reference')
      .single();

    return json({
      success: true,
      walletBalance,
      registration: {
        ...(updated ?? registration),
        reference,
        amount: feeAmount,
      },
      message: 'AFA Registration submitted successfully! You can now track your status.',
    }, 201);
  } catch (error) {
    if (walletDebited && registrationId) {
      const admin = adminClient();
      try {
        await admin
          .from('afa_registrations')
          .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
          .eq('id', registrationId);
        await refundWallet(agentId, reference, feeAmount, 'Automatic refund for failed AFA registration');
      } catch (innerError) {
        console.error('Rollback failed for AFA registration:', innerError);
      }
    }
    console.error('create-afa-registration error:', error);
    const message = error instanceof Error ? error.message : 'Unable to submit AFA registration.';
    const isInsufficient = error instanceof WalletError && error.code === 'insufficient';
    const status = isInsufficient
      ? 400
      : /authentication is required|session is invalid/i.test(message)
      ? 401
      : /agent account required/i.test(message)
      ? 403
      : 500;
    return json({ error: message, insufficientFunds: isInsufficient || undefined }, status);
  }
});
