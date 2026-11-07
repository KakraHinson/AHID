import { adminClient, corsPreflight, json } from '../_shared/supabase.ts';

/** Public, server-owned catalogue for the guest Standard Data checkout. */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const admin = adminClient();
    const [catalogRes, pricesRes] = await Promise.all([
      admin
        .from('bundle_catalog')
        .select('bundle_id, network, title, validity, volume_mb, price, active, sort_order')
        .eq('active', true)
        .order('network')
        .order('sort_order')
        .order('volume_mb'),
      admin
        .from('non_agent_data_prices')
        .select('bundle_id, price_override, active, updated_at'),
    ]);

    if (catalogRes.error) throw catalogRes.error;
    if (pricesRes.error) throw pricesRes.error;

    const overrides = new Map((pricesRes.data || []).map((row) => [String(row.bundle_id), row]));
    const bundles = (catalogRes.data || [])
      .map((row) => {
        const control = overrides.get(String(row.bundle_id));
        const price = control?.price_override == null
          ? Number(row.price)
          : Number(control.price_override);
        return {
          bundleId: String(row.bundle_id),
          network: String(row.network),
          title: String(row.title || row.bundle_id),
          validity: row.validity ? String(row.validity) : null,
          volumeMb: Number(row.volume_mb),
          agentPrice: Number(row.price),
          price,
          active: control?.active !== false,
          updatedAt: control?.updated_at || null,
        };
      })
      .filter((row) => row.active && Number.isInteger(row.volumeMb) && row.volumeMb > 0 && Number.isFinite(row.price) && row.price > 0);

    return json({ success: true, bundles });
  } catch (error) {
    console.error('public-data-catalog failed:', error);
    return json({ error: 'Unable to load data bundles right now. Please try again.' }, 500);
  }
});
