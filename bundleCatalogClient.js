import { supabase } from './supabaseClient.js';

/**
 * Reads the live Standard Data sale catalog directly from Supabase. The edge
 * function remains a compatibility fallback, but agent pages should not rely
 * on a cached function response to display an admin price edit.
 */
export async function fetchStandardBundleCatalog() {
  const direct = await supabase
    .from('bundle_catalog')
    .select('bundle_id, network, title, validity, volume_mb, price')
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (!direct.error && Array.isArray(direct.data) && direct.data.length) {
    return normalizeRows(direct.data);
  }

  const fallback = await supabase.functions.invoke('list-data-bundles');
  if (fallback.error) {
    throw fallback.error;
  }
  if (fallback.data?.error) {
    throw new Error(String(fallback.data.error));
  }

  return (Array.isArray(fallback.data?.networks) ? fallback.data.networks : []).map((group) => ({
    network: String(group.network || '').toLowerCase(),
    bundles: (Array.isArray(group.bundles) ? group.bundles : []).map((bundle) => ({
      bundleId: String(bundle.bundleId),
      title: String(bundle.title),
      validity: bundle.validity ? String(bundle.validity) : null,
      volumeMb: Number(bundle.volumeMb),
      price: Number(bundle.price),
    })),
  }));
}

function normalizeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const network = String(row.network || '').toLowerCase();
    if (!groups.has(network)) groups.set(network, []);
    groups.get(network).push({
      bundleId: String(row.bundle_id),
      title: String(row.title),
      validity: row.validity ? String(row.validity) : null,
      volumeMb: Number(row.volume_mb),
      price: Number(row.price),
    });
  }
  return [...groups.entries()].map(([network, bundles]) => ({ network, bundles }));
}
