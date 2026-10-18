import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://mxovqblxizvjsmudjsjf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bTpLJRZs057-DFMMeaz3Xw_oSdrYKy9';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The public catalog fallback uses these same public values when a stale
// browser session token prevents supabase.functions.invoke() from completing.
// They are publishable by design; no service-role credential belongs here.
export { SUPABASE_URL, SUPABASE_ANON_KEY };
