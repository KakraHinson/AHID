import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';
import { applyWalletBalance, refreshWalletBalance } from './walletBalance.js';

// Service page visitors must be sent to here to sign in / register as agents.
const AGENT_AUTH_URL = 'login.html?action=agent&notice=agent&register=true&redirect=utilityBills.html';

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
let currentService = 'ecg_prepaid';
let verifiedAccountKey = '';
let accountVerifyTimer = 0;

const SERVICE_INFO = {
  ecg_prepaid: { title: 'ECG Prepaid', subtitle: 'ECG · Prepaid electricity', logo: 'img/ecg%20logo.jpg' },
  ecg_postpaid: { title: 'ECG Postpaid', subtitle: 'ECG · Electricity bill payment', logo: 'img/ecg%20logo.jpg' },
  ghana_water: { title: 'Ghana Water', subtitle: 'GWCL · Water bill payment', logo: 'img/ghana%20water%20logo.png' },
  dstv: { title: 'DStv', subtitle: 'MultiChoice · TV subscription', logo: 'img/dstv.jpg' },
  gotv: { title: 'GOtv', subtitle: 'MultiChoice · TV subscription', logo: 'img/go%20tv%20logo.png' },
startimes: { title: 'StarTimes', subtitle: 'StarTimes · TV subscription', logo: 'img/star%20time%20logo.jpg' },
};

function $(id) {
  return document.getElementById(id);
}

export function updateSummary() {
  const amountInput = $('billAmount');
  const netAmount = Math.max(0, parseFloat(amountInput.value) || 0);
  // Wallet purchase: the exact amount is deducted, no checkout fee.
  const grossAmount = netAmount;
  const fee = 0;

  $('summaryNet').textContent = netAmount.toFixed(2);
  $('summaryFee').textContent = fee.toFixed(2);
  $('summaryTotal').textContent = grossAmount.toFixed(2);
  document.querySelectorAll('#amountChips .chip-btn').forEach(chip => {
    chip.classList.toggle('active', Number(chip.dataset.amount) === netAmount);
  });
}

export function setAmount(val) {
  $('billAmount').value = val;
  // Update active chip
  const chips = document.querySelectorAll('#amountChips .chip-btn');
  chips.forEach(c => {
    if (Number(c.dataset.amount) === val) {
      c.classList.add('active');
    } else {
      c.classList.remove('active');
    }
  });
  updateSummary();
}

export function switchBillCategory(category, openModal = true) {
  const service = category;
  currentService = service;
currentCategory = service === 'ghana_water' ? 'ghana_water' : ['dstv', 'gotv', 'startimes'].includes(service) ? 'tv' : 'ecg';
  if (currentCategory === 'tv') currentTvProvider = service;
  ['ecg_prepaid', 'ecg_postpaid', 'ghana_water', 'dstv', 'gotv', 'startimes'].forEach(key => {
    const buttonIds = { ecg_prepaid: 'serviceEcgPrepaid', ecg_postpaid: 'serviceEcgPostpaid', ghana_water: 'serviceWater', dstv: 'serviceDstv', gotv: 'serviceGotv', startimes: 'serviceStartimes' };
    const button = $(buttonIds[key]);
    if (button) button.classList.toggle('active', key === service);
  });

  const brand = SERVICE_INFO[service];
  if (brand) {
    $('serviceBrandTitle').textContent = brand.title;
    $('serviceBrandSubtitle').textContent = brand.subtitle;
    $('serviceBrandLogo').src = brand.logo;
    $('serviceBrandLogo').alt = `${brand.title} logo`;
  }

  // Reset verification message
  clearVerification();

  // Show/hide relevant fields
  const meterTypeField = $('meterTypeField');
  const tvProviderRow = $('tvProviderRow');
  const tvPackageField = $('tvPackageField');
  const accountLabel = $('accountLabel');
  const accountInput = $('accountNumber');

  if (currentCategory === 'ecg') {
    meterTypeField.style.display = service === 'ecg_prepaid' ? 'block' : 'none';
    tvProviderRow.style.display = 'none';
    tvPackageField.style.display = 'none';
    accountLabel.textContent = service === 'ecg_postpaid' ? 'ECG Account Number' : 'Prepaid Meter Number';
    accountInput.placeholder = service === 'ecg_postpaid' ? 'Enter ECG account number' : 'Enter prepaid meter number';
} else if (currentCategory === 'ghana_water') {
    meterTypeField.style.display = 'none';
    tvProviderRow.style.display = 'none';
    tvPackageField.style.display = 'none';
    accountLabel.textContent = 'GWCL Customer Account Number';
    accountInput.placeholder = 'e.g., GW-84920492';
  } else if (currentCategory === 'tv') {
    meterTypeField.style.display = 'none';
    tvProviderRow.style.display = 'none';
    tvPackageField.style.display = 'block';
    selectTvProvider(service);
  }

  updateSummary();
  if (openModal) {
    $('utilityModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('accountNumber').focus(), 80);
  }
}

export function selectTvProvider(provider) {
  currentService = provider;
  currentTvProvider = provider;
  ['dstv', 'gotv', 'startimes'].forEach(key => {
    const button = $(`service${key[0].toUpperCase()}${key.slice(1)}`);
    if (button) button.classList.toggle('active', provider === key);
  });

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
  verifiedAccountKey = '';
  const el = $('verificationMsg');
  if (el) {
    el.textContent = '';
    el.className = 'verification-status';
    el.style.display = '';
  }
}

export async function verifyAccount() {
  const accountInput = $('accountNumber');
  const accountVal = accountInput.value.trim();
  const statusEl = $('verificationMsg');

  if (!accountVal || accountVal.length < 5) {
    statusEl.textContent = 'Please enter a valid number (at least 5 characters).';
    statusEl.className = 'verification-status error';
    return;
  }

  statusEl.textContent = 'Verifying with utility provider...';
  statusEl.className = 'verification-status';
  statusEl.style.display = 'block';
  const billType = currentService === 'ecg_prepaid' ? 'ecg' : currentService;
  const meterType = currentService === 'ecg_prepaid' ? $('meterType').value : null;
  try {
    const { data, error } = await supabase.functions.invoke('verify-utility-account', {
      body: { billType, accountNumber: accountVal, meterType },
    });
    if (error || data?.verified !== true) {
      let errorMsg = data?.error;
      if (!errorMsg && error?.context) {
        try {
          const body = await error.context.json();
          errorMsg = body?.error || body?.message;
        } catch (_) {}
      }
      throw new Error(errorMsg || error?.message || 'Account verification failed.');
    }
    const verifiedName = data.customerName || '';
    statusEl.textContent = verifiedName ? `Account verified: ${verifiedName}` : 'Account verified by provider.';
    statusEl.className = 'verification-status success';
    verifiedAccountKey = `${currentService}:${accountVal}:${meterType || ''}`;
  } catch (err) {
    verifiedAccountKey = '';
    statusEl.textContent = err.message || 'Unable to verify this account.';
    statusEl.className = 'verification-status error';
  }
}

export function nextUtilityStep() {
  const form = $('utilityBillForm');
  const accountNumber = $('accountNumber').value.trim();
  const meterType = currentService === 'ecg_prepaid' ? $('meterType').value : '';
  if (!form.reportValidity()) return;
  if (verifiedAccountKey !== `${currentService}:${accountNumber}:${meterType}`) {
    showNotice('Verify this account with the provider before continuing.', true);
    $('verificationMsg').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
const brand = SERVICE_INFO[currentService];
  const net = Math.max(0, Number($('billAmount').value) || 0);
  const total = net;
  $('reviewService').textContent = `${brand.title}${currentCategory === 'tv' ? ` · ${$('tvPackage').value}` : ''}`;
  $('reviewAccount').textContent = accountNumber;
  $('reviewNet').textContent = net.toFixed(2);
  $('reviewFee').textContent = '0.00';
  $('reviewTotal').textContent = total.toFixed(2);
  $('utilityStepOne').style.display = 'none';
  $('utilityStepTwo').style.display = 'block';
  $('utilityStepLabel').textContent = 'Step 2 of 2 · Review and pay';
  $('utilityStepOneIndicator').classList.remove('active');
  $('utilityStepOneIndicator').classList.add('done');
  $('utilityStepTwoIndicator').classList.add('active');
  showNotice('Review your account and total before confirming payment.');
}

export function backUtilityStep() {
  $('utilityStepTwo').style.display = 'none';
  $('utilityStepOne').style.display = 'block';
  $('utilityStepLabel').textContent = 'Step 1 of 2 · Enter details';
  $('utilityStepOneIndicator').classList.add('active');
  $('utilityStepOneIndicator').classList.remove('done');
  $('utilityStepTwoIndicator').classList.remove('active');
}

export function closeUtilityFlow() {
  $('utilityBillForm').reset();
  backUtilityStep();
  clearVerification();
  setAmount(50);
  $('utilityModal').classList.remove('active');
  document.body.style.overflow = '';
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

// Non-agents are redirected to Sign In / Sign Up with an agent prompt.
export function openAgentModal() {
  window.location.href = AGENT_AUTH_URL;
}

export function closeAgentModal() {
  const modal = $('agentGateModal');
  if (modal) modal.classList.remove('active');
}

// Server-verified agent check (never trust client-side role claims).
export async function checkAgentAccess() {
  try {
    const { isAgent } = await checkAgentAccessServer();
    return isAgent;
  } catch (err) {
    console.warn('Error checking agent access in utilityBills.js:', err);
    return false;
  }
}

// Payment form submission
$('utilityBillForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submitPayBtn');
  const accountNumber = $('accountNumber').value.trim();
  const meterType = currentService === 'ecg_prepaid' ? $('meterType').value : '';
  const expectedVerification = `${currentService}:${accountNumber}:${meterType}`;
  if (!verifiedAccountKey || verifiedAccountKey !== expectedVerification) {
    showNotice('Verify this account with the provider before continuing.', true);
    $('verificationMsg').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Checking agent account...';
  showNotice('Verifying agent authorization...');

  const isAgent = await checkAgentAccess();
  if (!isAgent) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Pay with Wallet Balance';
    showNotice('Agent account required. Please register or sign in as an agent to pay utility bills.', true);
    openAgentModal();
    return;
  }

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing payment...';
  showNotice('Charging your wallet and confirming the payment with the utility provider...');

  const billType = currentService === 'ecg_prepaid' ? 'ecg' : currentService;
  const meterTypeForPayment = currentService === 'ecg_prepaid' ? $('meterType').value : null;
  const packageName = currentCategory === 'tv' ? $('tvPackage').value : null;
  const customerPhone = $('customerPhone').value.trim();
  const amount = parseFloat($('billAmount').value);

  try {
    const { data, error } = await supabase.functions.invoke('create-utility-bill-payment', {
      body: {
        billType,
        accountNumber,
        meterType: meterTypeForPayment,
        packageName,
        customerPhone,
        amount,
      }
    });

    if (error || data?.error) {
      let errorMsg = data?.error;
      if (!errorMsg && error?.context) {
        try {
          const body = await error.context.json();
          errorMsg = body?.error || body?.message;
        } catch (_) {}
      }
      throw new Error(errorMsg || error?.message || 'Failed to process payment.');
    }

    if (Number.isFinite(Number(data.walletBalance))) applyWalletBalance(data.walletBalance);

    // Cache the completed order for tracking
    sessionStorage.setItem('skaitech_utility_payment', JSON.stringify({
      reference: data.reference,
      phone: customerPhone,
      billType,
      accountNumber,
      amount,
    }));

    // Show the provider receipt; delivery can remain pending if its response
    // was accepted but the final order update needs reconciliation.
    const noticeEl = $('paymentResultNotice');
    const isProcessing = data.status === 'processing';
    if (noticeEl) {
      noticeEl.className = `notice show ${isProcessing ? 'info' : 'success'}`;
      noticeEl.textContent = data.message || 'Payment successful.';
    }
    const receipt = $('receiptCard');
    if (receipt) {
      receipt.style.display = 'block';
      $('tokenContainer').style.display = data.token ? 'block' : 'none';
      $('receiptToken').textContent = data.token || '---- ---- ---- ---- ----';
      $('receiptRef').textContent = data.reference;
      $('receiptService').textContent = (data.billType || billType).toUpperCase() + (packageName ? ` - ${packageName}` : '');
      $('receiptAccount').textContent = accountNumber;
      $('receiptName').textContent = data.customerName || 'Customer';
      $('receiptPhone').textContent = customerPhone;
      $('receiptAmount').textContent = `GHS ${Number(data.grossAmount || data.amount || amount).toFixed(2)}`;
      $('receiptDate').textContent = new Date().toLocaleString();
      $('receiptTitle').textContent = isProcessing ? 'Payment Processing' : 'Utility Payment Receipt';
      $('receiptStatus').textContent = isProcessing ? 'Processing' : 'Completed';
      $('receiptStatus').style.color = isProcessing ? '#b45309' : '#15803d';
      if (data.token) {
        $('receiptToken').textContent = data.token;
      }
      const orders = JSON.parse(localStorage.getItem('skaitech_orders') || '[]');
      if (!orders.some(o => o.trackingId === data.reference)) {
        orders.unshift({
          trackingId: data.reference,
          network: (data.billType || billType).toUpperCase(),
          size: packageName || 'BILL PAYMENT',
          price: `GHS ${Number(data.grossAmount || data.amount || amount).toFixed(2)}`,
          name: data.customerName || 'Customer',
          phone: customerPhone,
          status: isProcessing ? 'Processing' : 'Successful',
          date: new Date().toLocaleString(),
        });
        localStorage.setItem('skaitech_orders', JSON.stringify(orders));
      }
    }
    if ($('utilityBillForm')) $('utilityBillForm').reset();
    clearVerification();
    backUtilityStep();
    setAmount(50);
  } catch (err) {
    showNotice(err.message || 'Error processing request.', true);
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-lock"></i> Pay with Wallet Balance';
  }
});

// Check if returning from Paystack redirect
async function checkPaymentReturn() {
  const urlParams = new URLSearchParams(window.location.search);
  const reference = urlParams.get('reference');
  if (!reference || !reference.startsWith('UTIL-')) return;

  const { data: { user } } = await supabase.auth.getUser();
  const email = String(user?.email || '').trim();
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
    switchBillCategory('ghana_water', false);
  } else if (['dstv', 'gotv', 'startimes', 'ecg_postpaid', 'ecg_prepaid'].includes(service)) {
    switchBillCategory(service, false);
  } else {
    switchBillCategory('ecg_prepaid', false);
  }
}

$('accountNumber').addEventListener('input', () => {
  clearVerification();
  window.clearTimeout(accountVerifyTimer);
  if ($('accountNumber').value.trim().length >= 5) {
    $('verificationMsg').textContent = 'Checking account details…';
    $('verificationMsg').className = 'verification-status';
    $('verificationMsg').style.display = 'block';
    accountVerifyTimer = window.setTimeout(() => verifyAccount(), 700);
  }
});
$('meterType').addEventListener('change', clearVerification);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('utilityModal').classList.contains('active')) closeUtilityFlow();
});

// Global binds
window.switchBillCategory = switchBillCategory;
window.selectTvProvider = selectTvProvider;
window.setAmount = setAmount;
window.updateSummary = updateSummary;
window.nextUtilityStep = nextUtilityStep;
window.backUtilityStep = backUtilityStep;
window.closeUtilityFlow = closeUtilityFlow;
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
refreshWalletBalance();
