import { supabase } from './supabaseClient.js';
import { requireAdminAccess, PRIMARY_SUPER_ADMIN_EMAIL } from './agentAuthGuard.js';

// Application State
let currentUser = null;
let currentAgent = null;
let isSuperAdmin = false;
let activeSection = 'data-module';
let activeDataSubTab = 'orders';
let currentDataCatalogFilter = 'standard';
let activeHistSubTab = 'tx';
let currentUtilityService = 'ecg_prepaid';
let currentUtilityCategoryFilter = 'all';

// Cached Datasets
let cachedDataOrders = [];
let cachedDataStockItems = [];
let cachedAirtimeOrders = [];
let cachedUtilityOrders = [];
let cachedWallets = [];
let cachedAdmins = [];
let selectedWalletUser = null;

// Constant Configurations
const TV_PACKAGES = {
  dstv: [
    { name: 'DStv Padi', price: 75 },
    { name: 'DStv Access', price: 110 },
    { name: 'DStv Family', price: 180 },
    { name: 'DStv Compact', price: 300 },
    { name: 'DStv Compact Plus', price: 450 },
    { name: 'DStv Premium', price: 680 },
    { name: 'Custom Top-Up Amount', price: 0 }
  ],
  gotv: [
    { name: 'GOtv Smallie', price: 30 },
    { name: 'GOtv Jinja', price: 50 },
    { name: 'GOtv Jolli', price: 80 },
    { name: 'GOtv Max', price: 125 },
    { name: 'GOtv Supa', price: 175 },
    { name: 'GOtv Supa Plus', price: 240 },
    { name: 'Custom Top-Up Amount', price: 0 }
  ],
  startimes: [
    { name: 'StarTimes Nova', price: 30 },
    { name: 'StarTimes Basic', price: 55 },
    { name: 'StarTimes Classic', price: 75 },
    { name: 'StarTimes Super', price: 110 },
    { name: 'Custom Top-Up Amount', price: 0 }
  ]
};

// Helpers
const money = (val) => `GHS ${Number(val || 0).toFixed(2)}`;
const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

function safeProviderStatus(value, fallback = 'UNKNOWN') {
  const text = value === null || value === undefined ? '' : String(value).trim();
  return text || fallback;
}

function fiveCharacterAdminOrderCode(value) {
  const text = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{5}$/.test(text) ? text : text.slice(-5) || '-----';
}

async function fetchAllRows(queryFactory, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const text = document.getElementById('toastMessage');
  if (!toast) return;

  toast.className = `${type} show`;
  icon.className = type === 'success' ? 'fa-solid fa-circle-check' : 'fa-solid fa-circle-exclamation';
  text.textContent = message;

  setTimeout(() => {
    toast.className = '';
  }, 4000);
}

// -----------------------------------------------------------------------------
// INITIALIZATION & SECURITY CHECK
// -----------------------------------------------------------------------------
async function initAdminPortal() {
  try {
    const authData = await requireAdminAccess({ requireSuperAdmin: false, redirectOnFail: true });
    if (!authData) return;

    currentUser = authData.user;
    currentAgent = authData.agent;
    isSuperAdmin = authData.isSuperAdmin;

    // Render Admin Identity
    const avatarEl = document.getElementById('sidebarUserAvatar');
    const nameEl = document.getElementById('sidebarUserName');
    const roleEl = document.getElementById('sidebarUserRole');

    const displayName = currentAgent.full_name || currentUser.email.split('@')[0];
    nameEl.textContent = displayName;
    avatarEl.textContent = displayName.slice(0, 2).toUpperCase();

    if (isSuperAdmin) {
      roleEl.textContent = 'SUPER ADMIN';
      roleEl.className = 'user-role-badge role-super';
    } else {
      roleEl.textContent = 'ADMIN';
      roleEl.className = 'user-role-badge role-admin';
    }

    // Role-based visibility for Super Admin "Manage Admins" module
    const manageAdminsNavItem = document.getElementById('manageAdminsNavItem');
    const superAdminSectionLabel = document.getElementById('superAdminSectionLabel');
    if (!isSuperAdmin) {
      if (manageAdminsNavItem) manageAdminsNavItem.style.display = 'none';
      if (superAdminSectionLabel) superAdminSectionLabel.style.display = 'none';
    }

    // Bind Navigation Items
    document.querySelectorAll('.nav-item').forEach((item) => {
      item.addEventListener('click', () => {
        const target = item.dataset.section;
        if (target === 'admins-module' && !isSuperAdmin) {
          showToast('Super Admin access required for Admin Management.', 'error');
          return;
        }
        switchSection(target);
      });
    });

    // Initialize Utility service default
    selectUtilityService('ecg_prepaid');

    // Load the default operational view.
    await loadDataModuleData();

    // Close sidebar on mobile clicking outside
    document.addEventListener('click', (e) => {
      const sidebar = document.getElementById('adminSidebar');
      const toggle = document.querySelector('.mobile-menu-toggle');
      if (window.innerWidth <= 900 && sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });

  } catch (err) {
    console.error('Admin Portal Initialization Error:', err);
    showToast('Failed to initialize Admin Portal: ' + (err.message || 'Check connection'), 'error');
  }
}

// Section Switching
function switchSection(sectionId) {
  activeSection = sectionId;

  // Update Nav
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === sectionId);
  });

  // Update Panels
  document.querySelectorAll('.admin-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === `section-${sectionId}`);
  });

  // Update Topbar Title
  const heading = document.getElementById('pageHeading');
  const subheading = document.getElementById('pageSubheading');

  const titles = {
    'data-module': { title: 'Data Bundles', sub: 'Agent dashboard bundles with Swift / GrandTech fulfilment' },
    'airtime-module': { title: 'Airtime Dispatch Management', sub: 'Hubtel Commission Services [POS: 002040687] network top-up dispatch' },
    'utility-module': { title: 'Utility Bills & Subscriptions', sub: 'ECG Prepaid/Postpaid, Ghana Water (GWCL), DStv, GOtv, and StarTimes' },
    'afa-module': { title: 'AFA Portal Management', sub: 'Track and manage nationwide Ghana Card (AFA) registration requests' },
    'checkers-module': { title: 'Results Checker Stock & Upload', sub: 'Bulk import BECE, WASSCE, and NOV/DEC PINs and audit sales' },
    'agents-module': { title: 'Agent Directory & Access Control', sub: 'Inspect registered agents, manage privileges, and cancel/suspend accounts' },
    'notifications-module': { title: 'Agent Notifications', sub: 'Send targeted or platform-wide announcements that agents can dismiss' },
    'payouts-module': { title: 'Commission Withdrawals', sub: 'Review, disburse, or refund agent store commission withdrawal requests' },
    'stores-module': { title: 'Agent Store Management', sub: 'Monitor agent storefronts, configure commissions, and review store orders' },
    'wallets-module': { title: 'User & Agent Wallets', sub: 'Inspect ledger balances, credit/debit funds manually, and audit histories' },
    'admins-module': { title: 'Admin User Management', sub: 'Super Admin Console: register, edit, and audit administrator accounts' },
  };

  const t = titles[sectionId] || titles['data-module'];
  heading.textContent = t.title;
  subheading.textContent = t.sub;

  // Load section-specific data
  refreshActiveSection();

  // Mobile sidebar auto-close
  if (window.innerWidth <= 900) {
    document.getElementById('adminSidebar').classList.remove('open');
  }
}

async function refreshActiveSection() {
  const icon = document.getElementById('refreshIcon');
  if (icon) icon.classList.add('fa-spin');

  try {
    if (activeSection === 'data-module') await loadDataModuleData();
    else if (activeSection === 'airtime-module') await loadAirtimeData();
    else if (activeSection === 'utility-module') await loadUtilityData();
    else if (activeSection === 'afa-module') await loadAfaData();
    else if (activeSection === 'checkers-module') await loadCheckerData();
    else if (activeSection === 'agents-module') await loadAgentsModuleData();
    else if (activeSection === 'notifications-module') await loadNotificationsModuleData();
    else if (activeSection === 'payouts-module') await loadPayoutsData();
    else if (activeSection === 'stores-module') await loadStoresData();
    else if (activeSection === 'wallets-module') await loadWalletsData();
    else if (activeSection === 'admins-module' && isSuperAdmin) await loadAdminsData();
  } finally {
    if (icon) setTimeout(() => icon.classList.remove('fa-spin'), 400);
  }
}

// -----------------------------------------------------------------------------
// MODULE 2: DATA BUNDLES (LIVE DIRECT DB)
// -----------------------------------------------------------------------------
function switchDataSubTab(tab) {
  activeDataSubTab = tab;
  document.getElementById('dataSubTabOrders').style.display = tab === 'orders' ? 'block' : 'none';
  document.getElementById('dataSubTabStock').style.display = tab === 'stock' ? 'block' : 'none';

  document.querySelectorAll('#section-data-module .sub-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
  });
}

function formatVolumeInGb(details, volumeMb) {
  const mb = Number(volumeMb);
  if (Number.isFinite(mb) && mb > 0) {
    if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}GB`;
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)}GB`;
    return `${mb}MB`;
  }
  if (details) {
    const str = String(details).trim();
    const gbMatch = str.match(/(\d+(?:\.\d+)?)\s*gb/i);
    if (gbMatch) return `${gbMatch[1]}GB`;
    const mbMatch = str.match(/(\d+)\s*mb/i);
    if (mbMatch) {
      const val = Number(mbMatch[1]);
      if (val >= 1024 && val % 1024 === 0) return `${val / 1024}GB`;
      if (val >= 1024) return `${(val / 1024).toFixed(1)}GB`;
      return `${val}MB`;
    }
    const numMatch = str.match(/_(\d+)gb/i);
    if (numMatch) return `${numMatch[1]}GB`;
    const numMbMatch = str.match(/_(\d+)(?:mb)?$/i);
    if (numMbMatch) {
      const val = Number(numMbMatch[1]);
      if (val >= 1024 && val % 1024 === 0) return `${val / 1024}GB`;
      if (val >= 1024) return `${(val / 1024).toFixed(1)}GB`;
      if (val > 0 && val <= 100) return `${val}GB`;
    }
  }
  return details || '1GB';
}

async function loadDataModuleData(options = {}) {
  const syncLive = options.syncLive !== false;
  try {
    const [agentOrders, publicOrders, legacyOrders, storeOrders, catalogRes] = await Promise.all([
      fetchAllRows((from, to) => supabase.from('agent_data_orders').select('id, provider_reference, short_code, provider_name, provider_order_id, phone, network_type, volume_mb, amount, status, failure_reason, provider_response, created_at').order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabase.from('public_data_orders').select('id, payment_reference, short_code, provider_name, provider_reference, customer_phone, customer_name, network_type, volume_mb, sale_amount, status, provider_response, created_at').order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabase.from('orders').select('id, reference, short_code, network, bundle_size, recipient_phone, amount, status, created_at').order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabase.from('store_orders').select('id, reference, short_code, provider, provider_reference, provider_response, recipient, customer_phone, network, product_label, platform_price, sale_amount, payment_status, fulfilment_status, failure_reason, created_at').order('created_at', { ascending: false }).range(from, to)),
      supabase.from('bundle_catalog').select('bundle_id, network, title, volume_mb, price, provider_cost, active, inactive_reason, updated_at').order('network').order('volume_mb'),
    ]);

    const agentOrderRows = (agentOrders || []).map((o) => {
      const resp = (o.provider_response && typeof o.provider_response === 'object') ? o.provider_response : {};
      const provider = String(o.provider_name || ((o.network_type === 'mtn' && o.volume_mb === 1024) || (o.network_type === 'telecel' && o.volume_mb === 5120) ? 'GrandTech' : 'Swift'));
      const providerStatus = safeProviderStatus(resp.lastProviderStatus || resp.status || o.status);
      const isCancelled = o.status === 'cancelled' || resp.cancelled === true;
      const orderId = fiveCharacterAdminOrderCode(o.short_code || o.provider_reference || o.id);
      return {
        id: o.id,
        orderId,
        kind: 'data',
        reference: o.provider_reference,
        shortCode: o.short_code || '',
        phone: o.phone,
        network: o.network_type,
        amount: Number(o.amount || 0),
        status: isCancelled ? 'cancelled' : o.status,
        provider,
        providerStatus,
        isCancelled,
        failureReason: o.failure_reason,
        createdAt: o.created_at,
        type: 'Data Bundle (Agent Dashboard)',
        packageSize: formatVolumeInGb(`${o.volume_mb}MB`, o.volume_mb),
      };
    });

    const publicOrderRows = (publicOrders || []).map((o) => {
      const resp = (o.provider_response && typeof o.provider_response === 'object') ? o.provider_response : {};
      const provider = String(o.provider_name || resp.provider || 'Swift');
      const providerStatus = safeProviderStatus(resp.lastProviderStatus || resp.status || o.status);
      const isCancelled = o.status === 'cancelled' || resp.cancelled === true;
      const orderId = fiveCharacterAdminOrderCode(o.short_code || o.payment_reference || o.id);
      return {
        id: o.id,
        orderId,
        kind: 'public_data',
        reference: o.payment_reference,
        shortCode: o.short_code || '',
        phone: o.customer_phone,
        network: o.network_type,
        amount: Number(o.sale_amount || 0),
        status: isCancelled ? 'cancelled' : o.status,
        provider,
        providerStatus,
        isCancelled,
        failureReason: '',
        createdAt: o.created_at,
        type: 'Data Bundle (Agent Dashboard, Public)',
        packageSize: formatVolumeInGb(`${o.volume_mb}MB`, o.volume_mb),
      };
    });

    const legacyOrderRows = (legacyOrders || []).map((o) => ({
      id: o.id,
      orderId: fiveCharacterAdminOrderCode(o.short_code || o.reference || o.id),
      kind: 'legacy',
      reference: o.reference || o.id,
      shortCode: o.short_code || '',
      phone: o.recipient_phone,
      network: o.network,
      amount: Number(o.amount || 0),
      status: o.status || 'completed',
      provider: 'Wallet order',
      providerStatus: safeProviderStatus(o.status, 'COMPLETED'),
      isCancelled: false,
      failureReason: '',
      createdAt: o.created_at,
      type: 'Legacy Data Bundle',
      packageSize: o.bundle_size || 'Data bundle',
    }));

    const storeOrderRows = (storeOrders || []).map((o) => {
      const resp = (o.provider_response && typeof o.provider_response === 'object') ? o.provider_response : {};
      const status = o.fulfilment_status || (o.payment_status === 'paid' ? 'processing' : o.payment_status || 'pending');
      return {
        id: o.id,
        orderId: fiveCharacterAdminOrderCode(o.short_code || o.reference || o.id),
        kind: 'legacy',
        reference: o.reference,
        shortCode: o.short_code || '',
        phone: o.recipient || o.customer_phone,
        network: o.network,
        amount: Number(o.platform_price || o.sale_amount || 0),
        status,
        provider: o.provider || 'Swift',
        providerStatus: safeProviderStatus(resp.lastProviderStatus || resp.providerStatus || status),
        isCancelled: status === 'cancelled',
        failureReason: o.failure_reason || '',
        createdAt: o.created_at,
        type: 'Data Bundle (Agent Wallet)',
        packageSize: o.product_label || 'Data bundle',
      };
    });

    cachedDataOrders = [...agentOrderRows, ...publicOrderRows, ...legacyOrderRows, ...storeOrderRows].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    renderDataOrders(cachedDataOrders);
    renderDataStock(catalogRes.data || []);

    // Refresh open orders from their assigned provider before the admin relies
    // on a stored "processing" label. Limit one tab refresh to 15 provider
    // calls so a large history cannot block the portal.
    if (syncLive) {
      const activeOrders = cachedDataOrders.filter((o) =>
        o.kind !== 'legacy' && ['pending', 'processing'].includes(String(o.status).toLowerCase())
      );
      if (activeOrders.length) {
        const changed = await syncActiveDataOrders(activeOrders.slice(0, 15));
        if (changed > 0) await loadDataModuleData({ syncLive: false });
      }
    }

  } catch (err) {
    console.error('loadDataModuleData error:', err);
    showToast('Failed to load data module: ' + err.message, 'error');
  }
}

function renderDataOrders(orders) {
  const tbody = document.getElementById('dataOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 16px;">No data orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const netClass = o.network === 'mtn' ? 'badge-mtn' : o.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const rawStatus = String(o.status || '').toLowerCase();
    const isCancelled = rawStatus === 'cancelled' || o.isCancelled;
    const isSuccess = ['success', 'successful', 'completed', 'delivered'].includes(rawStatus);
    const isFailed = rawStatus === 'failed';
    const isPending = !isSuccess && !isFailed && !isCancelled;
    const providerStatus = safeProviderStatus(
      o?.providerStatus,
      isCancelled ? 'CANCELLED' : isSuccess ? 'DELIVERED' : isFailed ? 'FAILED' : 'PENDING',
    );

    let statusBadge = '';
    if (isCancelled) {
      statusBadge = `<span class="badge badge-failed"><i class="fa-solid fa-ban"></i> Cancelled</span>`;
    } else if (isSuccess) {
      statusBadge = `<span class="badge badge-success"><i class="fa-solid fa-check"></i> ${escapeHtml(providerStatus.toUpperCase())}</span>`;
    } else if (isFailed) {
      statusBadge = `<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> ${escapeHtml(providerStatus.toUpperCase())}</span>`;
    } else {
      statusBadge = `<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> ${escapeHtml(providerStatus.toUpperCase())}</span>`;
    }

    const providerBadge = `<span class="badge ${String(o.provider || '').toLowerCase().includes('grand') ? 'badge-primary' : 'badge-network'}">${escapeHtml(o.provider || 'Swift')}</span>`;

    let actions = '';
    if (o.kind === 'legacy') {
      actions = '<span style="color: var(--text-dim); font-size: 0.75rem;">Recorded wallet order</span>';
    } else if (isCancelled) {
      actions = `<span class="badge badge-failed" style="opacity: 0.8;"><i class="fa-solid fa-ban"></i> Cancelled</span>`;
    } else if (isPending) {
      actions = `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-secondary btn-sm" onclick="syncOrderStatus('${o.kind}', '${o.id}')" title="Sync live status with provider">
            <i class="fa-solid fa-arrows-rotate"></i> Sync
          </button>
          <button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('${o.kind}', '${o.id}', '${escapeHtml(o.reference)}', ${o.amount})" title="Cancel & Refund">
            <i class="fa-solid fa-ban"></i> Cancel
          </button>
        </div>
      `;
    } else if (isFailed) {
      actions = `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-secondary btn-sm" onclick="retryDataOrder('${o.id}', '${o.type}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>
          <button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('${o.kind}', '${o.id}', '${escapeHtml(o.reference)}', ${o.amount})" title="Cancel & Refund">
            <i class="fa-solid fa-ban"></i> Cancel
          </button>
        </div>
      `;
    } else {
      actions = `
        <button class="btn btn-secondary btn-sm" onclick="syncOrderStatus('${o.kind}', '${o.id}')" title="Re-check provider status">
          <i class="fa-solid fa-arrows-rotate"></i> Sync
        </button>
      `;
    }

    const eventButton = o.kind === 'legacy'
      ? ''
      : `<button class="btn btn-secondary btn-sm" onclick="openProviderStatusHistory('${o.kind}', '${o.id}')" title="View provider status events">
          <i class="fa-solid fa-list-check"></i> Events
        </button>`;

    return `
      <tr>
        <td><strong style="color: var(--primary); font-family: monospace;">${escapeHtml(fiveCharacterAdminOrderCode(o.shortCode || o.orderId || o.reference))}</strong></td>
        <td><span class="badge badge-network">${escapeHtml(o.type || 'Data Order')}</span></td>
        <td>${escapeHtml(o.phone)}</td>
        <td><span class="badge ${netClass}">${escapeHtml((o.network || '').toUpperCase())}</span></td>
        <td><span class="badge badge-network" style="font-weight: 700;">${escapeHtml(o.packageSize)}</span></td>
        <td><strong>${money(o.amount)}</strong></td>
        <td>${providerBadge}</td>
        <td>${statusBadge}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(o.createdAt).toLocaleString()}</td>
        <td><div style="display: flex; flex-wrap: wrap; gap: 4px; align-items: center;">${eventButton}${actions}</div></td>
      </tr>
    `;
  }).join('');
}

function filterDataOrders() {
  const query = (document.getElementById('dataOrderSearch')?.value || '').toLowerCase();
  const net = document.getElementById('dataNetworkFilter')?.value || 'all';
  const stat = document.getElementById('dataStatusFilter')?.value || 'all';

  const filtered = cachedDataOrders.filter((o) => {
    const matchQ = String(o.phone || '').toLowerCase().includes(query) || String(o.reference || '').toLowerCase().includes(query);
    const matchNet = net === 'all' || (o.network || '').toLowerCase() === net.toLowerCase();
    const matchStat = stat === 'all' ||
      (stat === 'success' && (o.status === 'success' || o.status === 'successful' || o.status === 'completed' || o.status === 'delivered')) ||
      (stat === 'pending' && (o.status === 'pending' || o.status === 'processing')) ||
      (stat === 'failed' && o.status === 'failed') ||
      (stat === 'cancelled' && o.status === 'cancelled');

    return matchQ && matchNet && matchStat;
  });

  renderDataOrders(filtered);
}

async function syncOrderStatus(orderType, orderId) {
  try {
    showToast('Querying live provider status (Swift / GrandTech / Hubtel)…', 'info');
    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'sync-order-status', orderType, orderId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (error) throw error;
    if (!data?.success) throw new Error(data?.error || data?.message || 'Provider did not return a definitive status.');

    showToast(data?.message || 'Provider status updated.', 'success');
    await loadDataModuleData({ syncLive: false });
  } catch (err) {
    console.error('syncOrderStatus error:', err);
    showToast('Provider check failed: ' + err.message, 'error');
  }
}

async function syncActiveDataOrders(orders) {
  const { data: { session } } = await supabase.auth.getSession();
  let updatedCount = 0;

  for (const order of orders) {
    try {
      const { data, error } = await supabase.functions.invoke('admin-portal-api', {
        body: { action: 'sync-order-status', orderType: order.kind, orderId: order.id },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (!error && data?.success) updatedCount++;
    } catch (_) { /* leave this order visible for the next reconciliation */ }
  }
  return updatedCount;
}

async function syncAllActiveDataOrders() {
  const pendingOrders = cachedDataOrders.filter(o => o.kind !== 'legacy' && (o.status === 'pending' || o.status === 'processing'));
  if (!pendingOrders.length) {
    showToast('No active pending/processing orders to sync.', 'info');
    return;
  }

  showToast(`Checking live provider status for ${pendingOrders.length} active orders…`, 'info');
  const updatedCount = await syncActiveDataOrders(pendingOrders.slice(0, 15));

  showToast(`Synchronized ${updatedCount} orders with live provider APIs (Swift, GrandTech).`, 'success');
  await loadDataModuleData({ syncLive: false });
}

function renderDataStock(standardCatalog) {
  const allItems = standardCatalog.map(c => ({
      id: c.bundle_id,
      title: c.title,
      network: c.network,
      volume: formatVolumeInGb(`${c.volume_mb}MB`, c.volume_mb),
      price: c.price,
      cost: c.provider_cost || '—',
      packageId: c.bundle_id,
      isAvailable: c.active,
      updatedAt: c.updated_at,
      catalogType: 'bundle_catalog',
      catalogGroup: 'standard',
      typeLabel: 'Data Bundle (Agent Dashboard)',
    }));

  cachedDataStockItems = allItems;
  renderDataStockRows(allItems);
}

function renderDataStockRows(items) {
  const section = document.getElementById('dataStandardCatalogSection');
  const tbody = document.getElementById('dataStandardStockTbody');
  if (!section || !tbody) return;
  const visible = items.filter((item) => item.catalogGroup === 'standard');
  section.style.display = '';

  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 16px;">No catalog packages mapped.</td></tr>';
    return;
  }

  tbody.innerHTML = visible.map((item) => {
    const netClass = item.network === 'mtn' ? 'badge-mtn' : item.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const statusText = item.isAvailable
      ? '<span class="badge badge-success">In Stock</span>'
      : '<span class="badge badge-failed">Out of Stock</span>';

    return `
      <tr>
        <td><span class="badge badge-network">${item.typeLabel}</span></td>
        <td><span>${escapeHtml(item.title)}</span></td>
        <td><span class="badge ${netClass}">${escapeHtml((item.network || '').toUpperCase())}</span></td>
        <td>${escapeHtml(item.volume)}</td>
        <td id="bundlePrice-${item.id}"><strong>${money(item.price)}</strong></td>
        <td>${item.cost !== '—' ? money(item.cost) : '—'}</td>
        <td><code>${escapeHtml(item.packageId)}</code></td>
        <td id="stockStatus-${item.id}">${statusText}</td>
        <td style="font-size: 0.75rem; color: var(--text-muted);">${item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}</td>
        <td>
          <label class="switch">
            <input type="checkbox" ${item.isAvailable ? 'checked' : ''} onchange="toggleStockAvailability('${item.id}', this.checked, '${item.catalogType}')">
            <span class="slider"></span>
          </label>
        </td>
        <td>
          <button class="btn btn-secondary btn-sm" onclick="openEditBundlePriceModal('${item.id}', '${escapeHtml(item.title)}', '${item.network}', ${Number(item.price)}, '${item.catalogType}')">
            <i class="fa-solid fa-pen-to-square"></i> Change Price
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

function filterDataCatalog(group) {
  currentDataCatalogFilter = group === 'standard' ? 'standard' : 'standard';
  document.querySelectorAll('[data-data-catalog-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.dataCatalogFilter === currentDataCatalogFilter);
  });
  renderDataStockRows(cachedDataStockItems);
}

async function toggleStockAvailability(bundleId, isAvailable, catalogType) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'toggle-data-stock', bundleId, isAvailable, catalogType },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Stock toggle failed');
    }

    const statusEl = document.getElementById(`stockStatus-${bundleId}`);
    if (statusEl) {
      statusEl.innerHTML = isAvailable
        ? '<span class="badge badge-success">In Stock</span>'
        : '<span class="badge badge-failed">Out of Stock</span>';
    }

    showToast(`Stock updated: Item marked ${isAvailable ? 'In Stock' : 'Out of Stock'}.`, 'success');
  } catch (err) {
    console.error('toggleStockAvailability error:', err);
    showToast(err.message, 'error');
  }
}

async function retryDataOrder(orderId, orderType) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'retry-data-order', orderId, orderType },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Retry failed');
    }

    showToast('Order successfully marked for redelivery.', 'success');
    loadDataModuleData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// MODULE 3: AIRTIME DISPATCH (Hubtel 002040687)
// -----------------------------------------------------------------------------
async function loadAirtimeData() {
  try {
    const { data: airtimeOrders, error } = await supabase
      .from('airtime_orders')
      .select('id, payment_reference, short_code, recipient_phone, network, amount, fee_amount, gross_amount, payment_method, payment_status, airtime_status, provider_reference, failure_reason, customer_name, customer_email, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    cachedAirtimeOrders = airtimeOrders || [];
    renderAirtimeOrders(cachedAirtimeOrders);
  } catch (err) {
    console.error('loadAirtimeData error:', err);
    showToast(err.message, 'error');
  }
}

function renderAirtimeOrders(orders) {
  const tbody = document.getElementById('airtimeOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No airtime orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const netClass = o.network === 'mtn' ? 'badge-mtn' : o.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const statusBadge = o.airtime_status === 'delivered'
      ? '<span class="badge badge-success">Delivered</span>'
      : o.airtime_status === 'failed'
      ? '<span class="badge badge-failed">Failed</span>'
      : '<span class="badge badge-pending">Processing</span>';

    const isPending = o.airtime_status === 'pending' || o.airtime_status === 'processing';
    const retryBtn = isPending
      ? `<div style="display: flex; gap: 4px;">
           <button class="btn btn-secondary btn-sm" onclick="retryAirtimeOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>
           <button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('airtime', '${o.id}', '${escapeHtml(o.payment_reference)}', ${o.amount})" title="Cancel & Refund"><i class="fa-solid fa-ban"></i> Cancel</button>
         </div>`
      : o.airtime_status === 'failed'
      ? `<button class="btn btn-secondary btn-sm" onclick="retryAirtimeOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    const orderDisplayId = o.short_code ? '#' + o.short_code : escapeHtml(o.payment_reference);
    return `
      <tr>
        <td><strong style="color: var(--primary);">${orderDisplayId}</strong></td>
        <td>${escapeHtml(o.recipient_phone)}</td>
        <td><span class="badge ${netClass}">${escapeHtml((o.network || '').toUpperCase())}</span></td>
        <td><strong>${money(o.amount)}</strong></td>
        <td><span class="badge badge-network">${escapeHtml(o.payment_status || 'paid')}</span></td>
        <td>${statusBadge}</td>
        <td><code>${escapeHtml(o.provider_reference || '—')}</code></td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(o.created_at).toLocaleString()}</td>
        <td>${retryBtn}</td>
      </tr>
    `;
  }).join('');
}

async function handleAirtimeDispatch(event) {
  event.preventDefault();
  const btn = document.getElementById('btnDispatchAirtime');
  const network = document.getElementById('airtimeNetworkSelect').value;
  const phone = document.getElementById('airtimePhoneInput').value.trim();
  const amount = parseFloat(document.getElementById('airtimeAmountInput').value);

  if (!phone || isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid phone and amount.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dispatching via Hubtel…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'dispatch-airtime', network, phone, amount },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.failureReason || res.data?.error || 'Airtime dispatch failed');
    }

    showToast(`Airtime of GHS ${amount.toFixed(2)} dispatched to ${phone}! Status: ${res.data.status}`, 'success');
    document.getElementById('airtimeDispatchForm').reset();
    await loadAirtimeData();
  } catch (err) {
    console.error('handleAirtimeDispatch error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Execute Airtime Dispatch';
  }
}

async function retryAirtimeOrder(orderId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'retry-airtime-order', orderId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Retry failed');
    showToast('Airtime dispatch retried!', 'success');
    loadAirtimeData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// MODULE 4: UTILITY BILLS (ECG Prepaid/Postpaid, Water, DStv, GOtv, StarTimes)
// -----------------------------------------------------------------------------
function selectUtilityService(serviceKey) {
  currentUtilityService = serviceKey;

  // Update active pill
  document.querySelectorAll('.service-pill-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.service === serviceKey);
  });

  const accountLabel = document.getElementById('utilityAccountLabel');
  const accountInput = document.getElementById('utilityAccountInput');
  const tvPackageGroup = document.getElementById('utilityTvPackageGroup');
  const meterTypeGroup = document.getElementById('utilityMeterTypeGroup');
  const meterTypeSelect = document.getElementById('utilityMeterTypeSelect');
  const amountInput = document.getElementById('utilityAmountInput');

  // Configure UI based on selected service
  if (serviceKey === 'ecg_prepaid') {
    accountLabel.textContent = 'ECG Prepaid Meter Number';
    accountInput.placeholder = 'e.g. P12345678';
    meterTypeGroup.style.display = 'flex';
    meterTypeSelect.value = 'prepaid';
    tvPackageGroup.style.display = 'none';
  } else if (serviceKey === 'ecg_postpaid') {
    accountLabel.textContent = 'ECG Postpaid Account Number';
    accountInput.placeholder = 'e.g. 102938475';
    meterTypeGroup.style.display = 'flex';
    meterTypeSelect.value = 'postpaid';
    tvPackageGroup.style.display = 'none';
  } else if (serviceKey === 'ghana_water') {
    accountLabel.textContent = 'GWCL Customer Account Number';
    accountInput.placeholder = 'e.g. GW-84920492';
    meterTypeGroup.style.display = 'none';
    tvPackageGroup.style.display = 'none';
  } else if (['dstv', 'gotv', 'startimes'].includes(serviceKey)) {
    meterTypeGroup.style.display = 'none';
    tvPackageGroup.style.display = 'flex';

    if (serviceKey === 'dstv') {
      accountLabel.textContent = 'DStv Smartcard Number';
      accountInput.placeholder = 'e.g. 1029384756';
    } else if (serviceKey === 'gotv') {
      accountLabel.textContent = 'GOtv IUC / Decoder Number';
      accountInput.placeholder = 'e.g. 2019283746';
    } else {
      accountLabel.textContent = 'StarTimes Smartcard / e-Code';
      accountInput.placeholder = 'e.g. 01827364521';
    }

    // Populate TV Packages
    const select = document.getElementById('utilityTvPackageSelect');
    const packages = TV_PACKAGES[serviceKey] || [];
    select.innerHTML = packages.map((pkg, idx) =>
      `<option value="${escapeHtml(pkg.name)}" data-price="${pkg.price}">${escapeHtml(pkg.name)} ${pkg.price > 0 ? `(GHS ${pkg.price}.00)` : ''}</option>`
    ).join('');

    handleTvPackageChange();
  }
}

function handleTvPackageChange() {
  const select = document.getElementById('utilityTvPackageSelect');
  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) return;

  const price = parseFloat(selectedOpt.getAttribute('data-price')) || 0;
  const amountInput = document.getElementById('utilityAmountInput');
  if (price > 0) {
    amountInput.value = price.toFixed(2);
  } else {
    amountInput.value = '';
    amountInput.placeholder = 'Enter custom amount';
  }
}

async function verifyUtilityAccount() {
  let account = document.getElementById('utilityAccountInput').value.trim();
  if (/^\+?233([A-Za-z].*)$/.test(account)) {
    account = account.replace(/^\+?233/, '');
    document.getElementById('utilityAccountInput').value = account;
  } else if (/^\+?233(\d{8,16})$/.test(account)) {
    account = account.replace(/^\+?233/, '');
    document.getElementById('utilityAccountInput').value = account;
  }
  if (!account) {
    showToast('Enter account or meter number to verify.', 'error');
    return;
  }

  showToast('Verifying account with provider…', 'success');
  const phone = document.getElementById('utilityPhoneInput')?.value?.trim() || '';
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'verify-utility-account', accountNumber: account, service: currentUtilityService, phone, mobile: phone },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.data?.message || 'Account verification unconfirmed');
    document.getElementById('utilityCustomerNameInput').value = res.data.customerName || 'Verified Customer';
    showToast(`Account Verified: ${res.data.customerName}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleUtilityDispatch(event) {
  event.preventDefault();
  const btn = document.getElementById('btnDispatchUtility');
  let accountNumber = document.getElementById('utilityAccountInput').value.trim();
  if (/^\+?233([A-Za-z].*)$/.test(accountNumber)) {
    accountNumber = accountNumber.replace(/^\+?233/, '');
    document.getElementById('utilityAccountInput').value = accountNumber;
  } else if (/^\+?233(\d{8,16})$/.test(accountNumber)) {
    accountNumber = accountNumber.replace(/^\+?233/, '');
    document.getElementById('utilityAccountInput').value = accountNumber;
  }
  const customerName = document.getElementById('utilityCustomerNameInput').value.trim();
  const meterType = document.getElementById('utilityMeterTypeSelect').value;
  const amount = parseFloat(document.getElementById('utilityAmountInput').value);
  const phone = document.getElementById('utilityPhoneInput').value.trim() || '0500000000';
  const packageName = ['dstv', 'gotv', 'startimes'].includes(currentUtilityService)
    ? document.getElementById('utilityTvPackageSelect').value
    : '';

  if (!accountNumber || isNaN(amount) || amount <= 0) {
    showToast('Please provide valid account number and amount.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Payment…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: {
        action: 'dispatch-utility',
        service: currentUtilityService,
        accountNumber,
        customerName,
        meterType,
        amount,
        packageName,
        phone
      },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.message || 'Payment processing failed');

    const tokenMsg = res.data.token ? ` Token: ${res.data.token}` : '';
    showToast(`Utility payment of GHS ${amount.toFixed(2)} successful!${tokenMsg}`, 'success');
    document.getElementById('utilityDispatchForm').reset();
    selectUtilityService(currentUtilityService);
    await loadUtilityData();
  } catch (err) {
    console.error('handleUtilityDispatch error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Process Payment';
  }
}

async function loadUtilityData() {
  try {
    const { data: utilityOrders, error } = await supabase
      .from('utility_orders')
      .select('id, payment_reference, bill_type, bill_category, account_number, meter_type, package_name, customer_name, customer_phone, amount, fee_amount, gross_amount, status, token_code, provider_reference, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (error) throw error;

    cachedUtilityOrders = utilityOrders || [];
    renderUtilityOrders(cachedUtilityOrders);
  } catch (err) {
    console.error('loadUtilityData error:', err);
    showToast(err.message, 'error');
  }
}

function filterUtilityOrders(category) {
  currentUtilityCategoryFilter = category;
  document.querySelectorAll('#section-utility-module .sub-tabs .sub-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(category) || (category === 'all' && btn.textContent.includes('All')));
  });

  if (category === 'all') {
    renderUtilityOrders(cachedUtilityOrders);
  } else {
    const filtered = cachedUtilityOrders.filter(o => (o.bill_category || '').toLowerCase() === category.toLowerCase());
    renderUtilityOrders(filtered);
  }
}

function renderUtilityOrders(orders) {
  const tbody = document.getElementById('utilityOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No utility orders recorded.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const statusBadge = o.status === 'completed'
      ? '<span class="badge badge-success">Completed</span>'
      : o.status === 'failed'
      ? '<span class="badge badge-failed">Failed</span>'
      : '<span class="badge badge-pending">Processing</span>';

    const tokenHtml = o.token_code
      ? `<strong style="letter-spacing: 0.5px; color: #34d399;">${escapeHtml(o.token_code)}</strong>
         <button class="btn btn-secondary btn-sm" style="margin-left: 4px; padding: 2px 5px;" onclick="copyToClipboard('${o.token_code}')"><i class="fa-regular fa-copy"></i></button>`
      : `<code>${escapeHtml(o.provider_reference || '—')}</code>`;

    const isPending = o.status === 'processing' || o.status === 'pending';
    const retryBtn = isPending
      ? `<div style="display: flex; gap: 4px;">
           <button class="btn btn-secondary btn-sm" onclick="retryUtilityOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>
           <button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('utility', '${o.id}', '${escapeHtml(o.payment_reference)}', ${o.amount})" title="Cancel & Refund"><i class="fa-solid fa-ban"></i> Cancel</button>
         </div>`
      : o.status === 'failed'
      ? `<button class="btn btn-secondary btn-sm" onclick="retryUtilityOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    const serviceDisplay = o.bill_type === 'ecg'
      ? `ECG (${(o.meter_type || 'prepaid').toUpperCase()})`
      : o.bill_type === 'ghana_water'
      ? 'GWCL Water'
      : (o.bill_type || 'TV').toUpperCase();

    return `
      <tr>
        <td><span class="badge badge-network">${escapeHtml(serviceDisplay)}</span></td>
        <td><code>${escapeHtml(o.account_number)}</code></td>
        <td>${escapeHtml(o.customer_name || 'Customer')}</td>
        <td>${escapeHtml(o.package_name || o.meter_type || 'Standard')}</td>
        <td><strong>${money(o.amount)}</strong></td>
        <td>${statusBadge}</td>
        <td>${tokenHtml}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(o.created_at).toLocaleString()}</td>
        <td>${retryBtn}</td>
      </tr>
    `;
  }).join('');
}

async function retryUtilityOrder(orderId) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'retry-utility-order', orderId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Retry failed');
    showToast('Utility payment retried successfully!', 'success');
    loadUtilityData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// MODULE 5: AGENT STORE MANAGEMENT (LIVE DIRECT DB)
// -----------------------------------------------------------------------------
async function loadStoresData() {
  try {
    const [storesRes, ordersRes] = await Promise.all([
      supabase.from('agent_stores').select('id, agent_id, slug, display_name, is_active, suspended_reason, created_at, agents(full_name, phone, agent_code)').order('created_at', { ascending: false }),
      supabase.from('store_orders').select('id, store_id, agent_id, reference, short_code, product_type, product_label, sale_amount, agent_earning, platform_revenue, payment_status, fulfilment_status, customer_name, customer_phone, created_at').order('created_at', { ascending: false }).limit(60)
    ]);

    renderStoresList(storesRes.data || []);
    renderStoreOrders(ordersRes.data || []);
  } catch (err) {
    console.error('loadStoresData error:', err);
    showToast(err.message, 'error');
  }
}

function renderStoresList(stores) {
  const tbody = document.getElementById('storesListTbody');
  if (!tbody) return;

  if (!stores.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 16px;">No agent stores registered yet.</td></tr>';
    return;
  }

  tbody.innerHTML = stores.map((s) => {
    const owner = Array.isArray(s.agents) ? s.agents[0] : s.agents;
    const statusPill = s.is_active
      ? '<span class="badge badge-success">Open</span>'
      : '<span class="badge badge-failed">Paused</span>';

    const toggleBtn = s.is_active
      ? `<button class="btn btn-danger btn-sm" onclick="toggleStoreStatus('${s.id}', false)"><i class="fa-solid fa-pause"></i> Pause</button>`
      : `<button class="btn btn-primary btn-sm" onclick="toggleStoreStatus('${s.id}', true)"><i class="fa-solid fa-play"></i> Re-open</button>`;

    return `
      <tr>
        <td><span>${escapeHtml(s.display_name || 'Store')}</span></td>
        <td><a href="/store/${encodeURIComponent(s.slug)}" target="_blank" style="color: #60a5fa; text-decoration: none;">/${escapeHtml(s.slug)}</a></td>
        <td>${escapeHtml(owner?.full_name || 'Owner')}</td>
        <td><code>${escapeHtml(owner?.agent_code || '—')}</code></td>
        <td>${statusPill}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(s.created_at).toLocaleDateString()}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            ${toggleBtn}
            <a href="/storefront.html?ref=${encodeURIComponent(s.slug)}" target="_blank" class="btn btn-secondary btn-sm"><i class="fa-solid fa-eye"></i> View</a>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function toggleStoreStatus(storeId, isActive) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'toggle-store-status', storeId, isActive },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.data?.error || res.error?.message || 'Failed to toggle store status');
    }
    showToast(`Store ${isActive ? 're-opened' : 'paused'} successfully!`, 'success');
    loadStoresData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveCommissionRates() {
  const serviceName = document.getElementById('commissionServiceSelect').value;
  const commissionPercent = parseFloat(document.getElementById('commissionPercentInput').value);
  const merchantShare = parseFloat(document.getElementById('merchantShareInput').value);
  const hubtelShare = parseFloat(document.getElementById('hubtelShareInput').value);

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'update-commission-rates', serviceName, commissionPercent, merchantShare, hubtelShare },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.data?.error || res.error?.message || 'Failed to save commission rates');
    }
    showToast('Commission configuration saved successfully!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStoreOrders(orders) {
  const tbody = document.getElementById('storeOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No store orders recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => `
    <tr>
      <td><span>${escapeHtml(o.reference)}</span></td>
      <td>${escapeHtml(o.product_label || o.product_type)}</td>
      <td>${escapeHtml(o.customer_name || 'Customer')}</td>
      <td><strong>${money(o.sale_amount)}</strong></td>
      <td style="color: #34d399;">${money(o.agent_earning)}</td>
      <td style="color: #60a5fa;">${money(o.platform_revenue)}</td>
      <td><span class="badge ${o.payment_status === 'paid' ? 'badge-success' : 'badge-pending'}">${escapeHtml(o.payment_status)}</span></td>
      <td><span class="badge ${o.fulfilment_status === 'successful' ? 'badge-success' : 'badge-pending'}">${escapeHtml(o.fulfilment_status)}</span></td>
      <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(o.created_at).toLocaleString()}</td>
    </tr>
  `).join('');
}

// -----------------------------------------------------------------------------
// MODULE 6: USER & AGENT WALLETS (LIVE DIRECT DB)
// -----------------------------------------------------------------------------
async function loadWalletsData() {
  try {
    const [walletsRes, agentsRes, profilesRes] = await Promise.all([
      supabase.from('wallets').select('id, balance, sales, deposits, commission_balance, total_commission_earned, updated_at'),
      supabase.from('agents').select('id, full_name, phone, agent_code, role, created_at'),
      supabase.from('profiles').select('id, full_name, phone, agent_code')
    ]);
    if (walletsRes.error) throw walletsRes.error;
    if (agentsRes.error) throw agentsRes.error;
    if (profilesRes.error) throw profilesRes.error;

    const agentMap = new Map();
    for (const a of agentsRes.data || []) agentMap.set(a.id, a);

    const profileMap = new Map();
    for (const p of profilesRes.data || []) profileMap.set(p.id, p);

    cachedWallets = (walletsRes.data || []).map((w) => {
      const a = agentMap.get(w.id);
      const p = profileMap.get(w.id);
      return {
        id: w.id,
        fullName: a?.full_name || p?.full_name || 'Agent/User',
        phone: a?.phone || p?.phone || '',
        agentCode: a?.agent_code || p?.agent_code || '',
        role: a?.role || 'agent',
        balance: Number(w.balance || 0),
        sales: Number(w.sales || 0),
        deposits: Number(w.deposits || 0),
        commissionBalance: Number(w.commission_balance || 0),
        totalCommissionEarned: Number(w.total_commission_earned || 0),
        updatedAt: w.updated_at,
      };
    });

    renderWallets(cachedWallets);
  } catch (err) {
    console.error('loadWalletsData error:', err);
    showToast(err.message, 'error');
  }
}

function renderWallets(wallets) {
  const tbody = document.getElementById('walletsListTbody');
  if (!tbody) return;

  if (!wallets.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No wallets found.</td></tr>';
    return;
  }

  tbody.innerHTML = wallets.map((w) => {
    const rolePill = w.role === 'super_admin'
      ? '<span class="badge" style="background: linear-gradient(135deg, #7c3aed, #2563eb); color: #fff;">Super Admin</span>'
      : w.role === 'admin'
      ? '<span class="badge badge-network" style="color: #60a5fa;">Admin</span>'
      : '<span class="badge badge-network">Agent</span>';

    return `
      <tr>
        <td><span>${escapeHtml(w.fullName)}</span></td>
        <td>${rolePill}</td>
        <td><code>${escapeHtml(w.agentCode || '—')}</code></td>
        <td>${escapeHtml(w.phone || '—')}</td>
        <td><strong style="color: #60a5fa;">${money(w.balance)}</strong></td>
        <td style="color: #34d399;">${money(w.commissionBalance)}</td>
        <td>${money(w.deposits)}</td>
        <td>${money(w.sales)}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            <button class="btn btn-primary btn-sm" onclick="openWalletModal('${w.id}', '${escapeHtml(w.fullName)}', ${w.balance})">
              <i class="fa-solid fa-plus-minus"></i> Credit / Debit
            </button>
            <button class="btn btn-danger btn-sm" onclick="openRefundModal('${w.id}', '${escapeHtml(w.fullName)}', ${w.balance})" title="Refund agent wallet">
              <i class="fa-solid fa-rotate-left"></i> Refund
            </button>
            <button class="btn btn-secondary btn-sm" onclick="openHistoryModal('${w.id}', '${escapeHtml(w.fullName)}')">
              <i class="fa-solid fa-clock-rotate-left"></i> History
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterWallets() {
  const query = (document.getElementById('walletSearchInput')?.value || '').toLowerCase();
  const filtered = cachedWallets.filter(w =>
    String(w.fullName || '').toLowerCase().includes(query) ||
    String(w.phone || '').toLowerCase().includes(query) ||
    String(w.agentCode || '').toLowerCase().includes(query)
  );
  renderWallets(filtered);
}

function openWalletModal(userId, fullName, currentBal) {
  selectedWalletUser = { id: userId, name: fullName, balance: currentBal };
  document.getElementById('walletModalUserInfo').innerHTML = `
    <span>User:</span> <strong>${escapeHtml(fullName)}</strong> |
    <span>Current Balance:</span> <span style="color: #60a5fa; font-weight: 600;">${money(currentBal)}</span>
  `;
  document.getElementById('adjustAmountInput').value = '';
  document.getElementById('adjustReasonInput').value = '';
  document.getElementById('walletAdjustModal').classList.add('open');
}

function closeWalletModal() {
  document.getElementById('walletAdjustModal').classList.remove('open');
  selectedWalletUser = null;
}

async function submitWalletAdjustment() {
  if (!selectedWalletUser) return;
  const btn = document.getElementById('btnConfirmAdjust');
  const type = document.getElementById('adjustTypeSelect').value;
  const amount = parseFloat(document.getElementById('adjustAmountInput').value);
  const reason = document.getElementById('adjustReasonInput').value.trim();

  if (isNaN(amount) || amount <= 0 || !reason) {
    showToast('Please enter a valid amount and audit reason.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing…';

  try {
    const { data, error } = await supabase.rpc('admin_adjust_wallet', {
      p_user_id: selectedWalletUser.id,
      p_amount: amount,
      p_type: type,
      p_reason: reason,
      p_admin_id: currentUser.id,
    });

    if (error) throw error;

    showToast(`Wallet ${type === 'credit' ? 'credited' : 'debited'} with GHS ${amount.toFixed(2)} successfully!`, 'success');
    closeWalletModal();
    loadWalletsData();
  } catch (err) {
    console.error('submitWalletAdjustment error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Confirm Adjustment';
  }
}

let selectedRefundAgent = null;

function openRefundModal(agentId, fullName, currentBalance) {
  selectedRefundAgent = { id: agentId, name: fullName, balance: currentBalance };
  const info = document.getElementById('refundModalAgentInfo');
  if (info) {
    info.innerHTML = `<span>Agent:</span> <strong>${escapeHtml(fullName)}</strong> |
      <span>Current Balance:</span> <strong style="color: #60a5fa;">${money(currentBalance)}</strong>`;
  }
  document.getElementById('refundAmountInput').value = '';
  document.getElementById('refundReasonInput').value = '';
  document.getElementById('agentRefundModal').classList.add('open');
}

function closeRefundModal() {
  selectedRefundAgent = null;
  document.getElementById('agentRefundModal')?.classList.remove('open');
}

async function submitAgentRefund() {
  if (!selectedRefundAgent) return;
  const amount = Number(document.getElementById('refundAmountInput')?.value);
  const reason = document.getElementById('refundReasonInput')?.value.trim() || '';
  const btn = document.getElementById('btnConfirmRefund');

  if (!Number.isFinite(amount) || amount <= 0 || !reason) {
    showToast('Enter a positive refund amount and a clear reason.', 'error');
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Refunding…';
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: {
        action: 'refund-agent',
        agentId: selectedRefundAgent.id,
        amount,
        reason,
      },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });
    if (res.error || !res.data?.success) {
      throw new Error(res.data?.error || res.error?.message || 'Refund failed.');
    }

    showToast(`Refunded ${money(amount)} to ${selectedRefundAgent.name}.`, 'success');
    closeRefundModal();
    await loadWalletsData();
  } catch (err) {
    console.error('submitAgentRefund error:', err);
    showToast(err.message || 'Refund failed.', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i> Confirm Refund';
    }
  }
}

async function openHistoryModal(userId, fullName) {
  document.getElementById('historyModalTitle').textContent = `Audit History: ${fullName}`;
  document.getElementById('walletHistoryModal').classList.add('open');
  switchHistTab('tx');

  const txTbody = document.getElementById('histTxTbody');
  const topupTbody = document.getElementById('histTopupTbody');
  const refundTbody = document.getElementById('histRefundTbody');
  txTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading ledger…</td></tr>';
  topupTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading deposits…</td></tr>';
  refundTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading refunds…</td></tr>';

  try {
    const [txs, topups, refunds] = await Promise.all([
      fetchAllRows((from, to) => supabase.from('transactions').select('id, type, amount, balance_before, balance_after, description, status, created_at').eq('agent_id', userId).order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabase.from('wallet_topups').select('id, amount, payment_reference, status, provider, created_at, paid_at').eq('agent_id', userId).order('created_at', { ascending: false }).range(from, to)),
      fetchAllRows((from, to) => supabase.from('agent_wallet_refunds').select('id, amount, reference, reason, admin_id, created_at').eq('agent_id', userId).order('created_at', { ascending: false }).range(from, to)),
    ]);

    if (!txs.length) {
      txTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">No ledger transactions.</td></tr>';
    } else {
      txTbody.innerHTML = txs.map(t => `
        <tr>
          <td><span class="badge badge-network">${escapeHtml(t.type)}</span></td>
          <td><strong>${money(t.amount)}</strong></td>
          <td>${money(t.balance_before)}</td>
          <td>${money(t.balance_after)}</td>
          <td>${escapeHtml(t.description)}</td>
          <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(t.created_at).toLocaleString()}</td>
        </tr>
      `).join('');
    }

    if (!topups.length) {
      topupTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 14px;">No deposit records.</td></tr>';
    } else {
      topupTbody.innerHTML = topups.map(tp => `
        <tr>
          <td><code>${escapeHtml(tp.payment_reference)}</code></td>
          <td><strong>${money(tp.amount)}</strong></td>
          <td><span class="badge badge-network">${escapeHtml(tp.provider)}</span></td>
          <td><span class="badge ${tp.status === 'paid' ? 'badge-success' : 'badge-pending'}">${escapeHtml(tp.status)}</span></td>
          <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(tp.created_at).toLocaleString()}</td>
          <td style="color: var(--text-dim); font-size: 0.74rem;">${tp.paid_at ? new Date(tp.paid_at).toLocaleString() : '—'}</td>
        </tr>
      `).join('');
    }

    if (!refunds.length) {
      refundTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No manual refunds.</td></tr>';
    } else {
      refundTbody.innerHTML = refunds.map(refund => `
        <tr>
          <td><code>${escapeHtml(refund.reference)}</code></td>
          <td><strong style="color: #34d399;">${money(refund.amount)}</strong></td>
          <td>${escapeHtml(refund.reason)}</td>
          <td><code>${escapeHtml(refund.admin_id || '—')}</code></td>
          <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(refund.created_at).toLocaleString()}</td>
        </tr>
      `).join('');
    }

  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openProviderStatusHistory(orderType, orderId) {
  const modal = document.getElementById('providerStatusHistoryModal');
  const tbody = document.getElementById('providerStatusEventsTbody');
  if (!modal || !tbody) return;

  const order = cachedDataOrders.find((item) => item.kind === orderType && item.id === orderId);
  document.getElementById('providerStatusHistoryTitle').textContent =
    `Provider Events: ${order?.orderId || order?.reference || orderId}`;
  modal.classList.add('open');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading provider events…</td></tr>';

  const dbOrderType = orderType === 'public_data'
      ? 'public_data_orders'
      : 'agent_data_orders';

  try {
    const { data, error } = await supabase
      .from('provider_order_status_events')
      .select('provider, provider_status, internal_status, source, payload, created_at')
      .eq('order_type', dbOrderType)
      .eq('order_id', orderId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    if (!data?.length) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 14px;">No provider events recorded yet.</td></tr>';
      return;
    }

    tbody.innerHTML = data.map((event) => `
      <tr>
        <td><span class="badge badge-network">${escapeHtml(event.provider || 'Unknown')}</span></td>
        <td><strong>${escapeHtml(event.provider_status || '—')}</strong></td>
        <td>${escapeHtml(event.internal_status || '—')}</td>
        <td>${escapeHtml(event.source || '—')}</td>
        <td><code style="font-size: 0.7rem; word-break: break-all;">${escapeHtml(JSON.stringify(event.payload || {}))}</code></td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(event.created_at).toLocaleString()}</td>
        <td><span class="badge ${['success', 'successful', 'completed', 'delivered'].includes(String(event.internal_status || '').toLowerCase()) ? 'badge-success' : ['failed', 'cancelled'].includes(String(event.internal_status || '').toLowerCase()) ? 'badge-failed' : 'badge-pending'}">${escapeHtml(event.internal_status || 'recorded')}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #f87171; padding: 14px;">${escapeHtml(err.message || 'Unable to load provider events.')}</td></tr>`;
    showToast(err.message || 'Unable to load provider events.', 'error');
  }
}

function closeProviderStatusHistory() {
  document.getElementById('providerStatusHistoryModal')?.classList.remove('open');
}

function switchHistTab(tab) {
  activeHistSubTab = tab;
  document.getElementById('histViewTx').style.display = tab === 'tx' ? 'block' : 'none';
  document.getElementById('histViewTopup').style.display = tab === 'topup' ? 'block' : 'none';
  document.getElementById('histViewRefund').style.display = tab === 'refund' ? 'block' : 'none';
  document.getElementById('histTabTxBtn').classList.toggle('active', tab === 'tx');
  document.getElementById('histTabTopupBtn').classList.toggle('active', tab === 'topup');
  document.getElementById('histTabRefundBtn').classList.toggle('active', tab === 'refund');
}

function closeHistoryModal() {
  document.getElementById('walletHistoryModal').classList.remove('open');
}

// -----------------------------------------------------------------------------
// MODULE 7: MANAGE ADMINS (Super Admin Exclusive)
// -----------------------------------------------------------------------------
async function loadAdminsData() {
  if (!isSuperAdmin) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('manage-admins', {
      body: {},
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.data?.admins) {
      cachedAdmins = res.data.admins;
      renderAdmins(cachedAdmins);
      return;
    }

    // Direct fallback from database
    const { data: adminAgents } = await supabase
      .from('agents')
      .select('id, full_name, role, phone, agent_code, created_at')
      .in('role', ['admin', 'super_admin'])
      .order('created_at', { ascending: false });

    cachedAdmins = (adminAgents || []).map(a => ({
      id: a.id,
      fullName: a.full_name || 'Admin',
      email: a.id === currentUser.id ? currentUser.email : `${(a.full_name || 'admin').toLowerCase().replace(/\s+/g, '')}@skaitech.com`,
      role: a.role,
      createdAt: a.created_at,
      isPrimaryOwner: (a.id === currentUser.id && currentUser.email?.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase())
    }));

    renderAdmins(cachedAdmins);
  } catch (err) {
    console.error('loadAdminsData error:', err);
    showToast(err.message, 'error');
  }
}

function renderAdmins(admins) {
  const tbody = document.getElementById('adminsListTbody');
  if (!tbody) return;

  if (!admins.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No administrators found.</td></tr>';
    return;
  }

  tbody.innerHTML = admins.map((adm) => {
    const isOwner = adm.isPrimaryOwner || (adm.email && adm.email.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase());
    const roleBadge = isOwner || adm.role === 'super_admin'
      ? '<span class="badge" style="background: linear-gradient(135deg, #7c3aed, #2563eb); color: #fff;">SUPER ADMIN</span>'
      : '<span class="badge badge-network" style="color: #60a5fa;">ADMIN</span>';

    const actionsHtml = isOwner
      ? '<span style="color: #c084fc; font-weight: 500; font-size: 0.76rem;"><i class="fa-solid fa-lock"></i> Root Owner</span>'
      : `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-secondary btn-sm" onclick="promptChangeAdminRole('${adm.id}', '${adm.role}')">
            <i class="fa-solid fa-arrows-rotate"></i> Role
          </button>
          <button class="btn btn-secondary btn-sm" onclick="promptResetAdminPassword('${adm.id}', '${escapeHtml(adm.fullName)}')">
            <i class="fa-solid fa-key"></i> Password
          </button>
          <button class="btn btn-danger btn-sm" onclick="promptRevokeAdmin('${adm.id}', '${escapeHtml(adm.fullName)}')">
            <i class="fa-solid fa-user-xmark"></i> Revoke
          </button>
        </div>
      `;

    return `
      <tr>
        <td><span>${escapeHtml(adm.fullName)}</span></td>
        <td><code>${escapeHtml(adm.email)}</code></td>
        <td>${roleBadge}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(adm.createdAt).toLocaleDateString()}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${adm.lastSignInAt ? new Date(adm.lastSignInAt).toLocaleString() : 'Active'}</td>
        <td>${actionsHtml}</td>
      </tr>
    `;
  }).join('');
}

async function handleRegisterAdmin(event) {
  event.preventDefault();
  const btn = document.getElementById('btnRegisterAdmin');
  const fullName = document.getElementById('adminRegFullName').value.trim();
  const email = document.getElementById('adminRegEmail').value.trim();
  const password = document.getElementById('adminRegPassword').value;
  const role = document.getElementById('adminRegRole').value;

  if (!fullName || !email || !password || password.length < 6) {
    showToast('Please provide all fields with a password of at least 6 characters.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering Admin…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('manage-admins', {
      body: { action: 'register-admin', fullName, email, password, role },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Failed to create admin');

    showToast(`Admin account for ${fullName} (${role}) registered successfully!`, 'success');
    document.getElementById('registerAdminForm').reset();
    await loadAdminsData();
  } catch (err) {
    console.error('handleRegisterAdmin error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-shield-plus"></i> Create Admin Account';
  }
}

async function promptChangeAdminRole(userId, currentRole) {
  const newRole = currentRole === 'super_admin' ? 'admin' : 'super_admin';
  if (!confirm(`Are you sure you want to change this administrator's role to ${newRole.toUpperCase()}?`)) return;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('manage-admins', {
      body: { action: 'update-role', userId, role: newRole },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Failed to change role');
    showToast(`Role updated to ${newRole.toUpperCase()}!`, 'success');
    loadAdminsData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function promptResetAdminPassword(userId, fullName) {
  const newPassword = prompt(`Enter new password for ${fullName} (min. 6 characters):`);
  if (!newPassword) return;
  if (newPassword.length < 6) {
    showToast('Password must be at least 6 characters.', 'error');
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('manage-admins', {
      body: { action: 'reset-password', userId, newPassword },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Password reset failed');
    showToast(`Password for ${fullName} updated successfully!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function promptRevokeAdmin(userId, fullName) {
  if (!confirm(`Are you sure you want to revoke admin privileges for ${fullName}? They will be demoted to a regular agent.`)) return;

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('manage-admins', {
      body: { action: 'revoke-admin', userId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Revocation failed');
    showToast(`Admin access revoked for ${fullName}.`, 'success');
    loadAdminsData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// ORDER CANCELLATION (UNIVERSAL WITH WALLET REFUND)
// -----------------------------------------------------------------------------
let pendingCancelOrder = null;

function openCancelOrderModal(orderType, orderId, reference, amount) {
  pendingCancelOrder = { orderType, orderId, reference, amount };
  const detailsEl = document.getElementById('cancelOrderDetails');
  if (detailsEl) {
    detailsEl.innerHTML = `
      <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
        <span><strong>Service:</strong> ${escapeHtml(orderType.toUpperCase())}</span>
        <span><strong>Amount:</strong> ${money(amount)}</span>
      </div>
      <div><strong>Reference:</strong> <span style="font-family: monospace;">${escapeHtml(reference)}</span></div>
    `;
  }
  const reasonInput = document.getElementById('cancelOrderReasonInput');
  if (reasonInput) reasonInput.value = '';
  document.getElementById('cancelOrderModal')?.classList.add('open');
}

function closeCancelOrderModal() {
  pendingCancelOrder = null;
  document.getElementById('cancelOrderModal')?.classList.remove('open');
}

async function submitCancelOrder() {
  if (!pendingCancelOrder) return;
  const reason = document.getElementById('cancelOrderReasonInput')?.value.trim() || 'Cancelled by Super Admin';
  const btn = document.getElementById('btnConfirmCancelOrder');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Cancelling…';
  }

  try {
    const { data, error } = await supabase.rpc('admin_cancel_order', {
      p_order_type: pendingCancelOrder.orderType,
      p_order_id: String(pendingCancelOrder.orderId),
      p_reason: reason
    });

    if (error) throw error;
    showToast(data?.message || 'Order cancelled successfully.', 'success');
    closeCancelOrderModal();

    // Reload active section
    await refreshActiveSection();
  } catch (err) {
    console.error('submitCancelOrder error:', err);
    showToast('Failed to cancel order: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-ban"></i> Cancel & Refund';
    }
  }
}

// -----------------------------------------------------------------------------
// MODULE: AFA REGISTRATION & STATUS TRACKING
// -----------------------------------------------------------------------------
let cachedAfaRegistrations = [];

async function loadAfaData() {
  try {
    const [regRes, pricingRes] = await Promise.all([
      supabase.from('afa_registrations').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('service_pricing').select('price').eq('service', 'afa').maybeSingle(),
    ]);

    if (regRes.error) throw regRes.error;

    cachedAfaRegistrations = regRes.data || [];
    const fee = pricingRes.data?.price || 11.00;

    // Metrics
    const total = cachedAfaRegistrations.length;
    const pending = cachedAfaRegistrations.filter(r => r.status === 'Pending' || r.status === 'Processing').length;
    const completed = cachedAfaRegistrations.filter(r => r.status === 'Completed').length;

    document.getElementById('afaTotalCount').textContent = total;
    document.getElementById('afaPendingCount').textContent = pending;
    document.getElementById('afaCompletedCount').textContent = completed;
    document.getElementById('afaFeeDisplay').textContent = money(fee);

    renderAfaRegistrations(cachedAfaRegistrations);
  } catch (err) {
    console.error('loadAfaData error:', err);
    showToast('Failed to load AFA registrations: ' + err.message, 'error');
  }
}

function renderAfaRegistrations(records) {
  const tbody = document.getElementById('afaRegistrationsTbody');
  if (!tbody) return;

  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align: center; color: var(--text-muted); padding: 16px;">No AFA records found.</td></tr>';
    return;
  }

  tbody.innerHTML = records.map((r) => {
    const isCompleted = r.status === 'Completed';
    const isCancelled = r.status === 'Cancelled';
    const isPending = !isCompleted && !isCancelled;

    let statusBadge = isCompleted
      ? '<span class="badge badge-success"><i class="fa-solid fa-check"></i> Completed</span>'
      : isCancelled
      ? '<span class="badge badge-failed"><i class="fa-solid fa-ban"></i> Cancelled</span>'
      : '<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> ' + escapeHtml(r.status || 'Pending') + '</span>';

    let actions = '';
    if (isPending) {
      actions = `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('afa', '${r.id}', '${escapeHtml(r.reference)}', ${r.amount})" title="Cancel & Refund">
            <i class="fa-solid fa-ban"></i> Cancel
          </button>
        </div>
      `;
    } else {
      actions = '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';
    }

    return `
      <tr>
        <td><span style="font-family: monospace; font-size: 0.75rem;">${escapeHtml(r.reference)}</span></td>
        <td><strong>${escapeHtml(r.full_name || '—')}</strong></td>
        <td>${escapeHtml(r.phone || '—')}</td>
        <td>${escapeHtml(r.town || '—')}</td>
        <td><span style="font-family: monospace;">${escapeHtml(r.id_number || '—')}</span></td>
        <td style="color: var(--text-dim); font-size: 0.75rem;">${escapeHtml(r.date_of_birth || '—')}</td>
        <td><strong>${money(r.amount || 0)}</strong></td>
        <td>${statusBadge}</td>
        <td style="font-size: 0.75rem; color: var(--text-dim);">${escapeHtml(r.provider_reference || '—')}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(r.created_at).toLocaleDateString()}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join('');
}

function filterAfaRegistrations() {
  const query = (document.getElementById('afaSearchInput')?.value || '').toLowerCase();
  const stat = document.getElementById('afaStatusFilter')?.value || 'all';

  const filtered = cachedAfaRegistrations.filter((r) => {
    const matchQ = (r.full_name || '').toLowerCase().includes(query) ||
                   (r.phone || '').toLowerCase().includes(query) ||
                   (r.id_number || '').toLowerCase().includes(query) ||
                   (r.reference || '').toLowerCase().includes(query);
    const matchStat = stat === 'all' ||
      (stat === 'completed' && r.status === 'Completed') ||
      (stat === 'cancelled' && r.status === 'Cancelled') ||
      (stat === 'pending' && r.status !== 'Completed' && r.status !== 'Cancelled');

    return matchQ && matchStat;
  });

  renderAfaRegistrations(filtered);
}

function openEditAfaFeeModal() {
  const currentFee = parseFloat((document.getElementById('afaFeeDisplay')?.textContent || '11.00').replace(/[^0-9.]/g, '')) || 11.00;
  const input = document.getElementById('editAfaFeeInput');
  if (input) input.value = currentFee;
  document.getElementById('editAfaFeeModal')?.classList.add('open');
}

function closeEditAfaFeeModal() {
  document.getElementById('editAfaFeeModal')?.classList.remove('open');
}

async function submitEditAfaFee() {
  const fee = parseFloat(document.getElementById('editAfaFeeInput')?.value);
  if (!fee || fee <= 0) {
    showToast('Please enter a valid positive fee amount.', 'error');
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'update-afa-fee', fee },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.data?.error || res.error?.message || 'Failed to update AFA fee.');
    }
    showToast(`AFA fee updated to ${money(fee)} successfully.`, 'success');
    closeEditAfaFeeModal();
    document.getElementById('afaFeeDisplay').textContent = money(fee);
  } catch (err) {
    console.error('submitEditAfaFee error:', err);
    showToast('Failed to update AFA fee: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// MODULE: RESULTS CHECKER & PIN STOCK
// -----------------------------------------------------------------------------
let cachedCheckerPins = [];
let cachedCheckerOrders = [];
let activeCheckerSubTab = 'stock';

function switchCheckerSubTab(tab) {
  activeCheckerSubTab = tab;
  document.getElementById('checkerSubTabStock').style.display = tab === 'stock' ? 'block' : 'none';
  document.getElementById('checkerSubTabOrders').style.display = tab === 'orders' ? 'block' : 'none';

  document.getElementById('checkerSubTabStockBtn')?.classList.toggle('active', tab === 'stock');
  document.getElementById('checkerSubTabOrdersBtn')?.classList.toggle('active', tab === 'orders');
}

async function loadCheckerData() {
  try {
    const [pinsRes, ordersRes] = await Promise.all([
      supabase.from('result_checker_pins').select('*').order('created_at', { ascending: false }).limit(500),
      supabase.from('results_orders').select('*').order('created_at', { ascending: false }).limit(200),
    ]);

    if (pinsRes.error) throw pinsRes.error;
    if (ordersRes.error) throw ordersRes.error;

    cachedCheckerPins = pinsRes.data || [];
    cachedCheckerOrders = ordersRes.data || [];

    // Calculate stock counters
    let beceAvailable = 0;
    let wassceAvailable = 0;
    let novdecAvailable = 0;

    for (const pin of cachedCheckerPins) {
      if (pin.status === 'available') {
        if (pin.exam_type === 'BECE') beceAvailable++;
        else if (pin.exam_type === 'WASSCE') wassceAvailable++;
        else if (pin.exam_type === 'NOV/DEC') novdecAvailable++;
      }
    }

    document.getElementById('beceStockCount').textContent = beceAvailable;
    document.getElementById('wassceStockCount').textContent = wassceAvailable;
    document.getElementById('novdecStockCount').textContent = novdecAvailable;

    renderCheckerPins(cachedCheckerPins);
    renderCheckerOrders(cachedCheckerOrders);
  } catch (err) {
    console.error('loadCheckerData error:', err);
    showToast('Failed to load checker stock: ' + err.message, 'error');
  }
}

function renderCheckerPins(pins) {
  const tbody = document.getElementById('checkerPinsTbody');
  if (!tbody) return;

  if (!pins.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 16px;">No checker PINs in database. Click "Upload Checkers" to import.</td></tr>';
    return;
  }

  tbody.innerHTML = pins.map((p) => {
    const isAvailable = p.status === 'available';
    const statusBadge = isAvailable
      ? '<span class="badge badge-success">Available</span>'
      : '<span class="badge badge-failed">Sold</span>';

    const maskedPin = `••••••••${(p.pin || '').slice(-4)}`;
    return `
      <tr>
        <td><span class="badge badge-primary">${escapeHtml(p.exam_type)}</span></td>
        <td><span style="font-family: monospace;">${escapeHtml(p.serial || '—')}</span></td>
        <td>
          <span id="pin-val-${p.id}" style="font-family: monospace;">${maskedPin}</span>
          <button class="btn btn-secondary btn-sm" onclick="togglePinReveal('${p.id}', '${escapeHtml(p.pin)}')" style="padding: 1px 6px; font-size: 0.68rem; margin-left: 6px;">
            <i class="fa-solid fa-eye"></i>
          </button>
        </td>
        <td>${statusBadge}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(p.created_at).toLocaleDateString()}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${p.sold_at ? new Date(p.sold_at).toLocaleString() : '—'}</td>
        <td>
          ${isAvailable ? `<button class="btn btn-danger btn-sm" onclick="deleteCheckerPin('${p.id}')"><i class="fa-solid fa-trash"></i></button>` : '—'}
        </td>
      </tr>
    `;
  }).join('');
}

function togglePinReveal(pinId, fullPin) {
  const el = document.getElementById(`pin-val-${pinId}`);
  if (!el) return;
  if (el.dataset.revealed === 'true') {
    el.textContent = `••••••••${fullPin.slice(-4)}`;
    el.dataset.revealed = 'false';
  } else {
    el.textContent = fullPin;
    el.dataset.revealed = 'true';
  }
}

async function deleteCheckerPin(pinId) {
  if (!confirm('Are you sure you want to remove this available PIN from stock?')) return;
  try {
    const { error } = await supabase.from('result_checker_pins').delete().eq('id', pinId);
    if (error) throw error;
    showToast('PIN removed from stock.', 'success');
    await loadCheckerData();
  } catch (err) {
    showToast('Failed to delete PIN: ' + err.message, 'error');
  }
}

function renderCheckerOrders(orders) {
  const tbody = document.getElementById('checkerOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; color: var(--text-muted); padding: 16px;">No checker orders placed yet.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const isPaid = o.status === 'paid';
    const isFailed = o.status === 'failed';
    const statusBadge = isPaid
      ? '<span class="badge badge-success"><i class="fa-solid fa-check"></i> Paid</span>'
      : isFailed
      ? '<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> Failed</span>'
      : '<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> Pending</span>';

    const actions = (!isPaid && !isFailed)
      ? `<button class="btn btn-danger btn-sm" onclick="openCancelOrderModal('results', '${o.id}', '${escapeHtml(o.payment_reference)}', ${o.amount})"><i class="fa-solid fa-ban"></i> Cancel</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    return `
      <tr>
        <td><span class="badge badge-primary">${escapeHtml(o.exam_type)}</span></td>
        <td><strong>${o.quantity}</strong></td>
        <td><strong>${money(o.amount)}</strong></td>
        <td>${escapeHtml(o.recipient_phone || '—')}</td>
        <td>${escapeHtml(o.email || '—')}</td>
        <td><span style="font-family: monospace; font-size: 0.76rem;">${escapeHtml(o.payment_reference)}</span></td>
        <td>${statusBadge}</td>
        <td><span style="font-family: monospace; font-size: 0.75rem;">${escapeHtml(o.serial_pin || '—')}</span></td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(o.created_at).toLocaleString()}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join('');
}

function filterCheckerPins() {
  const exam = document.getElementById('checkerExamFilter')?.value || 'all';
  const stat = document.getElementById('checkerStatusFilter')?.value || 'all';

  const filtered = cachedCheckerPins.filter((p) => {
    const matchExam = exam === 'all' || p.exam_type === exam;
    const matchStat = stat === 'all' || p.status === stat;
    return matchExam && matchStat;
  });

  renderCheckerPins(filtered);
}

function openUploadCheckerModal() {
  document.getElementById('uploadCheckerFeedback').style.display = 'none';
  document.getElementById('uploadCheckerPinsInput').value = '';
  document.getElementById('uploadCheckerFileInput').value = '';
  document.getElementById('uploadCheckerModal')?.classList.add('open');
}

function closeUploadCheckerModal() {
  document.getElementById('uploadCheckerModal')?.classList.remove('open');
}

function handleCheckerFileSelect(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target?.result;
    if (typeof content === 'string') {
      const existing = document.getElementById('uploadCheckerPinsInput').value;
      document.getElementById('uploadCheckerPinsInput').value = (existing ? existing + '\n' : '') + content.trim();
    }
  };
  reader.readAsText(file);
}

async function submitCheckerPins() {
  const examType = document.getElementById('uploadCheckerExamType')?.value;
  const rawText = document.getElementById('uploadCheckerPinsInput')?.value.trim();

  if (!rawText) {
    showToast('Please paste PINs or upload a CSV/text file.', 'error');
    return;
  }

  const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    showToast('No valid lines detected in PIN input.', 'error');
    return;
  }

  const btn = document.getElementById('btnSubmitCheckerUpload');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Importing PINs…';
  }

  try {
    const pins = lines.map(line => {
      const parts = line.split(/[,;\t]/).map(s => s.trim());
      return { pin: parts[0], serial: parts[1] || null };
    }).filter(p => p.pin);

    const { data: { session } } = await supabase.auth.getSession();
    const { data, error } = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'upload-result-checkers', examType, pins },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    const feedback = document.getElementById('uploadCheckerFeedback');
    if (feedback) {
      feedback.style.display = 'block';
      feedback.style.background = 'rgba(16, 185, 129, 0.15)';
      feedback.style.color = '#10b981';
      feedback.innerHTML = `<strong>Success!</strong> Added ${data.added} new PINs for ${examType} (${data.skipped} skipped as duplicates).`;
    }

    showToast(`Imported ${data.added} ${examType} PINs successfully!`, 'success');
    await loadCheckerData();
    setTimeout(() => closeUploadCheckerModal(), 1800);
  } catch (err) {
    console.error('submitCheckerPins error:', err);
    showToast('Upload failed: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-upload"></i> Import PINs into Stock';
    }
  }
}

// -----------------------------------------------------------------------------
// MODULE: MANAGE AGENTS & CANCELLATION
// -----------------------------------------------------------------------------
let cachedAgentsList = [];
let pendingAgentAction = null;

async function loadAgentsModuleData() {
  try {
    const [agentsRes, storesRes, walletsRes] = await Promise.all([
      supabase.from('agents').select('*').order('created_at', { ascending: false }),
      supabase.from('agent_stores').select('id, agent_id, slug, is_active'),
      supabase.from('wallets').select('id, balance, commission_balance'),
    ]);

    if (agentsRes.error) throw agentsRes.error;

    const storesMap = new Map((storesRes.data || []).map(s => [s.agent_id, s]));
    const walletsMap = new Map((walletsRes.data || []).map(w => [w.id, w]));

    cachedAgentsList = (agentsRes.data || []).map(a => {
      const store = storesMap.get(a.id);
      const wallet = walletsMap.get(a.id);
      const isCancelled = a.status === 'cancelled' || a.is_active === false;
      const isSuspended = a.status === 'suspended';
      return {
        id: a.id,
        fullName: a.full_name || 'Agent',
        code: a.agent_code || '—',
        phone: a.phone || '—',
        role: a.role || 'agent',
        status: a.status || (isCancelled ? 'cancelled' : isSuspended ? 'suspended' : 'active'),
        hasStore: !!store,
        storeActive: store ? store.is_active !== false : false,
        storeSlug: store?.slug || '',
        balance: Number(wallet?.balance || 0),
        commissionBalance: Number(wallet?.commission_balance || 0),
        createdAt: a.created_at,
      };
    });

    // Counts
    const total = cachedAgentsList.length;
    const active = cachedAgentsList.filter(a => a.status === 'active').length;
    const cancelled = cachedAgentsList.filter(a => a.status !== 'active').length;

    document.getElementById('agentsTotalCount').textContent = total;
    document.getElementById('agentsActiveCount').textContent = active;
    document.getElementById('agentsCancelledCount').textContent = cancelled;

    renderAgentsDirectory(cachedAgentsList);
  } catch (err) {
    console.error('loadAgentsModuleData error:', err);
    showToast('Failed to load agent directory: ' + err.message, 'error');
  }
}

function renderAgentsDirectory(agents) {
  const tbody = document.getElementById('agentsDirectoryTbody');
  if (!tbody) return;

  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No registered agents found.</td></tr>';
    return;
  }

  tbody.innerHTML = agents.map((a) => {
    const isAct = a.status === 'active';
    const statusBadge = isAct
      ? '<span class="badge badge-success">Active</span>'
      : a.status === 'suspended'
      ? '<span class="badge badge-pending">Suspended</span>'
      : '<span class="badge badge-failed">Cancelled</span>';

    const storeBadge = a.hasStore
      ? (a.storeActive ? `<span class="badge badge-primary">${escapeHtml(a.storeSlug)}</span>` : '<span class="badge badge-failed">Paused</span>')
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">None</span>';

    const actions = isAct
      ? `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-danger btn-sm" onclick="openManageAgentModal('${a.id}', '${escapeHtml(a.fullName)}', '${a.code}', 'cancelled')" title="Cancel Agent Privileges">
            <i class="fa-solid fa-user-slash"></i> Cancel
          </button>
          <button class="btn btn-secondary btn-sm" onclick="openManageAgentModal('${a.id}', '${escapeHtml(a.fullName)}', '${a.code}', 'suspended')" title="Suspend">
            <i class="fa-solid fa-pause"></i> Suspend
          </button>
        </div>
      `
      : `
        <button class="btn btn-primary btn-sm" onclick="openManageAgentModal('${a.id}', '${escapeHtml(a.fullName)}', '${a.code}', 'active')">
          <i class="fa-solid fa-user-check"></i> Reactivate
        </button>
      `;

    return `
      <tr>
        <td><strong>${escapeHtml(a.fullName)}</strong></td>
        <td><span style="font-family: monospace;">${escapeHtml(a.code)}</span></td>
        <td>${escapeHtml(a.phone)}</td>
        <td><span class="user-role-badge role-${a.role === 'super_admin' ? 'super' : 'admin'}">${escapeHtml(a.role)}</span></td>
        <td>${statusBadge}</td>
        <td>${storeBadge}</td>
        <td><strong>${money(a.balance)}</strong></td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(a.createdAt).toLocaleDateString()}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join('');
}

function filterAgentsList() {
  const query = (document.getElementById('agentSearchInput')?.value || '').toLowerCase();
  const stat = document.getElementById('agentStatusFilter')?.value || 'all';

  const filtered = cachedAgentsList.filter((a) => {
    const matchQ = a.fullName.toLowerCase().includes(query) ||
                   a.code.toLowerCase().includes(query) ||
                   a.phone.toLowerCase().includes(query);
    const matchStat = stat === 'all' || a.status === stat;
    return matchQ && matchStat;
  });

  renderAgentsDirectory(filtered);
}

function openManageAgentModal(agentId, name, code, defaultAction) {
  pendingAgentAction = { agentId, name, code };
  const title = defaultAction === 'active' ? 'Reactivate Agent Account' : defaultAction === 'suspended' ? 'Suspend Agent Account' : 'Cancel Agent Account';
  document.getElementById('manageAgentModalTitle').innerHTML = `<i class="fa-solid fa-user-gear"></i> ${title}`;

  const detailsEl = document.getElementById('manageAgentDetails');
  if (detailsEl) {
    detailsEl.innerHTML = `<strong>Agent:</strong> ${escapeHtml(name)} (${escapeHtml(code)})`;
  }

  const select = document.getElementById('manageAgentActionSelect');
  if (select) select.value = defaultAction;

  const btn = document.getElementById('btnConfirmManageAgent');
  if (btn) {
    btn.className = defaultAction === 'active' ? 'btn btn-primary' : 'btn btn-danger';
    btn.textContent = defaultAction === 'active' ? 'Reactivate Agent' : defaultAction === 'suspended' ? 'Suspend Agent' : 'Cancel Agent';
  }

  document.getElementById('manageAgentModal')?.classList.add('open');
}

function closeManageAgentModal() {
  pendingAgentAction = null;
  document.getElementById('manageAgentModal')?.classList.remove('open');
}

async function submitManageAgent() {
  if (!pendingAgentAction) return;
  const status = document.getElementById('manageAgentActionSelect')?.value || 'cancelled';
  const reason = document.getElementById('manageAgentReasonInput')?.value.trim() || `Administrative ${status}`;

  try {
    const { data, error } = await supabase.rpc('admin_manage_agent', {
      p_agent_id: pendingAgentAction.agentId,
      p_status: status,
      p_reason: reason
    });

    if (error) throw error;
    showToast(data?.message || `Agent ${status} successfully.`, 'success');
    closeManageAgentModal();
    await loadAgentsModuleData();
  } catch (err) {
    console.error('submitManageAgent error:', err);
    showToast('Failed to update agent: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// MODULE: AGENT NOTIFICATIONS
// -----------------------------------------------------------------------------
async function loadNotificationsModuleData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'notifications' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Failed to load notification data.');
    }

    renderNotificationRecipients(res.data.agents || []);
    renderAdminNotificationHistory(res.data.campaigns || []);
  } catch (err) {
    console.error('loadNotificationsModuleData error:', err);
    showToast('Failed to load notifications: ' + err.message, 'error');
  }
}

function renderNotificationRecipients(agents) {
  const select = document.getElementById('adminNotificationRecipient');
  if (!select) return;

  select.innerHTML = '<option value="all">All active agents</option>' + agents.map((agent) => {
    const label = `${agent.fullName || 'Agent'}${agent.agentCode ? ` (${agent.agentCode})` : ''}${agent.phone ? ` · ${agent.phone}` : ''}`;
    return `<option value="${escapeHtml(agent.id)}">${escapeHtml(label)}</option>`;
  }).join('');
}

function renderAdminNotificationHistory(campaigns) {
  const tbody = document.getElementById('adminNotificationsTbody');
  if (!tbody) return;

  if (!campaigns.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No admin notifications sent yet.</td></tr>';
    return;
  }

  tbody.innerHTML = campaigns.map((campaign) => {
    const kind = String(campaign.kind || 'info');
    const unread = Number(campaign.unreadCount || 0);
    const createdAt = new Date(campaign.createdAt);
    const date = Number.isNaN(createdAt.getTime()) ? '—' : createdAt.toLocaleString();
    return `
      <tr>
        <td><strong>${escapeHtml(campaign.title || '')}</strong></td>
        <td style="max-width: 340px; white-space: normal;">${escapeHtml(campaign.body || '')}</td>
        <td><span class="badge badge-${kind === 'success' ? 'success' : kind === 'error' ? 'failed' : kind === 'warning' ? 'pending' : 'network'}">${escapeHtml(kind)}</span></td>
        <td>${Number(campaign.recipientCount || 0)}</td>
        <td>${unread}</td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${escapeHtml(date)}</td>
      </tr>
    `;
  }).join('');
}

async function sendAdminNotification(event) {
  event.preventDefault();
  const btn = document.getElementById('btnSendAdminNotification');
  const recipientId = document.getElementById('adminNotificationRecipient')?.value || 'all';
  const kind = document.getElementById('adminNotificationKind')?.value || 'info';
  const title = document.getElementById('adminNotificationTitle')?.value.trim() || '';
  const message = document.getElementById('adminNotificationMessage')?.value.trim() || '';

  if (!title || !message) {
    showToast('Enter both a notification title and message.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'send-agent-notification', recipientId, title, message, kind },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Notification could not be sent.');
    }

    showToast(`Notification sent to ${res.data.recipientCount} agent${res.data.recipientCount === 1 ? '' : 's'}.`, 'success');
    document.getElementById('adminNotificationTitle').value = '';
    document.getElementById('adminNotificationMessage').value = '';
    await loadNotificationsModuleData();
  } catch (err) {
    console.error('sendAdminNotification error:', err);
    showToast(err.message || 'Notification could not be sent.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Notification';
  }
}

// -----------------------------------------------------------------------------
// MODULE: COMMISSION WITHDRAWALS (STORE PAYOUTS)
// -----------------------------------------------------------------------------
let cachedPayoutsList = [];
let pendingPayoutDecision = null;

async function loadPayoutsData() {
  try {
    const { data: payouts, error } = await supabase
      .from('agent_payouts')
      .select('*, agents(full_name, agent_code)')
      .order('requested_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    cachedPayoutsList = payouts || [];

    // Calculate totals
    let pendingCount = 0;
    let pendingTotal = 0;
    let paidTotal = 0;

    for (const p of cachedPayoutsList) {
      const amt = Number(p.amount || 0);
      if (p.status === 'pending' || p.status === 'processing') {
        pendingCount++;
        pendingTotal += amt;
      } else if (p.status === 'paid') {
        paidTotal += amt;
      }
    }

    document.getElementById('payoutsPendingCount').textContent = pendingCount;
    document.getElementById('payoutsPendingTotal').textContent = money(pendingTotal);
    document.getElementById('payoutsPaidTotal').textContent = money(paidTotal);

    renderPayoutsTable(cachedPayoutsList);
  } catch (err) {
    console.error('loadPayoutsData error:', err);
    showToast('Failed to load commission payouts: ' + err.message, 'error');
  }
}

function renderPayoutsTable(payouts) {
  const tbody = document.getElementById('payoutsTbody');
  if (!tbody) return;

  if (!payouts.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 16px;">No commission withdrawal requests recorded.</td></tr>';
    return;
  }

  tbody.innerHTML = payouts.map((p) => {
    const owner = Array.isArray(p.agents) ? p.agents[0] : p.agents;
    const name = owner?.full_name || 'Agent';
    const code = owner?.agent_code || '—';

    const snap = (p.account_snapshot && typeof p.account_snapshot === 'object') ? p.account_snapshot : {};
    const accNumber = snap.account_number || '—';
    const accName = snap.account_name ? ` (${snap.account_name})` : '';
    const network = snap.network ? `[${snap.network.toUpperCase()}] ` : '';

    const isPending = p.status === 'pending' || p.status === 'processing';
    const isPaid = p.status === 'paid';
    const isRejected = p.status === 'rejected';

    let statusBadge = isPaid
      ? '<span class="badge badge-success"><i class="fa-solid fa-check"></i> Paid</span>'
      : isRejected
      ? '<span class="badge badge-failed"><i class="fa-solid fa-xmark"></i> Rejected</span>'
      : p.status === 'processing'
      ? '<span class="badge badge-network"><i class="fa-solid fa-spinner fa-spin"></i> Processing</span>'
      : '<span class="badge badge-pending"><i class="fa-solid fa-clock"></i> Pending</span>';

    let actions = '';
    if (isPending) {
      actions = `
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-primary btn-sm" onclick="openPayoutModal('${p.id}', '${escapeHtml(name)}', ${p.amount}, 'paid')" title="Approve & Mark Paid">
            <i class="fa-solid fa-check"></i> Pay
          </button>
          <button class="btn btn-danger btn-sm" onclick="openPayoutModal('${p.id}', '${escapeHtml(name)}', ${p.amount}, 'rejected')" title="Reject & Refund Commission">
            <i class="fa-solid fa-ban"></i> Reject
          </button>
        </div>
      `;
    } else {
      actions = `<span style="color: var(--text-dim); font-size: 0.74rem;">${escapeHtml(p.admin_note || 'Finalized')}</span>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(name)}</strong></td>
        <td><span style="font-family: monospace;">${escapeHtml(code)}</span></td>
        <td><strong style="color: #3b82f6;">${money(p.amount || 0)}</strong></td>
        <td><span class="badge badge-primary">${escapeHtml((p.method || 'momo').toUpperCase())}</span></td>
        <td><span>${network}${escapeHtml(accNumber)}${escapeHtml(accName)}</span></td>
        <td><span style="font-family: monospace; font-size: 0.75rem;">${escapeHtml(p.reference || '—')}</span></td>
        <td style="color: var(--text-dim); font-size: 0.74rem;">${new Date(p.requested_at).toLocaleString()}</td>
        <td>${statusBadge}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join('');
}

function filterPayouts() {
  const stat = document.getElementById('payoutStatusFilter')?.value || 'all';

  const filtered = cachedPayoutsList.filter((p) => {
    return stat === 'all' || p.status === stat;
  });

  renderPayoutsTable(filtered);
}

function openPayoutModal(payoutId, name, amount, defaultDecision) {
  pendingPayoutDecision = { payoutId, name, amount };
  const detailsEl = document.getElementById('payoutModalDetails');
  if (detailsEl) {
    detailsEl.innerHTML = `
      <div><strong>Agent:</strong> ${escapeHtml(name)}</div>
      <div style="margin-top: 4px;"><strong>Withdrawal Amount:</strong> <span style="color: #3b82f6; font-weight: 600;">${money(amount)}</span></div>
    `;
  }

  const select = document.getElementById('payoutDecisionSelect');
  if (select) select.value = defaultDecision;

  handlePayoutDecisionChange();
  document.getElementById('payoutDecisionModal')?.classList.add('open');
}

function closePayoutModal() {
  pendingPayoutDecision = null;
  document.getElementById('payoutDecisionModal')?.classList.remove('open');
}

function handlePayoutDecisionChange() {
  const decision = document.getElementById('payoutDecisionSelect')?.value;
  const label = document.getElementById('payoutNoteLabel');
  const input = document.getElementById('payoutNoteInput');
  const btn = document.getElementById('btnConfirmPayout');

  if (decision === 'paid') {
    if (label) label.textContent = 'Hubtel / MoMo Disbursed Reference / Transaction ID';
    if (input) input.placeholder = 'e.g. Hubtel CS Ref: #2027124-91823';
    if (btn) {
      btn.className = 'btn btn-primary';
      btn.textContent = 'Confirm Payout Paid';
    }
  } else if (decision === 'rejected') {
    if (label) label.textContent = 'Rejection Reason (Refunds commission to agent wallet)';
    if (input) input.placeholder = 'e.g. Invalid account details provided';
    if (btn) {
      btn.className = 'btn btn-danger';
      btn.textContent = 'Reject & Refund';
    }
  } else {
    if (label) label.textContent = 'Internal Progress Note';
    if (btn) {
      btn.className = 'btn btn-secondary';
      btn.textContent = 'Mark Processing';
    }
  }
}

async function submitPayoutDecision() {
  if (!pendingPayoutDecision) return;
  const decision = document.getElementById('payoutDecisionSelect')?.value || 'paid';
  const note = document.getElementById('payoutNoteInput')?.value.trim() || '';

  try {
    const { data, error } = await supabase.rpc('admin_decide_payout', {
      p_payout_id: pendingPayoutDecision.payoutId,
      p_decision: decision,
      p_note: note
    });

    if (error) throw error;
    showToast(data?.message || 'Payout updated successfully.', 'success');
    closePayoutModal();
    await loadPayoutsData();
  } catch (err) {
    console.error('submitPayoutDecision error:', err);
    showToast('Failed to update payout: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------
function toggleSidebar() {
  document.getElementById('adminSidebar').classList.toggle('open');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Token copied to clipboard!', 'success');
  }).catch(() => {
    prompt('Copy Token:', text);
  });
}

async function handleAdminLogout() {
  try {
    await supabase.auth.signOut();
    localStorage.clear();
    sessionStorage.clear();
  } catch (_) { /* ignore */ }
  window.location.href = 'login.html';
}

// Global Exports for HTML event bindings
window.toggleSidebar = toggleSidebar;
window.refreshActiveSection = refreshActiveSection;
window.switchDataSubTab = switchDataSubTab;
window.filterDataCatalog = filterDataCatalog;
window.filterDataOrders = filterDataOrders;
window.syncOrderStatus = syncOrderStatus;
window.syncAllActiveDataOrders = syncAllActiveDataOrders;
window.openCancelOrderModal = openCancelOrderModal;
window.closeCancelOrderModal = closeCancelOrderModal;
window.submitCancelOrder = submitCancelOrder;
window.toggleStockAvailability = toggleStockAvailability;
window.retryDataOrder = retryDataOrder;
window.handleAirtimeDispatch = handleAirtimeDispatch;
window.retryAirtimeOrder = retryAirtimeOrder;
window.selectUtilityService = selectUtilityService;
window.handleTvPackageChange = handleTvPackageChange;
window.verifyUtilityAccount = verifyUtilityAccount;
window.handleUtilityDispatch = handleUtilityDispatch;
window.retryUtilityOrder = retryUtilityOrder;
window.filterUtilityOrders = filterUtilityOrders;
window.loadAfaData = loadAfaData;
window.filterAfaRegistrations = filterAfaRegistrations;
window.openEditAfaFeeModal = openEditAfaFeeModal;
window.closeEditAfaFeeModal = closeEditAfaFeeModal;
window.submitEditAfaFee = submitEditAfaFee;
window.loadCheckerData = loadCheckerData;
window.switchCheckerSubTab = switchCheckerSubTab;
window.filterCheckerPins = filterCheckerPins;
window.togglePinReveal = togglePinReveal;
window.deleteCheckerPin = deleteCheckerPin;
window.openUploadCheckerModal = openUploadCheckerModal;
window.closeUploadCheckerModal = closeUploadCheckerModal;
window.handleCheckerFileSelect = handleCheckerFileSelect;
window.submitCheckerPins = submitCheckerPins;
window.loadAgentsModuleData = loadAgentsModuleData;
window.filterAgentsList = filterAgentsList;
window.openManageAgentModal = openManageAgentModal;
window.closeManageAgentModal = closeManageAgentModal;
window.submitManageAgent = submitManageAgent;
window.loadNotificationsModuleData = loadNotificationsModuleData;
window.sendAdminNotification = sendAdminNotification;
window.loadPayoutsData = loadPayoutsData;
window.filterPayouts = filterPayouts;
window.openPayoutModal = openPayoutModal;
window.closePayoutModal = closePayoutModal;
window.handlePayoutDecisionChange = handlePayoutDecisionChange;
window.submitPayoutDecision = submitPayoutDecision;
window.toggleStoreStatus = toggleStoreStatus;
window.saveCommissionRates = saveCommissionRates;
window.filterWallets = filterWallets;
window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.submitWalletAdjustment = submitWalletAdjustment;
window.openRefundModal = openRefundModal;
window.closeRefundModal = closeRefundModal;
window.submitAgentRefund = submitAgentRefund;
window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;
window.switchHistTab = switchHistTab;
window.openProviderStatusHistory = openProviderStatusHistory;
window.closeProviderStatusHistory = closeProviderStatusHistory;
window.handleRegisterAdmin = handleRegisterAdmin;
window.promptChangeAdminRole = promptChangeAdminRole;
window.promptResetAdminPassword = promptResetAdminPassword;
window.promptRevokeAdmin = promptRevokeAdmin;
window.copyToClipboard = copyToClipboard;
window.handleAdminLogout = handleAdminLogout;

// Boot on DOM Ready
document.addEventListener('DOMContentLoaded', initAdminPortal);


function openEditBundlePriceModal(id, title, network, currentPrice, catalogType) {
  document.getElementById('editPriceBundleId').value = id;
  document.getElementById('editPriceCatalogType').value = catalogType;
  document.getElementById('editPriceBundleTitle').textContent = title;
  document.getElementById('editPriceNetwork').textContent = (network || '').toUpperCase();
  document.getElementById('editPriceCurrent').textContent = money(currentPrice);
  document.getElementById('editBundleNewPriceInput').value = Number(currentPrice).toFixed(2);

  const modal = document.getElementById('editBundlePriceModal');
  if (modal) {
    modal.classList.add('open');
    setTimeout(() => document.getElementById('editBundleNewPriceInput').focus(), 80);
  }
}

function closeEditBundlePriceModal() {
  const modal = document.getElementById('editBundlePriceModal');
  if (modal) modal.classList.remove('open');
}

async function submitEditBundlePrice() {
  const bundleId = document.getElementById('editPriceBundleId').value;
  const catalogType = document.getElementById('editPriceCatalogType').value;
  const newPrice = parseFloat(document.getElementById('editBundleNewPriceInput').value);
  const btn = document.getElementById('btnSaveBundlePrice');

  if (isNaN(newPrice) || newPrice <= 0) {
    showToast('Please enter a valid positive price.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'update-bundle-price', bundleId, newPrice, catalogType },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.data?.error || res.error?.message || 'Failed to update bundle price.');
    }

    // Update DOM price cell immediately
    const priceCell = document.getElementById(`bundlePrice-${bundleId}`);
    if (priceCell) {
      priceCell.innerHTML = `<strong>${money(newPrice)}</strong>`;
    }

    closeEditBundlePriceModal();
    showToast(`Price updated successfully to ${money(newPrice)}!`, 'success');

    await loadDataModuleData();
  } catch (err) {
    console.error('submitEditBundlePrice error:', err);
    showToast(err.message || 'Error updating price.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Save New Price';
  }
}

window.openEditBundlePriceModal = openEditBundlePriceModal;
window.closeEditBundlePriceModal = closeEditBundlePriceModal;
window.submitEditBundlePrice = submitEditBundlePrice;
