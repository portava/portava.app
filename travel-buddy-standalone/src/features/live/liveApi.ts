/**
 * TM-live (WP-11) — the one request helper every live decision surface uses.
 *
 * WHY A HELPER, AND WHY THESE FOUR STATES
 * =======================================
 * Every surface in this folder renders a server answer about the world (is it
 * busy, should I go, what changed) or about the viewer's own day. The rule they
 * share is DV-83's: a read that failed is never shown as an empty or complete
 * answer. So a call resolves to exactly one of:
 *
 *   ok          — the server answered 2xx with a body
 *   off         — nothing was asked: not configured here, not signed in, or the
 *                 server says the feature is disabled (`feature_disabled`)
 *   refused     — the server considered it and said no, with its status and code
 *   unavailable — the request failed or its fate is unknown (network, 5xx,
 *                 an unreadable body). Never merged with `refused`.
 *
 * Like `features/trips/shared/auth.ts`, this never imports `lib/supabase.ts`
 * at module load, so a test fakes only `fetch` (and sets a token source).
 */
type TokenSource = () => Promise<string | null>;

let _testToken: TokenSource | null = null;

/** Test seam: a token source to use instead of apiToken.ts; null restores. */
export function _setLiveTestToken(fn: TokenSource | null): void {
  _testToken = fn;
}

/** Same computation as lib/supabase.ts's isSupabaseConfigured, read at call time. */
export function isConfigured(): boolean {
  return Boolean(process.env.EXPO_PUBLIC_SUPABASE_URL && process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
}

export const apiBase = (): string => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function bearerToken(): Promise<string | null> {
  if (_testToken) return _testToken();
  const { freshToken } = await import('../../services/apiToken.ts');
  return freshToken();
}

export type LiveCall<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'off'; reason: 'not_configured' | 'signed_out' | 'feature_disabled'; detail: string | null }
  | { kind: 'refused'; status: number; error: string; reason: string | null; detail: string | null; body: any }
  | { kind: 'unavailable'; status: number | null; detail: string };

export async function liveRequest<T = any>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<LiveCall<T>> {
  if (!isConfigured() || !apiBase()) return { kind: 'off', reason: 'not_configured', detail: null };
  const token = await bearerToken();
  if (!token) return { kind: 'off', reason: 'signed_out', detail: null };
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e: any) {
    return { kind: 'unavailable', status: null, detail: String(e?.message ?? 'network error') };
  }
  const parsed: any = await res.json().catch(() => undefined);
  if (res.ok) {
    if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
      return { kind: 'unavailable', status: res.status, detail: 'unreadable response' };
    }
    return { kind: 'ok', status: res.status, body: parsed as T };
  }
  const error = typeof parsed?.error === 'string' ? parsed.error : `http_${res.status}`;
  const detail = typeof parsed?.detail === 'string' ? parsed.detail : typeof parsed?.message === 'string' ? parsed.message : null;
  if (error === 'feature_disabled' || parsed?.reason === 'FEATURE_DISABLED') return { kind: 'off', reason: 'feature_disabled', detail };
  if (res.status >= 500 || res.status === 0) {
    const why = typeof parsed?.reason === 'string' ? parsed.reason : null;
    return { kind: 'unavailable', status: res.status, detail: why ? `${why}${detail ? ` — ${detail}` : ''}` : detail ?? error };
  }
  return { kind: 'refused', status: res.status, error, reason: typeof parsed?.reason === 'string' ? parsed.reason : null, detail, body: parsed ?? null };
}

/** The one sentence a surface shows for a call that did not succeed. */
export function failureLine(call: Exclude<LiveCall<unknown>, { kind: 'ok' }>, what: string): string {
  if (call.kind === 'off') {
    return call.reason === 'feature_disabled' ? `This isn't switched on in this build (${what}).` : `Sign in to see ${what}.`;
  }
  if (call.kind === 'refused') return `The server refused ${what} (${call.reason ?? call.error}${call.detail ? `: ${call.detail}` : ''}).`;
  return `Couldn't load ${what} — ${call.detail}. This is not an empty answer; it could not be read.`;
}
