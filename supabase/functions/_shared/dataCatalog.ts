/**
 * The sale catalog: what a customer pays for a bundle, per network.
 *
 * This lives here, and only here, because it used to be duplicated. The payment
 * function carried its own copy, and the storefront pages each carried another,
 * so a price could be displayed that was not the price charged. Both sides now
 * import from this module and the served catalog is written from it, which means
 * there is exactly one place to change a price.
 *
 * These are SALE prices in GHS, not provider cost. Provider cost comes from the
 * provider's own catalog at purchase time (see dataProvider.ts) and is never
 * trusted from the client.
 *
 * Validity is deliberately absent. The provider does not expose a duration for
 * these packages, so any "30 days" / "Kokoo" style label would be invented. The
 * bundles are sold as what we can actually prove they are: a volume of data on a
 * network. bundle_catalog.validity stays NULL until a provider tells us
 * otherwise, and the UI renders it only when it is set.
 */

export type DataNetwork = 'mtn' | 'telecel' | 'airteltigo';

export const DATA_NETWORKS: DataNetwork[] = ['mtn', 'telecel', 'airteltigo'];

/**
 * network -> volume in MB -> sale price in GHS.
 *
 * Whole-GB tiers are for the Standard Data Bundle storefront. The legacy
 * small-MB entries remain only for older public/store order compatibility;
 * current Instant Data plans come exclusively from instant_data_bundles and
 * are delivered by Hubtel, never through this catalog.
 */
export const SALE_CATALOG: Record<DataNetwork, Record<number, number>> = {
  mtn: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    1024: 4.3, 2048: 8.8, 3072: 13.2, 4096: 17.6, 5120: 22, 6144: 26.1,
    8192: 34.8, 10240: 42, 15360: 63, 20480: 84, 25600: 103.75,
    30720: 121.5, 40960: 160, 51200: 200,
  },
  telecel: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    5120: 21, 10240: 40, 15360: 60, 20480: 78, 30720: 114, 40960: 151, 51200: 185,
  },
  airteltigo: {
    5: 0.5, 10: 1, 20: 2, 30: 3, 50: 5, 100: 10, 150: 15, 200: 20,
    1024: 4.2, 2048: 8.39, 3072: 12.58, 4096: 16.78, 5120: 20.97,
    6144: 25.17, 7168: 29.36, 8192: 33.56, 10240: 40.84, 15360: 60.71,
  },
};

/**
 * Stable, human-meaningful identifier for a bundle. Used as the primary key of
 * bundle_catalog and as the `bundleId` the client sends at checkout, so the
 * price and volume the customer picked can be resolved server-side instead of
 * being trusted from the request body.
 */
export function bundleIdFor(network: DataNetwork, volumeInMB: number): string {
  const gb = volumeInMB / 1024;
  const suffix = Number.isInteger(gb) ? `${gb}gb` : `${volumeInMB}mb`;
  return `${network}-${suffix}`;
}

/** The volume a bundle_id refers to, or null when the id is not one of ours. */
export function volumeForBundleId(bundleId: string): { network: DataNetwork; volumeInMB: number } | null {
  const match = /^(mtn|telecel|airteltigo)-(\d+(?:\.\d+)?)(gb|mb)$/.exec(String(bundleId || '').trim().toLowerCase());
  if (!match) return null;
  const [, network, amount, unit] = match;
  const volumeInMB = unit === 'gb' ? Math.round(Number(amount) * 1024) : Number(amount);
  if (!Number.isFinite(volumeInMB) || volumeInMB <= 0) return null;
  return { network: network as DataNetwork, volumeInMB };
}

/** Catalog sale price for a network + volume, or null when we do not sell it. */
export function catalogPrice(network: string, volumeInMB: number): number | null {
  const prices = SALE_CATALOG[String(network || '').toLowerCase() as DataNetwork];
  if (!prices) return null;
  const price = prices[volumeInMB];
  return Number.isFinite(price) ? price : null;
}

/** "1GB" / "5GB", used for display wherever a raw MB count would be noise. */
export function formatBundleVolume(volumeInMB: number): string {
  const mb = Number(volumeInMB);
  if (!Number.isFinite(mb) || mb <= 0) return 'Data bundle';
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)}GB`;
  }
  return `${mb}MB`;
}
