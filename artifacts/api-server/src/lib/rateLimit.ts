/**
 * In-memory sliding-window rate limiter.
 *
 * Each (key, limiterId) pair gets its own bucket: { count, windowStart }.
 * When the elapsed time since windowStart exceeds windowMs the bucket resets.
 *
 * Limits are configurable via environment variables:
 *   REPORT_RATE_LIMIT_PER_HOUR  (default 10)
 *   MUTE_RATE_LIMIT_PER_DAY     (default 50)
 *
 * The module exports two named limiters (reportRateLimit, muteRateLimit) as
 * thin wrappers, plus a low-level checkRateLimit() for custom limits.
 *
 * Test helpers: _resetRateLimit() clears buckets so tests start clean.
 */

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

const _buckets = new Map<string, Bucket>();

/**
 * Check and increment the rate limit for a key.
 *
 * @param limiterId  Stable identifier for this limiter (e.g. "report", "mute").
 * @param userId     Per-user bucket key.
 * @param limit      Maximum calls allowed per window.
 * @param windowMs   Window length in milliseconds.
 * @returns          { allowed, retryAfterMs } — retryAfterMs is 0 when allowed.
 */
export function checkRateLimit(
  limiterId: string,
  userId: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const key    = `${limiterId}:${userId}`;
  const now    = Date.now();
  const bucket = _buckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    _buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket.count >= limit) {
    const retryAfterMs = windowMs - (now - bucket.windowStart);
    return { allowed: false, retryAfterMs };
  }

  bucket.count++;
  return { allowed: true, retryAfterMs: 0 };
}

// ── Named limits (read from env at startup) ───────────────────────────────────

export const REPORT_HOURLY_LIMIT = parseInt(
  process.env.REPORT_RATE_LIMIT_PER_HOUR ?? "10",
  10,
);
export const REPORT_WINDOW_MS = 60 * 60 * 1_000; // 1 hour

export const MUTE_DAILY_LIMIT = parseInt(
  process.env.MUTE_RATE_LIMIT_PER_DAY ?? "50",
  10,
);
export const MUTE_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours

/** Check the per-user hourly report limit. */
export function reportRateLimit(userId: string): RateLimitResult {
  return checkRateLimit("report", userId, REPORT_HOURLY_LIMIT, REPORT_WINDOW_MS);
}

/** Check the per-user daily mute limit. */
export function muteRateLimit(userId: string): RateLimitResult {
  return checkRateLimit("mute", userId, MUTE_DAILY_LIMIT, MUTE_WINDOW_MS);
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Clear rate-limit buckets. Pass a limiterId+userId pair to clear one bucket,
 * or call with no arguments to clear all (use between tests).
 */
export function _resetRateLimit(limiterId?: string, userId?: string): void {
  if (limiterId && userId) {
    _buckets.delete(`${limiterId}:${userId}`);
  } else {
    _buckets.clear();
  }
}
