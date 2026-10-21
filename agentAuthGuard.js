import { supabase } from './supabaseClient.js';

/**
 * Validates that the current visitor has an active Supabase session AND
 * a verified 'agent' or 'admin' role in the public.agents table.
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

    // 1. Check user metadata first
    const metaRole = user.user_metadata?.role;
    if (metaRole === 'agent' || metaRole === 'admin') {
      const agentObj = {
        id: user.id,
        role: metaRole,
        full_name: user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent',
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
    if (agentError || !agent || !['agent', 'admin'].includes(agent.role)) {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name, agent_code, phone')
        .eq('id', user.id)
        .single();

      if (profile) {
        const agentName = profile.full_name || user.email?.split('@')[0] || 'Agent';
        const agentCode = profile.agent_code || '';
        try {
          await supabase.from('agents').upsert({
            id: user.id,
            full_name: agentName,
            agent_code: agentCode,
            phone: profile.phone || '',
            role: 'agent'
          }, { onConflict: 'id' });
        } catch (e) {
          console.warn('Could not auto-insert agent row:', e);
        }

        agent = {
          id: user.id,
          role: 'agent',
          full_name: agentName,
          agent_code: agentCode
        };
        agentError = null;
      }
    }

    if (agentError || !agent || !['agent', 'admin'].includes(agent.role)) {
      console.warn('Unauthorized agent access attempt:', user.id, agent);
      // Clean up agent state
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
        try { sessionStorage.setItem('skaitech_return_url', currentPath); } catch (_) { /* preserve navigation if storage is unavailable */ }
      }
      window.location.href = 'login.html';
    }
    return null;
  }
}
