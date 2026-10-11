import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';

/**
 * Unified, session-aware navigation shell for every Skaitech portal page.
 * Injected once per page to provide a consistent top header + slide-out
 * drawer. Behavior differs by session:
 *   - Verified agents: brand + nav point to dashboard/services (they stay
 *     inside the portal; there is no "Back to Home" that exits to the
 *     public landing page). Drawer includes Portal links + Sign Out.
 *   - Visitors: brand + "Home" keep them on the public site; drawer shows
 *     Agent Login / Become an Agent plus the same services.
 */

const LOGO = 'img/akaitech%20more%20final%20logo.jpeg';

const AGENT_PORTAL_ITEMS = [
  { page: 'dashboard.html', icon: 'fa-border-all', label: 'Dashboard' },
  { page: 'orders.html', icon: 'fa-cart-shopping', label: 'Orders' },
  { page: 'agentWallet.html', icon: 'fa-wallet', label: 'Wallet' },
  { page: 'deposit.html', icon: 'fa-money-bill-transfer', label: 'Deposit' },
  { page: 'agentAFA.HTML', icon: 'fa-users', label: 'Agent AFA' },
  { page: 'STORE.HTML', icon: 'fa-store', label: 'Store & Pricing' },
  { page: 'settings.html', icon: 'fa-user-gear', label: 'Settings' },
];

const SERVICE_ITEMS = [
  { page: 'airtime.html', icon: 'fa-mobile-screen-button', label: 'Buy Airtime' },
  { page: 'instantData.html', icon: 'fa-wifi', label: 'Instant Data' },
{ page: 'utilityBills.html', icon: 'fa-bolt', label: 'Utility Bills' },
  { href: 'utilityBills.html?service=telecel_broadband', page: 'utilityBills.html', icon: 'fa-wifi', label: 'Telecel Broadband' },
  { href: 'utilityBills.html?service=telecel_postpaid', page: 'utilityBills.html', icon: 'fa-file-invoice-dollar', label: 'Telecel Postpaid Bill' },
  { page: 'resultsChecker.html', icon: 'fa-receipt', label: 'Results Checker' },
  { page: 'nonAgentTrachOrder.html', icon: 'fa-magnifying-glass', label: 'Track Order' },
];

const AGENT_COMING_SOON_ITEMS = [];

function currentFile() {
  const file = window.location.pathname.split('/').pop();
  return (file || 'index.html').toLowerCase();
}

function drawerItem(item, isAgent) {
  if (item.disabled) {
    return `
    <span class="drawer-item" aria-disabled="true" title="Coming soon" style="opacity: .58; cursor: not-allowed;">
      <i class="fa-solid ${item.icon}"></i> ${item.label} <small style="margin-left: auto;">Soon</small>
    </span>`;
  }
  const ext = item.external ? ' target="_blank" rel="noopener"' : '';
  const href = item.href || item.page;
  const active = item.page && currentFile() === item.page.toLowerCase() ? ' active' : '';
  return `
    <a href="${href}" class="drawer-item${active ? ' active' : ''}"${ext}>
      <i class="fa-solid ${item.icon}"></i> ${item.label}
    </a>`;
}

function drawerHtml(isAgent) {
  const isHomePage = ['index.html', 'nonagentdashboard.html'].includes(currentFile());
  // Agents track their purchases on the Orders page instead, which is scoped to
  // their own account; this lookup page is for customers holding a reference.
  const serviceItems = SERVICE_ITEMS.filter((item) =>
    item.page !== 'nonAgentTrachOrder.html' || !isAgent || isHomePage
  );
  const portal = isAgent
    ? AGENT_PORTAL_ITEMS.map((i) => drawerItem(i, true)).join('')
    : `
      <a href="login.html" class="drawer-item">
        <i class="fa-solid fa-right-to-bracket"></i> Agent Login
      </a>
      <a href="login.html?register=true" class="drawer-item">
        <i class="fa-solid fa-user-plus"></i> Become an Agent
      </a>`;

  const logoutAction = isAgent
    ? `
      <div class="drawer-divider"></div>
      <span class="drawer-section-label">SESSION</span>
      <nav class="drawer-nav">
        <button type="button" onclick="agentShellLogout()" class="drawer-item" style="background: none; border: none; width: 100%; text-align: left; cursor: pointer; color: #dc2626;">
          <i class="fa-solid fa-right-from-bracket"></i> Sign Out
        </button>
      </nav>`
    : '';

  return `
    <div class="drawer-header">
      <div class="drawer-brand">
        <img src="${LOGO}" alt="Skaitech" class="drawer-logo">
        <span class="drawer-brand-name">SKAITECH</span>
      </div>
      <button type="button" class="drawer-close-btn" onclick="toggleAgentDrawer()" aria-label="Close menu">&times;</button>
    </div>

    <span class="drawer-section-label">${isAgent ? 'AGENT PORTAL' : 'SKAITECH'}</span>
    <nav class="drawer-nav">
      ${isAgent ? '' : `<a href="index.html" class="drawer-item"><i class="fa-solid fa-house"></i> Home</a>`}
      ${portal}
    </nav>

    <div class="drawer-divider"></div>

    <span class="drawer-section-label">SERVICES</span>
    <nav class="drawer-nav">
      ${[...serviceItems, ...(isAgent ? AGENT_COMING_SOON_ITEMS : [])].map((i) => drawerItem(i, isAgent)).join('')}
    </nav>

    <div class="drawer-divider"></div>

    <span class="drawer-section-label">SUPPORT</span>
    <nav class="drawer-nav">
      <a href="ourHelpDesk.html" class="drawer-item">
        <i class="fa-solid fa-headset"></i> Our Help Desk
      </a>
      <a href="https://chat.whatsapp.com/EbflGFoh9Y64BiaFVqbHid" target="_blank" rel="noopener" class="drawer-item">
        <i class="fa-brands fa-whatsapp"></i> Community
      </a>
    </nav>
    ${logoutAction}
  `;
}

function headerHtml(isAgent) {
  const userInitials = (localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || '').trim() || 'AG';
  const initials = userInitials.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'AG';

  return `
    <div class="gt-header-left">
      <button type="button" class="gt-hamburger-btn hamburger-btn" onclick="toggleAgentDrawer()" aria-label="Open menu">
        <i class="fa-solid fa-bars"></i>
      </button>
      <a href="${isAgent ? 'dashboard.html' : 'index.html'}" class="gt-brand" style="text-decoration: none;">
        SKAITECH
      </a>
    </div>
    <div class="gt-header-right">
      ${isAgent
        ? `<span class="header-utility">
             <button type="button" class="header-icon-btn" id="notifBellBtn"
                     aria-label="Notifications" aria-expanded="false" aria-haspopup="true">
               <i class="fa-solid fa-bell"></i>
               <span class="notif-badge" id="notifBadge" hidden>0</span>
             </button>
             <div class="notif-dropdown" id="notifDropdown" role="menu" aria-labelledby="notifBellBtn" hidden>
               <div class="notif-dropdown-head">
                 <span>Notifications</span>
                 <button type="button" class="notif-markall" id="notifMarkAll">Mark all as read</button>
               </div>
               <div class="notif-list" id="notifList">
                 <p class="notif-empty">Loading notifications&hellip;</p>
               </div>
             </div>
           </span>
           <button type="button" class="header-icon-btn" id="themeToggleBtn" aria-label="Toggle dark mode">
             <i class="fa-solid fa-moon" id="themeToggleIcon"></i>
           </button>
           <span class="agent-portal-tag"><i class="fa-solid fa-user-check"></i> Agent Portal</span>
           <div class="user-avatar" id="agentShellAvatar">${initials}</div>`
        : `<a href="login.html" class="agent-login-link"><i class="fa-solid fa-right-to-bracket"></i> Agent Login</a>`}
    </div>
  `;
}

async function loadShell(isAgent) {
  const header = document.getElementById('agentShellHeader');
  if (header) {
    header.innerHTML = headerHtml(isAgent, true);
  }
  const drawer = document.getElementById('agentShellDrawer');
  if (drawer) {
    drawer.innerHTML = drawerHtml(isAgent);
  }
  if (isAgent) {
    initHeaderControls();
  }
}

function ensureElements() {
  let header = document.getElementById('agentShellHeader');
  let overlay = document.getElementById('agentShellOverlay');
  let drawer = document.getElementById('agentShellDrawer');

  if (!header) {
    header = document.createElement('header');
    header.id = 'agentShellHeader';
    header.className = 'gt-header';
    header.style.cssText = 'position: sticky; top: 0; z-index: 100;';
    document.body.insertBefore(header, document.body.firstChild);
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'agentShellOverlay';
    overlay.className = 'sidebar-overlay';
    overlay.onclick = () => toggleAgentDrawer();
    document.body.appendChild(overlay);
  }

  if (!drawer) {
    drawer = document.createElement('aside');
    drawer.id = 'agentShellDrawer';
    drawer.className = 'side-drawer';
    document.body.appendChild(drawer);
  }

  return { header, overlay, drawer };
}

function toggleAgentDrawer(force) {
  const drawer = document.getElementById('agentShellDrawer');
  const overlay = document.getElementById('agentShellOverlay');
  if (!drawer) return;
  const open = typeof force === 'boolean' ? force : !drawer.classList.contains('active');
  drawer.classList.toggle('active', open);
  if (overlay) overlay.classList.toggle('active', open);
}

async function agentShellLogout() {
  try { await supabase.auth.signOut(); } catch (err) { console.warn('Sign out notice:', err); }
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch (err) { /* ignore */ }
  window.location.href = 'login.html';
}

async function initAgentShell() {
  const { overlay, drawer } = ensureElements();
  drawer.classList.add('side-drawer');
  drawer.id = 'agentShellDrawer';

  let isAgent = false;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      // Prefer server-verified status; fall back to cached flag.
      isAgent = !!localStorage.getItem('currentAgentCode') ||
                ['agent', 'admin'].includes(localStorage.getItem('agent_role') || '');
      try {
        const res = await checkAgentAccessServer();
        if (res && typeof res.isAgent === 'boolean') isAgent = res.isAgent;
      } catch (err) {
        console.warn('Server agent check unavailable; using cached flag:', err);
      }
    }
  } catch (err) {
    console.warn('Session check unavailable:', err);
  }

  await loadShell(isAgent);
  document.body.classList.add('agent-shell-mounted');
  document.body.classList.toggle('agent-shell-agent', isAgent);
}

window.toggleAgentDrawer = toggleAgentDrawer;
// Some legacy pages still call toggleDrawer(); expose a safe alias.
if (typeof window.toggleDrawer !== 'function') {
  window.toggleDrawer = toggleAgentDrawer;
}
window.agentShellLogout = agentShellLogout;

// ---------------------------------------------------------------------------
// Header controls: notifications + dark mode
// ---------------------------------------------------------------------------
// Both are agent-only and are wired up after the shell renders, because the
// header is built from JS and the elements do not exist until then.

const NOTIF_ICONS = {
  success: 'fa-circle-check',
  error: 'fa-circle-exclamation',
  warning: 'fa-triangle-exclamation',
  info: 'fa-circle-info'
};

// escapeHtml only exists on the AFA and admin pages, and agentNav.js loads
// before those on every page, so this cannot rely on a shared global.
function escapeNotifText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function closeNotifDropdown() {
  const dd = document.getElementById('notifDropdown');
  const btn = document.getElementById('notifBellBtn');
  if (dd) dd.hidden = true;
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function renderNotifications(rows) {
  const list = document.getElementById('notifList');
  const badge = document.getElementById('notifBadge');
  if (!list) return;

  if (!rows.length) {
    list.innerHTML = '<p class="notif-empty">No notifications yet.</p>';
  } else {
    list.innerHTML = rows.map((n) => {
      const icon = NOTIF_ICONS[n.kind] || NOTIF_ICONS.info;
      const unread = !n.read_at;
      // The title comes from our own trigger, not user input, and body is
      // rendered as text through the escaper rather than interpolated raw.
      const when = new Date(n.created_at);
      const stamp = Number.isNaN(when.getTime()) ? '' : when.toLocaleString();
      return `
        <div class="notif-item${unread ? ' is-unread' : ''}">
          <i class="fa-solid ${icon} notif-item-icon notif-kind-${n.kind || 'info'}"></i>
          <div class="notif-item-body">
            <p class="notif-item-title">${escapeNotifText(n.title || '')}</p>
            ${n.body ? `<p class="notif-item-text">${escapeNotifText(n.body)}</p>` : ''}
            <p class="notif-item-time">${escapeNotifText(stamp)}</p>
          </div>
        </div>`;
    }).join('');
  }

  if (badge) {
    const unread = rows.filter((n) => !n.read_at).length;
    // 99+ because a three digit badge breaks the pill shape.
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.hidden = unread === 0;
  }
}

async function loadNotifications() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from('notifications')
      .select('id, title, body, kind, read_at, created_at, order_table, order_id')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    renderNotifications(data || []);
  } catch (err) {
    console.warn('Could not load notifications:', err);
    const list = document.getElementById('notifList');
    if (list) list.innerHTML = '<p class="notif-empty">Notifications unavailable.</p>';
  }
}

async function markAllNotificationsRead() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { error } = await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('read_at', null);
    if (error) throw error;
    await loadNotifications();
  } catch (err) {
    console.warn('Could not mark notifications read:', err);
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  const icon = document.getElementById('themeToggleIcon');
  if (icon) {
    icon.classList.toggle('fa-moon', !dark);
    icon.classList.toggle('fa-sun', dark);
  }
  const btn = document.getElementById('themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

function toggleTheme() {
  const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
  try { localStorage.setItem('skaitech_theme', next); } catch (err) { /* ignore */ }
  applyTheme(next);
}

function initHeaderControls() {
  const bell = document.getElementById('notifBellBtn');
  const dd = document.getElementById('notifDropdown');
  const markAll = document.getElementById('notifMarkAll');
  const themeBtn = document.getElementById('themeToggleBtn');

  // Restore the saved theme first so the button state matches the page.
  let saved = 'light';
  try { saved = localStorage.getItem('skaitech_theme') || 'light'; } catch (err) { /* ignore */ }
  applyTheme(saved);

  if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

  if (bell && dd) {
    bell.addEventListener('click', (event) => {
      event.stopPropagation();
      const open = dd.hidden;
      dd.hidden = !open;
      bell.setAttribute('aria-expanded', String(open));
      if (open) loadNotifications();
    });
    // Clicks inside the dropdown must not close it via the document handler.
    dd.addEventListener('click', (event) => event.stopPropagation());
  }

  if (markAll) markAll.addEventListener('click', markAllNotificationsRead);

  if (!window.__notifOutsideBound) {
    window.__notifOutsideBound = true;
    document.addEventListener('click', closeNotifDropdown);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeNotifDropdown();
    });
  }

  loadNotifications();
}

window.toggleTheme = toggleTheme;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAgentShell);
} else {
  initAgentShell();
}
