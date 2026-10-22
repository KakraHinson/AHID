import { supabase } from './supabaseClient.js';

export const PRIMARY_SUPER_ADMIN_EMAIL = 'seidumobiriahidu@gmail.com';

/**
 * Validates that the current visitor has an active Supabase session AND
 * a verified 'agent', 'admin', or 'super_admin' role in the public.agents table.
 * If unauthorized, immediately redirects them away from protected agent areas.
 *
 * @param {Object} options
 * @param {boolean} options.redirectOnFail - whether to redirect if unauthorized (default: true)
 * @param {string} options.redirectTarget - where to redirect if unauthorized (default: 'login.html')
 * @returns {Promise<{ user: any, agent: any } | null>}
 */
export async function requireVerifiedAgent(options = {}) {
  const redirectOnFail = options.redirectOnFail !== false;
  const currentUrl = new URL(window.location.href);
  const currentPage = currentUrl.pathname.split('/').filter(Boolean).pop() || 'index.html';
  const currentPath = `${currentPage}${currentUrl.search}${currentUrl.hash}`;

  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      if (redirectOnFail) {
        if (currentPage.toLowerCase() !== 'login.html') {
          try { sessionStorage.setItem('skaitech_return_url', currentPath); } catch (_) { /* still send the visitor to sign in */ }
        }
        window.location.href = 'login.html';
      }
      return null;
    }

    const isPrimaryOwner = (user.email || '').toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase();

    // 1. Check user metadata first
    const metaRole = isPrimaryOwner ? 'super_admin' : user.user_metadata?.role;
    if (metaRole === 'agent' || metaRole === 'admin' || metaRole === 'super_admin' || isPrimaryOwner) {
      const assignedRole = isPrimaryOwner ? 'super_admin' : (metaRole || 'agent');
      const agentObj = {
        id: user.id,
        role: assignedRole,
        full_name: user.user_metadata?.full_name || (isPrimaryOwner ? 'Primary Super Admin' : user.email?.split('@')[0]) || 'Agent',
        agent_code: user.user_metadata?.agent_code || ''
      };
      localStorage.setItem('currentAgentName', agentObj.full_name);
      localStorage.setItem('agent_name', agentObj.full_name);
      if (agentObj.agent_code) localStorage.setItem('currentAgentCode', agentObj.agent_code);
      localStorage.setItem('agent_role', agentObj.role);

      // Auto-heal agent, profile, and wallet rows in database
      Promise.allSettled([
        supabase.from('profiles').upsert({
          id: user.id,
          full_name: agentObj.full_name,
          agent_code: agentObj.agent_code || null,
        }, { onConflict: 'id' }),
        supabase.from('agents').upsert({
          id: user.id,
          full_name: agentObj.full_name,
          agent_code: agentObj.agent_code || null,
          role: agentObj.role
        }, { onConflict: 'id' }),
        supabase.from('wallets').upsert({
          id: user.id,
          balance: 0
        }, { onConflict: 'id', ignoreDuplicates: true })
      ]).catch(() => {});

      return { user, agent: agentObj };
    }

    // 2. Verify role in the public.agents table
    let { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, role, full_name, agent_code, phone')
      .eq('id', user.id)
      .single();

    // 3. If missing from agents table, auto-heal using profiles
    if (agentError || !agent || !['agent', 'admin', 'super_admin'].includes(agent.role)) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, agent_code, phone')
        .eq('id', user.id)
        .single();

      if (profile || isPrimaryOwner) {
        const agentName = profile?.full_name || user.user_metadata?.full_name || (isPrimaryOwner ? 'Primary Super Admin' : user.email?.split('@')[0]) || 'Agent';
        const agentCode = profile?.agent_code || '';
        const roleToAssign = isPrimaryOwner ? 'super_admin' : 'agent';
        try {
          await supabase.from('agents').upsert({
            id: user.id,
            full_name: agentName,
            agent_code: agentCode,
            phone: profile?.phone || '',
            role: roleToAssign
          }, { onConflict: 'id' });
        } catch (e) {
          console.warn('Could not auto-insert agent row:', e);
        }

        agent = {
          id: user.id,
          role: roleToAssign,
          full_name: agentName,
          agent_code: agentCode
        };
        agentError = null;
      }
    }

    if (agentError || !agent || !['agent', 'admin', 'super_admin'].includes(agent.role)) {
      console.warn('Unauthorized agent access attempt:', user.id, agent);
      localStorage.removeItem('currentAgentCode');
      localStorage.removeItem('agent_wallet_balance');

      if (redirectOnFail) {
        alert('Access Denied: This portal requires a verified Skaitech Agent account.');
        window.location.href = 'index.html';
      }
      return null;
    }

    // Store verified agent credentials
    localStorage.setItem('currentAgentName', agent.full_name || user.email.split('@')[0]);
    localStorage.setItem('agent_name', agent.full_name || user.email.split('@')[0]);
    if (agent.agent_code) localStorage.setItem('currentAgentCode', agent.agent_code);
    localStorage.setItem('agent_role', agent.role);

    return { user, agent };
  } catch (err) {
    console.error('Agent verification failed:', err);
    if (redirectOnFail) {
      if (currentPage.toLowerCase() !== 'login.html') {
        try { sessionStorage.setItem('skaitech_return_url', currentPath); } catch (_) { /* preserve navigation */ }
      }
      window.location.href = 'login.html';
    }
    return null;
  }
}

/**
 * Validates that current visitor has an active session AND role is 'admin' or 'super_admin'.
 * Specifically restricts 'super_admin' actions to Super Admins.
 *
 * @param {Object} options
 * @param {boolean} options.requireSuperAdmin - strictly require super_admin (default: false)
 * @param {boolean} options.redirectOnFail - redirect if unauthorized (default: true)
 * @returns {Promise<{ user: any, agent: any, isSuperAdmin: boolean } | null>}
 */
export async function requireAdminAccess(options = {}) {
  const requireSuper = options.requireSuperAdmin === true;
  const redirectOnFail = options.redirectOnFail !== false;

  const authData = await requireVerifiedAgent({ redirectOnFail });
  if (!authData) return null;

  const { user, agent } = authData;
  const isPrimaryOwner = (user.email || '').toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase();
  const isSuperAdmin = isPrimaryOwner || agent.role === 'super_admin';
  const isAdmin = isSuperAdmin || agent.role === 'admin';

  if (!isAdmin || (requireSuper && !isSuperAdmin)) {
    if (redirectOnFail) {
      alert(`Access Denied: ${requireSuper ? 'Super Admin' : 'Admin'} credentials required.`);
      window.location.href = 'dashboard.html';
    }
    return null;
  }

  return { user, agent: { ...agent, role: isSuperAdmin ? 'super_admin' : agent.role }, isSuperAdmin };
}
