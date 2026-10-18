import { hubtelBasicAuthHeader } from './hubtelAuth.ts';
import { hubtelRequest } from './hubtelClient.ts';

export type UtilityProviderReply = {
  success: boolean;
  verified?: boolean;
  pending?: boolean;
  customerName?: string;
  token?: string;
  providerReference?: string;
  status?: string;
  message?: string;
  raw: unknown;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = stringValue(value);
    if (result) return result;
  }
  return undefined;
}

function responseData(payload: JsonRecord): unknown {
  return payload.Data ?? payload.data ?? payload.Result ?? payload.result;
}

function responseCode(payload: JsonRecord): string | undefined {
  return firstString(payload.ResponseCode, payload.responseCode, payload.response_code, payload.code);
}

function responseMessage(payload: JsonRecord): string | undefined {
  return firstString(payload.Message, payload.message, payload.Description, payload.description, payload.Error, payload.error);
}

function dataRows(payload: JsonRecord): JsonRecord[] {
  const data = responseData(payload);
  if (Array.isArray(data)) return data.map(record).filter((item) => Object.keys(item).length > 0);
  const item = record(data);
  return Object.keys(item).length ? [item] : [];
}

function providerReference(payload: JsonRecord): string | undefined {
  const data = record(responseData(payload));
  return firstString(
    payload.TransactionId, payload.transactionId, payload.OrderId, payload.orderId,
    payload.ClientReference, payload.clientReference,
    data.TransactionId, data.transactionId, data.OrderId, data.orderId,
    data.ClientReference, data.clientReference,
  );
}

function tokenFrom(payload: JsonRecord): string | undefined {
  const data = record(responseData(payload));
  const rows = dataRows(payload);
  return firstString(
    payload.Token, payload.token, payload.TokenCode, payload.tokenCode, payload.token_code,
    payload.PIN, payload.Pin, payload.pin,
    data.Token, data.token, data.TokenCode, data.tokenCode, data.token_code,
    data.PIN, data.Pin, data.pin,
    ...rows.flatMap((row) => [row.Token, row.token, row.TokenCode, row.tokenCode, row.token_code, row.PIN, row.Pin, row.pin]),
  );
}

function customerNameFrom(payload: JsonRecord): string | undefined {
  const data = record(responseData(payload));
  const rows = dataRows(payload);
  return firstString(
    payload.CustomerName, payload.customerName, payload.Customer, payload.customer,
    data.CustomerName, data.customerName, data.Customer, data.customer,
    ...rows.flatMap((row) => [row.CustomerName, row.customerName, row.Name, row.name, row.Customer, row.customer]),
  );
}

function configuredServiceEndpoint(service: string): string {
  const normalized = service.trim().toLowerCase();
  const suffix = normalized === 'ecg' || normalized === 'ecg_postpaid'
    ? 'ECG'
    : normalized.replace(/[^a-z0-9]+/g, '_').toUpperCase();
  const serviceEndpoint = Deno.env.get(`UTILITY_PROVIDER_API_URL_${suffix}`)?.trim();
  const endpoint = serviceEndpoint || Deno.env.get('UTILITY_PROVIDER_API_URL')?.trim();
  if (!endpoint) {
    throw new Error('Utility provider API is not configured. Contact support before making this payment.');
  }

  // The supplied production mapping is ECG. Do not silently send water or TV
  // purchases to the ECG service when their own mapping has not been supplied.
  if (!serviceEndpoint && normalized !== 'ecg' && normalized !== 'ecg_postpaid') {
    throw new Error(`Utility service ${service} is not configured for Hubtel yet.`);
  }
  return endpoint;
}

function authorizationHeader(apiKey: string): string {
  const explicit = apiKey.trim();
  if (/^(basic|bearer)\s+/i.test(explicit)) return explicit;
  const clientId = Deno.env.get('UTILITY_PROVIDER_CLIENT_ID')?.trim()
    || Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const scheme = (Deno.env.get('UTILITY_PROVIDER_AUTH_SCHEME')?.trim() || 'Basic').toLowerCase();
  if (scheme === 'bearer') return `Bearer ${explicit}`;
  return clientId ? hubtelBasicAuthHeader(clientId, explicit) : `Basic ${explicit}`;
}

function callbackUrl(): string | undefined {
  const configured = Deno.env.get('UTILITY_PROVIDER_CALLBACK_URL')?.trim();
  if (configured) return configured;
  const projectUrl = Deno.env.get('SUPABASE_URL')?.trim();
  return projectUrl ? `${projectUrl}/functions/v1/hubtel-utility-webhook` : undefined;
}

function endpointQuery(action: 'verify' | 'status', payload: Record<string, unknown>): Record<string, string | undefined> {
  return {
    destination: firstString(payload.accountNumber, payload.destination),
    clientreference: firstString(payload.reference, payload.clientReference),
    transactionid: firstString(payload.providerReference, payload.transactionId),
  };
}

/** Hubtel Commission Services adapter for the configured utility services. */
export async function callUtilityProvider(
  action: 'verify' | 'purchase' | 'status',
  payload: Record<string, unknown>,
): Promise<UtilityProviderReply> {
  const service = String(payload.service ?? '').trim().toLowerCase();
  const endpoint = configuredServiceEndpoint(service);
  const apiKey = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim() || Deno.env.get('UTILITY_PROVIDER_API_KEY')?.trim();
  if (!apiKey) {
    throw new Error('Utility provider API is not configured. Contact support before making this payment.');
  }

  const authorization = authorizationHeader(apiKey);
  let response;
  if (action === 'purchase') {
    const body: JsonRecord = {
      Destination: String(payload.accountNumber ?? '').trim(),
      Amount: Number(Number(payload.amount).toFixed(2)),
      ClientReference: String(payload.reference ?? '').trim(),
    };
    const callback = callbackUrl();
    if (callback) body.CallbackUrl = callback;
    response = await hubtelRequest(endpoint, { method: 'POST', body, authorization });
  } else {
    response = await hubtelRequest(endpoint, {
      method: 'GET',
      query: endpointQuery(action, payload),
      authorization,
    });
  }

  const raw = response.payload;
  const code = responseCode(raw);
  const message = responseMessage(raw) || `Hubtel returned HTTP ${response.status}.`;
  const pending = code === '0001' || /pending|processing|accepted/i.test(message);
  const success = response.ok && code === '0000';
  const status = success ? (action === 'verify' ? 'verified' : 'completed')
    : pending ? 'processing' : 'failed';

  return {
    success,
    verified: action === 'verify' && success,
    pending,
    customerName: customerNameFrom(raw),
    token: action === 'purchase' ? tokenFrom(raw) : undefined,
    providerReference: providerReference(raw),
    status,
    message,
    raw,
  };
}
