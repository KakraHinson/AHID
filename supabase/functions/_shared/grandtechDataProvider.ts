/**
 * Data Bundle Provider Integration for Skaitech Ghana
 * Provider: GrandTechHub Reseller API
 *
 * Catalog:  GET  https://backend.grandtechub.cloud/api/packages
 *             - payload: [{ id, size, network, price, type }]
 *             - `size` is in GB, `price` is in pesewas (400 => GHS 4.00)
 *             - `network` is one of MTN, TELECEL, AIRTELTIGO_ISHARE,
 *               AIRTELTIGO_BIGTIME, or legacy AIRTELTIGO
 * Purchase: POST https://backend.grandtechub.cloud/api/orders
 *             - body: { packages: [{ network, packageId, phone }] }
 *             - auth: x-api-key: <GRANDTECH_API_KEY>
 *
 * Orders are accepted asynchronously: a 201 means the provider took the order
 * and reserved the balance, not that the bundle has already landed. The
 * provider can POST a status update to the `callback` we send with the order.
 */

import { grandtechApiKey } from './afaProvider.ts';

const GRANDTECH_DEFAULT_BASE = 'https://backend.grandtechub.cloud';

export interface GrandTechPackage {
  id: string;
  sizeGb: number;
  priceGhs: number;
  providerNetwork: string;
  network: string;
  /** Units already sold, or null when the provider does not track it. */
  sales: number | null;
  /** Sales cap, or null when unlimited. */
  limit: number | null;
  /**
   * True when the package exists but has hit its sales cap. The order endpoint
   * still accepts these, so relying on acceptance to detect them means
   * charging customers for bundles that never arrive.
   */
  soldOut: boolean;
}

export interface GrandTechBuyResult {
  success: boolean;
  orderId?: string;
  totalPrice?: number;
  payload: Record<string, unknown>;
  failureReason?: string;
}

/**
 * Strips everything we do not need out of a provider response before it is
 * logged or written to the database.
 *
 * The GrandTechHub order endpoint echoes the reseller account itself back in an
 * `identity` object, which includes the API key and a password hash. Persisting
 * or logging the raw response would copy those secrets into every row of
 * public_data_orders / agent_data_orders, so only known-safe fields are kept.
 */
export function sanitizeGrandTechPayload(
  payload: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const source = payload && typeof payload === 'object' ? payload : {};
  const safe: Record<string, unknown> = {};

  for (const key of ['orderId', 'totalPrice', 'status', 'createdAt', 'message', 'error']) {
    const value = source[key];
    if (value !== undefined && value !== null) safe[key] = value;
  }

  if (Array.isArray(source.packages)) {
    safe.packages = (source.packages as Record<string, unknown>[]).map((pkg) => {
      const entry: Record<string, unknown> = {};
      for (const key of ['network', 'packageId', 'size', 'price', 'status']) {
        const value = pkg?.[key];
        if (value !== undefined && value !== null) entry[key] = value;
      }
      return entry;
    });
  }

  return safe;
}

export function grandtechDataBaseUrl(): string {
  const explicit = Deno.env.get('GRANDTECH_DATA_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  return GRANDTECH_DEFAULT_BASE;
}

/**
 * GrandTechHub uses its own network codes. Note AIRTELTIGO_ISHARE (daily
 * bundle) and AIRTELTIGO_BIGTIME (monthly "BigTime") are separate products,
 * so a bare AIRTELTIGO is treated as the legacy code and is not auto-matched.
 */
const NETWORK_MAP: Record<string, string> = {
  mtn: 'MTN',
  telecel: 'TELECEL',
  airteltigo: 'AIRTELTIGO_ISHARE',
  airteltigo_ishare: 'AIRTELTIGO_ISHARE',
  at: 'AIRTELTIGO_ISHARE',
  airteltigo_bigtime: 'AIRTELTIGO_BIGTIME',
  bigtime: 'AIRTELTIGO_BIGTIME',
};

export function normalizeDataNetwork(networkType: string): string {
  const key = String(networkType || '').trim().toLowerCase();
  return NETWORK_MAP[key] || key.toUpperCase();
}

/**
 * Catalog responses have appeared with both numeric sizes and display strings
 * such as "1GB" / "1 GB". Normalize those representations without guessing a
 * different unit: bundles expressed in MB must be explicitly marked as MB.
 */
function parsePackageSizeGb(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string') return null;

  const normalized = value.trim().replace(/,/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(gb|g|mb)?$/i);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] || 'gb').toLowerCase();
  return unit === 'mb' ? amount / 1024 : amount;
}

/**
 * Optional endpoint the provider POSTs order status updates to.
 *
 * Left unset by default: the provider's order-status callback payload is not
 * documented, so sending a URL we cannot yet handle would just produce 404s.
 * Set GRANDTECH_DATA_CALLBACK once the data-order-webhook function exists.
 */
export function grandtechOrderCallbackUrl(): string | null {
  const explicit = Deno.env.get('GRANDTECH_DATA_CALLBACK');
  return explicit ? explicit : null;
}

/**
 * Lists the packages the GrandTechHub account is allowed to sell. These IDs are
 * what the order endpoint validates against, so the catalog here is also the
 * guard against offering a size the provider cannot actually deliver.
 */
export async function fetchGrandTechPackages(): Promise<GrandTechPackage[]> {
  const response = await fetch(`${grandtechDataBaseUrl()}/api/packages`, {
    headers: {
      'x-api-key': grandtechApiKey(),
      Accept: 'application/json',
    },
  });

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || !Array.isArray(payload?.payload)) {
    console.error('GrandTechHub catalog fetch failed:', payload);
    throw new Error('Unable to fetch the data bundle catalog.');
  }

  return (payload.payload as Record<string, unknown>[])
    .map((pkg) => {
      const providerNetwork = String(pkg.network || '').trim().toUpperCase();
      const priceGhs = Number(pkg.price) / 100;
      const sizeGb = parsePackageSizeGb(pkg.size);
      if (!pkg.id || !providerNetwork || !Number.isFinite(priceGhs) || sizeGb === null) {
        return null;
      }
      // Number(null) is 0, so null has to be ruled out before coercing or every
      // uncapped package would look like it had hit a limit of zero.
      const sales = pkg.sales === null || pkg.sales === undefined
        ? null
        : (Number.isFinite(Number(pkg.sales)) ? Number(pkg.sales) : null);
      const limit = pkg.limit === null || pkg.limit === undefined
        ? null
        : (Number.isFinite(Number(pkg.limit)) ? Number(pkg.limit) : null);
      const limitNum = limit === null ? null : Number(limit);
      const salesNum = sales === null ? null : Number(sales);
      const soldOut = limitNum !== null && salesNum !== null && limitNum > 0 && salesNum >= limitNum;
      return {
        id: String(pkg.id),
        sizeGb,
        priceGhs: Math.round(priceGhs * 100) / 100,
        providerNetwork,
        network: providerNetwork.toLowerCase(),
        sales,
        limit,
        soldOut,
      } satisfies GrandTechPackage;
    })
    .filter((pkg): pkg is GrandTechPackage => pkg !== null);
}

/**
 * Finds the provider package for a network + volume, or null when the provider
 * cannot actually deliver it - either because the size does not exist or
 * because it has hit its sales cap. A null result must abort the order and
 * refund the wallet.
 */
export async function resolveGrandTechPackage(
  networkType: string,
  volumeInMB: number,
): Promise<GrandTechPackage | null> {
  const packages = await fetchGrandTechPackages();
  const providerNetwork = normalizeDataNetwork(networkType);
  const sizeGb = volumeInMB / 1024;

  const matches = packages
    .filter((pkg) => pkg.providerNetwork === providerNetwork && Math.abs(pkg.sizeGb - sizeGb) < 0.000001 && !pkg.soldOut)
    .sort((a, b) => a.priceGhs - b.priceGhs);

  return matches[0] ?? null;
}

/** Provider order status vocabulary, mapped onto our own states. */
export type GrandTechOrderState = 'successful' | 'failed' | 'cancelled' | 'processing';

const SUCCESSFUL_STATES = new Set(['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'DELIVERED', 'FULFILLED', 'DONE', 'PASSED', 'PROCESSED', 'APPROVED', 'SENT']);
const FAILED_STATES = new Set(['FAILED', 'FAILURE', 'REJECTED', 'EXPIRED', 'DECLINED', 'ERROR', 'UNFULFILLED']);
const CANCELLED_STATES = new Set(['CANCELLED', 'CANCELED']);

export function mapGrandTechOrderState(status: string): GrandTechOrderState {
  const normalized = String(status || '').trim().toUpperCase();
  if (SUCCESSFUL_STATES.has(normalized)) return 'successful';
  if (CANCELLED_STATES.has(normalized)) return 'cancelled';
  if (FAILED_STATES.has(normalized)) return 'failed';
  return 'processing';
}

function resolveGrandTechMatchState(match: Record<string, unknown>): { state: GrandTechOrderState; status: string; createdAt: string | null } {
  const packages = Array.isArray(match.packages) ? match.packages as Record<string, unknown>[] : [];
  const packageStatuses = packages.map((p) => String(p.status ?? ''));
  const orderRawStatus = String(match.status ?? '').trim();
  const orderState = orderRawStatus ? mapGrandTechOrderState(orderRawStatus) : null;

  let state: GrandTechOrderState = 'processing';
  if (orderState === 'successful') {
    state = 'successful';
  } else if (orderState === 'failed') {
    state = 'failed';
  } else if (orderState === 'cancelled') {
    state = 'cancelled';
  } else if (packageStatuses.length && packageStatuses.every((s) => mapGrandTechOrderState(s) === 'successful')) {
    state = 'successful';
  } else if (packageStatuses.length && packageStatuses.every((s) => mapGrandTechOrderState(s) === 'failed')) {
    state = 'failed';
  } else if (packageStatuses.length && packageStatuses.some((s) => mapGrandTechOrderState(s) === 'successful') && !packageStatuses.some((s) => mapGrandTechOrderState(s) === 'failed')) {
    state = 'successful';
  }

  const statusLabel = orderRawStatus || packageStatuses.join(',') || 'UNKNOWN';
  return {
    state,
    status: statusLabel,
    createdAt: match.createdAt ? String(match.createdAt) : null,
  };
}

/**
 * Reads the live status of a provider order. Checks direct order endpoint,
 * search parameter, and paginated order history against GrandTech.
 */
export async function fetchGrandTechOrderStatus(
  providerOrderId: string,
): Promise<{ state: GrandTechOrderState; status: string; createdAt: string | null; payload?: Record<string, unknown> } | null> {
  if (!providerOrderId) return null;

  const baseUrl = grandtechDataBaseUrl();
  const apiKey = grandtechApiKey();
  const headers = { 'x-api-key': apiKey, Accept: 'application/json' };

  // 1. Direct order lookup
  try {
    const singleRes = await fetch(`${baseUrl}/api/orders/${encodeURIComponent(providerOrderId)}`, { headers });
    if (singleRes.ok) {
      const singleJson = await singleRes.json().catch(() => ({}));
      const candidate = singleJson?.payload || singleJson?.data || singleJson?.order || (singleJson?.orderId ? singleJson : null);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return { ...resolveGrandTechMatchState(candidate as Record<string, unknown>), payload: singleJson as Record<string, unknown> };
      }
    }
  } catch (_e) {
    // Continue to search endpoint
  }

  // 2. Filtered search lookup
  try {
    const searchRes = await fetch(`${baseUrl}/api/orders?search=${encodeURIComponent(providerOrderId)}`, { headers });
    if (searchRes.ok) {
      const searchJson = await searchRes.json().catch(() => ({}));
      const rows = Array.isArray(searchJson?.payload) ? searchJson.payload : Array.isArray(searchJson?.data) ? searchJson.data : null;
      if (rows && rows.length) {
        const found = rows.find((o: Record<string, unknown>) => String(o.orderId ?? o.id ?? '') === String(providerOrderId)) || rows[0];
        if (found) return { ...resolveGrandTechMatchState(found as Record<string, unknown>), payload: searchJson as Record<string, unknown> };
      }
    }
  } catch (_e) {
    // Continue to pagination
  }

  // 3. Walk recent order pages (up to 10 pages)
  let url = `${baseUrl}/api/orders`;
  for (let page = 1; page <= 10; page += 1) {
    try {
      const response = await fetch(`${url}?page=${page}&limit=100`, { headers });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || !Array.isArray(payload?.payload)) break;

      const orders = payload.payload as Record<string, unknown>[];
      const match = orders.find((o) => String(o.orderId ?? o.id ?? '') === String(providerOrderId));
      if (match) {
        return { ...resolveGrandTechMatchState(match), payload };
      }

      const totalPages = Number(payload.totalPages ?? 1);
      if (!Number.isFinite(totalPages) || page >= totalPages) break;
    } catch (_e) {
      break;
    }
  }

  return null;
}

/**
 * Places the order. Never throws on a provider rejection: the caller refunds the
 * wallet when this reports failure.
 */
export async function buyGrandTechPackage(
  packageId: string,
  phone: string,
  networkType: string,
): Promise<GrandTechBuyResult> {
  try {
    const callback = grandtechOrderCallbackUrl();
    const response = await fetch(`${grandtechDataBaseUrl()}/api/orders`, {
      method: 'POST',
      headers: {
        'x-api-key': grandtechApiKey(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        packages: [{
          // The provider resolves the packageId within this network, so it has
          // to be the network the package actually belongs to.
          network: normalizeDataNetwork(networkType),
          packageId,
          phone,
          ...(callback ? { callback } : {}),
          clientReference: `DATA-${Date.now()}`,
        }],
      }),
    });

    const payload = await response.json().catch(() => ({
      raw: 'Invalid provider response',
    })) as Record<string, unknown>;

    const success = response.ok;
    return {
      success,
      orderId: payload.orderId ? String(payload.orderId) : undefined,
      totalPrice: Number.isFinite(Number(payload.totalPrice))
        ? Number(payload.totalPrice)
        : undefined,
      payload: sanitizeGrandTechPayload(payload),
      failureReason: success
        ? undefined
        : String(payload.message || payload.error || 'The data provider declined the order.'),
    };
  } catch (err) {
    return {
      success: false,
      payload: { error: String(err) },
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the data provider.',
    };
  }
}
