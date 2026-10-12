import { corsPreflight, json, requireAgent } from '../_shared/supabase.ts';
import { callUtilityProvider } from '../_shared/utilityProvider.ts';

const SERVICES = new Set(['ecg', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes']);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const { admin } = await requireAgent(request);
    void admin;
    const body = await request.json();
    const service = String(body.billType ?? '').trim().toLowerCase();
    const accountNumber = String(body.accountNumber ?? '').trim();
    if (!SERVICES.has(service) || accountNumber.length < 4 || accountNumber.length > 30) {
      return json({ error: 'Choose a service and enter a valid account or meter number.' }, 400);
    }
    const result = await callUtilityProvider('verify', {
      service,
      accountNumber,
      meterType: body.meterType ? String(body.meterType) : null,
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
