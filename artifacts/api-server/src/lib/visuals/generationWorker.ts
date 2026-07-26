/**
 * VisualGenerationWorker
 *
 * Polls `generated_visuals` for `status = 'queued'` rows whose `retry_after`
 * is past (or absent), claims each with a pessimistic lock (locked_until /
 * locked_by), delegates to processJob(), then applies exponential-backoff
 * retry logic or marks a terminal status.
 *
 * Recovery: on each cycle the worker resets any `generating` row past its
 * `locked_until` back to `queued` so jobs orphaned by a crashed worker are
 * automatically picked up again.
 *
 * Start via startVisualGenerationWorker() from index.ts.
 * Graceful shutdown on SIGTERM via stopVisualGenerationWorker().
 */

import { randomUUID } from "crypto";
import { getServiceClient } from "../supabase.js";
import { processJob } from "./service.js";
import { emitVisualEvent } from "./analytics.js";
import { logger } from "../logger.js";

const WORKER_ID = `visual-worker-${randomUUID()}`;
const LOCK_DURATION_MS = 5 * 60 * 1_000; // 5-min pessimistic lock

// Interval between polling cycles. Overridable for tests.
const DEFAULT_POLL_INTERVAL_MS =
  Number(process.env.AI_VISUAL_WORKER_INTERVAL_MS ?? "15000") || 15_000;

// Maximum provider attempts before the job is permanently failed.
// Env var is shared with service.ts so a single setting controls both.
export const MAX_RETRIES = Math.max(
  1,
  Number(process.env.AI_VISUAL_MAX_RETRIES ?? "5") || 5,
);

// Exponential backoff schedule (ms): attempt 1→30 s, 2→2 min, 3→10 min,
// 4→30 min, 5→2 h. Index = attempt_count after the failed attempt.
const BACKOFF_MS = [
  30_000,          // 30 s
  2 * 60_000,      // 2 min
  10 * 60_000,     // 10 min
  30 * 60_000,     // 30 min
  2 * 60 * 60_000, // 2 h
] as const;

function backoffForAttempt(attemptCount: number): number {
  const idx = Math.max(0, Math.min(attemptCount - 1, BACKOFF_MS.length - 1));
  return BACKOFF_MS[idx];
}

// ── Stuck-job recovery ────────────────────────────────────────────────────────

/**
 * Reset `generating` rows past their `locked_until` back to `queued`.
 * These are jobs whose worker process crashed before releasing the lock.
 * Accepts an injectable client override for tests.
 */
export async function recoverStuckVisualJobs(scOverride?: any): Promise<number> {
  const sc = scOverride ?? getServiceClient();
  if (!sc) return 0;

  const now = new Date().toISOString();
  const { data: stuck, error } = await sc
    .from("generated_visuals")
    .select("id")
    .eq("status", "generating")
    .lt("locked_until", now)
    .limit(50);

  if (error) {
    logger.warn({ event: "visual_worker.stuck_job_recovery_error", error: error.message });
    return 0;
  }

  const rows = (stuck ?? []) as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const { error: resetErr } = await sc
    .from("generated_visuals")
    .update({
      status:       "queued",
      locked_until: null,
      locked_by:    null,
      retry_after:  null,
      updated_at:   now,
    })
    .in("id", rows.map((r) => r.id))
    .eq("status", "generating");

  if (resetErr) {
    logger.warn({ event: "visual_worker.stuck_job_reset_error", error: resetErr.message });
    return 0;
  }

  logger.info({ event: "visual_worker.stuck_jobs_recovered", count: rows.length });
  return rows.length;
}

// ── Single generation cycle ───────────────────────────────────────────────────

export async function runVisualGenerationCycle(): Promise<{
  processed: boolean;
  visualId?: string;
}> {
  const sc = getServiceClient();
  if (!sc) {
    logger.warn({ event: "visual_worker.no_service_client" });
    return { processed: false };
  }

  // Recover stuck jobs before claiming new work.
  try {
    await recoverStuckVisualJobs(sc);
  } catch (e: any) {
    logger.warn({ event: "visual_worker.recovery_error", error: e?.message });
  }

  // Clock read AFTER recovery sweeps so the lock window is full-duration from
  // the moment of acquisition (split-clock guard).
  const lockNowMs = Date.now();
  const now       = new Date(lockNowMs).toISOString();
  const lockUntil = new Date(lockNowMs + LOCK_DURATION_MS).toISOString();

  // Claim one queued job whose retry_after is past or absent.
  const { data: job, error: jobErr } = await sc
    .from("generated_visuals")
    .select("id, entity_type, entity_id, purpose, style, attempt_count, provider")
    .eq("status", "queued")
    .or(`retry_after.is.null,retry_after.lte.${now}`)
    .order("created_at")
    .limit(1)
    .maybeSingle();

  if (jobErr) {
    logger.warn({ event: "visual_worker.poll_error", error: jobErr.message });
    return { processed: false };
  }

  if (!job) return { processed: false }; // Nothing ready to process.

  const {
    id: visualId,
    entity_type,
    entity_id,
    purpose,
    style,
    attempt_count,
    provider,
  } = job as any;

  // Atomically acquire the lock — only transition from queued → generating so
  // a race between two workers can never let both proceed on the same row.
  const { data: locked, error: lockErr } = await sc
    .from("generated_visuals")
    .update({
      status:       "generating",
      locked_until: lockUntil,
      locked_by:    WORKER_ID,
      updated_at:   now,
    })
    .eq("id", visualId)
    .eq("status", "queued")
    .select("id");

  if (lockErr || !locked || (locked as any[]).length === 0) {
    // Another worker claimed it first — skip silently.
    return { processed: false };
  }

  const startMs = Date.now();

  emitVisualEvent("visual_generation_started", {
    entity_type,
    entity_id,
    purpose,
    style,
    status:        "generating",
    visual_id:     visualId,
    attempt_count: attempt_count ?? 0,
    provider,
  });

  // Run the generation job. processJob() handles all provider calls, derivative
  // upload, and DB status transitions; it never throws.
  try {
    await processJob(visualId);
  } catch (e: any) {
    // Defensive — processJob is designed not to throw, but guard anyway.
    logger.error({
      event:     "visual_worker.process_job_exception",
      visual_id: visualId,
      error:     e?.message,
    });
  }

  // Read back the final state that processJob() left the row in.
  const { data: updated } = await sc
    .from("generated_visuals")
    .select("status, failure_code, attempt_count")
    .eq("id", visualId)
    .maybeSingle();

  const finalStatus:       string = (updated as any)?.status        ?? "failed";
  const failureCode:       string | null = (updated as any)?.failure_code ?? null;
  const finalAttemptCount: number = (updated as any)?.attempt_count ?? (attempt_count ?? 0) + 1;
  const durationMs:        number = Date.now() - startMs;

  // ── Success ───────────────────────────────────────────────────────────────
  if (finalStatus === "ready") {
    emitVisualEvent("visual_generation_completed", {
      entity_type,
      entity_id,
      purpose,
      style,
      status:        "ready",
      visual_id:     visualId,
      duration_ms:   durationMs,
      attempt_count: finalAttemptCount,
      provider,
    });
    return { processed: true, visualId };
  }

  // ── Non-retryable (blocked) ───────────────────────────────────────────────
  // processJob() already set status = 'blocked' for provider_rejected failures.
  if (finalStatus === "blocked") {
    emitVisualEvent("visual_generation_blocked", {
      entity_type,
      entity_id,
      purpose,
      style,
      status:        "blocked",
      visual_id:     visualId,
      failure_code:  failureCode,
      attempt_count: finalAttemptCount,
      provider,
    });
    return { processed: true, visualId };
  }

  // ── Failed — decide whether to retry ─────────────────────────────────────
  // `provider_rejected` failureCode indicates processJob set status='blocked'
  // above. Any remaining 'failed' rows are retryable in principle.
  if (finalAttemptCount < MAX_RETRIES) {
    const backoffMs   = backoffForAttempt(finalAttemptCount);
    const retryNowMs  = Date.now();
    const retryAfter  = new Date(retryNowMs + backoffMs).toISOString();
    const retryNowIso = new Date(retryNowMs).toISOString();

    await sc
      .from("generated_visuals")
      .update({
        status:       "queued",
        retry_after:  retryAfter,
        locked_until: null,
        locked_by:    null,
        updated_at:   retryNowIso,
      })
      .eq("id", visualId);

    logger.info({
      event:         "visual_worker.job_retry_scheduled",
      visual_id:     visualId,
      entity_type,
      entity_id,
      purpose,
      attempt_count: finalAttemptCount,
      retry_after:   retryAfter,
      backoff_ms:    backoffMs,
    });
  } else {
    // Retries exhausted — keep the row in 'failed' (processJob already did
    // this), just emit the terminal analytics event.
    emitVisualEvent("visual_generation_failed", {
      entity_type,
      entity_id,
      purpose,
      style,
      status:        "failed",
      visual_id:     visualId,
      failure_code:  failureCode,
      attempt_count: finalAttemptCount,
      provider,
    });
  }

  return { processed: true, visualId };
}

// ── Worker loop ───────────────────────────────────────────────────────────────

let _workerInterval: ReturnType<typeof setInterval> | null = null;

export function startVisualGenerationWorker(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  if (_workerInterval) return; // Already running.

  logger.info({
    event:       "visual_worker.started",
    interval_ms: intervalMs,
    worker_id:   WORKER_ID,
    max_retries: MAX_RETRIES,
  });

  // Run immediately on start, then on each interval.
  runVisualGenerationCycle().catch((e) =>
    logger.error({ event: "visual_worker.cycle_error", error: e?.message }),
  );

  _workerInterval = setInterval(() => {
    runVisualGenerationCycle().catch((e) =>
      logger.error({ event: "visual_worker.cycle_error", error: e?.message }),
    );
  }, intervalMs);
}

export function stopVisualGenerationWorker(): void {
  if (_workerInterval) {
    clearInterval(_workerInterval);
    _workerInterval = null;
    logger.info({ event: "visual_worker.stopped", worker_id: WORKER_ID });
  }
}
