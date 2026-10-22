import { supabase } from './supabaseClient.js';
import { requireAdminAccess, PRIMARY_SUPER_ADMIN_EMAIL } from './agentAuthGuard.js';

// Application State
let currentUser = null;
let currentAgent = null;
let isSuperAdmin = false;
let activeSection = 'overview';
let activeDataSubTab = 'orders';
let activeHistSubTab = 'tx';
let salesChart = null;

// Cached Datasets
let cachedDataOrders = [];
let cachedAirtimeOrders = [];
let cachedUtilityOrders = [];
let cachedWallets = [];
let cachedAdmins = [];
let selectedWalletUser = null;

// Helpers
const money = (val) => `GHS ${Number(val || 0).toFixed(2)}`;
const escapeHtml = (str) =>
  String(str ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

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

    // Load Initial Overview Data
    await loadOverviewData();

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
    showToast('Failed to initialize Admin Portal.', 'error');
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
    'overview': { title: 'Overview & Analytics', sub: 'Live platform metrics, sales telemetry, and revenue balances' },
    'data-module': { title: 'Data Bundles & Instant Data', sub: 'Manage catalog availability, stock status, and real-time data deliveries' },
    'airtime-module': { title: 'Airtime Dispatch Management', sub: 'Hubtel Commission Services [POS: 002040687] network top-up dispatch' },
    'utility-module': { title: 'Utility Bills (ECG Electricity)', sub: 'Hubtel Commission ECG Service [e6d6bac062b5499cb1ecelac3d742a84]' },
    'stores-module': { title: 'Agent Store Management', sub: 'Monitor agent storefronts, configure commissions, and review store orders' },
    'wallets-module': { title: 'User & Agent Wallets', sub: 'Inspect ledger balances, credit/debit funds manually, and audit histories' },
    'admins-module': { title: 'Admin User Management', sub: 'Super Admin Console: register, edit, and audit administrator accounts' },
  };

  const t = titles[sectionId] || titles['overview'];
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
    if (activeSection === 'overview') await loadOverviewData();
    else if (activeSection === 'data-module') await loadDataModuleData();
    else if (activeSection === 'airtime-module') await loadAirtimeData();
    else if (activeSection === 'utility-module') await loadUtilityData();
    else if (activeSection === 'stores-module') await loadStoresData();
    else if (activeSection === 'wallets-module') await loadWalletsData();
    else if (activeSection === 'admins-module' && isSuperAdmin) await loadAdminsData();
  } finally {
    if (icon) setTimeout(() => icon.classList.remove('fa-spin'), 400);
  }
}

// -----------------------------------------------------------------------------
// MODULE 1: OVERVIEW & ANALYTICS
// -----------------------------------------------------------------------------
async function loadOverviewData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: {},
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Failed to fetch overview metrics');
    }

    const { metrics, disbursement, recentActivity } = res.data;

    // Update KPIs
    document.getElementById('kpiTotalRevenue').textContent = money(metrics.total_revenue);
    document.getElementById('kpiAgentStoreSales').textContent = money(metrics.agent_store_sales);
    document.getElementById('kpiDisbursementBalance').textContent = money(disbursement.balance);
    document.getElementById('topbarDisbursementBal').textContent = money(disbursement.balance);

    const pending = metrics.pending_transactions || 0;
    const successful = metrics.successful_transactions || 0;
    document.getElementById('kpiTxSummary').textContent = `${successful} / ${pending}`;

    const totalTx = successful + pending;
    const ratio = totalTx > 0 ? Math.round((successful / totalTx) * 100) : 100;
    document.getElementById('kpiSuccessRatio').textContent = `${ratio}%`;

    // Breakdown Cards
    const b = metrics.breakdown || {};
    document.getElementById('breakdownDataBundles').textContent = money(b.data_bundles);
    document.getElementById('breakdownInstantData').textContent = money(b.instant_data);
    document.getElementById('breakdownAirtime').textContent = money(b.airtime);
    document.getElementById('breakdownUtility').textContent = money(b.utility_bills);

    // Render Chart
    renderSalesChart(b);

    // Render Recent Activity Feed
    renderActivityFeed(recentActivity || []);

  } catch (err) {
    console.error('loadOverviewData error:', err);
    showToast(err.message, 'error');
  }
}

function renderSalesChart(breakdown) {
  const ctx = document.getElementById('salesByServiceChart');
  if (!ctx) return;

  const labels = ['Standard Data', 'Instant Data', 'Airtime', 'Utility (ECG)', 'Agent Store'];
  const values = [
    Number(breakdown.data_bundles || 0),
    Number(breakdown.instant_data || 0),
    Number(breakdown.airtime || 0),
    Number(breakdown.utility_bills || 0),
    Number(breakdown.agent_store || 0),
  ];

  if (salesChart) {
    salesChart.destroy();
  }

  salesChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values.every(v => v === 0) ? [1, 1, 1, 1, 1] : values,
        backgroundColor: ['#2563eb', '#06b6d4', '#eab308', '#10b981', '#a855f7'],
        borderColor: '#131b2e',
        borderWidth: 3,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { color: '#94a3b8', font: { family: 'inherit', size: 12 }, boxWidth: 14 }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: GHS ${Number(ctx.raw || 0).toFixed(2)}`
          }
        }
      },
      cutout: '68%',
    }
  });
}

function renderActivityFeed(activities) {
  const tbody = document.getElementById('activityFeedTbody');
  if (!tbody) return;

  if (!activities.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 20px;">No recent audit activity.</td></tr>';
    return;
  }

  tbody.innerHTML = activities.map((act) => {
    const time = act.created_at ? new Date(act.created_at).toLocaleString() : '—';
    const metaPreview = act.metadata ? JSON.stringify(act.metadata).slice(0, 60) + '…' : '—';
    return `
      <tr>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${time}</td>
        <td><strong>${escapeHtml(act.summary)}</strong></td>
        <td><span class="badge badge-network">${escapeHtml(act.actor_user_id ? act.actor_user_id.slice(0, 8) : 'System')}</span></td>
        <td style="font-family: monospace; font-size: 0.75rem; color: var(--text-muted);">${escapeHtml(metaPreview)}</td>
      </tr>
    `;
  }).join('');
}

// -----------------------------------------------------------------------------
// MODULE 2: DATA BUNDLES & INSTANT DATA
// -----------------------------------------------------------------------------
function switchDataSubTab(tab) {
  activeDataSubTab = tab;
  document.getElementById('dataSubTabOrders').style.display = tab === 'orders' ? 'block' : 'none';
  document.getElementById('dataSubTabStock').style.display = tab === 'stock' ? 'block' : 'none';

  document.querySelectorAll('#section-data-module .sub-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
  });
}

async function loadDataModuleData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'data-management' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || 'Failed to load data module');
    }

    cachedDataOrders = res.data.orders || [];
    renderDataOrders(cachedDataOrders);
    renderDataStock(res.data.bundles || [], res.data.bundleCatalog || []);

  } catch (err) {
    console.error('loadDataModuleData error:', err);
    showToast(err.message, 'error');
  }
}

function renderDataOrders(orders) {
  const tbody = document.getElementById('dataOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No data orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const netClass = o.network === 'mtn' ? 'badge-mtn' : o.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const statusBadge = o.status === 'success' || o.status === 'successful'
      ? '<span class="badge badge-success">Delivered</span>'
      : o.status === 'failed'
      ? '<span class="badge badge-failed">Failed</span>'
      : '<span class="badge badge-pending">Processing</span>';

    const retryBtn = (o.status === 'failed' || o.status === 'pending' || o.status === 'processing')
      ? `<button class="btn btn-secondary btn-sm" onclick="retryDataOrder('${o.id}', '${o.type}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    return `
      <tr>
        <td><span class="badge badge-network">${escapeHtml(o.type)}</span></td>
        <td><strong>${escapeHtml(o.reference)}</strong></td>
        <td>${escapeHtml(o.phone)}</td>
        <td><span class="badge ${netClass}">${escapeHtml(o.network.toUpperCase())}</span></td>
        <td>${escapeHtml(o.details)}</td>
        <td><strong>${money(o.amount)}</strong></td>
        <td>${statusBadge}</td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(o.createdAt).toLocaleString()}</td>
        <td>${retryBtn}</td>
      </tr>
    `;
  }).join('');
}

function filterDataOrders() {
  const query = (document.getElementById('dataOrderSearch')?.value || '').toLowerCase();
  const net = document.getElementById('dataNetworkFilter')?.value || 'all';
  const stat = document.getElementById('dataStatusFilter')?.value || 'all';

  let filtered = cachedDataOrders.filter((o) => {
    const matchQ = o.phone.toLowerCase().includes(query) || o.reference.toLowerCase().includes(query);
    const matchNet = net === 'all' || o.network.toLowerCase() === net.toLowerCase();
    const matchStat = stat === 'all' ||
      (stat === 'success' && (o.status === 'success' || o.status === 'successful')) ||
      (stat === 'pending' && (o.status === 'pending' || o.status === 'processing')) ||
      (stat === 'failed' && o.status === 'failed');

    return matchQ && matchNet && matchStat;
  });

  renderDataOrders(filtered);
}

function renderDataStock(instantBundles, standardCatalog) {
  const tbody = document.getElementById('dataStockTbody');
  if (!tbody) return;

  const allItems = [
    ...instantBundles.map(b => ({
      id: b.id,
      title: b.title,
      network: b.network_id,
      volume: b.data_amount || `${b.volume_mb}MB`,
      price: b.price,
      cost: b.provider_cost || '—',
      packageId: b.bundle_key,
      isAvailable: b.is_available,
      catalogType: 'bundles',
      typeLabel: 'Instant Data',
    })),
    ...standardCatalog.map(c => ({
      id: c.bundle_id,
      title: c.title,
      network: c.network,
      volume: `${c.volume_mb}MB`,
      price: c.price,
      cost: c.provider_cost || '—',
      packageId: c.bundle_id,
      isAvailable: c.active,
      catalogType: 'bundle_catalog',
      typeLabel: 'Standard Bundle',
    })),
  ];

  if (!allItems.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No catalog packages mapped.</td></tr>';
    return;
  }

  tbody.innerHTML = allItems.map((item) => {
    const netClass = item.network === 'mtn' ? 'badge-mtn' : item.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const statusText = item.isAvailable
      ? '<span class="badge badge-success">In Stock</span>'
      : '<span class="badge badge-failed">Out of Stock</span>';

    return `
      <tr>
        <td><span class="badge badge-network">${item.typeLabel}</span></td>
        <td><strong>${escapeHtml(item.title)}</strong></td>
        <td><span class="badge ${netClass}">${escapeHtml(item.network.toUpperCase())}</span></td>
        <td>${escapeHtml(item.volume)}</td>
        <td><strong>${money(item.price)}</strong></td>
        <td>${item.cost !== '—' ? money(item.cost) : '—'}</td>
        <td><code>${escapeHtml(item.packageId)}</code></td>
        <td id="stockStatus-${item.id}">${statusText}</td>
        <td>
          <label class="switch">
            <input type="checkbox" ${item.isAvailable ? 'checked' : ''} onchange="toggleStockAvailability('${item.id}', this.checked, '${item.catalogType}')">
            <span class="slider"></span>
          </label>
        </td>
      </tr>
    `;
  }).join('');
}

async function toggleStockAvailability(bundleId, isAvailable, catalogType) {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'toggle-data-stock', bundleId, isAvailable, catalogType },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) {
      throw new Error(res.error?.message || res.data?.error || 'Failed to update stock');
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

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Retry failed');
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
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'airtime-management' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to load airtime data');

    cachedAirtimeOrders = res.data.orders || [];
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No airtime orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const netClass = o.network === 'mtn' ? 'badge-mtn' : o.network === 'telecel' ? 'badge-telecel' : 'badge-at';
    const statusBadge = o.airtime_status === 'delivered'
      ? '<span class="badge badge-success">Delivered</span>'
      : o.airtime_status === 'failed'
      ? '<span class="badge badge-failed">Failed</span>'
      : '<span class="badge badge-pending">Processing</span>';

    const retryBtn = (o.airtime_status === 'failed' || o.airtime_status === 'pending')
      ? `<button class="btn btn-secondary btn-sm" onclick="retryAirtimeOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(o.payment_reference)}</strong></td>
        <td>${escapeHtml(o.recipient_phone)}</td>
        <td><span class="badge ${netClass}">${escapeHtml((o.network || '').toUpperCase())}</span></td>
        <td><strong>${money(o.amount)}</strong></td>
        <td><span class="badge badge-network">${escapeHtml(o.payment_status || 'paid')}</span></td>
        <td>${statusBadge}</td>
        <td><code>${escapeHtml(o.provider_reference || '—')}</code></td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(o.created_at).toLocaleString()}</td>
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
// MODULE 4: UTILITY BILLS (ECG e6d6bac062b5499cb1ecelac3d742a84)
// -----------------------------------------------------------------------------
async function loadUtilityData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'utility-management' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to load utility orders');

    cachedUtilityOrders = res.data.orders || [];
    renderUtilityOrders(cachedUtilityOrders);
  } catch (err) {
    console.error('loadUtilityData error:', err);
    showToast(err.message, 'error');
  }
}

function renderUtilityOrders(orders) {
  const tbody = document.getElementById('utilityOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No ECG orders found.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => {
    const statusBadge = o.status === 'completed'
      ? '<span class="badge badge-success">Completed</span>'
      : o.status === 'failed'
      ? '<span class="badge badge-failed">Failed</span>'
      : '<span class="badge badge-pending">Processing</span>';

    const tokenHtml = o.token_code
      ? `<strong style="letter-spacing: 1px; color: #34d399;">${escapeHtml(o.token_code)}</strong>
         <button class="btn btn-secondary btn-sm" style="margin-left: 6px; padding: 2px 6px;" onclick="copyToClipboard('${o.token_code}')"><i class="fa-regular fa-copy"></i></button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    const retryBtn = (o.status === 'failed' || o.status === 'processing')
      ? `<button class="btn btn-secondary btn-sm" onclick="retryUtilityOrder('${o.id}')"><i class="fa-solid fa-arrows-rotate"></i> Retry</button>`
      : '<span style="color: var(--text-dim); font-size: 0.75rem;">—</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(o.payment_reference)}</strong></td>
        <td><code>${escapeHtml(o.account_number)}</code></td>
        <td>${escapeHtml(o.customer_name || 'Customer')}</td>
        <td><span class="badge badge-network">${escapeHtml((o.meter_type || 'prepaid').toUpperCase())}</span></td>
        <td><strong>${money(o.amount)}</strong></td>
        <td>${statusBadge}</td>
        <td>${tokenHtml}</td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(o.created_at).toLocaleString()}</td>
        <td>${retryBtn}</td>
      </tr>
    `;
  }).join('');
}

async function verifyUtilityMeter() {
  const meter = document.getElementById('utilityAccountInput').value.trim();
  if (!meter) {
    showToast('Enter meter number to verify.', 'error');
    return;
  }

  showToast('Verifying meter with ECG Hubtel provider…', 'success');
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'verify-utility-meter', accountNumber: meter, service: 'ecg' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.data?.message || 'Verification failed');
    document.getElementById('utilityCustomerNameInput').value = res.data.customerName || 'Verified ECG Customer';
    showToast(`Account Verified: ${res.data.customerName}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleUtilityDispatch(event) {
  event.preventDefault();
  const btn = document.getElementById('btnDispatchUtility');
  const accountNumber = document.getElementById('utilityAccountInput').value.trim();
  const customerName = document.getElementById('utilityCustomerNameInput').value.trim();
  const meterType = document.getElementById('utilityMeterTypeSelect').value;
  const amount = parseFloat(document.getElementById('utilityAmountInput').value);

  if (!accountNumber || isNaN(amount) || amount <= 0) {
    showToast('Please provide valid meter number and positive amount.', 'error');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing ECG Payment…';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'dispatch-utility', accountNumber, customerName, meterType, amount },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.message || 'Payment processing failed');

    const tokenMsg = res.data.token ? ` Token: ${res.data.token}` : '';
    showToast(`ECG Bill Payment of GHS ${amount.toFixed(2)} successful!${tokenMsg}`, 'success');
    document.getElementById('utilityDispatchForm').reset();
    await loadUtilityData();
  } catch (err) {
    console.error('handleUtilityDispatch error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Process ECG Bill Payment';
  }
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
// MODULE 5: AGENT STORE MANAGEMENT
// -----------------------------------------------------------------------------
async function loadStoresData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'agent-store-management' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to load store data');

    renderStoresList(res.data.stores || []);
    renderStoreOrders(res.data.orders || []);
  } catch (err) {
    console.error('loadStoresData error:', err);
    showToast(err.message, 'error');
  }
}

function renderStoresList(stores) {
  const tbody = document.getElementById('storesListTbody');
  if (!tbody) return;

  if (!stores.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No agent stores registered yet.</td></tr>';
    return;
  }

  tbody.innerHTML = stores.map((s) => {
    const owner = Array.isArray(s.agents) ? s.agents[0] : s.agents;
    const statusPill = s.is_active
      ? '<span class="badge badge-success">Open</span>'
      : '<span class="badge badge-failed">Paused</span>';

    const toggleBtn = s.is_active
      ? `<button class="btn btn-danger btn-sm" onclick="toggleStoreStatus('${s.id}', false)"><i class="fa-solid fa-pause"></i> Pause</button>`
      : `<button class="btn btn-success btn-sm" onclick="toggleStoreStatus('${s.id}', true)"><i class="fa-solid fa-play"></i> Re-open</button>`;

    return `
      <tr>
        <td><strong>${escapeHtml(s.display_name || 'Store')}</strong></td>
        <td><a href="/store/${encodeURIComponent(s.slug)}" target="_blank" style="color: #60a5fa; text-decoration: none;">/${escapeHtml(s.slug)}</a></td>
        <td>${escapeHtml(owner?.full_name || 'Owner')}</td>
        <td><code>${escapeHtml(owner?.agent_code || '—')}</code></td>
        <td>${statusPill}</td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(s.created_at).toLocaleDateString()}</td>
        <td>
          <div style="display: flex; gap: 6px;">
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

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Store status update failed');
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

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to save rates');
    showToast('Commission configuration saved successfully!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderStoreOrders(orders) {
  const tbody = document.getElementById('storeOrdersTbody');
  if (!tbody) return;

  if (!orders.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No store orders recorded yet.</td></tr>';
    return;
  }

  tbody.innerHTML = orders.map((o) => `
    <tr>
      <td><strong>${escapeHtml(o.reference)}</strong></td>
      <td>${escapeHtml(o.product_name || o.product_type)}</td>
      <td>${escapeHtml(o.customer_name || 'Customer')}</td>
      <td><strong>${money(o.sale_amount)}</strong></td>
      <td style="color: #34d399;">${money(o.agent_earning)}</td>
      <td style="color: #60a5fa;">${money(o.platform_revenue)}</td>
      <td><span class="badge ${o.payment_status === 'paid' ? 'badge-success' : 'badge-pending'}">${escapeHtml(o.payment_status)}</span></td>
      <td><span class="badge ${o.fulfilment_status === 'successful' ? 'badge-success' : 'badge-pending'}">${escapeHtml(o.fulfilment_status)}</span></td>
      <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(o.created_at).toLocaleString()}</td>
    </tr>
  `).join('');
}

// -----------------------------------------------------------------------------
// MODULE 6: USER & AGENT WALLETS
// -----------------------------------------------------------------------------
async function loadWalletsData() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'wallets' },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to load wallet ledger');

    cachedWallets = res.data.wallets || [];
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
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px;">No wallets found.</td></tr>';
    return;
  }

  tbody.innerHTML = wallets.map((w) => {
    const rolePill = w.role === 'super_admin'
      ? '<span class="badge" style="background: var(--super-admin-gradient); color: #fff;">Super Admin</span>'
      : w.role === 'admin'
      ? '<span class="badge badge-network" style="color: #60a5fa;">Admin</span>'
      : '<span class="badge badge-network">Agent</span>';

    return `
      <tr>
        <td><strong>${escapeHtml(w.fullName)}</strong></td>
        <td>${rolePill}</td>
        <td><code>${escapeHtml(w.agentCode || '—')}</code></td>
        <td>${escapeHtml(w.phone || '—')}</td>
        <td><strong style="color: #60a5fa; font-size: 0.95rem;">${money(w.balance)}</strong></td>
        <td style="color: #34d399;">${money(w.commissionBalance)}</td>
        <td>${money(w.deposits)}</td>
        <td>${money(w.sales)}</td>
        <td>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-primary btn-sm" onclick="openWalletModal('${w.id}', '${escapeHtml(w.fullName)}', ${w.balance})">
              <i class="fa-solid fa-plus-minus"></i> Credit / Debit
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
    w.fullName.toLowerCase().includes(query) ||
    w.phone.toLowerCase().includes(query) ||
    w.agentCode.toLowerCase().includes(query)
  );
  renderWallets(filtered);
}

function openWalletModal(userId, fullName, currentBal) {
  selectedWalletUser = { id: userId, name: fullName, balance: currentBal };
  document.getElementById('walletModalUserInfo').innerHTML = `
    <strong>User:</strong> ${escapeHtml(fullName)}<br>
    <strong>Current Available Balance:</strong> <span style="color: #60a5fa; font-weight: 800;">${money(currentBal)}</span>
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
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { action: 'adjust-wallet', userId: selectedWalletUser.id, amount, type, reason },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Adjustment failed');

    showToast(`Wallet ${type === 'credit' ? 'credited' : 'debited'} with GHS ${amount.toFixed(2)} successfully!`, 'success');
    closeWalletModal();
    loadWalletsData();
  } catch (err) {
    console.error('submitWalletAdjustment error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Confirm Balance Adjustment';
  }
}

async function openHistoryModal(userId, fullName) {
  document.getElementById('historyModalTitle').textContent = `Audit History: ${fullName}`;
  document.getElementById('walletHistoryModal').classList.add('open');
  switchHistTab('tx');

  const txTbody = document.getElementById('histTxTbody');
  const topupTbody = document.getElementById('histTopupTbody');
  txTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">Loading transactions…</td></tr>';
  topupTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">Loading topups…</td></tr>';

  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await supabase.functions.invoke('admin-portal-api', {
      body: { section: 'wallet-history', userId },
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || 'Failed to load history');

    const txs = res.data.transactions || [];
    const topups = res.data.topups || [];

    if (!txs.length) {
      txTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No ledger transactions.</td></tr>';
    } else {
      txTbody.innerHTML = txs.map(t => `
        <tr>
          <td><span class="badge badge-network">${escapeHtml(t.type)}</span></td>
          <td><strong>${money(t.amount)}</strong></td>
          <td>${money(t.balance_before)}</td>
          <td>${money(t.balance_after)}</td>
          <td>${escapeHtml(t.description)}</td>
          <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(t.created_at).toLocaleString()}</td>
        </tr>
      `).join('');
    }

    if (!topups.length) {
      topupTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No deposit records.</td></tr>';
    } else {
      topupTbody.innerHTML = topups.map(tp => `
        <tr>
          <td><code>${escapeHtml(tp.payment_reference)}</code></td>
          <td><strong>${money(tp.amount)}</strong></td>
          <td><span class="badge badge-network">${escapeHtml(tp.provider)}</span></td>
          <td><span class="badge ${tp.status === 'paid' ? 'badge-success' : 'badge-pending'}">${escapeHtml(tp.status)}</span></td>
          <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(tp.created_at).toLocaleString()}</td>
          <td style="color: var(--text-dim); font-size: 0.78rem;">${tp.paid_at ? new Date(tp.paid_at).toLocaleString() : '—'}</td>
        </tr>
      `).join('');
    }

  } catch (err) {
    showToast(err.message, 'error');
  }
}

function switchHistTab(tab) {
  activeHistSubTab = tab;
  document.getElementById('histViewTx').style.display = tab === 'tx' ? 'block' : 'none';
  document.getElementById('histViewTopup').style.display = tab === 'topup' ? 'block' : 'none';
  document.getElementById('histTabTxBtn').classList.toggle('active', tab === 'tx');
  document.getElementById('histTabTopupBtn').classList.toggle('active', tab === 'topup');
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
      method: 'GET',
      headers: { Authorization: `Bearer ${session?.access_token}` },
    });

    if (res.error || !res.data?.success) throw new Error(res.error?.message || res.data?.error || 'Failed to load admins');

    cachedAdmins = res.data.admins || [];
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
    tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">No administrators found.</td></tr>';
    return;
  }

  tbody.innerHTML = admins.map((adm) => {
    const isOwner = adm.isPrimaryOwner || adm.email.toLowerCase() === PRIMARY_SUPER_ADMIN_EMAIL.toLowerCase();
    const roleBadge = isOwner || adm.role === 'super_admin'
      ? '<span class="badge" style="background: var(--super-admin-gradient); color: #fff;">SUPER ADMIN</span>'
      : '<span class="badge badge-network" style="color: #60a5fa;">ADMIN</span>';

    const actionsHtml = isOwner
      ? '<span style="color: #a855f7; font-weight: 700; font-size: 0.8rem;"><i class="fa-solid fa-lock"></i> Primary Root Owner</span>'
      : `
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary btn-sm" onclick="promptChangeAdminRole('${adm.id}', '${adm.role}')">
            <i class="fa-solid fa-arrows-rotate"></i> Change Role
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
        <td><strong>${escapeHtml(adm.fullName)}</strong></td>
        <td><code>${escapeHtml(adm.email)}</code></td>
        <td>${roleBadge}</td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${new Date(adm.createdAt).toLocaleDateString()}</td>
        <td style="color: var(--text-dim); font-size: 0.78rem;">${adm.lastSignInAt ? new Date(adm.lastSignInAt).toLocaleString() : 'Never'}</td>
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
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Registering Admin Account…';

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
  if (!confirm(`Are you sure you want to revoke admin privileges for ${fullName}? They will be demoted to a standard agent.`)) return;

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
// UTILITY FUNCTIONS & EVENT HANDLERS
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

// Expose global window methods for HTML button handlers
window.toggleSidebar = toggleSidebar;
window.refreshActiveSection = refreshActiveSection;
window.switchDataSubTab = switchDataSubTab;
window.filterDataOrders = filterDataOrders;
window.toggleStockAvailability = toggleStockAvailability;
window.retryDataOrder = retryDataOrder;
window.handleAirtimeDispatch = handleAirtimeDispatch;
window.retryAirtimeOrder = retryAirtimeOrder;
window.verifyUtilityMeter = verifyUtilityMeter;
window.handleUtilityDispatch = handleUtilityDispatch;
window.retryUtilityOrder = retryUtilityOrder;
window.toggleStoreStatus = toggleStoreStatus;
window.saveCommissionRates = saveCommissionRates;
window.filterWallets = filterWallets;
window.openWalletModal = openWalletModal;
window.closeWalletModal = closeWalletModal;
window.submitWalletAdjustment = submitWalletAdjustment;
window.openHistoryModal = openHistoryModal;
window.closeHistoryModal = closeHistoryModal;
window.switchHistTab = switchHistTab;
window.handleRegisterAdmin = handleRegisterAdmin;
window.promptChangeAdminRole = promptChangeAdminRole;
window.promptResetAdminPassword = promptResetAdminPassword;
window.promptRevokeAdmin = promptRevokeAdmin;
window.copyToClipboard = copyToClipboard;
window.handleAdminLogout = handleAdminLogout;

// Boot on DOM Ready
document.addEventListener('DOMContentLoaded', initAdminPortal);
