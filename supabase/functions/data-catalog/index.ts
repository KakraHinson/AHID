import { corsPreflight, json } from '../_shared/supabase.ts';
import { hubtelConfigured } from '../_shared/hubtelDataProvider.ts';
import {
  instantDataSalesEnabled,
  INSTANT_DATA_OUT_OF_STOCK_MESSAGE,
} from '../_shared/instantDataAvailability.ts';

type InstantNetwork = 'MTN' | 'Telecel' | 'AT';

function normalizeNetwork(value: unknown): InstantNetwork | null {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'mtn') return 'MTN';
  if (normalized === 'telecel' || normalized === 'vodafone') return 'Telecel';
  if (normalized === 'at' || normalized === 'airteltigo') return 'AT';
  return null;
}

function volumeToMb(value: unknown): number {
  const match = String(value ?? '').trim().match(/([0-9]+(?:\.[0-9]+)?)\s*(GB|MB)/i);
  if (!match) return 0;
  const amount = Number(match[1]);
  return match[2].toUpperCase() === 'GB' ? Math.round(amount * 1024) : Math.round(amount);
}

/**
 * Serves the instant-data catalog: which networks exist, and which bundles are
 * sellable on each.
 *
 * Public and unauthenticated, like the existing list-data-bundles: a bundle list
 * is not sensitive, and the header card has to render before anyone signs in.
 * The catalog is deliberately public. Always use the anon/publishable key for
 * the internal read instead of forwarding a browser session token: an expired
 * access token must not turn a public catalog query into a 500 response.
 * RLS still applies, and the service role is never used here.
 *
 * The Instant Data plan catalogue is read from `instant_data_bundles`. The
 * table is deliberately separate from the provider-mapped fulfilment table:
 * an active plan can be displayed immediately, while checkout still refuses
 * to charge until a provider package mapping exists.
 *
 * `provider.configured` tells the page whether a delivery attempt is even
 * possible. Showing "delivery not available yet" is more useful than an empty
 * bundle list, and it means a half-finished deployment fails visibly rather
 * than looking like a platform with nothing to sell.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const salesEnabled = instantDataSalesEnabled();
    const providerConfigured = hubtelConfigured();
    const requestedNetwork = normalizeNetwork(new URL(request.url).searchParams.get('network'));
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || '';
    if (!anonKey) throw new Error('Supabase public key is not configured.');

    const supabase = createClient(url, anonKey, { auth: { persistSession: false } });

    const instantBundlesQuery = supabase
      .from('instant_data_bundles')
      .select('id, network, category, name, volume, price, validity, is_active, provider_value, provider_cost')
      .eq('is_active', true)
      .order('network', { ascending: true })
      .order('category', { ascending: true })
      .order('price', { ascending: true });
    if (requestedNetwork) instantBundlesQuery.eq('network', requestedNetwork);

    const [networksResult, instantBundlesResult] = await Promise.all([
      supabase
        .from('networks')
        .select('id, name, brand_color, badge_text, tagline, legacy_key, phone_prefixes')
        .order('sort_order', { ascending: true }),
      instantBundlesQuery,
    ]);

    if (networksResult.error) throw networksResult.error;
    if (instantBundlesResult.error) throw instantBundlesResult.error;

    const bundlesByNetwork = new Map<InstantNetwork, Record<string, unknown>[]>();
    for (const row of (instantBundlesResult.data ?? []) as Record<string, unknown>[]) {
      const network = normalizeNetwork(row.network);
      if (!network) continue;
      const rows = bundlesByNetwork.get(network) ?? [];
      rows.push(row);
      bundlesByNetwork.set(network, rows);
    }

    const networks = ((networksResult.data ?? []) as Record<string, unknown>[])
      .map((network) => ({
        id: String(network.id),
        name: String(network.name),
        brandColor: String(network.brand_color),
        badgeText: String(network.badge_text ?? ''),
        tagline: String(network.tagline ?? ''),
        // The longer pre-existing key ('airteltigo'), accepted in ?network=
        // URLs from the older storefront.
        legacyKey: network.legacy_key ? String(network.legacy_key) : null,
        phonePrefixes: Array.isArray(network.phone_prefixes) ? (network.phone_prefixes as unknown[]).map(String) : [],
        bundles: (bundlesByNetwork.get(normalizeNetwork(network.id) || 'MTN') ?? [])
          .map((bundle) => ({
            bundleKey: String(bundle.id),
            title: String(bundle.name),
            dataAmount: String(bundle.volume),
            volumeMb: volumeToMb(bundle.volume),
            price: Number(bundle.price),
            category: String(bundle.category ?? 'Regular'),
            validity: bundle.validity ? String(bundle.validity) : null,
            isAvailable: bundle.is_active === true,
            providerMapped: Boolean(bundle.provider_value && Number(bundle.provider_cost) > 0),
            unavailableReason: bundle.is_active === true
              ? (bundle.provider_value && Number(bundle.provider_cost) > 0
                ? null
                : 'This plan is awaiting its Hubtel package mapping.')
              : INSTANT_DATA_OUT_OF_STOCK_MESSAGE,
            source: 'instant_data_bundles',
          })),
      }))
      // A network with no catalog rows still has no useful tab, so it is
      // dropped rather than shown. Rows awaiting provider mapping remain in
      // the network and are rendered disabled by the client.
      .filter((network) => network.bundles.length > 0);

    return json({
      networks,
      salesEnabled,
      purchaseEnabled: salesEnabled && providerConfigured,
      requestedNetwork,
      outOfStockReason: salesEnabled ? null : INSTANT_DATA_OUT_OF_STOCK_MESSAGE,
      provider: { name: 'hubtel', configured: providerConfigured },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load the data catalog.';
    console.error('data-catalog failed:', message);
    return json({ error: 'Unable to load data bundles right now. Please try again.' }, 500);
  }
});
