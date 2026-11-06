import { readFunctionError, supabase } from './supabaseClient.js?v=2026110506';
import { checkAgentAccessServer } from './agentAccessCheck.js';
import { applyWalletBalance, refreshWalletBalance } from './walletBalance.js';

const FALLBACK_PRICES = { BECE: 19, WASSCE: 22 };
let PRICES = { ...FALLBACK_PRICES };
const $ = (id) => document.getElementById(id);
function notice(message, isError = false) { const el = $('notice'); el.textContent = message; el.className = `notice show${isError ? ' error' : ''}`; }
function escapeHtml(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function checkerExamLabel(value) { return String(value || '').toUpperCase() === 'BECE' ? 'BECE' : 'WASSCE / NOV/DEC'; }
function updatePrice() {
  const price = Number(PRICES[$('examType').value] || 0);
  const quantity = Math.max(1, Number.parseInt($('quantity').value, 10) || 1);
  $('quantity').value = quantity;
  $('pricePerPin').textContent = price.toFixed(2);
  $('totalPrice').textContent = (price * quantity).toFixed(2);
  const bece = $('becePriceDisplay');
  const wassce = $('wasscePriceDisplay');
  if (bece) bece.textContent = `GH₵${Number(PRICES.BECE).toFixed(2)}`;
  if (wassce) wassce.textContent = `GH₵${Number(PRICES.WASSCE).toFixed(2)}`;
}

async function loadCheckerPrices() {
  try {
    const { data, error } = await supabase
      .from('service_pricing')
      .select('service, price')
      .in('service', ['result_checker_bece', 'result_checker_wassce']);
    if (error) throw error;
    for (const row of data || []) {
      const key = row.service === 'result_checker_bece' ? 'BECE' : row.service === 'result_checker_wassce' ? 'WASSCE' : '';
      const price = Number(row.price);
      if (key && Number.isFinite(price) && price > 0) PRICES[key] = Math.round(price * 100) / 100;
    }
  } catch (error) {
    console.warn('Could not load result checker prices:', error);
  }
  updatePrice();
}

function selectResultsExam(examType) {
  if (!Object.hasOwn(PRICES, examType)) return;
  $('examType').value = examType;
  updatePrice();
  $('purchasePanel').hidden = false;
  $('purchasePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('phoneNumber').focus({ preventScroll: true }), 350);
}

function closeResultsPurchase() {
  $('purchasePanel').hidden = true;
  $('notice').className = 'notice';
  $('pins').hidden = true;
}

function parseOrderCredentials(serialPin) {
  if (!serialPin) return [];
  try {
    const parsed = typeof serialPin === 'string' ? JSON.parse(serialPin) : serialPin;
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.pin) : [];
  } catch (_) {
    return [];
  }
}

async function copyResultText(button) {
  const text = button?.dataset.copy || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const original = button.innerHTML;
  button.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
  window.setTimeout(() => { button.innerHTML = original; }, 1400);
}

function renderResultsHistory(orders) {
  const list = $('resultsHistoryList');
  if (!list) return;
  if (!orders.length) {
    list.innerHTML = '<div class="results-history-empty">No results checker orders yet.</div>';
    return;
  }

  list.innerHTML = orders.map((order) => {
    const status = String(order.status || 'pending_payment').toLowerCase();
    const isPaid = status === 'paid';
    const isFailed = status === 'failed';
    const credentials = isPaid ? parseOrderCredentials(order.serial_pin) : [];
    const credentialText = credentials.map((item, index) => `PIN ${index + 1}: ${item.pin}${item.serial ? ` | SERIAL: ${item.serial}` : ''}`).join('\n');
    const copyAllText = `Order: ${order.payment_reference}\nExam: ${checkerExamLabel(order.exam_type)}\nQuantity: ${order.quantity}\n${credentialText}`.trim();
    const statusLabel = isPaid ? 'Completed' : isFailed ? 'Failed' : 'Processing';
    const statusClass = isPaid ? '' : isFailed ? ' failed' : ' pending';
    const credentialsHtml = credentials.length
      ? `<div class="results-history-credentials">${credentials.map((item, index) => {
          const text = `PIN: ${item.pin}${item.serial ? ` | SERIAL: ${item.serial}` : ''}`;
          return `<div class="results-history-credential"><code>${escapeHtml(text)}</code><button type="button" class="copy-result-btn" data-copy="${escapeHtml(text)}" onclick="copyResultText(this)"><i class="fa-regular fa-copy"></i> Copy</button></div>`;
        }).join('')}</div>`
      : `<p class="results-history-meta">${isFailed ? 'This order did not complete; no PIN was assigned.' : 'PIN details will appear after payment is confirmed.'}</p>`;
    return `
      <article class="results-history-item">
        <div class="results-history-top">
          <div>
            <h3 class="results-history-ref">${escapeHtml(order.payment_reference)}</h3>
            <p class="results-history-meta">${escapeHtml(checkerExamLabel(order.exam_type))} · ${Number(order.quantity) || 0} PIN(s) · GH₵${Number(order.amount || 0).toFixed(2)} · ${new Date(order.created_at).toLocaleString()}</p>
          </div>
          <span class="results-history-status${statusClass}">${statusLabel}</span>
        </div>
        ${credentialsHtml}
        <div style="display:flex;justify-content:flex-end;margin-top:12px;"><button type="button" class="results-history-copy-all" data-copy="${escapeHtml(copyAllText)}" onclick="copyResultText(this)"><i class="fa-regular fa-copy"></i> Copy order</button></div>
      </article>`;
  }).join('');
}

async function loadResultHistory() {
  const list = $('resultsHistoryList');
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      if (list) list.innerHTML = '<div class="results-history-empty">Sign in as an agent to view your checker history.</div>';
      return;
    }
    const { data, error } = await supabase
      .from('results_orders')
      .select('payment_reference, exam_type, quantity, amount, recipient_phone, status, serial_pin, created_at')
      .eq('agent_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    renderResultsHistory(data || []);
  } catch (error) {
    console.error('Could not load result checker history:', error);
    if (list) list.innerHTML = '<div class="results-history-empty">Unable to load checker history right now.</div>';
  }
}

window.selectResultsExam = selectResultsExam;
window.closeResultsPurchase = closeResultsPurchase;
window.copyResultText = copyResultText;

async function showCompletedOrder(reference) {
  const saved = JSON.parse(sessionStorage.getItem('skaitech_result_payment') || '{}');
  if (saved.reference !== reference) { notice('Payment received. Sign in with the purchasing agent account to retrieve your PIN.'); return; }
  const { data: { user } } = await supabase.auth.getUser();
  const email = String(user?.email || '').trim().toLowerCase();
  if (!email) { notice('Sign in with the purchasing agent account to retrieve your PIN.', true); return; }
  const { data, error } = await supabase.functions.invoke('get-result-checker-order', { body: { reference, email } });
  if (error || data?.error) { notice(data?.error || 'Unable to retrieve your order.', true); return; }
  if (data.order.status !== 'paid') { notice('Your payment is being confirmed. Refresh in a few seconds; do not pay again.'); return; }
  $('pins').textContent = `Payment confirmed. Save these PIN details:\n${data.order.pins.map((pin) => `PIN: ${pin.pin}${pin.serial ? ` | SERIAL: ${pin.serial}` : ''}`).join('\n')}`;
  $('pins').hidden = false;
  notice(`Order ${reference} is complete.`);
  await loadResultHistory();
}

$('resultsCheckerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const originalButtonText = button.innerHTML;
  button.disabled = true;
  try {
    notice('Checking agent wallet balance…');

    const { isAgent } = await checkAgentAccessServer();
    if (!isAgent) {
      notice('Results checker purchases are available only to verified Skaitech Agents. Please sign in as an agent.', true);
      return;
    }

    const phone = $('phoneNumber').value.trim();
    if (!/^0\d{9}$/.test(phone)) {
      notice('Enter a valid 10-digit Ghana phone number starting with 0.', true);
      $('phoneNumber').focus();
      return;
    }

    const totalAmount = PRICES[$('examType').value] * Number($('quantity').value);
    const currentBalance = await refreshWalletBalance();
    if (Number.isFinite(Number(currentBalance)) && Number(currentBalance) < totalAmount) {
      notice(`Insufficient wallet balance. Available GHS ${Number(currentBalance).toFixed(2)}; required GHS ${totalAmount.toFixed(2)}.`, true);
      return;
    }

    notice('Charging your agent wallet and confirming PIN stock…');
    const { data, error } = await supabase.functions.invoke('create-result-checker-payment', {
      body: { examType: $('examType').value, quantity: Number($('quantity').value), phone },
    });

    if (error || data?.error) {
      const functionError = error ? await readFunctionError(error) : { body: null, message: '' };
      notice(data?.error || functionError.message || 'Unable to process your purchase.', true);
      return;
    }

    sessionStorage.setItem('skaitech_result_payment', JSON.stringify({ reference: data.reference }));
    if (Number.isFinite(Number(data.walletBalance))) applyWalletBalance(data.walletBalance);

    $('pins').textContent = `Payment confirmed from your agent wallet. Save these PIN details:\n${data.pins.map((pin) => `PIN: ${pin.pin}${pin.serial ? ` | SERIAL: ${pin.serial}` : ''}`).join('\n')}`;
    $('pins').hidden = false;
    notice(data.message || `Order ${data.reference} is complete. Wallet balance updated.`);
    await loadResultHistory();
  } catch (error) {
    console.error('Results checker purchase failed:', error);
    notice(error.message || 'Unable to complete this purchase. Please try again.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalButtonText;
  }
});

async function initializeResultsChecker() {
  await Promise.all([refreshWalletBalance(), loadCheckerPrices(), loadResultHistory()]);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeResultsChecker);
} else {
  initializeResultsChecker();
}

$('examType').addEventListener('change', updatePrice);
$('quantity').addEventListener('input', updatePrice);
updatePrice();
const reference = new URLSearchParams(window.location.search).get('reference');
if (reference) showCompletedOrder(reference);
