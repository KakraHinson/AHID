/** Shared status lookup for Hubtel Commission Services orders. */

import { getHubtelAuthorizationHeader } from './hubtelAuth.ts';
import { hubtelRequest, pickString } from './hubtelClient.ts';

export interface HubtelCommissionStatus {
  state: 'success' | 'failed' | 'pending';
  status: string;
  orderId?: string;
  payload: Record<string, unknown>;
}

const FAILURE_WORDS = ['fail', 'failed', 'failure', 'declined', 'rejected', 'cancelled', 'canceled', 'error', 'invalid'];

function statusEndpoint(): string | undefined {
  const configured = Deno.env.get('HUBTEL_COMMISSION_STATUS_URL')?.trim();
  if (configured && !/[{][^}]+[}]/.test(configured)) return configured;

  const account = Deno.env.get('HUBTEL_MERCHANT_ACCOUNT_NUMBER')?.trim()
    || Deno.env.get('HUBTEL_MERCHANT_ACCOUNT')?.trim();
  return account
    ? `https://rmsc.hubtel.com/v1/merchantaccount/merchants/${encodeURIComponent(account)}/transactions/status`
    : undefined;
}

function safePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set([
    'status', 'Status', 'responseCode', 'ResponseCode', 'response_code',
    'message', 'Message', 'description', 'Description', 'transactionId',
    'TransactionId', 'orderId', 'OrderId', 'clientReference', 'ClientReference',
    'isFulfilled', 'IsFulfilled', 'amount', 'Amount',
  ]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, entry]) => allowed.has(key) && entry !== null && typeof entry !== 'object'));
}

function classify(payload: unknown): { state: HubtelCommissionStatus['state']; status: string } {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = body.data ?? body.Data;
  const data = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const status = pickString(data, ['status', 'Status']) || pickString(body, ['status', 'Status']) || '';
  const normalized = status.toLowerCase();
  const fulfilled = data.isFulfilled ?? data.IsFulfilled ?? body.isFulfilled ?? body.IsFulfilled;

  if (normalized.includes('unpaid') || normalized.includes('reversed') || normalized.includes('refund')) {
    return { state: 'failed', status };
  }
  if (fulfilled === false && normalized.includes('paid')) return { state: 'failed', status };
  if (normalized.includes('paid') || fulfilled === true) return { state: 'success', status: status || 'Paid' };
  if (FAILURE_WORDS.some((word) => normalized.includes(word)) || fulfilled === false) {
    return { state: 'failed', status: status || 'Failed' };
  }
  if (normalized.includes('pending') || normalized.includes('process')) {
    return { state: 'pending', status };
  }
  return { state: 'pending', status: status || 'Unresolved' };
}

export async function fetchHubtelCommissionStatus(clientReference: string): Promise<HubtelCommissionStatus | null> {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  const endpoint = statusEndpoint();
  if (!clientId || !clientSecret || !endpoint || !clientReference) return null;

  try {
    const response = await hubtelRequest(endpoint, {
      query: { clientReference },
      authorization: await getHubtelAuthorizationHeader({ clientId, clientSecret }),
    });
    if (!response.ok) return null;

    const verdict = classify(response.payload);
    const orderId = pickString(response.payload, ['transactionId', 'TransactionId', 'orderId', 'OrderId']);
    return { ...verdict, orderId, payload: safePayload(response.payload) };
  } catch (error) {
    console.warn('Hubtel Commission Services status request failed:', { error: String(error) });
    return null;
  }
}
