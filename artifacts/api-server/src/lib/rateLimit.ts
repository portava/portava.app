/**
 * Rate limiter — fixed-window counters, optionally backed by Redis.
 *
 * BACKENDS
 *   - In-memory Map (default): per-process, best-effort only. With N server
 *     instances a client effectively gets N× the budget, and a restart clears
 *     all history.
 *   - Redis (when REDIS_URL is set and reachable): shared counters via the
 *     classic INCR + EXPIRE fixed-window pattern, so all instances count
 *     against the same budget. Uses the same ioredis dependency as
 *     routes/crashReport.ts.
 *
 * SYNC API + ASYNC REDIS — the exported functions are synchronous (dozens of
 * call sites depend on that), so the Redis round-trip cannot block the
 * decision. Instead each call:
 *   1. decides synchronously from the local bucket (window-aligned so every
 *      instance agrees on window boundaries), and
 *   2. fires INCR/EXPIRE at Redis in the background; when the reply arrives,
 *      the local bucket adopts the shared count if it is higher.
 * The result is near-real-time cross-instance enforcement (one round-trip of
 * lag) with zero added request latency, and a transparent fall back to pure
 * in-memory behaviour when Redis is absent or down (fail-open, like
 * crashReport.ts). Any limit that must be an exact hard ceiling across
 * instances MUST still be enforced against the DB — see the call-start limit:
 * callPermissionEngine.ts's DB-counted `startsInLastHour` remains the
 * authoritative cross-instance ceiling.
 *
 * Limits are configurable via environment variables:
 *   REPORT_RATE_LIMIT_PER_HOUR             (default 10)
 *   MUTE_RATE_LIMIT_PER_DAY                (default 50)
 *   MODERATION_REPORT_RATE_LIMIT_PER_DAY   (default 10)
 *
 * The module exports named limiters (reportRateLimit, muteRateLimit,
 * moderationReportRateLimit) as thin wrappers, plus a low-level
 * checkRateLimit() for custom limits.
 *
 * Test helpers: _resetRateLimit() clears local buckets so tests start clean
 * (tests run without REDIS_URL, so no Redis state is involved).
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

// ── Optional Redis backend (lazy, fail-open) ──────────────────────────────────

type RedisClient = import("ioredis").Redis;

let _redis: RedisClient | null = null;
let _redisInitInFlight = false;
let _redisLastAttemptAt = 0;
const REDIS_RETRY_COOLDOWN_MS = 30_000;

/**
 * Kick off the Redis connection in the background (never blocks a request).
 * Mirrors the lazy-import approach in routes/crashReport.ts so the module
 * still loads when REDIS_URL is unset or ioredis cannot connect. Failed
 * connections are retried at most every REDIS_RETRY_COOLDOWN_MS.
 */
function ensureRedis(): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  if (_redis) return _redis;
  if (_redisInitInFlight) return null;
  if (Date.now() - _redisLastAttemptAt < REDIS_RETRY_COOLDOWN_MS) return null;

  _redisInitInFlight = true;
  _redisLastAttemptAt = Date.now();
  void (async () => {
    try {
      const { default: Redis } = await import("ioredis");
      const client = new Redis(url, {
        lazyConnect:          true,
        enableReadyCheck:     true,
        maxRetriesPerRequest: 1,
        connectTimeout:       2000,
        commandTimeout:       1000,
      });
      await client.connect();
      _redis = client;
    } catch {
      // fail-open: stay on the in-memory backend; retry after cooldown
      _redis = null;
    } finally {
      _redisInitInFlight = false;
    }
  })();
  return null;
}

/**
 * Background sync of one hit into the shared Redis counter. On reply, adopt
 * the shared count into the local bucket when it is higher, so traffic on
 * other instances counts against this instance's next decision.
 */
function syncHitToRedis(
  redis: RedisClient,
  bucketKey: string,
  windowStart: number,
  windowMs: number,
): void {
  const redisKey = `rl:${bucketKey}:${windowStart}`;
  const ttlSec = Math.ceil(windowMs / 1000) + 1;
  void redis
    .incr(redisKey)
    .then(async (sharedCount: number) => {
      if (sharedCount === 1) {
        await redis.expire(redisKey, ttlSec).catch(() => {});
      }
      const bucket = _buckets.get(bucketKey);
      if (bucket && bucket.windowStart === windowStart && sharedCount > bucket.count) {
        bucket.count = sharedCount;
      }
    })
    .catch(() => {
      /* fail-open: Redis unavailable → in-memory behaviour only */
    });
}

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
  const key   = `${limiterId}:${userId}`;
  const now   = Date.now();
  const redis = ensureRedis();

  // With Redis, align windows to epoch multiples so every instance uses the
  // same window boundaries (required for a shared fixed-window counter).
  // Without Redis, keep the original first-hit-anchored window behaviour.
  const alignedStart = redis ? now - (now % windowMs) : now;

  let bucket = _buckets.get(key);
  const expired = !bucket ||
    (redis ? bucket.windowStart !== alignedStart : now - bucket.windowStart >= windowMs);

  if (expired) {
    bucket = { count: 1, windowStart: alignedStart };
    _buckets.set(key, bucket);
    if (redis) syncHitToRedis(redis, key, alignedStart, windowMs);
    return { allowed: true, retryAfterMs: 0 };
  }

  if (bucket!.count >= limit) {
    const retryAfterMs = windowMs - (now - bucket!.windowStart);
    return { allowed: false, retryAfterMs };
  }

  bucket!.count++;
  if (redis) syncHitToRedis(redis, key, bucket!.windowStart, windowMs);
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

// ── Moderation report rate limit (24-hour window) ─────────────────────────────

export const MODERATION_REPORT_DAILY_LIMIT = parseInt(
  process.env.MODERATION_REPORT_RATE_LIMIT_PER_DAY ?? "10",
  10,
);
export const MODERATION_REPORT_WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours

/** Check the per-user daily moderation-report limit (10 per 24 h). */
export function moderationReportRateLimit(userId: string): RateLimitResult {
  return checkRateLimit(
    "moderation_report",
    userId,
    MODERATION_REPORT_DAILY_LIMIT,
    MODERATION_REPORT_WINDOW_MS,
  );
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/**
 * Clear rate-limit buckets. Pass a limiterId+userId pair to clear one bucket,
 * or call with no arguments to clear all (use between tests).
 * Only clears LOCAL buckets — tests run without REDIS_URL so there is no
 * shared state to clear.
 */
export function _resetRateLimit(limiterId?: string, userId?: string): void {
  if (limiterId && userId) {
    _buckets.delete(`${limiterId}:${userId}`);
  } else {
    _buckets.clear();
  }
}
