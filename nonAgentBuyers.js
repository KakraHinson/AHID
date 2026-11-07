import { supabase, readFunctionError } from './supabaseClient.js';

const NETWORKS = ['mtn', 'telecel', 'airteltigo'];
const NETWORK_LABELS = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };
const params = new URLSearchParams(window.location.search);
let network = NETWORKS.includes(params.get('network')) ? params.get('network') : 'mtn';
let bundles = [];
let selectedBundle = null;

const $ = (id) => document.getElementById(id);
const money = (value) => `GHS ${Number(value || 0).toFixed(2)}`;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const volume = (mb) => Number(mb) >= 1024 ? `${Number(mb) / 1024 % 1 ? (Number(mb) / 1024).toFixed(1) : Number(mb) / 1024}GB` : `${mb}MB`;

function showMessage(text, type = 'info') {
  const element = $('message');
  if (!element) return;
  element.textContent = text;
  element.className = `message show ${type}`;
}

function renderTabs() {
  $('networkTabs').innerHTML = NETWORKS.map((key) => `<button class="network-tab ${key === network ? 'active' : ''}" data-network="${key}" type="button">${NETWORK_LABELS[key]}</button>`).join('');
  $('networkTabs').querySelectorAll('[data-network]').forEach((button) => button.addEventListener('click', () => {
    network = button.dataset.network;
    const url = new URL(window.location.href);
    url.searchParams.set('network', network);
    window.history.replaceState({}, '', url);
    renderTabs();
    renderBundles();
  }));
}

function renderBundles() {
  const visible = bundles.filter((bundle) => String(bundle.network).toLowerCase() === network);
  const catalog = $('catalog');
  if (!visible.length) {
    catalog.innerHTML = '<div class="message show info">No bundles are currently available on this network.</div>';
    return;
  }
  catalog.innerHTML = visible.map((bundle) => `
    <article class="bundle">
      <h2>${escapeHtml(volume(bundle.volumeMb))}</h2>
      <small>${escapeHtml(bundle.title || `${NETWORK_LABELS[network]} data bundle`)}${bundle.validity ? ` · ${escapeHtml(bundle.validity)}` : ''}</small>
      <div class="price">${money(bundle.price)}</div>
      <button class="buy" type="button" data-bundle-id="${escapeHtml(bundle.bundleId)}">Buy this bundle</button>
    </article>`).join('');
  catalog.querySelectorAll('[data-bundle-id]').forEach((button) => button.addEventListener('click', () => openCheckout(button.dataset.bundleId)));
}

function openCheckout(bundleId) {
  selectedBundle = bundles.find((bundle) => bundle.bundleId === bundleId) || null;
  if (!selectedBundle) return;
  $('selectedBundle').textContent = `${NETWORK_LABELS[selectedBundle.network]} · ${volume(selectedBundle.volumeMb)} · ${money(selectedBundle.price)}`;
  $('checkout').classList.add('open');
  $('customerPhone').focus();
  $('checkout').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function closeCheckout() {
  selectedBundle = null;
  $('checkout').classList.remove('open');
  $('customerPhone').value = '';
}

async function loadCatalog() {
  try {
    const { data, error } = await supabase.functions.invoke('public-data-catalog', { body: {} });
    if (error) {
      const details = await readFunctionError(error);
      throw new Error(details.message || 'Unable to load the live data catalogue.');
    }
    bundles = Array.isArray(data?.bundles) ? data.bundles : [];
    renderTabs();
    renderBundles();
    if (!bundles.length) showMessage('No data bundles are available right now.', 'info');
  } catch (error) {
    console.error(error);
    $('catalog').innerHTML = '';
    showMessage(error.message || 'Unable to load data bundles. Please refresh and try again.', 'error');
  }
}

async function startCheckout() {
  if (!selectedBundle) return showMessage('Choose a data bundle first.', 'error');
  const phone = $('customerPhone').value.trim();
  if (!/^0\d{9}$/.test(phone)) return showMessage('Enter a valid 10-digit Ghana customer number.', 'error');

  const button = $('payButton');
  button.disabled = true;
  button.textContent = 'Starting secure checkout…';
  showMessage('Preparing your secure payment…', 'info');
  try {
    const { data, error } = await supabase.functions.invoke('create-public-data-checkout', {
      body: { bundleId: selectedBundle.bundleId, phone },
    });
    if (error) {
      const details = await readFunctionError(error);
      throw new Error(details.message || 'Unable to start checkout.');
    }
    if (!data?.authorizationUrl || !data.reference || !data.accessToken) throw new Error(data?.error || 'Paystack did not return a checkout link.');
    sessionStorage.setItem('skaitech_guest_data_payment', JSON.stringify({
      reference: data.reference,
      accessToken: data.accessToken,
      phone,
      bundleId: selectedBundle.bundleId,
    }));
    window.location.assign(data.authorizationUrl);
  } catch (error) {
    console.error(error);
    showMessage(error.message || 'Unable to start checkout. Please try again.', 'error');
    button.disabled = false;
    button.textContent = 'Continue to payment';
  }
}

async function getOrderStatus(payment) {
  const { data, error } = await supabase.functions.invoke('get-public-data-order', {
    body: { reference: payment.reference, accessToken: payment.accessToken, phone: payment.phone },
  });
  if (error) {
    const details = await readFunctionError(error);
    throw new Error(details.message || 'Unable to read order status.');
  }
  return data?.order || null;
}

async function verifyPayment(payment) {
  const { data, error } = await supabase.functions.invoke('verify-public-data-payment', { body: { reference: payment.reference } });
  if (error) {
    const details = await readFunctionError(error);
    throw new Error(details.message || 'Payment verification is still processing.');
  }
  return data || {};
}

async function showPaymentResult() {
  const reference = params.get('reference');
  if (!reference) return;
  const payment = JSON.parse(sessionStorage.getItem('skaitech_guest_data_payment') || '{}');
  if (payment.reference !== reference) {
    showMessage('Payment reference found, but this browser has no matching checkout session. Use Track Order with your order code.', 'error');
    return;
  }
  $('statusCard').classList.add('show');
  $('statusText').textContent = 'Confirming payment and sending your bundle…';
  $('statusReference').textContent = `Payment reference: ${reference}`;
  try { await verifyPayment(payment); } catch (error) { console.warn(error.message); }

  let attempts = 0;
  const poll = async () => {
    attempts += 1;
    try {
      const order = await getOrderStatus(payment);
      const state = String(order?.status || 'pending_payment').toLowerCase();
      if (state === 'successful') {
        $('statusText').textContent = `Bundle delivered to ${payment.phone}. You can keep this reference for support.`;
        $('statusText').style.color = '#065f46';
        return;
      }
      if (state === 'failed' || state === 'cancelled') {
        $('statusText').textContent = 'This bundle could not be delivered. Your Paystack payment has been sent for refund.';
        $('statusText').style.color = '#991b1b';
        return;
      }
      $('statusText').textContent = state === 'pending_payment' ? 'Payment is still being confirmed…' : 'Payment confirmed. Your bundle is being delivered…';
      if (attempts < 12) window.setTimeout(poll, 5000);
    } catch (error) {
      if (attempts < 12) window.setTimeout(poll, 5000);
      else $('statusText').textContent = error.message || 'Unable to read order status. Please use Track Order.';
    }
  };
  poll();
}

$('payButton').addEventListener('click', startCheckout);
$('cancelButton').addEventListener('click', closeCheckout);
loadCatalog();
showPaymentResult();
