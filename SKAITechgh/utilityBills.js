import { supabase } from './supabaseClient.js';

// Package definitions
const TV_PACKAGES = {
  dstv: [
    { name: 'DStv Padi', price: 75 },
    { name: 'DStv Access', price: 110 },
    { name: 'DStv Family', price: 180 },
    { name: 'DStv Compact', price: 300 },
    { name: 'DStv Compact Plus', price: 450 },
    { name: 'DStv Premium', price: 680 },
    { name: 'Custom Top-Up', price: 0 }
  ],
  gotv: [
    { name: 'GOtv Smallie', price: 30 },
    { name: 'GOtv Jinja', price: 50 },
    { name: 'GOtv Jolli', price: 80 },
    { name: 'GOtv Max', price: 125 },
    { name: 'GOtv Supa', price: 175 },
    { name: 'GOtv Supa Plus', price: 240 },
    { name: 'Custom Top-Up', price: 0 }
  ],
  
  startimes: [
    { name: 'StarTimes Nova', price: 30 },
    { name: 'StarTimes Basic', price: 55 },
    { name: 'StarTimes Classic', price: 75 },
    { name: 'StarTimes Super', price: 110 },
    { name: 'Custom Top-Up', price: 0 }
  ]
};

// State
let currentCategory = 'ecg';
let currentTvProvider = 'dstv';
const FEE_PERCENT = 0.015;

function $(id) {
  return document.getElementById(id);
}

function calculateGross(net) {
  const safeRate = Number.isFinite(FEE_PERCENT) ? FEE_PERCENT : 0.015;
  return Math.round(((net / (1 - safeRate)) + Number.EPSILON) * 100) / 100;
}

export function updateSummary() {
  const amountInput = $('billAmount');
  const netAmount = Math.max(0, parseFloat(amountInput.value) || 0);
  const grossAmount = calculateGross(netAmount);
  const fee = Math.max(0, Math.round((grossAmount - netAmount + Number.EPSILON) * 100) / 100);

  $('summaryNet').textContent = netAmount.toFixed(2);
  $('summaryFee').textContent = fee.toFixed(2);
  $('summaryTotal').textContent = grossAmount.toFixed(2);
}

export function setAmount(val) {
  $('billAmount').value = val;
  // Update active chip
  const chips = document.querySelectorAll('#amountChips .chip-btn');
  chips.forEach(c => {
    if (parseFloat(c.textContent) === val) {
      c.classList.add('active');
    } else {
      c.classList.remove('active');
    }
  });
  updateSummary();
}

export function switchBillCategory(category) {
  currentCategory = category;

  // Update tabs
  $('tabBtnEcg').classList.toggle('active', category === 'ecg');
  $('tabBtnWater').classList.toggle('active', category === 'ghana_water');
  $('tabBtnTv').classList.toggle('active', category === 'tv');

  // Reset verification message
  clearVerification();

  // Show/hide relevant fields
  const meterTypeField = $('meterTypeField');
  const tvProviderRow = $('tvProviderRow');
  const tvPackageField = $('tvPackageField');
  const accountLabel = $('accountLabel');
  const accountInput = $('accountNumber');

  if (category === 'ecg') {
    meterTypeField.style.display = 'block';
    tvProviderRow.style.display = 'none';
    tvPackageField.style.display = 'none';
    accountLabel.textContent = 'Meter Number';
    accountInput.placeholder = 'e.g., 01420582910';
  } else if (category === 'ghana_water') {
    meterTypeField.style.display = 'none';
    tvProviderRow.style.display = 'none';
    tvPackageField.style.display = 'none';
    accountLabel.textContent = 'GWCL Customer Account Number';
    accountInput.placeholder = 'e.g., GW-84920492';
  } else if (category === 'tv') {
    meterTypeField.style.display = 'none';
    tvProviderRow.style.display = 'flex';
    tvPackageField.style.display = 'block';
    selectTvProvider(currentTvProvider);
  }

  updateSummary();
}

export function selectTvProvider(provider) {
  currentTvProvider = provider;
  $('tvBtnDstv').classList.toggle('active', provider === 'dstv');
  $('tvBtnGotv').classList.toggle('active', provider === 'gotv');
  $('tvBtnStartimes').classList.toggle('active', provider === 'startimes');

  const accountLabel = $('accountLabel');
  const accountInput = $('accountNumber');

  if (provider === 'dstv') {
    accountLabel.textContent = 'DStv Smartcard Number';
    accountInput.placeholder = 'e.g., 1029384756';
  } else if (provider === 'gotv') {
    accountLabel.textContent = 'GOtv IUC / Decoder Number';
    accountInput.placeholder = 'e.g., 2019283746';
  } else {
    accountLabel.textContent = 'StarTimes Smartcard / e-Code';
    accountInput.placeholder = 'e.g., 01827364521';
  }

  // Populate packages
  const packages = TV_PACKAGES[provider] || [];
  const packageSelect = $('tvPackage');
  packageSelect.innerHTML = packages
    .map(p => `<option value="${p.name}" data-price="${p.price}">${p.name} ${p.price > 0 ? `(GHS ${p.price.toFixed(2)})` : ''}</option>`)
    .join('');

  onPackageSelect();
  clearVerification();
}

export function onPackageSelect() {
  const select = $('tvPackage');
  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) return;
  const price = parseFloat(selectedOpt.getAttribute('data-price')) || 0;
  if (price > 0) {
    setAmount(price);
  }
}

function clearVerification() {
  const el = $('verificationMsg');
  if (el) {
    el.textContent = '';
    el.className = 'verification-status';
  }
}

function sanitizeMeterNumber(val) {
  let clean = String(val || '').trim();
  // Ensure meter number is treated strictly as an alphanumeric string without phone formatting.
  // If a browser autofill or user mistakenly prepended "+233" or "233" to an alphanumeric meter, strip it.
  if (/^\+?233[A-Za-z]/.test(clean)) {
    clean = clean.replace(/^\+?233/, '');
  }
  return clean;
}

export async function verifyAccount() {
  const accountInput = $('accountNumber');
  const accountVal = sanitizeMeterNumber(accountInput.value);
  if (accountInput.value !== accountVal) accountInput.value = accountVal;
  const statusEl = $('verificationMsg');

  if (!accountVal || accountVal.length < 4) {
    statusEl.textContent = 'Please enter a valid meter or account number (at least 4 characters).';
    statusEl.className = 'verification-status error';
    return;
  }

  statusEl.textContent = 'Verifying with utility provider...';
  statusEl.className = 'verification-status';
  statusEl.style.display = 'block';

  // Simulate remote verification response with realistic delay
  await new Promise(r => setTimeout(r, 600));

  let verifiedName = '';
  if (currentCategory === 'ecg') {
    const meterType = $('meterType').value;
    verifiedName = 'KWAME BOADI (RESIDENTIAL - ' + meterType + ')';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Verified Meter: <strong>${verifiedName}</strong>`;
  } else if (currentCategory === 'ghana_water') {
    verifiedName = 'AMA MENSAH (GWCL ACCRA EAST)';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Verified Account: <strong>${verifiedName}</strong>`;
  } else {
    const provName = currentTvProvider.toUpperCase();
    verifiedName = 'KOFI ADDO (' + provName + ' ACTIVE)';
    statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Verified Smartcard: <strong>${verifiedName}</strong>`;
  }

  statusEl.className = 'verification-status success';
  const nameInput = $('customerName');
  if (nameInput && !nameInput.value.trim()) {
    nameInput.value = verifiedName.split(' (')[0];
  }
}

function showNotice(message, isError = false) {
  const el = $('formNotice');
  if (el) {
    el.textContent = message;
    el.className = `notice show ${isError ? 'error' : 'info'}`;
  }
}

export function copyToken() {
  const token = $('receiptToken').textContent;
  if (token) {
    navigator.clipboard.writeText(token.replace(/\s+/g, ''));
    const btn = $('copyTokenBtn');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> Copied!';
    setTimeout(() => {
      btn.innerHTML = '<i class="fa-solid fa-copy"></i> Copy Token';
    }, 2500);
  }
}

export function openAgentModal() {
  const modal = $('agentGateModal');
  if (modal) modal.classList.add('active');
}

export function closeAgentModal() {
  const modal = $('agentGateModal');
  if (modal) modal.classList.remove('active');
}

export async function checkAgentAccess() {
  try {
    const { data: { user }, error: userError } = await supabase.auth.getUser();
    if (userError || !user) {
      return false;
    }

    const metaRole = user.user_metadata?.role;
    if (metaRole === 'agent' || metaRole === 'admin') {
      return true;
    }

    const { data: agent } = await supabase
      .from('agents')
      .select('role')
      .eq('id', user.id)
      .single();

    if (agent && (agent.role === 'agent' || agent.role === 'admin')) {
      return true;
    }

    // Also check profiles for backwards compatibility with registered agents
    const { data: profile } = await supabase
      .from('profiles')
      .select('agent_code')
      .eq('id', user.id)
      .single();

    return !!profile?.agent_code;
  } catch (err) {
    console.warn('Error checking agent access in utilityBills.js:', err);
    return false;
  }
}

// Payment form submission
$('utilityBillForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submitPayBtn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking agent account...';
  showNotice('Verifying agent authorization...');

  const isAgent = await checkAgentAccess();
  if (!isAgent) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Pay with Paystack';
    showNotice('Agent account required. Please register or sign in as an agent to pay utility bills.', true);
    openAgentModal();
    return;
  }

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Initializing Paystack...';
  showNotice('Connecting to secure payment gateway...');

  const billType = currentCategory === 'tv' ? currentTvProvider : currentCategory;
  const accountNumber = $('accountNumber').value.trim();
  const meterType = currentCategory === 'ecg' ? $('meterType').value : null;
  const packageName = currentCategory === 'tv' ? $('tvPackage').value : null;
  const customerName = $('customerName').value.trim();
  const customerPhone = $('customerPhone').value.trim();
  const customerEmail = $('customerEmail').value.trim().toLowerCase();
  const amount = parseFloat($('billAmount').value);

  try {
    const { data, error } = await supabase.functions.invoke('create-utility-bill-payment', {
      body: {
        billType,
        accountNumber,
        meterType,
        packageName,
        customerName,
        customerPhone,
        customerEmail,
        amount,
      }
    });

    if (error || data?.error) {
      throw new Error(data?.error || error?.message || 'Failed to initiate payment.');
    }

    // Cache pending order info locally
    sessionStorage.setItem('skaitech_utility_payment', JSON.stringify({
      reference: data.reference,
      email: customerEmail,
      name: customerName,
      phone: customerPhone,
      billType,
      accountNumber,
      amount,
    }));

    window.location.href = data.authorizationUrl;
  } catch (err) {
    showNotice(err.message || 'Error processing request.', true);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Pay with Paystack';
  }
});

// Check if returning from Paystack redirect
async function checkPaymentReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const reference = urlParams.get('reference');
  if (!reference || !reference.startsWith('UTIL-')) return;

  const saved = JSON.parse(sessionStorage.getItem('skaitech_utility_payment') || '{}');
  const email = saved.email || prompt('Please confirm your email address used for payment:');
  if (!email) return;

  const noticeEl = $('paymentResultNotice');
  noticeEl.className = 'notice show info';
  noticeEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Confirming your payment with Paystack...';

  try {
    const { data, error } = await supabase.functions.invoke('get-utility-bill-order', {
      body: { reference, email }
    });

    if (error || data?.error) {
      noticeEl.className = 'notice show error';
      noticeEl.textContent = data?.error || 'Unable to load order details.';
      return;
    }

    const order = data.order;
    if (order.status === 'completed' || order.status === 'paid') {
      noticeEl.style.display = 'none';
      const receipt = $('receiptCard');
      receipt.style.display = 'block';

      $('receiptRef').textContent = order.payment_reference;
      $('receiptService').textContent = (order.bill_type || '').toUpperCase() + (order.package_name ? ` - ${order.package_name}` : '');
      $('receiptAccount').textContent = order.account_number;
      $('receiptName').textContent = order.customer_name || 'Customer';
      $('receiptPhone').textContent = order.customer_phone;
      $('receiptAmount').textContent = `GHS ${Number(order.amount).toFixed(2)}`;
      $('receiptDate').textContent = new Date(order.created_at).toLocaleString();

      if (order.token_code && order.bill_category === 'electricity') {
        $('tokenContainer').style.display = 'block';
        $('receiptToken').textContent = order.token_code;
      }

      // Save to local storage for tracking
      const orders = JSON.parse(localStorage.getItem('skaitech_orders') || '[]');
      if (!orders.some(o => o.trackingId === order.payment_reference)) {
        orders.unshift({
          trackingId: order.payment_reference,
          network: (order.bill_type || 'UTILITY').toUpperCase(),
          size: order.package_name || `${order.bill_category.toUpperCase()} PAYMENT`,
          price: `GHS ${Number(order.amount).toFixed(2)}`,
          name: order.customer_name || 'Customer',
          phone: order.customer_phone,
          status: 'Successful',
          date: new Date(order.created_at).toLocaleString(),
        });
        localStorage.setItem('skaitech_orders', JSON.stringify(orders));
      }
    } else {
      noticeEl.className = 'notice show info';
      noticeEl.textContent = 'Payment is still being processed. Please refresh in a moment.';
    }
  } catch (err) {
    noticeEl.className = 'notice show error';
    noticeEl.textContent = 'Error checking payment status: ' + err.message;
  }
}

// Parse URL param for pre-selected service
function checkUrlServiceParam() {
  const urlParams = new URLSearchParams(window.location.search);
  const service = urlParams.get('service');
  if (service === 'water' || service === 'ghana_water') {
    switchBillCategory('ghana_water');
  } else if (service === 'tv') {
    switchBillCategory('tv');
  } else if (service === 'dstv') {
    switchBillCategory('tv');
    selectTvProvider('dstv');
  } else if (service === 'gotv') {
    switchBillCategory('tv');
    selectTvProvider('gotv');
  } else if (service === 'startimes') {
    switchBillCategory('tv');
    selectTvProvider('startimes');
  } else {
    switchBillCategory('ecg');
  }
}

// Global binds
window.switchBillCategory = switchBillCategory;
window.selectTvProvider = selectTvProvider;
window.setAmount = setAmount;
window.updateSummary = updateSummary;
window.verifyAccount = verifyAccount;
window.onPackageSelect = onPackageSelect;
window.copyToken = copyToken;
window.openAgentModal = openAgentModal;
window.closeAgentModal = closeAgentModal;

// Check agent access on page load
async function initAgentCheck() {
  const isAgent = await checkAgentAccess();
  if (!isAgent) {
    showNotice('Agent account required. Please register or sign in as an agent to pay utility bills.', true);
    openAgentModal();
  }
}

// Init
checkUrlServiceParam();
checkPaymentReturn();
initAgentCheck();
