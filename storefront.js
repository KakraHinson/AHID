import { supabase } from './supabaseClient.js';

const FN = supabase.functions;

const NETWORK_LABELS = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

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
const returningReference = params.get('reference');

function showResult(message, kind = 'ok') {
  if (!els.result) return;
  els.result.className = `card result ${kind}`;
  els.result.style.display = 'block';
  els.result.innerHTML = message;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function hideResult() {
  if (els.result) els.result.style.display = 'none';
}

function money(value) {
  return `GHS ${Number(value).toFixed(2)}`;
}

function showError(message, kind = 'err') {
  if (els.loading) els.loading.style.display = 'none';
  if (els.app) els.app.style.display = 'none';
  showResult(message, kind);
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

    // If customer returned from redirect checkout with a reference
    if (returningReference) {
      showResult('<i class="fa-solid fa-spinner fa-spin"></i> Confirming your payment with Paystack...', 'ok');
      verifyOrder(returningReference);
    }
  } catch (err) {
    showError(err.message || 'Unable to load this store right now. Please try again.');
  }
}

function renderStore() {
  if (els.loading) els.loading.style.display = 'none';
  if (els.app) els.app.style.display = 'block';

  const store = storeData.store || {};
  const ownerName = storeData.ownerName || 'Skaitech Agent';
  if (els.storeWelcome) els.storeWelcome.textContent = `Welcome to ${ownerName}'s Store`;
  if (els.storeName) els.storeName.textContent = store.displayName || 'Skaitech Store';
  if (els.storeOwner) els.storeOwner.textContent = storeData.ownerName ? `Your agent: ${storeData.ownerName}` : 'Skaitech GH Agent';
  if (els.storeTagline) els.storeTagline.textContent = store.tagline || '';
  if (els.storeDescription) els.storeDescription.textContent = store.description || 'Choose your bundle and pay securely with Paystack (MoMo / Card). Bundles are delivered instantly.';
  
  if (store.contactPhone && els.storePhone) {
    els.storePhone.href = `tel:${String(store.contactPhone).replace(/[^+0-9]/g, '')}`;
    els.storePhone.textContent = `Call ${store.contactPhone}`;
    els.storePhone.style.display = 'inline-block';
  }
  if (store.logoUrl && els.storeLogo) els.storeLogo.src = store.logoUrl;
  if (store.whatsapp && els.whatsapp) {
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

  if (els.tabs) {
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
  }

  renderBundles(networks.find((g) => g.network === activeNetwork)?.bundles || []);
}

function renderBundles(bundles) {
  if (!els.grid) return;
  els.grid.innerHTML = bundles.map((bundle, index) => `
    <div class="bundle">
      <span class="net">${NETWORK_LABELS[bundle.network] || bundle.network}</span>
      <span class="size">${bundle.title.replace(/^[A-Za-z ]+/, '').trim() || bundle.volumeMb / 1024 + 'GB'}</span>
      <span class="price">${money(bundle.price)}</span>
      <span class="valid">${bundle.validity || 'Instant Delivery'}</span>
      <button type="button" data-index="${index}">Buy Now</button>
      <div class="form" id="form-${index}">
        <input type="text" id="name-${index}" placeholder="Your full name *" autocomplete="name">
        <input type="tel" id="phone-${index}" placeholder="Recipient number e.g. 0240000000 *" autocomplete="tel" inputmode="tel">
        <input type="email" id="email-${index}" placeholder="Email (optional, for receipt)" autocomplete="email">
        <div class="row">
          <button type="button" class="confirm" data-confirm="${index}">Pay with Paystack</button>
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
  const phone = (document.getElementById(`phone-${index}`)?.value || '').trim();
  const email = (document.getElementById(`email-${index}`)?.value || '').trim().toLowerCase();
  const button = els.grid.querySelector(`[data-confirm="${index}"]`);

  if (!name || !phone) {
    showResult('<strong>Missing details.</strong> Please fill in your name and recipient phone number.', 'err');
    return;
  }
  if (!/^0\d{9}$/.test(phone)) {
    showResult('<strong>Invalid number.</strong> Enter a valid 10-digit number starting with 0.', 'err');
    return;
  }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    showResult('<strong>Check email.</strong> Please enter a valid email address or leave it blank.', 'err');
    return;
  }

  const idempotencyKey = (window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  if (button) {
    button.disabled = true;
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening Paystack…';
  }

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

    if (error || data?.error) {
      let body = null;
      try { body = await error?.context?.json(); } catch (_) { /* ignore */ }
      const message = body?.error || data?.error || 'Unable to start checkout right now.';
      showResult(`<strong>Checkout error.</strong> ${message}`, 'err');
      if (button) { button.disabled = false; button.textContent = 'Pay with Paystack'; }
      return;
    }

    const { orderReference, authorizationUrl, saleAmount, customerEmail, paystackPublicKey } = data;

    // Use Paystack Popup if PaystackPop is available
    if (typeof window.PaystackPop !== 'undefined' && paystackPublicKey) {
      try {
        const handler = window.PaystackPop.setup({
          key: paystackPublicKey,
          email: customerEmail,
          amount: Math.round(Number(saleAmount) * 100),
          currency: 'GHS',
          ref: orderReference,
          onClose: function () {
            if (button) { button.disabled = false; button.textContent = 'Pay with Paystack'; }
            showResult('<strong>Payment cancelled.</strong> You can try again when you are ready.', 'err');
          },
          callback: function (response) {
            if (button) { button.disabled = false; button.textContent = 'Pay with Paystack'; }
            showResult('<i class="fa-solid fa-spinner fa-spin"></i> <strong>Payment successful!</strong> Delivering your data bundle...', 'ok');
            verifyOrder(orderReference);
          },
        });
        handler.openIframe();
        return;
      } catch (inlineErr) {
        console.warn('PaystackPop inline error, falling back to redirect:', inlineErr);
      }
    }

    // Direct redirect fallback
    if (authorizationUrl) {
      window.location.href = authorizationUrl;
      return;
    }

    showResult('Could not open payment checkout. Please try again.', 'err');
    if (button) { button.disabled = false; button.textContent = 'Pay with Paystack'; }
  } catch (err) {
    showResult(`<strong>Order error.</strong> ${err.message || 'Please try again.'}`, 'err');
    if (button) { button.disabled = false; button.textContent = 'Pay with Paystack'; }
  }
}

async function verifyOrder(reference) {
  try {
    const { data, error } = await FN.invoke('create-store-order', {
      body: { action: 'verify', reference },
    });

    if (error || data?.error) {
      const msg = data?.message || data?.error || 'Unable to confirm order delivery.';
      showResult(`<strong>Notice:</strong> ${msg}<br>Reference: <code>${reference}</code>`, 'err');
      return;
    }

    showResult(
      `<strong><i class="fa-solid fa-circle-check" style="color: #10b981;"></i> Order Successful!</strong><br>` +
      `Reference: <code>${reference}</code><br>` +
      `${data.message || 'Your data bundle order was accepted and is being delivered.'}`,
      'ok',
    );
  } catch (err) {
    showResult(`Payment recorded. Your bundle will be delivered shortly. Reference: <code>${reference}</code>`, 'ok');
  }
}

loadStore();
