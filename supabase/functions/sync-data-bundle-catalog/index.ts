import { adminClient, corsPreflight, json, requireAdmin } from '../_shared/supabase.ts';
import { fetchGrandTechPackages, normalizeDataNetwork } from '../_shared/grandtechDataProvider.ts';
import { fetchSwiftPackages, swiftPackageVolumeInMB } from '../_shared/swiftProvider.ts';
import { providerForBundle } from '../_shared/dataProvider.ts';
import {
  DATA_NETWORKS,
  SALE_CATALOG,
  bundleIdFor,
  catalogPrice,
  formatBundleVolume,
  type DataNetwork,
} from '../_shared/dataCatalog.ts';

/**
 * Rebuilds bundle_catalog from what the provider can actually deliver.
 *
 * A bundle is sellable only when both sides agree: the provider has a package
 * for that network + volume, and we have a sale price for it. Rows that fail
 * either test are deactivated rather than deleted, so an order that referenced
 * the bundle still resolves, and so the reason it went away is inspectable.
 *
 * This is the reason the storefront cannot sell an undeliverable bundle: the
 * list the client renders comes from this table, and this table is only ever
 * populated from a real provider response.
 *
 * Admin only. It writes the catalog every other purchase path trusts.
 */
Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return corsPreflight();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const { admin } = await requireAdmin(request);

    const [grandTechPackages, swiftPackages] = await Promise.all([
      fetchGrandTechPackages(),
      fetchSwiftPackages(),
    ]);

    // Build a catalog from the provider assigned to each tier. GrandTech is
    // used only for MTN 1GB and Telecel 5GB; all remaining tiers use Swift.
    const chosen = new Map<string, { packageId: string; cost: number }>();
    for (const pkg of grandTechPackages) {
      if (pkg.soldOut) continue;
      const network = String(pkg.network || '').toLowerCase() as DataNetwork;
      if (!DATA_NETWORKS.includes(network)) continue;
      const volumeInMB = Math.round(pkg.sizeGb * 1024);
      if (volumeInMB < 1024) continue;
      if (providerForBundle(network, volumeInMB) !== 'grandtech') continue;
      if (!Number.isFinite(volumeInMB) || volumeInMB <= 0) continue;
      // Only sizes that map to a whole number of MB can be sold, because that
      // is the unit volume_mb and the order path are both denominated in.
      if (Math.abs(pkg.sizeGb * 1024 - volumeInMB) > 0.000001) continue;
      if (catalogPrice(network, volumeInMB) === null) continue;

      const key = `${network}:${volumeInMB}`;
      const current = chosen.get(key);
      if (!current || pkg.priceGhs < current.cost) {
        chosen.set(key, { packageId: pkg.id, cost: pkg.priceGhs });
      }
    }

    for (const pkg of swiftPackages) {
      const networkName = String(pkg.network || '').trim().toLowerCase();
      const namedNetwork = String(pkg.name || '').match(/\b(mtn|telecel|airteltigo|at)\b/i)?.[1]?.toLowerCase();
      const network = (networkName === 'at' ? 'airteltigo' : networkName || (namedNetwork === 'at' ? 'airteltigo' : namedNetwork)) as DataNetwork;
      if (!DATA_NETWORKS.includes(network)) continue;
      const volumeInMB = swiftPackageVolumeInMB(pkg.name);
      if (volumeInMB === null) continue;
      if (!Number.isFinite(volumeInMB) || volumeInMB < 1024 || providerForBundle(network, volumeInMB) !== 'swift') continue;
      if (catalogPrice(network, volumeInMB) === null) continue;
      const cost = Number(pkg.price);
      if (!Number.isFinite(cost) || cost <= 0) continue;
      const key = `${network}:${volumeInMB}`;
      const current = chosen.get(key);
      if (!current || cost < current.cost) chosen.set(key, { packageId: pkg.id, cost });
    }

    // Provider synchronization may run after an admin changes a sale price.
    // Keep those persisted prices; this job owns availability/provider cost,
    // not the selling price controlled in the admin portal.
    const { data: existingCatalogRows, error: existingCatalogError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, price');
    if (existingCatalogError) throw existingCatalogError;
    const configuredPrices = new Map(
      (existingCatalogRows || [])
        .map((row) => [String(row.bundle_id), Number(row.price)] as const)
        .filter(([, price]) => Number.isFinite(price) && price > 0),
    );

    const sellableBundleIds = new Set<string>();
    const upserts: Record<string, unknown>[] = [];
    let sortOrder = 0;

    for (const network of DATA_NETWORKS) {
      // Ascending by volume so the storefront reads smallest-first.
      const volumes = Object.keys(SALE_CATALOG[network])
        .map(Number)
        .sort((a, b) => a - b);

      for (const volumeInMB of volumes) {
        if (volumeInMB < 1024) continue;
        const match = chosen.get(`${network}:${volumeInMB}`);
        const bundleId = bundleIdFor(network, volumeInMB);
        const price = catalogPrice(network, volumeInMB);
        if (price === null) continue;
        const salePrice = configuredPrices.get(bundleId) ?? price;

        if (!match) {
          // We sell this size on paper but the provider cannot deliver it, so it
          // must not be offered. Recorded rather than silently dropped.
          await admin.from('bundle_catalog').upsert({
            bundle_id: bundleId,
            network,
            title: `${formatBundleVolume(volumeInMB)} ${normalizeDataNetwork(network)}`,
            volume_mb: volumeInMB,
            price: salePrice,
            active: false,
            inactive_reason: 'Provider has no sellable package for this network and size.',
            sort_order: sortOrder++,
          }, { onConflict: 'bundle_id' });
          continue;
        }

        sellableBundleIds.add(bundleId);
        upserts.push({
          bundle_id: bundleId,
          network,
          title: `${formatBundleVolume(volumeInMB)} ${normalizeDataNetwork(network)}`,
          validity: null,
          volume_mb: volumeInMB,
          price: salePrice,
          provider_package_id: match.packageId,
          provider_cost: match.cost,
          active: true,
          inactive_reason: null,
          sort_order: sortOrder++,
        });
      }
    }

    if (upserts.length) {
      const { error } = await admin.from('bundle_catalog').upsert(upserts, { onConflict: 'bundle_id' });
      if (error) throw error;
    }

    // Anything previously active that this run did not confirm sellable is now
    // stale: the provider dropped it, capped it, or it was never deliverable.
    const { data: existing, error: readError } = await admin
      .from('bundle_catalog')
      .select('bundle_id')
      .eq('active', true);
    if (readError) throw readError;

    const stale = (existing ?? [])
      .map((row) => String(row.bundle_id))
      .filter((bundleId) => !sellableBundleIds.has(bundleId));

    if (stale.length) {
      const { error } = await admin
        .from('bundle_catalog')
        .update({ active: false, inactive_reason: 'No longer confirmed sellable by the provider catalog.' })
        .in('bundle_id', stale);
      if (error) throw error;
    }

    const { data: finalRows, error: finalError } = await admin
      .from('bundle_catalog')
      .select('bundle_id, network, title, validity, volume_mb, price, active, inactive_reason, sort_order')
      .order('sort_order', { ascending: true });
    if (finalError) throw finalError;

    // Best-effort trail. A failure to log must not fail the sync, but the
    // builder is not a real Promise, so it cannot be caught with .catch().
    try {
      await admin.rpc('log_activity', {
        p_summary: `Synced data bundle catalog: ${upserts.length} sellable, ${stale.length} deactivated`,
        p_meta: {
          sellable: upserts.length,
          deactivated: stale.length,
          providerPackages: grandTechPackages.length + swiftPackages.length,
        },
        p_actor_user_id: null,
      });
    } catch (logError) {
      console.warn('Could not record the catalog sync in activity_log:', logError);
    }

    return json({
      success: true,
      providerPackages: grandTechPackages.length + swiftPackages.length,
      sellable: upserts.length,
      deactivated: stale.length,
      bundles: finalRows ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to sync the bundle catalog.';
    const status = /authentication is required|session is invalid/i.test(message)
      ? 401
      : /administrator access is required/i.test(message)
        ? 403
        : 502;
    return json({ error: message }, status);
  }
});
