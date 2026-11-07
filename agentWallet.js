import { supabase } from './supabaseClient.js';
import { requireVerifiedAgent } from './agentAuthGuard.js';

let currentAgentUser = null;
let currentAgentObj = null;
let currentWalletStats = {
  balance: 0,
  sales: 0,
  deposits: 0,
  overdraft: 0,
  commission_balance: 0,
  withdrawn_commission: 0,
  transferred_commission: 0,
  total_commission_earned: 0,
  store_sales: 0,
};
let allTransactions = [];

async function fetchAllRows(queryFactory, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // 0. Enforce verified agent authentication
  const authResult = await requireVerifiedAgent({ redirectOnFail: true });
  if (!authResult) return;

  currentAgentUser = authResult.user;
  currentAgentObj = authResult.agent;

  // 1. Render Agent Initials
  renderAgentInitials();

  // 2. Setup Modals and Event Listeners
  setupEventListeners();

  // 3. Load wallet stats and transaction history
  await refreshDashboard();
  showDepositResult();
});

function showDepositResult() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('deposit') !== 'success') return;

  const amount = Number(params.get('amount'));
  showToast(
    Number.isFinite(amount) && amount > 0
      ? `Hubtel deposit successful. GHS ${amount.toFixed(2)} was added to your wallet.`
      : 'Hubtel deposit successful. Your wallet has been updated.'
  );
  window.history.replaceState({}, document.title, 'agentWallet.html');
}

// =============================================================================
// 1. DASHBOARD REFRESH & STATS CALCULATION
// =============================================================================

export async function refreshDashboard() {
  if (!currentAgentUser) return;
  await Promise.all([
    loadWalletStats(),
    loadTransactions(),
  ]);
}

async function loadWalletStats() {
  try {
    const { data, error } = await supabase.rpc('get_wallet_dashboard_stats', {
      p_agent_id: currentAgentUser.id,
    });

    if (error) {
      console.warn('RPC get_wallet_dashboard_stats error, falling back to direct table query:', error);
      const { data: directWallet } = await supabase
        .from('wallets')
        .select('*')
        .eq('id', currentAgentUser.id)
        .maybeSingle();

      if (directWallet) {
        currentWalletStats = {
          balance: Number(directWallet.balance || 0),
          sales: Number(directWallet.sales || 0),
          deposits: Number(directWallet.deposits || 0),
          overdraft: Number(directWallet.overdraft || 0),
          commission_balance: Number(directWallet.commission_balance || 0),
          withdrawn_commission: Number(directWallet.withdrawn_commission || 0),
          transferred_commission: Number(directWallet.transferred_commission || 0),
          total_commission_earned: Number(directWallet.total_commission_earned || 0),
          store_sales: Number(directWallet.store_sales || 0),
        };
      }
    } else if (data) {
      currentWalletStats = {
        balance: Number(data.balance || 0),
        sales: Number(data.sales || 0),
        deposits: Number(data.deposits || 0),
        overdraft: Number(data.overdraft || 0),
        commission_balance: Number(data.commission_balance || 0),
        withdrawn_commission: Number(data.withdrawn_commission || 0),
        transferred_commission: Number(data.transferred_commission || 0),
        total_commission_earned: Number(data.total_commission_earned || 0),
        store_sales: Number(data.store_sales || 0),
      };
    }

    // Keep localStorage wallet balance in sync with rest of the app
    localStorage.setItem('agent_wallet_balance', String(currentWalletStats.balance));

    // Render all 9 financial cards
    renderCards();
  } catch (err) {
    console.error('Failed to load wallet stats:', err);
  }
}

function renderCards() {
  const fmt = (num) => `GHS ${Number(num || 0).toFixed(2)}`;

  setElText('walletPageBalance', fmt(currentWalletStats.balance));
  setElText('walletSales', fmt(currentWalletStats.sales));
  setElText('walletDeposits', fmt(currentWalletStats.deposits));
  setElText('walletOverdraft', fmt(currentWalletStats.overdraft));
  setElText('walletCommissionBalance', fmt(currentWalletStats.commission_balance));
  setElText('quickCommissionDisplay', fmt(currentWalletStats.commission_balance));
  setElText('walletWithdrawnCommission', fmt(currentWalletStats.withdrawn_commission));
  setElText('walletTransferredCommission', fmt(currentWalletStats.transferred_commission));
  setElText('walletTotalCommission', fmt(currentWalletStats.total_commission_earned));
  setElText('walletStoreSales', fmt(currentWalletStats.store_sales));

  // Update commission modal references
  setElText('transferModalAvailable', fmt(currentWalletStats.commission_balance));
  setElText('withdrawModalAvailable', fmt(currentWalletStats.commission_balance));
}

// =============================================================================
// 2. TRANSACTIONS LOADING & FILTERING
// =============================================================================

async function loadTransactions() {
  const listContainer = document.getElementById('transactionResultsList');
  if (!listContainer) return;

  try {
    const agentCode = currentAgentObj?.agent_code || localStorage.getItem('currentAgentCode') || '';
    
    const data = await fetchAllRows((from, to) => {
      let query = supabase
        .from('transactions')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, to);
      return agentCode
        ? query.or(`agent_id.eq.${currentAgentUser.id},agent_code.eq.${agentCode}`)
        : query.eq('agent_id', currentAgentUser.id);
    });
    allTransactions = data || [];
    localStorage.setItem('agent_transactions', JSON.stringify(allTransactions));

    renderTransactions();
  } catch (err) {
    console.error('Failed to load transactions:', err);
    try {
      allTransactions = JSON.parse(localStorage.getItem('agent_transactions') || '[]');
    } catch (_) {
      allTransactions = [];
    }
    renderTransactions();
  }
}

function renderTransactions() {
  const listContainer = document.getElementById('transactionResultsList');
  const countBadge = document.getElementById('txCountBadge');
  if (!listContainer) return;

  const typeFilter = document.getElementById('txTypeFilter')?.value || 'All';
  const idFilter = document.getElementById('txIdFilter')?.value.trim().toLowerCase() || '';

  const filtered = allTransactions.filter(tx => {
    // 1. Transaction Type Filter
    let typeMatches = true;
    if (typeFilter !== 'All') {
      const txTypeNorm = String(tx.type || '').trim().toLowerCase();
      const filterNorm = String(typeFilter).trim().toLowerCase();
      
      // Match exact or common aliases
      if (filterNorm === 'wallet deposit') {
        typeMatches = txTypeNorm === 'wallet deposit' || txTypeNorm === 'deposit';
      } else if (filterNorm === 'order purchase') {
        typeMatches = txTypeNorm === 'order purchase' || txTypeNorm === 'purchase';
      } else if (filterNorm === 'store sales') {
        typeMatches = txTypeNorm === 'store sales' || txTypeNorm === 'store sale';
      } else if (filterNorm === 'commission transfer') {
        typeMatches = txTypeNorm === 'commission transfer' || txTypeNorm.includes('transfer');
      } else if (filterNorm === 'commission withdrawal') {
        typeMatches = txTypeNorm === 'commission withdrawal' || txTypeNorm.includes('withdrawal');
      } else if (filterNorm === 'overdraft') {
        typeMatches = txTypeNorm === 'overdraft';
      } else {
        typeMatches = txTypeNorm === filterNorm;
      }
    }

    // 2. Transaction ID / Reference Search Filter
    let idMatches = true;
    if (idFilter) {
      const ref = String(tx.reference || tx.id || '').toLowerCase();
      const type = String(tx.type || '').toLowerCase();
      const meta = JSON.stringify(tx.metadata || '').toLowerCase();
      idMatches = ref.includes(idFilter) || type.includes(idFilter) || meta.includes(idFilter);
    }

    return typeMatches && idMatches;
  });

  if (countBadge) {
    countBadge.innerText = `${filtered.length} ${filtered.length === 1 ? 'entry' : 'entries'}`;
  }

  // 3. Empty State
  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div style="text-align: center; color: #94a3b8; font-size: 0.9rem; padding: 40px 10px;">
        <i class="fa-solid fa-receipt" style="font-size: 1.8rem; margin-bottom: 10px; display: block; opacity: 0.4;"></i>
        No transactions found.
      </div>
    `;
    return;
  }

  // 4. Render Items
  let html = '';
  filtered.forEach(tx => {
    const isCredit = ['wallet deposit', 'deposit', 'commission transfer', 'store sales'].includes(String(tx.type || '').toLowerCase());
    const amountVal = Math.abs(Number(tx.amount || 0)).toFixed(2);
    const amountFormatted = isCredit ? `+GHS ${amountVal}` : `-GHS ${amountVal}`;
    const amountColor = isCredit ? '#10b981' : '#ef4444';

    // Badge styling
    const badgeStyle = getBadgeStyle(tx.type);
    const dateFormatted = formatTxDate(tx.created_at || tx.date);
    const displayRef = tx.reference || tx.id || 'REF';

    html += `
      <div class="tx-item">
        <div style="flex: 1; padding-right: 12px;">
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;">
            <span class="tx-badge" style="${badgeStyle.css}">${escapeHtml(tx.type || 'Transaction')}</span>
            <span style="font-weight: 700; font-size: 0.85rem; color: #1e293b; font-family: monospace;">${escapeHtml(displayRef)}</span>
          </div>
          <div style="font-size: 0.75rem; color: #64748b; display: flex; gap: 8px; align-items: center;">
            <span><i class="fa-regular fa-clock" style="margin-right: 4px;"></i>${dateFormatted}</span>
            ${tx.status ? `<span style="text-transform: capitalize; color: ${tx.status === 'success' || tx.status === 'completed' ? '#15803d' : '#b45309'}; font-weight: 600;">&bull; ${tx.status}</span>` : ''}
          </div>
        </div>
        <div style="text-align: right;">
          <div style="font-weight: 800; font-size: 0.95rem; color: ${amountColor};">${amountFormatted}</div>
        </div>
      </div>
    `;
  });

  listContainer.innerHTML = html;
}

function getBadgeStyle(type) {
  const norm = String(type || '').toLowerCase();
  if (norm.includes('deposit')) {
    return { css: 'background: #dcfce7; color: #15803d;' };
  }
  if (norm.includes('purchase')) {
    return { css: 'background: #dbeafe; color: #1d4ed8;' };
  }
  if (norm.includes('transfer')) {
    return { css: 'background: #e0f2fe; color: #0369a1;' };
  }
  if (norm.includes('withdrawal')) {
    return { css: 'background: #fef3c7; color: #b45309;' };
  }
  if (norm.includes('sales')) {
    return { css: 'background: #ccfbf1; color: #0f766e;' };
  }
  if (norm.includes('overdraft')) {
    return { css: 'background: #fee2e2; color: #b91c1c;' };
  }
  return { css: 'background: #f1f5f9; color: #475569;' };
}

// =============================================================================
// 3. COMMISSION ACTION HANDLERS (TRANSFER & WITHDRAW)
// =============================================================================

async function handleTransferCommission() {
  const amountInput = document.getElementById('transferAmountInput');
  const amount = parseFloat(amountInput ? amountInput.value : 0);

  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Enter a valid amount to transfer.', true);
    return;
  }

  if (amount > currentWalletStats.commission_balance) {
    showToast(`Insufficient commission balance (Available: GHS ${currentWalletStats.commission_balance.toFixed(2)}).`, true);
    return;
  }

  const btn = document.getElementById('confirmTransferBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Transferring...';
  }

  try {
    const { data, error } = await supabase.rpc('transfer_commission', {
      p_agent_id: currentAgentUser.id,
      p_amount: amount,
    });

    if (error) throw error;

    closeAllModals();
    showToast(`Successfully transferred GHS ${amount.toFixed(2)} to wallet balance!`);
    await refreshDashboard();
  } catch (err) {
    console.error('Transfer commission error:', err);
    showToast(err.message || 'Failed to transfer commission.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-arrow-right-arrow-left"></i> Confirm Transfer';
    }
  }
}

async function handleWithdrawCommission() {
  const methodSelect = document.getElementById('withdrawMethodSelect');
  const method = methodSelect ? methodSelect.value : 'momo';
  const network = document.getElementById('withdrawNetworkSelect')?.value || 'MTN';
  const bankName = document.getElementById('withdrawBankInput')?.value.trim() || '';
  const accountName = document.getElementById('withdrawAccountNameInput')?.value.trim() || '';
  const accountNumber = document.getElementById('withdrawAccountNumberInput')?.value.trim() || '';
  const amount = parseFloat(document.getElementById('withdrawAmountInput')?.value || 0);

  if (!accountName) {
    showToast('Please enter the account name.', true);
    return;
  }
  if (!accountNumber) {
    showToast('Please enter the account number or phone number.', true);
    return;
  }
  if (!amount || isNaN(amount) || amount <= 0) {
    showToast('Please enter a valid withdrawal amount.', true);
    return;
  }
  if (amount > currentWalletStats.commission_balance) {
    showToast(`Insufficient commission balance (Available: GHS ${currentWalletStats.commission_balance.toFixed(2)}).`, true);
    return;
  }

  const btn = document.getElementById('confirmWithdrawBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting...';
  }

  try {
    const { data, error } = await supabase.rpc('withdraw_commission', {
      p_agent_id: currentAgentUser.id,
      p_amount: amount,
      p_payout_method: method,
      p_account_name: accountName,
      p_account_number: accountNumber,
      p_network: method === 'momo' ? network : null,
      p_bank_name: method === 'bank' ? bankName : null,
    });

    if (error) throw error;

    closeAllModals();
    showToast(`Payout request for GHS ${amount.toFixed(2)} submitted for review!`);
    await refreshDashboard();
  } catch (err) {
    console.error('Withdraw commission error:', err);
    showToast(err.message || 'Failed to submit withdrawal request.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Submit Payout Request';
    }
  }
}

// =============================================================================
// 4. EVENT LISTENERS & UI HELPERS
// =============================================================================

function setupEventListeners() {
  // Modal openers
  document.getElementById('transferCommissionBtn')?.addEventListener('click', openTransferModal);
  document.getElementById('withdrawCommissionBtn')?.addEventListener('click', openWithdrawModal);

  // Modal actions
  document.getElementById('confirmTransferBtn')?.addEventListener('click', handleTransferCommission);
  document.getElementById('confirmWithdrawBtn')?.addEventListener('click', handleWithdrawCommission);

  // Transfer Max All button
  document.getElementById('transferAllBtn')?.addEventListener('click', () => {
    const input = document.getElementById('transferAmountInput');
    if (input) input.value = currentWalletStats.commission_balance.toFixed(2);
  });

  // Payout method change
  document.getElementById('withdrawMethodSelect')?.addEventListener('change', (e) => {
    const isBank = e.target.value === 'bank';
    const momoWrap = document.getElementById('withdrawMomoNetworkWrap');
    const bankWrap = document.getElementById('withdrawBankNameWrap');
    if (momoWrap) momoWrap.style.display = isBank ? 'none' : 'block';
    if (bankWrap) bankWrap.style.display = isBank ? 'block' : 'none';
  });

  // Filters
  document.getElementById('txTypeFilter')?.addEventListener('change', renderTransactions);
  document.getElementById('txIdFilter')?.addEventListener('input', renderTransactions);

  // Close modals on clicking backdrop
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAllModals();
    });
  });
}

function renderAgentInitials() {
  const initialsEl = document.getElementById('walletAgentInitials');
  if (!initialsEl) return;
  const storedName = localStorage.getItem('currentAgentName') || localStorage.getItem('agent_name') || 'Valued Agent';
  const parts = storedName.trim().split(/\s+/);
  let initials = 'SA';
  if (parts.length >= 2) {
    initials = (parts[0][0] + parts[1][0]).toUpperCase();
  } else if (parts.length === 1 && parts[0].length > 0) {
    initials = parts[0].substring(0, 2).toUpperCase();
  }
  initialsEl.innerText = initials;
}

export function openTransferModal() {
  closeAllModals();
  const input = document.getElementById('transferAmountInput');
  if (input) input.value = '';
  document.getElementById('transferModal')?.classList.add('open');
}

export function openWithdrawModal() {
  closeAllModals();
  const input = document.getElementById('withdrawAmountInput');
  if (input) input.value = '';
  document.getElementById('withdrawModal')?.classList.add('open');
}

export function closeAllModals() {
  document.querySelectorAll('.modal-backdrop').forEach(m => m.classList.remove('open'));
}

export function showToast(message, isError = false) {
  const toast = document.getElementById('walletToast');
  const text = document.getElementById('toastText');
  const icon = document.getElementById('toastIcon');
  if (!toast || !text) {
    alert(message);
    return;
  }

  text.innerText = message;
  if (icon) {
    icon.className = isError ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
    icon.style.color = isError ? '#ef4444' : '#10b981';
  }
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3800);
}

function setElText(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function formatTxDate(dateVal) {
  if (!dateVal) return 'Just now';
  try {
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return String(dateVal);
  }
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[m]));
}

// Bind wallet actions used by the remaining HTML controls.
window.openTransferModal = openTransferModal;
window.openWithdrawModal = openWithdrawModal;
window.closeAllModals = closeAllModals;
window.renderTransactions = renderTransactions;
window.refreshDashboard = refreshDashboard;
