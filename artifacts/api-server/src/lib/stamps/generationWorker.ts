/**
 * Stamp Generation Worker
 *
 * Polls `stamp_generation_queue` for work, generates 3 candidate images per
 * catalog entry via the configured StampImageProvider, uploads to Supabase
 * storage, and inserts `stamp_artwork_versions` rows.
 *
 * The worker uses a pessimistic lock (locked_until / locked_by) so multiple
 * worker instances can run without producing duplicates.
 *
 * Start via startWorkerLoop() from index.ts — only when STAMP_WORKER_ENABLED=true.
 *
 * ── Root cause fixed (2026-07-28) ───────────────────────────────────────────
 * The worker was crashing on every poll cycle because two related fixes were
 * applied at different layers:
 *
 * 1. Missing columns on `generated_visuals` (separate table used by the
 *    VisualGenerationWorker): `locked_until`, `retry_after`, and `locked_by`
 *    were absent until migration 2034_generated_visuals_retry_cols.sql was
 *    applied.  The VisualGenerationWorker polls the same queue infrastructure
 *    and its WARN logs on every cycle indicated these columns were missing —
 *    confirmed via live information_schema query, applied via Supabase
 *    Management API.
 *
 * 2. Artwork never surfaced in `GET /api/stamps/me` even after admin approval:
 *    `buildCatalogArtworkMap` (routes/stamps.ts) used the wrong PostgREST FK
 *    hint (`stamp_artwork_versions!active_version_id`) which PostgREST could
 *    not resolve, returning null for every catalog row.  Fix: use the FK
 *    constraint name `stamp_artwork_versions!fk_catalog_active_version`.
 *    Additionally, `public_url` was a raw Supabase storage path, not an HTTPS
 *    URL; the hydrator now generates short-lived signed URLs so expo-image can
 *    render the artwork without making the stamp-artwork bucket public.
 */

import { randomUUID } from "crypto";
import { getServiceClient } from "../supabase.js";
import { buildStampPrompt, buildHeroArtPrompt, STYLE_VERSION, HERO_PROMPT_VERSION, CANDIDATE_COUNT } from "./artDirection.js";
import { getStampImageProvider } from "./imageProvider.js";
import type { CatalogEntryForPrompt } from "./artDirection.js";
import { invalidateCatalogCache } from "./StampCatalogService.js";
import { resolveIdentity } from "./composition/identities.js";
import { composeStamp, templateFamilyForType, normalizeRarity } from "./composition/compositor.js";
import { rasterizeStamp, validateHeroBuffer, validateComposedPng } from "./composition/rasterize.js";

const WORKER_ID = `worker-${randomUUID()}`;
const LOCK_DURATION_MS = 5 * 60 * 1_000; // 5 min pessimistic lock
const STORAGE_BUCKET = "stamp-artwork";

// Auto-requeue: retryable_failed jobs older than N hours get reset to queued.
// Set STAMP_FAILED_REQUEUE_HOURS=0 to disable.
const AUTO_REQUEUE_AFTER_HOURS = Number(process.env.STAMP_FAILED_REQUEUE_HOURS ?? "6");
// Cap on automatic re-queue rounds: after this many auto-requeues a job is
// moved to the terminal `permanently_failed` status instead of being retried
// again (stops paying for image-provider calls on permanently broken jobs).
// Manual admin re-queue resets the counter. Minimum 1.
const AUTO_REQUEUE_MAX_ROUNDS = Math.max(1, Number(process.env.STAMP_FAILED_REQUEUE_MAX_ROUNDS ?? "3") || 3);
const AUTO_REQUEUE_CHECK_INTERVAL_MS = 10 * 60 * 1_000; // sweep at most every 10 min
let _lastAutoRequeueAt = 0;

// Stale-artwork sweep: scan for outdated prompt_template_version and enqueue
// new generation jobs.  Runs at most every 30 minutes so a busy worker doesn't
// hammer the DB on every cycle.  Set STAMP_STALE_SWEEP_INTERVAL_MINUTES=0 to
// disable.
const STALE_ARTWORK_SWEEP_INTERVAL_MS =
  Number(process.env.STAMP_STALE_SWEEP_INTERVAL_MINUTES ?? "30") * 60 * 1_000;
let _lastStaleArtworkSweepAt = 0;

// Minimum number of candidates a generation run must produce to be considered
// reviewable. Below this the job is treated as a retryable failure instead of
// review_required (default 1 keeps the historical "at least one image" rule).
const MIN_CANDIDATES = Math.max(
  1,
  Math.min(CANDIDATE_COUNT, Number(process.env.STAMP_MIN_CANDIDATES ?? "1") || 1)
);

// Prefix used in last_error to flag a degraded-but-reviewable run so the admin
// review screen can surface the shortfall. Exported for tests/routes.
export const CANDIDATE_SHORTFALL_PREFIX = "candidate_shortfall";

/**
 * Classify a generation run by how many candidates it produced.
 * Pure; exported for tests.
 *
 * - "failed":    produced < minimum → treat as retryable failure.
 * - "degraded":  produced < expected but ≥ minimum → review_required, with the
 *                shortfall recorded on the queue row.
 * - "full":      produced === expected.
 */
export function evaluateCandidateShortfall(
  produced: number,
  expected: number = CANDIDATE_COUNT,
  minimum: number = MIN_CANDIDATES,
): { outcome: "failed" | "degraded" | "full"; shortfallMessage: string | null } {
  if (produced < Math.max(1, minimum)) {
    return {
      outcome: "failed",
      shortfallMessage: `${CANDIDATE_SHORTFALL_PREFIX}: produced ${produced} of ${expected} candidates (minimum ${Math.max(1, minimum)})`,
    };
  }
  if (produced < expected) {
    return {
      outcome: "degraded",
      shortfallMessage: `${CANDIDATE_SHORTFALL_PREFIX}: produced ${produced} of ${expected} candidates`,
    };
  }
  return { outcome: "full", shortfallMessage: null };
}

// ── Stale-artwork sweep (STYLE_VERSION bump) ──────────────────────────────────

/**
 * Scan `stamp_artwork_versions` for rows whose `prompt_template_version`
 * doesn't match the current `STYLE_VERSION` (including null rows which
 * pre-date the versioning scheme) and enqueue a new generation job for each
 * affected catalog entry that doesn't already have an active job.
 *
 * "Active" means status is one of: queued, generating, review_required.
 * Terminal statuses (retryable_failed, permanently_failed) do NOT block
 * re-enqueuing — the sweep treats them as "needs a fresh attempt".
 *
 * Returns the number of new jobs inserted. Accepts an injectable client for
 * tests.
 */
export async function sweepStaleArtwork(scOverride?: any): Promise<number> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return 0;

  // The sweep paginates through ALL stale rows in a single invocation:
  // pages of SWEEP_PAGE_SIZE are fetched via .range() until a page returns
  // fewer rows than the limit.  Each page is deduplicated, checked, and
  // enqueued before the next page is fetched, so a crash mid-sweep still
  // leaves every completed page fully enqueued.
  const SWEEP_PAGE_SIZE = 500;
  // Safety cap on pages per invocation. A pathological backend that ignores
  // the range offset (returning the same full page forever) would otherwise
  // spin the loop indefinitely — the cap guarantees termination
  // unconditionally, without risking early aborts on legitimate
  // duplicate-heavy pages (cross-page dedup already makes repeats no-ops).
  // 2000 pages × 500 rows = 1M stale rows per sweep, far beyond realistic data.
  const MAX_SWEEP_PAGES = 2_000;
  // Catalog IDs already handled in this invocation (across pages) — the same
  // catalog can have stale rows spanning a page boundary.
  const seenCatalogIds = new Set<string>();
  let totalEnqueued = 0;
  let offset = 0;
  let pageIndex = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Pass 1: fetch one page of catalog_ids that have at least one stale or
    // null prompt_template_version.  The OR covers rows pre-dating the
    // versioning scheme (null) and rows from a previous STYLE_VERSION.
    const { data: staleRows, error: staleErr } = await sc
      .from("stamp_artwork_versions")
      .select("catalog_id")
      .or(`prompt_template_version.is.null,prompt_template_version.neq.${STYLE_VERSION}`)
      .range(offset, offset + SWEEP_PAGE_SIZE - 1);

    if (staleErr) {
      console.error(JSON.stringify({ event: "stamp.sweep.stale_query_error", error: staleErr.message, page: pageIndex }));
      return totalEnqueued;
    }

    const pageRows = (staleRows ?? []) as Array<{ catalog_id: string }>;
    const pageFull = pageRows.length >= SWEEP_PAGE_SIZE;

    // Deduplicate within the page and against catalogs already handled on
    // earlier pages of this invocation.
    const staleCatalogIds = [...new Set(pageRows.map((r) => r.catalog_id))]
      .filter((id) => !seenCatalogIds.has(id));
    for (const id of staleCatalogIds) seenCatalogIds.add(id);

    if (staleCatalogIds.length > 0) {
      const enqueued = await processSweepPage(sc, staleCatalogIds, pageIndex);
      if (enqueued === null) return totalEnqueued; // query/insert error — stop paging
      totalEnqueued += enqueued;
    }
    // Note: a full page yielding zero NEW catalog IDs is NOT treated as an
    // abort signal — a catalog with heavy version churn can legitimately fill
    // one or more whole pages with rows for already-seen catalogs before
    // unseen catalogs appear on later pages. Termination against a
    // misbehaving backend is guaranteed solely by the MAX_SWEEP_PAGES cap.

    if (!pageFull) break;

    if (pageIndex + 1 >= MAX_SWEEP_PAGES) {
      // Hard safety cap — remaining stale rows (if any) are picked up by the
      // next scheduled sweep.
      console.error(JSON.stringify({
        event:     "stamp.sweep.page_cap_reached",
        max_pages: MAX_SWEEP_PAGES,
        note:      "sweep page cap reached; remaining stale rows deferred to the next sweep",
      }));
      return totalEnqueued;
    }

    // Debug-level progress log: the page was full, so more stale rows may
    // exist beyond it — the loop continues with the next page immediately.
    console.log(JSON.stringify({
      event:         "stamp.sweep.page_complete",
      page:          pageIndex,
      page_size:     SWEEP_PAGE_SIZE,
      style_version: STYLE_VERSION,
      note:          "stale artwork page was full; fetching the next page in the same sweep",
    }));

    offset += SWEEP_PAGE_SIZE;
    pageIndex++;
  }

  return totalEnqueued;
}

/**
 * Process a single page of stale catalog IDs: exclude catalogs that already
 * have a current-version row or an active job, then insert generation jobs
 * for the remainder. Returns the number of jobs enqueued for this page, or
 * null when a query/insert error should abort the pagination loop.
 */
async function processSweepPage(
  sc: any,
  staleCatalogIds: string[],
  pageIndex: number,
): Promise<number | null> {
  // Pass 2: scoped current-version check — query only within the stale batch.
  // By scoping to staleCatalogIds, this query is always bounded (≤ page size)
  // and cannot be truncated regardless of total catalog size.  A catalog that
  // returns here already has a current-version row and must NOT be re-enqueued,
  // even if it also has historical old-version rows (mixed-history catalog).
  const { data: currentRows, error: currentErr } = await sc
    .from("stamp_artwork_versions")
    .select("catalog_id")
    .eq("prompt_template_version", STYLE_VERSION)
    .in("catalog_id", staleCatalogIds);

  if (currentErr) {
    console.error(JSON.stringify({ event: "stamp.sweep.current_query_error", error: currentErr.message, page: pageIndex }));
    return null;
  }

  const currentCatalogIds = new Set<string>(
    ((currentRows ?? []) as Array<{ catalog_id: string }>).map((r) => r.catalog_id),
  );

  // A catalog is truly stale only if it has no current-version row in the batch.
  const trulyStale = staleCatalogIds.filter((id) => !currentCatalogIds.has(id));
  if (trulyStale.length === 0) return 0;

  // Check which truly-stale catalog IDs already have an active (non-terminal)
  // job so we don't create duplicate queue entries.
  const { data: existingJobs, error: jobsErr } = await sc
    .from("stamp_generation_queue")
    .select("catalog_id")
    .in("catalog_id", trulyStale)
    .in("status", ["queued", "generating", "review_required"]);

  if (jobsErr) {
    console.error(JSON.stringify({ event: "stamp.sweep.existing_jobs_query_error", error: jobsErr.message, page: pageIndex }));
    return null;
  }

  const alreadyActive = new Set<string>(
    ((existingJobs ?? []) as Array<{ catalog_id: string }>).map((r) => r.catalog_id),
  );

  const toEnqueue = trulyStale.filter((id) => !alreadyActive.has(id));
  if (toEnqueue.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const newJobs = toEnqueue.map((catalogId) => ({
    id:                  randomUUID(),
    catalog_id:          catalogId,
    status:              "queued",
    priority:            10,
    attempts:            0,
    max_attempts:        3,
    requeue_count:       0,
    triggered_by_action: "style_version_sweep",
    created_at:          nowIso,
    updated_at:          nowIso,
  }));

  const { error: insertErr } = await sc
    .from("stamp_generation_queue")
    .insert(newJobs);

  if (insertErr) {
    console.error(JSON.stringify({ event: "stamp.sweep.enqueue_error", error: insertErr.message, page: pageIndex }));
    return null;
  }

  console.log(JSON.stringify({
    event:         "stamp.sweep.stale_artwork_enqueued",
    count:         toEnqueue.length,
    catalog_ids:   toEnqueue,
    style_version: STYLE_VERSION,
    page:          pageIndex,
  }));

  return toEnqueue.length;
}

// ── Auto-requeue of stale failed jobs ─────────────────────────────────────────

/**
 * Sweep retryable_failed jobs whose last update is older than the configured
 * threshold:
 *   - Jobs still under the auto-requeue cap are reset to queued (attempts → 0)
 *     with requeue_count incremented, so the worker picks them up again.
 *   - Jobs that already used all AUTO_REQUEUE_MAX_ROUNDS rounds are moved to
 *     the terminal `permanently_failed` status (still visible on the admin
 *     Failed Generation Jobs screen, where a manual re-queue resets the cap).
 * Returns the number of jobs re-queued. Accepts an injectable client for tests.
 */
export async function requeueStaleFailedJobs(scOverride?: any): Promise<number> {
  if (!(AUTO_REQUEUE_AFTER_HOURS > 0)) return 0;

  const sc = scOverride ?? getServiceClient();
  if (!sc) return 0;

  // Single clock read — the staleness cutoff and updated_at stamps derive from
  // the same instant so they can never disagree (split-clock risk).
  const nowMs = Date.now();
  const cutoff = new Date(nowMs - AUTO_REQUEUE_AFTER_HOURS * 3_600_000).toISOString();

  const { data: stale, error } = await sc
    .from("stamp_generation_queue")
    .select("id, requeue_count")
    .eq("status", "retryable_failed")
    .lt("updated_at", cutoff)
    .limit(200);

  if (error) {
    console.error(JSON.stringify({ event: "stamp.queue.auto_requeue_error", error: error.message }));
    return 0;
  }

  const rows = (stale ?? []) as Array<{ id: string; requeue_count: number | null }>;
  if (rows.length === 0) return 0;

  const exhausted = rows.filter((r) => (r.requeue_count ?? 0) >= AUTO_REQUEUE_MAX_ROUNDS);
  const requeueable = rows.filter((r) => (r.requeue_count ?? 0) < AUTO_REQUEUE_MAX_ROUNDS);

  // Jobs that used up all auto-requeue rounds → terminal permanently_failed.
  if (exhausted.length > 0) {
    const { error: permErr } = await sc
      .from("stamp_generation_queue")
      .update({
        status:       "permanently_failed",
        locked_until: null,
        locked_by:    null,
        updated_at:   new Date(nowMs).toISOString(),
      })
      .in("id", exhausted.map((r) => r.id))
      .eq("status", "retryable_failed");

    if (permErr) {
      console.error(JSON.stringify({ event: "stamp.queue.permanent_fail_error", error: permErr.message }));
    } else {
      console.error(JSON.stringify({
        event:      "stamp.queue.permanently_failed",
        count:      exhausted.length,
        max_rounds: AUTO_REQUEUE_MAX_ROUNDS,
        job_ids:    exhausted.map((r) => r.id),
      }));
    }
  }

  // Remaining jobs → back to queued, incrementing requeue_count.
  // Group by current requeue_count so each batch is a single UPDATE.
  let requeued = 0;
  const byCount = new Map<number, string[]>();
  for (const r of requeueable) {
    const n = r.requeue_count ?? 0;
    const ids = byCount.get(n) ?? [];
    ids.push(r.id);
    byCount.set(n, ids);
  }

  for (const [count, ids] of byCount) {
    const { data: updated, error: updErr } = await sc
      .from("stamp_generation_queue")
      .update({
        status:        "queued",
        attempts:      0,
        last_error:    null,
        // cleanup_error and cleanup_error_paths are intentionally preserved:
        // orphaned files remain in the bucket even after re-queue and ops must
        // be able to enumerate them from the admin UI until they manually
        // remove the files and the admin clears the error.
        locked_until:  null,
        locked_by:     null,
        requeue_count: count + 1,
        updated_at:    new Date(nowMs).toISOString(),
      })
      .in("id", ids)
      .eq("status", "retryable_failed")
      .select("id");

    if (updErr) {
      console.error(JSON.stringify({ event: "stamp.queue.auto_requeue_error", error: updErr.message }));
      continue;
    }
    requeued += ((updated ?? []) as any[]).length;
  }

  if (requeued > 0) {
    console.log(JSON.stringify({
      event:        "stamp.queue.auto_requeued",
      count:        requeued,
      older_than_h: AUTO_REQUEUE_AFTER_HOURS,
      max_rounds:   AUTO_REQUEUE_MAX_ROUNDS,
    }));
  }
  return requeued;
}

// ── Reclaim of stuck `generating` jobs ────────────────────────────────────────

/**
 * Message stamped on `last_error` when a stuck `generating` job is reclaimed by
 * the timeout sweep below. Exported so tests/admin tooling can recognise it.
 */
export const STUCK_GENERATING_RECLAIM_ERROR =
  "reclaimed: worker lock expired while generating (worker likely crashed)";

/**
 * Requeue `generating` jobs whose pessimistic lock has expired — the worker that
 * claimed them is presumed dead (crash / OOM / redeploy mid-run).
 *
 * Why this is needed (audit STAMP·H4): `runGenerationCycle` only ever claims
 * rows in status `queued`, so a row left in `generating` is never re-processed.
 * The partial unique index `uix_queue_catalog_active` treats `generating` as an
 * active row, so it also keeps the catalog entry's only active-job slot — every
 * later enqueue for that catalog (award pipeline, admin regenerate) hits 23505
 * and is swallowed as success. The entry can then never produce artwork. The
 * health monitor already *detects* these rows (see `queryStampWorkerHealth` /
 * `evaluateWorkerHealth`) but only warns; this sweep actually heals them.
 *
 * A reclaim counts as a failed attempt: a job that keeps crashing the worker is
 * bounded by `max_attempts` and lands in `retryable_failed` instead of looping
 * forever, where `requeueStaleFailedJobs` then governs it under the auto-requeue
 * cap. Returns the number of rows moved out of `generating`. Accepts an
 * injectable client for tests.
 */
export async function requeueStuckGeneratingJobs(scOverride?: any): Promise<number> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return 0;

  // Single clock read — the expiry probe (WHERE) and the new updated_at stamp
  // derive from the same instant so they can never disagree (split-clock risk).
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const { data: stuck, error } = await sc
    .from("stamp_generation_queue")
    .select("id, attempts, max_attempts")
    .eq("status", "generating")
    .lt("locked_until", nowIso)
    .limit(200);

  if (error) {
    console.error(JSON.stringify({ event: "stamp.queue.stuck_reclaim_error", error: error.message }));
    return 0;
  }

  const rows = (stuck ?? []) as Array<{ id: string; attempts: number | null; max_attempts: number | null }>;
  if (rows.length === 0) return 0;

  let reclaimed = 0;
  for (const r of rows) {
    const newAttempts = (r.attempts ?? 0) + 1;
    const maxAttempts = r.max_attempts ?? 3;
    // A crash that used up all attempts is terminal-retryable, not re-queued,
    // so a job that reliably kills the worker cannot livelock the sweep.
    const newStatus = newAttempts >= maxAttempts ? "retryable_failed" : "queued";

    const { data: updated, error: updErr } = await sc
      .from("stamp_generation_queue")
      .update({
        status:       newStatus,
        attempts:     newAttempts,
        last_error:   STUCK_GENERATING_RECLAIM_ERROR,
        locked_until: null,
        locked_by:    null,
        updated_at:   new Date(nowMs).toISOString(),
      })
      .eq("id", r.id)
      // Guard on BOTH the status and the still-expired lock so we never clobber
      // a row a live worker just re-claimed (queued → generating, fresh lock)
      // between our SELECT and this UPDATE — its lock is in the future so the
      // `.lt` fails and the update touches 0 rows.
      .eq("status", "generating")
      .lt("locked_until", nowIso)
      .select("id");

    if (updErr) {
      console.error(JSON.stringify({ event: "stamp.queue.stuck_reclaim_error", error: updErr.message, job_id: r.id }));
      continue;
    }
    reclaimed += ((updated ?? []) as any[]).length;
  }

  if (reclaimed > 0) {
    console.log(JSON.stringify({
      event: "stamp.queue.stuck_generating_reclaimed",
      count: reclaimed,
    }));
  }
  return reclaimed;
}

// ── Permanent-error classification ────────────────────────────────────────────

// Error-message prefixes that can never succeed on retry — retrying only burns
// image-provider spend. Jobs failing with one of these go straight to the
// terminal `permanently_failed` status on first failure (admin manual re-queue
// still works and resets attempts/requeue_count).
const PERMANENT_ERROR_PREFIXES = [
  "catalog_not_found",
  // Image provider rejected the request in a way retries can't fix
  // (content-policy refusal or invalid-request 4xx). See imageProvider.ts.
  "provider_rejected",
] as const;

/**
 * True when an error message identifies a failure that cannot be fixed by
 * retrying (e.g. the catalog entry was deleted). Exported for tests.
 */
export function isPermanentGenerationError(errorMsg: string): boolean {
  return PERMANENT_ERROR_PREFIXES.some((p) => errorMsg.startsWith(p));
}

// ── Image download + upload ───────────────────────────────────────────────────

async function downloadImageBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed: ${res.status} ${url}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Classify a provider candidate URL.
 *
 *   placeholder — data:image/svg SVG from the dev PlaceholderProvider; stored
 *                 as-is, never uploaded (legacy behavior).
 *   data_image  — base64 data: URL carrying REAL raster art (gpt-image-1
 *                 returns b64_json normalized to data:image/png). Must be
 *                 decoded and uploaded to storage like remote art — treating
 *                 it as a placeholder would stuff megabytes of base64 into
 *                 public_url and skip storage entirely.
 *   remote      — http(s) URL to download.
 *
 * Exported for tests.
 */
export function classifyCandidateUrl(url: string): "placeholder" | "data_image" | "remote" {
  if (url.startsWith("data:image/svg")) return "placeholder";
  if (url.startsWith("data:")) return "data_image";
  return "remote";
}

/** Decode a base64 image data: URL into a raster buffer. */
export function decodeDataImageUrl(url: string): Buffer {
  const comma = url.indexOf(",");
  if (comma === -1) throw new Error("invalid data url");
  const meta = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  if (!/;base64$/i.test(meta)) throw new Error("data url is not base64-encoded");
  return Buffer.from(payload, "base64");
}

async function uploadBufferToPath(
  sc: any,
  path: string,
  buffer: Buffer,
  contentType = "image/png",
): Promise<string> {
  const { error } = await sc.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  // Return the storage path rather than a public URL — the stamp-artwork
  // bucket will be private; callers that need a displayable URL sign via
  // the admin relay or the Supabase signed-URL endpoint.
  return path;
}

async function uploadToStorage(
  sc: any,
  catalogId: string,
  versionId: string,
  buffer: Buffer,
  contentType = "image/png",
): Promise<string> {
  return uploadBufferToPath(sc, `catalog/${catalogId}/${versionId}.png`, buffer, contentType);
}

// ── Premium composition support (Stamp Wave 1) ───────────────────────────────

/**
 * True when the auto-approve artwork flag is enabled. Defensive: any error
 * (flag table missing, pre-2042 DB) → false, review_required path runs.
 */
async function autoApproveArtworkEnabled(sc: any): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "stamp_auto_approve_artwork")
      .maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Promote the first candidate in `versionInserts` to approved status, set it
 * as the catalog's active version, and archive all other candidates for this
 * catalog entry.
 *
 * Mirrors the activate-version admin endpoint logic (stampCatalog.ts ~523-635)
 * but runs inside the worker without an admin actor. Non-fatal: any DB error
 * is logged and the caller falls through to the normal review_required path.
 *
 * Returns true when the approval succeeded, false on any error.
 */
async function autoApproveFirstCandidate(
  sc: any,
  jobId: string,
  catalogId: string,
  canonicalLocationKey: string,
  stampType: string,
  versionInserts: any[],
): Promise<boolean> {
  const first = versionInserts[0];
  if (!first) return false;

  const versionId: string = first.id;
  const nowIso = new Date().toISOString();

  // 1. Approve the version row.
  const { error: vErr } = await sc
    .from("stamp_artwork_versions")
    .update({
      status:      "approved",
      reviewed_at: nowIso,
      // reviewed_by_admin_id left null — auto-approved by worker, not an admin.
    })
    .eq("id", versionId)
    .eq("catalog_id", catalogId)
    .eq("status", "candidate");

  if (vErr) {
    console.error(JSON.stringify({
      event:      "stamp.generation.auto_approve_version_error",
      job_id:     jobId,
      catalog_id: catalogId,
      version_id: versionId,
      error:      vErr.message,
    }));
    return false;
  }

  // 2. Point the catalog at the new active version and set status to approved.
  const { error: catErr } = await sc
    .from("universal_stamp_catalog")
    .update({
      active_version_id: versionId,
      status:            "approved",
      updated_at:        nowIso,
    })
    .eq("id", catalogId);

  if (catErr) {
    console.error(JSON.stringify({
      event:      "stamp.generation.auto_approve_catalog_error",
      job_id:     jobId,
      catalog_id: catalogId,
      version_id: versionId,
      error:      catErr.message,
    }));
    return false;
  }

  // 3. Archive any other candidates for this catalog entry.
  if (versionInserts.length > 1) {
    const otherIds = versionInserts.slice(1).map((v: any) => v.id);
    await sc
      .from("stamp_artwork_versions")
      .update({ status: "archived" })
      .eq("catalog_id", catalogId)
      .eq("status", "candidate")
      .in("id", otherIds);
    // Best-effort: log but don't fail the auto-approve on archive errors.
  }

  // 4. Invalidate catalog cache so the next /api/stamps/me poll sees the artwork.
  invalidateCatalogCache(canonicalLocationKey, stampType);

  console.log(JSON.stringify({
    event:      "stamp.generation.auto_approved",
    job_id:     jobId,
    catalog_id: catalogId,
    version_id: versionId,
  }));

  return true;
}

/**
 * True when the premium composition pipeline is enabled. Defensive: any error
 * (flag table missing, pre-0177 DB) → false, legacy path runs.
 */
async function premiumRenderingEnabled(sc: any): Promise<boolean> {
  try {
    const { data, error } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "stamp_premium_rendering_enabled")
      .maybeSingle();
    if (error) return false;
    return (data as any)?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Rarity for composition: the linked definition's rarity when exactly one
 * definition references this catalog entry; otherwise 'common'. (Rarity is a
 * definition-level concept; catalog artwork is shared. Per-definition rarity
 * variants are a later wave — hero_path is kept so recomposition is cheap.)
 */
async function rarityForCatalog(sc: any, catalogId: string): Promise<string> {
  try {
    const { data, error } = await sc
      .from("stamp_definitions")
      .select("rarity")
      .eq("catalog_id", catalogId)
      .limit(2);
    if (error || !Array.isArray(data) || data.length !== 1) return "common";
    return (data[0] as any)?.rarity ?? "common";
  } catch {
    return "common";
  }
}

// ── Orphan-cleanup error persistence ─────────────────────────────────────────

/**
 * Reads the existing `cleanup_error_paths` from the queue row, merges the new
 * failed paths into the accumulated list (deduplicating), then writes the
 * combined list back. This ensures paths from previous failed cleanup attempts
 * are never silently discarded across retries or worker restarts.
 *
 * Errors thrown by the DB read/write are caught and logged so a secondary
 * failure here never shadows the original generation error.
 */
export async function persistCleanupError(
  sc: any,
  jobId: string,
  errorMsg: string,
  newPaths: string[],
): Promise<void> {
  try {
    const readOnce = () => sc
      .from("stamp_generation_queue")
      .select("cleanup_error_paths")
      .eq("id", jobId)
      .maybeSingle();

    let { data: existing, error: readErr } = await readOnce();

    if (readErr) {
      // Transient read blips are common during a DB outage — retry once
      // before falling back, so most read failures still take the normal
      // read-merge-write path.
      ({ data: existing, error: readErr } = await readOnce());
    }

    if (readErr) {
      // If the read failed we cannot know what paths are already stored.
      // Writing with an empty fallback would replace the accumulated list
      // with only the new paths — silently losing earlier orphaned files.
      // Instead, append the new paths atomically server-side via an
      // append-only SQL function that needs no client-side merge base.
      // This survives a worker restart between the failed read and the
      // next cleanup attempt — the paths land in the DB, not just in logs.
      const { error: rpcErr } = await sc.rpc("append_stamp_cleanup_error_paths", {
        p_job_id: jobId,
        p_error:  errorMsg,
        p_paths:  newPaths,
      });
      if (rpcErr) {
        // Last resort: the paths exist only in this structured log. Ops can
        // recover them by searching for this event and the skipped_paths
        // field (see migration 0146 header for the recovery story).
        console.error(JSON.stringify({
          event:  "stamp.generation.cleanup_error_persist_read_failed",
          job_id: jobId,
          error:  readErr.message,
          rpc_error: rpcErr.message,
          skipped_paths: newPaths,
        }));
      } else {
        console.error(JSON.stringify({
          event:  "stamp.generation.cleanup_error_persist_appended_after_read_failure",
          job_id: jobId,
          error:  readErr.message,
          appended_paths: newPaths,
        }));
      }
      return;
    }

    const existingPaths: string[] = (existing?.cleanup_error_paths ?? []) as string[];
    // Deduplicate so the same path never appears twice even if two cleanup
    // attempts race on a restarted worker.
    const combined = [...new Set([...existingPaths, ...newPaths])];

    const { error: ceErr } = await sc
      .from("stamp_generation_queue")
      .update({
        cleanup_error:       errorMsg,
        cleanup_error_paths: combined,
        updated_at:          new Date().toISOString(),
      })
      .eq("id", jobId);

    if (ceErr) {
      console.error(JSON.stringify({
        event:  "stamp.generation.cleanup_error_persist_failed",
        job_id: jobId,
        error:  ceErr.message,
      }));
    }
  } catch (e: any) {
    console.error(JSON.stringify({
      event:  "stamp.generation.cleanup_error_persist_failed",
      job_id: jobId,
      error:  e?.message,
    }));
  }
}

// ── Single generation cycle ───────────────────────────────────────────────────

export async function runGenerationCycle(): Promise<{ processed: boolean; catalogId?: string }> {
  const sc = getServiceClient();
  if (!sc) {
    console.warn("[stamp-worker] Service client not available — skipping cycle");
    return { processed: false };
  }

  // Single clock read — interval checks, the lock-expiry probe, and the new
  // lock expiry all derive from nowMs so they can never disagree (split-clock risk).
  const nowMs = Date.now();

  // Periodically sweep stale retryable_failed jobs back into the queue, and
  // reclaim `generating` rows whose lock has expired (crashed worker) so they
  // don't wedge the catalog's active-job slot forever (audit STAMP·H4).
  if (nowMs - _lastAutoRequeueAt > AUTO_REQUEUE_CHECK_INTERVAL_MS) {
    _lastAutoRequeueAt = nowMs;
    try {
      await requeueStaleFailedJobs(sc);
    } catch (e: any) {
      console.error(JSON.stringify({ event: "stamp.queue.auto_requeue_error", error: e?.message }));
    }
    try {
      await requeueStuckGeneratingJobs(sc);
    } catch (e: any) {
      console.error(JSON.stringify({ event: "stamp.queue.stuck_reclaim_error", error: e?.message }));
    }
  }

  // Periodically sweep artwork rows with an outdated prompt_template_version
  // and enqueue new generation jobs so STYLE_VERSION bumps are picked up
  // automatically without manual intervention.
  if (STALE_ARTWORK_SWEEP_INTERVAL_MS > 0 && nowMs - _lastStaleArtworkSweepAt > STALE_ARTWORK_SWEEP_INTERVAL_MS) {
    _lastStaleArtworkSweepAt = nowMs;
    try {
      await sweepStaleArtwork(sc);
    } catch (e: any) {
      console.error(JSON.stringify({ event: "stamp.sweep.stale_artwork_error", error: e?.message }));
    }
  }

  // Fresh clock read AFTER the (potentially slow) pre-lock sweeps — the lock
  // window must be full-duration from acquisition, not from cycle start.
  // `now` and `lockUntil` both derive from this single read so the expiry
  // probe and the new lock expiry can never disagree (split-clock risk).
  const lockNowMs = Date.now();
  const now = new Date(lockNowMs).toISOString();

  // Claim one queued job with a pessimistic lock
  const { data: job, error: jobErr } = await sc
    .from("stamp_generation_queue")
    .select("id, catalog_id, attempts, max_attempts, triggered_by_action")
    .eq("status", "queued")
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .order("priority")
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (jobErr) {
    console.error(JSON.stringify({ event: "stamp.queue.poll_error", error: jobErr.message }));
    return { processed: false };
  }

  if (!job) return { processed: false }; // Nothing to do

  const { id: jobId, catalog_id: catalogId } = job as any;

  // Acquire lock atomically — verify a row was actually updated, not just that no error occurred.
  // Without this check a race between two workers can let both proceed on the same job.
  const lockUntil = new Date(lockNowMs + LOCK_DURATION_MS).toISOString();
  const { data: locked, error: lockErr } = await sc
    .from("stamp_generation_queue")
    .update({
      status:       "generating",
      locked_until: lockUntil,
      locked_by:    WORKER_ID,
      updated_at:   now,
    })
    .eq("id", jobId)
    .eq("status", "queued") // Guard: only transition from queued → generating
    .select("id");

  if (lockErr || !locked || (locked as any[]).length === 0) {
    // Another worker grabbed it first — skip silently
    return { processed: false };
  }

  console.log(JSON.stringify({ event: "stamp.generation.started", job_id: jobId, catalog_id: catalogId }));

  // Track storage paths uploaded in this batch so they can be deleted
  // if the loop fails mid-way (preventing orphaned storage files).
  const uploadedStoragePaths: string[] = [];

  try {
    // Load catalog entry
    const { data: catalogRow, error: catErr } = await sc
      .from("universal_stamp_catalog")
      .select("id, canonical_location_key, stamp_type, display_name, country, country_code, region, city, neighborhood")
      .eq("id", catalogId)
      .maybeSingle();

    if (catErr || !catalogRow) {
      throw new Error(`catalog_not_found: ${catalogId}`);
    }

    const entry: CatalogEntryForPrompt = catalogRow as any;

    // Premium composition path (Stamp Wave 1): AI paints hero art only; the
    // composition engine owns typography/borders/rarity. Flag-gated — when
    // off, the legacy full-stamp prompt + flat-raster path runs unchanged.
    const [premium, autoApprove] = await Promise.all([
      premiumRenderingEnabled(sc),
      autoApproveArtworkEnabled(sc),
    ]);
    const identity = premium ? await resolveIdentity(sc, { ...(catalogRow as any) }) : null;
    const prompt = premium && identity
      ? buildHeroArtPrompt(entry, identity)
      : buildStampPrompt(entry);

    // Generate candidates
    const provider = getStampImageProvider();
    const images = await provider.generate(prompt, CANDIDATE_COUNT);

    // Shortfall handling: below the configured minimum the run is treated as a
    // retryable failure; a degraded-but-reviewable run records the shortfall on
    // the queue row (last_error) so admins see generation was degraded.
    const shortfall = evaluateCandidateShortfall(images.length, CANDIDATE_COUNT);
    if (shortfall.outcome === "failed") {
      throw new Error(shortfall.shortfallMessage!);
    }
    if (shortfall.outcome === "degraded") {
      console.warn(JSON.stringify({
        event:      "stamp.generation.candidate_shortfall",
        job_id:     jobId,
        catalog_id: catalogId,
        produced:   images.length,
        expected:   CANDIDATE_COUNT,
      }));
    }

    // Detect placeholder-only generation: when STAMP_WORKER_ENABLED=true but
    // the OpenAI key is absent, getStampImageProvider() returns PlaceholderProvider
    // which emits data:image/svg URLs. These pass through as 'candidate' rows
    // but isValidUrl in UniversalStampArtwork rejects them, so the stamp always
    // shows the fallback icon. Emit a clear WARN so operators know the provider
    // is misconfigured and artwork will not render correctly on device.
    const allPlaceholders =
      images.length > 0 &&
      images.every((img) => classifyCandidateUrl(img.url) === "placeholder");
    if (allPlaceholders && process.env.STAMP_WORKER_ENABLED === "true") {
      console.warn(JSON.stringify({
        event:      "stamp.generation.provider_degraded",
        job_id:     jobId,
        catalog_id: catalogId,
        candidates: images.length,
        note:       "all candidates are placeholder SVGs — STAMP_WORKER_ENABLED=true but no real image provider is configured; artwork will not render correctly on device",
      }));
    }

    // Rarity treatment for premium composition (definition-level concept;
    // 'common' when the catalog entry has zero or several linked definitions).
    const compositionRarity = premium ? normalizeRarity(await rarityForCatalog(sc, catalogId)) : "common";

    // Upload each candidate and insert artwork version rows
    const versionInserts: any[] = [];

    for (const img of images) {
      const versionId = randomUUID();
      const urlKind = classifyCandidateUrl(img.url);

      let storagePath: string;
      let publicUrl: string;
      const extraColumns: Record<string, unknown> = {};

      if (urlKind === "placeholder") {
        // Dev placeholder SVG — store URL as-is (legacy behavior).
        storagePath = `placeholder/${catalogId}/${versionId}.svg`;
        publicUrl   = img.url;
      } else {
        // Real raster art: remote URL to download, or base64 data: URL from
        // gpt-image-1 (b64_json). Both become a hero buffer.
        const heroBuffer = urlKind === "data_image"
          ? decodeDataImageUrl(img.url)
          : await downloadImageBuffer(img.url);

        if (premium && identity) {
          // ── Premium: QC hero → compose → rasterize → QC → dual upload ──
          const heroQc = await validateHeroBuffer(heroBuffer);
          if (!heroQc.passed) {
            console.warn(JSON.stringify({
              event: "stamp.generation.hero_qc_failed",
              job_id: jobId, catalog_id: catalogId, reason: heroQc.reason,
            }));
            continue; // skip candidate; shortfall handling below
          }

          const composed = composeStamp({
            identity,
            title:    (entry.display_name ?? entry.city ?? "DESTINATION").toUpperCase(),
            subtitle: (entry.country ?? "").toUpperCase(),
            family:   templateFamilyForType(entry.stamp_type),
            rarity:   compositionRarity,
            heroImageDataUrl: `data:image/png;base64,${heroBuffer.toString("base64")}`,
            uid: versionId.slice(0, 8),
          });
          const raster = await rasterizeStamp(composed.svg);
          const composedQc = await validateComposedPng(raster.full);
          if (!composedQc.passed) {
            console.warn(JSON.stringify({
              event: "stamp.generation.composed_qc_failed",
              job_id: jobId, catalog_id: catalogId, reason: composedQc.reason,
            }));
            continue;
          }

          const heroPath  = `hero/${catalogId}/${versionId}.png`;
          const thumbPath = `catalog/${catalogId}/${versionId}_thumb.png`;
          storagePath     = `catalog/${catalogId}/${versionId}.png`;

          await uploadBufferToPath(sc, heroPath, heroBuffer);
          uploadedStoragePaths.push(heroPath);
          publicUrl = await uploadBufferToPath(sc, storagePath, raster.full);
          uploadedStoragePaths.push(storagePath);
          const thumbUrl = await uploadBufferToPath(sc, thumbPath, raster.thumbnail);
          uploadedStoragePaths.push(thumbPath);

          Object.assign(extraColumns, {
            width:          raster.width,
            height:         raster.height,
            format:         "png",
            hero_path:      heroPath,
            thumbnail_path: thumbPath,
            thumbnail_url:  thumbUrl,
            qc_status:      "passed",
            qc_metadata:    { hero: heroQc.checks, composed: composedQc.checks },
            composition:    { ...composed.manifest, hero_prompt_version: HERO_PROMPT_VERSION },
          });
        } else {
          // ── Legacy: upload the flat raster as-is ──
          publicUrl   = await uploadToStorage(sc, catalogId, versionId, heroBuffer);
          storagePath = `catalog/${catalogId}/${versionId}.png`;
          // Track so we can clean up on failure later in this batch.
          uploadedStoragePaths.push(storagePath);
        }
      }

      versionInserts.push({
        id:                      versionId,
        catalog_id:              catalogId,
        status:                  "candidate",
        storage_path:            storagePath!,
        public_url:              publicUrl!,
        generation_source:       urlKind === "placeholder" ? "placeholder" : "ai_generated",
        provider:                (img.metadata.model as string) ?? "openai_image",
        model_version:           (img.metadata.model as string) ?? "unknown",
        prompt_used:             prompt,
        prompt_template_version: STYLE_VERSION,
        generation_metadata:     {
          ...img.metadata,
          candidates_expected: CANDIDATE_COUNT,
          candidates_produced: images.length,
        },
        ...extraColumns,
      });
    }

    // Premium QC can reject candidates after generation: zero survivors is a
    // retryable failure (never insert an empty batch / never review nothing).
    if (versionInserts.length === 0) {
      throw new Error("all_candidates_failed_qc");
    }

    const { error: insertErr } = await sc
      .from("stamp_artwork_versions")
      .insert(versionInserts);

    if (insertErr) throw new Error(`version_insert_failed: ${insertErr.message}`);

    // Auto-approve: when the feature flag is on, promote the first passing
    // candidate immediately so earned stamps show artwork without waiting for
    // manual admin review.  Non-fatal: any DB error is logged and the cycle
    // continues to the normal review_required queue update below so the admin
    // still sees the job and can approve a different candidate if desired.
    if (autoApprove) {
      await autoApproveFirstCandidate(
        sc,
        jobId,
        catalogId,
        entry.canonical_location_key,
        entry.stamp_type,
        versionInserts,
      );
    }

    // Mark queue job as review_required. A degraded run records the shortfall
    // in last_error so the admin review screen can surface it; a full run
    // clears any stale error from a previous attempt.
    // When auto-approve ran successfully the catalog is already approved, but
    // the queue row stays review_required so admins can see the generation and
    // optionally switch to a different candidate via the activate-version endpoint.
    await sc
      .from("stamp_generation_queue")
      .update({
        status:       "review_required",
        last_error:   shortfall.shortfallMessage,
        locked_until: null,
        locked_by:    null,
        // Fresh intentional clock read after slow generation work,
        // expressed as a single derivation (split-clock guard).
        updated_at:   new Date(Date.now()).toISOString(),
      })
      .eq("id", jobId);

    // Invalidate cache so next catalog lookup re-reads fresh status
    invalidateCatalogCache(entry.canonical_location_key, entry.stamp_type);

    console.log(JSON.stringify({
      event:      "stamp.generation.success",
      job_id:     jobId,
      catalog_id: catalogId,
      candidates: images.length,
    }));

    return { processed: true, catalogId };

  } catch (err: any) {
    const errorMsg = err?.message ?? String(err);
    console.error(JSON.stringify({
      event:      "stamp.generation.failed",
      job_id:     jobId,
      catalog_id: catalogId,
      error:      errorMsg,
    }));

    // Clean up any files that were successfully uploaded before the failure so
    // they don't become orphaned (no DB row will reference them).
    if (uploadedStoragePaths.length > 0) {
      try {
        const { error: removeErr } = await sc.storage.from(STORAGE_BUCKET).remove(uploadedStoragePaths);
        if (removeErr) {
          console.error(JSON.stringify({
            event:      "stamp.generation.orphan_cleanup_error",
            job_id:     jobId,
            catalog_id: catalogId,
            error:      removeErr?.message,
            paths:      uploadedStoragePaths,
          }));
          // Accumulate orphaned paths on the queue row across retries and
          // restarts so ops can enumerate them from the admin UI.
          await persistCleanupError(sc, jobId, removeErr.message ?? String(removeErr), uploadedStoragePaths);
        } else {
          console.log(JSON.stringify({
            event:      "stamp.generation.orphan_cleanup",
            job_id:     jobId,
            catalog_id: catalogId,
            deleted:    uploadedStoragePaths.length,
          }));
        }
      } catch (cleanupErr: any) {
        const cleanupErrMsg = cleanupErr?.message ?? String(cleanupErr);
        console.error(JSON.stringify({
          event:      "stamp.generation.orphan_cleanup_error",
          job_id:     jobId,
          catalog_id: catalogId,
          error:      cleanupErrMsg,
          paths:      uploadedStoragePaths,
        }));
        // Accumulate orphaned paths on the queue row across retries and
        // restarts so ops can enumerate them from the admin UI.
        await persistCleanupError(sc, jobId, cleanupErrMsg, uploadedStoragePaths);
      }
    }

    // Increment attempts. Known-permanent errors (e.g. deleted catalog entry)
    // skip retries entirely and go straight to terminal permanently_failed;
    // transient errors keep the retry + capped auto-requeue behaviour.
    const newAttempts = ((job as any).attempts ?? 0) + 1;
    const maxAttempts = ((job as any).max_attempts ?? 3);
    let newStatus: string;
    if (isPermanentGenerationError(errorMsg)) {
      newStatus = "permanently_failed";
      console.error(JSON.stringify({
        event:      "stamp.generation.permanent_error",
        job_id:     jobId,
        catalog_id: catalogId,
        error:      errorMsg,
      }));
    } else {
      newStatus = newAttempts >= maxAttempts ? "retryable_failed" : "queued";
    }

    await sc
      .from("stamp_generation_queue")
      .update({
        status:       newStatus,
        attempts:     newAttempts,
        last_error:   errorMsg,
        locked_until: null,
        locked_by:    null,
        // Fresh intentional clock read after slow generation work,
        // expressed as a single derivation (split-clock guard).
        updated_at:   new Date(Date.now()).toISOString(),
      })
      .eq("id", jobId);

    return { processed: false };
  }
}

// ── Worker health ─────────────────────────────────────────────────────────────

export interface StampWorkerHealth {
  worker_enabled: boolean;
  worker_running: boolean;
  worker_id: string;
  last_success_at: string | null;
  queue_depth: Record<string, number>;
  stuck_jobs: Array<{
    id: string;
    catalog_id: string;
    locked_by: string | null;
    locked_until: string | null;
    updated_at: string | null;
  }>;
  /**
   * True when the worker is enabled but the last N artwork versions are all
   * placeholders — indicating the image provider (OpenAI) is unconfigured and
   * artwork will never render correctly on device.
   */
  provider_degraded: boolean;
}

/**
 * Query worker health from the queue table.
 *
 * - last_success_at: most recent artwork version insert (persistent across restarts)
 * - queue_depth: count of queue rows per status
 * - stuck_jobs: rows still in `generating` whose lock has expired — a crashed
 *   worker never released them.
 *
 * Returns null when the service client is not configured.
 */
export async function queryStampWorkerHealth(): Promise<StampWorkerHealth | null> {
  const sc = getServiceClient();
  if (!sc) return null;

  const nowIso = new Date().toISOString();

  // How many recent artwork versions to inspect for the provider_degraded check.
  const PROVIDER_DEGRADED_WINDOW = 5;

  const [statusRes, lastSuccessRes, stuckRes, recentSourcesRes] = await Promise.all([
    sc.from("stamp_generation_queue").select("status"),
    sc
      .from("stamp_artwork_versions")
      .select("created_at")
      .eq("generation_source", "ai_generated")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sc
      .from("stamp_generation_queue")
      .select("id, catalog_id, locked_by, locked_until, updated_at")
      .eq("status", "generating")
      .lt("locked_until", nowIso)
      .order("locked_until")
      .limit(50),
    sc
      .from("stamp_artwork_versions")
      .select("generation_source")
      .order("created_at", { ascending: false })
      .limit(PROVIDER_DEGRADED_WINDOW),
  ]);

  if (statusRes.error) {
    throw new Error(`worker_health_query_failed: ${statusRes.error.message}`);
  }

  const queueDepth: Record<string, number> = {};
  for (const row of (statusRes.data ?? []) as Array<{ status: string }>) {
    queueDepth[row.status] = (queueDepth[row.status] ?? 0) + 1;
  }

  const workerEnabled = process.env.STAMP_WORKER_ENABLED === "true";
  const recentSources = (recentSourcesRes.data ?? []) as Array<{ generation_source: string }>;
  const providerDegraded =
    workerEnabled &&
    recentSources.length > 0 &&
    recentSources.every((r) => r.generation_source === "placeholder");

  return {
    worker_enabled: workerEnabled,
    worker_running: _workerInterval !== null,
    worker_id: WORKER_ID,
    last_success_at: (lastSuccessRes.data as any)?.created_at ?? null,
    queue_depth: queueDepth,
    stuck_jobs: (stuckRes.data ?? []) as StampWorkerHealth["stuck_jobs"],
    provider_degraded: providerDegraded,
  };
}

// ── Periodic health monitor ───────────────────────────────────────────────────
//
// Re-runs the same health query on an interval so a mid-run stall (rate
// limits, provider outage, crashed worker) surfaces in the logs without
// waiting for the next deploy or a manual hit on the admin endpoint.

export interface HealthWarning {
  key: "stuck_jobs" | "backlog_growing" | "provider_degraded";
  message: string;
  details: Record<string, unknown>;
}

/**
 * Pure evaluation of a health snapshot against the previous queued depth.
 * Exported for tests.
 *
 * - stuck_jobs: any job still `generating` past lock expiry.
 * - backlog_growing: worker is enabled but the queued count grew since the
 *   previous tick — the worker isn't keeping up (or isn't actually running).
 */
export function evaluateWorkerHealth(
  health: StampWorkerHealth,
  prevQueuedDepth: number | null,
): HealthWarning[] {
  const warnings: HealthWarning[] = [];

  if (health.stuck_jobs.length > 0) {
    warnings.push({
      key: "stuck_jobs",
      message:
        "stamp generation jobs stuck in 'generating' past lock expiry — worker may have crashed",
      details: {
        stuck_count: health.stuck_jobs.length,
        stuck_jobs: health.stuck_jobs,
      },
    });
  }

  const queued = health.queue_depth["queued"] ?? 0;
  if (
    health.worker_enabled &&
    prevQueuedDepth !== null &&
    queued > prevQueuedDepth
  ) {
    warnings.push({
      key: "backlog_growing",
      message:
        "stamp generation queued backlog is growing while the worker is enabled — worker may be stalled",
      details: {
        queued,
        previous_queued: prevQueuedDepth,
        last_success_at: health.last_success_at,
      },
    });
  }

  if (health.provider_degraded) {
    warnings.push({
      key: "provider_degraded",
      message:
        "stamp image provider is degraded — all recent artwork generations produced placeholder SVGs; configure AI_INTEGRATIONS_OPENAI_API_KEY / STAMP_IMAGE_MODEL so artwork renders correctly on device",
      details: {
        worker_enabled: health.worker_enabled,
      },
    });
  }

  return warnings;
}

const HEALTH_MONITOR_INTERVAL_MS = 15 * 60 * 1_000; // 15 min between checks
const WARN_COOLDOWN_MS = 60 * 60 * 1_000; // at most one warning per type per hour

let _monitorInterval: ReturnType<typeof setInterval> | null = null;
let _prevQueuedDepth: number | null = null;
const _lastWarnedAt = new Map<string, number>();

type HealthLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

/**
 * One monitor tick: query health, evaluate, and emit rate-limited warnings.
 * Exported for tests; `now` is injectable for deterministic cooldown checks.
 * Returns the warnings that were actually logged (after rate limiting).
 */
export async function runHealthMonitorTick(
  log: HealthLogger,
  queryHealth: () => Promise<StampWorkerHealth | null> = queryStampWorkerHealth,
  now: () => number = Date.now,
): Promise<HealthWarning[]> {
  const health = await queryHealth();
  if (!health) return []; // service client not configured — skip

  const warnings = evaluateWorkerHealth(health, _prevQueuedDepth);
  _prevQueuedDepth = health.queue_depth["queued"] ?? 0;

  const emitted: HealthWarning[] = [];
  for (const w of warnings) {
    const last = _lastWarnedAt.get(w.key);
    if (last !== undefined && now() - last < WARN_COOLDOWN_MS) continue; // rate-limited
    _lastWarnedAt.set(w.key, now());
    log.warn(w.details, `stamp worker health: ${w.message}`);
    emitted.push(w);
  }
  return emitted;
}

/**
 * Evaluate warnings for a health snapshot using the monitor's last-known
 * queued depth, WITHOUT mutating monitor state. Used by the admin
 * worker-health endpoint so admins see the same findings the periodic
 * monitor logs (stuck jobs always; backlog growth once the monitor has a
 * baseline from a previous tick).
 */
export function evaluateCurrentWorkerHealth(health: StampWorkerHealth): HealthWarning[] {
  return evaluateWorkerHealth(health, _prevQueuedDepth);
}

/** Reset monitor state between tests. */
export function resetHealthMonitorState(): void {
  _prevQueuedDepth = null;
  _lastWarnedAt.clear();
}

/** Reset stale-artwork sweep timer between tests. */
export function resetStaleArtworkSweepState(): void {
  _lastStaleArtworkSweepAt = 0;
}

export function startHealthMonitorLoop(
  log: HealthLogger,
  intervalMs = HEALTH_MONITOR_INTERVAL_MS,
): void {
  if (_monitorInterval) return; // Already running

  console.log(JSON.stringify({
    event:       "stamp.health_monitor.started",
    interval_ms: intervalMs,
  }));

  _monitorInterval = setInterval(() => {
    runHealthMonitorTick(log).catch((e) =>
      log.warn({ err: e?.message ?? String(e) }, "stamp worker health: periodic check failed"),
    );
  }, intervalMs);
  // Don't keep the process alive just for the monitor
  (_monitorInterval as any).unref?.();
}

export function stopHealthMonitorLoop(): void {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
    console.log(JSON.stringify({ event: "stamp.health_monitor.stopped" }));
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────

let _workerInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkerLoop(intervalMs = 30_000): void {
  if (_workerInterval) return; // Already running

  console.log(JSON.stringify({
    event:       "stamp.worker.started",
    interval_ms: intervalMs,
    worker_id:   WORKER_ID,
  }));

  // Run immediately on start, then on interval
  runGenerationCycle().catch((e) =>
    console.error(JSON.stringify({ event: "stamp.worker.cycle_error", error: e?.message }))
  );

  _workerInterval = setInterval(() => {
    runGenerationCycle().catch((e) =>
      console.error(JSON.stringify({ event: "stamp.worker.cycle_error", error: e?.message }))
    );
  }, intervalMs);
}

export function stopWorkerLoop(): void {
  if (_workerInterval) {
    clearInterval(_workerInterval);
    _workerInterval = null;
    console.log(JSON.stringify({ event: "stamp.worker.stopped", worker_id: WORKER_ID }));
  }
}
