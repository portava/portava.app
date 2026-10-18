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
 *   60-minute sweep — walks overdue place_best_of rows oldest-first in keyset
 *     pages, busy places first within a bounded share (owner ruling 2026-10-17).
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
const POST_COUNT_THRESHOLD     = 20; // a place is "active" for the stale sweep above this many active posts

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

function staleCacheCutoffIso(nowMs: number): string {
  return new Date(nowMs - CACHE_STALE_HOURS * 60 * 60 * 1_000).toISOString();
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
    return { ...result, errors: 1 }; // a pass that could not read its queue failed (the overdue sweep's drain counts it)
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
    return { ...result, errors: 1 }; // a pass that could not lock its batch failed, likewise
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
  // because the consumers below need DIFFERENT sets:
  //
  //   • place_best_of — a PUBLIC rail: only stranger-readable, published posts.
  //   • place_top_contributors — also a PUBLIC rail: same stranger-readable,
  //     published subset, for both the top-3 selection and contribution_count.
  //   • the place_contributor STAMP — keeps counting every active post at the
  //     place as it always has, private and pending posts included.
  //
  // That is why the visibility/publication predicate is applied in memory (here
  // for Best-Of, and inside computeContributors for the rail-vs-stamp split)
  // rather than narrowed at the query — one read, three rules, none imposed on
  // the others.
  //
  // PostgREST returns ONLY the projected columns, so a column omitted here reads
  // back `undefined` and isPublicPlaceRailPost would treat it as a legacy row:
  // visibility must be projected or the gate silently passes everything.
  const { data: postRows, error: postErr } = await sc
    .from("posts")
    .select(
      "id, author_id, trip_id, visibility, post_status, content, media_type, " +
      "media_urls, media_thumbnail_url, " +
      // view_count / qualified_view_count are NOT columns of `posts` (verified
      // against the live CI schema 2026-09-06: the table has post_buckets,
      // like_count, save_count, share_count, media_type, media_urls and no view
      // counters at all). PostgREST fails the WHOLE select on an unknown column,
      // so naming them meant this read returned 42703 every time and the
      // collections worker's ranking has never seen a single row. Nothing in
      // this file ever consumed either value — they were selected and dropped.
      "post_buckets, like_count, save_count, share_count, location_privacy_mode", // census-media §43: isPublicPlaceRailPost reads the owner's mode for both public rails (Best-Of, top contributors); the stamp count below does not
    )
    .eq("canonical_place_id", placeId)
    .eq("status", "active")
    .limit(5_000);

  if (postErr) {
    throw new Error(`posts fetch failed: ${postErr.message}`);
  }

  const posts = ((postRows ?? []) as any[]);

  // A. Best-of computation → upsert place_best_of.
  //
  // THE SAME GATES getBestOf's realtime path applies (lib/postVisibility, via
  // isPublicPlaceRailPost), because this worker WRITES `place_best_of` and
  // getBestOf serves that cache FIRST — a post the realtime path refuses but the
  // cache baked in is served all the same, so gating only the fallback would fix
  // nothing in practice. `status = 'active'` is not a publication filter (a
  // delayed post is written active + pending), and there was no visibility
  // filter at all, so a private / trip_only post attached to this place was
  // cached onto its public rails.
  const bestOf = computeBestOf(posts.filter((r) => isPublicPlaceRailPost(r)));

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
  } catch (err) {
    // assembleLivingPage not yet available, or the dynamic import failed. Note
    // this catch does NOT cover a refused cache write — supabase-js resolves on
    // a database error, so that arrives as `cacheErr` above and is handled
    // there. Skipping stays graceful (the worker must survive one bad place),
    // but a place whose living page can never be assembled is now visible
    // instead of being indistinguishable from a place that simply has no page.
    console.warn(JSON.stringify({
      event:    "place_collections.living_page_assemble_error",
      place_id: placeId,
      error:    err instanceof Error ? err.message : String(err),
    }));
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

// ── Hourly overdue sweep (owner ruling 2026-10-17) ────────────────────────────
//
// THE RULING ("Place-collection refresh limit"). The hourly refresh examined
// only the 200 most recently stale places, so once more than 200 were stale some
// were skipped run after run. Required: the longest-waiting places first, in
// paginated batches; busy places first WITHOUT starving quiet ones; the backlog
// continues by itself; refresh failures, backlog size and maximum waiting time
// tracked; capacity that grows with the backlog.
//
// WHAT "OVERDUE" MEANS, AND WHY IT IS place_best_of.updated_at. A refresh is
// processPlace, run by the queue: it rebuilds place_best_of (step A, which
// throws when it cannot write) and place_top_contributors. It does NOT rebuild
// place_living_cache: step C imports `assembleLivingPage` from
// routes/placeLiving.ts, and that module exports no such function (its
// assembler, assembleLivingPayload, is module-private), so `living` is always
// undefined and the write never happens. The route rebuilds that cache itself
// when a page is viewed. A backlog keyed on place_living_cache.cached_at could
// therefore never drain: a place this sweep refreshed would stay "stale" until
// someone opened its page, and an oldest-first walk would start on the same
// already-refreshed places every run. place_best_of.updated_at is the instant a
// refresh really advances, so a refreshed place leaves the overdue set.
//
// THE WALK. Oldest-first on the stable key (updated_at, place_id), in keyset
// pages of STALE_SWEEP_PAGE_SIZE — never OFFSET. WHERE A RUN RESUMES is derived
// from the data, not stored: production has no table to hold a cursor
// (scheduler_watermarks is migration 3505, unapplied). Every place a run hands
// to the queue is refreshed by the drain and leaves the set, so the next run's
// first page IS the head of what is left. Places already pending or processing
// in the queue are waiting on the drain, not on this sweep: they are counted
// (`inFlight`) and skipped, never re-queued — re-queueing a processing row would
// change its queued_at, fail its mark-done and refresh it twice.
//
// TRAFFIC WITHOUT STARVATION. Each run's budget is split in two lanes:
//   aging   the first ceil(budget × STALE_SWEEP_AGING_SHARE) eligible places
//           in walk order — the longest-waiting — whatever their traffic;
//   traffic the rest of the budget goes to BUSY places (more than
//           POST_COUNT_THRESHOLD active posts, counted from posts as before)
//           found further along the walk, up to STALE_SWEEP_MAX_SCAN_PAGES;
//   fill    traffic slots no busy place claimed go to the quiet places the
//           walk passed, oldest first, so capacity is never left idle.
// THE BOUND. Overdue order is first-in-first-out: a place joins the tail when
// its collections turn CACHE_STALE_HOURS old, behind everything already
// waiting. In every run that reads and writes cleanly the aging lane re-queues
// R = ceil(budget × share) >= 100 of the eligible places ahead of any other, and
// a re-queued place never comes back ahead of it (it is held by the queue, then
// refreshed to the tail), so a place k eligible places from the head is
// re-queued within floor(k / R) + 1 such runs, whatever the traffic and whatever
// arrives meanwhile.
// When the backlog fits one budget (<= 600 places) every eligible place is
// re-queued in the run that sees it: aging + traffic + fill = the budget. A busy
// place inside the scan window is re-queued in the current run unless the
// traffic lane is already full of busy places older than it.
//
// CAPACITY. staleSweepBudget: pages = clamp(ceil(backlog / 100), 2, 6), so a
// run re-queues 200 (the old fixed batch) to 600 places and scans at most twice
// that. The run then DRAINS the queue itself (runCollectionsDrain), because the
// 15-minute tick claims only CLAIM_BATCH_SIZE (20) rows — 80 an hour — and
// growing the re-queue budget without the processing behind it would only grow
// the queue. When backlog remains, a follow-up run is armed
// STALE_SWEEP_FOLLOW_UP_DELAY_MS later, at most STALE_SWEEP_MAX_FOLLOW_UPS times
// between hourly runs: at most 4 runs and 2 400 refreshes an hour, never more.
//
// THE INDEX. 3902 adds a btree on place_best_of (updated_at, place_id), the
// walk key below; until it is applied (the owner's press), the count and each
// page scan a table of one row per precomputed place. With it, the count is a
// bitmap index scan and the pages an index-only scan with no sort (PGlite plan).

/** A place's collections are overdue this long after their last rebuild. */
const STALE_MS = CACHE_STALE_HOURS * 60 * 60 * 1_000;
/** Rows per keyset page; also the re-queue chunk. */
export const STALE_SWEEP_PAGE_SIZE = 100;
/** Budget floor: 200 places — the old fixed batch. */
export const STALE_SWEEP_MIN_PAGES = 2;
/** Budget cap: 600 places per run. */
export const STALE_SWEEP_MAX_PAGES = 6;
/** The walk reads at most twice the budget's pages looking for busy places. */
export const STALE_SWEEP_MAX_SCAN_PAGES = 2 * STALE_SWEEP_MAX_PAGES;
/** Share of every run reserved for the longest-waiting places, whatever their traffic. */
export const STALE_SWEEP_AGING_SHARE = 0.5;
/** Delay of a follow-up run while backlog remains. */
export const STALE_SWEEP_FOLLOW_UP_DELAY_MS = 15 * 60 * 1_000;
/** Follow-up runs allowed between two hourly runs. */
export const STALE_SWEEP_MAX_FOLLOW_UPS = 3;
/** Drain passes one run may take: twice a full budget's worth of claims, plus one. */
export const STALE_SWEEP_MAX_DRAIN_PASSES =
  (2 * STALE_SWEEP_MAX_PAGES * STALE_SWEEP_PAGE_SIZE) / CLAIM_BATCH_SIZE + 1;
/** The job name GET /healthz/schedulers reports this sweep under. */
export const PLACE_COLLECTIONS_SWEEP_JOB = "placeCollectionsStaleSweep";

export interface StaleSweepBudget {
  /** Keyset pages' worth of places this run may re-queue. */
  pages: number;
  /** Places this run may re-queue: pages × STALE_SWEEP_PAGE_SIZE. */
  places: number;
  /** Pages the walk may read. */
  scanPages: number;
  /** Slots of the aging lane. */
  agingSlots: number;
}

/**
 * The run's budget, from the backlog. Bounded both ways: an unreadable backlog
 * (null) gets the floor, a backlog of a million gets the cap.
 */
export function staleSweepBudget(backlog: number | null): StaleSweepBudget {
  const wanted = backlog === null || !Number.isFinite(backlog) || backlog < 0
    ? STALE_SWEEP_MIN_PAGES
    : Math.ceil(backlog / STALE_SWEEP_PAGE_SIZE);
  const pages = Math.min(STALE_SWEEP_MAX_PAGES, Math.max(STALE_SWEEP_MIN_PAGES, wanted));
  const places = pages * STALE_SWEEP_PAGE_SIZE;
  return {
    pages,
    places,
    scanPages: Math.min(STALE_SWEEP_MAX_SCAN_PAGES, 2 * pages),
    agingSlots: Math.ceil(places * STALE_SWEEP_AGING_SHARE),
  };
}

export type StaleSweepLane = "aging" | "traffic" | "fill";

export interface StaleSweepFailures {
  /** The overdue count could not be read; the budget fell back to its floor. */
  backlogUnreadable: number;
  /** An overdue page could not be read; the walk stopped there. */
  pageUnreadable: number;
  /** Pages whose queue state could not be read; their places were skipped, not re-queued blind. */
  queueStateUnreadable: number;
  /** Places whose activity could not be read; ranked with the quiet ones, never promoted on a guess. */
  activityUnreadable: number;
  /** Places the re-queue write refused. */
  requeueFailed: number;
}

export interface StaleSweepResult {
  /** Places handed to the queue this run. */
  requeued: number;
  /** Overdue places when the run started; null when the count could not be read. */
  backlog: number | null;
  /** How long the longest-waiting overdue place has been overdue, ms; null when no page was read. */
  maxWaitMs: number | null;
  budget: StaleSweepBudget;
  pagesRead: number;
  scanned: number;
  /** Overdue places already pending/processing in the queue: skipped, waiting on the drain. */
  inFlight: number;
  /** What this run chose, in the order it chose it. */
  selected: Array<{ place_id: string; lane: StaleSweepLane }>;
  /** Overdue places remain that this run did not hand to the queue. */
  backlogRemains: boolean;
  failures: StaleSweepFailures;
  cutoff: string;
}

interface OverdueRow { place_id: string; updated_at: string }

/**
 * One keyset page of overdue place_best_of rows after `after`, oldest first.
 * The key is (updated_at, place_id): the rest of `after`'s instant past its id
 * first, then later instants — so a page boundary inside a run of equal
 * timestamps neither skips nor repeats a row.
 */
async function readOverduePage(
  sc: any,
  cutoffIso: string,
  after: OverdueRow | null,
): Promise<{ rows: OverdueRow[]; error: string | null }> {
  if (after === null) {
    const { data, error } = await sc
      .from("place_best_of")
      .select("place_id, updated_at")
      .lt("updated_at", cutoffIso)
      .order("updated_at", { ascending: true })
      .order("place_id", { ascending: true })
      .limit(STALE_SWEEP_PAGE_SIZE);
    if (error) return { rows: [], error: error.message };
    return { rows: (data ?? []) as OverdueRow[], error: null };
  }
  const { data: ties, error: tieErr } = await sc
    .from("place_best_of")
    .select("place_id, updated_at")
    .eq("updated_at", after.updated_at)
    .gt("place_id", after.place_id)
    .order("place_id", { ascending: true })
    .limit(STALE_SWEEP_PAGE_SIZE);
  if (tieErr) return { rows: [], error: tieErr.message };
  const tieRows = (ties ?? []) as OverdueRow[];
  if (tieRows.length >= STALE_SWEEP_PAGE_SIZE) return { rows: tieRows, error: null };
  const { data: later, error: laterErr } = await sc
    .from("place_best_of")
    .select("place_id, updated_at")
    .lt("updated_at", cutoffIso)
    .gt("updated_at", after.updated_at)
    .order("updated_at", { ascending: true })
    .order("place_id", { ascending: true })
    .limit(STALE_SWEEP_PAGE_SIZE - tieRows.length);
  if (laterErr) return { rows: [], error: laterErr.message };
  return { rows: [...tieRows, ...((later ?? []) as OverdueRow[])], error: null };
}

/**
 * The traffic signal, with the predicate this worker already counts a place's
 * posts by (`canonical_place_id`, `status = 'active'`, as in processPlace): at
 * most POST_COUNT_THRESHOLD + 1 ids, so "more than 20" never reads more than 21.
 */
async function readActivity(sc: any, placeId: string): Promise<"busy" | "quiet" | "unreadable"> {
  const { data: activePosts, error: activityErr } = await sc
    .from("posts")
    .select("id")
    .eq("canonical_place_id", placeId)
    .eq("status", "active")
    .limit(POST_COUNT_THRESHOLD + 1);
  if (activityErr) {
    console.warn(JSON.stringify({
      event:    "place_collections.stale_activity_read_error",
      place_id: placeId,
      error:    activityErr.message,
    }));
    return "unreadable";
  }
  return ((activePosts ?? []) as unknown[]).length > POST_COUNT_THRESHOLD ? "busy" : "quiet";
}

/**
 * Re-queue overdue places — collections older than CACHE_STALE_HOURS — walking
 * them oldest-first in keyset pages, busy places first within a bounded share.
 * Exported so tests can call it directly; `opts.now` is the clock seam. Never
 * throws. Selection only: runPlaceCollectionsSweepTick drains what it queues.
 */
export async function runStaleSweep(scOverride?: any, opts: { now?: number } = {}): Promise<StaleSweepResult> {
  const nowMs = opts.now ?? Date.now();
  const cutoff = staleCacheCutoffIso(nowMs);
  const failures: StaleSweepFailures = {
    backlogUnreadable: 0, pageUnreadable: 0, queueStateUnreadable: 0, activityUnreadable: 0, requeueFailed: 0,
  };
  const result: StaleSweepResult = {
    requeued: 0, backlog: null, maxWaitMs: null, budget: staleSweepBudget(null), pagesRead: 0, scanned: 0,
    inFlight: 0, selected: [], backlogRemains: false, failures, cutoff,
  };
  const sc = scOverride ?? getServiceClient();
  if (!sc) return result;

  // 1. How big is the backlog? It sizes the run.
  const { count, error: countErr } = await sc
    .from("place_best_of")
    .select("place_id", { count: "exact", head: true })
    .lt("updated_at", cutoff);
  if (countErr || typeof count !== "number") {
    failures.backlogUnreadable++;
    console.warn(JSON.stringify({
      event: "place_collections.stale_backlog_count_error",
      error: countErr ? countErr.message : "no count returned",
    }));
  } else {
    result.backlog = count;
  }
  const budget = staleSweepBudget(result.backlog);
  result.budget = budget;
  if (result.backlog === 0) { result.maxWaitMs = 0; return result; } // nothing is waiting

  // 2. Walk oldest-first, choosing by lane.
  let cursor: OverdueRow | null = null;
  let exhausted = false;
  let skippedUnknown = 0;
  let agingLeft = budget.agingSlots;
  let trafficLeft = budget.places - budget.agingSlots;
  const held: string[] = []; // passed in the traffic window and not busy: the fill lane, oldest first

  while (result.pagesRead < budget.scanPages && agingLeft + trafficLeft > 0) {
    const page = await readOverduePage(sc, cutoff, cursor);
    if (page.error !== null) {
      failures.pageUnreadable++;
      console.warn(JSON.stringify({ event: "place_collections.stale_sweep_query_error", error: page.error }));
      break;
    }
    result.pagesRead++;
    const rows = page.rows;
    if (rows.length === 0) {
      if (result.pagesRead === 1) result.maxWaitMs = 0; // nothing is overdue
      exhausted = true;
      break;
    }
    if (result.maxWaitMs === null) {
      result.maxWaitMs = Math.max(0, nowMs - (Date.parse(rows[0].updated_at) + STALE_MS));
    }
    cursor = rows[rows.length - 1];
    result.scanned += rows.length;

    const { data: queueRows, error: queueErr } = await sc
      .from("place_cache_invalidation_queue")
      .select("place_id, status")
      .in("place_id", rows.map((r) => r.place_id));
    if (queueErr) {
      failures.queueStateUnreadable++;
      skippedUnknown += rows.length;
      console.warn(JSON.stringify({ event: "place_collections.stale_queue_state_error", error: queueErr.message }));
    } else {
      const waiting = new Set(
        ((queueRows ?? []) as Array<{ place_id: string; status: string }>)
          .filter((q) => q.status === "pending" || q.status === "processing")
          .map((q) => q.place_id),
      );
      for (const row of rows) {
        if (agingLeft + trafficLeft === 0) break;
        if (waiting.has(row.place_id)) { result.inFlight++; continue; }
        if (agingLeft > 0) {
          result.selected.push({ place_id: row.place_id, lane: "aging" });
          agingLeft--;
          continue;
        }
        const activity = await readActivity(sc, row.place_id);
        if (activity === "unreadable") failures.activityUnreadable++;
        if (activity === "busy") {
          result.selected.push({ place_id: row.place_id, lane: "traffic" });
          trafficLeft--;
        } else {
          held.push(row.place_id);
        }
      }
    }
    if (rows.length < STALE_SWEEP_PAGE_SIZE) { exhausted = true; break; }
  }

  let filled = 0;
  while (trafficLeft > 0 && filled < held.length) {
    result.selected.push({ place_id: held[filled++], lane: "fill" });
    trafficLeft--;
  }

  // 3. Hand the choice to the queue, a page at a time.
  const nowIso = new Date(nowMs).toISOString();
  for (let i = 0; i < result.selected.length; i += STALE_SWEEP_PAGE_SIZE) {
    const chunk = result.selected.slice(i, i + STALE_SWEEP_PAGE_SIZE);
    const { error: upsertErr } = await sc
      .from("place_cache_invalidation_queue")
      .upsert(
        chunk.map((s) => ({ place_id: s.place_id, queued_at: nowIso, status: "pending" })),
        { onConflict: "place_id" },
      );
    if (upsertErr) {
      failures.requeueFailed += chunk.length;
      console.warn(JSON.stringify({
        event:  "place_collections.stale_requeue_error",
        places: chunk.length,
        error:  upsertErr.message,
      }));
    } else {
      result.requeued += chunk.length;
    }
  }

  const unwalked = !exhausted && (result.backlog === null || result.backlog > result.inFlight + result.selected.length);
  result.backlogRemains =
    held.length > filled || skippedUnknown > 0 || failures.pageUnreadable > 0 || failures.requeueFailed > 0 || unwalked;
  return result;
}

// ── Drain: the processing behind the re-queue ────────────────────────────────

export interface CollectionsDrainResult extends CollectionsTickResult {
  passes: number;
}

/** Drain passes for a run that re-queued `requeued` places (0 when it queued nothing). */
export function drainPassesFor(requeued: number): number {
  if (requeued <= 0) return 0;
  return Math.min(STALE_SWEEP_MAX_DRAIN_PASSES, 2 * Math.ceil(requeued / CLAIM_BATCH_SIZE) + 1);
}

/**
 * Run queue passes (runCollectionsTick: claim, process, mark done) until a pass
 * claims less than a full batch — the queue is empty, or a claim failed — or
 * `maxPasses` is spent. Oldest queued_at first, so invalidations queued before
 * the sweep's rows are processed first, never displaced. Per-place errors are
 * counted by the tick and do not stop the drain.
 */
export async function runCollectionsDrain(sc: any, maxPasses: number): Promise<CollectionsDrainResult> {
  const out: CollectionsDrainResult = { claimed: 0, processed: 0, errors: 0, passes: 0 };
  while (out.passes < maxPasses) {
    const r = await runCollectionsTick(sc);
    out.passes++;
    out.claimed += r.claimed;
    out.processed += r.processed;
    out.errors += r.errors;
    if (r.claimed < CLAIM_BATCH_SIZE) break;
  }
  return out;
}

// ── Status, health, follow-up ─────────────────────────────────────────────────

export interface PlaceCollectionsSweepRun {
  sweep: Omit<StaleSweepResult, "selected"> & { selected: Record<StaleSweepLane, number> };
  drain: CollectionsDrainResult;
  /** A throw the run could not attribute (null when none). */
  thrown: string | null;
  noClient: boolean;
}

export interface PlaceCollectionsSweepStatus {
  /** PLACE_COLLECTIONS_WORKER_ENABLED as startPlaceCollectionsWorker read it; null before it ran. */
  enabled: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastFailures: string[];
  lastResult: PlaceCollectionsSweepRun | null;
  /** Follow-up runs armed since the last hourly run. */
  followUpsInARow: number;
  /** Refreshes that failed in this process's drains (processPlace threw, or a claim failed). */
  refreshFailuresTotal: number;
}

const _sweepStatus: PlaceCollectionsSweepStatus = {
  enabled: null, lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailures: [],
  lastResult: null, followUpsInARow: 0, refreshFailuresTotal: 0,
};

export function getPlaceCollectionsSweepStatus(): Readonly<PlaceCollectionsSweepStatus> {
  const r = _sweepStatus.lastResult;
  return {
    ..._sweepStatus,
    lastFailures: [..._sweepStatus.lastFailures],
    lastResult: r
      ? { ...r, sweep: { ...r.sweep, failures: { ...r.sweep.failures }, selected: { ...r.sweep.selected }, budget: { ...r.sweep.budget } }, drain: { ...r.drain } }
      : null,
  };
}

/** Test seam. */
export function _resetPlaceCollectionsSweepStatus(): void {
  _sweepStatus.enabled = null; _sweepStatus.lastAttemptAt = null; _sweepStatus.lastSuccessAt = null;
  _sweepStatus.consecutiveFailures = 0; _sweepStatus.lastFailures = []; _sweepStatus.lastResult = null;
  _sweepStatus.followUpsInARow = 0; _sweepStatus.refreshFailuresTotal = 0;
}

/** The failures one run carries; empty = the run succeeded. */
export function placeCollectionsSweepFailuresOf(run: PlaceCollectionsSweepRun): string[] {
  const out: string[] = [];
  if (run.noClient) out.push("no service client — the sweep did not run");
  if (run.thrown !== null) out.push(`the run threw: ${run.thrown}`);
  const f = run.sweep.failures;
  if (f.backlogUnreadable > 0) out.push("the overdue count could not be read — the run fell back to its minimum budget");
  if (f.pageUnreadable > 0) out.push("an overdue page could not be read — the walk stopped there");
  if (f.queueStateUnreadable > 0) out.push(`${f.queueStateUnreadable} page(s) of queue state could not be read — their places were skipped, not re-queued blind`);
  if (f.activityUnreadable > 0) out.push(`${f.activityUnreadable} place(s) had unreadable activity — ranked with the quiet ones`);
  if (f.requeueFailed > 0) out.push(`${f.requeueFailed} place(s) could not be re-queued`);
  if (run.drain.errors > 0) out.push(`${run.drain.errors} refresh failure(s) in the drain — a place whose refresh threw stays processing until the stale-lock sweeper re-queues it`);
  return out;
}

function formatWait(ms: number | null): string {
  if (ms === null) return "unknown";
  const minutes = Math.floor(ms / 60_000);
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function placeCollectionsSweepHealthDetail(s: Readonly<PlaceCollectionsSweepStatus>): string | undefined {
  const parts: string[] = [];
  if (s.enabled === false) {
    parts.push("PLACE_COLLECTIONS_WORKER_ENABLED is not \"true\": the worker is off and no overdue place collection is refreshed");
  }
  if (s.lastFailures.length > 0) parts.push(`last failures: ${s.lastFailures.join("; ")}`);
  const r = s.lastResult;
  if (r && !r.noClient) {
    const w = r.sweep;
    parts.push(
      `last pass: backlog ${w.backlog ?? "unknown"}, max wait ${formatWait(w.maxWaitMs)}, ` +
      `budget ${w.budget.places} (${w.budget.pages} page(s)), re-queued ${w.requeued} ` +
      `(aging ${w.selected.aging}, traffic ${w.selected.traffic}, fill ${w.selected.fill}), in flight ${w.inFlight}, ` +
      `drained ${r.drain.processed} of ${r.drain.claimed} claimed in ${r.drain.passes} pass(es), ` +
      `${r.drain.errors} refresh failure(s)` +
      (w.backlogRemains ? `, backlog remains (follow-ups ${s.followUpsInARow}/${STALE_SWEEP_MAX_FOLLOW_UPS})` : ""),
    );
  }
  if (s.refreshFailuresTotal > 0) parts.push(`refresh failures since start: ${s.refreshFailuresTotal}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * One run: select and re-queue (runStaleSweep), drain what it queued, record
 * the status, log one structured line. Never throws.
 */
export async function runPlaceCollectionsSweepTick(
  opts: { client?: any; now?: number } = {},
): Promise<Readonly<PlaceCollectionsSweepStatus>> {
  const nowMs = opts.now ?? Date.now();
  const attemptAt = new Date(nowMs).toISOString();
  _sweepStatus.lastAttemptAt = attemptAt;
  const sc = opts.client !== undefined ? opts.client : getServiceClient();

  let sweep: StaleSweepResult | null = null;
  let drain: CollectionsDrainResult = { claimed: 0, processed: 0, errors: 0, passes: 0 };
  let thrown: string | null = null;
  if (sc) {
    try {
      sweep = await runStaleSweep(sc, { now: nowMs });
      const passes = drainPassesFor(sweep.requeued);
      if (passes > 0) drain = await runCollectionsDrain(sc, passes);
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
  }
  const base: StaleSweepResult = sweep ?? {
    requeued: 0, backlog: null, maxWaitMs: null, budget: staleSweepBudget(null), pagesRead: 0, scanned: 0,
    inFlight: 0, selected: [], backlogRemains: false, cutoff: staleCacheCutoffIso(nowMs),
    failures: { backlogUnreadable: 0, pageUnreadable: 0, queueStateUnreadable: 0, activityUnreadable: 0, requeueFailed: 0 },
  };
  const lanes: Record<StaleSweepLane, number> = { aging: 0, traffic: 0, fill: 0 };
  for (const s of base.selected) lanes[s.lane]++;
  const run: PlaceCollectionsSweepRun = { sweep: { ...base, selected: lanes }, drain, thrown, noClient: !sc };

  const failures = placeCollectionsSweepFailuresOf(run);
  _sweepStatus.lastResult = run;
  _sweepStatus.lastFailures = failures;
  _sweepStatus.refreshFailuresTotal += drain.errors;
  if (failures.length === 0) { _sweepStatus.consecutiveFailures = 0; _sweepStatus.lastSuccessAt = attemptAt; }
  else _sweepStatus.consecutiveFailures += 1;

  const f = run.sweep.failures;
  const line = JSON.stringify({
    event:                  "place_collections.stale_sweep_complete",
    backlog:                run.sweep.backlog,
    max_wait_ms:            run.sweep.maxWaitMs,
    budget:                 run.sweep.budget.places,
    pages_read:             run.sweep.pagesRead,
    scanned:                run.sweep.scanned,
    in_flight:              run.sweep.inFlight,
    requeued:               run.sweep.requeued,
    selected_aging:         lanes.aging,
    selected_traffic:       lanes.traffic,
    selected_fill:          lanes.fill,
    backlog_remains:        run.sweep.backlogRemains,
    drain_passes:           drain.passes,
    drain_claimed:          drain.claimed,
    drain_processed:        drain.processed,
    refresh_failures:       drain.errors,
    backlog_unreadable:     f.backlogUnreadable,
    page_unreadable:        f.pageUnreadable,
    queue_state_unreadable: f.queueStateUnreadable,
    activity_unreadable:    f.activityUnreadable,
    requeue_failed:         f.requeueFailed,
    consecutive_failures:   _sweepStatus.consecutiveFailures,
    cutoff:                 run.sweep.cutoff,
    worker_id:              WORKER_ID,
  });
  if (failures.length === 0) console.log(line);
  else console.warn(line);
  return getPlaceCollectionsSweepStatus();
}

/**
 * When to run again before the next hourly run: STALE_SWEEP_FOLLOW_UP_DELAY_MS
 * while backlog remains, at most STALE_SWEEP_MAX_FOLLOW_UPS times in a row;
 * null = wait for the hourly run.
 */
export function staleSweepFollowUpDelayMs(backlogRemains: boolean, followUpsInARow: number): number | null {
  if (!backlogRemains) return null;
  if (followUpsInARow >= STALE_SWEEP_MAX_FOLLOW_UPS) return null;
  return STALE_SWEEP_FOLLOW_UP_DELAY_MS;
}

let _sweepInFlight = false;
let _followUpTimer: ReturnType<typeof setTimeout> | null = null;

/** The scheduler's entry: one run at a time, then a bounded follow-up while backlog remains. */
async function runScheduledSweep(trigger: "scheduled" | "follow_up"): Promise<void> {
  if (_sweepInFlight) {
    console.log(JSON.stringify({ event: "place_collections.sweep_overlap_skipped", trigger }));
    return;
  }
  _sweepInFlight = true;
  try {
    if (trigger === "scheduled") {
      _sweepStatus.followUpsInARow = 0;
      if (_followUpTimer !== null) { clearTimeout(_followUpTimer); _followUpTimer = null; }
    }
    const status = await runPlaceCollectionsSweepTick();
    const remains = status.lastResult?.sweep.backlogRemains === true;
    const delay = staleSweepFollowUpDelayMs(remains, _sweepStatus.followUpsInARow);
    if (delay !== null) {
      _sweepStatus.followUpsInARow += 1;
      _followUpTimer = setTimeout(() => {
        _followUpTimer = null;
        void runScheduledSweep("follow_up").catch((err) =>
          console.warn(JSON.stringify({
            event: "place_collections.follow_up_sweep_error",
            error: err instanceof Error ? err.message : String(err),
          })),
        );
      }, delay);
      if (typeof _followUpTimer.unref === "function") _followUpTimer.unref();
    } else if (!remains) {
      _sweepStatus.followUpsInARow = 0;
    }
  } finally {
    _sweepInFlight = false;
  }
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
    _sweepStatus.enabled = false;
    console.log(JSON.stringify({
      event: "place_collections.worker_disabled",
      note:  "Set PLACE_COLLECTIONS_WORKER_ENABLED=true to enable",
    }));
    return { tickInterval: null, sweepInterval: null };
  }
  _sweepStatus.enabled = true;

  // Run initial tick + sweep after a short startup delay.
  const STARTUP_DELAY_MS = 2 * 60 * 1_000; // 2 min — let other init finish
  const startupTimer = setTimeout(() => {
    void runCollectionsTick().catch((err) =>
      console.warn(JSON.stringify({
        event: "place_collections.initial_tick_error",
        error: err instanceof Error ? err.message : String(err),
      })),
    );
    void runScheduledSweep("scheduled").catch((err) =>
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
    void runScheduledSweep("scheduled").catch((err) =>
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
