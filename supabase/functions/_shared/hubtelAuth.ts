/**
 * Hubtel authentication — the one place that builds the `Authorization` header
 * for every outgoing Hubtel request (wallet checkout and data vending alike).
 *
 * Hubtel's documented requirement is HTTP Basic over the account credentials:
 *
 *   Authorization: Basic base64(clientId:clientSecret)
 *
 * `hubtelBasicAuthHeader()` builds exactly that, and
 * `getHubtelAuthorizationHeader()` is the function every call site uses, so the
 * scheme lives in a single place instead of being re-derived per module.
 *
 * When the account is issued an OAuth2 token endpoint (`HUBTEL_TOKEN_URL`), the
 * same credentials mint a bearer token that is cached until just before it
 * expires. Otherwise `HUBTEL_AUTH_SCHEME` selects the direct style: `basic`
 * (default) or `bearer`.
 *
 * No credential is ever logged or returned from this module — a failed token
 * response can echo the submitted credential back, so even that log omits the
 * body.
 */

import { hubtelFetch, pickString, readJson } from './hubtelClient.ts';

export interface HubtelCredentials {
  clientId: string;
  clientSecret: string;
}

export interface HubtelAuthOptions {
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  authScheme?: string;
  scope?: string;
  timeoutMs?: number;
}

/** Reads the shared Hubtel client credentials from the environment. */
export function readHubtelCredentials(): HubtelCredentials | null {
  const clientId = Deno.env.get('HUBTEL_CLIENT_ID')?.trim();
  const clientSecret = Deno.env.get('HUBTEL_CLIENT_SECRET')?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * `Authorization: Basic base64(clientId:clientSecret)`.
 *
 * Encoded byte-by-byte rather than with `btoa(`${id}:${secret}`)`: `btoa` throws
 * on any code point above U+00FF, and the secret is UTF-8, so a stray character
 * would surface as a runtime error instead of a header.
 */
export function hubtelBasicAuthHeader(clientId: string, clientSecret: string): string {
  const bytes = new TextEncoder().encode(`${clientId}:${clientSecret}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Resolves the Authorization header for any Hubtel call. Credentials, token
 * URL, scheme and scope come from the environment unless overridden, so callers
 * that already parsed their own config can pass it in.
 *
 * Throws when the account credentials are missing: a misconfigured deployment
 * should fail loudly rather than send an unauthenticated request.
 */
export async function getHubtelAuthorizationHeader(options: HubtelAuthOptions = {}): Promise<string> {
  const envCreds = readHubtelCredentials();
  const clientId = options.clientId ?? envCreds?.clientId ?? '';
  const clientSecret = options.clientSecret ?? envCreds?.clientSecret ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Hubtel credentials are not configured. Set HUBTEL_CLIENT_ID and HUBTEL_CLIENT_SECRET.');
  }

  const tokenUrl = options.tokenUrl ?? (Deno.env.get('HUBTEL_TOKEN_URL')?.trim() || undefined);
  const scope = options.scope ?? (Deno.env.get('HUBTEL_SCOPE')?.trim() || undefined);
  const scheme = String(options.authScheme ?? (Deno.env.get('HUBTEL_AUTH_SCHEME')?.trim() || 'basic')).toLowerCase();

  if (!tokenUrl) {
    return scheme === 'bearer' ? `Bearer ${clientId}` : hubtelBasicAuthHeader(clientId, clientSecret);
  }

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return `Bearer ${cachedToken.value}`;
  }

  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (scope) form.set('scope', scope);

  const response = await hubtelFetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: hubtelBasicAuthHeader(clientId, clientSecret),
    },
    body: form.toString(),
  }, options.timeoutMs);

  const payload = await readJson(response);
  const token = pickString(payload, ['access_token', 'accessToken', 'token']);
  if (!response.ok || !token) {
    console.error('Hubtel token request failed:', { status: response.status });
    throw new Error('Could not authenticate with Hubtel.');
  }

  const expiresIn = Number(pickString(payload, ['expires_in', 'expiresIn']));
  cachedToken = {
    value: token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn - 60 : 300) * 1000,
  };
  return `Bearer ${token}`;
}

/** Clears the cached OAuth token. Used after a credential rotation and in tests. */
export function resetHubtelAuthTokenCache(): void {
  cachedToken = null;
}
