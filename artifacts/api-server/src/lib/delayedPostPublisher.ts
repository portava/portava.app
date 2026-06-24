/**
 * Delayed Post Publisher
 *
 * Background job that periodically checks for posts whose delayed-publish window
 * has elapsed and publishes them. Supports two pending states:
 *
 *   pending_location_exit — user has exited the geofence and the confirmation
 *     window has passed (publish_eligible_at is set by POST /api/location/exit-geofence)
 *
 *   pending_delay — user chose a fixed-time delay (publish_after_time ≤ now)
 *
 * Per-post failures are isolated — one bad post never blocks others. Worker health
 * is persisted to the job_health table under key 'delayed_post_publisher'.
 *
 * Configurable via DELAYED_POST_PUBLISH_INTERVAL_MINUTES (default 5).
 */

import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ job: "DelayedPostPublisher" });

// ── Config ────────────────────────────────────────────────────────────────────

export function parsePublishIntervalMinutes(raw: string | undefined): number {
  const parsed = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

const PUBLISH_INTERVAL_MINUTES = parsePublishIntervalMinutes(
  process.env.DELAYED_POST_PUBLISH_INTERVAL_MINUTES,
);

export const PUBLISH_INTERVAL_MS = PUBLISH_INTERVAL_MINUTES * 60 * 1_000;
export const PUBLISH_STARTUP_DELAY_MS = 60 * 1_000; // 1 min after boot

// ── Test-only client injection ────────────────────────────────────────────────

let _testClient: any = null;

export function _setTestClient(client: any | null): void {
  _testClient = client;
}

function resolveClient(): any | null {
  return _testClient ?? (isServiceClientReady ? getServiceClient() : null);
}

// ── Publish counter (for tests) ───────────────────────────────────────────────

export let _publishCallCount = 0;

// ── Core publish logic ────────────────────────────────────────────────────────

/**
 * Publish a single eligible post. Sets post_status='published', published_at=now(),
 * optionally copies public coordinates, and appends a 'published' event.
 */
async function publishPost(db: any, post: any): Promise<void> {
  const now = new Date().toISOString();

  // Reveal coordinates only when the user opted in to exact-location mode.
  // For city_only / hidden modes, public_lat/lng remain null.
  const revealCoords =
    post.location_privacy_mode === "none" ||
    post.location_privacy_mode === "delayed_until_exit" ||
    post.location_privacy_mode === "delayed_until_time";

  const patch: Record<string, unknown> = {
    post_status: "published",
    published_at: now,
  };
  if (revealCoords && post.original_lat != null) {
    patch.public_lat = post.original_lat;
    patch.public_lng = post.original_lng;
  }

  const { error } = await db
    .from("posts")
    .update(patch)
    .eq("id", post.id);

  if (error) {
    logger.warn({ err: error, postId: post.id }, "delayedPostPublisher: failed to publish post");
    return;
  }

  // Append published event (non-fatal)
  try {
    await db.from("delayed_post_location_events").insert({
      post_id: post.id,
      user_id: post.author_id,
      event_type: "published",
      metadata: { trigger: post.post_status, worker: true },
    });
  } catch { /* non-fatal */ }

  logger.info({ postId: post.id, mode: post.location_privacy_mode }, "delayedPostPublisher: post published");
}

/**
 * Check whether the post author has an active Safe Return session.
 * If so, the post is held until Safe Return completes or expires.
 */
async function hasActiveSafeReturn(db: any, userId: string): Promise<boolean> {
  try {
    const { data } = await db
      .from("safe_return_sessions")
      .select("id")
      .eq("user_id", userId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    return !!data;
  } catch {
    return false; // fail open — don't hold post forever on a DB error
  }
}

/**
 * Main worker tick: find all eligible posts and publish them.
 * Errors per post are isolated; the job never throws.
 */
export async function runDelayedPostPublisher(opts?: { client?: any }): Promise<{
  published: number;
  skipped: number;
  errors: number;
}> {
  _publishCallCount++;
  const db = opts?.client ?? resolveClient();

  if (!db) {
    logger.warn("delayedPostPublisher: service client not ready — skipping");
    return { published: 0, skipped: 0, errors: 0 };
  }

  const now = new Date().toISOString();

  // Query posts that are ready to publish
  const { data: posts, error: queryErr } = await db
    .from("posts")
    .select("id, author_id, location_privacy_mode, original_lat, original_lng, post_status")
    .in("post_status", ["pending_location_exit", "pending_delay"])
    .lte("publish_eligible_at", now);

  if (queryErr) {
    logger.error({ err: queryErr }, "delayedPostPublisher: query failed");
    await persistJobHealth(db, now);
    return { published: 0, skipped: 0, errors: 1 };
  }

  const eligible: any[] = posts ?? [];
  let published = 0;
  let skipped = 0;
  let errors = 0;

  for (const post of eligible) {
    try {
      // Hold post if user has active Safe Return
      const held = await hasActiveSafeReturn(db, post.author_id);
      if (held) {
        logger.info({ postId: post.id }, "delayedPostPublisher: holding — Safe Return active");
        skipped++;

        // Log worker_skipped event so operators can see holds
        await db.from("delayed_post_location_events").insert({
          post_id: post.id,
          user_id: post.author_id,
          event_type: "worker_skipped",
          metadata: { reason: "safe_return_active" },
        }).catch(() => {});

        continue;
      }

      await publishPost(db, post);
      published++;
    } catch (err) {
      logger.error({ err, postId: post.id }, "delayedPostPublisher: per-post error");
      errors++;
    }
  }

  logger.info({ published, skipped, errors }, "delayedPostPublisher: tick complete");
  await persistJobHealth(db, now);

  return { published, skipped, errors };
}

async function persistJobHealth(db: any, runAt: string): Promise<void> {
  try {
    await db
      .from("job_health")
      .upsert(
        { job: "delayed_post_publisher", last_run_at: runAt, updated_at: runAt },
        { onConflict: "job" },
      );
  } catch (err) {
    logger.warn({ err }, "delayedPostPublisher: could not persist job health");
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export function startDelayedPostPublisher(): ReturnType<typeof setInterval> {
  const initial = setTimeout(() => {
    runDelayedPostPublisher().catch(() => {});
  }, PUBLISH_STARTUP_DELAY_MS);

  const interval = setInterval(() => {
    runDelayedPostPublisher().catch(() => {});
  }, PUBLISH_INTERVAL_MS);

  interval.unref();
  if (typeof (initial as any).unref === "function") (initial as any).unref();

  logger.info(
    { intervalMinutes: PUBLISH_INTERVAL_MS / 60_000 },
    "delayedPostPublisher: scheduler started",
  );

  return interval;
}
