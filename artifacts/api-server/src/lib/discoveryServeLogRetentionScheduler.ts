/**
 * discoveryServeLogRetentionScheduler — census-discovery §120: the owner's
 * 30-day TESTING retention for Discovery's per-request serve log
 * (`public.recommendations`, 3376), run as an API scheduler.
 *
 * ── THE DECISION ────────────────────────────────────────────────────────────
 * Owner, 2026-09-30, approving 3376 for the testing database with
 * discovery_serve_log_enabled ON: "Implement and schedule cleanup using the
 * appropriate record timestamp … Deliver logging and cleanup together rather
 * than leaving records to accumulate indefinitely or disabling the feature …
 * This decision covers recommendation logs in testing only. It does not set
 * retention for financial records or other data."
 *
 * ── WHAT A TICK DOES ────────────────────────────────────────────────────────
 * Reads `discovery_serve_log_retention_enabled` (3501), then calls
 * `purge_expired_discovery_recommendations(p_batch_size)` up to
 * MAX_BATCHES_PER_TICK times, PURGE_BATCH_SIZE rows each, stopping as soon as
 * the database answers `more: false`. The retention period, its clock
 * (created_at) and the boundary are the SQL function's — 3501's header argues
 * each — so this file cannot compute a different horizon from the database's.
 * A backlog larger than one tick's bound is left for the next tick and
 * reported, never chased in an unbounded loop.
 *
 * pg_cron is not installed in the testing database (measured 2026-09-30), so
 * this is an API scheduler, in the shape lib/storyRetentionScheduler.ts set for
 * a retention job: hourly, unref'd, attempt and SUCCESS kept apart, the success
 * persisted to job_health so a restart cannot launder a job that never
 * succeeded, and reported at GET /api/healthz/schedulers.
 *
 * ── A FAILED PURGE IS REPORTED, NEVER SWALLOWED ─────────────────────────────
 * Every one of these makes the pass a FAILURE (consecutiveFailures + 1, no
 * lastSuccessAt, 503 at /healthz/schedulers, an error log line):
 *   * no service client;
 *   * the retention row absent or unreadable (getFlagRow answers null for both);
 *   * the flag OFF — the owner ruled out logging without cleanup, so a
 *     switched-off purge is a state an operator must see, not a quiet skip;
 *   * the RPC erroring (including the function's own refusals: a missing row,
 *     an invalid keep_days, a foreign key that now references the table);
 *   * an answer that is not {status: 'purged', deleted: n >= 0, more: boolean}.
 * A pass that deleted nothing because nothing was expired is a SUCCESS with
 * `deleted: 0`; a pass that could not run is never reported as zero work.
 */
import { getServiceClient, isServiceClientReady } from "./supabase.js";
import { logger } from "./logger.js";
import { getFlagRow } from "./featureFlags.js";

export const JOB_KEY = "discoveryServeLogRetention";

/** 3501's row. Its metadata.keep_days (30, labelled testing) is the retention value. */
export const DISCOVERY_SERVE_LOG_RETENTION_FLAG = "discovery_serve_log_retention_enabled";

/** 3501's purge: SECURITY DEFINER, service_role EXECUTE only. */
export const PURGE_RPC = "purge_expired_discovery_recommendations";

/** Hourly: a row outlives its 30 days by at most one interval. */
export const RETENTION_INTERVAL_MS = 60 * 60 * 1_000;

/** Let the process finish booting before the first pass. */
export const RETENTION_STARTUP_DELAY_MS = 4 * 60 * 1_000;

/** Rows per DELETE. The function refuses anything outside 1..10000. */
export const PURGE_BATCH_SIZE = 1_000;

/** DELETE statements per tick: at most 25,000 rows an hour, each statement short. */
export const MAX_BATCHES_PER_TICK = 25;

export interface RetentionPassReport {
  deleted: number;
  batches: number;
  /** The database said expired rows remain when this pass stopped. */
  backlogRemains: boolean;
  /** The horizon the database used (ISO), from the last answer. */
  cutoff: string | null;
}

export interface DiscoveryServeLogRetentionStatus {
  /** A tick began. Never evidence that it worked. */
  lastAttemptAt: string | null;
  /** A tick ended with no failure. The only thing that means healthy. */
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  /** Failures from the most recent pass, verbatim. */
  lastFailures: string[];
  /** Counts from the most recent pass (also set on a failed pass that deleted some). */
  lastReport: RetentionPassReport | null;
}

const _status: DiscoveryServeLogRetentionStatus = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastFailures: [],
  lastReport: null,
};

/** Snapshot for /healthz/schedulers. */
export function getDiscoveryServeLogRetentionStatus(): Readonly<DiscoveryServeLogRetentionStatus> {
  return {
    ..._status,
    lastFailures: [..._status.lastFailures],
    lastReport: _status.lastReport ? { ..._status.lastReport } : null,
  };
}

/** Test seam: reset module state between cases. */
export function _resetDiscoveryServeLogRetentionStatus(): void {
  _status.lastAttemptAt = null;
  _status.lastSuccessAt = null;
  _status.consecutiveFailures = 0;
  _status.lastFailures = [];
  _status.lastReport = null;
}

let _testClient: any | null = null;
/** Inject a client for the timer-driven path in tests; pass null to restore. */
export function _setTestClient(sc: any | null): void { _testClient = sc; }

/** Explicit null means "no client" (the house rule: intelRetentionScheduler's note on `??`). */
function resolveClient(db?: any): any | null {
  if (db !== undefined) return db;
  if (_testClient) return _testClient;
  return isServiceClientReady ? getServiceClient() : null;
}

/** The purge's answer, checked field by field. null = not the shape 3501 returns. */
export function parsePurgeAnswer(data: unknown): { status: "purged" | "disabled"; deleted: number; more: boolean | null; cutoff: string | null } | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const status = d["status"];
  if (status !== "purged" && status !== "disabled") return null;
  const deleted = typeof d["deleted"] === "string" ? Number(d["deleted"]) : d["deleted"];
  if (typeof deleted !== "number" || !Number.isInteger(deleted) || deleted < 0) return null;
  const more = d["more"];
  if (status === "purged" && typeof more !== "boolean") return null;
  const cutoff = typeof d["cutoff"] === "string" ? d["cutoff"] : null;
  return { status, deleted, more: typeof more === "boolean" ? more : null, cutoff };
}

/**
 * Load the persisted success timestamp so a fresh process does not report a job
 * that has never succeeded as merely "not run yet". A read failure leaves it
 * null — the pessimistic reading.
 */
export async function hydrateDiscoveryServeLogRetentionStatus(db?: any): Promise<void> {
  const client = resolveClient(db);
  if (!client) return;
  const { data, error } = await client
    .from("job_health")
    .select("last_run_at, last_success_at")
    .eq("job", JOB_KEY)
    .maybeSingle();
  if (error || !data) return;
  _status.lastAttemptAt = (data as any).last_run_at ?? null;
  _status.lastSuccessAt = (data as any).last_success_at ?? null;
}

/** One tick. Never throws; the outcome goes to the status object and the log. */
export async function runDiscoveryServeLogRetentionTick(db?: any): Promise<DiscoveryServeLogRetentionStatus> {
  const client = resolveClient(db);
  const attemptAt = new Date().toISOString();
  _status.lastAttemptAt = attemptAt;

  const failures: string[] = [];
  const report: RetentionPassReport = { deleted: 0, batches: 0, backlogRemains: false, cutoff: null };

  if (!client) {
    failures.push("no service client — the retention pass did not run");
  } else {
    try {
      const flag = await getFlagRow(client, DISCOVERY_SERVE_LOG_RETENTION_FLAG);
      if (!flag) {
        failures.push(`${DISCOVERY_SERVE_LOG_RETENTION_FLAG} is absent or unreadable — nothing was purged (is 3501 applied?)`);
      } else if (!flag.enabled) {
        failures.push(`${DISCOVERY_SERVE_LOG_RETENTION_FLAG} is OFF — expired serve-log rows are being kept, which the owner's decision (census-discovery §120) rules out while serve logging is on`);
      } else {
        for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
          const { data, error } = await client.rpc(PURGE_RPC, { p_batch_size: PURGE_BATCH_SIZE });
          if (error) {
            failures.push(`${PURGE_RPC} failed after ${report.batches} batch(es), ${report.deleted} row(s) deleted: ${error?.code ?? "?"} ${error?.message ?? String(error)}`);
            break;
          }
          const answer = parsePurgeAnswer(data);
          if (!answer) {
            failures.push(`${PURGE_RPC} answered an unexpected shape: ${JSON.stringify(data)?.slice(0, 200)}`);
            break;
          }
          if (answer.status === "disabled") {
            failures.push(`${PURGE_RPC} answered disabled — the database's ${DISCOVERY_SERVE_LOG_RETENTION_FLAG} is OFF; nothing was purged`);
            break;
          }
          report.batches += 1;
          report.deleted += answer.deleted;
          report.cutoff = answer.cutoff;
          report.backlogRemains = answer.more === true;
          if (!report.backlogRemains) break;
        }
      }
    } catch (err) {
      failures.push(`retention pass threw: ${(err as any)?.message ?? String(err)}`);
    }
  }

  const succeeded = failures.length === 0;
  _status.lastFailures = failures;
  _status.lastReport = client ? report : null;
  if (succeeded) {
    _status.consecutiveFailures = 0;
    _status.lastSuccessAt = attemptAt;
  } else {
    _status.consecutiveFailures += 1;
  }

  if (client) {
    // The attempt always; the success only when there was one (storyRetention's rule).
    const row: Record<string, unknown> = { job: JOB_KEY, last_run_at: attemptAt };
    if (succeeded) row["last_success_at"] = attemptAt;
    try {
      const { error: healthErr } = await client.from("job_health").upsert(row, { onConflict: "job" });
      if (healthErr) logger.warn({ job: JOB_KEY, err: healthErr }, "discoveryServeLogRetention: could not persist job health");
    } catch (err) {
      logger.warn({ job: JOB_KEY, err }, "discoveryServeLogRetention: could not persist job health");
    }
  }

  if (succeeded) {
    // Counts only: which serves expired is a fact about viewers.
    logger.info({ job: JOB_KEY, ...report }, "discoveryServeLogRetention: pass complete");
  } else {
    logger.error(
      { job: JOB_KEY, failures, ...report, consecutiveFailures: _status.consecutiveFailures },
      "discoveryServeLogRetention: pass did NOT succeed — serve-log retention is not current",
    );
  }
  return getDiscoveryServeLogRetentionStatus();
}

let _timer: ReturnType<typeof setInterval> | null = null;
let _startup: ReturnType<typeof setTimeout> | null = null;

/** Start the hourly scheduler. Idempotent; a second call is a no-op. */
export function startDiscoveryServeLogRetentionScheduler(): void {
  if (_timer || _startup) return;
  _startup = setTimeout(() => {
    _startup = null;
    void hydrateDiscoveryServeLogRetentionStatus()
      .catch(() => undefined)
      .then(() => runDiscoveryServeLogRetentionTick());
    _timer = setInterval(() => void runDiscoveryServeLogRetentionTick(), RETENTION_INTERVAL_MS);
    if (typeof _timer.unref === "function") _timer.unref();
  }, RETENTION_STARTUP_DELAY_MS);
  if (typeof _startup.unref === "function") _startup.unref();
  logger.info(
    { job: JOB_KEY, intervalMinutes: RETENTION_INTERVAL_MS / 60_000, batchSize: PURGE_BATCH_SIZE, maxBatches: MAX_BATCHES_PER_TICK },
    "discoveryServeLogRetention: scheduled",
  );
}

/** Stop the scheduler. For tests and a clean shutdown. */
export function stopDiscoveryServeLogRetentionScheduler(): void {
  if (_startup) { clearTimeout(_startup); _startup = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}
