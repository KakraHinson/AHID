import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://mxovqblxizvjsmudjsjf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bTpLJRZs057-DFMMeaz3Xw_oSdrYKy9';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Supabase JS returns a FunctionsHttpError for non-2xx responses and leaves the
// useful JSON body on error.context. Keep that body available to the portal so
// wallet, stock, validation, and provider errors are not reduced to a generic
// "Unable to process" message.
export async function readFunctionError(error) {
  const response = error?.context;
  if (response && typeof response.clone === 'function') {
    try {
      const body = await response.clone().json();
      if (body && typeof body === 'object') {
        return {
          body,
          message: String(body.error || body.message || '').trim(),
        };
      }
    } catch (_) {
      // Fall back to the SDK message when the response is not JSON.
    }
  }
  return { body: null, message: String(error?.message || '').trim() };
}

// The public catalog fallback uses these same public values when a stale
// browser session token prevents supabase.functions.invoke() from completing.
// They are publishable by design; no service-role credential belongs here.
export { SUPABASE_URL, SUPABASE_ANON_KEY };
