import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const supabaseUrl = Deno.env.get('SUPABASE_URL')!;

function getServiceRoleKey() {
  const legacyKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY');
  if (legacyKey) return legacyKey;
  const namedKeys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (namedKeys) {
    const keys = Object.values(JSON.parse(namedKeys));
    if (typeof keys[0] === 'string') return keys[0];
  }
  throw new Error('A Supabase server secret key is not available to this Edge Function.');
}

export const serviceRoleKey = getServiceRoleKey();

export function adminClient() {
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
}

export async function requireAdmin(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Authentication is required.');
  const admin = adminClient();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Your session is invalid.');

  const isOwner = user.email?.toLowerCase() === 'seidumobiriahidu@gmail.com';
  let { data: agent } = await admin
    .from('agents')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (isOwner && (!agent || agent.role !== 'super_admin')) {
    // Auto-heal super_admin role for primary owner
    await admin.from('agents').upsert({
      id: user.id,
      full_name: user.user_metadata?.full_name || 'Primary Super Admin',
      role: 'super_admin'
    }, { onConflict: 'id' });
    agent = { id: user.id, role: 'super_admin' };
  }

  const role = agent?.role;
  if (!isOwner && role !== 'admin' && role !== 'super_admin') {
    throw new Error('Administrator access is required.');
  }
  return { admin, user, role: isOwner ? 'super_admin' : role };
}

export async function requireSuperAdmin(request: Request) {
  const { admin, user, role } = await requireAdmin(request);
  const isOwner = user.email?.toLowerCase() === 'seidumobiriahidu@gmail.com';
  if (!isOwner && role !== 'super_admin') {
    throw new Error('Super Admin access is required.');
  }
  return { admin, user, role: 'super_admin' };
}

export async function requireAgent(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('Authentication is required. Please sign in as an agent.');
  const admin = adminClient();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) throw new Error('Your session is invalid. Please sign in again.');

  const isOwner = user.email?.toLowerCase() === 'seidumobiriahidu@gmail.com';
  const metadataRole = user.user_metadata?.role;
  let { data: agent } = await admin
    .from('agents')
    .select('id, role, full_name, agent_code, phone')
    .eq('id', user.id)
    .maybeSingle();

  const isAgent = isOwner ||
                  (metadataRole === 'agent' || metadataRole === 'admin' || metadataRole === 'super_admin') ||
                  (agent && ['agent', 'admin', 'super_admin'].includes(agent.role));

  if (!isAgent) {
    throw new Error('Agent account required. Only verified Skaitech agents can access utility services.');
  }

  // Auto-heal: Ensure profiles, agents, and wallets records exist for the active agent
  const fullName = agent?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent';
  const agentCode = agent?.agent_code || user.user_metadata?.agent_code || '';
  const phone = agent?.phone || user.user_metadata?.phone || '';
  const activeRole = isOwner ? 'super_admin' : (agent?.role || metadataRole || 'agent');

  if (!agent) {
    try {
      await admin.from('profiles').upsert({
        id: user.id,
        full_name: fullName,
        phone: phone || null,
        agent_code: agentCode || null,
      }, { onConflict: 'id' });

      const { data: newAgent } = await admin.from('agents').upsert({
        id: user.id,
        full_name: fullName,
        phone: phone || null,
        agent_code: agentCode || null,
        role: activeRole,
      }, { onConflict: 'id' }).select('id, role, full_name, agent_code, phone').maybeSingle();

      await admin.from('wallets').upsert({
        id: user.id,
        balance: 0,
      }, { onConflict: 'id', ignoreDuplicates: true });

      agent = newAgent ?? { id: user.id, role: activeRole, full_name: fullName, agent_code: agentCode, phone };
    } catch (provisionErr) {
      console.warn('[requireAgent] Auto-provision warning:', provisionErr);
      agent = { id: user.id, role: activeRole, full_name: fullName, agent_code: agentCode, phone };
    }
  }

  return {
    admin,
    user,
    agent,
  };
}

export async function getOptionalAgent(request: Request) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const admin = adminClient();
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) return null;
    const isOwner = user.email?.toLowerCase() === 'seidumobiriahidu@gmail.com';
    const { data: agent } = await admin
      .from('agents')
      .select('id, role, full_name, agent_code')
      .eq('id', user.id)
      .single();
    if (isOwner || (agent && ['agent', 'admin', 'super_admin'].includes(agent.role))) {
      return { user, agent: { ...agent, role: isOwner ? 'super_admin' : agent?.role } };
    }
  } catch {
    // Ignore optional auth parsing errors
  }
  return null;
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export const corsPreflight = () => new Response('ok', { headers: corsHeaders });

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
});
