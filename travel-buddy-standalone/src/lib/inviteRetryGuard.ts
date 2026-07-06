/**
 * Pure retry-guard logic for acceptInviteByToken.
 *
 * 4xx responses represent definitive server decisions — the link is revoked,
 * expired, exhausted, or the user is already a member — and must NEVER be
 * retried.  Retrying a 410 would loop forever; retrying a 409 would
 * incorrectly create duplicate member records.
 *
 * 5xx / network errors may be transient (proxy restart, momentary DB hiccup)
 * and are safe to retry up to MAX_INVITE_ACCEPT_ATTEMPTS times with
 * exponential backoff.
 */

export const MAX_INVITE_ACCEPT_ATTEMPTS = 3;

/**
 * Returns true when an HTTP status code represents a transient failure that
 * should be retried.  Returns false for any 4xx (client / authoritative error)
 * and for 200 OK (obviously not an error).
 */
export function isRetriableStatus(httpStatus: number): boolean {
  return httpStatus >= 500;
}

/**
 * Compute the delay (ms) before the nth retry attempt (0-indexed).
 * attempt=0 → no delay (first try), attempt=1 → 500 ms, attempt=2 → 1 000 ms.
 */
export function retryDelayMs(attempt: number): number {
  return attempt === 0 ? 0 : 500 * attempt;
}
