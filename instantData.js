import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js';
import { checkAgentAccessServer } from './agentAccessCheck.js';

/** Hubtel-only Instant Data storefront. Standard Data uses data.html. */


const state = {
  networks: [],
  providerConfigured: false,
  salesEnabled: false,
  purchaseEnabled: false,
  activeNetworkId: null,
  selectedBundleKey: null,
  balance: 0,
  busy: false,
  catalogRequestId: 0,
  /** Stable per (network, bundle, phone) so a retry cannot double-charge. */
  idempotencyKey: null,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function formatCedi(amount) {
  return `${CEDI}${Number(amount || 0).toFixed(2)}`;
}

function formatGhs(amount) {
  return `GH₵ ${Number(amount || 0).toFixed(2)}`;
}

function activeNetwork() {
  return state.networks.find((network) => network.id === state.activeNetworkId) || null;
}

function activeBundles() {
  const network = activeNetwork();
  return network ? network.bundles : [];
}

function selectedBundle() {
  return activeBundles().find((bundle) => bundle.bundleKey === state.selectedBundleKey) || null;
}

function showNotice(message, kind = 'error') {
  const notice = $('svNotice');
  notice.className = `sv-notice show ${kind}`;
  notice.textContent = message;
}

function clearNotice() {
  const notice = $('svNotice');
  notice.className = 'sv-notice';
  notice.textContent = '';
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Use the selected network's brand colour throughout the active drawer. MTN's
 * yellow gets dark ink; Telecel and AirtelTigo use white ink.
 */
function applyNetworkAccent() {
  const network = activeNetwork();
  const accent = network?.brandColor || '#1e40af';
  const ink = network?.id === 'mtn' ? '#1a1400' : '#ffffff';
  document.documentElement.style.setProperty('--sv-accent', accent);
  document.documentElement.style.setProperty('--sv-accent-ink', ink);
}

function renderTabs() {
  const tabs = $('networkTabs');
  if (!state.networks.length) {
    tabs.innerHTML = '';
    return;
  }

  tabs.innerHTML = state.networks.map((network) => `
    <button
      type="button"
      role="tab"
      class="sv-tab ${network.id === state.activeNetworkId ? 'active' : ''}"
      aria-selected="${network.id === state.activeNetworkId}"
      onclick="selectDataNetwork('${escapeHtml(network.id)}')"
    >
      <span class="sv-tab-dot" style="background:${escapeHtml(network.brandColor)}">${escapeHtml(network.badgeText)}</span>
      <span>${escapeHtml(network.name.replace(/\s+Data$/i, ''))}</span>
    </button>
  `).join('');
}

function renderHero() {
  const network = activeNetwork();
  if (!network) {
    $('heroBadge').textContent = '--';
    $('heroName').textContent = 'No networks available';
    $('heroTag').textContent = '';
    return;
  }

  const bundle = selectedBundle();
  $('heroBadge').textContent = network.badgeText;
  $('heroBadge').style.background = network.brandColor;
  $('heroName').textContent = network.name;
  $('heroTag').textContent = network.tagline || 'From wallet · Instant delivery';

  const price = $('heroPrice');
  if (bundle) {
    price.textContent = formatCedi(bundle.price);
    price.classList.remove('muted');
  } else {
    price.textContent = formatCedi(0);
    price.classList.add('muted');
  }
}

function renderBundles() {
  const list = $('bundleList');
  const bundles = activeBundles();
  const network = activeNetwork();

  $('bundleCount').textContent = bundles.length ? `${bundles.length} available` : '';

  if (!bundles.length) {
    list.innerHTML = `
      <div class="sv-empty">
        No ${network ? escapeHtml(network.name) : ''} bundles are on sale yet.<br>
        Packages are switched on once the provider mapping is confirmed.
      </div>
    `;
    return;
  }

  const grouped = new Map();
  for (const bundle of bundles) {
    const category = bundle.category || 'Other';
    const rows = grouped.get(category) || [];
    rows.push(bundle);
    grouped.set(category, rows);
  }

  list.innerHTML = [...grouped.entries()].map(([categoryName, rows]) => `
    <section class="sv-category-group" aria-label="${escapeHtml(categoryName)} bundles">
      <div class="sv-category-heading">
        <span>${escapeHtml(categoryName)}</span>
        <span>${rows.length} plan${rows.length === 1 ? '' : 's'}</span>
      </div>
      ${rows.map((bundle) => {
        const unaffordable = Number(bundle.price) > state.balance;
        const selected = bundle.bundleKey === state.selectedBundleKey;
        const unavailable = bundle.isAvailable === false || bundle.providerMapped === false;
        const validity = bundle.validity
          ? `<span class="sv-validity">${escapeHtml(bundle.validity)}</span>`
          : '';

        return `
          <button
            type="button"
            role="radio"
            class="sv-bundle ${selected ? 'selected' : ''} ${unaffordable ? 'unaffordable' : ''} ${unavailable ? 'disabled' : ''}"
            aria-checked="${selected}"
            aria-disabled="${unavailable}"
            ${unavailable ? 'disabled' : ''}
            onclick="selectDataBundle('${escapeHtml(bundle.bundleKey)}')"
          >
            <input type="radio" name="sv-bundle" tabindex="-1" aria-hidden="true" ${selected ? 'checked' : ''} readonly>
            <span class="sv-radio" aria-hidden="true"></span>
            <span class="sv-bundle-info">
              <span class="sv-bundle-title">${escapeHtml(bundle.title)}</span>
              <span class="sv-bundle-meta">${escapeHtml(network?.name || '')} ${validity}</span>
            </span>
            <span class="sv-bundle-price">
              <span class="sv-price">${formatCedi(bundle.price)}</span>
              ${unaffordable ? '<span class="sv-low">Low balance</span>' : ''}
              ${unavailable ? `<span class="sv-unavailable">${bundle.providerMapped === false ? 'Mapping pending' : 'Inactive'}</span>` : ''}
            </span>
          </button>
        `;
      }).join('')}
    </section>
  `).join('');
}

function renderBalance() {
  $('walletBalance').textContent = formatGhs(state.balance);
}

function renderFooter() {
  const button = $('sendBtn');
  const network = activeNetwork();
  const bundle = selectedBundle();
  const phone = ($('recipientPhone').value || '').replace(/\D/g, '');

  if (state.busy) {
    button.disabled = true;
    button.textContent = 'Sending...';
    return;
  }

  if (!bundle) {
    button.disabled = true;
    button.textContent = 'Select a Data Bundle';
    return;
  }

  if (!GHANA_PHONE.test(phone)) {
    button.disabled = true;
    button.textContent = 'Enter recipient number';
    return;
  }

  if (Number(bundle.price) > state.balance) {
    button.disabled = true;
    button.textContent = 'Wallet balance too low';
    return;
  }

  if (bundle.isAvailable === false) {
    button.disabled = true;
    button.textContent = 'Plan inactive';
    return;
  }

  if (!state.purchaseEnabled) {
    button.disabled = true;
    button.textContent = state.providerConfigured ? 'Purchasing temporarily paused' : 'Provider setup pending';
    return;
  }

  button.disabled = false;
  button.textContent = `Send ${network ? network.name : 'Data'} — ${formatCedi(bundle.price)}`;
}

function renderAll() {
  applyNetworkAccent();
  renderTabs();
  renderHero();
  renderBundles();
  renderBalance();
  renderFooter();
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export async function selectDataNetwork(networkId) {
  if (!state.networks.some((network) => network.id === networkId)) return;
  state.activeNetworkId = networkId;
  // The selection is per network, so switching networks must not leave a bundle
  // key selected that does not exist on the new one.
  state.selectedBundleKey = null;
  state.idempotencyKey = null;
  renderAll();

  const requestId = ++state.catalogRequestId;
  try {
    const data = await fetchCatalog(networkId);
    if (requestId !== state.catalogRequestId) return;
    const freshGroup = (Array.isArray(data?.networks) ? data.networks : [])
      .find((network) => network.id === networkId);
    if (freshGroup) {
      const current = state.networks.find((network) => network.id === networkId);
      if (current) current.bundles = freshGroup.bundles || [];
      state.purchaseEnabled = data?.purchaseEnabled === true && state.providerConfigured;
      renderAll();
    }
  } catch (err) {
    if (requestId === state.catalogRequestId) showNotice(err.message || 'Could not refresh this network catalogue.');
  }
}

export function selectDataBundle(bundleKey) {
  if (!activeBundles().some((bundle) => bundle.bundleKey === bundleKey && bundle.isAvailable !== false && bundle.providerMapped !== false)) return;
  state.selectedBundleKey = bundleKey;
  state.idempotencyKey = null;
  renderAll();
}

/**
 * Detects the network from the first three digits.
 *
 * Only a prefix that some active network claims triggers a switch. An
 * unrecognised prefix deliberately does nothing: `networks.phone_prefixes` is
 * data that gets corrected when allocations change, so guessing on a miss would
 * switch a customer to the wrong network instead of leaving their choice alone.
 */
function detectNetwork(phone) {
  const prefix = phone.slice(0, 3);
  if (!/^0\d\d$/.test(prefix)) return null;
  return state.networks.find((network) =>
    (network.phonePrefixes || []).some((candidate) => String(candidate) === prefix)
  ) || null;
}

export function handleDataPhoneInput() {
  const input = $('recipientPhone');
  const digits = input.value.replace(/\D/g, '').slice(0, 10);
  if (digits !== input.value) input.value = digits;

  const hint = $('phoneHint');
  hint.className = 'sv-hint';

  if (digits.length === 10) {
    const detected = detectNetwork(digits);
    if (detected && detected.id !== state.activeNetworkId) {
      selectDataNetwork(detected.id);
    }
    hint.className = 'sv-hint ok show';
    hint.innerHTML = '<i class="fa-solid fa-circle-check"></i> Valid number';
  } else if (digits.length === 3) {
    const detected = detectNetwork(digits);
    if (detected) {
      hint.className = 'sv-hint ok show';
      hint.innerHTML = `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(detected.name)}`;
      if (detected.id !== state.activeNetworkId) selectDataNetwork(detected.id);
    } else {
      input.classList.remove('invalid');
      renderFooter();
      return;
    }
  } else if (digits.length > 0) {
    hint.className = 'sv-hint bad show';
    hint.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Enter 10 digits';
    input.classList.add('invalid');
  }

  input.classList.remove('invalid');
  state.idempotencyKey = null;
  renderFooter();
}

function openResult({ icon, title, description, reference }) {
  $('resultIcon').innerHTML = icon;
  $('resultTitle').textContent = title;
  $('resultDesc').textContent = description;
  $('resultRef').textContent = reference || '-';
  $('resultOverlay').classList.add('active');
}

export function closeDataResult() {
  $('resultOverlay').classList.remove('active');
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadCatalog() {
  const data = await fetchCatalog();
  if (data?.error) throw new Error(String(data.error));

  const networks = (Array.isArray(data?.networks) ? data.networks : []).map((network) => ({
    ...network,
    bundles: (Array.isArray(network.bundles) ? network.bundles : []).map((bundle) => ({
      ...bundle,
      isAvailable: bundle.isAvailable === true,
      providerMapped: bundle.providerMapped !== false,
      unavailableReason: bundle.unavailableReason ? String(bundle.unavailableReason) : null,
    })),
  }));
  state.networks = networks;
  state.providerConfigured = data?.provider?.configured === true;
  state.salesEnabled = data?.salesEnabled === true;
  state.purchaseEnabled = data?.purchaseEnabled === true && state.providerConfigured;

  if (!state.activeNetworkId && networks.length) {
    const preferred = new URLSearchParams(window.location.search).get('network');
    // legacyKey keeps older ?network=airteltigo links working; the catalog id
    // for AirtelTigo is 'at'.
    const requested = networks.find((network) =>
      network.id === preferred || network.legacyKey === preferred
    );
    state.activeNetworkId = (requested || networks[0]).id;
  }

  if (!state.purchaseEnabled) {
    showNotice(
      state.providerConfigured
        ? 'Plans are live, but Instant Data purchasing is temporarily paused.'
        : 'Plans are live, but the Hubtel purchase connection is not configured yet. No wallet charge will be made.',
      'info',
    );
  } else if (!networks.length) {
    showNotice('No data bundles are on sale right now. Please check back shortly.', 'info');
  }
}

async function fetchCatalog(networkId = '') {
  const network = networkId === 'at' ? 'AT' : networkId === 'telecel' ? 'Telecel' : networkId === 'mtn' ? 'MTN' : '';
  const url = new URL(`${SUPABASE_URL}/functions/v1/data-catalog`);
  if (network) url.searchParams.set('network', network);
  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json', apikey: SUPABASE_ANON_KEY },
    cache: 'no-store',
  });
  let data;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) throw new Error(data?.error || 'Could not reach the data catalog.');
  return data;
}

/**
 * Reads the live wallet balance straight from `wallets` (the authoritative
 * table the charge/refund RPCs maintain), so the footer can never show the
 * stale `profiles.wallet_balance` mirror. The mirror is only a fallback for an
 * account whose wallet row has not been provisioned yet.
 */
async function loadBalance() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user) return;

  const { data: wallet } = await supabase
    .from('wallets')
    .select('balance')
    .eq('id', session.user.id)
    .maybeSingle();

  if (wallet?.balance !== null && wallet?.balance !== undefined) {
    state.balance = Number(wallet.balance) || 0;
    return;
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('wallet_balance')
    .eq('id', session.user.id)
    .maybeSingle();

  if (profile?.wallet_balance !== null && profile?.wallet_balance !== undefined) {
    state.balance = Number(profile.wallet_balance) || 0;
  }
}

export async function startDataPurchase() {
  if (state.busy) return;

  const bundle = selectedBundle();
  const phone = ($('recipientPhone').value || '').replace(/\D/g, '');

  if (!bundle) {
    showNotice('Select a data bundle first.');
    return;
  }
  if (!GHANA_PHONE.test(phone)) {
    showNotice('Enter a valid 10-digit Ghanaian recipient number (e.g. 024XXXXXXX).');
    return;
  }
  if (!state.purchaseEnabled) {
    showNotice('This plan is visible, but live provider mapping is not complete yet. No wallet charge was made.', 'info');
    return;
  }
  if (Number(bundle.price) > state.balance) {
    showNotice(`Your wallet balance is ${formatGhs(state.balance)}, which does not cover this ${formatCedi(bundle.price)} bundle. Top up your wallet to buy it.`);
    return;
  }

  // One key per distinct order. A retry of the same order reuses it, so the
  // server returns the original transaction instead of charging again.
  const orderKey = `${state.activeNetworkId}:${bundle.bundleKey}:${phone}`;
  if (!state.idempotencyKey) {
    state.idempotencyKey = `${orderKey}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) +
      `-${Math.random().toString(36).slice(2, 8)}`;
  }

  state.busy = true;
  clearNotice();
  renderFooter();

  try {
    const { data, error } = await supabase.functions.invoke('purchase-data-bundle', {
      body: { bundleKey: bundle.bundleKey, phone, idempotencyKey: state.idempotencyKey },
    });

    if (error) throw new Error(error.message || 'Unable to complete the purchase.');
    if (typeof data?.walletBalance === 'number') state.balance = data.walletBalance;

    if (data?.success) {
      state.idempotencyKey = null;
      openResult({
        icon: '&#9989;',
        title: 'Bundle delivered',
        description: `${bundle.title} sent to ${phone}. ${data.message || ''}`.trim(),
        reference: data.shortCode || data.reference,
      });
    } else if (data?.pending) {
      // Wallet held, delivery unconfirmed. Not offered as a retry: resending
      // could deliver the bundle twice.
      openResult({
        icon: '&#9203;',
        title: 'Delivery being confirmed',
        description: data.message || 'We are confirming this delivery. Your wallet is on hold until we settle it. Please do not resend.',
        reference: data.shortCode || data.reference,
      });
    } else {
      openResult({
        icon: '&#9888;',
        title: 'Bundle not delivered',
        description: data?.message || data?.error || 'The order could not be completed. Any wallet charge has been reversed.',
        reference: data?.shortCode || data?.reference,
      });
    }

    $('recipientPhone').value = '';
    $('phoneHint').className = 'sv-hint';
  } catch (err) {
    console.warn('Data purchase error:', err);
    showNotice(err.message || 'Unable to complete the purchase. Please try again.');
  } finally {
    state.busy = false;
    renderAll();
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  const { isAgent } = await checkAgentAccessServer();
  if (!isAgent) {
    const params = new URLSearchParams();
    params.set('action', 'agent');
    params.set('notice', 'agent');
    params.set('redirect', 'instantData.html');
    window.location.href = `login.html?${params.toString()}`;
    return;
  }

  try {
    await Promise.all([loadCatalog(), loadBalance()]);
  } catch (err) {
    console.warn('Instant data page load failed:', err);
    showNotice('Could not load data bundles right now. Please refresh and try again.');
  }

  renderAll();
});

window.selectDataNetwork = selectDataNetwork;
window.selectDataBundle = selectDataBundle;
window.handleDataPhoneInput = handleDataPhoneInput;
window.startDataPurchase = startDataPurchase;
window.closeDataResult = closeDataResult;
