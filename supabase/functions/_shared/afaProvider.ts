/**
 * AFA (Aid & Food Allowance / Farmer) Provider Integration for Skaitech Ghana
 * Provider: GrandTechHub AFA API
 *
 * Endpoint: POST https://backend.grandtechub.cloud/api/afa
 *   (the provider's own docs say "backend.grandtech.cloud", which does not
 *    resolve - the real host is grandtechub.cloud)
 * Headers:  x-api-key: <GRANDTECH_API_KEY>
 *           Content-Type: application/json
 * Body:     { fullName, phoneNumber, town, occupation, priceId, idNumber,
 *             idType, callback }
 */

export interface AfaSubmission {
  fullName: string;
  phoneNumber: string;
  town: string;
  occupation: string;
  priceId: string;
  idNumber: string;
  idType: string;
  reference: string;
}

export interface AfaSubmitResult {
  success: boolean;
  providerReference?: string;
  providerResponse?: Record<string, unknown>;
  failureReason?: string;
}

const GRANDTECH_AFA_DEFAULT_URL = 'https://backend.grandtechub.cloud/api/afa';

/**
 * Base AFA endpoint. Override with GRANDTECH_AFA_URL when the provider moves or
 * when the documented host does not resolve.
 */
export function grandtechAfaUrl(): string {
  return (Deno.env.get('GRANDTECH_AFA_URL') || GRANDTECH_AFA_DEFAULT_URL).replace(/\/+$/, '');
}

export function grandtechApiKey(): string {
  const key = Deno.env.get('GRANDTECH_API_KEY');
  if (!key) throw new Error('AFA provider API key is not configured.');
  return key;
}

/**
 * Status callback the provider POSTs to. This must be a server endpoint, so it
 * points at the afa-webhook Edge Function - not at a page on the static site.
 * The frontend is static hosting and cannot receive POSTs.
 */
export function afaCallbackUrl(): string {
  const explicit = Deno.env.get('GRANDTECH_AFA_CALLBACK');
  if (explicit) return explicit;

  const supabaseUrl = (Deno.env.get('SUPABASE_URL') || '').replace(/\/+$/, '');
  if (supabaseUrl) return `${supabaseUrl}/functions/v1/afa-webhook`;

  return 'https://mxovqblxizvjsmudjsjf.supabase.co/functions/v1/afa-webhook';
}

/**
 * Submits an AFA registration to GrandTechHub. Never throws on a provider
 * rejection; returns a structured result so the caller can refund the wallet.
 */
export async function submitAfaRegistration(data: AfaSubmission): Promise<AfaSubmitResult> {
  const apiKey = grandtechApiKey();
  const priceId = data.priceId || Deno.env.get('GRANDTECH_AFA_PRICE_ID')?.trim() || '';
  if (!priceId) throw new Error('GrandTech AFA price ID is not configured.');

  const payload = {
    fullName: data.fullName,
    phoneNumber: data.phoneNumber,
    town: data.town,
    occupation: data.occupation,
    priceId,
    idNumber: data.idNumber,
    idType: data.idType,
    callback: afaCallbackUrl(),
  };

  try {
    const response = await fetch(grandtechAfaUrl(), {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const responseData = await response.json().catch(() => ({})) as Record<string, unknown>;

    const ok = response.ok || (response.status >= 200 && response.status < 300);
    const statusText = String(
      responseData.status ?? responseData.Status ?? responseData.state ?? '',
    ).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
    const messageText = String(responseData.message ?? responseData.description ?? '').trim();
    const explicitlyFailed = responseData.success === false || responseData.status === false ||
      Boolean(responseData.error || responseData.failure_reason) ||
      /^(failed|failure|rejected|declined|denied|cancelled|canceled|error|expired)$/.test(statusText) ||
      /\b(failed|failure|rejected|declined|denied|invalid|unable|missing|error)\b/i.test(messageText);

    // GrandTech commonly returns a successful 2xx response with a human-readable
    // `message`. A message alone is not an error; only an explicit failure marker
    // or a failed HTTP status should trigger the wallet refund path.
    if (ok && !explicitlyFailed) {
      const providerDataRaw = responseData.payload ?? responseData.Payload ?? responseData.data;
      const providerData = providerDataRaw && typeof providerDataRaw === 'object' && !Array.isArray(providerDataRaw)
        ? providerDataRaw as Record<string, unknown>
        : {};
      return {
        success: true,
        providerReference: String(
          responseData.reference ??
          responseData.provider_reference ??
          responseData.id ??
          responseData.transactionId ??
          responseData.afaId ??
          providerData.reference ??
          providerData.provider_reference ??
          providerData.id ??
          providerData.transactionId ??
          providerData.afaId ??
          '',
        ) || undefined,
        providerResponse: responseData,
      };
    }

    return {
      success: false,
      failureReason: String(
        responseData.message ||
        responseData.error ||
        responseData.failure_reason ||
        responseData.description ||
        (ok ? 'The AFA provider did not confirm the registration.' : `AFA provider request failed (HTTP ${response.status}).`),
      ),
      providerResponse: responseData,
    };
  } catch (err) {
    console.error('GrandTechHub AFA dispatch error:', err);
    return {
      success: false,
      failureReason: err instanceof Error ? err.message : 'Network error connecting to the AFA provider.',
      providerResponse: { error: String(err) },
    };
  }
}
