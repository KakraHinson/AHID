import { supabase } from './supabaseClient.js';

const notice = document.getElementById('notice');
const storesEl = document.getElementById('stores');
const payoutsEl = document.getElementById('payouts');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character]));
}

const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`;

function renderStores(stores) {
  if (!stores.length) {
    storesEl.innerHTML = '<div class="empty">No stores yet.</div>';
    return;
  }
  storesEl.innerHTML = `<table>
    <thead><tr>
      <th>Store</th><th>Owner</th><th>Orders</th><th>Delivered</th>
      <th>Sales</th><th>Earnings</th><th>Platform</th><th>Status</th><th></th>
    </tr></thead>
    <tbody>
      ${stores.map((store) => `
        <tr>
          <td>${escapeHtml(store.displayName)}<br><span style="color:var(--muted)">/${escapeHtml(store.slug)}</span></td>
          <td>${escapeHtml(store.ownerName)}<br><span style="color:var(--muted)">${escapeHtml(store.ownerCode)}</span></td>
          <td>${store.orders}</td>
          <td>${store.delivered}</td>
          <td>${money(store.sales)}</td>
          <td>${money(store.earnings)}</td>
          <td>${money(store.revenue)}</td>
          <td><span class="pill ${store.isActive ? 'on' : 'off'}">${store.isActive ? 'Open' : 'Paused'}</span></td>
          <td><div class="actions">
            ${store.isActive
              ? `<button class="danger" data-suspend="${store.id}">Pause</button>`
              : `<button class="ok" data-activate="${store.id}">Re-open</button>`}
            <button data-view="${escapeHtml(store.slug)}">View</button>
          </div></td>
        </tr>`).join('')}
    </tbody>
  </table>`;

  storesEl.querySelectorAll('[data-suspend]').forEach((button) => {
    button.addEventListener('click', () => setStoreActive(button.dataset.suspend, false));
  });
  storesEl.querySelectorAll('[data-activate]').forEach((button) => {
    button.addEventListener('click', () => setStoreActive(button.dataset.activate, true));
  });
  storesEl.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => window.open(`https://skaitechgh.wasmer.app/storefront.html?ref=${encodeURIComponent(button.dataset.view)}`, '_blank', 'noopener'));
  });
}

function accountSummary(account) {
  if (!account || typeof account !== 'object') return '—';
  if (account.method === 'bank') return escapeHtml(`${account.bank_name || 'Bank'} · ${account.account_number || ''}`);
  return escapeHtml(`${account.momo_network || 'Momo'} · ${account.account_number || ''}`);
}

function renderPayouts(payouts) {
  if (!payouts.length) {
    payoutsEl.innerHTML = '<div class="empty">No payout requests yet.</div>';
    return;
  }
  payoutsEl.innerHTML = `<table>
    <thead><tr>
      <th>Owner</th><th>Amount</th><th>Method</th><th>Destination</th>
      <th>Reference</th><th>Status</th><th>Requested</th><th></th>
    </tr></thead>
    <tbody>
      ${payouts.map((payout) => {
        const open = ['requested', 'approved', 'processing'].includes(payout.status);
        const controls = open
          ? `<button class="ok" data-approve="${payout.id}">Approve</button>
             <button class="danger" data-reject="${payout.id}">Reject</button>
             ${payout.status === 'approved' ? `<button class="primary" data-paid="${payout.id}">Mark paid</button>` : ''}`
          : '';
        return `<tr>
          <td>${escapeHtml(payout.ownerName)}<br><span style="color:var(--muted)">${escapeHtml(payout.ownerCode)}</span></td>
          <td>${money(payout.amount)}</td>
          <td>${escapeHtml(payout.method || '')}</td>
          <td>${accountSummary(payout.account)}</td>
          <td>${escapeHtml(payout.reference)}</td>
          <td><span class="pill">${escapeHtml(payout.status)}</span></td>
          <td>${payout.requestedAt ? new Date(payout.requestedAt).toLocaleDateString() : ''}</td>
          <td><div class="actions">${controls}</div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;

  payoutsEl.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', () => decide(button.dataset.approve, 'approved'));
  });
  payoutsEl.querySelectorAll('[data-reject]').forEach((button) => {
    button.addEventListener('click', () => decide(button.dataset.reject, 'rejected'));
  });
  payoutsEl.querySelectorAll('[data-paid]').forEach((button) => {
    button.addEventListener('click', () => decide(button.dataset.paid, 'paid'));
  });
}

async function setStoreActive(storeId, isActive) {
  let reason = '';
  if (!isActive) {
    reason = window.prompt('Reason for pausing this store (shown internally):') || 'Paused by admin';
  }
  notice.textContent = '';
  const { data, error } = await supabase.functions.invoke('manage-store-admin', {
    body: { action: 'set-store-active', storeId, isActive, reason },
  });
  if (error || data?.error) {
    notice.textContent = data?.error || error?.message || 'Unable to update the store.';
    return;
  }
  load();
}

async function decide(payoutId, decision) {
  const note = window.prompt('Admin note (optional):') || '';
  notice.textContent = '';
  const { data, error } = await supabase.functions.invoke('manage-store-admin', {
    body: { action: 'payout-decision', payoutId, decision, note },
  });
  if (error || data?.error) {
    notice.textContent = data?.error || error?.message || 'Unable to update the payout.';
    return;
  }
  load();
}

async function load() {
  storesEl.innerHTML = '<div class="loading">Loading stores…</div>';
  payoutsEl.innerHTML = '<div class="loading">Loading payouts…</div>';
  const { data, error } = await supabase.functions.invoke('manage-store-admin');
  if (error || data?.error) {
    notice.textContent = data?.error || error?.message || 'Unable to load the store console. Administrator access is required.';
    storesEl.innerHTML = '';
    payoutsEl.innerHTML = '';
    return;
  }
  notice.textContent = '';
  renderStores(data.stores || []);
  renderPayouts(data.payouts || []);
}

load();
