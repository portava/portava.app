/**
 * sensingRetentionScheduler — the TTL sweep for the anonymous sensing store.
 *
 * Migration 2315 shipped `purge_expired_sensing_contributions(timestamptz)` and
 * NOTHING CALLED IT. There is no pg_cron anywhere in src/migrations — no
 * migration in this tree contains `cron.schedule` — so a sweep runs only if a
 * Node scheduler runs it, and none did. Rows would have sat past their
 * `expires_at` indefinitely.
 *
 * That is precisely the defect lib/intelRetentionScheduler's own header
 * describes: location_snapshots carried `expires_at` for months with no cleanup
 * job, the purge function's only reference in the repository was its own
 * definition, and readers filtered on expiry so the feature looked correct while
 * rows accumulated forever. This file is that lesson applied to 2315, in the
 * same shape, in the same band.
 *
 * ── THIS IS THE "TTL" THE RULING NAMES, AND NOTHING ELSE ─────────────────────
 * The owner ruling permits this store to own "privacy-reduced sensor
 * contributions, rotating IDs, TTL, cohort/coverage aggregation and revocation".
 * This is the TTL clause and only that: it deletes rows the database already
 * considers expired, through the SECURITY DEFINER function 2315 provides. It
 * writes nothing, reads no contributor data, computes no aggregate, promotes
 * nothing into the canonical intel lifecycle, and has no opinion about any row
 * that is still fresh.
 *
 * ── WHY THERE IS NO FEATURE FLAG, AND WHAT GATES IT INSTEAD ──────────────────
 * Every other sweep in this band is flag-gated. This one is not, and the
 * omission is deliberate rather than forgotten.
 *
 * Seeding a flag row is an owner decision in this lane (docs/architecture/
 * sensing-input-gap.md §3.2, "Enabling any flag that would make an input path
 * live"), and 2315 seeds none. More to the point, the thing a flag protects
 * against does not exist here. The irreversible-DELETE flags elsewhere guard
 * rows a reader can still see: an expired intel snapshot is recomputable, an
 * aged intel_observation is contributor content whose retention window is a
 * policy choice. Here, `expires_at` is a STRUCTURAL ceiling — 2315's CHECK makes
 * a row older than 72 hours unrepresentable — and the store's only reader
 * (`readSensingCohort`) already filters `expires_at > now`, so a row this sweep
 * deletes is one no code path can observe. Deleting it changes no answer any
 * caller could get. A flag would only add a way to leave expired personal data
 * in the database.
 *
 * WHAT DOES GATE IT is the schema itself:
 *
 *   THE SWEEP MUST NOT RUN IF THE TABLE IS ABSENT. 2315 is applied to portava-ci
 *   and NOT to production. `sensingStorePresent` probes before every pass, and a
 *   probe that errors for any reason at all — table missing, database
 *   unreachable, permission refused — answers "absent", so the RPC is never
 *   attempted. Where the store does not exist this scheduler is an inert
 *   heartbeat, which is exactly what it should be until an operator applies the
 *   migration. When they do, the next pass picks it up with no restart.
 *
 * ── FAIL-CLOSED, AND WHY THE REASON MATTERS ──────────────────────────────────
 * `skipped: true` alone is useless: a sweep failing on every pass and a sweep
 * that has nothing to sweep produced byte-identical results in the shape this
 * replaced, which made a permanently broken job indistinguishable from a
 * correctly idle one. So every pass names why — `no_client`, `store_absent`,
 * `error`, or null for a real run — following lib/intelRetentionScheduler.
 *
 * Starting it from src/index.ts before 2315 is applied anywhere is safe: with no
 * table there is nothing to delete, and with a table there is nothing to delete
 * that anything could still read.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { purgeExpiredSensingContributions } from "./sensingAnonStore.js";
import { sensingStorePresent } from "./sensingAnonService.js";

/**
 * Later than every intel scheduler's delay (the latest is 8 minutes) so the
 * boot burst is not made worse by a probe that will usually answer "absent".
 */
const STARTUP_DELAY_MS = 9 * 60 * 1000;

/** A positive finite env float, else the default (house pattern: eventWaitlistSweeper). */
function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

/**
 * Sweep cadence, default five minutes.
 *
 * The store's TTL is measured in hours and capped at 72, and no reader can see
 * an expired row, so the cadence decides only how long a row that is already
 * invisible lingers in storage before it is gone — not whether anything is
 * correct. Five minutes keeps that window short without turning a
 * delete-by-index into a busy loop. Configurable via
 * SENSING_RETENTION_SWEEP_INTERVAL_SECONDS; anything unset, non-numeric or ≤ 0
 * falls back to the default.
 */
export const SENSING_RETENTION_SWEEP_INTERVAL_SECONDS = parseEnvFloat(
  process.env["SENSING_RETENTION_SWEEP_INTERVAL_SECONDS"],
  300,
);
export const SENSING_RETENTION_INTERVAL_MS = SENSING_RETENTION_SWEEP_INTERVAL_SECONDS * 1000;

let _timer: ReturnType<typeof setTimeout> | null = null;

export interface SensingSweepResult {
  deleted: number;
  skipped: boolean;
  /**
   * WHY this pass did nothing.
   *
   *   no_client     the process holds no service-role client
   *   store_absent  2315 is not applied to this database — the RPC is NOT called
   *   error         the purge was attempted and the database refused or threw
   *   null          a real pass; `deleted` is the row count
   */
  reason: "no_client" | "store_absent" | "error" | null;
}

/**
 * One sweep. Deterministic in its instant: the SQL function takes `p_now` rather
 * than reading a clock, so a caller can prove what a pass would delete without
 * one — the same property 2315 gave the function on purpose.
 */
export async function runSensingRetentionSweep(
  opts: { client?: any; now?: Date } = {},
): Promise<SensingSweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — `??` does not short-circuit on an
  // explicit null, so a unit test passing `client: null` would get a REAL client
  // and open a socket. lib/intelRetentionScheduler records that exact defect.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { deleted: 0, skipped: true, reason: "no_client" };

  // The hard precondition. An absent store is not an error to retry into
  // success, and the DELETE must never be attempted against a database that does
  // not have the table.
  if (!(await sensingStorePresent(db))) {
    return { deleted: 0, skipped: true, reason: "store_absent" };
  }

  const nowIso = (opts.now ?? new Date()).toISOString();
  const result = await purgeExpiredSensingContributions(db, nowIso);
  if (!result.ok) {
    logger.warn({ error: result.error }, "sensing retention sweep failed");
    return { deleted: 0, skipped: true, reason: "error" };
  }
  if (result.deleted > 0) {
    // A count and nothing else. Which cohort, zone or token expired is a fact
    // about contributors, and a log is not a place any of that belongs.
    logger.info({ deleted: result.deleted }, "sensing retention sweep removed expired contributions");
  }
  return { deleted: result.deleted, skipped: false, reason: null };
}

export function startSensingRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: SENSING_RETENTION_INTERVAL_MS,
      gate: "sensing_anon_contributions must exist in this database",
    },
    "SensingRetentionScheduler scheduled (no-op wherever migration 2315 is not applied)",
  );
  _timer = setTimeout(function tick() {
    void runSensingRetentionSweep().finally(() => {
      _timer = setTimeout(tick, SENSING_RETENTION_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopSensingRetentionScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
