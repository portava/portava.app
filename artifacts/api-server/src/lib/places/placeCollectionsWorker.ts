/**
 * Place Collections Precompute Worker
 *
 * Maintains place_best_of, place_top_contributors, and place_living_cache so
 * popular destination pages are served from precomputed rows in milliseconds.
 *
 * Two loops run in parallel:
 *
 *   15-minute loop — claims rows from place_cache_invalidation_queue (written
 *     by enqueueLivingCacheInvalidation), recomputes best-of + contributors +
 *     living cache for each claimed place, marks the row 'done'.
 *
 *   60-minute sweep — selects place_living_cache rows older than 6 h for
 *     places with post_count > 20 and re-queues them (upsert).
 *
 * Schema alignment:
 *   place_cache_invalidation_queue — place_id UUID PRIMARY KEY (from 2047),
 *     extended with status/locked_until/locked_by by 2048 migration.
 *   place_top_contributors         — (place_id, user_id) PK, contribution_count.
 *   place_best_of                  — place_id PK, top_videos/photos/etc JSONB.
 *
 * place_top_contributors is a PUBLIC rail (routes/placeLiving serves it to
 * anonymous callers) and is built from the STRANGER-READABLE subset of a
 * place's posts; the place_contributor STAMP thresholds keep counting the full
 * active set. See computeContributors — the two must not be collapsed again.
 *
 * Pessimistic-lock pattern mirrors stamp_generation_queue: each claim sets
 * status='processing', locked_until = now + 5min, locked_by = WORKER_ID.
 * A stale-lock sweeper reclaims rows locked > 10 min.
 *
 * Gated by PLACE_COLLECTIONS_WORKER_ENABLED=true.
 *
 * Exported for tests:
 *   runCollectionsTick(scOverride?)  — one 15-min processing pass.
 *   runStaleSweep(scOverride?)       — one 60-min stale-cache sweep.
 *   _setTestAwardStamp(fn|null)      — inject fake stamp-award helper.
 */

import { randomUUID } from "crypto";
import { getServiceClient } from "../supabase.js";
import { placePostScore, isPublicPlaceRailPost } from "./placeCollections.js";

const WORKER_ID = `place-worker-${randomUUID()}`;

// ── Timing constants ──────────────────────────────────────────────────────────
const TICK_INTERVAL_MS         = 15 * 60 * 1_000;   // 15 minutes
const SWEEP_INTERVAL_MS        = 60 * 60 * 1_000;   // 60 minutes
const LOCK_DURATION_MS         = 5  * 60 * 1_000;   // 5-min pessimistic lock
const STALE_LOCK_THRESHOLD_MS  = 10 * 60 * 1_000;   // reclaim locks > 10 min old
const CLAIM_BATCH_SIZE         = 20;
const CACHE_STALE_HOURS        = 6;
const POST_COUNT_THRESHOLD     = 20;

// ── Best-of limits ────────────────────────────────────────────────────────────
const LIMIT_VIDEOS      = 25;
const LIMIT_PHOTOS      = 25;
const LIMIT_VIEWPOINTS  = 5;
const LIMIT_FOOD        = 10;
const LIMIT_EXPERIENCES = 10;

// ── Contributor thresholds for place_contributor stamp ────────────────────────
const STAMP_THRESHOLDS = [10, 50, 100] as const;

// ── Test injection hooks ──────────────────────────────────────────────────────

type AwardStampFn = (
  sc: any,
  input: { userId: string; definitionSlug: string; metadata?: Record<string, unknown> },
) => Promise<{ awarded: boolean; reason: string }>;

let _testAwardStamp: AwardStampFn | null = null;
/** Inject a fake awardStamp function in tests; pass null to restore. */
export function _setTestAwardStamp(fn: AwardStampFn | null): void {
  _testAwardStamp = fn;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lockedUntilIso(): string {
  return new Date(Date.now() + LOCK_DURATION_MS).toISOString();
}

function staleLockCutoffIso(): string {
  return new Date(Date.now() - STALE_LOCK_THRESHOLD_MS).toISOString();
}

function staleCacheCutoffIso(): string {
  return new Date(Date.now() - CACHE_STALE_HOURS * 60 * 60 * 1_000).toISOString();
}

// ── Best-of computation ───────────────────────────────────────────────────────

/** Classify a post by its media type and bucket tags. */
function classifyPost(row: any): "video" | "photo" | "viewpoint" | "food" | "experience" {
  const mt = (row.media_type ?? "").toLowerCase();
  const buckets: string[] = Array.isArray(row.post_buckets) ? row.post_buckets : [];

  if (mt.includes("video"))                            return "video";
  if (buckets.includes("hidden_angles"))               return "viewpoint";
  if (buckets.includes("food_nearby"))                 return "food";
  if (mt.includes("photo") || mt.includes("image"))    return "photo";
  return "experience";
}

function topN(arr: any[], limit: number): any[] {
  return [...arr].sort((a, b) => placePostScore(b) - placePostScore(a)).slice(0, limit);
}

function toItem(row: any): {
  postId: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  caption: string | null;
  score: number;
} {
  const mediaUrls = Array.isArray(row.media_urls) ? row.media_urls : [];
  return {
    postId:       row.id as string,
    mediaUrl:     (mediaUrls[0] ?? row.media_url ?? null) as string | null,
    thumbnailUrl: (row.media_thumbnail_url ?? null) as string | null,
    caption:      (row.content ?? null) as string | null,
    score:        placePostScore(row),
  };
}

function computeBestOf(posts: any[]): {
  top_videos:      ReturnType<typeof toItem>[];
  top_photos:      ReturnType<typeof toItem>[];
  top_viewpoints:  ReturnType<typeof toItem>[];
  food_nearby:     ReturnType<typeof toItem>[];
  top_experiences: ReturnType<typeof toItem>[];
} {
  const videos: any[]      = [];
  const photos: any[]      = [];
  const viewpoints: any[]  = [];
  const food: any[]        = [];
  const experiences: any[] = [];

  for (const row of posts) {
    switch (classifyPost(row)) {
      case "video":      videos.push(row);      break;
      case "viewpoint":  viewpoints.push(row);  break;
      case "food":       food.push(row);        break;
      case "photo":      photos.push(row);      break;
      default:           experiences.push(row); break;
    }
  }

  return {
    top_videos:      topN(videos,      LIMIT_VIDEOS).map(toItem),
    top_photos:      topN(photos,      LIMIT_PHOTOS).map(toItem),
    top_viewpoints:  topN(viewpoints,  LIMIT_VIEWPOINTS).map(toItem),
    food_nearby:     topN(food,        LIMIT_FOOD).map(toItem),
    top_experiences: topN(experiences, LIMIT_EXPERIENCES).map(toItem),
  };
}

// ── Stamp award (dynamic import so tests can inject a fake) ───────────────────

async function tryAwardStamp(
  sc: any,
  userId: string,
  placeId: string,
  threshold: number,
): Promise<void> {
  try {
    const awardFn = _testAwardStamp
      ?? (await import("../../services/passport/StampAwardEngine.js")).awardStamp;

    await awardFn(sc, {
      userId,
      definitionSlug: "place_contributor",
      metadata: { placeId, threshold },
    });
  } catch {
    // Stamp failure must never block cache write — best-effort only.
  }
}

// ── Contributor computation ───────────────────────────────────────────────────
// Schema: place_top_contributors(place_id, user_id, contribution_count, updated_at)
// PK: (place_id, user_id) — no rank column.
// Posts use author_id for the post author; we surface it as user_id in place_top_contributors.
//
// TWO CONSUMERS, TWO POST SETS. This used to be one count driving both, and
// that was a privacy defect:
//
//   • place_top_contributors is a PUBLIC rail. routes/placeLiving serves
//     `topContributor { userId, displayName, avatarUrl, contributionCount }` on
//     the anonymous living page (no viewer, service-role client, RLS bypassed).
//     Counting every `status = 'active'` post meant a user whose only posts at a
//     venue were `private` — or still `pending_location_exit`, i.e. a delayed
//     post whose author has not left yet — was publicly named as that venue's
//     top contributor. That is the same "this person is at this place"
//     disclosure the visibility tiers and delayed geotagging exist to prevent,
//     and it is the one read on that page that was NOT visibility-gated
//     (placeLiving gates its own post sample and rating rolls-up already).
//     ⇒ built from the STRANGER-READABLE subset (isPublicPlaceRailPost).
//
//   • the place_contributor STAMP is a private, earned credit awarded to the
//     author themselves. Its thresholds have always counted the author's own
//     work at the place, private posts included, and narrowing that set would
//     silently retire stamps people have already earned and stop future ones.
//     ⇒ built from the FULL active set, byte-for-byte as before.
//
// Neither rule is imposed on the other: one fetch, two derivations.

type ContributorCount = [userId: string, postCount: number];

/** Posts-per-author over an already-fetched batch, in first-seen order. */
function countByAuthor(posts: any[]): Map<string, number> {
  const countMap = new Map<string, number>();
  for (const row of posts) {
    if (!row.author_id) continue;
    countMap.set(row.author_id, (countMap.get(row.author_id) ?? 0) + 1);
  }
  return countMap;
}

/** Top 3 by count. Sort is stable, so equal counts keep first-seen order. */
function top3ByCount(countMap: Map<string, number>): ContributorCount[] {
  return [...countMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
}

/**
 * Remove every place_top_contributors row for this place that the new public
 * top-3 does not contain.
 *
 * Without this the fix would not actually fix anything: the write path is an
 * UPSERT and routes/placeLiving reads `ORDER BY contribution_count DESC LIMIT 1`
 * with NO staleness check at all, so a row baked from private posts before this
 * change — or a contributor who has since made their posts private — would keep
 * being served as the public top contributor forever. Best-effort: a prune
 * failure is logged, never thrown, and never blocks the stamp award below.
 */
async function pruneContributors(
  sc: any,
  placeId: string,
  keepUserIds: string[],
): Promise<void> {
  try {
    let q = sc.from("place_top_contributors").delete().eq("place_id", placeId);
    if (keepUserIds.length > 0) {
      q = q.not("user_id", "in", `(${keepUserIds.join(",")})`);
    }
    const { error } = await q;
    if (error) {
      console.warn(JSON.stringify({
        event:    "place_collections.contributor_prune_error",
        place_id: placeId,
        error:    error.message,
      }));
    }
  } catch (err) {
    console.warn(JSON.stringify({
      event:    "place_collections.contributor_prune_error",
      place_id: placeId,
      error:    err instanceof Error ? err.message : String(err),
    }));
  }
}

async function computeContributors(
  sc: any,
  placeId: string,
  posts: any[],
): Promise<void> {
  // ── A. PUBLIC RAIL — stranger-readable, published posts only ───────────────
  const railTop3 = top3ByCount(countByAuthor(posts.filter((r) => isPublicPlaceRailPost(r))));

  const nowIso = new Date().toISOString();

  for (const [userId, postCount] of railTop3) {
    const { error: upsertErr } = await sc
      .from("place_top_contributors")
      .upsert(
        {
          place_id:           placeId,
          user_id:            userId,
          contribution_count: postCount,
          updated_at:         nowIso,
        },
        { onConflict: "place_id,user_id" },
      );

    if (upsertErr) {
      console.warn(JSON.stringify({
        event:    "place_collections.contributor_upsert_error",
        place_id: placeId,
        user_id:  userId,
        error:    upsertErr.message,
      }));
    }
  }

  // Drop anyone the gated recompute no longer credits (including everyone, when
  // a place has no publicly-readable posts left).
  await pruneContributors(sc, placeId, railTop3.map(([userId]) => userId));

  // ── B. STAMP THRESHOLDS — the full active set, unchanged ───────────────────
  // Same source set, same top-3 selection, same counts, same thresholds and the
  // same call order as before the rail was split off. The early return below is
  // the old `if (countMap.size === 0) return` — it guarded the stamp loop, so it
  // stays on the stamp side; the rail is pruned above regardless.
  const stampTop3 = top3ByCount(countByAuthor(posts));
  if (stampTop3.length === 0) return;

  for (const [userId, postCount] of stampTop3) {
    // Award stamp at each threshold the contributor has crossed.
    // The stamp award engine deduplicates via (user:def:sourceType:sourceId)
    // so repeated calls for the same (userId, threshold) are idempotent.
    for (const threshold of STAMP_THRESHOLDS) {
      if (postCount >= threshold) {
        await tryAwardStamp(sc, userId, placeId, threshold);
      }
    }
  }
}

// ── Stale-lock sweeper ────────────────────────────────────────────────────────

async function reclaimStaleLocks(sc: any): Promise<void> {
  const cutoff = staleLockCutoffIso();
  const { error } = await sc
    .from("place_cache_invalidation_queue")
    .update({ status: "pending", locked_until: null, locked_by: null })
    .eq("status", "processing")
    .lt("locked_until", cutoff);

  if (error) {
    console.warn(JSON.stringify({
      event: "place_collections.stale_lock_reclaim_error",
      error: error.message,
    }));
  }
}

// ── Core tick (15-minute loop) ────────────────────────────────────────────────

export interface CollectionsTickResult {
  claimed:   number;
  processed: number;
  errors:    number;
}

/**
 * One processing pass of the 15-minute queue-drain loop.
 * Exported so tests can inject a fake client and assert logic without a timer.
 * Never throws.
 */
export async function runCollectionsTick(scOverride?: any): Promise<CollectionsTickResult> {
  const result: CollectionsTickResult = { claimed: 0, processed: 0, errors: 0 };
  const sc = scOverride ?? getServiceClient();
  if (!sc) return result;

  // 0. Reclaim any stale locks from a previous crashed worker.
  await reclaimStaleLocks(sc);

  // 1. Claim up to CLAIM_BATCH_SIZE pending rows with a pessimistic lock.
  //    place_id is the PK so we use it as the lock key.
  //    Guard: only rows where locked_until is NULL or already expired — this
  //    prevents re-claiming a row whose status was reset to 'pending' by a
  //    concurrent enqueue while a live worker still holds the lock.
  const nowIso = new Date().toISOString();
  const { data: rows, error: claimQueryErr } = await sc
    .from("place_cache_invalidation_queue")
    .select("place_id, queued_at")
    .eq("status", "pending")
    .or(`locked_until.is.null,locked_until.lt.${nowIso}`)
    .order("queued_at", { ascending: true })
    .limit(CLAIM_BATCH_SIZE);

  if (claimQueryErr) {
    console.error(JSON.stringify({
      event: "place_collections.claim_query_error",
      error: claimQueryErr.message,
    }));
    return result;
  }

  const batch = ((rows ?? []) as Array<{ place_id: string; queued_at: string }>);
  if (batch.length === 0) return result;

  const placeIds = batch.map((r) => r.place_id);
  const nowLockedUntil = lockedUntilIso();

  // Atomic claim via UPDATE + RETURNING: only rows whose status is still
  // 'pending' at UPDATE time are returned.  In a multi-instance deployment,
  // two workers may read the same pending batch; whichever worker's UPDATE
  // runs second finds those rows already 'processing' and receives an empty
  // set — so it processes nothing.  We must trust this returned set, not the
  // pre-lock select batch.
  const { data: claimedData, error: lockErr } = await sc
    .from("place_cache_invalidation_queue")
    .update({
      status:       "processing",
      locked_until: nowLockedUntil,
      locked_by:    WORKER_ID,
    })
    .in("place_id", placeIds)
    .eq("status", "pending")      // guard: only rows still 'pending' at UPDATE time
    .select("place_id, queued_at"); // RETURNING — includes queued_at for version check

  if (lockErr) {
    console.error(JSON.stringify({
      event: "place_collections.lock_error",
      error: lockErr.message,
    }));
    return result;
  }

  // Use only the rows this worker actually locked (RETURNING result).
  // queued_at is the version token used in mark-done to detect mid-flight
  // invalidations: if a new enqueue arrived during processing, queued_at will
  // have changed and mark-done will refuse to overwrite the pending signal.
  const claimed = ((claimedData ?? []) as Array<{ place_id: string; queued_at: string }>);
  result.claimed = claimed.length;

  if (claimed.length === 0) return result;

  // 2. Process each place this worker exclusively claimed.
  for (const row of claimed) {
    try {
      await processPlace(sc, row.place_id, row.queued_at);
      result.processed++;
    } catch (err) {
      result.errors++;
      console.error(JSON.stringify({
        event:    "place_collections.process_error",
        place_id: row.place_id,
        error:    err instanceof Error ? err.message : String(err),
      }));
      // Leave the row in 'processing' — stale-lock sweeper will reclaim it.
    }
  }

  console.log(JSON.stringify({
    event:     "place_collections.tick_complete",
    claimed:   result.claimed,
    processed: result.processed,
    errors:    result.errors,
    worker_id: WORKER_ID,
  }));

  return result;
}

/**
 * Process one place: fetch posts, compute best-of + contributors, write cache,
 * mark queue row 'done'.
 *
 * claimedQueuedAt — the queued_at value recorded at claim time (version token).
 * Mark-done checks locked_by = WORKER_ID AND queued_at = claimedQueuedAt.
 * If a new invalidation arrived during processing (enqueue updated queued_at),
 * mark-done returns 0 rows and the row stays 'pending' — no invalidation lost.
 */
async function processPlace(sc: any, placeId: string, claimedQueuedAt: string): Promise<void> {
  const nowIso = new Date().toISOString();

  // Fetch all active posts for this place with engagement metrics.
  // Limit 5 000 — Supabase default cap is 1 000 without an explicit limit.
  //
  // The gate columns (author_id / trip_id / visibility / post_status) ride along
  // because the consumers below need DIFFERENT sets: place_top_contributors is a
  // PUBLIC rail and must see only stranger-readable, published posts, while the
  // place_contributor stamp keeps counting every active post at the place as it
  // always has. That is why the visibility/publication predicate is applied in
  // memory in computeContributors rather than narrowed at the query — one read,
  // two rules, neither imposed on the other.
  //
  // PostgREST returns ONLY the projected columns, so a column omitted here reads
  // back `undefined` and isPublicPlaceRailPost would treat it as a legacy row:
  // visibility must be projected or the gate silently passes everything.
  const { data: postRows, error: postErr } = await sc
    .from("posts")
    .select(
      "id, author_id, trip_id, visibility, post_status, content, media_type, " +
      "media_urls, media_thumbnail_url, " +
      "post_buckets, like_count, save_count, share_count, view_count, qualified_view_count",
    )
    .eq("canonical_place_id", placeId)
    .eq("status", "active")
    .limit(5_000);

  if (postErr) {
    throw new Error(`posts fetch failed: ${postErr.message}`);
  }

  const posts = ((postRows ?? []) as any[]);

  // A. Best-of computation → upsert place_best_of.
  const bestOf = computeBestOf(posts);

  const { error: bestOfErr } = await sc
    .from("place_best_of")
    .upsert(
      { place_id: placeId, ...bestOf, updated_at: nowIso },
      { onConflict: "place_id" },
    );

  if (bestOfErr) {
    throw new Error(`place_best_of upsert failed: ${bestOfErr.message}`);
  }

  // B. Contributor computation (best-effort; errors logged, not re-thrown).
  try {
    await computeContributors(sc, placeId, posts);
  } catch (contribErr) {
    console.warn(JSON.stringify({
      event:    "place_collections.contributor_error",
      place_id: placeId,
      error:    contribErr instanceof Error ? contribErr.message : String(contribErr),
    }));
  }

  // C. Assemble a living-page cache payload and write place_living_cache.
  //    assembleLivingPage is exported by Task 5 (placeLiving.ts). Cast as
  //    `any` so TypeScript doesn't reject the forward reference; the
  //    try/catch absorbs the "not a function" case when Task 5 is absent.
  try {
    const mod = await import("../../routes/placeLiving.js") as any;
    const living = await mod.assembleLivingPage?.(sc, placeId, { skipCache: true });
    if (living) {
      const { error: cacheErr } = await sc
        .from("place_living_cache")
        .upsert(
          { place_id: placeId, payload: living, cached_at: nowIso },
          { onConflict: "place_id" },
        );
      if (cacheErr) {
        console.warn(JSON.stringify({
          event:    "place_collections.living_cache_write_error",
          place_id: placeId,
          error:    cacheErr.message,
        }));
      }
    }
  } catch {
    // assembleLivingPage not yet available or failed — skip gracefully.
  }

  // D. Mark queue row 'done' — conditional on two guards:
  //   1. locked_by = WORKER_ID   → ownership: only this worker may finalise its row.
  //   2. queued_at = claimedQueuedAt → version: if a new invalidation arrived during
  //      processing (enqueue updated queued_at), the row stays pending so the next
  //      tick re-processes it; no mid-flight invalidation is silently dropped.
  const { data: doneRows, error: doneErr } = await sc
    .from("place_cache_invalidation_queue")
    .update({ status: "done", locked_until: null, locked_by: null })
    .eq("place_id",  placeId)
    .eq("locked_by", WORKER_ID)
    .eq("queued_at", claimedQueuedAt)
    .select("place_id");

  if (doneErr) {
    console.warn(JSON.stringify({
      event:    "place_collections.mark_done_error",
      place_id: placeId,
      error:    doneErr.message,
    }));
  } else if (((doneRows ?? []) as any[]).length === 0) {
    // 0 rows updated: either a new invalidation changed queued_at (row is now
    // 'pending' again and will be re-processed on the next tick) or another
    // worker claimed the row.  Both cases are safe — log for observability.
    console.log(JSON.stringify({
      event:    "place_collections.mark_done_skipped",
      place_id: placeId,
      reason:   "queued_at changed mid-flight or lock stolen — row preserved for re-processing",
    }));
  }
}

// ── Hourly stale-cache sweep ──────────────────────────────────────────────────

/**
 * Select place_living_cache rows older than CACHE_STALE_HOURS for places with
 * post_count > POST_COUNT_THRESHOLD and re-queue them.
 * Exported so tests can call it directly.
 * Never throws.
 */
export async function runStaleSweep(scOverride?: any): Promise<{ requeued: number }> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return { requeued: 0 };

  const cutoff = staleCacheCutoffIso();

  const { data: staleRows, error: staleErr } = await sc
    .from("place_living_cache")
    .select("place_id, places!inner(post_count)")
    .lt("cached_at", cutoff)
    .gt("places.post_count", POST_COUNT_THRESHOLD)
    .limit(200);

  if (staleErr) {
    console.warn(JSON.stringify({
      event: "place_collections.stale_sweep_query_error",
      error: staleErr.message,
    }));
    return { requeued: 0 };
  }

  const rows = (staleRows ?? []) as Array<{ place_id: string }>;
  if (rows.length === 0) return { requeued: 0 };

  const nowIso = new Date().toISOString();
  let requeued = 0;

  for (const row of rows) {
    // Upsert back to pending — if already pending, just refresh queued_at.
    // If processing, this re-asserts pending so the next tick re-claims it.
    const { error: upsertErr } = await sc
      .from("place_cache_invalidation_queue")
      .upsert(
        { place_id: row.place_id, queued_at: nowIso, status: "pending" },
        { onConflict: "place_id" },
      );

    if (upsertErr) {
      console.warn(JSON.stringify({
        event:    "place_collections.stale_requeue_error",
        place_id: row.place_id,
        error:    upsertErr.message,
      }));
    } else {
      requeued++;
    }
  }

  console.log(JSON.stringify({
    event:    "place_collections.stale_sweep_complete",
    requeued,
    cutoff,
  }));

  return { requeued };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the place collections precompute worker.
 * Gated by PLACE_COLLECTIONS_WORKER_ENABLED=true.
 * Returns the interval handles so tests can cancel them.
 */
export function startPlaceCollectionsWorker(): {
  tickInterval:  ReturnType<typeof setInterval> | null;
  sweepInterval: ReturnType<typeof setInterval> | null;
} {
  if (process.env.PLACE_COLLECTIONS_WORKER_ENABLED !== "true") {
    console.log(JSON.stringify({
      event: "place_collections.worker_disabled",
      note:  "Set PLACE_COLLECTIONS_WORKER_ENABLED=true to enable",
    }));
    return { tickInterval: null, sweepInterval: null };
  }

  // Run initial tick + sweep after a short startup delay.
  const STARTUP_DELAY_MS = 2 * 60 * 1_000; // 2 min — let other init finish
  const startupTimer = setTimeout(() => {
    void runCollectionsTick().catch((err) =>
      console.warn(JSON.stringify({
        event: "place_collections.initial_tick_error",
        error: err instanceof Error ? err.message : String(err),
      })),
    );
    void runStaleSweep().catch((err) =>
      console.warn(JSON.stringify({
        event: "place_collections.initial_sweep_error",
        error: err instanceof Error ? err.message : String(err),
      })),
    );
  }, STARTUP_DELAY_MS);
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  const tickInterval = setInterval(() => {
    void runCollectionsTick().catch((err) =>
      console.warn(JSON.stringify({
        event: "place_collections.tick_error",
        error: err instanceof Error ? err.message : String(err),
      })),
    );
  }, TICK_INTERVAL_MS);
  tickInterval.unref();

  const sweepInterval = setInterval(() => {
    void runStaleSweep().catch((err) =>
      console.warn(JSON.stringify({
        event: "place_collections.sweep_error",
        error: err instanceof Error ? err.message : String(err),
      })),
    );
  }, SWEEP_INTERVAL_MS);
  sweepInterval.unref();

  console.log(JSON.stringify({
    event:              "place_collections.worker_started",
    tick_interval_min:  TICK_INTERVAL_MS  / 60_000,
    sweep_interval_min: SWEEP_INTERVAL_MS / 60_000,
    worker_id:          WORKER_ID,
  }));

  return { tickInterval, sweepInterval };
}
