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

  // 3. Handle potential redirect return from Paystack
  await handlePaystackReturn();

  // 4. Load all 9 Stats and Transaction History
  await refreshDashboard();
});

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

  // Update modal references
  setElText('transferModalAvailable', fmt(currentWalletStats.commission_balance));
  setElText('withdrawModalAvailable', fmt(currentWalletStats.commission_balance));
  setElText('orderModalWalletBalance', fmt(currentWalletStats.balance));

  // Real-time check in Order modal if open
  checkOrderBalanceFeasibility();
}

// =============================================================================
// 2. TRANSACTIONS LOADING & FILTERING
// =============================================================================

async function loadTransactions() {
  const listContainer = document.getElementById('transactionResultsList');
  if (!listContainer) return;

  try {
    const agentCode = currentAgentObj?.agent_code || localStorage.getItem('currentAgentCode') || '';
    
    // Query both by agent_id and agent_code
    let query = supabase
      .from('transactions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);

    if (agentCode) {
      query = query.or(`agent_id.eq.${currentAgentUser.id},agent_code.eq.${agentCode}`);
    } else {
      query = query.eq('agent_id', currentAgentUser.id);
    }

    const { data, error } = await query;
    if (error) {
      console.warn('Error fetching transactions from Supabase:', error);
      allTransactions = JSON.parse(localStorage.getItem('agent_transactions')) || [];
    } else {
      allTransactions = data || [];
      localStorage.setItem('agent_transactions', JSON.stringify(allTransactions));
    }

    renderTransactions();
  } catch (err) {
    console.error('Failed to load transactions:', err);
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
// 3. PAYSTACK WALLET FUNDING (INLINE & CALLBACK)
// =============================================================================

async function initiatePaystackDeposit() {
  const amountInput = document.getElementById('depositAmountInput');
  const amount = parseFloat(amountInput ? amountInput.value : 0);

  if (!amount || isNaN(amount) || amount < 1) {
    showToast('Please enter a valid deposit amount (min GHS 1.00).', true);
    return;
  }

  const payBtn = document.getElementById('confirmPaystackDepositBtn');
  if (payBtn) {
    payBtn.disabled = true;
    payBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Initializing Paystack...';
  }

  try {
    const { data, error } = await supabase.functions.invoke('create-agent-wallet-payment', {
      body: { amount, provider: 'paystack' }
    });

    if (error) throw error;
    if (!data?.authorizationUrl && !data?.accessCode) {
      throw new Error(data?.error || 'Unable to open checkout.');
    }

    const { reference, authorizationUrl, accessCode, paystackPublicKey, customerEmail, grossAmount } = data;

    // A. Use Paystack Inline Popup if available
    if (typeof window.PaystackPop !== 'undefined' && (paystackPublicKey || accessCode)) {
      const handler = window.PaystackPop.setup({
        key: paystackPublicKey || undefined,
        access_code: accessCode || undefined,
        email: customerEmail || currentAgentUser.email,
        amount: Math.round(Number(grossAmount || amount) * 100),
        ref: reference,
        currency: 'GHS',
        callback: async function(response) {
          closeAllModals();
          showToast('Payment confirmed! Crediting your wallet...');
          try {
            await supabase.rpc('record_paystack_deposit', {
              p_agent_id: currentAgentUser.id,
              p_amount: amount,
              p_reference: reference,
            });
          } catch (recErr) {
            console.warn('Note on immediate deposit record:', recErr);
          }
          await refreshDashboard();
          showToast(`Wallet loaded with GHS ${amount.toFixed(2)}!`);
        },
        onClose: function() {
          if (payBtn) {
            payBtn.disabled = false;
            payBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Proceed to Paystack';
          }
        }
      });
      handler.openIframe();
    } else {
      // B. Redirect Fallback
      window.location.href = authorizationUrl;
    }
  } catch (err) {
    console.error('Paystack funding error:', err);
    showToast(err.message || 'Unable to start Paystack payment. Please try again.', true);
  } finally {
    if (payBtn) {
      payBtn.disabled = false;
      payBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Proceed to Paystack';
    }
  }
}

async function handlePaystackReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const reference = urlParams.get('reference') || urlParams.get('trxref');
  if (!reference) return;

  const alertBox = document.getElementById('walletAlertBox');
  if (alertBox) {
    alertBox.style.display = 'block';
    alertBox.style.background = '#eef6ff';
    alertBox.style.border = '1px solid #bfdbfe';
    alertBox.style.color = '#1e3a8a';
    alertBox.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Confirming your wallet deposit...';
  }

  try {
    // Check topup record
    const { data: topup } = await supabase
      .from('wallet_topups')
      .select('*')
      .eq('payment_reference', reference)
      .maybeSingle();

    if (topup) {
      if (topup.status !== 'paid') {
        // Record and fulfill deposit atomically
        await supabase.rpc('record_paystack_deposit', {
          p_agent_id: currentAgentUser.id,
          p_amount: Number(topup.amount),
          p_reference: reference,
        });
      }

      if (alertBox) {
        alertBox.style.background = '#f0fdf4';
        alertBox.style.border = '1px solid #bbf7d0';
        alertBox.style.color = '#166534';
        alertBox.innerHTML = `<i class="fa-solid fa-circle-check"></i> Wallet credited successfully: GHS ${Number(topup.amount).toFixed(2)}!`;
        setTimeout(() => { alertBox.style.display = 'none'; }, 6000);
      }
    }
  } catch (err) {
    console.warn('Payment return check note:', err);
  } finally {
    // Clean up query param from URL without reload
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

// =============================================================================
// 4. COMMISSION ACTION HANDLERS (TRANSFER & WITHDRAW)
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
// 5. AGENT STORE ORDERING SYSTEM (PRE-CHECK & ATOMIC EXECUTION)
// =============================================================================

function checkOrderBalanceFeasibility() {
  const bundleSelect = document.getElementById('orderBundleSelect');
  const alertEl = document.getElementById('orderInsufficientAlert');
  const confirmBtn = document.getElementById('confirmPlaceOrderBtn');
  if (!bundleSelect) return;

  const selectedOpt = bundleSelect.options[bundleSelect.selectedIndex];
  const orderPrice = parseFloat(selectedOpt?.getAttribute('data-price') || 4.30);
  const commissionEarned = Math.round((orderPrice * 0.05) * 100) / 100;

  setElText('orderSummaryTotal', `GHS ${orderPrice.toFixed(2)}`);
  setElText('orderSummaryCommission', `GHS ${commissionEarned.toFixed(2)}`);

  // Pre-check rule: verify if balance >= order_total
  const isInsufficient = currentWalletStats.balance < orderPrice;
  if (alertEl) alertEl.style.display = isInsufficient ? 'block' : 'none';
  if (confirmBtn) {
    confirmBtn.disabled = isInsufficient;
    confirmBtn.style.opacity = isInsufficient ? '0.5' : '1';
    confirmBtn.style.cursor = isInsufficient ? 'not-allowed' : 'pointer';
  }
}

async function handlePlaceAgentOrder() {
  const network = document.getElementById('orderNetworkSelect')?.value || 'MTN';
  const bundleSelect = document.getElementById('orderBundleSelect');
  const selectedOpt = bundleSelect?.options[bundleSelect.selectedIndex];
  const bundleSize = selectedOpt?.value || '1GB';
  const orderTotal = parseFloat(selectedOpt?.getAttribute('data-price') || 4.30);
  const recipient = document.getElementById('orderRecipientInput')?.value.trim() || '';

  // 1. Recipient validation
  if (!recipient || !/^0\d{9}$/.test(recipient)) {
    showToast('Please enter a valid 10-digit recipient phone number (e.g. 0244000000).', true);
    return;
  }

  // 2. Pre-check: verify if balance >= order_total
  if (currentWalletStats.balance < orderTotal) {
    showToast('Insufficient wallet balance. Please top up your wallet via Paystack.', true);
    const alertEl = document.getElementById('orderInsufficientAlert');
    if (alertEl) alertEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('confirmPlaceOrderBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing Order...';
  }

  try {
    // 3. Atomic Execution wrapped in database transaction:
    // Deducts order_total from balance, increments sales & store_sales,
    // adds store commission to commission_balance & total_commission_earned,
    // logs record in transactions with type: "Order Purchase".
    const { data, error } = await supabase.rpc('process_agent_order', {
      p_agent_id: currentAgentUser.id,
      p_order_total: orderTotal,
      p_network: network,
      p_bundle_size: bundleSize,
      p_recipient_phone: recipient,
      p_commission_rate: 0.05,
    });

    if (error) {
      if (String(error.message).includes('Insufficient wallet balance')) {
        throw new Error('Insufficient wallet balance. Please top up your wallet via Paystack.');
      }
      throw error;
    }

    closeAllModals();
    showToast(`Order ${data?.reference || ''} placed! GHS ${Number(data?.commission_earned || 0).toFixed(2)} commission earned.`);
    await refreshDashboard();
  } catch (err) {
    console.error('Order processing error:', err);
    showToast(err.message || 'Failed to process order.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-check"></i> Complete Order';
    }
  }
}

// =============================================================================
// 6. EVENT LISTENERS & UI HELPERS
// =============================================================================

function setupEventListeners() {
  // Modal openers
  document.getElementById('fundWalletBtn')?.addEventListener('click', openFundModal);
  document.getElementById('placeOrderBtn')?.addEventListener('click', openPlaceOrderModal);
  document.getElementById('transferCommissionBtn')?.addEventListener('click', openTransferModal);
  document.getElementById('withdrawCommissionBtn')?.addEventListener('click', openWithdrawModal);

  // Modal actions
  document.getElementById('confirmPaystackDepositBtn')?.addEventListener('click', initiatePaystackDeposit);
  document.getElementById('confirmTransferBtn')?.addEventListener('click', handleTransferCommission);
  document.getElementById('confirmWithdrawBtn')?.addEventListener('click', handleWithdrawCommission);
  document.getElementById('confirmPlaceOrderBtn')?.addEventListener('click', handlePlaceAgentOrder);

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

  // Order package select change
  document.getElementById('orderBundleSelect')?.addEventListener('change', checkOrderBalanceFeasibility);

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

export function openFundModal() {
  closeAllModals();
  const input = document.getElementById('depositAmountInput');
  if (input) input.value = '50';
  document.getElementById('fundWalletModal')?.classList.add('open');
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

export function openPlaceOrderModal() {
  closeAllModals();
  checkOrderBalanceFeasibility();
  document.getElementById('placeOrderModal')?.classList.add('open');
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

// Bind to window for HTML attribute triggers
window.openFundModal = openFundModal;
window.openTransferModal = openTransferModal;
window.openWithdrawModal = openWithdrawModal;
window.openPlaceOrderModal = openPlaceOrderModal;
window.closeAllModals = closeAllModals;
window.renderTransactions = renderTransactions;
window.refreshDashboard = refreshDashboard;
