/**
 * uploadRetry — WHEN an upload request is worth sending again, and how long to
 * wait first (Media spec §37 "Upload resume / retry").
 *
 * Pure: no network, no timers of its own (sleep is injected), no react-native.
 *
 * WHAT IS RETRIED
 *   • A request that never got an answer (the fetch/XHR threw — radio dropped,
 *     DNS, socket reset, app briefly suspended).
 *   • 408, 425, 429 and every 5xx — the server or the store said "not now".
 *     429's Retry-After is honoured (seconds or an HTTP date), capped.
 *
 * WHAT IS NOT
 *   • Every other 4xx. 400/401/403/404/409/413/422 are answers about the
 *     REQUEST, and sending the identical request again cannot change them —
 *     retrying a refused upload only burns the user's data and the rate limit.
 *     A caller that can FIX the request (a fresh signed URL after a 400/403 on
 *     an expired one) does that itself and then retries through this module.
 *
 * Backoff is exponential with FULL jitter (random in [0, cap]), so a fleet of
 * phones that lost the same cell tower do not return in lock-step.
 */

export type AttemptOutcome<T> =
  | { kind: 'done'; value: T }
  | { kind: 'retry'; reason: string; afterMs?: number | null }
  | { kind: 'fail'; reason: string; status?: number | null };

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  /** Checked before every attempt and after every wait. */
  isCancelled?: () => boolean;
}

export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; reason: string; attempts: number; retryable: boolean; cancelled?: boolean; status?: number | null };

export const DEFAULT_RETRY: Omit<RetryOptions, 'sleep' | 'random'> = {
  maxAttempts: 6,
  baseMs: 800,
  maxMs: 30_000,
};

/** Longest Retry-After this client will obey before treating the answer as "try later". */
const MAX_RETRY_AFTER_MS = 120_000;

/** Parse an HTTP Retry-After header (delta-seconds or HTTP-date) into ms, or null. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.min(at - nowMs, MAX_RETRY_AFTER_MS));
}

/** Classify an HTTP status the request DID receive. */
export function classifyStatus(
  status: number,
  retryAfter?: string | null,
): { kind: 'ok' } | { kind: 'retry'; afterMs: number | null } | { kind: 'fail' } {
  if (status >= 200 && status < 300) return { kind: 'ok' };
  if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
    return { kind: 'retry', afterMs: parseRetryAfter(retryAfter) };
  }
  return { kind: 'fail' };
}

/** Full-jitter exponential backoff: random in [0, min(maxMs, baseMs · 2^(attempt-1))]. */
export function backoffDelayMs(attempt: number, opts: { baseMs: number; maxMs: number }, random: () => number): number {
  const cap = Math.min(opts.maxMs, opts.baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.floor(random() * cap);
}

/**
 * Run `op` until it reports done or fail, or attempts run out. `op` receives
 * the 1-based attempt number. A thrown error is treated as "no answer" —
 * retryable — because that is what a thrown fetch means.
 */
export async function withRetry<T>(
  op: (attempt: number) => Promise<AttemptOutcome<T>>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  let lastReason = 'not attempted';
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.isCancelled?.()) return { ok: false, reason: 'cancelled', attempts: attempt - 1, retryable: false, cancelled: true };
    let outcome: AttemptOutcome<T>;
    try {
      outcome = await op(attempt);
    } catch (err) {
      outcome = { kind: 'retry', reason: err instanceof Error ? err.message : 'request failed' };
    }
    if (outcome.kind === 'done') return { ok: true, value: outcome.value, attempts: attempt };
    if (outcome.kind === 'fail') {
      return { ok: false, reason: outcome.reason, attempts: attempt, retryable: false, status: outcome.status ?? null };
    }
    lastReason = outcome.reason;
    if (attempt === opts.maxAttempts) break;
    const wait = outcome.afterMs != null ? outcome.afterMs : backoffDelayMs(attempt, opts, opts.random);
    await opts.sleep(wait);
    if (opts.isCancelled?.()) return { ok: false, reason: 'cancelled', attempts: attempt, retryable: false, cancelled: true };
  }
  // Out of attempts on a RETRYABLE condition: the upload is not refused, it is
  // paused — a later run (next foreground, next launch) may resume it.
  return { ok: false, reason: lastReason, attempts: opts.maxAttempts, retryable: true };
}
