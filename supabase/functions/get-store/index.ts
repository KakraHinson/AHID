import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import {
  DATA_NETWORKS,
  SALE_CATALOG,
  bundleIdFor,
  formatBundleVolume,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';

/**
 * Public storefront definition for a single agent store.
 *
 * A customer opens `store.html?ref=<slug>` and this returns the store's brand
 * plus the Data Bundle catalog priced at THAT owner's selling prices. It is
 * unauthenticated on purpose: the page has to render before anyone signs in.
 *
 * It never touches a wallet and never returns anything private - no agent code,
 * no wallet balance, no provider cost. Prices come from the owner's own
 * `agent_pricing` overrides (or a per-store `store_products` override), falling
 * back to the platform catalog, and are always resolved server-side so the
 * browser can never decide what a bundle costs.
 */
function normalizeSlug(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

const NETWORK_LABELS: Record<string, string> = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    let slug = '';
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      slug = normalizeSlug(params.get('slug') || params.get('ref') || params.get('agent') || params.get('code'));
    } else {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      slug = normalizeSlug(body.slug ?? body.ref ?? body.agent ?? body.code);
    }

    const admin = adminClient();
    let store = null;

    if (slug) {
      // 1. Direct slug match
      const { data: storeBySlug } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
        .eq('slug', slug)
        .maybeSingle();
      if (storeBySlug) store = storeBySlug;

      // 2. Agent code match (e.g. SKAIADMIN, case-insensitive)
      if (!store) {
        const { data: agentByCode } = await admin
          .from('agents')
          .select('id')
          .ilike('agent_code', slug)
          .maybeSingle();
        if (agentByCode) {
          const { data: storeByAgent } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
            .eq('agent_id', agentByCode.id)
            .maybeSingle();
          if (storeByAgent) store = storeByAgent;
        }
      }

      // 3. Agent ID match
      if (!store) {
        const { data: storeById } = await admin
          .from('agent_stores')
          .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
          .eq('agent_id', slug)
          .maybeSingle();
        if (storeById) store = storeById;
      }
    }

    // 4. Default fallback: Load primary active store so customers always see the data bundles
    if (!store || !store.is_active) {
      const { data: fallbackStore } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackStore) store = fallbackStore;
    }

    if (!store || !store.is_active) {
      return json({ error: 'This store is not available.', code: 'store_unavailable' }, 404);
    }

    const ownerId = String(store.agent_id);

    const [ownerResult, catalogResult, productsResult, pricingResult] = await Promise.all([
      admin.from('agents').select('full_name').eq('id', ownerId).maybeSingle(),
      admin.from('bundle_catalog')
        .select('bundle_id, network, title, validity, volume_mb, price')
        .eq('active', true)
        .order('sort_order', { ascending: true }),
      admin.from('store_products')
        .select('product_ref, price, is_enabled')
        .eq('store_id', store.id)
        .eq('product_type', 'data_bundle'),
      admin.from('agent_pricing')
        .select('pricing_key, price')
        .eq('agent_id', ownerId),
    ]);

    if (catalogResult.error) throw catalogResult.error;

    // The owner's custom prices, keyed the same way the Store > Pricing tab
    // writes them: price_<network>_<gb>gb.
    const customPrices = new Map<string, number>();
    for (const row of (pricingResult.data ?? []) as { pricing_key: string; price: number }[]) {
      const value = Number(row.price);
      if (Number.isFinite(value) && value > 0) customPrices.set(String(row.pricing_key), value);
    }

    // A per-store override wins over the agent's global pricing; an explicit
    // is_enabled=false hides the bundle from this store.
    const overrides = new Map<string, { price: number; enabled: boolean }>();
    for (const row of (productsResult.data ?? []) as { product_ref: string; price: number; is_enabled: boolean }[]) {
      overrides.set(String(row.product_ref), { price: Number(row.price), enabled: row.is_enabled !== false });
    }

    // Prefer the provider-confirmed catalog. When it has no active rows (a
    // fresh project, or before the provider sync has run), fall back to the
    // canonical whole-GB sale catalog so the store is still sellable. Checkout
    // re-validates against the live provider either way, so an undeliverable
    // bundle is refused cleanly rather than charged.
    let bundles = (catalogResult.data ?? []) as {
      bundle_id: string; network: string; title: string; validity: string | null; volume_mb: number; price: number;
    }[];
    if (bundles.length === 0) {
      bundles = DATA_NETWORKS.flatMap((network) =>
        Object.entries(SALE_CATALOG[network])
          .filter(([mb]) => Number(mb) >= 1024)
          .map(([mb, price]) => ({
            bundle_id: bundleIdFor(network, Number(mb)),
            network,
            title: `${NETWORK_LABELS[network] ?? network.toUpperCase()} ${formatBundleVolume(Number(mb))}`,
            validity: null as string | null,
            volume_mb: Number(mb),
            price: Number(price),
          })));
    }

    const priced = bundles
      .map((bundle) => {
        const network = String(bundle.network);
        const volumeInMB = Number(bundle.volume_mb);
        const catalogPrice = Number(bundle.price);
        const override = overrides.get(String(bundle.bundle_id));
        if (override && !override.enabled) return null;

        const gb = volumeInMB / 1024;
        const customKey = Number.isInteger(gb) && gb > 0 ? `price_${network}_${gb}gb` : '';
        const custom = customKey ? customPrices.get(customKey) : undefined;
        const price = override?.price && override.price > 0
          ? override.price
          : (custom && custom > 0 ? custom : catalogPrice);

        return {
          bundleId: String(bundle.bundle_id),
          network: network as DataNetwork,
          title: String(bundle.title),
          validity: bundle.validity ? String(bundle.validity) : null,
          volumeMb: volumeInMB,
          price: Math.round(price * 100) / 100,
        };
      })
      .filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null);

    const networks = DATA_NETWORKS
      .map((network) => ({ network, bundles: priced.filter((b) => b.network === network) }))
      .filter((group) => group.bundles.length > 0);

    return json({
      store: {
        slug: String(store.slug),
        displayName: String(store.display_name),
        description: store.description ? String(store.description) : '',
        logoUrl: store.logo_url ? String(store.logo_url) : null,
        brandColor: store.brand_color ? String(store.brand_color) : '#2563eb',
        tagline: store.tagline ? String(store.tagline) : '',
        whatsapp: store.whatsapp ? String(store.whatsapp) : null,
        contactPhone: store.contact_phone ? String(store.contact_phone) : null,
      },
      ownerName: ownerResult.data?.full_name ? String(ownerResult.data.full_name) : 'Skaitech Agent',
      networks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load this store.';
    console.error('get-store failed:', message);
    return json({ error: 'Unable to load this store right now. Please try again.' }, 500);
  }
});
