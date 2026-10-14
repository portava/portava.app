/**
 * Management API THROTTLING (HTTP 429) — a bounded retry, shared by every
 * Management API caller certify:migrations runs (its own stages 2–4, stage 1's
 * check:migration-ledger, stage 5's audit:schema and check:missing-live-columns)
 * and therefore by live-db.yml and beta-db.yml, which run the same scripts.
 *
 * WHY. beta-db run 38071891814 (2026-10-10, APPLY-PENDING-BETA) applied 59 files
 * cleanly, then certify:migrations re-ran 70 postcondition blocks: 19 answered,
 * and the next 51 came back `Management API 429: {"message":"ThrottlerException:
 * Too Many Requests"}` within the same ten seconds. Every one was recorded as a
 * POSTCONDITION FAILED and the stage went red, although nothing about the
 * database was wrong — the platform had refused to answer, which is not the same
 * claim. A bootstrap certifies the WHOLE chain in one run (~490 files), so the
 * same burst is certain there.
 *
 * WHAT IS RETRIED, AND WHAT IS NOT. Only status 429. The throttler answers
 * before the request reaches the database (the body names NestJS's
 * ThrottlerException), so a 429 means "not executed" and resending the same
 * statement is safe. Every other status — 400 (the SQL failed), 401/403 (the
 * token), 5xx (an outcome this client cannot know) — is returned unchanged on
 * the first attempt, so each caller's existing error handling and messages are
 * exactly what they were. A transport error (fetch throws) propagates unchanged.
 *
 * BOUNDED. At most `maxAttempts` requests per call; each wait honours a
 * `Retry-After` header (delta-seconds or an HTTP-date) when the response carries
 * one, capped at `maxRetryAfterMs`, otherwise exponential backoff from
 * `baseDelayMs` capped at `maxDelayMs`; every wait carries random jitter (so the
 * five or ten parallel catalog reads of a snapshot do not retry in lock-step);
 * and the waits of one call never sum past `maxTotalWaitMs`. When the budget is
 * spent the LAST 429 response is returned to the caller, which fails exactly as
 * it always did ("Management API 429: …") — a throttled check is still never a
 * pass. Each retry and the give-up are printed, so a slow run says why.
 *
 * PURE APART FROM fetch AND THE CLOCK, both injectable: no credential variable
 * is named here (see migrationLedgerCore.ts on why a lib file stays that way).
 */

export interface ThrottleRetryPolicy {
  /** Requests per call, the first one included. */
  maxAttempts: number;
  /** First backoff when the response names no Retry-After. Doubles per retry. */
  baseDelayMs: number;
  /** Ceiling of one computed backoff. */
  maxDelayMs: number;
  /** Ceiling of one Retry-After wait; a larger value is clamped, not refused. */
  maxRetryAfterMs: number;
  /** Ceiling of the jitter added to every wait. */
  maxJitterMs: number;
  /** The waits of one call never sum past this. */
  maxTotalWaitMs: number;
}

export const MANAGEMENT_API_THROTTLE_RETRY: Readonly<ThrottleRetryPolicy> = Object.freeze({
  maxAttempts: 8,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
  maxJitterMs: 1_000,
  maxTotalWaitMs: 180_000,
});

/**
 * `Retry-After` as milliseconds from `nowMs`: delta-seconds (RFC 9110 §10.2.3)
 * or an HTTP-date. Absent, empty, negative or unparseable → null (backoff is
 * used instead). A date in the past is 0.
 */
export function parseRetryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;
  if (/^\d+$/.test(v)) return Number(v) * 1_000;
  if (/^\d*\.\d+$/.test(v)) return Math.round(Number(v) * 1_000);
  const at = Date.parse(v);
  if (!Number.isFinite(at) || !/[A-Za-z]/.test(v)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * The wait before retry number `retry` (1 = the first retry). Retry-After, when
 * given, is a floor the wait honours (clamped to maxRetryAfterMs); otherwise
 * exponential backoff. `random` in [0,1) supplies the jitter, always ADDED, so
 * a Retry-After is never undercut.
 */
export function throttleDelayMs(
  retry: number,
  retryAfterMs: number | null,
  policy: Readonly<ThrottleRetryPolicy>,
  random: () => number,
): number {
  const jitter = Math.floor(random() * policy.maxJitterMs);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, policy.maxRetryAfterMs) + jitter;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, retry - 1));
  return backoff + jitter;
}

export interface ThrottleRetryDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  log?: (line: string) => void;
  policy?: Readonly<ThrottleRetryPolicy>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * fetch(), resent while the Management API answers 429 and the budget lasts.
 * Returns the first non-429 response, or the last 429 once the budget is spent.
 * `init.body` must be a string (it is resent verbatim) — every caller here sends
 * `JSON.stringify({ query })`.
 */
export async function fetchWithThrottleRetry(
  url: string,
  init: RequestInit,
  deps: ThrottleRetryDeps = {},
): Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.error(line));
  const policy = deps.policy ?? MANAGEMENT_API_THROTTLE_RETRY;
  if (init.body !== undefined && init.body !== null && typeof init.body !== "string") {
    throw new Error("fetchWithThrottleRetry: init.body must be a string so a throttled request can be resent verbatim");
  }

  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch(url, init);
    if (res.status !== 429) return res;
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"), now());
    const delay = throttleDelayMs(attempt, retryAfterMs, policy, random);
    if (attempt >= policy.maxAttempts || waited + delay > policy.maxTotalWaitMs) {
      log(
        `Management API 429 (throttled): giving up after ${attempt} attempt(s) and ${(waited / 1000).toFixed(1)}s of ` +
          "waiting — the caller reports this request as failed.",
      );
      return res;
    }
    // Drain the refused response before waiting, so its connection is released.
    await res.text().catch(() => "");
    log(
      `Management API 429 (throttled): retry ${attempt}/${policy.maxAttempts - 1} in ${(delay / 1000).toFixed(1)}s` +
        (retryAfterMs !== null ? ` (Retry-After ${(retryAfterMs / 1000).toFixed(1)}s)` : " (exponential backoff)"),
    );
    await sleep(delay);
    waited += delay;
  }
}
