import { supabase } from './supabaseClient.js';
import { refreshWalletBalance } from './walletBalance.js';
import {
  NETWORK_BRANDING,
  bundlesForNetwork,
  formatGhs,
  guessNetworkFromPhone,
  loadBundleCatalog,
} from './dataCatalog.js';

/**
 * The Instant Data purchase modal.
 *
 * Prices come from the live `bundles` catalog, never from this file, and the
 * server resolves the bundle and price again at checkout, so what is shown is
 * what gets charged.
 *
 * Validity is rendered only when the catalog provides it. Every row is currently
 * null because the provider does not expose a duration, and showing a
 * placeholder like "30 days" would be a claim we cannot back up.
 */

const TOP_UP_URL = 'agentWallet.html';

const state = {
  built: false,
  networks: [],
  network: 'mtn',
  bundleId: '',
  idempotencyKey: null,
  balance: 0,
  submitting: false,
  staleCatalog: false,
  salesEnabled: false,
};

const el = {};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function build() {
  if (state.built) return;

  const overlay = document.createElement('div');
  overlay.id = 'instantDataModal';
  overlay.className = 'idm-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = `
    <div class="idm-card" role="dialog" aria-modal="true" aria-labelledby="idmTitle">
      <header class="idm-header">
        <div class="idm-head-main">
          <div class="idm-brand-lockup">
            <img class="idm-network-logo" data-idm-network-logo src="img/mtn-logo.png" alt="MTN logo" />
            <div>
              <p class="idm-eyebrow">Instant Data</p>
              <h2 id="idmTitle" class="idm-title">Choose a bundle</h2>
              <p class="idm-pricing-header" data-idm-pricing-header>Live bundle pricing</p>
            </div>
          </div>
        </div>
        <button type="button" class="idm-close" data-idm-close aria-label="Close">&times;</button>
      </header>

      <div class="idm-tabs" role="tablist" aria-label="Network"></div>

      <div class="idm-phone">
        <label class="idm-label" for="idmPhone">Recipient phone number</label>
        <div class="idm-phone-field">
          <i class="fa-solid fa-address-book idm-phone-icon" aria-hidden="true"></i>
          <input id="idmPhone" type="tel" inputmode="numeric" autocomplete="tel-national"
                 placeholder="e.g. 0241234567" maxlength="10" aria-describedby="idmPhoneHint" />
        </div>
        <p class="idm-hint" id="idmPhoneHint">The number that receives the data.</p>
        <p class="idm-error" data-idm-error role="alert" hidden></p>
      </div>

      <div class="idm-bundles" role="radiogroup" aria-label="Bundles">
        <p class="idm-loading" data-idm-loading>Loading bundles&hellip;</p>
      </div>

      <footer class="idm-footer">
        <div class="idm-balance">
          <span class="idm-balance-label">Wallet balance</span>
          <strong class="idm-balance-value" data-idm-balance>GHS 0.00</strong>
        </div>
        <button type="button" class="idm-cta" data-idm-submit disabled>Select a bundle</button>
      </footer>
    </div>`;

  document.body.appendChild(overlay);
  overlay.classList.add('idm-theme-mtn');

  el.overlay = overlay;
  el.tabs = overlay.querySelector('.idm-tabs');
  el.bundleList = overlay.querySelector('.idm-bundles');
  el.phone = overlay.querySelector('#idmPhone');
  el.error = overlay.querySelector('[data-idm-error]');
  el.balance = overlay.querySelector('[data-idm-balance]');
  el.cta = overlay.querySelector('[data-idm-submit]');
  el.title = overlay.querySelector('#idmTitle');
  el.networkLogo = overlay.querySelector('[data-idm-network-logo]');
  el.pricingHeader = overlay.querySelector('[data-idm-pricing-header]');

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closeInstantDataModal();
    if (event.target.closest('[data-idm-close]')) closeInstantDataModal();
  });
  overlay.querySelector('[data-idm-submit]').addEventListener('click', handleDataPurchase);

  el.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-network]');
    if (!tab) return;
    selectNetwork(tab.dataset.network);
  });

  el.bundleList.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="idmBundle"]');
    if (input) selectBundle(input.value);
  });

  el.phone.addEventListener('input', () => {
    el.phone.value = el.phone.value.replace(/\D/g, '').slice(0, 10);
    state.idempotencyKey = null;
    hideError();
    // Nudge the network to match the number the agent typed, but never override
    // a choice the agent already made for this network.
    const guess = guessNetworkFromPhone(el.phone.value);
    if (guess && guess !== state.network && hasNetwork(guess)) selectNetwork(guess, { fromPhone: true });
    syncFooter();
  });

  el.phone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !el.cta.disabled) handleDataPurchase();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && el.overlay.classList.contains('is-open')) closeInstantDataModal();
  });

  state.built = true;
}

function hasNetwork(network) {
  return state.networks.some((group) => group.network === network);
}

function selectNetwork(network, { fromPhone = false } = {}) {
  if (!hasNetwork(network)) return;
  state.network = network;
  // A different network means the old selection is not a valid choice any more.
  state.bundleId = '';
  state.idempotencyKey = null;
  if (!fromPhone) hideError();

  const brand = NETWORK_BRANDING[network];
  for (const name of Object.keys(NETWORK_BRANDING)) {
    el.overlay.classList.toggle(`idm-theme-${name}`, name === network);
  }
  el.title.textContent = brand.label + ' data bundles';
  el.networkLogo.src = brand.logo;
  el.networkLogo.alt = brand.label + ' logo';
  el.pricingHeader.textContent = brand.label + ' bundle pricing';

  renderTabs();
  renderBundles();
  syncFooter();
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const group of state.networks) {
    const brand = NETWORK_BRANDING[group.network] || NETWORK_BRANDING.mtn;
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'idm-tab';
    tab.dataset.network = group.network;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(group.network === state.network));
    tab.classList.toggle('is-active', group.network === state.network);
    tab.innerHTML = `<i class="${brand.icon}" aria-hidden="true"></i><span>${brand.label}</span>`;
    el.tabs.appendChild(tab);
  }
}

function renderBundles() {
  const bundles = bundlesForNetwork(state.networks, state.network);
  el.bundleList.innerHTML = '';

  if (!bundles.length) {
    el.bundleList.innerHTML = '<p class="idm-empty">No bundles are available on this network right now.</p>';
    return;
  }

  for (const bundle of bundles) {
    const low = state.balance < bundle.price;
    const unavailable = !state.salesEnabled || bundle.isAvailable === false;
    const label = document.createElement('label');
    label.className = 'idm-bundle';
    label.classList.toggle('is-selected', bundle.bundleId === state.bundleId);
    label.classList.toggle('is-low', low);
    label.classList.toggle('is-unavailable', unavailable);

    // validity is null for every real row today; the span is only filled when
    // the catalog actually supplies one.
    const validity = bundle.validity
      ? `<span class="idm-bundle-validity">${escapeHtml(bundle.validity)}</span>`
      : '';
    const category = bundle.category && bundle.category !== 'Standard'
      ? `<span class="idm-bundle-category">${escapeHtml(bundle.category)}</span>`
      : '';

    label.innerHTML = `
      <input type="radio" name="idmBundle" value="${escapeHtml(bundle.bundleId)}"
             ${bundle.bundleId === state.bundleId ? 'checked' : ''}
             ${unavailable ? 'disabled' : ''} />
      <span class="idm-bundle-info">
        <span class="idm-bundle-title">${escapeHtml(bundle.title)}</span>
        ${validity}
        ${category}
      </span>
      <span class="idm-bundle-side">
        ${unavailable
          ? '<span class="idm-flag">Out of stock</span>'
          : (low ? '<span class="idm-flag">Low balance</span>' : '')}
        <span class="idm-bundle-price">${formatGhs(bundle.price)}</span>
      </span>`;

    el.bundleList.appendChild(label);
  }
}

function selectedBundle() {
  for (const group of state.networks) {
    for (const bundle of group.bundles || []) {
      if (bundle.bundleId === state.bundleId) return bundle;
    }
  }
  return null;
}

function selectBundle(bundleId) {
  if (!state.salesEnabled) return;
  const candidate = selectedBundleById(bundleId);
  if (candidate?.isAvailable === false) return;
  state.bundleId = bundleId;
  state.idempotencyKey = null;
  hideError();
  for (const node of el.bundleList.querySelectorAll('.idm-bundle')) {
    node.classList.toggle('is-selected', node.querySelector('input')?.value === bundleId);
  }
  syncFooter();
}

function selectedBundleById(bundleId) {
  for (const group of state.networks) {
    const bundle = (group.bundles || []).find((entry) => entry.bundleId === bundleId);
    if (bundle) return bundle;
  }
  return null;
}

function syncFooter() {
  const brand = NETWORK_BRANDING[state.network] || NETWORK_BRANDING.mtn;
  el.balance.textContent = formatGhs(state.balance);

  const bundle = selectedBundle();
  const phoneOk = /^\d{10}$/.test(el.phone.value);
  const available = Boolean(bundle && state.salesEnabled && bundle.isAvailable !== false);
  const affordable = available && state.balance >= bundle.price;

  el.cta.disabled = state.submitting || !bundle || !phoneOk || !affordable;
  el.cta.classList.toggle('is-topup', Boolean(bundle && !affordable));

  if (!bundle) {
    el.cta.textContent = 'Select a bundle';
  } else if (!available) {
    el.cta.textContent = 'Instant Data out of stock';
  } else if (!affordable) {
    const short = bundle.price - state.balance;
    el.cta.textContent = `Top up ${formatGhs(short)} to buy`;
  } else {
    el.cta.textContent = `Send ${brand.label} data — ${formatGhs(bundle.price)}`;
  }
}

function showError(message) {
  el.error.textContent = message;
  el.error.hidden = false;
}

function hideError() {
  el.error.hidden = true;
  el.error.textContent = '';
}

/**
 * Opens the modal from any `[data-open-instant-data]` trigger on the page, so a
 * new entry point only needs the attribute rather than its own listener.
 */
function wireTriggers() {
  document.querySelectorAll('[data-open-instant-data]').forEach((trigger) => {
    if (trigger.dataset.idmWired === '1') return;
    trigger.dataset.idmWired = '1';
    trigger.addEventListener('click', () => { openInstantDataModal(); });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireTriggers, { once: true });
} else {
  wireTriggers();
}

/** Opens the modal. Safe to call repeatedly. */
export async function openInstantDataModal() {
  build();

  el.overlay.classList.add('is-open');
  el.overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('idm-open');
  syncFooter();

  // Price and balance must both be current before the agent can commit to one.
  const [catalogResult, balance] = await Promise.allSettled([
    loadBundleCatalog(),
    refreshWalletBalance(),
  ]);

  if (balance.status === 'fulfilled' && typeof balance.value === 'number') {
    state.balance = balance.value;
  }

  if (catalogResult.status === 'rejected') {
    state.networks = [];
    el.bundleList.innerHTML =
      '<p class="idm-empty">We could not load data bundles. Check your connection and try again.</p>';
    syncFooter();
    return;
  }

  state.networks = catalogResult.value.networks;
  state.staleCatalog = catalogResult.value.stale;
  state.salesEnabled = catalogResult.value.salesEnabled === true;

  if (!hasNetwork(state.network)) state.network = state.networks[0].network;
  selectNetwork(state.network);

  if (state.staleCatalog) {
    showError('Showing the last known bundles. Prices are confirmed when you buy.');
  }
  if (!state.salesEnabled) {
    showError('Instant Data is temporarily out of stock while provider mappings are being completed.');
  }

  el.phone.focus();
}

export function closeInstantDataModal() {
  if (!state.built) return;
  el.overlay.classList.remove('is-open');
  el.overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('idm-open');
  hideError();
}

function isValidGhanaNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^0\d{9}$/.test(digits);
}

/**
 * Buys the selected bundle.
 *
 * The order is recorded against the signed-in agent's own name and email,
 * because this is an agent-wallet purchase and the wallet has to be traceable to
 * one account. The recipient phone number is what receives the data.
 */
export async function handleDataPurchase() {
  if (state.submitting) return;

  const bundle = selectedBundle();
  const phone = el.phone.value.trim();

  if (!bundle) {
    showError('Choose a bundle first.');
    return;
  }
  if (!isValidGhanaNumber(phone)) {
    showError('Enter a valid 10-digit Ghanaian phone number, e.g. 0241234567.');
    el.phone.focus();
    return;
  }
  if (state.balance < bundle.price) {
    const short = bundle.price - state.balance;
    const message = `Your balance is ${formatGhs(short)} short for this bundle. Top up to continue.`;
    showError(message);
    if (window.confirm(`${message}\n\nOpen your wallet to top up now?`)) {
      window.location.href = TOP_UP_URL;
    }
    return;
  }

  state.submitting = true;
  el.cta.disabled = true;
  el.cta.textContent = 'Processing…';
  hideError();

  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Please sign in to buy data.');

    // bundleKey, not price: the server resolves both the bundle and its price,
    // so nothing about the charge can be tampered with from the browser.
    const { data, error } = await supabase.functions.invoke('purchase-data-bundle', {
      body: {
        bundleKey: bundle.bundleId,
        phone,
        idempotencyKey: state.idempotencyKey || (state.idempotencyKey = crypto.randomUUID()),
      },
    });

    if (error) throw new Error(error.message || 'The data purchase could not be completed.');
    const reference = data?.reference || data?.orderReference;
    if (data?.success !== true || !reference) {
      throw new Error(data?.error || 'The data purchase could not be completed.');
    }

    const fresh = await refreshWalletBalance();
    if (typeof fresh === 'number') state.balance = fresh;
    else state.balance -= bundle.price;

    el.phone.value = '';
    state.bundleId = '';
    state.idempotencyKey = null;
    closeInstantDataModal();

    window.alert(
      `${bundle.title} on ${NETWORK_BRANDING[state.network].label} is on its way to ${phone}.\n\n` +
      `Reference: ${reference}\nTrack it on your Orders page.`,
    );
  } catch (err) {
    showError(err instanceof Error ? err.message : 'The data purchase could not be completed.');
    // The wallet may still have been charged, so re-read it rather than guessing.
    const fresh = await refreshWalletBalance();
    if (typeof fresh === 'number') {
      state.balance = fresh;
      renderBundles();
      syncFooter();
    }
  } finally {
    state.submitting = false;
    syncFooter();
  }
}
