/**
 * Low-level Hubtel transport: one timeout-aware fetch plus the JSON/field
 * readers every Hubtel call shares.
 *
 * This module knows nothing about auth — the caller passes the `Authorization`
 * header it wants (built by `hubtelAuth.ts`). Keeping transport and auth
 * separate makes the dependency one-way (`hubtelAuth -> hubtelClient`) with no
 * import cycle.
 */

const DEFAULT_TIMEOUT_MS = 25_000;

function resolveTimeout(timeoutMs?: number): number {
  if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs;
  const fromEnv = Number(Deno.env.get('HUBTEL_TIMEOUT_MS'));
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS;
}

/** `fetch` with an abort timer, so a hung Hubtel endpoint cannot pin a worker. */
export async function hubtelFetch(url: string, init: RequestInit, timeoutMs?: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), resolveTimeout(timeoutMs));
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads a response body as JSON. A non-JSON body (an HTML error page, an empty
 * 204) is returned as `{ raw }` rather than throwing, so callers can still read
 * a status out of it.
 */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return { raw: raw.slice(0, 500) };
  }
}

/** First non-empty string (or finite number) among `fields` on a JSON object. */
export function pickString(payload: unknown, fields: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const body = payload as Record<string, unknown>;
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/** Numeric read of the first matching field, or undefined when absent/NaN. */
export function pickNumber(payload: unknown, fields: string[]): number | undefined {
  const raw = pickString(payload, fields);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export interface HubtelRequestOptions {
  method?: string;
  /** Object -> JSON body; string -> sent verbatim (e.g. a form-encoded token request). */
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  /** The `Authorization` header to send (see `hubtelAuth.ts`). */
  authorization?: string;
  timeoutMs?: number;
}

export interface HubtelResponse {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

function withQuery(url: string, query?: Record<string, string | number | undefined>): string {
  if (!query) return url;
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || `${value}` === '') continue;
    target.searchParams.set(key, String(value));
  }
  return target.toString();
}

/**
 * Sends one Hubtel call: attaches the auth header, serializes the body, applies
 * the timeout, and parses the JSON response.
 *
 * Throws only on a transport failure (timeout / DNS / offline), so callers keep
 * their "could not reach Hubtel" handling. An HTTP error status is returned as
 * `ok: false` for the caller to interpret — Hubtel often answers 200 with a
 * failure body, and a few products answer non-2xx with a useful payload.
 */
export async function hubtelRequest(url: string, options: HubtelRequestOptions = {}): Promise<HubtelResponse> {
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (options.authorization) headers.Authorization = options.authorization;

  let body: string | undefined;
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const response = await hubtelFetch(
    withQuery(url, options.query),
    { method: options.method ?? (body ? 'POST' : 'GET'), headers, body },
    options.timeoutMs,
  );
  return { ok: response.ok, status: response.status, payload: await readJson(response) };
}
