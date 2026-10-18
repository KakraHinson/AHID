import { supabase } from './supabaseClient.js';

const FN = supabase.functions;

const NETWORK_LABELS = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };
const NETWORK_KEYS = ['mtn', 'telecel', 'airteltigo'];

const els = {
  loading: document.getElementById('loading'),
  app: document.getElementById('app'),
  result: document.getElementById('result'),
  storeLogo: document.getElementById('storeLogo'),
  storeWelcome: document.getElementById('storeWelcome'),
  storeName: document.getElementById('storeName'),
  storeOwner: document.getElementById('storeOwner'),
  storeTagline: document.getElementById('storeTagline'),
  storePhone: document.getElementById('storePhone'),
  storeDescription: document.getElementById('storeDescription'),
  whatsapp: document.getElementById('storeWhatsapp'),
  tabs: document.getElementById('networkTabs'),
  grid: document.getElementById('bundleGrid'),
};

let storeData = null;
let activeNetwork = 'mtn';

const params = new URLSearchParams(window.location.search);
const pathMatch = window.location.pathname.match(/^\/store\/([a-z0-9-]+)\/?$/i);
const slug = (pathMatch?.[1] || params.get('ref') || params.get('slug') || params.get('agent') || params.get('code') || '').trim().toLowerCase();

function showResult(message, kind = 'ok') {
  els.result.className = `card result ${kind}`;
  els.result.style.display = 'block';
  els.result.innerHTML = message;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideResult() {
  els.result.style.display = 'none';
}

function money(value) {
  return `GHS ${Number(value).toFixed(2)}`;
}

function showError(message, kind = 'err') {
  els.loading.style.display = 'none';
  els.app.style.display = 'none';
  showResult(message, kind);
}

// Reads our edge-function error envelope out of a failed fetch response.
async function readError(response, fallback) {
  try {
    const body = await response.json();
    if (body && body.error) return body;
  } catch (_) { /* not JSON */ }
  return { error: fallback };
}

async function loadStore() {
  try {
    const { data, error } = await FN.invoke('get-store', { body: { slug: slug || '' } });
    if (error) {
      let body = null;
      try { body = await error.context?.json(); } catch (_) { /* ignore */ }
      throw new Error(body?.error || 'This store could not be found.');
    }
    if (data?.error) throw new Error(data.error);
    storeData = data;
    renderStore();
  } catch (err) {
    showError(err.message || 'Unable to load this store right now. Please try again.');
  }
}

function renderStore() {
  els.loading.style.display = 'none';
  els.app.style.display = 'block';

  const store = storeData.store || {};
  const ownerName = storeData.ownerName || 'Skaitech Agent';
  els.storeWelcome.textContent = `Welcome to ${ownerName}'s Store`;
  els.storeName.textContent = store.displayName || 'Skaitech Store';
  els.storeOwner.textContent = storeData.ownerName ? `Your agent: ${storeData.ownerName}` : 'Skaitech GH Agent';
  els.storeTagline.textContent = store.tagline || '';
  els.storeDescription.textContent = store.description || 'Choose a bundle and enter the recipient\'s details. Your order will be delivered automatically.';
  if (store.contactPhone) {
    els.storePhone.href = `tel:${String(store.contactPhone).replace(/[^+0-9]/g, '')}`;
    els.storePhone.textContent = `Call ${store.contactPhone}`;
    els.storePhone.style.display = 'inline-block';
  }
  if (store.logoUrl) els.storeLogo.src = store.logoUrl;
  if (store.whatsapp) {
    const digits = String(store.whatsapp).replace(/[^0-9]/g, '');
    els.whatsapp.href = `https://wa.me/${digits}`;
    els.whatsapp.style.display = 'inline-block';
  }

  const networks = (storeData.networks || []).filter((g) => g.bundles && g.bundles.length > 0);
  if (networks.length === 0) {
    showError('This store has no packages available right now.');
    return;
  }
  if (!networks.some((g) => g.network === activeNetwork)) {
    activeNetwork = networks[0].network;
  }

  els.tabs.innerHTML = networks.map((group) => {
    const active = group.network === activeNetwork;
    return `<button type="button" class="${active ? 'active' : ''}" data-network="${group.network}">${NETWORK_LABELS[group.network] || group.network}</button>`;
  }).join('');
  els.tabs.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      activeNetwork = button.dataset.network;
      hideResult();
      renderStore();
    });
  });

  renderBundles(networks.find((g) => g.network === activeNetwork)?.bundles || []);
}

function renderBundles(bundles) {
  els.grid.innerHTML = bundles.map((bundle, index) => `
    <div class="bundle">
      <span class="net">${NETWORK_LABELS[bundle.network] || bundle.network}</span>
      <span class="size">${bundle.title.replace(/^[A-Za-z ]+/, '').trim() || bundle.volumeMb / 1024 + 'GB'}</span>
      <span class="price">${money(bundle.price)}</span>
      <span class="valid">${bundle.validity || 'One-time payment'}</span>
      <button type="button" data-index="${index}">Buy Now</button>
      <div class="form" id="form-${index}">
        <input type="text" id="name-${index}" placeholder="Your full name" autocomplete="name">
        <input type="email" id="email-${index}" placeholder="Your email" autocomplete="email">
        <input type="tel" id="phone-${index}" placeholder="Recipient number e.g. 0240000000" autocomplete="tel" inputmode="tel">
        <div class="row">
          <button type="button" class="confirm" data-confirm="${index}">Confirm Order</button>
          <button type="button" class="cancel" data-cancel="${index}">Cancel</button>
        </div>
      </div>
    </div>
  `).join('');

  els.grid.querySelectorAll('[data-index]').forEach((button) => {
    button.addEventListener('click', () => toggleForm(Number(button.dataset.index)));
  });
  els.grid.querySelectorAll('[data-cancel]').forEach((button) => {
    button.addEventListener('click', () => toggleForm(Number(button.dataset.cancel)));
  });
  els.grid.querySelectorAll('[data-confirm]').forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.confirm);
      submitOrder(bundles[index], index);
    });
  });
}

function toggleForm(index) {
  const form = document.getElementById(`form-${index}`);
  if (form) form.style.display = form.style.display === 'flex' ? 'none' : 'flex';
}

async function submitOrder(bundle, index) {
  const name = (document.getElementById(`name-${index}`)?.value || '').trim();
  const email = (document.getElementById(`email-${index}`)?.value || '').trim().toLowerCase();
  const phone = (document.getElementById(`phone-${index}`)?.value || '').trim();
  const button = els.grid.querySelector(`[data-confirm="${index}"]`);

  if (!name || !phone) {
    showResult('<strong>Missing details.</strong> Please fill in your name and the recipient number.', 'err');
    return;
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    showResult('<strong>Check the email.</strong> That email address looks invalid.', 'err');
    return;
  }
  if (!/^0\d{9}$/.test(phone)) {
    showResult('<strong>Check the number.</strong> Enter a valid 10-digit number starting with 0.', 'err');
    return;
  }

  const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  if (button) { button.disabled = true; button.textContent = 'Placing order…'; }

  try {
    const { data, error } = await FN.invoke('create-store-order', {
      body: {
        slug,
        bundleId: bundle.bundleId,
        recipient: phone,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        idempotencyKey,
      },
    });

    if (error) {
      let body = null;
      try { body = await error.context?.json(); } catch (_) { /* ignore */ }
      const message = body?.error || 'Unable to place the order right now.';
      const code = body?.code || '';
      if (code === 'store_wallet_low') {
        showResult(`<strong>Temporarily unavailable.</strong> ${message}`, 'err');
      } else {
        showResult(`<strong>Order not placed.</strong> ${message}`, 'err');
      }
      return;
    }
    if (data?.error) {
      showResult(`<strong>Order not placed.</strong> ${data.error}`, 'err');
      return;
    }

    const reference = data.reference || data.orderReference || '';
    const status = String(data.status || 'processing').toLowerCase();
    if (status === 'failed' || status === 'cancelled') {
      showResult(`<strong>Could not deliver.</strong> ${data.message || 'The bundle could not be delivered, and the order was not charged.'}`, 'err');
    } else {
      showResult(
        `<strong>Order placed.</strong> Reference <code>${reference}</code>.<br>` +
        `${money(bundle.price)} — ${bundle.title} for ${phone}.<br>` +
        `The bundle is being delivered now. Keep your reference for tracking.`,
        'ok',
      );
      els.grid.innerHTML = '';
    }
  } catch (err) {
    showResult(`<strong>Order not placed.</strong> ${err.message || 'Please try again.'}`, 'err');
  } finally {
    if (button) { button.disabled = false; button.textContent = 'Buy Now'; }
  }
}

loadStore();
