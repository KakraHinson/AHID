import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';
/* ==========================================================================
   SKAITECH MASTER APPLICATION SCRIPT
   ========================================================================== */

/* ==========================================================================
   ORDER STATUS MODEL

   Every service (airtime, utility, data) reports its status in its own
   vocabulary: 'delivered', 'paid', 'successful', 'Processing', 'FAILED'... The
   dashboard therefore maps all of them onto ONE canonical state before it
   counts, filters or renders anything, so a row can never silently fall
   outside every filter and vanish from the summary totals.
   ========================================================================== */
const ORDER_STATUS = Object.freeze({
    PENDING: 'pending',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled'
});

const ORDER_STATUS_LABELS = {
    [ORDER_STATUS.PENDING]: 'Pending',
    [ORDER_STATUS.PROCESSING]: 'Processing',
    [ORDER_STATUS.COMPLETED]: 'Completed',
    [ORDER_STATUS.FAILED]: 'Failed',
    [ORDER_STATUS.CANCELLED]: 'Cancelled'
};

function normalizeOrderStatus(rawStatus) {
    const value = String(rawStatus ?? '').trim().toLowerCase();
    if (!value) return ORDER_STATUS.PENDING;
    if (['successful', 'success', 'completed', 'complete', 'delivered', 'fulfilled', 'paid', 'approved'].includes(value)) {
        return ORDER_STATUS.COMPLETED;
    }
    if (['cancelled', 'canceled', 'void', 'voided'].includes(value)) return ORDER_STATUS.CANCELLED;
    if (['failed', 'failure', 'fail', 'rejected', 'expired', 'declined', 'error'].includes(value)) {
        return ORDER_STATUS.FAILED;
    }
    if (['processing', 'in_progress', 'inprogress', 'accepted', 'dispatched', 'pending_provider'].includes(value)) {
        return ORDER_STATUS.PROCESSING;
    }
    return ORDER_STATUS.PENDING;
}

function formatDataVolume(volumeInMB) {
    const mb = Number(volumeInMB);
    if (!Number.isFinite(mb) || mb <= 0) return 'Data bundle';
    if (mb >= 1024) {
        const gb = mb / 1024;
        return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
    }
    return `${mb}MB`;
}

const SERVICE_LABELS = {
    airtime: 'Airtime',
    utility: 'Utility',
    // The dashboard sells whole-GB bundles against the agent wallet. That is a
    // different product from the small MB top-ups on instantData.html, so the
    // two must not share a name in the orders table. They also live in different
    // database tables, which is why they are separate service keys here.
    data: 'Data Bundle',
    instant_data: 'Instant Data'
};

function serviceLabel(type) {
    return SERVICE_LABELS[type] || 'Other';
}

// --- COOKIE FALLBACK HELPERS ---
function setCookie(name, value, days = 7) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + expires + '; path=/';
}

function getCookie(name) {
  return document.cookie.split('; ').reduce((r, v) => {
    const parts = v.split('=');
    return parts[0] === name ? decodeURIComponent(parts[1]) : r;
  }, '');
}

function generateAgentCode() {
  const token = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  return `SKAI-${token}`;
}

async function ensureAgentProfile(userId, agentName, agentCode, phone = '') {
  try {
    // profiles is read-only to browsers on purpose: its wallet_balance column
    // is a mirror of wallets.balance and must never be client-writable. Agent
    // identity (name/code/phone) is therefore written only to `agents`; a
    // database trigger mirrors those to `profiles`.

    // Check if user is an admin to avoid demoting
    let role = 'agent';
    try {
      const { data: existingAgent } = await supabase
        .from('agents')
        .select('role')
        .eq('id', userId)
        .single();
      if (existingAgent?.role === 'admin') {
        role = 'admin';
      }
    } catch (_) {}

    const agentResult = await supabase.from('agents').upsert({
      id: userId,
      full_name: agentName,
      agent_code: agentCode,
      phone,
      role: role
    }, { onConflict: 'id' });

    // Create the wallet row only if it does not exist yet. Never write a
    // balance here: upserting would overwrite a real balance with 0.00 on
    // every page load. Balances are server-only (see the RLS policies).
    const walletResult = await supabase.from('wallets').upsert({
      id: userId,
      balance: 0.00
    }, { onConflict: 'id', ignoreDuplicates: true });

    // Also update auth user metadata with role and code
    try {
      await supabase.auth.updateUser({
        data: { role, full_name: agentName, agent_code: agentCode }
      });
    } catch (_) {}

    return {
      profileError: null,
      agentError: agentResult.error,
      walletError: walletResult.error
    };
  } catch (err) {
    console.error('ensureAgentProfile error:', err);
    return { profileError: err, agentError: err, walletError: err };
  }
}

function ensureLocalWebServer() {
  if (window.location.protocol === 'file:') {
    throw new Error('Please open this app through a local web server URL such as http://localhost:8000 before ordering data.');
  }
}

async function getValidAgentSession() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.access_token) {
    throw new Error('Your session has expired. Please sign in again.');
  }
  return session;
}

// --- AUTHENTICATION & REGISTRATION LOGIC ---
// Only accept same-site HTML targets. Protected-page guards save this value
// before sending an unauthenticated agent to login, including query strings.
function safeAuthReturnTarget(value) {
  if (!value) return '';
  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) return '';
    const page = target.pathname.split('/').filter(Boolean).pop() || '';
    if (!/^[a-zA-Z0-9_-]+\.html$/i.test(page) || page.toLowerCase() === 'login.html') return '';
    return `${page}${target.search}${target.hash}`;
  } catch (_) {
    return '';
  }
}

function rememberAuthReturnTarget() {
  const current = new URL(window.location.href);
  const page = current.pathname.split('/').filter(Boolean).pop() || 'index.html';
  const target = safeAuthReturnTarget(`${page}${current.search}${current.hash}`);
  if (target) {
    try { sessionStorage.setItem('skaitech_return_url', target); } catch (_) { /* continue to login even if storage is unavailable */ }
  }
}

function postAuthRedirect() {
  const queryRedirect = safeAuthReturnTarget(new URLSearchParams(window.location.search).get('redirect'));
  let savedValue = '';
  try {
    savedValue = sessionStorage.getItem('skaitech_return_url') || '';
    sessionStorage.removeItem('skaitech_return_url');
  } catch (_) { /* use the safe default when session storage is unavailable */ }
  const storedRedirect = safeAuthReturnTarget(savedValue);
  return queryRedirect || storedRedirect || 'dashboard.html';
}

async function handleLogin(event) {
  if (event) event.preventDefault();
  const identifierInput = document.getElementById('loginEmail') || document.getElementById('regName');
  const passwordInput = document.getElementById('passwordInput') || document.getElementById('loginPassword');

  const identifier = identifierInput ? identifierInput.value.trim().toLowerCase() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!identifier || !password) {
    alert('Please enter your email/phone and password.');
    return;
  }

  if (!identifier.includes('@')) {
    alert('Please sign in with the email address on your account.');
    return;
  }

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: identifier,
      password: password
    });

    if (error || !data?.user) {
      const authMessage = error?.message?.toLowerCase() || '';
      if (error?.code === 'email_not_confirmed' || authMessage.includes('email not confirmed')) {
        alert('Your email is not confirmed. Check your inbox or spam folder for the confirmation link. Please do not repeatedly request new links because Supabase limits email delivery.');
        return;
      }
      if (authMessage.includes('rate limit') || authMessage.includes('email rate')) {
        alert('Email delivery is temporarily rate-limited. Wait a few minutes before trying again, or disable email confirmation in Supabase while testing.');
        return;
      }
      alert(error?.message || 'Unable to sign in. Please check your details.');
      return;
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('full_name, agent_code, phone')
      .eq('id', data.user.id)
      .single();

    const { data: agentRow } = await supabase
      .from('agents')
      .select('id, role')
      .eq('id', data.user.id)
      .single();

    const agentName = profile?.full_name || data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || 'Agent';
    const agentCode = profile?.agent_code || data.user.user_metadata?.agent_code || '';

    const effectiveAgentCode = agentCode || generateAgentCode();

    if (!profile || !agentRow || !['agent', 'admin'].includes(agentRow.role)) {
      const setupErrors = await ensureAgentProfile(data.user.id, agentName, effectiveAgentCode, profile?.phone || '');
      if (setupErrors.profileError || setupErrors.agentError || setupErrors.walletError) {
        console.warn('Account setup notice after sign-in:', setupErrors);
      }
    }

    localStorage.setItem('currentAgentName', agentName);
    localStorage.setItem('agent_name', agentName);
    localStorage.setItem('currentAgentCode', effectiveAgentCode);
    window.location.href = postAuthRedirect();
  } catch (err) {
    console.error('Supabase sign-in failed:', err);
    if (err instanceof TypeError && err.message.toLowerCase().includes('fetch')) {
      alert('Connection failed. Open this site through the local server URL, not by double-clicking the HTML file, then try again.');
      return;
    }
    alert('Unable to sign in right now. Please try again.');
  }
}

async function handleRegistration(event) {
  if (event) event.preventDefault();

  const fullNameInput = document.getElementById('regName');
  const phoneInput = document.getElementById('regPhone');
  const emailInput = document.getElementById('regEmail');
  const passwordInput = document.getElementById('regPassword');

  const agentName = fullNameInput && fullNameInput.value.trim() !== '' 
    ? fullNameInput.value.trim() 
    : 'Agent';
  const phone = phoneInput ? phoneInput.value.trim() : '';
  const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
  const password = passwordInput ? passwordInput.value : '';

  if (!email || !email.includes('@')) {
    alert('Please enter a valid email address.');
    return;
  }
  if (password.length < 6) {
    alert('Password must be at least 6 characters.');
    return;
  }

  const generatedCode = generateAgentCode();

  try {
      const { data, error } = await supabase.auth.signUp({
        email: email,
        password: password,
        options: {
          data: {
            full_name: agentName,
            phone: phone,
            agent_code: generatedCode,
            role: 'agent'
          }
        }
      });

      if (error || !data?.user) {
        const authMessage = error?.message?.toLowerCase() || '';
        if (authMessage.includes('signups not allowed') || authMessage.includes('signup is disabled')) {
          alert('New accounts are disabled in Supabase. In Supabase Dashboard, open Authentication > Settings and enable Allow new users to sign up, then try again.');
          return;
        }
        if (authMessage.includes('rate limit') || authMessage.includes('email rate')) {
          alert('Email delivery is temporarily rate-limited. Wait a few minutes before creating another account, or disable email confirmation in Supabase while testing.');
          return;
        }
        alert(error?.message || 'Unable to create your account.');
        return;
      }

      if (!data.session) {
        alert('Account created. Check your email to confirm your account, then sign in.');
        window.location.href = 'login.html';
        return;
      }

      const setupErrors = await ensureAgentProfile(data.user.id, agentName, generatedCode, phone);
      if (setupErrors.profileError || setupErrors.agentError || setupErrors.walletError) {
        console.warn('Profile/wallet setup was blocked; continuing with the authenticated session:', setupErrors);
      }
  } catch (err) {
    console.error('Supabase sign-up failed:', err);
    alert('Unable to create your account right now. Please try again.');
    return;
  }

  try {
    localStorage.setItem('currentAgentName', agentName);
    localStorage.setItem('agent_name', agentName);
    localStorage.setItem('currentAgentCode', generatedCode);
    if (!localStorage.getItem('agent_wallet_balance')) {
      localStorage.setItem('agent_wallet_balance', '0');
    }
  } catch (e) {
    setCookie('currentAgentName', agentName);
    setCookie('currentAgentCode', generatedCode);
  }

  window.location.href = postAuthRedirect();
}

 window.switchTab = function(tab) {
  const loginForm = document.getElementById('loginForm');
  const registerForm = document.getElementById('registerForm');
  const loginTab = document.getElementById('loginTab');
  const registerTab = document.getElementById('registerTab');

  if (!loginForm || !registerForm) return;

  if (tab === 'register') {
    loginForm.classList.add('hidden-form');
    registerForm.classList.remove('hidden-form');
    if (loginTab) loginTab.classList.remove('active');
    if (registerTab) registerTab.classList.add('active');
  } else {
    registerForm.classList.add('hidden-form');
    loginForm.classList.remove('hidden-form');
    if (registerTab) registerTab.classList.remove('active');
    if (loginTab) loginTab.classList.add('active');
  }
}

// --- DASHBOARD DISPLAY LOGIC ---
function loadDashboardAgentInfo() {
  const agentNameElement = document.getElementById('displayAgentName');
  const agentCodeElement = document.getElementById('displayAgentCode');
  const avatarElement = document.getElementById('userAvatarInitials');

  if (agentNameElement && agentCodeElement) {
    let storedName = '';
    let storedCode = '';

    try {
      storedName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name');
      storedCode = localStorage.getItem('currentAgentCode');
    } catch (e) {
      storedName = getCookie('currentAgentName');
      storedCode = getCookie('currentAgentCode');
    }

    if (!storedName) storedName = getCookie('currentAgentName') || 'Valued Agent';
    if (!storedCode) {
      storedCode = getCookie('currentAgentCode') || generateAgentCode();
      try { localStorage.setItem('currentAgentCode', storedCode); } catch (e) { setCookie('currentAgentCode', storedCode); }
    }

    // Update greeting and agent code
    agentNameElement.textContent = storedName;
   agentCodeElement.textContent = `AGENT CODE: ${storedCode}`;

    // Extract first letter of first name and first letter of second name
    if (avatarElement && storedName) {
      const nameParts = storedName.trim().split(/\s+/);
      let initials = '';

      if (nameParts.length >= 2) {
        initials = nameParts[0].charAt(0) + nameParts[1].charAt(0);
      } else if (nameParts.length === 1 && nameParts[0].length > 0) {
        initials = nameParts[0].slice(0, 2);
      } else {
        initials = 'AG';
      }

      avatarElement.textContent = initials.toUpperCase();
    }
  }
}


// --- NAVIGATION & UI INTERACTION LOGIC ---
 function toggleDrawer() {
  const drawer = document.getElementById('sideDrawer');
  const overlay = document.getElementById('sidebarOverlay');

  if (drawer) {
    drawer.classList.toggle('active');
  }
  if (overlay) {
    overlay.classList.toggle('active');
  }
}



 // NETWORK BUNDLE PRICING DATA & LOGOS
const networkPackages = {
  'MTN': {
    label: 'MTN',
    themeClass: 'theme-mtn',
    logoUrl: 'img/mtn-logo.png',
    packages: [
      { size: '1 GB', price: 4.30 },
      { size: '2 GB', price: 8.80 },
      { size: '3 GB', price: 13.20 },
      { size: '4 GB', price: 17.60 },
      { size: '5 GB', price: 22.00 },
      { size: '6 GB', price: 26.10 },
      { size: '8 GB', price: 34.80 },
      { size: '10 GB', price: 42.00 },
      { size: '15 GB', price: 63.00 },
      { size: '20 GB', price: 84.00 },
      { size: '25 GB', price: 103.75 },
      { size: '30 GB', price: 121.50 },
      { size: '40 GB', price: 160.00 },
      { size: '50 GB', price: 200.00 }
    ]
  },
  'Telecel': {
    label: 'TELECEL',
    themeClass: 'theme-telecel',
    logoUrl: 'img/telecel-logo.png',
    packages: [
      { size: '5 GB', price: 21.00 },
      { size: '10 GB', price: 40.00 },
      { size: '15 GB', price: 60.00 },
      { size: '20 GB', price: 78.00 },
      { size: '30 GB', price: 114.00 },
      { size: '40 GB', price: 151.00 },
      { size: '50 GB', price: 185.00 }
    ]
  },
  'AirtelTigo': {
    label: 'AIRTELTIGO',
    themeClass: 'theme-airteltigo',
    logoUrl: 'img/airtel-logo.png',
    packages: [
      { size: '1 GB', price: 4.20 },
      { size: '2 GB', price: 8.39 },
      { size: '3 GB', price: 12.58 },
      { size: '4 GB', price: 16.78 },
      { size: '5 GB', price: 20.97 },
      { size: '6 GB', price: 25.17 },
      { size: '7 GB', price: 29.36 },
      { size: '8 GB', price: 33.56 },
      { size: '10 GB', price: 40.84 },
      { size: '15 GB BigTime', price: 60.71 }
    ]
  }
};

/**
 * Dynamically builds package cards with network logos and theme styles
 */
function selectNetwork(netKey) {
  const container = document.getElementById('bundlesContainer');
  if (!container) return;

  const data = networkPackages[netKey] || networkPackages['MTN'];

  const outOfStockBanner = data.outOfStock
    ? `<div style="grid-column: 1 / -1; background: #fee2e2; border: 1px solid #f87171; color: #991b1b; padding: 12px; border-radius: 8px; font-weight: 700; text-align: center; margin-bottom: 12px;"><i class="fa-solid fa-triangle-exclamation"></i> Telecel Data Bundles are currently Out of Stock.</div>`
    : '';

  container.innerHTML = outOfStockBanner + data.packages.map(pkg => `
    <div class="package-card ${data.themeClass || ''}" style="${data.outOfStock ? 'opacity: 0.85;' : ''}">
      <div class="card-logo-wrapper">
        <img src="${data.logoUrl}" alt="${data.label}" class="card-network-logo" />
        <span class="status-dot" style="${data.outOfStock ? 'background: #ef4444;' : ''}"></span>
      </div>
      <span class="card-net-label">${data.label}</span>
      <div class="card-data-size">
        <i class="fa-solid fa-wifi text-sky-500 text-base"></i> ${pkg.size}
      </div>
      <div class="card-price-tag">GHS ${pkg.price.toFixed(2)}</div>
      <span class="card-pay-type">One-time payment</span>
${data.outOfStock ? `
      <button class="btn-add-cart" disabled style="background: #9ca3af; color: #fff; cursor: not-allowed; opacity: 0.8;" onclick="alert('Telecel data bundle is currently out of stock.'); return false;">
        <i class="fa-solid fa-ban"></i> Out of Stock
      </button>
      ` : `
      <button class="btn-add-cart" onclick="openBuyModal('${data.label}', '${pkg.size}', ${pkg.price})" style="background: linear-gradient(135deg, #2563eb, #1e40af); color: #fff; cursor: pointer;">
        <i class="fa-solid fa-cart-plus"></i> Add to Cart
      </button>
      `}
    </div>
  `).join('');
}  



let currentOrder = null;

function openBuyModal(network, size, price) {
    currentOrder = { network, size, price: parseFloat(price) };
    const modal = document.getElementById('buyModal');
    const title = document.getElementById('modalTitle');
    const details = document.getElementById('modalPackageDetails');
    const phoneInput = document.getElementById('recipientPhone');
    if (title) title.innerText = `Buy ${network} Bundle`;
    if (details) details.innerText = `Package: ${size} - GHS ${parseFloat(price).toFixed(2)}`;
    if (phoneInput) phoneInput.value = '';
    if (modal) modal.style.display = 'flex';
}

function closeBuyModal() {
    currentOrder = null;
    document.getElementById('buyModal').style.display = 'none';
}

async function processPurchase() {
    const phoneInput = document.getElementById('recipientPhone');
    const phone = phoneInput ? phoneInput.value.trim() : '';

    if (!phone || phone.length < 10) {
        alert("Please enter a valid 10-digit phone number.");
        return;
    }

    if (!currentOrder || typeof currentOrder.price === 'undefined') {
        alert("No active order found!");
        return;
    }

    try {
      ensureLocalWebServer();
    } catch (serverError) {
      alert(serverError.message);
      return;
    }

    const networkMap = { MTN: 'mtn', TELECEL: 'telecel', AIRTELTIGO: 'airteltigo' };
    const networkType = networkMap[currentOrder.network.toUpperCase()];
    const volumeInMB = Number.parseFloat(currentOrder.size) * 1024;
    const button = document.querySelector('#buyModal .btn-confirm');

    if (!networkType || !Number.isFinite(volumeInMB)) {
      alert('This bundle is not configured correctly.');
      return;
    }

    if (button) {
      button.disabled = true;
      button.textContent = 'Processing secure order...';
    }

    try {
      const session = await getValidAgentSession();
      const { data, error } = await supabase.functions.invoke('purchase-agent-data', {
        body: { phone, networkType, volumeInMB, amount: currentOrder.price },
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      if (error) {
        // Supabase wraps every non-2xx function response in a generic
        // FunctionsHttpError. Its response body contains the safe message the
        // function returned (for example, a provider price or order failure).
        let responseMessage = data?.error;
        const response = error?.context;
        if (!responseMessage && response instanceof Response) {
          const errorBody = await response.clone().json().catch(() => null);
          if (errorBody && typeof errorBody.error === 'string') responseMessage = errorBody.error;
        }

        const message = responseMessage
          || (typeof error?.message === 'string' ? error.message : '')
          || 'Unable to complete the data order.';
        if (/failed to fetch|unexpected.*fetch/i.test(message)) {
          throw new Error('The ordering service is unavailable. Check your internet connection and try again.');
        }
        throw new Error(message);
      }
      if (!data?.success) throw new Error(data?.error || 'The data order was not completed.');

      const newOrder = {
        id: data.orderReference,
        shortId: data.shortCode || '',
        type: 'data',
        network: currentOrder.network,
        phone,
        package: currentOrder.size,
        price: Number(data.amount ?? currentOrder.price).toFixed(2),
        // The provider only reserves the order at this point; the real status
        // comes from sync-agent-data-order, so never assume it is delivered.
        status: data.status || ORDER_STATUS.PROCESSING,
        providerRef: data.providerReference || '',
        date: new Date().toLocaleDateString()
      };
      const existingOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
      existingOrders.unshift(newOrder);
      localStorage.setItem('skaitechOrders', JSON.stringify(existingOrders));

      if (normalizeOrderStatus(newOrder.status) === ORDER_STATUS.COMPLETED) {
        alert(`Order completed successfully!\nNetwork: ${newOrder.network}\nSize: ${newOrder.package}\nPhone: ${phone}`);
      } else {
        const code = newOrder.shortId ? ` (code ${newOrder.shortId})` : '';
        alert(`Order submitted!\nNetwork: ${newOrder.network}\nSize: ${newOrder.package}\nPhone: ${phone}${code}\n\nThe bundle is being delivered. Track it under Orders.`);
      }
      closeBuyModal();
      if (document.getElementById('ordersTableBody')) loadStoredOrders();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to complete the data order. Your wallet was not charged if the provider failed.';
      alert(message);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = 'Confirm & Buy';
      }
    }
}
// Run when page loads
document.addEventListener('DOMContentLoaded', () => {
  loadDashboardAgentInfo();
});
function toggleAccordion(headerElement) {
  const accordion = headerElement.parentElement;
  accordion.classList.toggle('active');
}
// REALTIME ORDER SEARCH FILTER

//  // REALTIME ORDER SEARCH FILTER
let currentFilter = 'all';
let currentServiceTab = 'all';
let currentPage = 1;
let ordersPerPage = 10;

// SET ACTIVE FILTER PILL
function setFilter(status, element) {
    currentFilter = status;
    currentPage = 1;

    // Update pill active classes
    const buttons = document.querySelectorAll('#statusPills .pill-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    if (element) element.classList.add('active');

    filterOrders();
}

// SET ACTIVE SERVICE TYPE TAB (airtime / data / utility / all)
function setServiceTab(tab, element) {
    currentServiceTab = tab;
    currentPage = 1;

    const buttons = document.querySelectorAll('#serviceTabs .pill-btn');
    buttons.forEach(btn => btn.classList.remove('active'));
    if (element) element.classList.add('active');

    filterOrders();
}

/**
 * Every order the page knows about, cached so that searching and filtering
 * re-paginate over the full list instead of only the rows that happen to be on
 * the current page.
 */
let allOrders = [];

function currentSearchTerm() {
  const searchInput = document.getElementById('orderSearch');
  return searchInput ? searchInput.value.trim().toLowerCase() : '';
}

// FILTER, PAGINATE AND RENDER ORDERS BY STATUS, SERVICE TYPE & SEARCH TEXT
function filterOrders() {
  const tableBody = document.getElementById('ordersTableBody');
  if (!tableBody) return;

  const searchText = currentSearchTerm();

  const filteredOrders = allOrders.filter(order => {
    const type = order.type || 'data';
    if (currentServiceTab !== 'all' && type !== currentServiceTab) return false;
    if (currentFilter !== 'all' && normalizeOrderStatus(order.status) !== normalizeOrderStatus(currentFilter)) {
      return false;
    }
    if (!searchText) return true;
    // Search across the fields an agent would actually recall an order by,
    // including both the 5-character code and the long tracking reference.
    return [order.shortId, order.id, order.network, order.phone, order.package, order.providerRef, order.date]
      .some(field => String(field || '').toLowerCase().includes(searchText));
  });

  // Summary totals always describe every order, not just the filtered page.
  updateTransactionSummary(allOrders);

  tableBody.innerHTML = '';

  const startIndex = (currentPage - 1) * ordersPerPage;
  const paginatedOrders = filteredOrders.slice(startIndex, startIndex + Number(ordersPerPage));

  paginatedOrders.forEach(order => {
    const status = normalizeOrderStatus(order.status);
    const label = ORDER_STATUS_LABELS[status];
    const type = order.type || 'data';
    const row = document.createElement('tr');
    row.setAttribute('data-status', status);
    row.setAttribute('data-service', type);
    // Orders show their short 5-character code; the long reference stays in the
    // row (and in the search index) so it can still be tracked.
    const orderId = order.shortId || order.id;
    // The network belongs with the package details; the Service column names
    // the product (Airtime / Instant Data / Utility) instead of a network.
    const details = [order.network, order.package].filter(Boolean).join(' · ');
    const providerRef = order.providerRef
        ? `<span class="cell-ref">${order.providerRef}</span>`
        : '<span class="cell-muted">-</span>';
    row.innerHTML = `
        <td class="cell-id">#${orderId}</td>
        <td>${serviceLabel(type)}</td>
        <td>${order.phone || '-'}</td>
        <td>${details || '-'}</td>
        <td><span class="status-badge badge-${status}">${label}</span></td>
        <td>${providerRef}</td>
        <td class="cell-date">${order.date || ''}</td>
    `;
    tableBody.appendChild(row);
  });

  // Toggle between Empty State message and Data Table display
  const emptyState = document.getElementById('emptyState');
  const table = document.getElementById('ordersTable');
  const emptyTitle = document.querySelector('#emptyState h3');
  const emptyText = document.querySelector('#emptyState p');
  if (emptyText) {
    emptyText.textContent = currentServiceTab === 'airtime'
      ? "You haven't placed any airtime purchases yet, or try searching with a different reference or phone number."
      : currentServiceTab === 'utility'
      ? "You haven't settled any utility bills yet, or try searching with a different reference or phone number."
      : currentServiceTab === 'data'
      ? "You haven't purchased any data bundles yet, or try searching with a different reference or phone number."
      : currentServiceTab === 'instant_data'
      ? "You haven't sold any instant data yet, or try searching with a different reference or phone number."
      : "You haven't placed any orders yet, or try searching with a different phone number.";
  }
  if (emptyTitle) {
    emptyTitle.textContent = searchText ? 'No matching orders' : 'No orders found';
  }

  if (paginatedOrders.length === 0) {
    if (emptyState) emptyState.style.display = 'block';
    if (table) table.style.display = 'none';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (table) table.style.display = 'table';
  }

  const countDisplay = document.getElementById('ordersCountText');
  if (countDisplay) {
    countDisplay.textContent = `${filteredOrders.length} order${filteredOrders.length === 1 ? '' : 's'} found`;
  }

  updatePaginationUI(filteredOrders.length);
}
// LOAD AND DISPLAY ORDERS WITH STATUS ACTIONS
// RENDER TABLE (AUTOMATIC DISPLAY - NO DROPDOWN)
function maskPhoneDisplay(phone) {
    const clean = String(phone || '').replace(/\D/g, '');
    if (!clean) return phone || '-';
    if (clean.length <= 6) return clean.length <= 2 ? clean : clean.slice(0, 1) + '*'.repeat(clean.length - 2) + clean.slice(-1);
    return clean.slice(0, 3) + '*'.repeat(clean.length - 7) + clean.slice(-4);
}

function updateTransactionSummary(orders) {
    const airtimeCount = orders.filter(o => o.type === 'airtime').length;
    const utilityCount = orders.filter(o => o.type === 'utility').length;
    const dataCount = orders.filter(o => o.type === 'data').length;
    const instantDataCount = orders.filter(o => o.type === 'instant_data').length;

    // Count against the canonical state, not the raw provider wording, so a new
    // status string can never leave an order uncounted.
    const tally = orders.reduce((acc, order) => {
        acc[normalizeOrderStatus(order.status)] += 1;
        return acc;
    }, { pending: 0, processing: 0, completed: 0, failed: 0, cancelled: 0 });

    const setStat = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    setStat('statAirtime', airtimeCount);
    setStat('statUtility', utilityCount);
    setStat('statData', dataCount);
    setStat('statInstantData', instantDataCount);
    setStat('statCompleted', tally.completed);
    setStat('statFailed', tally.failed + tally.cancelled);
    setStat('statPending', tally.pending + tally.processing);
}

/**
 * Asks the backend to check any data bundle orders that are still in flight
 * against the provider. Data is delivered asynchronously, so this is what moves
 * an order from Processing to Completed (or refunds it when it fails) instead of
 * guessing. Failures are non-fatal: the page still renders from the database.
 */
async function syncAgentDataOrders() {
    try {
        const session = await getValidAgentSession();
        if (!session) return;
        const { error } = await supabase.functions.invoke('sync-agent-data-order', {
            body: {},
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (error) console.warn('Data order sync did not complete:', error.message || error);
    } catch (error) {
        console.warn('Data order sync could not run:', error);
    }
}

async function loadStoredOrders() {
    const tableBody = document.getElementById('ordersTableBody');
    if (!tableBody) return;

    let savedOrders = JSON.parse(localStorage.getItem('skaitechOrders')) || [];
    let instantDataReadError = '';

    try {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
            // Reconcile in-flight data orders before reading them, so the table
            // shows the provider's real outcome rather than a stale snapshot.
            await syncAgentDataOrders();

            // Server-scoped transactions (airtime + utility) from the agent-transactions edge function.
            const txData = await fetchAgentTransactions();

            // Data bundle orders remain scoped via RLS to the authenticated agent.
            const { data: dataOrders } = await supabase
                .from('agent_data_orders')
                .select('id, provider_reference, short_code, provider_order_id, network_type, phone, volume_mb, amount, status, created_at')
                .eq('agent_id', user.id)
                .order('created_at', { ascending: false })
                .limit(50);

            // Instant Data (instantData.html) is a separate storefront that writes to
            // public_data_orders, not agent_data_orders, so without this read the
            // agent's instant data purchases never appeared on this page at all.
            // The RLS policy scopes it to the caller's own rows.
            const instantDataOrders = [];
            let instantDataError = null;
            for (let offset = 0; !instantDataError; offset += 500) {
                const { data: page, error } = await supabase
                    .from('public_data_orders')
                    .select('id, payment_reference, short_code, provider_reference, network_type, customer_name, customer_phone, volume_mb, sale_amount, status, created_at')
                    .eq('agent_id', user.id)
                    .order('created_at', { ascending: false })
                    .range(offset, offset + 499);
                if (error) {
                    instantDataError = error;
                    break;
                }
                instantDataOrders.push(...(page || []));
                if (!page || page.length < 500) break;
            }
            if (instantDataError) {
                console.warn('Instant data orders could not be read:', instantDataError.message || instantDataError);
                instantDataReadError = 'Instant Data history could not be refreshed. Please reload, or contact support if this continues.';
            }

            // The new storefronts (data.html + instantData.html) buy through
            // purchase-data-bundle, which writes to data_transactions, a third
            // table. RLS scopes it to the caller's own rows; bundles() is embedded
            // so the title can be shown instead of the raw bundle_key.
            const { data: platformDataOrders } = await supabase
                .from('data_transactions')
                .select('reference, short_code, network_id, bundle_key, recipient_phone, amount, status, created_at, bundles(title, volume_mb)')
                .eq('user_id', user.id)
                .order('created_at', { ascending: false })
                .limit(200);

            const remoteOrders = [];
            if (txData?.airtime) {
                txData.airtime.forEach(o => {
                    remoteOrders.push({
                        id: o.reference || o.id.slice(0, 8),
                        shortId: o.shortCode || '',
                        type: 'airtime',
                        network: o.networkLabel,
                        phone: o.phoneMasked,
                        package: `Airtime (GHS ${Number(o.amount).toFixed(2)})`,
                        status: o.statusLabel,
                        providerRef: o.providerReference || '',
                        date: new Date(o.createdAt).toLocaleDateString()
                    });
                });
            }
            if (txData?.utility) {
                txData.utility.forEach(o => {
                    remoteOrders.push({
                        id: o.reference || o.id.slice(0, 8),
                        shortId: o.shortCode || '',
                        type: 'utility',
                        network: o.billLabel,
                        phone: o.phoneMasked,
                        package: `${o.packageName || o.billLabel} (GHS ${Number(o.amount).toFixed(2)}) • Acct ${o.accountMasked}`,
                        status: o.statusLabel,
                        providerRef: o.providerReference || '',
                        date: new Date(o.createdAt).toLocaleDateString()
                    });
                });
            }
            if (dataOrders) {
                dataOrders.forEach(o => {
                    remoteOrders.push({
                        id: o.provider_reference || o.id.slice(0, 8),
                        shortId: o.short_code || '',
                        type: 'data',
                        network: (o.network_type || '').toUpperCase(),
                        phone: maskPhoneDisplay(o.phone),
                        package: `${formatDataVolume(o.volume_mb)} (GHS ${Number(o.amount).toFixed(2)})`,
                        status: o.status,
                        providerRef: o.provider_order_id || o.provider_reference || '',
                        date: new Date(o.created_at).toLocaleDateString()
                    });
                });
            }
            if (instantDataOrders) {
                instantDataOrders.forEach(o => {
                    remoteOrders.push({
                        id: o.payment_reference || o.id.slice(0, 8),
                        shortId: o.short_code || '',
                        type: 'instant_data',
                        network: (o.network_type || '').toUpperCase(),
                        phone: maskPhoneDisplay(o.customer_phone),
                        // Instant data is always bought for a named walk-in customer,
                        // so the name rides along in the details (and the search index).
                        package: `${o.customer_name || 'Customer'} · ${formatDataVolume(o.volume_mb)} (GHS ${Number(o.sale_amount).toFixed(2)})`,
                        status: o.status,
                        providerRef: o.provider_reference || '',
                        date: new Date(o.created_at).toLocaleDateString()
                    });
                });
            }
            // Synchronize the new-platform instant data purchases into the same
            // list so the Instant Data tab shows both generations of storefront.
            if (platformDataOrders) {
                platformDataOrders.forEach(o => {
                    const bundle = Array.isArray(o.bundles) ? o.bundles[0] : o.bundles;
                    const title = bundle?.title || o.bundle_key || 'Data bundle';
                    remoteOrders.push({
                        id: o.reference || o.id.slice(0, 8),
                        shortId: o.short_code || '',
                        type: 'instant_data',
                        network: (o.network_id || '').toUpperCase(),
                        phone: maskPhoneDisplay(o.recipient_phone),
                        package: `${title} (GHS ${Number(o.amount).toFixed(2)})`,
                        status: o.status === 'success' ? 'successful' : o.status,
                        providerRef: '',
                        date: new Date(o.created_at).toLocaleDateString()
                    });
                });
            }

            if (remoteOrders.length > 0) {
                const existingIds = new Set(remoteOrders.map(r => String(r.id).toUpperCase()));
                savedOrders = [...remoteOrders, ...savedOrders.filter(s => !existingIds.has(String(s.id).toUpperCase()))];
            }
        }
    } catch (e) {
        console.warn('Could not load remote agent orders:', e);
    }

    try {
        const localAirtime = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
        const existingIds = new Set(savedOrders.map(s => String(s.id).toUpperCase()));
        localAirtime.forEach(o => {
            if (o.reference && !existingIds.has(String(o.reference).toUpperCase())) {
                savedOrders.push({
                    id: o.reference,
                    type: 'airtime',
                    network: (o.network || 'AIRTIME').toUpperCase(),
                    phone: maskPhoneDisplay(o.phone),
                    package: `Airtime (GHS ${Number(o.amount).toFixed(2)})`,
                    status: o.airtimeStatus || 'pending',
                    providerRef: '',
                    date: o.createdAt ? new Date(o.createdAt).toLocaleDateString() : 'Recent'
                });
            }
        });
    } catch {
        // Ignore local cache read error
    }

    const instantDataNotice = document.getElementById('instantDataOrdersNotice');
    if (instantDataNotice) {
        instantDataNotice.textContent = instantDataReadError;
        instantDataNotice.hidden = !instantDataReadError;
    }

    // Cache the full list; filterOrders() owns filtering, pagination and
    // rendering so the search box and the filter pills behave consistently.
    allOrders = savedOrders;
    currentPage = 1;
    filterOrders();
}

// RUN ON PAGE LOAD
document.addEventListener('DOMContentLoaded', () => {
  loadStoredOrders();
});

function updatePaginationUI(totalOrders) {
  const totalPages = Math.ceil(totalOrders / ordersPerPage) || 1;
  const pageIndicator = document.getElementById('pageIndicator');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');

  if (pageIndicator) pageIndicator.innerText = `Page ${currentPage} of ${totalPages}`;
  if (prevBtn) prevBtn.disabled = currentPage === 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function changePage(direction) {
  currentPage += direction;
  filterOrders();
}

function changePageSize(newSize) {
    ordersPerPage = Number(newSize);
    currentPage = 1;
    filterOrders();
}

function handleReportMessage(event) {
    event.preventDefault();
    const name = document.getElementById('msgName').value;
    const email = document.getElementById('msgEmail').value;
    const subject = document.getElementById('msgSubject').value;
    const message = document.getElementById('msgContent').value;

    const mailSubject = `[Help Desk] ${subject} - ${name}`;
    const mailBody = `Name: ${name}\nEmail: ${email}\nSubject: ${subject}\n\nMessage:\n${message}`;
    const mailtoLink = `mailto:skaitechgh360@gmail.com?subject=${encodeURIComponent(mailSubject)}&body=${encodeURIComponent(mailBody)}`;

    window.location.href = mailtoLink;
    document.getElementById('reportMessageForm').reset();
}
function toggleFaq(button) {
    const item = button.parentElement;
    const isActive = item.classList.contains('active');

    // Close all FAQ items first
    document.querySelectorAll('.faq-item').forEach(el => {
        el.classList.remove('active');
    });

    // If it wasn't active before, open it now
    if (!isActive) {
        item.classList.add('active');
    }
}

const menuToggleBtn = document.getElementById('menuToggleBtn');
const dropdownMenu = document.getElementById('dropdownMenu');

if (menuToggleBtn && dropdownMenu) {
    menuToggleBtn.addEventListener('click', () => {
        if (dropdownMenu.style.display === 'none' || dropdownMenu.style.display === '') {
            dropdownMenu.style.display = 'block';
        } else {
            dropdownMenu.style.display = 'none';
        }
    });
}

// function toggleMenu() {
//     const dropdown = document.getElementById('dropdownMenu');
//     const symbol = document.getElementById('menuIconSymbol');


function toggleMenu() {
    const dropdown = document.getElementById('dropdownMenu');
    const overlay = document.getElementById('menuOverlay');
    const symbol = document.getElementById('menuIconSymbol');

    if (dropdown) {
        dropdown.classList.toggle('active');
    }
    if (overlay) {
        overlay.classList.toggle('active');
    }
    if (symbol && dropdown) {
        symbol.innerHTML = dropdown.classList.contains('active') ? '&times;' : '&#8801;';
    }
}

function openForgotModal(event) {
    event.preventDefault();
    document.getElementById('forgotPasswordModal').style.display = 'flex';
}

function closeForgotModal() {
    document.getElementById('forgotPasswordModal').style.display = 'none';
}

async function submitPasswordReset() {
    const input = document.getElementById('resetEmailOrPhone');
    const email = String(input?.value || '').trim().toLowerCase();

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
        alert('Enter the email address registered to your account.');
        return;
    }

    const button = document.querySelector('#forgotPasswordModal button[onclick="submitPasswordReset()"]');
    if (button) {
        button.disabled = true;
        button.textContent = 'Sending…';
    }
    try {
        const redirectTo = new URL('login.html?recovery=true', window.location.origin).href;
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
        if (error) throw error;
        input.value = '';
        closeForgotModal();
        alert('If that email is registered, a password reset link has been sent. Check your inbox and spam folder.');
    } catch (error) {
        console.error('Password reset request failed:', error);
        alert(error?.message || 'Could not send a reset link. Please try again later.');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = 'Send Reset Link';
        }
    }
}

async function handlePasswordRecovery(event) {
    event.preventDefault();
    const password = document.getElementById('newAccountPassword')?.value || '';
    const confirmation = document.getElementById('confirmAccountPassword')?.value || '';
    if (password.length < 6) {
        alert('Use a password with at least 6 characters.');
        return;
    }
    if (password !== confirmation) {
        alert('The passwords do not match.');
        return;
    }

    try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !session) throw new Error('This reset link is invalid or expired. Request a new one.');
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        await supabase.auth.signOut();
        alert('Your password has been updated. Sign in with your new password.');
        window.location.replace('login.html');
    } catch (error) {
        console.error('Password update failed:', error);
        alert(error?.message || 'Could not update your password. Request a new reset link and try again.');
    }
}

function togglePasswordVisibility() {
    const passwordInput = document.getElementById('passwordInput');
    const eyeIcon = document.getElementById('eyeIcon');

    if (passwordInput.type === 'password') {
        passwordInput.type = 'text';
        eyeIcon.classList.remove('fa-eye');
        eyeIcon.classList.add('fa-eye-slash'); // Changes to a slashed eye when visible
    } else {
        passwordInput.type = 'password';
        eyeIcon.classList.remove('fa-eye-slash');
        eyeIcon.classList.add('fa-eye');
    }
}

// Low balance check guard function for orders placed from dashboard
function checkOrderBalanceBeforeAction(orderPrice) {
    let balance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
    if (balance < orderPrice) {
        alert(`⚠️ Warning: Your account balance (GHS ${balance.toFixed(2)}) is too low for this transaction! Please fund your wallet.`);
        window.location.href = 'agentWallet.html';
        return false;
    }
    return true;
}

// Populate popup balance on load
document.addEventListener('DOMContentLoaded', () => {
    const popupBal = document.getElementById('popupBalanceVal');
    if (popupBal) {
        const bal = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0;
        popupBal.innerText = `GHS ${bal.toFixed(2)}`;
    }
});
/* ---- AGENT-ONLY SERVICE GATING (server-verified, redirects to auth) ---- */
// Builds the Sign In / Register URL with an agent prompt and a return target.
function agentActionLoginUrl(redirectPath) {
    const params = new URLSearchParams();
    params.set('action', 'agent');
    params.set('notice', 'agent');
    params.set('register', 'true');
    if (redirectPath) params.set('redirect', redirectPath);
    return `login.html?${params.toString()}`;
}

// Sends visitors who are not verified agents to the Sign In / Sign Up page
// with a prompt to create an agent account.
function redirectToAgentAuth(redirectPath) {
    window.location.href = agentActionLoginUrl(redirectPath);
    return false;
}

async function handleUtilityClick(event, service = 'ecg') {
    if (event) event.preventDefault();
    const target = `utilityBills.html?service=${encodeURIComponent(service)}`;

    try {
        const { isAgent } = await checkAgentAccessServer();
        if (isAgent) {
            window.location.href = target;
            return false;
        }
    } catch (err) {
        console.warn('Error checking agent authorization for utility service:', err);
    }

    return redirectToAgentAuth(target);
}

function openAgentModal() {
    const modal = document.getElementById('agentGateModal');
    if (modal) {
        modal.classList.add('active');
    } else {
        if (confirm('Skaitech Utility Bill payments (ECG Prepaid, Ghana Water, and TV Subscriptions) require a verified Agent account.\n\nWould you like to register as an Agent now?')) {
            window.location.href = 'login.html?register=true';
        }
    }
}

function closeAgentModal() {
    const modal = document.getElementById('agentGateModal');
    if (modal) modal.classList.remove('active');
}

/* ---- INSTANT DATA AGENT-ONLY GATING (server-verified) ---- */
async function handleInstantDataClick(networkKey, event) {
    if (event) event.preventDefault();
    const target = networkKey ? `instantData.html?network=${encodeURIComponent(networkKey)}` : 'instantData.html';

    try {
        const { isAgent } = await checkAgentAccessServer();
        if (isAgent) {
            window.location.href = target;
            return false;
        }
    } catch (err) {
        console.warn('Agent check failed before instant data navigation:', err);
    }

    return redirectToAgentAuth(target);
}

function openInstantDataAgentModal() {
    const modal = document.getElementById('instantDataAgentGateModal');
    if (modal) {
        modal.classList.add('active');
        return;
    }
    if (confirm('Agent Registration Required\n\nOnly registered agents can purchase instant data. Register as an agent to continue.')) {
        window.location.href = 'login.html?register=true';
    } else {
        return false;
    }
}

function closeInstantDataAgentModal() {
    const modal = document.getElementById('instantDataAgentGateModal');
    if (modal) modal.classList.remove('active');
}

/* ---- AIRTIME AGENT-ONLY GATING (server-verified) ---- */
async function handleAirtimeClick(networkKey, event) {
    if (event) event.preventDefault();
    const target = networkKey ? `airtime.html?network=${encodeURIComponent(networkKey)}` : 'airtime.html';

    try {
        const { isAgent } = await checkAgentAccessServer();
        if (isAgent) {
            window.location.href = target;
            return false;
        }
    } catch (err) {
        console.warn('Agent check failed before airtime navigation:', err);
    }

    return redirectToAgentAuth(target);
}

function openAirtimeAgentModal() {
    const modal = document.getElementById('airtimeAgentGateModal');
    if (modal) {
        modal.classList.add('active');
        return;
    }
    if (confirm('Agent Registration Required\n\nOnly registered agents can purchase airtime. Please register as an agent to continue.')) {
        window.location.href = 'login.html?register=true';
    } else {
        return false;
    }
}

function closeAirtimeAgentModal() {
    const modal = document.getElementById('airtimeAgentGateModal');
    if (modal) modal.classList.remove('active');
}

// Global Window Bindings for HTML Inline Event Handlers
window.toggleDrawer = toggleDrawer;
window.toggleAccordion = toggleAccordion;
window.selectNetwork = selectNetwork;
window.openBuyModal = openBuyModal;
window.closeBuyModal = closeBuyModal;
window.processPurchase = processPurchase;
window.setFilter = setFilter;
window.setServiceTab = setServiceTab;
window.filterOrders = filterOrders;
window.changePage = changePage;
window.changePageSize = changePageSize;
window.openForgotModal = openForgotModal;
window.closeForgotModal = closeForgotModal;
window.submitPasswordReset = submitPasswordReset;
window.handlePasswordRecovery = handlePasswordRecovery;
window.togglePasswordVisibility = togglePasswordVisibility;
window.handleRegistration = handleRegistration;
window.handleLogin = handleLogin;
window.switchTab = switchTab;
window.toggleFaq = toggleFaq;
window.toggleMenu = toggleMenu;
window.handleReportMessage = handleReportMessage;
window.loadStoredOrders = loadStoredOrders;
window.loadDashboardAgentInfo = loadDashboardAgentInfo;
window.loadUserData = loadUserData;
window.handleUtilityClick = handleUtilityClick;
window.openAgentModal = openAgentModal;
window.closeAgentModal = closeAgentModal;
window.handleAirtimeClick = handleAirtimeClick;
window.openAirtimeAgentModal = openAirtimeAgentModal;
window.closeAirtimeAgentModal = closeAirtimeAgentModal;
window.handleInstantDataClick = handleInstantDataClick;
window.openInstantDataAgentModal = openInstantDataAgentModal;
window.closeInstantDataAgentModal = closeInstantDataAgentModal;

async function loadUserData() {
  const currentPath = window.location.pathname.toLowerCase();

  const isLoginPage = currentPath.endsWith('login.html');
  const isPublicPage = isLoginPage ||
    currentPath.endsWith('index.html') ||
    currentPath.endsWith('ourhelpdesk.html') ||
    currentPath.endsWith('nonagentbuyers.html') ||
    currentPath.endsWith('nonagenttrachorder.html') ||
    currentPath.endsWith('resultschecker.html') ||
    currentPath.endsWith('utilitybills.html') ||
    currentPath.endsWith('nonagentdashboard.html') ||
    currentPath.endsWith('afa.html') ||
    currentPath === '/' ||
    currentPath.endsWith('/');

  const isProtectedAgentPage = currentPath.endsWith('dashboard.html') ||
    currentPath.endsWith('orders.html') ||
    currentPath.endsWith('agentWallet.html') ||
    currentPath.endsWith('deposit.html') ||
    currentPath.endsWith('store.html') ||
    currentPath.endsWith('agentafa.html');

  // An existing authenticated user should not see the sign-in form again.
  // Return them to the requested page, or to the agent home dashboard.
  if (isLoginPage) {
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const isPasswordRecovery = new URLSearchParams(window.location.search).get('recovery') === 'true' ||
      hashParams.get('type') === 'recovery';
    if (isPasswordRecovery) return;
    try {
      const { data: { user }, error } = await supabase.auth.getUser();
      if (!error && user) {
        window.location.replace(postAuthRedirect());
        return;
      }
    } catch (authErr) {
      console.warn('Could not restore the saved login session:', authErr);
    }
    return;
  }

  // Public pages remain accessible while the agent session stays active.
  if (isPublicPage && !isProtectedAgentPage) {
    return;
  }

  try {
    let userName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || 'Valued Agent';
    let agentCode = localStorage.getItem('currentAgentCode') || generateAgentCode();
    let walletBalance = parseFloat(localStorage.getItem('agent_wallet_balance')) || 0.00;

    // 1. Try to get Supabase session
    try {
      const { data: { user }, error: userError } = await supabase.auth.getUser();

      if (user && !userError) {
        // Enforce verified agent role for protected agent pages
        let { data: agentData, error: agentError } = await supabase
          .from('agents')
          .select('id, role, full_name, agent_code')
          .eq('id', user.id)
          .single();

        // If agent record doesn't exist or is invalid, check user metadata or profiles
        if (isProtectedAgentPage && (agentError || !agentData || !['agent', 'admin'].includes(agentData.role))) {
          const metaRole = user.user_metadata?.role;
          const { data: profileData } = await supabase
            .from('profiles')
            .select('full_name, agent_code, phone')
            .eq('id', user.id)
            .single();

          if (profileData || metaRole === 'agent' || metaRole === 'admin') {
            const name = profileData?.full_name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent';
            const code = profileData?.agent_code || user.user_metadata?.agent_code || generateAgentCode();
            const phone = profileData?.phone || user.user_metadata?.phone || '';

            // Auto-heal agent record
            await ensureAgentProfile(user.id, name, code, phone);

            // Re-fetch agent record
            const { data: refreshedAgent } = await supabase
              .from('agents')
              .select('id, role, full_name, agent_code')
              .eq('id', user.id)
              .single();

            if (refreshedAgent && ['agent', 'admin'].includes(refreshedAgent.role)) {
              agentData = refreshedAgent;
              agentError = null;
            } else {
              agentData = {
                id: user.id,
                role: metaRole === 'admin' ? 'admin' : 'agent',
                full_name: name,
                agent_code: code
              };
              agentError = null;
            }
          }
        }

        if (isProtectedAgentPage && (agentError || !agentData || !['agent', 'admin'].includes(agentData.role))) {
          console.warn('Unauthorized access attempt to agent portal:', user.id);
          localStorage.removeItem('currentAgentCode');
          localStorage.removeItem('agent_wallet_balance');
          alert('Access Denied: This portal requires a verified Skaitech Agent account.');
          window.location.href = 'index.html';
          return;
        }

        const { data: profileData, error: profileError } = await supabase
          .from('profiles')
          .select('full_name, agent_code')
          .eq('id', user.id)
          .single();

        if (profileData && !profileError) {
          if (profileData.full_name) userName = profileData.full_name;
          if (profileData.agent_code) agentCode = profileData.agent_code;
        } else if (agentData) {
          if (agentData.full_name) userName = agentData.full_name;
          if (agentData.agent_code) agentCode = agentData.agent_code;
        }

        const { data: walletData, error: walletError } = await supabase
          .from('wallets')
          .select('balance')
          .eq('id', user.id)
          .single();

        if (walletData && !walletError && walletData.balance !== null && walletData.balance !== undefined) {
          walletBalance = parseFloat(walletData.balance);
        }
      } else if (isProtectedAgentPage) {
        rememberAuthReturnTarget();
        window.location.href = 'login.html';
        return;
      }
    } catch (authErr) {
      console.error('Supabase auth check failed:', authErr);
      if (isProtectedAgentPage) {
        rememberAuthReturnTarget();
        window.location.href = 'login.html';
        return;
      }
    }

    // Cache latest values
    localStorage.setItem('currentAgentName', userName);
    localStorage.setItem('agent_name', userName);
    localStorage.setItem('currentAgentCode', agentCode);
    localStorage.setItem('agent_wallet_balance', walletBalance);

    // Update UI elements across various dashboard pages
    const nameElement = document.getElementById('displayAgentName') || document.getElementById('userName');
    const codeElement = document.getElementById('displayAgentCode') || document.getElementById('agentCode');
    const avatarElement = document.getElementById('userAvatarInitials') || document.getElementById('walletAgentInitials');
    const popupBalElement = document.getElementById('popupBalanceVal');
    const balanceElement = document.getElementById('agentWalletBalance') || document.getElementById('walletPageBalance') || document.getElementById('walletHeaderDisplay') || document.getElementById('cashoutWalletBalDisplay');

    if (nameElement) nameElement.innerText = userName;
    if (codeElement) {
      codeElement.innerText = codeElement.id === 'displayAgentCode' ? `AGENT CODE: ${agentCode}` : agentCode;
    }
    if (popupBalElement) popupBalElement.innerText = `GHS ${walletBalance.toFixed(2)}`;
    if (balanceElement) {
      if (balanceElement.id === 'walletHeaderDisplay') {
        balanceElement.innerText = `Wallet Balance: GHS ${walletBalance.toFixed(2)}`;
      } else {
        balanceElement.innerText = `GHS ${walletBalance.toFixed(2)}`;
      }
    }

    if (avatarElement && userName) {
      const parts = userName.trim().split(/\s+/);
      let initials = 'AG';
      if (parts.length >= 2) {
        initials = parts[0][0] + parts[1][0];
      } else if (parts.length === 1 && parts[0].length > 0) {
        initials = parts[0].slice(0, 2);
      }
      avatarElement.innerText = initials.toUpperCase();
    }
  } catch (err) {
    console.error('Unexpected error in loadUserData:', err);
  }
}

// Execute on DOM load
document.addEventListener('DOMContentLoaded', loadUserData);
