/**
 * Data Bundle Provider Integration for Skaitech Ghana
 * Provider: Swift Vendux Reseller API
 *
 * Catalog:  GET  https://swiftvendux.com/api/v1/developer/v1/packages/?network=mtn|telecel|at
 * Purchase: POST https://swiftvendux.com/api/v1/developer/v1/buy/
 *             - body: { package_id, phone, reference }
 *             - auth: Authorization: Bearer <SWIFTVENDUX_API_KEY>
 *
 * Both paths were probed live against the provider. The catalog path only
 * exists with its trailing slash (401 without a key; the un-slashed form is a
 * 301 redirect), and the purchase path is `/v1/buy/`. The old `/buy-data/`
 * path returns HTTP 404, which is why every Swift-fulfilled bundle failed to
 * resolve or buy.
 */

export interface SwiftPackage {
  id: string;
  package_id?: string;
  name: string;
  network: string;
  price: string | number;
  validity?: string;
  category?: string;
  raw?: Record<string, unknown>;
}

export interface SwiftBuyResult {
  success: boolean;
  /** The reference sent to Swift's status endpoint. */
  reference?: string;
  orderId?: string;
  status?: string;
  amount?: number;
  payload: Record<string, unknown>;
  failureReason?: string;
}

const SWIFT_BASE_URL = 'https://swiftvendux.com/api/v1/developer';
const SWIFT_STATUS_BASE_URL = 'https://swiftvendux.com/api/v1';
// The provider is a Django/DRF app behind nginx and only serves the versioned
// resource at its trailing slash; the un-slashed form 301-redirects. fetch
// follows that redirect, but a redirect is one more place the Authorization
// header can be dropped, so the canonical URL is used directly.
const SWIFT_CATALOG_PATH = '/v1/packages/';
const SWIFT_PURCHASE_PATH = '/v1/buy/';

function swiftApiKey() {
  const key = Deno.env.get('SWIFTVENDUX_API_KEY')?.trim().replace(/^Bearer\s+/i, '');
  if (!key) throw new Error('Swift data provider API key is not configured.');
  return key;
}

function normalizeNetwork(networkType: string): string {
  const raw = String(networkType || '').trim().toLowerCase();
  const key = raw.replace(/[\s_-]/g, '');
  if (key === 'mtn') return 'MTN';
  if (key === 'telecel' || key === 'vodafone') return 'TELECEL';
  if (key === 'at' || /^(?:at(?:data|bundle|network)?|airtel.*tigo)/.test(key)) return 'AIRTELTIGO';
  return raw.toUpperCase();
}

/** Normalize Swift's size label to the MB unit used by our sale catalog. */
export function swiftPackageVolumeInMB(packageName: unknown): number | null {
  const size = String(packageName || '').match(/(\d+(?:\.\d+)?)\s*(gb|g|mb)\b/i);
  if (!size) return null;
  const amount = Number(size[1]);
  const volumeInMB = Math.round(amount * (size[2].toLowerCase() === 'mb' ? 1 : 1024));
  return Number.isFinite(volumeInMB) && volumeInMB > 0 ? volumeInMB : null;
}

function swiftCatalogNetwork(networkType: string): string {
  const key = String(networkType || '').trim().toLowerCase();
  if (key === 'airteltigo' || key === 'at') return 'at';
  if (key === 'mtn' || key === 'telecel') return key;
  throw new Error('Unsupported Swift catalog network.');
}

function packageRows(payload: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  const nestedData = body.data;
  if (nestedData && typeof nestedData === 'object' && !Array.isArray(nestedData)) {
    const nestedPackages = (nestedData as Record<string, unknown>).packages;
    if (Array.isArray(nestedPackages)) return nestedPackages as Record<string, unknown>[];
  }
  for (const field of ['data', 'packages', 'results', 'bundles', 'items']) {
    if (Array.isArray(body[field])) return body[field] as Record<string, unknown>[];
  }
  return null;
}

export async function fetchSwiftPackages(networkType?: string): Promise<SwiftPackage[]> {
  const networks = networkType
    ? [swiftCatalogNetwork(networkType)]
    : ['mtn', 'telecel', 'at'];
  const apiKey = swiftApiKey();

  const results = await Promise.all(networks.map(async (network) => {
    const url = new URL(`${SWIFT_BASE_URL}${SWIFT_CATALOG_PATH}`);
    url.searchParams.set('network', network);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const contentType = response.headers.get('content-type') || '';
    const raw = await response.text();
    let payload: unknown = null;
    try { payload = JSON.parse(raw); } catch { payload = raw.slice(0, 300); }

    if (!response.ok) {
      console.error('Swift catalog request failed:', { network, status: response.status, contentType, payload });
      throw new Error(`Swift package catalog request failed for ${network} (HTTP ${response.status}).`);
    }

    const rows = packageRows(payload);
    if (!rows) {
      const responseKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? Object.keys(payload)
        : [];
      console.error('Swift catalog response format was not recognized:', { network, contentType, responseKeys });
      throw new Error(`Swift returned an unsupported package catalog response for ${network}.`);
    }
    return rows.map((row) => ({ ...row, _requestedNetwork: network } as Record<string, unknown>));
  }));

  return results.flat().map((row) => ({
    ...row,
    id: String(row.package_id ?? row.id ?? row.uuid ?? row.package_uuid ?? ''),
    name: String(row.name ?? row.package_name ?? row.package ?? row.bundle_name ?? row.title ?? row.display_name ?? row.size ?? ''),
    network: normalizeNetwork(String(row.network ?? row.network_name ?? row.network_type ?? row._requestedNetwork ?? '')),
    price: row.price ?? row.amount ?? '',
  }) as SwiftPackage).filter((pkg) => pkg.id && pkg.name && pkg.network &&
    Number.isFinite(Number(pkg.price)) && Number(pkg.price) > 0 &&
    (!String((pkg as unknown as Record<string, unknown>).category || '').trim() || /data|bundle/i.test(String((pkg as unknown as Record<string, unknown>).category))));
}

/**
 * Resolve the cheapest Swift package whose name matches the requested
 * network + volume. Package names look like "1GB MTN", "5GB AT", etc.
 */
export async function resolveSwiftPackage(networkType: string, volumeInMB: number): Promise<SwiftPackage | null> {
  const packages = await fetchSwiftPackages(networkType);
  const network = normalizeNetwork(networkType);

  const matches = packages
    .filter((pkg) => {
      const packageNetwork = normalizeNetwork(pkg.network);
      return packageNetwork === network && swiftPackageVolumeInMB(pkg.name) === volumeInMB;
    })
    .sort((a, b) => Number(a.price) - Number(b.price));

  if (!matches.length) {
    console.warn('No Swift package matched the requested network and volume:', {
      network: normalizeNetwork(networkType),
      volumeInMB,
      packageCount: packages.length,
      sample: packages.slice(0, 12).map(({ name, network, price }) => ({ name, network, price })),
    });
  }
  return matches[0] ?? null;
}

export async function buySwiftPackage(packageId: string, phone: string): Promise<SwiftBuyResult> {
  try {
    const reference = `SWIFT-${crypto.randomUUID()}`;
    const response = await fetch(`${SWIFT_BASE_URL}${SWIFT_PURCHASE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${swiftApiKey()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ package_id: packageId, phone, reference }),
    });
    const payload = await response.json().catch(() => ({ raw: 'Invalid provider response' })) as Record<string, unknown>;
    const success = response.ok && payload.success === true;
    return {
      success,
      reference,
      orderId: payload.order_id ? String(payload.order_id) : undefined,
      status: payload.status ? String(payload.status) : undefined,
      amount: Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : undefined,
      payload,
      failureReason: success ? undefined : String(payload.message || payload.error || 'Swift declined the data order.'),
    };
  } catch (err) {
    return {
      success: false,
      payload: { error: String(err) },
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the Swift provider.',
    };
  }
}

/** Provider status states for Swift */
export type SwiftOrderState = 'successful' | 'failed' | 'cancelled' | 'processing';

export function mapSwiftOrderState(rawStatus: string): { state: SwiftOrderState; status: string } {
  const norm = String(rawStatus || '').trim().toUpperCase();
  if (['DELIVERED', 'SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'TRUE', 'DONE', 'PASSED', 'PROCESSED', 'APPROVED', 'SENT'].includes(norm)) {
    return { state: 'successful', status: norm || 'DELIVERED' };
  }
  if (['FAILED', 'FAILURE', 'DECLINED', 'REJECTED', 'ERROR', 'UNFULFILLED'].includes(norm)) {
    return { state: 'failed', status: norm || 'FAILED' };
  }
  if (['CANCELLED', 'CANCELED'].includes(norm)) {
    return { state: 'cancelled', status: norm || 'CANCELLED' };
  }
  return { state: 'processing', status: norm || 'PROCESSING' };
}

/**
 * Queries Swift Vendux API for the real live status of an order.
 */
export async function fetchSwiftOrderStatus(
  orderIdOrReference: string,
): Promise<{ state: SwiftOrderState; status: string; payload?: Record<string, unknown> } | null> {
  if (!orderIdOrReference) return null;
  const apiKey = swiftApiKey();

  const encoded = encodeURIComponent(orderIdOrReference);
  // This is Swift Vendux's documented status endpoint. Keep the older developer
  // paths as a compatibility fallback for orders created before the endpoint was
  // standardised.
  const candidateUrls = [
    `${SWIFT_STATUS_BASE_URL}/orders/${encoded}/`,
    `${SWIFT_STATUS_BASE_URL}/orders/${encoded}`,
    `${SWIFT_BASE_URL}/v1/status/?reference=${encoded}`,
    `${SWIFT_BASE_URL}/v1/status/?order_id=${encoded}`,
    `${SWIFT_BASE_URL}/v1/orders/?reference=${encoded}`,
    `${SWIFT_BASE_URL}/v1/orders/?search=${encoded}`,
    `${SWIFT_BASE_URL}/v1/orders/${encoded}/`,
    `${SWIFT_BASE_URL}/v1/status/${encoded}/`,
    `${SWIFT_BASE_URL}/v1/check-status/?reference=${encoded}`,
    `${SWIFT_BASE_URL}/v1/check-status/?order_id=${encoded}`,
  ];

  for (const urlStr of candidateUrls) {
    try {
      const response = await fetch(urlStr, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      if (!response.ok) continue;

      const responseBody = await response.json().catch(() => ({})) as unknown;
      const payload = responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)
        ? responseBody as Record<string, unknown>
        : { data: responseBody };
      const candidates = [payload, payload.data, payload.result, payload.order]
        .filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value)));

      for (const candidate of candidates) {
        const rawStatus = candidate.status ?? candidate.order_status ?? candidate.delivery_status ?? candidate.state;
        if (rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '') {
          const mapped = mapSwiftOrderState(String(rawStatus));
          return { ...mapped, payload };
        }
        if (candidate.success === true || candidate.success === 'true') {
          return { state: 'successful', status: 'SUCCESSFUL', payload };
        }
        if (candidate.success === false || candidate.success === 'false') {
          return { state: 'failed', status: 'FAILED', payload };
        }
      }

      const rows = Array.isArray(responseBody)
        ? responseBody
        : Array.isArray(payload.data) ? payload.data
          : Array.isArray(payload.results) ? payload.results
            : [];
      const match = rows.find((row) => {
        if (!row || typeof row !== 'object') return false;
        const item = row as Record<string, unknown>;
        return String(item.order_id || item.reference || item.id || '') === orderIdOrReference;
      }) || rows[0];
      if (match && typeof match === 'object') {
        const item = match as Record<string, unknown>;
        const rawStatus = item.status ?? item.order_status ?? item.delivery_status ?? item.state;
        if (rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() !== '') {
          const mapped = mapSwiftOrderState(String(rawStatus));
          return { ...mapped, payload: item };
        }
      }
    } catch (_err) {
      // Continue to next URL candidate
    }
  }

  return null;
}
