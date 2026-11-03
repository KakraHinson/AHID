import { supabase } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';
import { applyWalletBalance, refreshWalletBalance } from './walletBalance.js';

// Non-agents are sent to Sign In / Sign Up with an agent prompt.
const AGENT_AUTH_URL = 'login.html?action=agent&notice=agent&register=true&redirect=airtime.html';

// Prefix to network detection (Ghana numbering plan).
const NETWORK_PREFIXES = {
  mtn: ['024', '025', '053', '054', '055', '059'],
  telecel: ['020', '050'],
  at: ['026', '027', '056', '057'],
};

// Brand copy rendered in the modal header per selected network.
const NETWORK_INFO = {
  mtn: { title: 'MTN Airtime', subtitle: 'MTN · Instant airtime top-up', logo: 'img/mtn-logo.png' },
  telecel: { title: 'Telecel Airtime', subtitle: 'Telecel · Instant airtime top-up', logo: 'img/telecel-logo.png' },
  at: { title: 'AT Airtime', subtitle: 'AT (AirtelTigo) · Instant airtime top-up', logo: 'img/airtel-logo.png' },
};

// Application state
let selectedNetwork = 'mtn';
let currentAmount = 10;
let agentUser = null;
let agentWalletBalance = 0;
let agentVerified = false;

function $(id) {
  return document.getElementById(id);
}

// Stable idempotency key per purchase so a duplicate submit never double-charges.
function newClientRequestId() {
  return 'rid_' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

// Amount Selection via chips
export function setAirtimeAmount(val) {
  currentAmount = Number(val);
  const amountInput = $('airtimeAmount');
  if (amountInput) amountInput.value = currentAmount;
  syncAmountChips();
}

// Amount Input Handler
export function handleAmountInput() {
  const val = parseFloat($('airtimeAmount').value);
  currentAmount = Number.isFinite(val) ? val : 0;
  syncAmountChips();
}

function syncAmountChips() {
  document.querySelectorAll('#amountChips .chip-btn').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.amount) === currentAmount);
  });
}

// Prefix to Network Detection
function detectNetworkFromPhone(phone) {
  const clean = phone.replace(/\D/g, '');
  if (clean.length < 3) return null;
  const prefix = clean.slice(0, 3);
  for (const [net, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return net;
  }
  return null;
}

// Update the active service card + modal brand (no modal open/close side effects).
function applyNetworkBrand(net) {
  const brand = NETWORK_INFO[net] || NETWORK_INFO.mtn;
  selectedNetwork = net;
  const title = $('networkBrandTitle');
  const subtitle = $('networkBrandSubtitle');
  const logo = $('networkBrandLogo');
  if (title) title.textContent = brand.title;
  if (subtitle) subtitle.textContent = brand.subtitle;
  if (logo) {
    logo.src = brand.logo;
    logo.alt = `${brand.title} logo`;
  }
  const indicatorText = $('indicatorText');
  if (indicatorText) indicatorText.textContent = net.toUpperCase();
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

  const detected = detectNetworkFromPhone(val);

  if (detected) {
    indicator.className = 'phone-network-indicator detected';
    indicatorText.textContent = detected.toUpperCase();
    if (detected !== selectedNetwork && val.length >= 3) {
      applyNetworkBrand(detected);
    }
  } else {
    indicator.className = 'phone-network-indicator';
    indicatorText.textContent = selectedNetwork.toUpperCase();
  }

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

// Open the flow for a network (called from the service tiles).
export function switchNetwork(net, openModal = true) {
  if (!NETWORK_INFO[net]) net = 'mtn';
  applyNetworkBrand(net);
  clearVerification();
  if (openModal) {
    $('airtimeModal').classList.add('active');
    document.body.style.overflow = 'hidden';
    window.setTimeout(() => $('recipientPhone').focus(), 80);
  }
}

// Step 1 -> Step 2
export function nextAirtimeStep() {
  const phone = $('recipientPhone').value.trim();
  const netAmount = Math.max(0, Number($('airtimeAmount').value) || 0);

  if (!/^0[235]\d{8}$/.test(phone)) {
    showNotice('Please enter a valid 10-digit Ghanaian mobile number (e.g. 0244123456).', true);
    return;
  }
  if (netAmount < 1.00 || netAmount > 500.00) {
    showNotice('Airtime amount must be between GHS 1.00 and GHS 500.00.', true);
    return;
  }

  currentAmount = netAmount;
  const brand = NETWORK_INFO[selectedNetwork] || NETWORK_INFO.mtn;
  $('reviewPhone').textContent = phone;
  $('reviewNetwork').textContent = brand.title.replace(' Airtime', '');
  $('reviewAmount').textContent = netAmount.toFixed(2);
  $('reviewTotal').textContent = netAmount.toFixed(2);

  $('airtimeStepOne').style.display = 'none';
  $('airtimeStepTwo').style.display = 'block';
  $('airtimeStepLabel').textContent = 'Step 2 of 2 · Review and pay';
  $('airtimeStepOneIndicator').classList.remove('active');
  $('airtimeStepOneIndicator').classList.add('done');
  $('airtimeStepTwoIndicator').classList.add('active');
  $('airtimeBackLabel').textContent = 'Back';
  clearNotice();
}

// Back: Step 2 -> Step 1, or Step 1 -> network selection.
export function backAirtimeStep() {
  const onReview = $('airtimeStepTwo').style.display !== 'none';
  if (onReview) {
    $('airtimeStepTwo').style.display = 'none';
    $('airtimeStepOne').style.display = 'block';
    $('airtimeStepLabel').textContent = 'Step 1 of 2 · Enter details';
    $('airtimeStepOneIndicator').classList.add('active');
    $('airtimeStepOneIndicator').classList.remove('done');
    $('airtimeStepTwoIndicator').classList.remove('active');
    clearNotice();
  } else {
    closeAirtimeFlow();
  }
}

// Reset the flow and close the modal.
export function closeAirtimeFlow() {
  const form = $('airtimeForm');
  if (form) form.reset();
  $('airtimeStepTwo').style.display = 'none';
  $('airtimeStepOne').style.display = 'block';
  $('airtimeStepLabel').textContent = 'Step 1 of 2 · Enter details';
  $('airtimeStepOneIndicator').classList.add('active');
  $('airtimeStepOneIndicator').classList.remove('done');
  $('airtimeStepTwoIndicator').classList.remove('active');
  $('airtimeBackLabel').textContent = 'Back';
  clearVerification();
  clearNotice();
  setAirtimeAmount(10);
  const submitBtn = $('submitAirtimeBtn');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-lock"></i> Confirm &amp; Pay';
  }
  $('airtimeModal').classList.remove('active');
  document.body.style.overflow = '';
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

function clearVerification() {
  const validationHint = $('phoneValidationHint');
  if (validationHint) {
    validationHint.className = 'phone-validation-hint';
    validationHint.innerHTML = '<i class="fa-solid fa-circle-info"></i> Enter standard 10-digit Ghana mobile number';
  }
  const indicator = $('phoneNetworkIndicator');
  if (indicator) {
    indicator.className = 'phone-network-indicator';
    const indicatorText = $('indicatorText');
    if (indicatorText) indicatorText.textContent = selectedNetwork.toUpperCase();
  }
}

// Page-level result banner (top of page, not an inline receipt).
function showResultNotice(message, isError = false) {
  const el = $('paymentResultNotice');
  if (!el) return;
  el.className = `notice show ${isError ? 'error' : 'success'}`;
  el.textContent = message;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

// Local order cache (for the Recent Purchases list + badge)
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

function updateHistoryCountBadge() {
  try {
    const orders = JSON.parse(localStorage.getItem('skaitech_airtime_orders') || '[]');
    const badge = $('historyCountBadge');
    if (badge) badge.textContent = orders.length;
  } catch {
    // Ignore
  }
}

// Form Submission
export async function handleAirtimeSubmit(event) {
  event.preventDefault();
  clearNotice();

  const phone = $('recipientPhone').value.trim();
  const netAmount = Math.max(0, Number($('airtimeAmount').value) || 0);

  if (!/^0\d{9}$/.test(phone)) {
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
    // 1. Retrieve active authenticated agent directly
    const { data: authData } = await supabase.auth.getUser();
    const activeUser = authData?.user || agentUser;
    if (!activeUser) {
      throw new Error('Airtime purchases are available only to registered Skaitech Agents. Please register or sign in as an agent.');
    }
    agentUser = activeUser;
    const activeAgentId = activeUser.id;

    if (!agentVerified) {
      throw new Error('Airtime purchases are available only to registered Skaitech Agents. Please register or sign in as an agent.');
    }

    if (agentWalletBalance < netAmount) {
      throw new Error(`Insufficient wallet balance (GHS ${agentWalletBalance.toFixed(2)}). Please deposit funds from the wallet page.`);
    }

    // Auto-heal agent/profile/wallet if missing before requesting purchase
    try {
      const fullName = activeUser.user_metadata?.full_name || activeUser.email?.split('@')[0] || 'Agent';
      const phoneNo = activeUser.user_metadata?.phone || phone || '';
      const agentCode = activeUser.user_metadata?.agent_code || '';

      await supabase.from('profiles').upsert({
        id: activeAgentId,
        full_name: fullName,
        phone: phoneNo || null,
        agent_code: agentCode || null,
      }, { onConflict: 'id' });

      await supabase.from('agents').upsert({
        id: activeAgentId,
        full_name: fullName,
        phone: phoneNo || null,
        agent_code: agentCode || null,
        role: 'agent',
      }, { onConflict: 'id' });

      await supabase.from('wallets').upsert({
        id: activeAgentId,
        balance: 0,
      }, { onConflict: 'id', ignoreDuplicates: true });
    } catch (healErr) {
      console.warn('[airtime.js] Parent tables check note:', healErr);
    }

    showProcessing('Deducting from agent wallet & dispatching top-up...');

    const clientRequestId = newClientRequestId();
    let data = null;
    let error = null;

    try {
      const res = await supabase.functions.invoke('create-airtime-payment', {
        body: {
          network: selectedNetwork,
          phone,
          amount: netAmount,
          paymentMethod: 'wallet',
          clientRequestId,
          agentId: activeAgentId,
          agent_id: activeAgentId,
        }
      });
      data = res.data;
      error = res.error;
    } catch (invokeErr) {
      error = invokeErr;
    }

    hideProcessing();

    if (error || data?.error || data?.success === false) {
      let errorMsg = data?.message || data?.error;

      // Extract specific error message from Supabase FunctionsHttpError / error.context
      if (!errorMsg && error?.context) {
        try {
          const cloned = typeof error.context.clone === 'function' ? error.context.clone() : error.context;
          const body = await cloned.json();
          errorMsg = body?.message || body?.error;
        } catch (_) {
          try {
            const text = await error.context.text();
            if (text && text.trim().length > 0 && !text.includes('<!DOCTYPE') && text.length < 300) {
              errorMsg = text.trim();
            }
          } catch (_) {}
        }
      }

      // Filter out generic SDK strings so user never sees "Edge Function returned a non-2xx status code"
      if (errorMsg && (errorMsg.includes('non-2xx') || errorMsg.includes('Edge Function returned'))) {
        errorMsg = null;
      }

      const fallbackMsg = error?.message && !error.message.includes('non-2xx')
        ? error.message
        : 'Airtime purchase could not be completed. Please check your wallet balance and try again.';

      throw new Error(errorMsg || fallbackMsg);
    }

    // Trust the server-returned balance (authoritative; accounts for refunds).
    if (data.walletBalance !== undefined && data.walletBalance !== null) {
      agentWalletBalance = Number(data.walletBalance);
      applyWalletBalance(agentWalletBalance);
    } else {
      agentWalletBalance = Math.max(0, agentWalletBalance - netAmount);
      applyWalletBalance(agentWalletBalance);
    }

    const orderCode = data.shortCode || data.orderId || (data.reference && data.reference.length === 5 ? data.reference : data.reference?.slice(-5)?.toUpperCase() || 'AIRTM');
    saveOrderToLocalHistory({
      reference: orderCode,
      orderId: orderCode,
      shortCode: orderCode,
      orderReference: data.paymentReference || data.reference,
      phone: data.phone || phone,
      network: data.network || selectedNetwork,
      amount: Number(data.amount || netAmount),
      paymentMethod: 'wallet',
      airtimeStatus: data.airtimeStatus || 'successful',
      createdAt: new Date().toISOString(),
    });

    const brand = NETWORK_INFO[selectedNetwork] || NETWORK_INFO.mtn;
    closeAirtimeFlow();
    showResultNotice(data.message || `${brand.title} top-up of GHS ${netAmount.toFixed(2)} sent to ${phone}. Order ID: #${orderCode}`);
  } catch (err) {
    hideProcessing();
    showNotice(err.message || 'Error completing request.', true);
    submitBtn.disabled = false;
  }
}

// Direct insert helper for airtime_orders with auto-provisioning
export async function submitAirtimeOrderDirect({ phone, network, amount, paymentMethod = 'wallet' }) {
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new Error('Authentication required: please log in as an active agent.');
  }
  const activeAgentId = user.id;
  const fullName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent';
  const phoneNo = user.user_metadata?.phone || phone || '';
  const agentCode = user.user_metadata?.agent_code || '';

  // Auto-heal parent records if missing
  try {
    await supabase.from('profiles').upsert({
      id: activeAgentId,
      full_name: fullName,
      phone: phoneNo || null,
      agent_code: agentCode || null,
    }, { onConflict: 'id' });

    await supabase.from('agents').upsert({
      id: activeAgentId,
      full_name: fullName,
      phone: phoneNo || null,
      agent_code: agentCode || null,
      role: 'agent',
    }, { onConflict: 'id' });

    await supabase.from('wallets').upsert({
      id: activeAgentId,
      balance: 0,
    }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (err) {
    console.warn('[submitAirtimeOrderDirect] Parent records check note:', err);
  }

  const reference = 'AIR-' + crypto.randomUUID();
  const orderPayload = {
    user_id: activeAgentId,
    agent_id: activeAgentId,
    payment_reference: reference,
    recipient_phone: phone,
    network,
    amount: Number(amount),
    fee_amount: 0.00,
    gross_amount: Number(amount),
    payment_method: paymentMethod,
    payment_status: paymentMethod === 'wallet' ? 'paid' : 'pending_payment',
    airtime_status: 'pending',
    customer_name: fullName,
    customer_email: user.email,
  };

  const { data, error } = await supabase
    .from('airtime_orders')
    .insert(orderPayload)
    .select()
    .single();

  if (error) {
    console.error('[submitAirtimeOrderDirect] Direct insert failed:', error);
    throw error;
  }

  return data;
}

// Check Agent Auth Session and Load Wallet
async function initAuth() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    const { isAgent } = await checkAgentAccessServer();
    agentVerified = isAgent;

    if (user) {
      agentUser = user;

      // Auto-heal parent rows in database if missing
      try {
        const { data: existingAgent } = await supabase
          .from('agents')
          .select('id')
          .eq('id', user.id)
          .maybeSingle();

        if (!existingAgent) {
          const fullName = user.user_metadata?.full_name || user.email?.split('@')[0] || 'Agent';
          const phoneNo = user.user_metadata?.phone || '';
          const agentCode = user.user_metadata?.agent_code || '';

          await supabase.from('profiles').upsert({
            id: user.id,
            full_name: fullName,
            phone: phoneNo || null,
            agent_code: agentCode || null,
          }, { onConflict: 'id' });

          await supabase.from('agents').upsert({
            id: user.id,
            full_name: fullName,
            phone: phoneNo || null,
            agent_code: agentCode || null,
            role: 'agent',
          }, { onConflict: 'id' });

          await supabase.from('wallets').upsert({
            id: user.id,
            balance: 0,
          }, { onConflict: 'id', ignoreDuplicates: true });
        }
      } catch (provisionErr) {
        console.warn('[airtime.js] Auto-heal check note:', provisionErr);
      }

      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('id', user.id)
        .maybeSingle();
      if (wallet) agentWalletBalance = Number(wallet.balance) || 0;
    }
  } catch (e) {
    console.warn('Auth check error:', e);
    agentVerified = false;
  }
}

// Non-agents are redirected to Sign In / Sign Up with an agent prompt.
function enforceAgentAccess() {
  if (!agentVerified) {
    window.location.href = AGENT_AUTH_URL;
  }
}

export function closeAirtimeAgentGate() {
  const modal = $('airtimeAgentGateModal');
  if (modal) modal.classList.remove('active');
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
          paymentMethod: o.payment_method,
          airtimeStatus: o.airtime_status,
          createdAt: o.created_at,
        }));
      }
    } catch (e) {
      console.warn('Could not load remote history:', e);
    }
  }

  const map = new Map();
  [...remoteOrders, ...localOrders].forEach(o => {
    if (o.reference && !map.has(o.reference)) map.set(o.reference, o);
  });
  const allOrders = Array.from(map.values());

  if (allOrders.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: #94a3b8; padding: 24px 0;">No past airtime orders found.</p>';
    return;
  }

  container.innerHTML = allOrders.map(order => {
    const isSuccess = ['successful', 'delivered', 'completed'].includes(order.airtimeStatus);
    const isPending = ['pending_provider', 'pending', 'processing'].includes(order.airtimeStatus);
    const statusColor = isSuccess ? '#15803d' : (isPending ? '#b45309' : '#b91c1c');
    const statusBg = isSuccess ? '#dcfce7' : (isPending ? '#fef3c7' : '#fee2e2');
    const statusLabel = isSuccess ? 'Successful' : (isPending ? 'Queued' : 'Failed');
    const dateStr = order.createdAt ? new Date(order.createdAt).toLocaleDateString() : 'Recent';

    return `
      <div class="history-item">
        <div>
          <div style="font-weight: 700; color: #0f172a; font-size: 0.95rem;">
            ${(order.network || '').toUpperCase()} Airtime - GHS ${Number(order.amount).toFixed(2)}
          </div>
          <div style="font-size: 0.8rem; color: #64748b; margin-top: 2px;">
            To: <strong>${order.phone}</strong> &bull; Ref: ${String(order.reference).slice(0, 16)}...
          </div>
          <div style="font-size: 0.75rem; color: #94a3b8; margin-top: 2px;">
            ${dateStr} &bull; Paid via ${(order.paymentMethod || 'wallet').toUpperCase()}
          </div>
        </div>
        <div style="text-align: right;">
          <span style="font-weight: 700; font-size: 0.8rem; color: ${statusColor}; background: ${statusBg}; padding: 3px 8px; border-radius: 9999px;">
            ${statusLabel}
          </span>
        </div>
      </div>
    `;
  }).join('');
}

export function closeAirtimeHistory() {
  const modal = $('historyModal');
  if (modal) modal.classList.remove('active');
}

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', async () => {
  await initAuth();
  enforceAgentAccess();
  refreshWalletBalance();
  updateHistoryCountBadge();
  syncAmountChips();

  const params = new URLSearchParams(window.location.search);
  const net = (params.get('network') || '').toLowerCase();
  const phone = params.get('phone');
  const amt = parseFloat(params.get('amount'));

  if (net && NETWORK_INFO[net]) {
    switchNetwork(net, true);
  }
  if (phone) {
    $('recipientPhone').value = phone.replace(/\D/g, '').slice(0, 10);
    handlePhoneInput();
  }
  if (amt && amt >= 1 && amt <= 500) {
    setAirtimeAmount(amt);
  }
});

// Wire the form submit
const airtimeForm = $('airtimeForm');
if (airtimeForm) airtimeForm.addEventListener('submit', handleAirtimeSubmit);

// Escape closes the flow / history
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('historyModal')?.classList.contains('active')) {
    closeAirtimeHistory();
  } else if ($('airtimeModal')?.classList.contains('active')) {
    closeAirtimeFlow();
  }
});

// Expose globals for inline onclick handlers
window.switchNetwork = switchNetwork;
window.handlePhoneInput = handlePhoneInput;
window.setAirtimeAmount = setAirtimeAmount;
window.handleAmountInput = handleAmountInput;
window.nextAirtimeStep = nextAirtimeStep;
window.backAirtimeStep = backAirtimeStep;
window.closeAirtimeFlow = closeAirtimeFlow;
window.openAirtimeHistory = openAirtimeHistory;
window.closeAirtimeHistory = closeAirtimeHistory;
window.closeAirtimeAgentGate = closeAirtimeAgentGate;
