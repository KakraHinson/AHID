/**
 * Provider cancellation adapter.
 *
 * Cancellation is deliberately opt-in. Provider APIs do not share one
 * cancellation contract, so we never invent an endpoint or refund a wallet
 * while the provider may still deliver the order. Configure the provider URL
 * as a Supabase secret when the provider has supplied an official endpoint.
 */

export type ProviderCancellationResult = {
  configured: boolean;
  confirmed: boolean;
  provider: string;
  reference: string;
  status: number | null;
  payload: unknown;
  error?: string;
};

function normalizeProvider(provider: string): 'swift' | 'grandtech' | 'hubtel' | null {
  const value = String(provider || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (value === 'swift' || value === 'swiftvendux') return 'swift';
  if (value === 'grandtech' || value === 'grandtechhub') return 'grandtech';
  if (value === 'hubtel') return 'hubtel';
  return null;
}

function configuredUrl(provider: 'swift' | 'grandtech' | 'hubtel'): string {
  const key = provider === 'swift'
    ? 'SWIFT_ORDER_CANCEL_URL'
    : provider === 'grandtech'
      ? 'GRANDTECH_ORDER_CANCEL_URL'
      : 'HUBTEL_ORDER_CANCEL_URL';
  return Deno.env.get(key)?.trim() || '';
}

function expandUrl(template: string, reference: string): string {
  const encoded = encodeURIComponent(reference);
  return template
    .replaceAll('{ref}', encoded)
    .replaceAll('{reference}', encoded)
    .replaceAll('{orderId}', encoded);
}

function parsePayload(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function headersFor(provider: 'swift' | 'grandtech' | 'hubtel'): Record<string, string> {
  if (provider === 'swift') {
    const key = Deno.env.get('SWIFTVENDUX_API_KEY')?.trim().replace(/^Bearer\s+/i, '');
    if (!key) throw new Error('Swift data provider API key is not configured.');
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  }
  if (provider === 'grandtech') {
    const key = Deno.env.get('GRANDTECH_API_KEY')?.trim();
    if (!key) throw new Error('GrandTech API key is not configured.');
    return { 'x-api-key': key, 'Content-Type': 'application/json' };
  }

  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) throw new Error('Hubtel client credentials are not configured.');
  return {
    Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Ask a configured provider endpoint to cancel an order. A 2xx response from
 * the provider endpoint is treated as the provider's confirmation; callers
 * must not refund before this result is confirmed.
 */
export async function requestProviderCancellation(
  provider: string,
  reference: string,
  reason: string,
): Promise<ProviderCancellationResult> {
  const normalized = normalizeProvider(provider);
  const cleanReference = String(reference || '').trim();
  if (!normalized || !cleanReference) {
    return {
      configured: false,
      confirmed: false,
      provider: normalized || String(provider || 'unknown'),
      reference: cleanReference,
      status: null,
      payload: null,
      error: 'A supported provider and order reference are required.',
    };
  }

  const template = configuredUrl(normalized);
  if (!template) {
    return {
      configured: false,
      confirmed: false,
      provider: normalized,
      reference: cleanReference,
      status: null,
      payload: null,
      error: `${normalized} order cancellation is not configured. Add ${normalized === 'swift' ? 'SWIFT_ORDER_CANCEL_URL' : normalized === 'grandtech' ? 'GRANDTECH_ORDER_CANCEL_URL' : 'HUBTEL_ORDER_CANCEL_URL'} from the provider's official API documentation.`,
    };
  }

  try {
    const method = (Deno.env.get(`${normalized.toUpperCase()}_ORDER_CANCEL_METHOD`) || 'POST').trim().toUpperCase();
    const response = await fetch(expandUrl(template, cleanReference), {
      method,
      headers: headersFor(normalized),
      ...(method === 'GET' || method === 'HEAD' ? {} : {
        body: JSON.stringify({ reference: cleanReference, orderId: cleanReference, reason }),
      }),
    });
    const payload = parsePayload(await response.text());
    return {
      configured: true,
      confirmed: response.ok,
      provider: normalized,
      reference: cleanReference,
      status: response.status,
      payload,
      ...(!response.ok ? { error: `Provider cancellation returned HTTP ${response.status}.` } : {}),
    };
  } catch (error) {
    return {
      configured: true,
      confirmed: false,
      provider: normalized,
      reference: cleanReference,
      status: null,
      payload: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
