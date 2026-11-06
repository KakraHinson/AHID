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

    // Auth user_metadata is user-editable. Authorization comes only from the
    // server-controlled agents row, with the primary owner as the one explicit
    // identity exception.
    let { data: agent, error: agentError } = await supabase
      .from('agents')
      .select('id, role, full_name, agent_code, phone, status, is_active')
      .eq('id', user.id)
      .single();

    if (isPrimaryOwner && (!agent || agentError)) {
      agent = {
        id: user.id,
        role: 'super_admin',
        full_name: user.user_metadata?.full_name || 'Primary Super Admin',
        agent_code: user.user_metadata?.agent_code || ''
      };
      agentError = null;
    }

    const isInactive = !isPrimaryOwner && agent && (agent.status !== 'active' || agent.is_active === false);
    if (agentError || !agent || !['agent', 'admin', 'super_admin'].includes(agent.role) || isInactive) {
      console.warn('Unauthorized agent access attempt:', user.id, agent);
      localStorage.removeItem('currentAgentCode');
      localStorage.removeItem('agent_wallet_balance');

      if (redirectOnFail) {
        await supabase.auth.signOut();
        alert(isInactive
          ? 'Your agent account is suspended or cancelled. Contact the administrator.'
          : 'Access Denied: This portal requires a verified Skaitech Agent account.');
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
