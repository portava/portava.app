/**
 * pendingUploadSweepScheduler — the caller `POST /api/postcards/sweep-orphans`
 * never had. census-discovery DV-77, §56.
 *
 * ── WHY A SCHEDULER, AND WHY THAT IS THE WHOLE FIX ───────────────────────────
 * Phase 0.4 (`docs/specs/discovery-architecture-v1/discovery-v1-12-
 * implementation-plan.md`): *"no raw unstripped original can persist merely
 * because a completion handler never runs."* The sweep that removes such an
 * original has existed since 2026-08-11 and is correct in its ordering — but it
 * was an internal-secret endpoint "designed to be called on a schedule", and
 * nothing called it: no scheduler in `src/index.ts`, no cron, no workflow
 * (`docs/fact-layer-20260810/PROMOTION.md` §C, re-verified for §56). A sweep
 * nobody runs bounds nothing. This is the timer, and only the timer; the pass
 * itself is `services/media/PendingUploadSweep.ts`, shared with the endpoint.
 *
 * ── THE BOUND IT GIVES, STATED EXACTLY ───────────────────────────────────────
 * With the flag on and the database readable, an upload whose completion never
 * ran is removed — object, feed variant, resumable parts, poster, then row —
 * no later than `PENDING_UPLOAD_ORPHAN_CUTOFF_MS + PENDING_UPLOAD_SWEEP_INTERVAL_MS`
 * after its slot was reserved, while fewer than `PENDING_UPLOAD_SWEEP_BATCH`
 * slots are abandoned per interval. Past that rate the backlog drains OLDEST
 * FIRST at one batch per interval, and the pass says `more: true` rather than
 * reporting a clean run. Until then the bytes are never SERVED to anyone but
 * their owner: `lib/mediaAccess.ts` branch 3a refuses a `post_media` object
 * whose row is not `ready` (§56).
 *
 * ── GATED, AND WHY ───────────────────────────────────────────────────────────
 * The pass DELETES user uploads. `media_pending_upload_sweep_enabled`
 * (migration 3400) is seeded FALSE and read at the top of every pass with
 * `readFlagState`, which keeps four answers apart:
 *
 *   on           run the pass
 *   off / absent nobody enabled it — do nothing, read nothing else
 *   unreadable   do nothing, and RECORD A FAILURE. A deletion job must not run
 *                on a guess, and "we could not read the flag" is not a quiet
 *                idle tick either: it is the job not running, said out loud.
 *
 * Turning it on is the owner's decision (§56 states the question). The house
 * pattern for a flag-gated interval worker (lib/media/mediaProcessingWorker.ts):
 * started unconditionally from src/index.ts, a self-rescheduling timer so passes
 * never overlap in one process, the flag read at the top of every pass. Across
 * instances two passes can race on one row; every step is idempotent (a missing
 * object is not a removal error, a deleted row deletes nothing).
 */
import { logger as rootLogger } from "../logger.js";
import { getServiceClient } from "../supabase.js";
import { readFlagState } from "../capability/schemaCapability.js";
import {
  sweepAbandonedPendingUploads,
  type PendingUploadSweepResult,
} from "../../services/media/PendingUploadSweep.js";

const logger = rootLogger.child({ job: "PendingUploadSweepScheduler" });

/**
 * Hourly — the cadence the sweep's own header named when it was written
 * ("designed to be called on a schedule (e.g. hourly cron …)"). UNRATIFIED: it
 * is the example that header gave, not a measured or decided number.
 */
export const PENDING_UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;

/** Let the process finish booting before the first pass touches storage. */
export const PENDING_UPLOAD_SWEEP_STARTUP_DELAY_MS = 120 * 1_000;

export type PendingUploadPassOutcome =
  | { ran: false; why: "flag_off" | "flag_absent" | "no_service_client" }
  /** A failure: the job did not run and must not look like it did. */
  | { ran: false; why: "flag_unreadable"; failed: true }
  | { ran: true; result: PendingUploadSweepResult; failed: boolean };

export interface PendingUploadSweepStatus {
  lastAttemptAt: string | null;
  /** A pass that RAN, read `post_media`, and kept no row back. The only healthy state. */
  lastSuccessAt: string | null;
  lastOutcome: PendingUploadPassOutcome | null;
}

const _status: PendingUploadSweepStatus = { lastAttemptAt: null, lastSuccessAt: null, lastOutcome: null };

export function getPendingUploadSweepStatus(): Readonly<PendingUploadSweepStatus> {
  return { ..._status };
}

/**
 * One pass. Exported for the tests and for the timer; never throws.
 *
 * `deps.sc` is injectable so a test can hand it a controlled client; production
 * passes nothing and gets the service client.
 */
export async function runPendingUploadSweepPass(
  deps: { sc?: any; nowMs?: number } = {},
): Promise<PendingUploadPassOutcome> {
  const nowMs = deps.nowMs ?? Date.now();
  _status.lastAttemptAt = new Date(nowMs).toISOString();
  const sc = deps.sc ?? getServiceClient();
  let outcome: PendingUploadPassOutcome;
  if (!sc) {
    outcome = { ran: false, why: "no_service_client" };
  } else {
    const flag = await readFlagState(sc, "media_pending_upload_sweep_enabled");
    if (flag === "unreadable") {
      logger.warn("pending-upload sweep: feature_flags unreadable — the sweep did NOT run this pass");
      outcome = { ran: false, why: "flag_unreadable", failed: true };
    } else if (flag !== "on") {
      outcome = { ran: false, why: flag === "off" ? "flag_off" : "flag_absent" };
    } else {
      const result = await sweepAbandonedPendingUploads(sc, { nowMs });
      const failed = !result.ok || result.errors > 0;
      if (!failed) _status.lastSuccessAt = new Date(nowMs).toISOString();
      if (!result.ok) logger.warn({ reason: result.reason }, "pending-upload sweep: pass could not read post_media");
      else logger.info({ swept: result.swept, errors: result.errors, more: result.more }, "pending-upload sweep: pass finished");
      outcome = { ran: true, result, failed };
    }
  }
  _status.lastOutcome = outcome;
  return outcome;
}

let _timer: ReturnType<typeof setTimeout> | null = null;
let _generation = 0;

/** Started from src/index.ts. `runPass` exists for the wiring test only. */
export function startPendingUploadSweepScheduler(
  deps: { runPass?: () => Promise<unknown> } = {},
): void {
  if (_timer !== null) return;
  const generation = _generation;
  const runPass = deps.runPass ?? (() => runPendingUploadSweepPass());
  logger.info(
    { startupDelayMs: PENDING_UPLOAD_SWEEP_STARTUP_DELAY_MS, intervalMs: PENDING_UPLOAD_SWEEP_INTERVAL_MS, flag: "media_pending_upload_sweep_enabled" },
    "PendingUploadSweepScheduler scheduled (no-op until the flag is enabled)",
  );
  _timer = setTimeout(function tick() {
    void Promise.resolve()
      .then(runPass)
      .catch((err) => logger.warn({ err }, "pending-upload sweep pass threw"))
      .finally(() => {
        if (generation === _generation) _timer = setTimeout(tick, PENDING_UPLOAD_SWEEP_INTERVAL_MS);
      });
  }, PENDING_UPLOAD_SWEEP_STARTUP_DELAY_MS);
}

export function stopPendingUploadSweepScheduler(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
