import { supabase } from './supabaseClient.js';

// Configuration & Constants
const FEE_PERCENT = 0.015;
const NETWORK_PREFIXES = {
  mtn: ['024', '025', '053', '054', '055', '059'],
  telecel: ['020', '050'],
  at: ['026', '027', '056', '057'],
};

// Application State
let selectedNetwork = 'mtn';
let paymentMethod = 'paystack';
let currentAmount = 10;
let agentUser = null;
let agentWalletBalance = 0;

function $(id) {
  return document.getElementById(id);
}

// Calculate Gross Amount with Paystack Gateway fee
function calculateGross(net) {
  if (paymentMethod === 'wallet') return net;
  const safeRate = Number.isFinite(FEE_PERCENT) ? FEE_PERCENT : 0.015;
  return Math.round(((net / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

// Prefix to Network Detection
function detectNetworkFromPhone(phone) {
  const clean = phone.replace(/\D/g, '');
  if (clean.length < 3) return null;
  const prefix = clean.slice(0, 3);
  for (const [net, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) {
      return net;
    }
  }
  return null;
}

// Phone Input Handling
export function handlePhoneInput() {
  const phoneInput = $('recipientPhone');
  let val = phoneInput.value.replace(/\D/g, '');
  if (val.length > 10) val = val.slice(0, 10);
  phoneInput.value = val;

  const indicator = $('phoneNetworkIndicator');
  const indicatorText = $('indicatorText');
  const validationHint = $('phoneValidationHint');
  const summaryPhone = $('summaryPhone');

  summaryPhone.textContent = val || '0244XXXXXX';

  const detected = detectNetworkFromPhone(val);

  if (detected) {
    indicator.className = 'phone-network-indicator detected';
    indicatorText.textContent = detected.toUpperCase();
    if (detected !== selectedNetwork && val.length === 3) {
      selectNetwork(detected);
    }
  } else {
    indicator.className = 'phone-network-indicator';
    indicatorText.textContent = selectedNetwork.toUpperCase();
  }

  // Validate format
  if (val.length === 10) {
    if (/^0[235]\d{8}$/.test(val)) {
      validationHint.className = 'phone-validation-hint valid';
      validationHint.innerHTML = '<i class="fa-solid fa-circle-check"></i> Valid Ghanaian number format';
    } else {
      validationHint.className = 'phone-validation-hint invalid';
      validationHint.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> Invalid Ghana mobile network prefix';
    }
  } else if (val.length > 0) {
    validationHint.className = 'phone-validation-hint';
    validationHint.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${10 - val.length} more digits needed`;
  } else {
    validationHint.className = 'phone-validation-hint';
    validationHint.innerHTML = '<i class="fa-solid fa-circle-info"></i> Enter standard 10-digit Ghana mobile number';
  }
}

// Network Selection
export function selectNetwork(net) {
  selectedNetwork = net;

  const btnMtn = $('netBtnMtn');
  const btnTelecel = $('netBtnTelecel');
  const btnAt = $('netBtnAt');

  btnMtn.className = 'network-select-btn' + (net === 'mtn' ? ' active active-mtn' : '');
  btnTelecel.className = 'network-select-btn' + (net === 'telecel' ? ' active active-telecel' : '');
  btnAt.className = 'network-select-btn' + (net === 'at' ? ' active active-at' : '');

  const badge = $('summaryNetworkBadge');
  if (net === 'mtn') {
    badge.textContent = 'MTN';
    badge.style.background = '#ffcc00';
    badge.style.color = '#000000';
  } else if (net === 'telecel') {
    badge.textContent = 'Telecel';
    badge.style.background = '#e11d48';
    badge.style.color = '#ffffff';
  } else if (net === 'at') {
    badge.textContent = 'AT';
    badge.style.background = '#0284c7';
    badge.style.color = '#ffffff';
  }

  const indicatorText = $('indicatorText');
  if (indicatorText) indicatorText.textContent = net.toUpperCase();
}

// Amount Selection via Chips
export function setAirtimeAmount(val) {
  currentAmount = Number(val);
  $('airtimeAmount').value = currentAmount;

  // Update chip active states
  const chips = document.querySelectorAll('#amountChipsContainer .airtime-chip');
  chips.forEach(chip => {
    if (parseFloat(chip.textContent) === currentAmount) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  updateSummary();
}

// Amount Input Handler
export function handleAmountInput() {
  const val = parseFloat($('airtimeAmount').value);
  currentAmount = Number.isFinite(val) ? val : 0;

  // Update chips active state
  const chips = document.querySelectorAll('#amountChipsContainer .airtime-chip');
  chips.forEach(chip => {
    if (parseFloat(chip.textContent) === currentAmount) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  updateSummary();
}

// Payment Method Selection
export function selectPaymentMethod(method) {
  if (method === 'wallet' && !agentUser) {
    if (confirm('Agent Wallet payment is available to registered Skaitech Agents. Would you like to log in as an agent?')) {
      window.location.href = 'login.html';
    }
    return;
  }

  paymentMethod = method;

  $('payMethodPaystack').classList.toggle('active', method === 'paystack');
  $('payMethodWallet').classList.toggle('active', method === 'wallet');

  $('summaryPaymentMethod').textContent = method === 'wallet' ? 'Agent Wallet (0% Fee)' : 'Paystack Checkout';

  updateSummary();
}

// Update Real-Time Order Breakdown
export function updateSummary() {
  const netAmount = Math.max(0, currentAmount);
  const grossAmount = calculateGross(netAmount);
  const fee = paymentMethod === 'wallet' ? 0.00 : Math.max(0, Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100);

  $('summaryAirtimeNet').textContent = netAmount.toFixed(2);
  $('summaryFeeAmount').textContent = fee.toFixed(2);
  $('summaryGrossTotal').textContent = grossAmount.toFixed(2);
  $('btnAmountText').textContent = grossAmount.toFixed(2);
}

// Display Notice Alerts
function showNotice(message, isError = false) {
  const notice = $('formNotice');
  if (!notice) return;
  notice.className = isError ? 'notice show error' : 'notice show info';
  notice.innerHTML = isError
    ? `<i class="fa-solid fa-circle-exclamation"></i> ${message}`
    : `<i class="fa-solid fa-circle-info"></i> ${message}`;
}

function clearNotice() {
  const notice = $('formNotice');
  if (notice) {
    notice.className = 'notice';
    notice.innerHTML = '';
  }
}

// Processing Modal Helpers
function showProcessing(stepText = 'Connecting to recharge gateway...') {
  const modal = $('processingModal');
  const step = $('processingStepText');
  if (step) step.textContent = stepText;
  if (modal) modal.classList.add('active');
}

function hideProcessing() {
  const modal = $('processingModal');
  if (modal) modal.classList.remove('active');
}

// Save Order to Local History
function saveOrderToLocalHistory(order) {
  try {
    const orders = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
    const existingIndex = orders.findIndex(o => o.reference === order.reference);
    if (existingIndex >= 0) {
      orders[existingIndex] = { ...orders[existingIndex], ...order };
    } else {
      orders.unshift(order);
    }
    localStorage.setItem('skaitech_airtime_orders', JSON.stringify(orders.slice(0, 100)));
    updateHistoryCountBadge();
  } catch (err) {
    console.warn('Could not cache airtime order locally:', err);
  }
}

// Update Recent Purchases Count Badge
function updateHistoryCountBadge() {
  try {
    const orders = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
    const badge = $('historyCountBadge');
    if (badge) badge.textContent = orders.length;
  } catch {
    // Ignore
  }
}

// Render Receipt Card
function showReceipt(order) {
  $('airtimeFormCard').style.display = 'none';
  const receiptCard = $('airtimeReceiptCard');
  receiptCard.style.display = 'block';

  const displayId = order.shortCode || order.orderId || (order.reference && order.reference.length === 5 ? order.reference : order.reference?.slice(-5)?.toUpperCase()) || '-';
  $('receiptRef').textContent = displayId;
  $('receiptPhone').textContent = order.phone || '-';
  $('receiptNetwork').textContent = (order.network || '').toUpperCase();
  $('receiptAmount').textContent = `GHS ${Number(order.amount || 0).toFixed(2)}`;
  $('receiptTotalPaid').textContent = `GHS ${Number(order.grossAmount || order.amount || 0).toFixed(2)}`;
  $('receiptPaymentMethod').textContent = (order.paymentMethod || 'paystack').toUpperCase();
  $('receiptTimestamp').textContent = order.createdAt ? new Date(order.createdAt).toLocaleString() : new Date().toLocaleString();

  const badge = $('receiptBadge');
  const badgeText = $('receiptBadgeText');
  const statusText = $('receiptStatus');
  const providerNoteRow = $('receiptProviderNoteRow');
  const providerNotice = $('receiptProviderNotice');

  if (order.airtimeStatus === 'delivered') {
    badge.style.background = '#dcfce7';
    badge.style.color = '#15803d';
    badgeText.textContent = 'Airtime Delivered Successfully';
    statusText.textContent = 'Delivered';
    statusText.style.color = '#15803d';
    providerNoteRow.style.display = 'none';
  } else if (order.airtimeStatus === 'pending_provider') {
    badge.style.background = '#fef3c7';
    badge.style.color = '#b45309';
    badgeText.textContent = 'Payment Confirmed • Queued for Dispatch';
    statusText.textContent = 'Queued (Awaiting Provider)';
    statusText.style.color = '#b45309';
    providerNoteRow.style.display = 'flex';
    providerNotice.textContent = 'Payment secured. Awaiting topup gateway processing.';
  } else if (order.airtimeStatus === 'failed') {
    badge.style.background = '#fee2e2';
    badge.style.color = '#b91c1c';
    badgeText.textContent = 'Top-Up Declined';
    statusText.textContent = 'Failed';
    statusText.style.color = '#b91c1c';
    providerNoteRow.style.display = 'flex';
    providerNotice.textContent = order.failureReason || 'Declined by network provider.';
  } else {
    badge.style.background = '#eff6ff';
    badge.style.color = '#1d4ed8';
    badgeText.textContent = 'Payment Verified • In Progress';
    statusText.textContent = 'Processing';
    statusText.style.color = '#1d4ed8';
    providerNoteRow.style.display = 'none';
  }

  // Save to local cache
  const displayId = order.shortCode || order.orderId || (order.reference && order.reference.length === 5 ? order.reference : order.reference?.slice(-5)?.toUpperCase()) || '-';
  saveOrderToLocalHistory({
    reference: displayId,
    orderId: displayId,
    shortCode: displayId,
    orderReference: order.paymentReference || order.reference,
    phone: order.phone,
    network: order.network,
    amount: order.amount,
    grossAmount: order.grossAmount || order.amount,
    paymentMethod: order.paymentMethod,
    airtimeStatus: order.airtimeStatus,
    createdAt: order.createdAt || new Date().toISOString()
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Reset and Start New Purchase
export function startNewAirtimePurchase() {
  $('airtimeReceiptCard').style.display = 'none';
  $('airtimeFormCard').style.display = 'block';
  clearNotice();
  $('recipientPhone').value = '';
  handlePhoneInput();
  setAirtimeAmount(10);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Form Submission
export async function handleAirtimeSubmit(event) {
  event.preventDefault();
  clearNotice();

  const phone = $('recipientPhone').value.trim();
  const emailInput = $('customerEmail').value.trim();
  const netAmount = Math.max(0, currentAmount);

  // Validation
  if (!/^0[235]\d{8}$/.test(phone)) {
    showNotice('Please enter a valid 10-digit Ghanaian mobile number (e.g. 0244123456).', true);
    return;
  }

  if (netAmount < 1.00 || netAmount > 500.00) {
    showNotice('Airtime amount must be between GHS 1.00 and GHS 500.00.', true);
    return;
  }

  const submitBtn = $('submitAirtimeBtn');
  submitBtn.disabled = true;

  try {
    // FLOW A: AGENT WALLET
    if (paymentMethod === 'wallet') {
      if (agentWalletBalance < netAmount) {
        throw new Error(`Insufficient wallet balance (GHS ${agentWalletBalance.toFixed(2)}). Please deposit funds or pay with Paystack.`);
      }

      showProcessing('Deducting from agent wallet & dispatching top-up...');

      const { data, error } = await supabase.functions.invoke('create-airtime-payment', {
        body: {
          network: selectedNetwork,
          phone,
          amount: netAmount,
          paymentMethod: 'wallet',
          customerEmail: emailInput || agentUser?.email || '',
        }
      });

      hideProcessing();

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'Wallet transaction failed.');
      }

      // Decrement local wallet balance
      agentWalletBalance = Math.max(0, agentWalletBalance - netAmount);
      $('agentBannerBalance').textContent = agentWalletBalance.toFixed(2);
      $('walletCardSubtitle').textContent = `Balance: GHS ${agentWalletBalance.toFixed(2)}`;

      showReceipt({
        reference: data.reference,
        phone: data.phone || phone,
        network: data.network || selectedNetwork,
        amount: data.amount || netAmount,
        grossAmount: data.amount || netAmount,
        paymentMethod: 'wallet',
        airtimeStatus: data.airtimeStatus,
        createdAt: new Date().toISOString()
      });

      return;
    }

    // FLOW B: PAYSTACK CHECKOUT
    showProcessing('Redirecting to Paystack secure checkout...');

    // Cache parameters for return
    sessionStorage.setItem('skaitech_airtime_pending', JSON.stringify({
      network: selectedNetwork,
      phone,
      amount: netAmount,
      email: emailInput || `${phone}@customer.skaitechgh.wasmer.app`
    }));

    const { data, error } = await supabase.functions.invoke('create-airtime-payment', {
      body: {
        network: selectedNetwork,
        phone,
        amount: netAmount,
        paymentMethod: 'paystack',
        customerEmail: emailInput,
      }
    });

    if (error || data?.error) {
      hideProcessing();
      throw new Error(data?.error || error?.message || 'Could not initialize Paystack payment.');
    }

    if (data?.authorizationUrl) {
      window.location.href = data.authorizationUrl;
    } else {
      hideProcessing();
      throw new Error('Payment gateway did not return authorization link.');
    }
  } catch (err) {
    hideProcessing();
    showNotice(err.message || 'Error completing request.', true);
    submitBtn.disabled = false;
  }
}

// Check if returning from Paystack redirect (query string ?reference=AIR-...)
async function checkPaymentCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const reference = urlParams.get('reference');
  if (!reference || !reference.startsWith('AIR-')) return;

  const resultNotice = $('paymentResultNotice');
  resultNotice.className = 'notice show info';
  resultNotice.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Verifying your payment and checking airtime delivery...';

  showProcessing('Verifying transaction with network...');

  let attempts = 0;
  const maxAttempts = 6;

  async function poll() {
    attempts++;
    try {
      const { data, error } = await supabase.functions.invoke('get-airtime-order', {
        body: { reference }
      });

      if (error || data?.error) {
        throw new Error(data?.error || error?.message || 'Failed to retrieve order status.');
      }

      const order = data.order;
      if (order.paymentStatus === 'paid' || order.airtimeStatus === 'delivered' || order.airtimeStatus === 'pending_provider' || attempts >= maxAttempts) {
        hideProcessing();
        resultNotice.style.display = 'none';
        showReceipt(order);
        // Clean URL without reloading
        window.history.replaceState({}, document.title, window.location.pathname);
      } else {
        // Retry polling in 2.5s
        setTimeout(poll, 2500);
      }
    } catch (err) {
      hideProcessing();
      resultNotice.className = 'notice show error';
      resultNotice.textContent = 'Could not confirm airtime delivery: ' + err.message;
    }
  }

  poll();
}

// Check Agent Auth Session and Load Wallet
async function initAuth() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      agentUser = user;

      // Update header button to Agent Dashboard
      const authBtn = $('headerAuthBtn');
      if (authBtn) {
        authBtn.textContent = 'Agent Dashboard';
        authBtn.href = 'dashboard.html';
      }

      // Check wallet balance
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('id', user.id)
        .maybeSingle();

      if (wallet) {
        agentWalletBalance = Number(wallet.balance) || 0;
        $('agentWalletBanner').style.display = 'flex';
        $('agentBannerBalance').textContent = agentWalletBalance.toFixed(2);
        $('walletCardSubtitle').textContent = `Balance: GHS ${agentWalletBalance.toFixed(2)}`;
      }

      // Pre-fill email
      if (user.email && $('customerEmail')) {
        $('customerEmail').value = user.email;
      }
    }
  } catch (e) {
    console.warn('Auth check error:', e);
  }
}

// Open Recent Purchases Modal
export async function openAirtimeHistory() {
  const modal = $('historyModal');
  const container = $('historyListContainer');
  if (modal) modal.classList.add('active');

  const localOrders = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
  let remoteOrders = [];

  if (agentUser) {
    try {
      const { data } = await supabase
        .from('airtime_orders')
        .select('*')
        .or(`agent_id.eq.${agentUser.id},user_id.eq.${agentUser.id}`)
        .order('created_at', { ascending: false })
        .limit(20);

      if (data) {
        remoteOrders = data.map(o => ({
          reference: o.payment_reference,
          phone: o.recipient_phone,
          network: o.network,
          amount: Number(o.amount),
          grossAmount: Number(o.gross_amount),
          paymentMethod: o.payment_method,
          airtimeStatus: o.airtimeStatus || o.airtime_status,
          createdAt: o.created_at
        }));
      }
    } catch (e) {
      console.warn('Could not load remote history:', e);
    }
  }

  // Merge and deduplicate by reference
  const map = new Map();
  [...remoteOrders, ...localOrders].forEach(o => {
    if (o.reference && !map.has(o.reference)) {
      map.set(o.reference, o);
    }
  });
  const allOrders = Array.from(map.values());

  if (allOrders.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 24px 0;">No past airtime orders found.</p>';
    return;
  }

  container.innerHTML = allOrders.map(order => {
    const isDelivered = order.airtimeStatus === 'delivered';
    const isPending = order.airtimeStatus === 'pending_provider' || order.airtimeStatus === 'pending';
    const statusColor = isDelivered ? '#15803d' : (isPending ? '#b45309' : '#b91c1c');
    const statusLabel = isDelivered ? 'Delivered' : (isPending ? 'Queued' : 'Failed');
    const dateStr = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : 'Recent';

    return `
      <div class="history-item">
        <div>
          <div style="font-weight: 700; color: #0f172a; font-size: 0.95rem;">
            ${(order.network || '').toUpperCase()} Airtime - GHS ${Number(order.amount).toFixed(2)}
          </div>
          <div style="font-size: 0.8rem; color: #64748b; margin-top: 2px;">
            To: <strong>${order.phone}</strong> &bull; Ref: ${order.reference.slice(0, 16)}...
          </div>
          <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 2px;">
            ${dateStr} &bull; Paid via ${(order.paymentMethod || 'paystack').toUpperCase()}
          </div>
        </div>
        <div style="text-align: right;">
          <span style="font-weight: 700; font-size: 0.8rem; color: ${statusColor}; background: ${isDelivered ? '#dcfce7' : (isPending ? '#fef3c7' : '#fee2e2')}; padding: 3px 8px; border-radius: 9999px;">
            ${statusLabel}
          </span>
          <div style="margin-top: 6px;">
            <button type="button" onclick="viewHistoricalReceipt('${order.reference}')" style="background: none; border: 1px solid #cbd5e1; padding: 3px 8px; border-radius: 4px; font-size: 0.75rem; cursor: pointer; color: #2563eb; font-weight: 600;">
              Receipt
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

export function closeAirtimeHistory() {
  const modal = $('historyModal');
  if (modal) modal.classList.remove('active');
}

export async function viewHistoricalReceipt(reference) {
  closeAirtimeHistory();
  const localOrders = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
  const match = localOrders.find(o => o.reference === reference);
  if (match) {
    showReceipt(match);
    return;
  }

  showProcessing('Retrieving transaction receipt...');
  try {
    const { data, error } = await supabase.functions.invoke('get-airtime-order', {
      body: { reference }
    });
    hideProcessing();
    if (data?.order) {
      showReceipt(data.order);
    }
  } catch {
    hideProcessing();
  }
}

// Side Drawer Navigation
export function toggleAirtimeDrawer() {
  const drawer = $('sideDrawer');
  const overlay = $('sidebarOverlay');
  if (drawer && overlay) {
    drawer.classList.toggle('active');
    overlay.classList.toggle('active');
  }
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  updateSummary();
  updateHistoryCountBadge();
  checkPaymentCallback();

  // Check URL parameters (e.g. ?network=mtn&phone=024...)
  const params = new URLSearchParams(window.location.search);
  const net = params.get('network');
  if (net && ['mtn', 'telecel', 'at'].includes(net.toLowerCase())) {
    selectNetwork(net.toLowerCase());
  }
  const phone = params.get('phone');
  if (phone) {
    $('recipientPhone').value = phone;
    handlePhoneInput();
  }
  const amt = parseFloat(params.get('amount'));
  if (amt && amt >= 1 && amt <= 500) {
    setAirtimeAmount(amt);
  }
});

// Expose globals for inline onclick handlers
window.selectNetwork = selectNetwork;
window.handlePhoneInput = handlePhoneInput;
window.setAirtimeAmount = setAirtimeAmount;
window.handleAmountInput = handleAmountInput;
window.selectPaymentMethod = selectPaymentMethod;
window.handleAirtimeSubmit = handleAirtimeSubmit;
window.startNewAirtimePurchase = startNewAirtimePurchase;
window.openAirtimeHistory = openAirtimeHistory;
window.closeAirtimeHistory = closeAirtimeHistory;
window.viewHistoricalReceipt = viewHistoricalReceipt;
window.toggleAirtimeDrawer = toggleAirtimeDrawer;
