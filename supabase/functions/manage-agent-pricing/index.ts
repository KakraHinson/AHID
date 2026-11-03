import { adminClient, corsPreflight, json, requireAgent } from '../_shared/supabase.ts';

// Reserved pricing_key holding the percent of their commission profit an agent
// chooses to share with customers on their storefront.
const DISCOUNT_KEY = 'customer_discount_percent';

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();

  try {
    const { admin, user } = await requireAgent(request);

    if (request.method === 'GET') {
      const { data, error } = await admin
        .from('agent_pricing')
        .select('pricing_key, price, updated_at')
        .eq('agent_id', user.id);

      if (error) throw error;
      const prices: Record<string, number> = {};
      let discountPercent = 0;
      (data || []).forEach((row: { pricing_key: string; price: number }) => {
        if (row.pricing_key === DISCOUNT_KEY) {
          const value = Number(row.price);
          if (Number.isFinite(value)) discountPercent = Math.min(Math.max(value, 0), 100);
        } else {
          prices[row.pricing_key] = Number(row.price);
        }
      });

      // Also merge any prices from agent_prices table
      try {
        const { data: apData } = await admin
          .from('agent_prices')
          .select('network, package_id, custom_price')
          .eq('agent_id', user.id);

        (apData || []).forEach((row: { network: string; package_id: string; custom_price: number }) => {
          const net = String(row.network).toLowerCase();
          const pkg = String(row.package_id).toLowerCase();
          const key = `price_${net}_${pkg}`;
          if (prices[key] === undefined) {
            prices[key] = Number(row.custom_price);
          }
        });
      } catch (apErr) {
        console.warn('agent_prices merge notice:', apErr);
      }

      return json({ prices, discountPercent });
    }

    if (request.method === 'POST') {
      const body = await request.json();
      const prices = body.prices;
      const hasPrices = prices && typeof prices === 'object';
      const rawDiscount = body.discountPercent;
      const hasDiscount = rawDiscount !== undefined && rawDiscount !== null && rawDiscount !== '';

      if (!hasPrices && !hasDiscount) {
        return json({ error: 'Invalid pricing payload.' }, 400);
      }

      const rowsToUpsert = hasPrices
        ? Object.entries(prices)
          .filter(([key, val]) => typeof key === 'string' && key.startsWith('price_') && Number.isFinite(Number(val)) && Number(val) >= 0)
          .map(([key, val]) => ({
            agent_id: user.id,
            pricing_key: key,
            price: Math.round(Number(val) * 100) / 100,
            updated_at: new Date().toISOString(),
          }))
        : [];

      if (hasDiscount) {
        const percent = Number(rawDiscount);
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          return json({ error: 'Discount percent must be between 0 and 100.' }, 400);
        }
        rowsToUpsert.push({
          agent_id: user.id,
          pricing_key: DISCOUNT_KEY,
          price: Math.round(percent * 100) / 100,
          updated_at: new Date().toISOString(),
        });
      }

      if (rowsToUpsert.length === 0) {
        return json({ error: 'No valid prices provided to update.' }, 400);
      }

      const { error: upsertError } = await admin
        .from('agent_pricing')
        .upsert(rowsToUpsert, { onConflict: 'agent_id,pricing_key' });

      if (upsertError) throw upsertError;

      // Ensure store exists and sync to store_products table for this agent's store.
      // This block is best-effort: a failure here must not prevent agent_prices
      // from being written (which is handled in the separate block below).
      let storeSlug: string | null = null;
      let storeId: string | null = null;
      try {
        const { data: store } = await admin
          .from('agent_stores')
          .select('id, slug')
          .eq('agent_id', user.id)
          .maybeSingle();

        if (store?.id) {
          storeId = store.id;
          storeSlug = store.slug;
        } else {
          // Idempotently create store row for this agent
          const { data: createdId } = await admin.rpc('ensure_agent_store', { p_agent_id: user.id });
          if (createdId) storeId = createdId;
          const { data: freshStore } = await admin
            .from('agent_stores')
            .select('id, slug')
            .eq('agent_id', user.id)
            .maybeSingle();
          storeId = freshStore?.id || storeId;
          storeSlug = freshStore?.slug || null;
        }

        if (storeId && hasPrices) {
          const storeProductRows = Object.entries(prices)
            .filter(([key, val]) => typeof key === 'string' && key.startsWith('price_') && Number.isFinite(Number(val)) && Number(val) > 0)
            .map(([key, val]) => ({
              store_id: storeId,
              product_type: 'data_bundle',
              product_ref: key.replace(/^price_/, '').replace(/_/g, '-'),
              price: Math.round(Number(val) * 100) / 100,
              is_enabled: true,
              updated_at: new Date().toISOString(),
            }));

          if (storeProductRows.length > 0) {
            await admin
              .from('store_products')
              .upsert(storeProductRows, { onConflict: 'store_id,product_type,product_ref' });
          }
        }
      } catch (storeProdErr) {
        console.warn('store_products sync warning:', storeProdErr);
      }

      // Sync to agent_prices table (primary table read by the public storefront).
      // Intentionally OUTSIDE the store-lookup try/catch above so that a store
      // provisioning error never prevents custom prices from reaching the storefront.
      if (hasPrices) {
        try {
          const agentPricesRows = Object.entries(prices)
            .filter(([key, val]) => typeof key === 'string' && key.startsWith('price_') && Number.isFinite(Number(val)) && Number(val) >= 0)
            .map(([key, val]) => {
              const match = key.match(/^price_([a-z]+)_(.+)$/i);
              if (!match) return null;
              let net = match[1].toLowerCase();
              // Normalize to the canonical network casing stored in agent_prices
              if (net === 'mtn') net = 'MTN';
              else if (net === 'telecel') net = 'Telecel';
              else if (net === 'airteltigo') net = 'AirtelTigo';
              else net = net.toUpperCase();
              // Package IDs are stored uppercase (e.g. '1GB', '5GB')
              const pkg = match[2].toUpperCase();
              return {
                agent_id: user.id,
                network: net,
                package_id: pkg,
                custom_price: Math.round(Number(val) * 100) / 100,
                updated_at: new Date().toISOString(),
              };
            })
            .filter((row): row is NonNullable<typeof row> => row !== null);

          if (agentPricesRows.length > 0) {
            const { error: apUpsertErr } = await admin
              .from('agent_prices')
              .upsert(agentPricesRows, { onConflict: 'agent_id,network,package_id' });

            if (apUpsertErr) {
              console.error('agent_prices upsert error (by UUID):', apUpsertErr);
            }

            // Mirror rows keyed by store slug so that slug-based storefront
            // lookups (where the visitor arrives via ?agent=my-slug) also find
            // the custom prices in agent_prices.
            if (storeSlug) {
              const slugRows = agentPricesRows.map(r => ({ ...r, agent_id: storeSlug as string }));
              const { error: slugErr } = await admin
                .from('agent_prices')
                .upsert(slugRows, { onConflict: 'agent_id,network,package_id' });
              if (slugErr) {
                console.warn('agent_prices upsert error (by slug):', slugErr);
              }
            }
          }
        } catch (agentPricesErr) {
          // Non-fatal – log and continue so the HTTP response is always 200
          console.error('agent_prices sync error:', agentPricesErr);
        }
      }

      return json({ success: true, count: rowsToUpsert.length, storeId, slug: storeSlug });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('manage-agent-pricing error:', error);
    const message = error instanceof Error ? error.message : 'Unable to process agent pricing request.';
    const status = /authentication is required|session is invalid|sign in/i.test(message)
      ? 401
      : /agent account required|verified/i.test(message)
        ? 403
        : 500;
    return json({ error: message }, status);
  }
});
