/**
 * Data bundle provider facade. GrandTech fulfills MTN 1GB and Telecel 5GB;
 * Swift fulfills every other bundle. Package IDs and provider costs come from
 * the active provider-confirmed bundle catalog used by the storefront.
 */

import { buySwiftPackage, resolveSwiftPackage, fetchSwiftOrderStatus } from './swiftProvider.ts';
import {
  buyGrandTechPackage,
  fetchGrandTechOrderStatus,
  resolveGrandTechPackage,
  type GrandTechOrderState,
} from './grandtechDataProvider.ts';
import { friendlyProviderMessage } from './providerMessages.ts';

export type DataProviderName = 'grandtech' | 'swift';

export interface ResolvedDataPackage {
  provider: DataProviderName;
  id: string;
  /** What the provider charges us, in GHS. Used for margin reporting. */
  costGhs: number;
  raw: { id: string; price: string | number };
}

export interface DataBuyResult {
  success: boolean;
  /**
   * `'unknown'` when the bundle could not be resolved to any provider package,
   * so nothing was dispatched and no provider actually handled the order.
   */
  provider: DataProviderName | 'unknown';
  orderId?: string;
  /** Mirrors the provider's own status wording where it gives us one. */
  status?: string;
  payload: Record<string, unknown>;
  failureReason?: string;
}

/** GrandTech's only designated sellable bundles; all other tiers use Swift. */
export function providerForBundle(networkType: string, volumeInMB: number): DataProviderName {
  const network = String(networkType || '').trim().toLowerCase();
  if ((network === 'mtn' && volumeInMB === 1024) ||
      (network === 'telecel' && volumeInMB === 5120)) return 'grandtech';
  return 'swift';
}

/** Provider fallback for legacy orders whose provider was not saved. */
export function activeDataProvider(networkType?: string, volumeInMB?: number): DataProviderName {
  if (networkType && Number.isFinite(volumeInMB)) {
    return providerForBundle(networkType, Number(volumeInMB));
  }
  return 'swift';
}

/**
 * Resolves the provider package from the provider's live catalog. MTN 1GB and
 * Telecel 5GB are GrandTech-only; every other Data Bundle package is resolved
 * from Swift. bundle_catalog remains the storefront's sale-price catalog, but
 * a stale provider mapping there must not block a package the assigned provider
 * currently offers (or send it to the wrong provider).
 */
export async function resolveDataPackage(
  networkType: string,
  volumeInMB: number,
): Promise<ResolvedDataPackage | null> {
  const network = String(networkType || '').trim().toLowerCase();
  const provider = providerForBundle(network, volumeInMB);
  if (provider === 'grandtech') {
    const pkg = await resolveGrandTechPackage(network, volumeInMB);
    if (!pkg) return null;
    return { provider, id: pkg.id, costGhs: pkg.priceGhs, raw: { id: pkg.id, price: pkg.priceGhs } };
  }

  // All other Data Bundle tiers and the small Instant Data tiers use Swift.
  if (provider === 'swift') {
    const pkg = await resolveSwiftPackage(network, volumeInMB);
    if (!pkg) return null;
    return { provider: 'swift', id: pkg.id, costGhs: Number(pkg.price), raw: { id: pkg.id, price: pkg.price } };
  }
  return null;
}
export async function buyDataPackage(
  resolved: ResolvedDataPackage,
  networkType: string,
  phone: string,
): Promise<DataBuyResult> {
  if (resolved.provider === 'grandtech') {
    const result = await buyGrandTechPackage(resolved.id, phone, networkType);
    return {
      success: result.success,
      provider: 'grandtech',
      orderId: result.orderId,
      // GrandTechHub accepting the order only means it reserved the balance. The
      // bundle is delivered later, so the order stays in 'processing' until a
      // status poll (or a callback) confirms the outcome.
      status: result.success ? 'processing' : 'failed',
      payload: result.payload,
      failureReason: result.failureReason && !result.success
        ? friendlyProviderMessage(result.failureReason, networkType)
        : result.failureReason,
    };
  }

  const result = await buySwiftPackage(resolved.id, phone);
  return {
    success: result.success,
    provider: 'swift',
    orderId: result.orderId,
    status: result.status,
    payload: result.payload,
    failureReason: result.failureReason && !result.success
      ? friendlyProviderMessage(result.failureReason, networkType)
      : result.failureReason,
  };
}

/**
 * Live delivery status for an order we already placed. Returns null when the
 * provider cannot be consulted, which callers must treat as "still unknown"
 * rather than as a failure.
 */
export async function fetchDataOrderStatus(
  provider: DataProviderName,
  providerOrderId: string,
  reference?: string,
): Promise<{ state: GrandTechOrderState; status: string; payload?: Record<string, unknown> } | null> {
  if (provider === 'grandtech') {
    const result = await fetchGrandTechOrderStatus(providerOrderId);
    return result ? { state: result.state, status: result.status } : null;
  }
  if (provider === 'swift') {
    const result = await fetchSwiftOrderStatus(providerOrderId || reference || '');
    return result ? { state: result.state as GrandTechOrderState, status: result.status, payload: result.payload } : null;
  }
  return null;
}

/**
 * How long an accepted order may sit undelivered before we assume the provider
 * dropped it and refund the customer. Generous, because a late delivery we then
 * refund is a loss, but bounded so nobody is left having paid for nothing.
 */
export function dataOrderStuckMinutes(): number {
  const configured = Number(Deno.env.get('DATA_ORDER_STUCK_MINUTES'));
  return Number.isFinite(configured) && configured > 0 ? configured : 45;
}
