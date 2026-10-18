import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient.js';

/**
 * Client for the sellable bundle catalog.
 *
 * Prices are never hardcoded here. Every price comes from the live `bundles`
 * catalog through `data-catalog`, which is the same catalog used by the
 * standalone Instant Data page and the secure purchase function. If that call
 * fails there is deliberately no local fallback: showing a cached or invented
 * price would let an agent quote one number and be charged another.
 */

const CACHE_KEY = 'data_bundle_catalog_v3';
const CACHE_TTL_MS = 5 * 60 * 1000;

let inFlight = null;

/** Branding, so the modal can theme itself without hardcoding it in the markup. */
export const NETWORK_BRANDING = {
  mtn: { label: 'MTN', accent: '#FFCC00', accentText: '#1a1400', icon: 'fa-solid fa-signal', logo: 'img/mtn-logo.png' },
  telecel: { label: 'Telecel', accent: '#DA291C', accentText: '#ffffff', icon: 'fa-solid fa-wifi', logo: 'img/telecel-logo.png' },
  airteltigo: { label: 'AirtelTigo', accent: '#0072BC', accentText: '#ffffff', icon: 'fa-solid fa-mobile-screen', logo: 'img/airtel-logo.png' },
};

/**
 * Number prefixes per network, used to guess the network a customer expects
 * from the phone number they typed. Wrong guesses are harmless because the
 * network tabs stay editable and the provider validates the pairing.
 */
const NETWORK_PREFIXES = {
  mtn: ['024', '025', '053', '054', '055', '059'],
  telecel: ['020', '050'],
  airteltigo: ['026', '027', '056', '057'],
};

export function guessNetworkFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length !== 10 || !digits.startsWith('0')) return null;
  const prefix = digits.slice(0, 3);
  return Object.keys(NETWORK_PREFIXES).find((network) => NETWORK_PREFIXES[network].includes(prefix)) ?? null;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.fetchedAt || Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return Array.isArray(parsed.networks) ? parsed.networks : null;
  } catch {
    return null;
  }
}

function writeCache(networks) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), networks }));
  } catch {
    // A full or blocked localStorage just means no cache. Not worth surfacing.
  }
}

/**
 * Returns the catalog grouped by network: [{ network, bundles: [...] }].
 *
 * Concurrent callers share one request. A stale cache is only used when a
 * refresh fails, and it is reported through `stale` so the UI can say so.
 */
export async function loadBundleCatalog({ force = false } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let networks = force ? null : readCache();
    let stale = false;
    let salesEnabled = false;

    if (networks) {
      // Cached rows are already gated by the last server response. Treat the
      // cache as sellable only when it actually contains an available row.
      salesEnabled = networks.some((group) => (group.bundles || []).some((bundle) => bundle.isAvailable === true));
    }

    if (!networks) {
      try {
        const invoked = await supabase.functions.invoke('data-catalog');
        let data = invoked.data;
        if (invoked.error) {
          // A stale session token can make supabase-js fail even though this
          // public catalog is readable anonymously. Retry without that token.
          const response = await fetch(`${SUPABASE_URL}/functions/v1/data-catalog`, {
            headers: { Accept: 'application/json', apikey: SUPABASE_ANON_KEY },
            cache: 'no-store',
          });
          let fallback;
          try { fallback = await response.json(); } catch { fallback = null; }
          if (!response.ok) {
            throw new Error(invoked.error.message || fallback?.error || 'Could not load data bundles.');
          }
          data = fallback;
        }
        if (data?.error) throw new Error(String(data.error));
        salesEnabled = data?.salesEnabled === true;
        networks = (Array.isArray(data?.networks) ? data.networks : []).map((group) => ({
          // The database keeps AirtelTigo as `at` for the foreign key while the
          // modal's branding and phone-prefix map use the readable legacy key.
          network: String(group.legacyKey || group.id || '').toLowerCase() === 'at'
            ? 'airteltigo'
            : String(group.legacyKey || group.id || '').toLowerCase(),
          bundles: (Array.isArray(group.bundles) ? group.bundles : []).map((bundle) => ({
            bundleId: String(bundle.bundleKey || ''),
            title: String(bundle.title || bundle.dataAmount || 'Data bundle'),
            validity: bundle.validity ? String(bundle.validity) : null,
            volumeMb: Number(bundle.volumeMb),
            price: Number(bundle.price),
            category: String(bundle.category || 'Standard'),
            isAvailable: salesEnabled && bundle.isAvailable === true,
            unavailableReason: bundle.unavailableReason ? String(bundle.unavailableReason) : null,
          })),
        })).filter((group) => group.network && group.bundles.length);
        if (!networks.length) throw new Error('No data bundles are available right now.');
        writeCache(networks);
      } catch (err) {
        networks = readCache();
        if (!networks) throw err;
        stale = true;
        salesEnabled = networks.some((group) => (group.bundles || []).some((bundle) => bundle.isAvailable === true));
      }
    }

    return { networks, stale, salesEnabled };
  })().finally(() => { inFlight = null; });

  try {
    return await inFlight;
  } catch (err) {
    throw err instanceof Error ? err : new Error('Could not load data bundles.');
  }
}
/** All bundles for one network, cheapest first. */
export function bundlesForNetwork(networks, network) {
  const group = networks.find((entry) => entry.network === network);
  if (!group) return [];
  return [...(group.bundles || [])].sort((a, b) => a.volumeMb - b.volumeMb);
}

export function formatGhs(amount) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'GH₵ 0.00';
  return 'GH₵ ' + value.toFixed(2);
}
