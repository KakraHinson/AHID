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
const pathMatch = window.location.pathname.match(/^\/store\/([a-z0-9-_]+)\/?$/i);
const agentParam = (params.get('agent') || params.get('slug') || params.get('ref') || params.get('code') || pathMatch?.[1] || '').trim();
const returningReference = params.get('reference');
const initialNetwork = (params.get('network') || '').toLowerCase();
if (['mtn', 'telecel', 'airteltigo'].includes(initialNetwork)) {
  activeNetwork = initialNetwork;
}

const PAYSTACK_FEE_RATE = 0.0195; // 1.95% Paystack processing fee

function computePaystackFee(packagePrice) {
  const price = Number(packagePrice) || 0;
  const gross = Math.round(((price / (1 - PAYSTACK_FEE_RATE)) + Number.EPSILON) * 100) / 100;
  const fee = Math.round((gross - price) * 100) / 100;
  return {
    packagePrice: price,
    feeAmount: fee,
    grossAmount: gross,
  };
}

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
    const { data, error } = await FN.invoke('get-store', { body: { slug: agentParam || '' } });
    if (!error && data && !data.error) {
      storeData = data;
      renderStore();

      // If customer returned from redirect checkout with a reference
      if (returningReference) {
        showResult('<i class="fa-solid fa-spinner fa-spin"></i> Confirming your payment with Paystack...', 'ok');
        verifyOrder(returningReference);
      }
      return;
    }
    if (error && error.message && !error.message.includes('fetch')) {
      let body = null;
      try { body = await error.context?.json(); } catch (_) { /* ignore */ }
      if (body?.error) {
        throw new Error(body.error);
      }
    }
  } catch (fnErr) {
    console.warn('get-store edge function notice:', fnErr);
  }

  // Resilient fallback: direct database query
  try {
    let store = null;
    let agent = null;

    if (agentParam) {
      const slugRaw = agentParam.toLowerCase();
      const dashed = slugRaw.replace(/[_ ]+/g, '-');
      const spaced = slugRaw.replace(/[-_]+/g, ' ');

      // 1. By slug
      const { data: storeBySlug } = await supabase
        .from('agent_stores')
        .select('*')
        .or(`slug.ilike.${slugRaw},slug.ilike.${dashed}`)
        .maybeSingle();
      if (storeBySlug) store = storeBySlug;

      // 2. By agent code
      if (!store) {
        const { data: agentByCode } = await supabase
          .from('agents')
          .select('id, full_name, agent_code')
          .ilike('agent_code', agentParam)
          .maybeSingle();
        if (agentByCode) {
          agent = agentByCode;
          const { data: storeByAgent } = await supabase
            .from('agent_stores')
            .select('*')
            .eq('agent_id', agentByCode.id)
            .maybeSingle();
          if (storeByAgent) store = storeByAgent;
        }
      }

      // 3. By agent full_name
      if (!store && !agent) {
        const { data: agentByName } = await supabase
          .from('agents')
          .select('id, full_name')
          .ilike('full_name', spaced)
          .maybeSingle();
        if (agentByName) {
          agent = agentByName;
          const { data: storeByName } = await supabase
            .from('agent_stores')
            .select('*')
            .eq('agent_id', agentByName.id)
            .maybeSingle();
          if (storeByName) store = storeByName;
        }
      }
    }

    // Fallback store if no agent was specified
    if (!store && !agentParam) {
      const { data: fallbackStore } = await supabase
        .from('agent_stores')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackStore) store = fallbackStore;
    }

    if (!store && !agentParam) {
      throw new Error('This store is currently not available.');
    }

    if (!store && agentParam) {
      throw new Error(`Store not found for agent '${agentParam}'. Please check the store link.`);
    }

    const ownerId = store.agent_id;
    if (!agent) {
      const { data: ownerAgent } = await supabase.from('agents').select('full_name, agent_code').eq('id', ownerId).maybeSingle();
      agent = ownerAgent;
    }

    // Fetch catalog, store_products, and agent custom pricing from both agent_prices and agent_pricing
    const agentIdentifiers = [ownerId];
    if (store.slug) agentIdentifiers.push(store.slug);
    if (agent?.agent_code) agentIdentifiers.push(agent.agent_code);
    if (agentParam && !agentIdentifiers.includes(agentParam)) agentIdentifiers.push(agentParam);

    const [catalogRes, pricingRes, agentPricesRes, productsRes] = await Promise.all([
      supabase.from('bundle_catalog').select('*').eq('active', true).order('sort_order', { ascending: true }),
      supabase.from('agent_pricing').select('pricing_key, price').eq('agent_id', ownerId),
      supabase.from('agent_prices').select('agent_id, network, package_id, custom_price').in('agent_id', agentIdentifiers),
      supabase.from('store_products').select('product_ref, price, is_enabled').eq('store_id', store.id).eq('product_type', 'data_bundle')
    ]);

    const customPrices = new Map();
    (pricingRes.data || []).forEach(r => {
      const val = Number(r.price);
      if (val > 0) customPrices.set(String(r.pricing_key).toLowerCase(), val);
    });

    (agentPricesRes.data || []).forEach(r => {
      const val = Number(r.custom_price);
      if (val > 0) {
        const net = String(r.network).toLowerCase();
        const pkg = String(r.package_id).toLowerCase();
        customPrices.set(`price_${net}_${pkg}`, val);
        customPrices.set(`${net}_${pkg}`, val);
        customPrices.set(`${net}-${pkg}`, val);
        customPrices.set(pkg, val);
      }
    });

    const overrides = new Map();
    (productsRes.data || []).forEach(r => {
      overrides.set(String(r.product_ref).toLowerCase(), {
        price: Number(r.price),
        enabled: r.is_enabled !== false
      });
    });

    const bundles = (catalogRes.data || []).map(b => {
      const network = String(b.network).toLowerCase();
      const volumeInMB = Number(b.volume_mb);
      const catalogPrice = Number(b.price);
      const bId = String(b.bundle_id).toLowerCase();
      const gb = volumeInMB / 1024;
      const keyGb = Number.isInteger(gb) && gb > 0 ? `price_${network}_${gb}gb` : '';
      const keyMb = `price_${network}_${volumeInMB}mb`;
      const keyId = `price_${bId.replace(/[- ]+/g, '_')}`;

      const override = overrides.get(bId) || overrides.get(bId.replace(/_/g, '-'));
      if (override && !override.enabled) return null;

      const custom = (keyGb && customPrices.get(keyGb)) ||
                     customPrices.get(keyMb) ||
                     customPrices.get(keyId) ||
                     customPrices.get(bId);

      const finalPrice = (custom !== undefined && custom > 0)
        ? custom
        : (override?.price && override.price > 0 ? override.price : catalogPrice);

      return {
        bundleId: String(b.bundle_id),
        network,
        title: String(b.title),
        validity: b.validity ? String(b.validity) : null,
        volumeMb: volumeInMB,
        basePrice: catalogPrice,
        price: Math.round(finalPrice * 100) / 100,
        isCustomPrice: (custom !== undefined && custom > 0) || (override?.price !== undefined && override.price > 0)
      };
    }).filter(Boolean);

    const networks = ['mtn', 'telecel', 'airteltigo'].map(net => ({
      network: net,
      bundles: bundles.filter(b => b.network === net)
    })).filter(g => g.bundles.length > 0);

    storeData = {
      store: {
        slug: store.slug,
        displayName: store.display_name,
        description: store.description || '',
        logoUrl: store.logo_url || null,
        brandColor: store.brand_color || '#2563eb',
        tagline: store.tagline || '',
        whatsapp: store.whatsapp || null,
        contactPhone: store.contact_phone || null,
        agentId: ownerId
      },
      ownerName: agent?.full_name ? String(agent.full_name).trim() : 'Skaitech Agent',
      hasAgentParam: !!agentParam,
      networks
    };

    renderStore();

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
  const hasAgent = Boolean(storeData.hasAgentParam && storeData.ownerName && storeData.ownerName !== 'Skaitech Agent');

  // Set main header greeting to "Welcome to Skaitech GH Store" and display the agent name
  if (els.storeWelcome) {
    els.storeWelcome.textContent = 'Welcome to Skaitech GH Store';
  }

  if (els.storeOwner) {
    if (hasAgent) {
      els.storeOwner.innerHTML = `<i class="fa-solid fa-circle-check" style="color: #10b981;"></i> Agent: <strong>${storeData.ownerName.trim().toUpperCase()}</strong>`;
      els.storeOwner.style.display = 'inline-flex';
    } else {
      els.storeOwner.innerHTML = `<i class="fa-solid fa-shield-halved" style="color: #60a5fa;"></i> Skaitech GH Official Store`;
      els.storeOwner.style.display = 'inline-flex';
    }
  }

  document.title = hasAgent
    ? `Welcome to Skaitech GH Store | ${storeData.ownerName.trim()}`
    : 'Welcome to Skaitech GH Store';

  if (els.storeName) {
    if (store.displayName && store.displayName !== storeData.ownerName && store.displayName !== 'Skaitech Store') {
      els.storeName.textContent = store.displayName;
      els.storeName.style.display = 'block';
    } else {
      els.storeName.style.display = 'none';
    }
  }

  if (els.storeTagline) els.storeTagline.textContent = store.tagline || '';
  if (els.storeDescription) els.storeDescription.textContent = store.description || 'Choose your data package below and pay securely via Paystack (MoMo / Card). Bundles are delivered instantly.';

  if (store.contactPhone && els.storePhone) {
    els.storePhone.href = `tel:${String(store.contactPhone).replace(/[^+0-9]/g, '')}`;
    els.storePhone.textContent = `Call ${store.contactPhone}`;
    els.storePhone.style.display = 'inline-block';
  }
  if (store.logoUrl && els.storeLogo) els.storeLogo.src = store.logoUrl;
  if (store.whatsapp && els.whatsapp) {
    const digits = String(store.whatsapp).replace(/[^0-9]/g, '');
    const chatText = hasAgent
      ? `Hello ${storeData.ownerName}, I would like to purchase a data bundle from your Skaitech GH store.`
      : 'Hello Skaitech GH, I would like to purchase a data bundle.';
    els.whatsapp.href = `https://wa.me/${digits}?text=${encodeURIComponent(chatText)}`;
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
        try {
          const currentUrl = new URL(window.location.href);
          if (agentParam) currentUrl.searchParams.set('agent', agentParam);
          currentUrl.searchParams.set('network', activeNetwork);
          window.history.replaceState({}, '', currentUrl.toString());
        } catch (_) { /* ignore */ }
        renderStore();
      });
    });
  }

  renderBundles(networks.find((g) => g.network === activeNetwork)?.bundles || []);
}

function renderBundles(bundles) {
  if (!els.grid) return;
  els.grid.innerHTML = bundles.map((bundle, index) => {
    const price = Number(bundle.price);
    const { feeAmount, grossAmount } = computePaystackFee(price);

    return `
      <div class="bundle">
        <span class="net">${NETWORK_LABELS[bundle.network] || bundle.network}</span>
        <span class="size">${bundle.title.replace(/^[A-Za-z ]+/, '').trim() || (bundle.volumeMb / 1024) + 'GB'}</span>
        <span class="price">${money(price)}</span>
        <span class="valid">${bundle.validity || 'Instant Delivery'}</span>
        <button type="button" data-index="${index}">Buy Now</button>
        <div class="form" id="form-${index}">
          <input type="text" id="name-${index}" placeholder="Your full name *" autocomplete="name">
          <input type="tel" id="phone-${index}" placeholder="Recipient number e.g. 0240000000 *" autocomplete="tel" inputmode="tel">
          <input type="email" id="email-${index}" placeholder="Email (optional, for receipt)" autocomplete="email">
          
          <div class="fee-breakdown">
            <div class="fee-row">
              <span>Package Price:</span>
              <strong>${money(price)}</strong>
            </div>
            <div class="fee-row">
              <span>Paystack Fee (1.95%):</span>
              <span>+ ${money(feeAmount)}</span>
            </div>
            <div class="fee-row total">
              <span>Total Payable:</span>
              <strong>${money(grossAmount)}</strong>
            </div>
          </div>

          <div class="row">
            <button type="button" class="confirm" data-confirm="${index}">Pay ${money(grossAmount)} with Paystack</button>
            <button type="button" class="cancel" data-cancel="${index}">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

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

  const packagePrice = Number(bundle.price);
  const { feeAmount, grossAmount } = computePaystackFee(packagePrice);

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
        slug: agentParam,
        agent: agentParam,
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
      if (button) { button.disabled = false; button.textContent = `Pay ${money(grossAmount)} with Paystack`; }
      return;
    }

    const { orderReference, authorizationUrl, grossAmount: serverGross, saleAmount: serverSale, customerEmail: payerEmail, paystackPublicKey } = data;
    const finalGross = Number(serverGross || serverSale || grossAmount);

    // Use Paystack Popup if PaystackPop is available
    if (typeof window.PaystackPop !== 'undefined' && paystackPublicKey) {
      try {
        const handler = window.PaystackPop.setup({
          key: paystackPublicKey,
          email: payerEmail,
          amount: Math.round(finalGross * 100), // in pesewas
          currency: 'GHS',
          ref: orderReference,
          onClose: function () {
            if (button) { button.disabled = false; button.textContent = `Pay ${money(finalGross)} with Paystack`; }
            showResult('<strong>Payment cancelled.</strong> You can try again when you are ready.', 'err');
          },
          callback: function (response) {
            if (button) { button.disabled = false; button.textContent = `Pay ${money(finalGross)} with Paystack`; }
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
    if (button) { button.disabled = false; button.textContent = `Pay ${money(finalGross)} with Paystack`; }
  } catch (err) {
    showResult(`<strong>Order error.</strong> ${err.message || 'Please try again.'}`, 'err');
    if (button) { button.disabled = false; button.textContent = `Pay ${money(grossAmount)} with Paystack`; }
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
