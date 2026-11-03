import { corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';

const SERVICES = new Set(['ecg', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes']);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin, agent, user } = await requireAgent(request);
    void admin;
    const body = await request.json();
    const service = String(body.billType ?? '').trim().toLowerCase();
    // Meter numbers and account numbers are strictly alphanumeric strings (e.g. "P241759005").
    // Do NOT prepend country code "233" or format as a phone number. If a client or browser autofill
    // erroneously prepended "233" to a meter, strip the spurious prefix.
    let accountNumber = String(body.accountNumber ?? body.meterNumber ?? '').trim();
    if (/^\+?233([A-Za-z].*)$/.test(accountNumber)) {
      accountNumber = accountNumber.replace(/^\+?233/, '');
    } else if (/^\+?233(\d{8,16})$/.test(accountNumber)) {
      accountNumber = accountNumber.replace(/^\+?233/, '');
    }
    if (!SERVICES.has(service) || accountNumber.length < 4 || accountNumber.length > 30) {
      return json({ error: 'Choose a service and enter a valid account or meter number.' }, 400);
    }
    const result = await callUtilityProvider('verify', {
      service,
      accountNumber,
      meterType: body.meterType ? String(body.meterType) : null,
      // ECG queries meters by the phone linked to them and Ghana Water requires
      // the customer's phone, so the number entered on the form is passed along.
      customerPhone: String(body.customerPhone ?? '').trim(),
    });
    if (!result.success || !result.verified) {
      return json({ verified: false, error: result.message || 'The provider could not verify this account.' }, 422);
    }
    return json({ verified: true, customerName: result.customerName || null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to verify this account.';
    const status = /authentication is required|session is invalid/i.test(message) ? 401 : /not configured/i.test(message) ? 503 : 502;
    return json({ verified: false, error: message }, status);
  }
});
