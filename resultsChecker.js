import { readFunctionError, supabase } from './supabaseClient.js?v=2026110506';
import { checkAgentAccessServer } from './agentAccessCheck.js';
import { applyWalletBalance, refreshWalletBalance } from './walletBalance.js';

const PRICES = { BECE: 19, WASSCE: 22 };
const $ = (id) => document.getElementById(id);
function notice(message, isError = false) { const el = $('notice'); el.textContent = message; el.className = `notice show${isError ? ' error' : ''}`; }
function updatePrice() { const price = PRICES[$('examType').value]; const quantity = Math.max(1, Number.parseInt($('quantity').value, 10) || 1); $('quantity').value = quantity; $('pricePerPin').textContent = price.toFixed(2); $('totalPrice').textContent = (price * quantity).toFixed(2); }

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

window.selectResultsExam = selectResultsExam;
window.closeResultsPurchase = closeResultsPurchase;

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
  } catch (error) {
    console.error('Results checker purchase failed:', error);
    notice(error.message || 'Unable to complete this purchase. Please try again.', true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalButtonText;
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => refreshWalletBalance());
} else {
  refreshWalletBalance();
}

$('examType').addEventListener('change', updatePrice);
$('quantity').addEventListener('input', updatePrice);
updatePrice();
const reference = new URLSearchParams(window.location.search).get('reference');
if (reference) showCompletedOrder(reference);
