/**
 * One request shape for the trips collaboration clients (WP-10: join
 * requests, lifecycle, shared contents, transport policy, saved places,
 * post-trip). Every client in src/features/trips/ used to restate it; the
 * five new ones share it so the three states are drawn the same way:
 *
 *   ok / done     the server answered and the answer is the data.
 *   refused       the server considered the request and said no, by name
 *                 (`reason` is the route's error code or the kernel's reason).
 *   unavailable   the request did not get an answer — offline, 503, a body
 *                 that could not be read. NEVER merged with `refused` and
 *                 never drawn as empty: nothing was decided (DV-83).
 *   off           this build is not configured, or nobody is signed in.
 *                 Nothing was asked, so nothing is claimed.
 *
 * Writes that the server routes through `trip_kernel_execute` read an
 * `Idempotency-Key` header (domain/trips/commands/tripKernel.ts
 * readCommandEnvelope). A key is minted once per user INTENT by the caller
 * (see `intentKey`) and reused when that intent is retried, so a retry after
 * a lost response is a duplicate receipt, not a second transition.
 */
import { isConfigured, apiBase, bearerToken } from './auth.ts';

export type ApiRead<T> =
  | { state: 'ok'; data: T }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string; status?: number; reason?: string };

export type ApiWrite<T> =
  | { state: 'done'; data: T; status: number }
  | { state: 'refused'; status: number; reason: string; detail: string }
  | { state: 'unavailable'; detail: string };

/** A fresh key for ONE user intent. Keep it and pass it again to retry that intent. */
export function intentKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

type ErrBody = { error?: string; reason?: string; message?: string; detail?: string } | null;

/**
 * GET a JSON body and accept it only when `valid` says it has the shape the
 * caller will render. A body without its lists is not an empty list.
 */
export async function readTripJson<T>(path: string, valid: (b: any) => boolean): Promise<ApiRead<T>> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ErrBody;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return {
        state: 'unavailable',
        detail: body?.message ?? body?.detail ?? `HTTP ${res.status}`,
        status: res.status,
        ...(body?.reason || body?.error ? { reason: body?.reason ?? body?.error } : {}),
      };
    }
    const body: unknown = await res.json().catch(() => null);
    if (body === null || !valid(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', data: body as T };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/**
 * Send a write. A 2xx is `done` (a 204 carries `null`); a 503 or a body that
 * cannot be read on a failure is `unavailable`; any other failure is a named
 * refusal.
 */
export async function sendTripWrite<T = unknown>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<ApiWrite<T>> {
  if (!isConfigured() || !apiBase()) return { state: 'unavailable', detail: 'not configured' };
  const token = await bearerToken();
  if (!token) return { state: 'unavailable', detail: 'not signed in' };
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e: any) {
    // It may or may not have reached the server: retry with the SAME key.
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
  if (res.status === 204) return { state: 'done', data: null as T, status: 204 };
  const parsed = (await res.json().catch(() => undefined)) as unknown;
  if (res.ok) {
    if (parsed === undefined) return { state: 'unavailable', detail: `unreadable response (HTTP ${res.status})` };
    return { state: 'done', data: parsed as T, status: res.status };
  }
  const err = (parsed ?? null) as ErrBody;
  if (res.status === 503) {
    return { state: 'unavailable', detail: err?.detail ?? err?.message ?? err?.reason ?? 'service unavailable' };
  }
  if (!err || (typeof err.reason !== 'string' && typeof err.error !== 'string')) {
    return { state: 'unavailable', detail: `unreadable response (HTTP ${res.status})` };
  }
  return {
    state: 'refused',
    status: res.status,
    reason: String(err.reason ?? err.error),
    detail: String(err.message ?? err.detail ?? `HTTP ${res.status}`),
  };
}

/** One sentence for a failed write, for an Alert or an inline line. */
export function writeFailureText(w: Exclude<ApiWrite<unknown>, { state: 'done' }>): string {
  return w.state === 'refused' ? w.detail : `Not saved — ${w.detail}. Try again.`;
}
