/**
 * Hubtel Commission Services airtime adapter.
 *
 * Airtime is sold through the same commission-services host as Instant Data,
 * but each network has its own service id. The previous implementation called
 * the retired `/prepaid/topup` route, which returned HTTP 404.
 */

import { hubtelBasicAuthHeader } from './hubtelAuth.ts';
import { hubtelRequest } from './hubtelClient.ts';

const DEFAULT_AIRTIME_SERVICE_IDS: Record<'mtn' | 'telecel' | 'at', string> = {
  mtn: 'fdd76c884e614b1c8f669a3207b09a98',
  telecel: 'f4be83ad74c742e185224fdae1304800',
  at: 'dae2142eb5a14c298eace60240c09e4b',
};

export interface AirtimeDispatchResult {
  success: boolean;
  status: 'delivered' | 'failed' | 'pending_provider';
  providerReference?: string;
  providerResponse?: Record<string, unknown>;
  failureReason?: string;
}

function serviceIdFor(network: 'mtn' | 'telecel' | 'at'): string {
  const envName = network === 'mtn'
    ? 'HUBTEL_AIRTIME_SERVICE_ID_MTN'
    : network === 'telecel'
      ? 'HUBTEL_AIRTIME_SERVICE_ID_TELECEL'
      : 'HUBTEL_AIRTIME_SERVICE_ID_AIRTELTIGO';
  return Deno.env.get(envName)?.trim() || DEFAULT_AIRTIME_SERVICE_IDS[network];
}

function airtimeEndpoint(network: 'mtn' | 'telecel' | 'at'): string | null {
  // The Commission Services path segment is the DISBURSEMENT (prepaid deposit)
  // account. It is deliberately not the merchant/collection account, so there
  // is no fallback between them: using the wrong one reads as an auth failure.
  const account = Deno.env.get('HUBTEL_DISBURSEMENT_ACCOUNT')?.trim();
  if (!account) return null;

  const template = Deno.env.get('HUBTEL_AIRTIME_URL')?.trim()
    || `https://cs.hubtel.com/commissionservices/${encodeURIComponent(account)}/{ServiceID}`;
  return template.replaceAll('{ServiceID}', encodeURIComponent(serviceIdFor(network)));
}

function callbackUrl(): string | null {
  const configured = Deno.env.get('HUBTEL_AIRTIME_CALLBACK_URL')?.trim();
  if (configured) return configured;
  const projectUrl = Deno.env.get('SUPABASE_URL')?.trim();
  return projectUrl ? `${projectUrl}/functions/v1/hubtel-airtime-webhook` : null;
}

function providerReference(payload: Record<string, unknown>, fallback: string): string {
  const data = payload.Data ?? payload.data;
  if (data && typeof data === 'object') {
    const nested = data as Record<string, unknown>;
    for (const key of ['TransactionId', 'transactionId', 'OrderId', 'orderId', 'ClientReference']) {
      if (nested[key] !== undefined && nested[key] !== null) return String(nested[key]);
    }
  }
  for (const key of ['TransactionId', 'transactionId', 'OrderId', 'orderId', 'ClientReference']) {
    if (payload[key] !== undefined && payload[key] !== null) return String(payload[key]);
  }
  return fallback;
}

export async function dispatchAirtimeTopup(params: {
  phone: string;
  network: 'mtn' | 'telecel' | 'at';
  amount: number;
  reference: string;
}): Promise<AirtimeDispatchResult> {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  const endpoint = airtimeEndpoint(params.network);

  if (!clientId || !clientSecret || !endpoint) {
    return {
      success: false,
      status: 'failed',
      failureReason: 'Hubtel Airtime is not configured. Check HUBTEL_DISBURSEMENT_ACCOUNT and the Commission Services credentials.',
      providerResponse: { configured: false },
    };
  }

  const cleanPhone = params.phone.replace(/\D/g, '');
  const destination = cleanPhone.startsWith('0') ? `233${cleanPhone.slice(1)}` : cleanPhone;
  const body: Record<string, unknown> = {
    Destination: destination,
    Amount: Number(params.amount.toFixed(2)),
    ClientReference: params.reference,
  };
  const callback = callbackUrl();
  if (callback) body.CallbackUrl = callback;

  try {
    // Commission Services uses Basic client-id:client-secret auth. The OAuth
    // token endpoint belongs to another Hubtel product family.
    const response = await hubtelRequest(endpoint, {
      method: 'POST',
      body,
      authorization: hubtelBasicAuthHeader(clientId, clientSecret),
    });

    const payload = response.payload;
    const responseCode = String(payload.ResponseCode ?? payload.responseCode ?? '').trim();
    const reference = providerReference(payload, params.reference);

    if (response.ok && responseCode === '0000') {
      return { success: true, status: 'delivered', providerReference: reference, providerResponse: payload };
    }

    if (response.ok && responseCode === '0001') {
      return {
        success: true,
        status: 'pending_provider',
        providerReference: reference,
        providerResponse: payload,
        failureReason: 'Hubtel accepted the airtime request and is processing delivery.',
      };
    }

    return {
      success: false,
      status: 'failed',
      providerReference: reference,
      failureReason: String(payload.Message ?? payload.message ?? payload.Description ?? `Hubtel returned HTTP ${response.status}.`),
      providerResponse: payload,
    };
  } catch (err) {
    console.error('Hubtel airtime dispatch error:', err);
    return {
      success: false,
      status: 'failed',
      failureReason: err instanceof Error ? err.message : 'Network error connecting to Hubtel airtime provider.',
      providerResponse: { error: String(err) },
    };
  }
}
