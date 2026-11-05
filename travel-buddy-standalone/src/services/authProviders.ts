/**
 * authProviders — which sign-in providers the backend will actually accept.
 *
 * Supabase Auth publishes its provider switches at GET /auth/v1/settings: a
 * public endpoint (apikey only) whose `external` object says whether `apple`,
 * `google` and `email` are enabled. The sign-in screen offers a provider only
 * when BOTH hold: this build can perform it (src/lib/buildCapabilities.ts) and
 * the backend has it switched on. On 2026-11-04 production had Apple OFF while
 * the iOS screen showed "Continue with Apple" to everyone, so every tap failed
 * with a provider error.
 *
 * FAIL-OPEN: an unreachable, slow or malformed settings endpoint reports null,
 * and the screen shows every provider the build can do. A provider is hidden
 * only when the backend positively says it is off. The successful answer is
 * cached for the process; a failure is not, so the next sign-in screen asks again.
 */
import { timeoutSignal } from '../lib/timeoutSignal.ts';

export interface AuthProviderAvailability {
  apple: boolean;
  google: boolean;
  email: boolean;
}

/** The provider switches in a /auth/v1/settings body; null when the body has no `external` object. A missing key counts as ON. */
export function parseAuthSettings(body: unknown): AuthProviderAvailability | null {
  const external = (body as { external?: unknown } | null)?.external;
  if (!external || typeof external !== 'object') return null;
  const flags = external as Record<string, unknown>;
  const on = (key: string) => flags[key] !== false;
  return { apple: on('apple'), google: on('google'), email: on('email') };
}

export interface AuthProviderFetchOptions {
  fetchImpl?: typeof fetch;
  supabaseUrl?: string;
  anonKey?: string;
  timeoutMs?: number;
}

/** One read of the settings endpoint; never rejects. */
export async function fetchAuthProviderAvailability(opts: AuthProviderFetchOptions = {}): Promise<AuthProviderAvailability | null> {
  const supabaseUrl = (opts.supabaseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '').trim().replace(/\/$/, '');
  const anonKey = (opts.anonKey ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '').trim();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!supabaseUrl || !anonKey || typeof fetchImpl !== 'function') return null;
  try {
    const res = await fetchImpl(`${supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: anonKey, accept: 'application/json' },
      signal: timeoutSignal(opts.timeoutMs ?? 5000), // not AbortSignal.timeout: absent in React Native (src/lib/timeoutSignal.ts)
    });
    if (!res.ok) return null;
    return parseAuthSettings(await res.json());
  } catch {
    return null;
  }
}

let cached: Promise<AuthProviderAvailability | null> | null = null;

/** The process-wide answer: fetched once, kept while it succeeded. */
export function getAuthProviderAvailability(opts: AuthProviderFetchOptions = {}): Promise<AuthProviderAvailability | null> {
  if (cached) return cached;
  const inflight = fetchAuthProviderAvailability(opts).then((result) => {
    if (result === null && cached === inflight) cached = null; // a failure is not remembered
    return result;
  });
  cached = inflight;
  return inflight;
}

/** Test seam. */
export function _resetAuthProviderAvailabilityCache(): void {
  cached = null;
}
