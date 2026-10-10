/**
 * highlight.expired — the clock half of §17's Highlight events (census H157).
 *
 * Highlights/Memories spec §5: DRAFT -> ACTIVE -> EXPIRED. §17 names
 * `highlight.expired`, and nothing ever wrote it: expiry is a read-time filter
 * (`expires_at > now`) and no command moves a Highlight into EXPIRED — the
 * clock does. So the event's producer is a scheduler, not a route.
 *
 * WHAT A PASS DOES. Calls public.highlight_expiry_emit (migration 3677) in
 * bounded batches. The function writes highlight.expired + its outbox row, in
 * one transaction, for each Highlight whose event log last said ACTIVE and
 * whose row is now EXPIRED (not pinned, hidden or deleted; expires_at passed).
 * It is idempotent by construction: the event it writes makes the log's last
 * word EXPIRED, so a second pass finds nothing. The outbox drain
 * (services/memoryProjections/outboxDrainRunner.ts) delivers the rows to
 * HIGHLIGHT_EVENT_PROJECTIONS["highlight.expired"] like every other event.
 *
 * GATED TWICE, fail-closed, both read every tick:
 *   - `highlight_expiry_events_enabled` (3677, seeded FALSE) — this producer;
 *   - `memory_kernel_enabled` (2710, FALSE) — whether the event store is the
 *     write path at all. With the kernel off no Highlight gets a stream, and an
 *     expiry stream with no creation would describe an aggregate the log never
 *     saw made.
 * Absent function (3677 unapplied) => `not_deployed`.
 *
 * THE HOUSE SHAPE (memoryDeletionRedriveScheduler): a startup delay, then a
 * self-rescheduling setTimeout that re-arms only while its own loop is current,
 * unref()'d, every error logged and swallowed; reports at GET
 * /healthz/schedulers as HIGHLIGHT_EXPIRY_JOB_KEY and, on every pass that RUNS,
 * writes that job_health row (attempt always, success only on success).
 */
import { getServiceClient } from "./supabase.js";
import { logger } from "./logger.js";
import { isFlagEnabled } from "./featureFlags.js";
import { MEMORY_KERNEL_FLAG } from "./memoryCommandBus.js";

export const HIGHLIGHT_EXPIRY_FLAG = "highlight_expiry_events_enabled";
export const HIGHLIGHT_EXPIRY_FN = "highlight_expiry_emit";
export const HIGHLIGHT_EXPIRY_JOB_KEY = "highlightExpiryEvents";
/** Rows per function call (3677 refuses outside 1..1000). */
export const HIGHLIGHT_EXPIRY_BATCH = 200;
/** Calls per tick; a backlog beyond this drains on the next tick. */
export const HIGHLIGHT_EXPIRY_MAX_BATCHES = 5;
const STARTUP_DELAY_MS = 4 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

export interface HighlightExpiryPassResult {
  skipped: boolean;
  reason: "disabled" | "kernel_disabled" | "no_client" | "not_deployed" | "error" | null;
  emitted: number;
  batches: number;
  /** The last call filled its batch: more may be due. */
  backlogRemains: boolean;
}

function isFunctionAbsent(err: any): boolean {
  const code = String(err?.code ?? "");
  return code === "PGRST202" || code === "42883";
}

export async function runHighlightExpiryPass(
  opts: { client?: any; now?: Date } = {},
): Promise<HighlightExpiryPassResult> {
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  const out: HighlightExpiryPassResult = { skipped: true, reason: null, emitted: 0, batches: 0, backlogRemains: false };
  if (!db) return { ...out, reason: "no_client" };
  if (!(await isFlagEnabled(db, HIGHLIGHT_EXPIRY_FLAG))) return { ...out, reason: "disabled" };
  if (!(await isFlagEnabled(db, MEMORY_KERNEL_FLAG))) return { ...out, reason: "kernel_disabled" };
  // ONE clock for the whole pass: every batch judges expiry against the same instant.
  const now = (opts.now ?? new Date()).toISOString();

  const result: HighlightExpiryPassResult = { ...out, skipped: false };
  try {
    for (let i = 0; i < HIGHLIGHT_EXPIRY_MAX_BATCHES; i++) {
      const { data, error } = await db.rpc(HIGHLIGHT_EXPIRY_FN, { p_now: now, p_limit: HIGHLIGHT_EXPIRY_BATCH });
      if (error) {
        if (isFunctionAbsent(error)) return { ...result, skipped: true, reason: "not_deployed" };
        logger.warn({ err: error }, "highlight expiry events: emit call failed");
        return { ...result, reason: "error" };
      }
      const emitted = Number((data as any)?.emitted);
      if (!Number.isFinite(emitted) || emitted < 0) {
        logger.warn({ data }, "highlight expiry events: emit returned no count");
        return { ...result, reason: "error" };
      }
      result.batches += 1;
      result.emitted += emitted;
      result.backlogRemains = (data as any)?.more === true;
      if (!result.backlogRemains) break;
    }
    if (result.emitted > 0) logger.info({ ...result }, "highlight expiry events pass complete");
    return result;
  } catch (err) {
    logger.warn({ err }, "highlight expiry events pass threw");
    return { ...result, reason: "error" };
  }
}

// ── status, health, job_health ───────────────────────────────────────────────

export interface HighlightExpiryStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastFailures: string[];
  lastResult: HighlightExpiryPassResult | null;
}

const _status: HighlightExpiryStatus = {
  lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastFailures: [], lastResult: null,
};

export function getHighlightExpiryStatus(): Readonly<HighlightExpiryStatus> {
  return { ..._status, lastFailures: [..._status.lastFailures], lastResult: _status.lastResult ? { ..._status.lastResult } : null };
}

/** Test seam. */
export function _resetHighlightExpiryStatus(): void {
  _status.lastAttemptAt = null; _status.lastSuccessAt = null; _status.consecutiveFailures = 0;
  _status.lastFailures = []; _status.lastResult = null;
}

/** The job failures one pass carries; empty = the pass succeeded. OFF is not a failure. */
export function highlightExpiryFailuresOf(r: HighlightExpiryPassResult): string[] {
  if (r.reason === "no_client") return ["no service client — the expiry pass did not run"];
  if (r.reason === "not_deployed") return [`${HIGHLIGHT_EXPIRY_FN} is absent while ${HIGHLIGHT_EXPIRY_FLAG} is ON — is 3677 applied?`];
  if (r.reason === "error") return ["the emit call failed or threw — expired Highlights were not recorded"];
  return [];
}

export function highlightExpiryHealthDetail(s: Readonly<HighlightExpiryStatus>): string | undefined {
  const parts: string[] = [];
  if (s.lastFailures.length > 0) parts.push(`last failures: ${s.lastFailures.join("; ")}`);
  const r = s.lastResult;
  if (r?.reason === "disabled") parts.push(`${HIGHLIGHT_EXPIRY_FLAG} is OFF (3677 seeds it FALSE): no highlight.expired is written`);
  else if (r?.reason === "kernel_disabled") parts.push(`${MEMORY_KERNEL_FLAG} is OFF: the event store is not the write path, so no expiry is recorded`);
  else if (r && !r.skipped) parts.push(`last pass: emitted ${r.emitted} in ${r.batches} batch(es)${r.backlogRemains ? ", backlog remains" : ""}`);
  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/** One tick: the pass, its status, and (when the pass ran) the job_health row. Never throws. */
export async function runHighlightExpiryTick(
  opts: { client?: any; now?: Date } = {},
): Promise<Readonly<HighlightExpiryStatus>> {
  const attemptAt = (opts.now ?? new Date()).toISOString();
  _status.lastAttemptAt = attemptAt;
  let result: HighlightExpiryPassResult;
  try {
    result = await runHighlightExpiryPass(opts);
  } catch (err) {
    logger.warn({ err }, "highlight expiry events pass threw");
    result = { skipped: true, reason: "error", emitted: 0, batches: 0, backlogRemains: false };
  }
  const failures = highlightExpiryFailuresOf(result);
  const succeeded = failures.length === 0;
  _status.lastResult = result;
  _status.lastFailures = failures;
  if (succeeded) { _status.consecutiveFailures = 0; _status.lastSuccessAt = attemptAt; }
  else _status.consecutiveFailures += 1;

  if (result.reason !== "disabled" && result.reason !== "kernel_disabled" && result.reason !== "no_client") {
    const db = opts.client !== undefined ? opts.client : getServiceClient();
    if (db) {
      const row: Record<string, unknown> = { job: HIGHLIGHT_EXPIRY_JOB_KEY, last_run_at: attemptAt };
      if (succeeded) row["last_success_at"] = attemptAt;
      try {
        const { error: healthErr } = await db.from("job_health").upsert(row, { onConflict: "job" });
        if (healthErr) logger.warn({ job: HIGHLIGHT_EXPIRY_JOB_KEY, err: healthErr }, "highlight expiry events: could not persist job health");
      } catch (err) {
        logger.warn({ job: HIGHLIGHT_EXPIRY_JOB_KEY, err }, "highlight expiry events: could not persist job health");
      }
    }
  }
  if (!succeeded) {
    logger.error({ job: HIGHLIGHT_EXPIRY_JOB_KEY, failures, ...result, consecutiveFailures: _status.consecutiveFailures },
      "highlight expiry events: pass did NOT succeed — expired Highlights are not being recorded");
  }
  return getHighlightExpiryStatus();
}

let _timer: ReturnType<typeof setTimeout> | null = null;
let _generation = 0;

export function startHighlightExpiryEventScheduler(
  timing: { startupDelayMs?: number; intervalMs?: number } = {},
): void {
  if (_timer !== null) return;
  const startupDelayMs = timing.startupDelayMs ?? STARTUP_DELAY_MS;
  const intervalMs = timing.intervalMs ?? INTERVAL_MS;
  logger.info({ startupDelayMs, intervalMs, flag: HIGHLIGHT_EXPIRY_FLAG }, "HighlightExpiryEventScheduler scheduled (no-op until the flags are enabled)");
  const generation = ++_generation;
  _timer = setTimeout(function tick() {
    void runHighlightExpiryTick()
      .catch((err) => logger.warn({ err }, "highlight expiry events tick failed"))
      .finally(() => { if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, intervalMs); _timer.unref?.(); } });
  }, startupDelayMs); _timer.unref?.();
}

export function stopHighlightExpiryEventScheduler(): void {
  _generation += 1;
  if (_timer !== null) { clearTimeout(_timer); _timer = null; }
}
