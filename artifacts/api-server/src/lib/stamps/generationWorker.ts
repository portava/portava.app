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
 */

import { randomUUID } from "crypto";
import { getServiceClient } from "../supabase.js";
import { buildStampPrompt, STYLE_VERSION, CANDIDATE_COUNT } from "./artDirection.js";
import { getStampImageProvider } from "./imageProvider.js";
import type { CatalogEntryForPrompt } from "./artDirection.js";
import { invalidateCatalogCache } from "./StampCatalogService.js";

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

  const cutoff = new Date(Date.now() - AUTO_REQUEUE_AFTER_HOURS * 3_600_000).toISOString();

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
        updated_at:   new Date().toISOString(),
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
        status:              "queued",
        attempts:            0,
        last_error:          null,
        cleanup_error:       null,
        cleanup_error_paths: null,
        locked_until:        null,
        locked_by:           null,
        requeue_count:       count + 1,
        updated_at:          new Date().toISOString(),
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

async function uploadToStorage(
  sc: any,
  catalogId: string,
  versionId: string,
  buffer: Buffer,
  contentType = "image/png",
): Promise<string> {
  const path = `catalog/${catalogId}/${versionId}.png`;
  const { error } = await sc.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, {
      contentType,
      upsert: false,
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data: urlData } = sc.storage
    .from(STORAGE_BUCKET)
    .getPublicUrl(path);

  return urlData?.publicUrl ?? path;
}

// ── Single generation cycle ───────────────────────────────────────────────────

export async function runGenerationCycle(): Promise<{ processed: boolean; catalogId?: string }> {
  const sc = getServiceClient();
  if (!sc) {
    console.warn("[stamp-worker] Service client not available — skipping cycle");
    return { processed: false };
  }

  // Periodically sweep stale retryable_failed jobs back into the queue
  if (Date.now() - _lastAutoRequeueAt > AUTO_REQUEUE_CHECK_INTERVAL_MS) {
    _lastAutoRequeueAt = Date.now();
    try {
      await requeueStaleFailedJobs(sc);
    } catch (e: any) {
      console.error(JSON.stringify({ event: "stamp.queue.auto_requeue_error", error: e?.message }));
    }
  }

  const now = new Date().toISOString();

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
  const lockUntil = new Date(Date.now() + LOCK_DURATION_MS).toISOString();
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
    const prompt = buildStampPrompt(entry);

    // Generate candidates
    const provider = getStampImageProvider();
    const images = await provider.generate(prompt, CANDIDATE_COUNT);

    if (images.length === 0) {
      throw new Error("No images generated — all provider calls failed");
    }

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

    // Upload each candidate and insert artwork version rows
    const versionInserts: any[] = [];

    for (const img of images) {
      const versionId = randomUUID();

      // Download image buffer (skip for placeholder data-URLs)
      let storagePath: string;
      let publicUrl: string;

      if (img.url.startsWith("data:")) {
        // Placeholder provider — store URL as-is
        storagePath = `placeholder/${catalogId}/${versionId}.svg`;
        publicUrl   = img.url;
      } else {
        const buffer = await downloadImageBuffer(img.url);
        publicUrl   = await uploadToStorage(sc, catalogId, versionId, buffer);
        storagePath = `catalog/${catalogId}/${versionId}.png`;
        // Track so we can clean up on failure later in this batch.
        uploadedStoragePaths.push(storagePath);
      }

      versionInserts.push({
        id:                      versionId,
        catalog_id:              catalogId,
        status:                  "candidate",
        storage_path:            storagePath,
        public_url:              publicUrl,
        generation_source:       "ai_generated",
        provider:                (img.metadata.model as string) ?? "openai_dalle3",
        model_version:           "dall-e-3",
        prompt_used:             prompt,
        prompt_template_version: STYLE_VERSION,
        generation_metadata:     {
          ...img.metadata,
          candidates_expected: CANDIDATE_COUNT,
          candidates_produced: images.length,
        },
      });
    }

    const { error: insertErr } = await sc
      .from("stamp_artwork_versions")
      .insert(versionInserts);

    if (insertErr) throw new Error(`version_insert_failed: ${insertErr.message}`);

    // Mark queue job as review_required. A degraded run records the shortfall
    // in last_error so the admin review screen can surface it; a full run
    // clears any stale error from a previous attempt.
    await sc
      .from("stamp_generation_queue")
      .update({
        status:       "review_required",
        last_error:   shortfall.shortfallMessage,
        locked_until: null,
        locked_by:    null,
        updated_at:   new Date().toISOString(),
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
        await sc.storage.from(STORAGE_BUCKET).remove(uploadedStoragePaths);
        console.log(JSON.stringify({
          event:      "stamp.generation.orphan_cleanup",
          job_id:     jobId,
          catalog_id: catalogId,
          deleted:    uploadedStoragePaths.length,
        }));
      } catch (cleanupErr: any) {
        const cleanupErrMsg = cleanupErr?.message ?? String(cleanupErr);
        console.error(JSON.stringify({
          event:      "stamp.generation.orphan_cleanup_error",
          job_id:     jobId,
          catalog_id: catalogId,
          error:      cleanupErrMsg,
          paths:      uploadedStoragePaths,
        }));
        // Record cleanup failure on the queue row so it surfaces in the admin UI.
        // We do this as a best-effort fire-and-forget; a failure here must not
        // shadow the original generation error that caused the catch block.
        sc.from("stamp_generation_queue")
          .update({
            cleanup_error:       cleanupErrMsg,
            cleanup_error_paths: uploadedStoragePaths,
            updated_at:          new Date().toISOString(),
          })
          .eq("id", jobId)
          .then(({ error: ceErr }: { error: any }) => {
            if (ceErr) {
              console.error(JSON.stringify({
                event:  "stamp.generation.cleanup_error_persist_failed",
                job_id: jobId,
                error:  ceErr.message,
              }));
            }
          });
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
        updated_at:   new Date().toISOString(),
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

  const [statusRes, lastSuccessRes, stuckRes] = await Promise.all([
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
  ]);

  if (statusRes.error) {
    throw new Error(`worker_health_query_failed: ${statusRes.error.message}`);
  }

  const queueDepth: Record<string, number> = {};
  for (const row of (statusRes.data ?? []) as Array<{ status: string }>) {
    queueDepth[row.status] = (queueDepth[row.status] ?? 0) + 1;
  }

  return {
    worker_enabled: process.env.STAMP_WORKER_ENABLED === "true",
    worker_running: _workerInterval !== null,
    worker_id: WORKER_ID,
    last_success_at: (lastSuccessRes.data as any)?.created_at ?? null,
    queue_depth: queueDepth,
    stuck_jobs: (stuckRes.data ?? []) as StampWorkerHealth["stuck_jobs"],
  };
}

// ── Periodic health monitor ───────────────────────────────────────────────────
//
// Re-runs the same health query on an interval so a mid-run stall (rate
// limits, provider outage, crashed worker) surfaces in the logs without
// waiting for the next deploy or a manual hit on the admin endpoint.

export interface HealthWarning {
  key: "stuck_jobs" | "backlog_growing";
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
