/**
 * rankingDebugSamplePurgeScheduler — census-discovery §133 (DV-52): the
 * scheduled caller `purge_old_ranking_debug_samples()` never had, behind
 * `ranking_debug_samples_purge_enabled` (3922, seeded FALSE).
 *
 * ── WHY IT IS FLAGGED, AND OFF ──────────────────────────────────────────────
 * The purge (0203, search_path pinned by 0204) deletes every
 * `ranking_debug_samples` row older than 7 days. Those rows carry `viewer_id`.
 * Nothing called it, and pg_cron is not installed, so the samples accumulate
 * (production, read 2026-10-23). The 7 days is a constant in a backfilled
 * function. It is NOT a recorded retention ruling: D-OWNER1004-1
 * (docs/architecture/discovery-decision-register.md) leaves "which horizon
 * governs ranking_debug_samples" to the legal review. A sweep that deletes at a
 * coded horizon nobody ruled on must not run unflagged, so this tick issues the
 * DELETE only while the flag row reads exactly TRUE. OFF, absent and
 * unreadable all mean: no DELETE, no RPC, one flag read.
 *
 * ── WHAT A TICK REPORTS ─────────────────────────────────────────────────────
 *   disabled   the flag is OFF — the seeded, correct state until the owner
 *              rules. Not a failure, and not persisted to job_health (nothing ran).
 *   no_flag    the row is absent or unreadable (3922 unapplied, or the read
 *              failed). No DELETE either. Not a failure, but named as itself, so
 *              an unreadable flag never reads as "OFF on purpose".
 *   purged     the flag is ON and the purge answered a non-negative count.
 *   failed     no service client, the RPC erroring, or a non-integer answer.
 * Reported at GET /api/healthz/schedulers as `rankingDebugSamplePurge`.
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";

export const JOB_KEY = "rankingDebugSamplePurge";

/** 3922's row. Read as a literal so check:flag-polarity sees the read. */
export const RANKING_DEBUG_SAMPLES_PURGE_FLAG = "ranking_debug_samples_purge_enabled";

/** 0203's purge: SECURITY DEFINER, service_role EXECUTE only (production, 2026-10-23). */
export const PURGE_RPC = "purge_old_ranking_debug_samples";

/** Hourly. A sample outlives the function's horizon by at most one interval while ON. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1_000;

/** Let the process finish booting before the first pass. */
export const PURGE_STARTUP_DELAY_MS = 5 * 60 * 1_000;

export type DebugSamplePurgeOutcome = "disabled" | "no_flag" | "purged" | "failed";

export interface DebugSamplePurgeStatus {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastOutcome: DebugSamplePurgeOutcome | null;
  lastDeleted: number | null;
  lastFailure: string | null;
}

const _status: DebugSamplePurgeStatus = {
  lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastOutcome: null, lastDeleted: null, lastFailure: null,
};

export function getDebugSamplePurgeStatus(): Readonly<DebugSamplePurgeStatus> {
  return { ..._status };
}

/** Test seam. */
export function _resetDebugSamplePurgeStatus(): void {
  Object.assign(_status, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastOutcome: null, lastDeleted: null, lastFailure: null });
}

let _testClient: any | null = null;
/** Inject a client for the timer-driven path in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void { _testClient = sc; }

function resolveClient(db?: any): any | null {
  if (db !== undefined) return db;
  if (_testClient) return _testClient;
  return isServiceClientReady ? getServiceClient() : null;
}

/**
 * The raw `enabled` value, or null when the row is absent or the read failed.
 * Read here rather than through getFlagRow, which coerces with Boolean(): a
 * DELETE must need the boolean TRUE itself, never something truthy.
 */
async function readPurgeFlag(client: any): Promise<unknown | null> {
  try {
    const { data, error } = await client.from("feature_flags").select("enabled").eq("flag", RANKING_DEBUG_SAMPLES_PURGE_FLAG).maybeSingle();
    if (error || !data) return null;
    return (data as any).enabled ?? null;
  } catch {
    return null;
  }
}

/** The health detail line for this job. */
export function debugSamplePurgeHealthDetail(s: Readonly<DebugSamplePurgeStatus>): string | undefined {
  switch (s.lastOutcome) {
    case null: return undefined;
    case "disabled": return `last pass: disabled (${RANKING_DEBUG_SAMPLES_PURGE_FLAG} is OFF; no retention ruling recorded for debug samples, nothing deleted)`;
    case "no_flag": return `last pass: ${RANKING_DEBUG_SAMPLES_PURGE_FLAG} absent or unreadable — nothing deleted (is 3922 applied?)`;
    case "purged": return `last pass: deleted ${s.lastDeleted ?? 0} sample(s) older than the purge's 7 days`;
    case "failed": return `last pass FAILED: ${s.lastFailure ?? "unknown"}`;
  }
}

/** One tick. Never throws. */
export async function runDebugSamplePurgeTick(db?: any, now: Date = new Date()): Promise<Readonly<DebugSamplePurgeStatus>> {
  const client = resolveClient(db);
  const attemptAt = now.toISOString();
  _status.lastAttemptAt = attemptAt;
  let outcome: DebugSamplePurgeOutcome;
  let deleted: number | null = null;
  let failure: string | null = null;

  if (!client) {
    outcome = "failed"; failure = "no service client";
  } else {
    const flag = await readPurgeFlag(client);
    if (flag === null) outcome = "no_flag";
    else if (flag !== true) outcome = "disabled";
    else {
      try {
        const { data, error } = await client.rpc(PURGE_RPC);
        const n = typeof data === "string" ? Number(data) : data;
        if (error) { outcome = "failed"; failure = `${PURGE_RPC}: ${error?.code ?? "?"} ${error?.message ?? String(error)}`; }
        else if (typeof n !== "number" || !Number.isInteger(n) || n < 0) { outcome = "failed"; failure = `${PURGE_RPC} answered ${JSON.stringify(data)?.slice(0, 120)}`; }
        else { outcome = "purged"; deleted = n; }
      } catch (err) {
        outcome = "failed"; failure = `${PURGE_RPC} threw: ${(err as any)?.message ?? String(err)}`;
      }
    }
  }

  _status.lastOutcome = outcome;
  _status.lastDeleted = deleted;
  _status.lastFailure = failure;
  if (outcome === "failed") _status.consecutiveFailures += 1;
  else { _status.consecutiveFailures = 0; _status.lastSuccessAt = attemptAt; }

  if (client && outcome !== "disabled" && outcome !== "no_flag") {
    const row: Record<string, unknown> = { job: JOB_KEY, last_run_at: attemptAt };
    if (outcome === "purged") row["last_success_at"] = attemptAt;
    try {
      const { error } = await client.from("job_health").upsert(row, { onConflict: "job" });
      if (error) logger.warn({ job: JOB_KEY, err: error }, "rankingDebugSamplePurge: could not persist job health");
    } catch (err) {
      logger.warn({ job: JOB_KEY, err }, "rankingDebugSamplePurge: could not persist job health");
    }
  }
  if (outcome === "failed") logger.error({ job: JOB_KEY, failure, consecutiveFailures: _status.consecutiveFailures }, "rankingDebugSamplePurge: pass did NOT succeed");
  else if (outcome === "purged") logger.info({ job: JOB_KEY, deleted }, "rankingDebugSamplePurge: pass complete");
  return getDebugSamplePurgeStatus();
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _startup: ReturnType<typeof setTimeout> | null = null;

/** Start the hourly scheduler. Idempotent. */
export function startRankingDebugSamplePurgeScheduler(): void {
  if (_timer || _startup) return;
  _startup = setTimeout(() => {
    _startup = null;
    void runDebugSamplePurgeTick();
    _timer = setInterval(() => void runDebugSamplePurgeTick(), PURGE_INTERVAL_MS);
    if (typeof _timer.unref === "function") _timer.unref();
  }, PURGE_STARTUP_DELAY_MS);
  if (typeof _startup.unref === "function") _startup.unref();
}

/** Stop the scheduler. For tests and a clean shutdown. */
export function stopRankingDebugSamplePurgeScheduler(): void {
  if (_startup) { clearTimeout(_startup); _startup = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}
