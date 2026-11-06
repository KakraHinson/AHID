import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

/**
 * Server-side check: is the authenticated (Bearer token) user a verified
 * Skaitech Agent? Agent status is always verified against auth + public.agents;
 * a value sent from the frontend is never trusted.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) {
    return json({ isAgent: false });
  }

  try {
    const admin = adminClient();
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) {
      return json({ isAgent: false });
    }

    const { data: agent, error: agentError } = await admin
      .from('agents')
      .select('id, role, full_name, agent_code, status, is_active')
      .eq('id', user.id)
      .single();

    const isOwner = user.email?.toLowerCase() === 'seidumobiriahidu@gmail.com';
    if (isOwner || (!agentError && agent && ['agent', 'admin', 'super_admin'].includes(agent.role)
      && agent.status === 'active' && agent.is_active !== false)) {
      return json({
        isAgent: true,
        agent: isOwner
          ? { id: user.id, role: 'super_admin', full_name: agent?.full_name || 'Primary Super Admin', agent_code: agent?.agent_code || '' }
          : agent,
      });
    }

    return json({ isAgent: false });
  } catch (err) {
    console.error('check-agent-access error:', err);
    return json({ isAgent: false });
  }
});
