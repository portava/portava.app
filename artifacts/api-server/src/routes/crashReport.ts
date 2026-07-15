import { Router } from "express";
import { z } from "zod";

const router = Router();

// ── Constants (env-configurable) ──────────────────────────────────────────────

function parsePositiveInt(value: string | undefined, defaultVal: number): number {
  const parsed = parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultVal;
}

const WINDOW_MS   = parsePositiveInt(process.env.CRASH_REPORT_WINDOW_MS,  60_000);
const MAX_REPORTS = parsePositiveInt(process.env.CRASH_REPORT_MAX_REPORTS, 10);

// ── Redis client (optional) ───────────────────────────────────────────────────

/**
 * We import ioredis lazily so the module still loads in environments where
 * REDIS_URL is not set (the Redis client constructor would throw on a bad URL).
 * If REDIS_URL is absent or Redis becomes unavailable the limiter falls back
 * to the in-memory store transparently (fail-open).
 */
let _redis: import("ioredis").Redis | null = null;

async function getRedis(): Promise<import("ioredis").Redis | null> {
  const url = process.env.REDIS_URL;
  if (!url) return null;

  if (_redis) return _redis;

  try {
    const { default: Redis } = await import("ioredis");
    const client = new Redis(url, {
      lazyConnect:            true,
      enableReadyCheck:       true,
      maxRetriesPerRequest:   1,
      connectTimeout:         2000,
      commandTimeout:         1000,
    });
    await client.connect();
    _redis = client;
    return _redis;
  } catch {
    return null;
  }
}

// ── In-memory fallback store ──────────────────────────────────────────────────

const _store = new Map<string, number[]>();

// ── Sliding-window implementations ────────────────────────────────────────────

/**
 * Redis sliding-window check using a sorted set.
 * Score = timestamp (ms), members are unique per hit (timestamp + random).
 * Returns true (allowed) or false (rate-limited).
 * Throws on Redis errors so the caller can fall back to in-memory.
 */
async function checkRateLimitRedis(
  redis: import("ioredis").Redis,
  key: string,
): Promise<boolean> {
  const now    = Date.now();
  const cutoff = now - WINDOW_MS;
  const member = `${now}:${Math.random().toString(36).slice(2)}`;
  const ttlSec = Math.ceil(WINDOW_MS / 1000);

  const pipe = redis.pipeline();
  pipe.zremrangebyscore(key, "-inf", cutoff);   // evict expired
  pipe.zadd(key, now, member);                   // record this hit
  pipe.zcard(key);                               // count in window
  pipe.expire(key, ttlSec);                      // sliding TTL
  const results = await pipe.exec();

  // results[2] is [err, count] for ZCARD
  const countResult = results?.[2];
  const count = (countResult && countResult[0] == null)
    ? (countResult[1] as number)
    : MAX_REPORTS + 1; // assume over-limit on error

  if (count > MAX_REPORTS) {
    // undo the hit we just added
    await redis.zrem(key, member).catch(() => {});
    return false;
  }
  return true;
}

/** In-memory sliding-window fallback. */
function checkRateLimitMemory(key: string): boolean {
  const now  = Date.now();
  const cut  = now - WINDOW_MS;
  const hits = (_store.get(key) ?? []).filter((t) => t > cut);
  if (hits.length >= MAX_REPORTS) {
    _store.set(key, hits);
    return false;
  }
  hits.push(now);
  _store.set(key, hits);
  return true;
}

async function checkRateLimit(key: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    if (redis) {
      return await checkRateLimitRedis(redis, `crash_rl:${key}`);
    }
  } catch {
    // fall through to in-memory
  }
  return checkRateLimitMemory(key);
}

// ── Test seam ─────────────────────────────────────────────────────────────────

/**
 * Clears the in-memory fallback store and, when a Redis client is connected,
 * deletes all crash-report rate-limit keys so tests start clean regardless of
 * which backend is active.
 */
export async function _resetRateLimiter(): Promise<void> {
  _store.clear();
  if (_redis) {
    try {
      const keys = await _redis.keys("crash_rl:*");
      if (keys.length) await _redis.del(...keys);
    } catch {
      // ignore
    }
  }
}

// ── Schema ────────────────────────────────────────────────────────────────────

const CrashReportBody = z.object({
  timestamp:      z.string().optional(),
  errorMessage:   z.string().max(2000),
  errorStack:     z.string().max(10000).optional(),
  componentStack: z.string().max(10000),
  userId:         z.string().max(200).optional(),
});

/**
 * POST /crash-report
 *
 * Receives a client-side render crash from the mobile app's ErrorBoundary and
 * writes it to the server log so it appears in EAS build logs and any log
 * aggregator connected to the API server.
 *
 * No auth required — crashes may occur before the user has signed in.
 * Only the opaque userId is accepted; no email, name, or other PII.
 *
 * Rate limited to MAX_REPORTS per IP per WINDOW_MS to prevent log flooding
 * from devices stuck in a crash loop.  The limit state is persisted in Redis
 * (when REDIS_URL is set) so it survives server restarts and works across
 * multiple instances.  Falls back to in-memory when Redis is unavailable.
 */
router.post("/crash-report", async (req, res) => {
  const key = (req.ip ?? "unknown").replace(/^::ffff:/, "");

  const allowed = await checkRateLimit(key).catch(() => true); // fail-open
  if (!allowed) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const parsed = CrashReportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_payload" });
    return;
  }

  const { timestamp, errorMessage, errorStack, componentStack, userId } =
    parsed.data;

  req.log.error(
    { errorMessage, componentStack, userId, timestamp, errorStack },
    "client crash report",
  );

  res.json({ ok: true });
});

export default router;
