/**
 * layoverOperationalRetentionScheduler — census-layover L159 and L161, the two
 * "expire it, then forget it" duties nothing performed.
 *
 * ── PHASE 1 — L159: operational checkpoints (and presence) leave at expiry ───
 * Spec line 540: "Operational checkpoints — short-lived operational + bounded
 * diagnostics". `layover_checkpoints` (2992) carries `expires_at` = departure
 * + 6 h (`services/layover/LayoverCheckpointStore.ts`), and 2992 says in its
 * own header that the column is "a FILTER, NOT A RETENTION PROMISE … THERE IS
 * NO SWEEPER". `layover_presence` (3900) is the same shape: every read is
 * bounded by `expires_at > now`, and the row stays until the user clears it.
 * The L261 proposal's phase P1 (docs/ops/layover-retention-proposal-L261-
 * 20261012.md §3.1, §4) is exactly this: delete both at their own expiry, no
 * grace. That proposal is NOT ruled (OD-1012-LAY-3); P1 lists no alternative
 * and is the most private choice, so it is built here — behind its own flag.
 *
 * WHY A FLAG, when lib/layoverCrewExpiryScheduler argues for none: that sweep
 * implements a DECIDED retention (L196's "expiration jobs"). This one deletes
 * rows under a proposal the owner has not ruled on, so it ships seeded FALSE
 * (`layover_operational_expiry_sweep_enabled`, migration 3789; PR-R-L163a's
 * precedent) and turning it on is the owner's press. OFF, absent or unreadable:
 * the pass reads that flag and touches neither table.
 *
 * WHAT A PASS RECORDS: COUNTS. Per table: swept / idle / absent / failed and
 * how many rows went. Never a row, an id, a session or a type — a retention
 * sweep that copied what it deleted into a log has not deleted it. The counts
 * go to a log line, to /healthz/schedulers (`layoverOperationalExpiry`) and to
 * the `job_health` row of the same name.
 *
 * A MISSING TABLE IS NOT A FAILURE. 2992 and 3900 are applied to no production
 * database; there, Postgres answers 42P01 and PostgREST PGRST205, and the pass
 * reports the table `absent` — nothing to sweep, said out loud — rather than
 * failing every hour or calling it "nothing due". Any OTHER error is a failure
 * (lib/absentTableError.ts draws that line).
 *
 * DELETE re-checks expiry. The keys are read, then deleted with
 * `expires_at <= cutoff` repeated on the DELETE, so a presence row renewed
 * between the two statements (an upsert moves its expiry) is not taken.
 *
 * ── PHASE 2 — L161: fold expired airport observations, then delete them ─────
 * services/layover/AirportTimingAggregate.ts, behind
 * `airport_timing_aggregate_enabled` (3790, seeded FALSE). Its header carries
 * the de-identification argument, the k = 10 floor (OQ-5) and why the fold and
 * the delete are one database transaction. Reported as `airportTimingAggregate`.
 *
 * ── SHAPE ─────────────────────────────────────────────────────────────────────
 * As lib/layoverAuditRetentionScheduler: the clock is an argument; the two
 * phases are independent and throw-safe (one failing cannot stop the other);
 * a phase that RAN writes its job_health row — the attempt always, the success
 * only when there was one — and a DISABLED phase writes nothing durable (one
 * flag read a tick). A generation counter (PR #652) keeps exactly one loop
 * across a stop()/start() during a pass.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { isFlagEnabled } from "./featureFlags.js";
import { isAbsentTableError } from "./absentTableError.js";
import { runAirportTimingFoldPhase, type AirportTimingFoldResult } from "../services/layover/AirportTimingAggregate.js";

/** Hourly: the L261 proposal's tick, and every row it removes is already invisible. */
export const LAYOVER_OPERATIONAL_RETENTION_INTERVAL_MS = 60 * 60_000;
export const LAYOVER_OPERATIONAL_EXPIRY_BATCH_SIZE = 500;
/** After the crew expiry sweep's 10 minutes, so the boot burst is not made worse. */
const STARTUP_DELAY_MS = 11 * 60_000;

export const OPERATIONAL_EXPIRY_JOB_KEY = "layoverOperationalExpiry";
export const TIMING_AGGREGATE_JOB_KEY = "airportTimingAggregate";

/** 3789's flag. Read below with its literal so check:flag-polarity can resolve it. */
export const OPERATIONAL_EXPIRY_FLAG = "layover_operational_expiry_sweep_enabled";

// ── phase 1 ──────────────────────────────────────────────────────────────────

export type ExpiryTable = "layover_checkpoints" | "layover_presence";

export interface ExpiryTableResult {
  table: ExpiryTable;
  /** swept: rows removed · idle: ran, none due · absent: the table is not here (42P01 / PGRST205) · failed */
  outcome: "swept" | "idle" | "absent" | "failed";
  reason: "read_failed" | "delete_failed" | null;
  /** Rows the database CONFIRMED it removed. */
  deleted: number;
  /** False when the batch filled up or the pass did not finish. */
  complete: boolean;
}

export interface OperationalExpiryResult {
  outcome: "disabled" | "refused" | "swept" | "idle" | "failed";
  reason: "no_client" | null;
  tables: ExpiryTableResult[];
  deleted: number;
}

type TableRead = { data: unknown; error: unknown };

function tableResult(table: ExpiryTable, read: TableRead, del: TableRead | null, due: number, limit: number): ExpiryTableResult {
  if (read.error) {
    if (isAbsentTableError(read.error)) return { table, outcome: "absent", reason: null, deleted: 0, complete: true };
    logger.warn({ table, code: (read.error as { code?: unknown })?.code ?? null }, "layover operational expiry: due rows unreadable — 0 deleted is not a measurement here");
    return { table, outcome: "failed", reason: "read_failed", deleted: 0, complete: false };
  }
  if (due === 0) return { table, outcome: "idle", reason: null, deleted: 0, complete: true };
  if (!del || del.error) {
    logger.warn({ table, due, code: (del?.error as { code?: unknown } | undefined)?.code ?? null }, "layover operational expiry: delete refused — expired rows remain");
    return { table, outcome: "failed", reason: "delete_failed", deleted: 0, complete: false };
  }
  const confirmed = Array.isArray(del.data) ? del.data.length : 0;
  return { table, outcome: "swept", reason: null, deleted: confirmed, complete: due < limit };
}

async function settle(p: PromiseLike<TableRead>): Promise<TableRead> {
  try {
    return await p;
  } catch (err) {
    return { data: null, error: err ?? new Error("threw") };
  }
}

/** `layover_checkpoints` (2992): keyed by id. Literal table names so check:write-path-columns can see each site. */
async function sweepCheckpoints(db: any, cutoff: string, limit: number): Promise<ExpiryTableResult> {
  const read = await settle(db.from("layover_checkpoints").select("id").lte("expires_at", cutoff).order("expires_at", { ascending: true }).limit(limit));
  const ids = read.error ? [] : ((read.data ?? []) as Array<{ id: unknown }>).map((r) => r.id).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (read.error || ids.length === 0) return tableResult("layover_checkpoints", read, null, 0, limit);
  const del = await settle(db.from("layover_checkpoints").delete().in("id", ids).lte("expires_at", cutoff).select("id"));
  return tableResult("layover_checkpoints", read, del, ids.length, limit);
}

/** `layover_presence` (3900): keyed by session_id (its primary key); an upsert can renew it, hence the re-checked expiry. */
async function sweepPresence(db: any, cutoff: string, limit: number): Promise<ExpiryTableResult> {
  const read = await settle(db.from("layover_presence").select("session_id").lte("expires_at", cutoff).order("expires_at", { ascending: true }).limit(limit));
  const keys = read.error ? [] : ((read.data ?? []) as Array<{ session_id: unknown }>).map((r) => r.session_id).filter((v): v is string => typeof v === "string" && v.length > 0);
  if (read.error || keys.length === 0) return tableResult("layover_presence", read, null, 0, limit);
  const del = await settle(db.from("layover_presence").delete().in("session_id", keys).lte("expires_at", cutoff).select("session_id"));
  return tableResult("layover_presence", read, del, keys.length, limit);
}

/** One expiry pass, deterministic in its instant: `opts.now` IS the cutoff. Never throws. */
export async function runLayoverOperationalExpiryPhase(
  opts: { client: any; now: Date; batchSize?: number },
): Promise<OperationalExpiryResult> {
  const db = opts.client;
  if (!db) return { outcome: "refused", reason: "no_client", tables: [], deleted: 0 };
  let on = false;
  try {
    on = await isFlagEnabled(db, "layover_operational_expiry_sweep_enabled");
  } catch {
    on = false;
  }
  if (!on) return { outcome: "disabled", reason: null, tables: [], deleted: 0 };

  const limit = opts.batchSize ?? LAYOVER_OPERATIONAL_EXPIRY_BATCH_SIZE;
  const cutoff = opts.now.toISOString();
  const tables = [await sweepCheckpoints(db, cutoff, limit), await sweepPresence(db, cutoff, limit)];
  const deleted = tables.reduce((n, t) => n + t.deleted, 0);
  const outcome = tables.some((t) => t.outcome === "failed") ? "failed" : deleted > 0 ? "swept" : "idle";
  // Counts only. No id, session, type or instant of any row.
  logger.info(
    { outcome, tables: tables.map((t) => ({ table: t.table, outcome: t.outcome, deleted: t.deleted, complete: t.complete })) },
    "layover operational expiry pass",
  );
  return { outcome, reason: null, tables, deleted };
}

// ── status, health, job_health ───────────────────────────────────────────────

export interface PhaseStatus<R> {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastResult: R | null;
}

const _expiry: PhaseStatus<OperationalExpiryResult> = { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null };
const _timing: PhaseStatus<AirportTimingFoldResult> = { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null };

/** Snapshot for /healthz/schedulers (job "layoverOperationalExpiry"). */
export function getLayoverOperationalExpiryStatus(): Readonly<PhaseStatus<OperationalExpiryResult>> {
  return { ..._expiry };
}

/** Snapshot for /healthz/schedulers (job "airportTimingAggregate"). */
export function getAirportTimingAggregateStatus(): Readonly<PhaseStatus<AirportTimingFoldResult>> {
  return { ..._timing };
}

/** Test seam. */
export function _resetLayoverOperationalRetentionStatus(): void {
  Object.assign(_expiry, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null });
  Object.assign(_timing, { lastAttemptAt: null, lastSuccessAt: null, consecutiveFailures: 0, lastResult: null });
}

/** The health detail line for the L159 phase. Counts only. */
export function operationalExpiryHealthDetail(s: Readonly<PhaseStatus<OperationalExpiryResult>>): string | undefined {
  const r = s.lastResult;
  if (!r) return undefined;
  if (r.outcome === "disabled") return "last pass: disabled (layover_operational_expiry_sweep_enabled is OFF)";
  if (r.outcome === "refused") return "last pass: no service client";
  return `last pass: ${r.outcome}; ` + r.tables.map((t) => `${t.table} ${t.outcome}${t.reason ? ` (${t.reason})` : ""}, ${t.deleted} deleted${t.complete ? "" : ", backlog remains"}`).join("; ");
}

/** The health detail line for the L161 phase. Counts only. */
export function airportTimingAggregateHealthDetail(s: Readonly<PhaseStatus<AirportTimingFoldResult>>): string | undefined {
  const r = s.lastResult;
  if (!r) return undefined;
  if (r.outcome === "disabled") return "last pass: disabled (airport_timing_aggregate_enabled is OFF)";
  if (r.outcome === "refused") return "last pass: no service client";
  return `last pass: ${r.outcome}${r.reason ? ` (${r.reason})` : ""}, ${r.read} due observation(s), ${r.aggregatesWritten} band(s) written, ` +
    `${r.observationsDeleted} observation(s) deleted, ${r.bandsWithheld} band(s) withheld below the floor, ${r.unusable} unusable, ` +
    `${r.airportsFailed} airport(s) failed${r.complete ? "" : ", backlog remains"}`;
}

function phaseSucceeded(outcome: string): boolean {
  return outcome === "disabled" || outcome === "idle" || outcome === "swept" || outcome === "folded";
}

async function recordPhase<R extends { outcome: string }>(db: any, job: string, status: PhaseStatus<R>, attemptAt: string, result: R): Promise<void> {
  status.lastAttemptAt = attemptAt;
  status.lastResult = result;
  const ok = phaseSucceeded(result.outcome);
  if (ok) {
    status.consecutiveFailures = 0;
    status.lastSuccessAt = attemptAt;
  } else {
    status.consecutiveFailures += 1;
    const log = status.consecutiveFailures >= 3 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ job, outcome: result.outcome, consecutiveFailures: status.consecutiveFailures }, "layover operational retention: a phase did NOT succeed");
  }
  // A disabled phase writes nothing durable; a refused one has no client to write with.
  if (result.outcome === "disabled" || !db) return;
  const row: Record<string, unknown> = { job, last_run_at: attemptAt };
  if (ok) row["last_success_at"] = attemptAt;
  try {
    const { error } = await db.from("job_health").upsert(row, { onConflict: "job" });
    if (error) logger.warn({ job, code: (error as { code?: unknown })?.code ?? null }, "layover operational retention: could not persist job health");
  } catch (err) {
    logger.warn({ job, err: (err as Error)?.message }, "layover operational retention: could not persist job health");
  }
}

export interface LayoverOperationalRetentionTick {
  expiry: OperationalExpiryResult;
  timing: AirportTimingFoldResult;
}

/** One tick: reads the clock once, runs both phases independently, never rejects. */
export async function runLayoverOperationalRetentionTick(
  opts: { client?: any; now?: Date; batchSize?: number } = {},
): Promise<LayoverOperationalRetentionTick> {
  const now = opts.now ?? new Date();
  const attemptAt = now.toISOString();
  // Explicit null means "no client"; undefined means "use the service client".
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  let expiry: OperationalExpiryResult;
  try {
    expiry = await runLayoverOperationalExpiryPhase({ client: db, now, batchSize: opts.batchSize });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "layover operational expiry phase threw");
    expiry = { outcome: "failed", reason: null, tables: [], deleted: 0 };
  }
  await recordPhase(db, OPERATIONAL_EXPIRY_JOB_KEY, _expiry, attemptAt, expiry);
  let timing: AirportTimingFoldResult;
  try {
    timing = await runAirportTimingFoldPhase({ client: db, now, batchSize: opts.batchSize });
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "airport timing fold phase threw");
    timing = {
      outcome: "failed", reason: null, read: 0, airports: 0, airportsCommitted: 0, airportsFailed: 0,
      aggregatesWritten: 0, observationsDeleted: 0, bandsWithheld: 0, unusable: 0, complete: false,
    };
  }
  await recordPhase(db, TIMING_AGGREGATE_JOB_KEY, _timing, attemptAt, timing);
  return { expiry, timing };
}

let _timer: ReturnType<typeof setTimeout> | null = null; let _generation = 0; // which loop is current: a pass re-arms only if no stop() came after its own start() (PR #652's pattern)

export function startLayoverOperationalRetentionScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      intervalMs: LAYOVER_OPERATIONAL_RETENTION_INTERVAL_MS,
      gates: ["layover_operational_expiry_sweep_enabled (3789, seeded FALSE)", "airport_timing_aggregate_enabled (3790, seeded FALSE)"],
    },
    "LayoverOperationalRetentionScheduler scheduled (one flag read per phase per tick while both are OFF)",
  );
  const generation = ++_generation;
  _timer = setTimeout(function tick() {
    void runLayoverOperationalRetentionTick().finally(() => {
      if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, LAYOVER_OPERATIONAL_RETENTION_INTERVAL_MS); _timer.unref?.(); }
    });
  }, STARTUP_DELAY_MS);
  _timer.unref?.();
}

export function stopLayoverOperationalRetentionScheduler(): void {
  _generation += 1;
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
