/**
 * Hubtel Commission Services adapter for utility bills.
 *
 * Utility bills — ECG (prepaid & postpaid), Ghana Water, DStv, GOtv and
 * StarTimes — are sold through the same commission-services host as airtime and
 * Instant Data:
 *
 *   https://cs.hubtel.com/commissionservices/{disbursementAccount}/{ServiceID}
 *
 * The path segment is the DISBURSEMENT (prepaid deposit) account, not the
 * merchant/collection account, and auth is Basic over
 * HUBTEL_CLIENT_ID/HUBTEL_CLIENT_SECRET. Each service has its own ServiceID
 * supplied by Hubtel; ECG Prepaid and Postpaid deliberately share one.
 */

import { hubtelBasicAuthHeader } from './hubtelAuth.ts';
import { hubtelRequest } from './hubtelClient.ts';

/** Commission Services ServiceIDs supplied by Hubtel. */
const DEFAULT_UTILITY_SERVICE_IDS: Record<string, string> = {
  ecg: 'e6d6bac062b5499cb1ece1ac3d742a84',
  ecg_postpaid: 'e6d6bac062b5499cb1ece1ac3d742a84',
  ghana_water: '6c1e8a82d2e84feeb8bfd6be2790d71d',
  dstv: '297a96656b5846ad8b00d5d41b256ea7',
  gotv: 'e6ceac7f3880435cb30b048e9617eb41',
  startimes: '6598652d34ea4112949c93c079c501ce',
};

export type UtilityProviderReply = {
  success: boolean;
  verified?: boolean;
  pending?: boolean;
  customerName?: string;
  token?: string;
  sessionId?: string;
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

/** `Data[]` rows are `{Display, Value, Amount}`; `Display` is the field key. */
function rowValue(payload: JsonRecord, keys: string[]): string | undefined {
  for (const row of dataRows(payload)) {
    const display = (firstString(row.Display, row.display) || '').toLowerCase();
    if (!keys.includes(display)) continue;
    const value = firstString(row.Value, row.value);
    if (value) return value;
  }
  return undefined;
}

/**
 * The ECG query returns every meter linked to the phone as
 * `{Display: "NAME (METER)", Value: METER, Amount: outstanding}` rows, so the
 * holder's name is taken from the row whose meter matches the one entered.
 */
function ecgNameFor(payload: JsonRecord, accountNumber?: string): string | undefined {
  const wanted = (accountNumber || '').replace(/\s+/g, '');
  for (const row of dataRows(payload)) {
    const display = firstString(row.Display, row.display);
    if (!display) continue;
    const meter = (firstString(row.Value, row.value) || '').replace(/\s+/g, '');
    if (wanted && meter !== wanted) continue;
    const name = display.replace(/\([^)]*\)\s*$/, '').trim();
    if (name) return name;
  }
  return undefined;
}

/**
 * Account queries return the holder as `{Display, Value}` rows: Ghana Water,
 * DStv and GOtv key the name as `name`, while ECG embeds it in `Display`.
 */
function customerNameFrom(payload: JsonRecord, service: string, accountNumber?: string): string | undefined {
  if (service === 'ecg' || service === 'ecg_postpaid') return ecgNameFor(payload, accountNumber);
  return rowValue(payload, ['name']);
}

/** Ghana Water mints a session id on the meter query that its top-up requires. */
function sessionIdFrom(payload: JsonRecord): string | undefined {
  return rowValue(payload, ['sessionid', 'session id']);
}

function serviceIdFor(service: string): string | null {
  const envName = `HUBTEL_UTILITY_SERVICE_ID_${service.replace(/[^a-z0-9]+/g, '_').toUpperCase()}`;
  return Deno.env.get(envName)?.trim() || DEFAULT_UTILITY_SERVICE_IDS[service] || null;
}

/** `{base}/{disbursementAccount}/{ServiceID}` — GET queries an account, POST pays it. */
function utilityEndpoint(service: string): string | null {
  const serviceId = serviceIdFor(service);
  const account = Deno.env.get('HUBTEL_DISBURSEMENT_ACCOUNT')?.trim();
  if (!serviceId || !account) return null;
  const template = Deno.env.get('HUBTEL_UTILITY_URL')?.trim()
    || `https://cs.hubtel.com/commissionservices/${encodeURIComponent(account)}/{ServiceID}`;
  return template.replaceAll('{ServiceID}', encodeURIComponent(serviceId));
}

function callbackUrl(): string | undefined {
  const configured = Deno.env.get('HUBTEL_UTILITY_CALLBACK_URL')?.trim();
  if (configured) return configured;
  const projectUrl = Deno.env.get('SUPABASE_URL')?.trim();
  return projectUrl ? `${projectUrl}/functions/v1/hubtel-utility-webhook` : undefined;
}

/**
 * Commission Services queries an account with `destination`. ECG keys meters by
 * the mobile number linked to them, and Ghana Water needs both the meter number
 * (`destination`) and the customer's phone (`mobile`).
 */
function utilityQuery(
  action: 'verify' | 'status',
  service: string,
  payload: Record<string, unknown>,
): Record<string, string | undefined> {
  const account = firstString(payload.accountNumber, payload.destination);
  if (action === 'status') {
    return {
      destination: account,
      clientreference: firstString(payload.reference, payload.clientReference),
      transactionid: firstString(payload.providerReference, payload.transactionId),
    };
  }
  if (service === 'ecg' || service === 'ecg_postpaid') {
    return { destination: firstString(payload.customerPhone, payload.phone) };
  }
  if (service === 'ghana_water') {
    return { destination: account, mobile: firstString(payload.customerPhone, payload.phone) };
  }
  return { destination: account };
}

/** Hubtel Commission Services adapter for the configured utility services. */
export async function callUtilityProvider(
  action: 'verify' | 'purchase' | 'status',
  payload: Record<string, unknown>,
): Promise<UtilityProviderReply> {
  const service = String(payload.service ?? '').trim().toLowerCase();
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Utility provider API is not configured. Contact support before making this payment.');
  }
  const endpoint = utilityEndpoint(service);
  if (!endpoint) {
    throw new Error(`Utility service ${service || 'unknown'} is not configured for Hubtel yet.`);
  }

  const accountNumber = firstString(payload.accountNumber, payload.destination) ?? '';
  const phone = firstString(payload.customerPhone, payload.phone);
  const isEcg = service === 'ecg' || service === 'ecg_postpaid';

  const authorization = hubtelBasicAuthHeader(clientId, clientSecret);
  let response;
  if (action === 'purchase') {
    // ECG and Ghana Water charge the customer's phone number and carry the
    // meter/account number in `Extradata.bundle`; Ghana Water also needs the
    // customer's e-mail and the session id minted by its meter query. DStv,
    // GOtv and StarTimes pay the account number directly.
    const body: JsonRecord = {
      Amount: Number(Number(payload.amount).toFixed(2)),
      ClientReference: String(payload.reference ?? '').trim(),
    };
    if (isEcg) {
      if (!phone) throw new Error('A phone number is required to top up this ECG meter.');
      body.Destination = phone;
      body.Extradata = { bundle: accountNumber };
    } else if (service === 'ghana_water') {
      if (!phone) throw new Error('A phone number is required to top up this Ghana Water account.');
      body.Destination = phone;
      body.Extradata = {
        bundle: accountNumber,
        Email: firstString(payload.customerEmail, payload.email),
        SessionId: firstString(payload.sessionId),
      };
    } else {
      body.Destination = accountNumber;
    }
    const callback = callbackUrl();
    if (callback) body.CallbackUrl = callback;

    response = await hubtelRequest(endpoint, { method: 'POST', body, authorization });
  } else {
    const query = utilityQuery(action, service, payload);
    // Hubtel answers `ResponseCode 4000 "Expected \"destination\" in query
    // parameters"` when the query string has no destination, and `withQuery`
    // drops empty values — so surface the missing field here instead of
    // forwarding a request Hubtel will reject.
    if (!query.destination) {
      throw new Error(isEcg
        ? 'The phone number linked to this ECG meter is required to query it.'
        : 'A valid account number is required to query this utility account.');
    }
    if (service === 'ghana_water' && !query.mobile) {
      throw new Error("The customer's phone number is required to query this Ghana Water account.");
    }
    response = await hubtelRequest(endpoint, {
      method: 'GET',
      query,
      authorization,
    });
  }

  const raw = response.payload;
  const code = responseCode(raw);
  const message = responseMessage(raw) || `Hubtel returned HTTP ${response.status}.`;
  const data = record(responseData(raw));
  const statusText = firstString(raw.Status, raw.status, data.Status, data.status) || '';
  const explicitSuccess = raw.Success === true || raw.success === true || data.Success === true || data.success === true;
  const positiveText = /success|successful|completed|complete|paid|verified|approved|delivered/i.test(`${statusText} ${message}`);
  const negativeText = /fail|declin|reject|error|invalid|not found/i.test(`${statusText} ${message}`);
  const pending = code === '0001' || /pending|processing|accepted|queued/i.test(`${statusText} ${message}`);
  const success = response.ok && !pending && (code === '0000' || explicitSuccess || (positiveText && !negativeText));
  const status = success ? (action === 'verify' ? 'verified' : 'completed')
    : pending ? 'processing' : 'failed';

  return {
    success,
    verified: action === 'verify' && success,
    pending,
    customerName: customerNameFrom(raw, service, accountNumber),
    sessionId: sessionIdFrom(raw),
    token: action === 'purchase' ? tokenFrom(raw) : undefined,
    providerReference: providerReference(raw),
    status,
    message,
    raw,
  };
}
