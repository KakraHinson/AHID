import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';
import {
  DATA_NETWORKS,
  SALE_CATALOG,
  bundleIdFor,
  formatBundleVolume,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';

const NETWORK_LABELS: Record<string, string> = { mtn: 'MTN', telecel: 'Telecel', airteltigo: 'AirtelTigo' };

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    let inputParam = '';
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      inputParam = String(params.get('agent') || params.get('slug') || params.get('ref') || params.get('code') || '').trim();
    } else {
      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      inputParam = String(body.agent ?? body.slug ?? body.ref ?? body.code ?? '').trim();
    }

    const admin = adminClient();
    let store = null;

    if (inputParam) {
      const slugRaw = inputParam.toLowerCase();
      const dashed = slugRaw.replace(/[_ ]+/g, '-');
      const spaced = slugRaw.replace(/[-_]+/g, ' ');

      // 1. Match by slug (case-insensitive)
      let { data: storeBySlug } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
        .ilike('slug', slugRaw)
        .maybeSingle();
      if (!storeBySlug && dashed !== slugRaw) {
        const { data: storeByDashed } = await admin
          .from('agent_stores')
          .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
          .ilike('slug', dashed)
          .maybeSingle();
        storeBySlug = storeByDashed;
      }
      if (storeBySlug) store = storeBySlug;

      // 2. Match by store- prefix with hex or UUID
      if (!store && slugRaw.startsWith('store-')) {
        const hex = slugRaw.replace(/^store-/, '').replace(/[^a-f0-9]/gi, '');
        if (hex.length >= 6) {
          const { data: matchedAgents } = await admin
            .from('agents')
            .select('id')
            .ilike('id::text', `${hex}%`)
            .limit(1);
          if (matchedAgents && matchedAgents.length > 0) {
            const agentId = matchedAgents[0].id;
            let { data: storeByHex } = await admin
              .from('agent_stores')
              .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
              .eq('agent_id', agentId)
              .maybeSingle();
            if (!storeByHex) {
              await admin.rpc('ensure_agent_store', { p_agent_id: agentId });
              const { data: fresh } = await admin
                .from('agent_stores')
                .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
                .eq('agent_id', agentId)
                .maybeSingle();
              storeByHex = fresh;
            }
            if (storeByHex) store = storeByHex;
          }
        }
      }

      // 3. Match by agent code (e.g. SKAIADMIN, case-insensitive)
      if (!store) {
        const codeClean = inputParam.replace(/[^a-zA-Z0-9]/g, '');
        const { data: agentByCode } = await admin
          .from('agents')
          .select('id')
          .or(`agent_code.ilike.${inputParam},agent_code.ilike.${codeClean}`)
          .maybeSingle();
        if (agentByCode) {
          let { data: storeByAgent } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
            .eq('agent_id', agentByCode.id)
            .maybeSingle();
          if (!storeByAgent) {
            await admin.rpc('ensure_agent_store', { p_agent_id: agentByCode.id });
            const { data: fresh } = await admin
              .from('agent_stores')
              .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
              .eq('agent_id', agentByCode.id)
              .maybeSingle();
            storeByAgent = fresh;
          }
          if (storeByAgent) store = storeByAgent;
        }
      }

      // 4. Match by agent UUID
      if (!store && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inputParam)) {
        let { data: storeById } = await admin
          .from('agent_stores')
          .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
          .eq('agent_id', inputParam)
          .maybeSingle();
        if (!storeById) {
          await admin.rpc('ensure_agent_store', { p_agent_id: inputParam });
          const { data: fresh } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
            .eq('agent_id', inputParam)
            .maybeSingle();
          storeById = fresh;
        }
        if (storeById) store = storeById;
      }

      // 5. Match by agent full_name (e.g. AHIDU MOBIRI SEIDU or AHIDU_MOBIRI_SEIDU)
      if (!store) {
        let { data: agentByName } = await admin
          .from('agents')
          .select('id, full_name')
          .ilike('full_name', spaced)
          .maybeSingle();

        // If not found, try flexible matching on name parts
        if (!agentByName) {
          const parts = spaced.split(/\s+/).filter((p: string) => p.length >= 3);
          if (parts.length > 0) {
            let q = admin.from('agents').select('id, full_name');
            for (const part of parts) {
              q = q.ilike('full_name', `%${part}%`);
            }
            const { data: candidates } = await q.limit(2);
            if (candidates && candidates.length === 1) {
              agentByName = candidates[0];
            }
          }
        }

        if (agentByName) {
          let { data: storeByName } = await admin
            .from('agent_stores')
            .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
            .eq('agent_id', agentByName.id)
            .maybeSingle();
          if (!storeByName) {
            await admin.rpc('ensure_agent_store', { p_agent_id: agentByName.id });
            const { data: fresh } = await admin
              .from('agent_stores')
              .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
              .eq('agent_id', agentByName.id)
              .maybeSingle();
            storeByName = fresh;
          }
          if (storeByName) store = storeByName;
        }
      }
    }

    // Fallback: If no match and parameter was empty, select the primary active store
    if (!store && !inputParam) {
      const { data: fallbackStore } = await admin
        .from('agent_stores')
        .select('id, agent_id, slug, display_name, description, logo_url, brand_color, tagline, whatsapp, contact_phone, is_active')
        .eq('is_active', true)
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (fallbackStore) store = fallbackStore;
    }

    if (!store) {
      return json({ error: `Store not found for agent '${inputParam}'. Please check the store link.`, code: 'store_not_found' }, 404);
    }

    const ownerId = String(store.agent_id);

    // Build the full list of identifiers we might have stored agent_prices under.
    // agent_prices.agent_id is TEXT and may hold:
    //   • the agent UUID (primary write path)
    //   • the store slug  (mirrored by manage-agent-pricing for slug-based lookups)
    //   • the agent code  (mirrored by manage-agent-pricing when code differs from slug)
    //   • the raw inputParam the visitor used to reach this store
    const agentIdentifiers = [ownerId];
    if (store.slug) agentIdentifiers.push(String(store.slug));
    if (inputParam && !agentIdentifiers.includes(inputParam)) agentIdentifiers.push(inputParam);

    const [ownerResult, catalogResult, productsResult, pricingResult, agentPricesResult] = await Promise.all([
      admin.from('agents').select('full_name, agent_code').eq('id', ownerId).maybeSingle(),
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
      admin.from('agent_prices')
        .select('agent_id, network, package_id, custom_price')
        .in('agent_id', agentIdentifiers),
    ]);

    // Add agent_code to identifiers after we have the agent row, then re-query
    // agent_prices for the code-keyed rows if the code was not already included.
    const agentCode = ownerResult.data?.agent_code ? String(ownerResult.data.agent_code) : null;
    let extraAgentPrices: { agent_id: string; network: string; package_id: string; custom_price: number }[] = [];
    if (agentCode && !agentIdentifiers.includes(agentCode)) {
      const { data: codePrices } = await admin
        .from('agent_prices')
        .select('agent_id, network, package_id, custom_price')
        .eq('agent_id', agentCode);
      extraAgentPrices = (codePrices ?? []) as typeof extraAgentPrices;
    }

    if (catalogResult.error) throw catalogResult.error;

    // Load owner custom prices from agent_pricing table
    const customPrices = new Map<string, number>();
    for (const row of (pricingResult.data ?? []) as { pricing_key: string; price: number }[]) {
      const value = Number(row.price);
      if (Number.isFinite(value) && value > 0) {
        customPrices.set(String(row.pricing_key).toLowerCase(), value);
      }
    }

    // Load custom prices from agent_prices table (includes UUID-keyed + slug-keyed rows)
    // Also merge any extra rows found via agent_code lookup.
    const allAgentPriceRows = [
      ...(agentPricesResult.data ?? []),
      ...extraAgentPrices,
    ] as { agent_id: string; network: string; package_id: string; custom_price: number }[];

    for (const row of allAgentPriceRows) {
      const value = Number(row.custom_price);
      if (Number.isFinite(value) && value > 0) {
        // Store under multiple key formats so the bundle-mapping lookup finds it
        // regardless of whether it uses keyGb ('price_mtn_1gb'), keyMb, or keyId.
        const net = String(row.network).toLowerCase();    // e.g. 'mtn', 'telecel', 'airteltigo'
        const pkg = String(row.package_id).toLowerCase(); // e.g. '1gb', '5gb'
        customPrices.set(`price_${net}_${pkg}`, value);
        customPrices.set(`${net}_${pkg}`, value);
        customPrices.set(`${net}-${pkg}`, value);
        customPrices.set(pkg, value);
      }
    }

    // Load per-store overrides from store_products table
    const overrides = new Map<string, { price: number; enabled: boolean }>();
    for (const row of (productsResult.data ?? []) as { product_ref: string; price: number; is_enabled: boolean }[]) {
      overrides.set(String(row.product_ref).toLowerCase(), {
        price: Number(row.price),
        enabled: row.is_enabled !== false,
      });
    }

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

    // Map each bundle to the agent's custom price, falling back to base catalog price
    const priced = bundles
      .map((bundle) => {
        const network = String(bundle.network).toLowerCase();
        const volumeInMB = Number(bundle.volume_mb);
        const catalogPrice = Number(bundle.price);
        const bId = String(bundle.bundle_id).toLowerCase();

        const gb = volumeInMB / 1024;
        const keyGb = Number.isInteger(gb) && gb > 0 ? `price_${network}_${gb}gb` : '';
        const keyMb = `price_${network}_${volumeInMB}mb`;
        const keyId = `price_${bId.replace(/[- ]+/g, '_')}`;
        const keyBare = bId;
        const refDashed = keyGb ? keyGb.replace(/^price_/, '').replace(/_/g, '-') : '';

        const override = overrides.get(bId) || (refDashed ? overrides.get(refDashed) : undefined) || overrides.get(bId.replace(/_/g, '-'));
        if (override && !override.enabled) return null;

        // Give priority to custom prices configured by the agent
        const custom = (keyGb && customPrices.get(keyGb)) ||
                       customPrices.get(keyMb) ||
                       customPrices.get(keyId) ||
                       customPrices.get(keyBare) ||
                       (refDashed && customPrices.get(refDashed));

        const price = (custom !== undefined && custom > 0)
          ? custom
          : (override?.price && override.price > 0 ? override.price : catalogPrice);

        return {
          bundleId: String(bundle.bundle_id),
          network: network as DataNetwork,
          title: String(bundle.title),
          validity: bundle.validity ? String(bundle.validity) : null,
          volumeMb: volumeInMB,
          basePrice: catalogPrice,
          price: Math.round(price * 100) / 100,
          isCustomPrice: (custom !== undefined && custom > 0) || (override?.price !== undefined && override.price > 0),
        };
      })
      .filter((bundle): bundle is NonNullable<typeof bundle> => bundle !== null);

    const networks = DATA_NETWORKS
      .map((network) => ({ network, bundles: priced.filter((b) => b.network === network) }))
      .filter((group) => group.bundles.length > 0);

    const rawOwnerName = ownerResult.data?.full_name ? String(ownerResult.data.full_name).trim() : '';

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
        agentId: ownerId,
      },
      ownerName: rawOwnerName || 'Skaitech Agent',
      hasAgentParam: !!inputParam,
      networks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load this store.';
    console.error('get-store failed:', message);
    return json({ error: 'Unable to load this store right now. Please try again.' }, 500);
  }
});
