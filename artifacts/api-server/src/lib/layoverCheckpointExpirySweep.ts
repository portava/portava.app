/**
 * layoverCheckpointExpirySweep — census-layover L159, spec §17's data
 * lifecycle row: "Operational checkpoints — short-lived operational + bounded
 * diagnostics."
 *
 * ── WHAT WAS MISSING ────────────────────────────────────────────────────────
 * 2992 created `layover_checkpoints` with an `expires_at` that its own comment
 * calls "a filter, not a retention promise", and the writer
 * (`services/layover/LayoverCheckpointStore.ts` `recordTravellerCheckpoint`)
 * sets it to the scheduled departure + CHECKPOINT_VISIBLE_AFTER_DEPARTURE_MIN.
 * Every reader is bounded by `expires_at > now`, so the operational half was
 * short-lived. The diagnostic half was not bounded at all: nothing ever deleted
 * a row, so a traveller's "I left the airport / I am back" trail stayed in
 * storage for as long as the session row did. The L261 retention proposal
 * (docs/ops/layover-retention-proposal-L261-20261012.md §3.1 and §4 "P1
 * expiry") names this exact gap — "Delete presence and checkpoints past
 * `expires_at`" — as code-only work with no option for the owner to choose.
 *
 * ── WHY DELETE AT `expires_at`, AND WHY NO GRACE PERIOD ─────────────────────
 * The same argument as the presence sweep (`lib/layoverPresenceExpiryScheduler.ts`)
 * and the crew sweep: a row this pass removes is one no code path can observe.
 * The cutoff is `expires_at <= now`, the exact complement of
 * `readTravellerCheckpoints`' `expires_at > now`, so deleting changes no answer
 * any caller can get — not the dashboard's airport presence, not the landside
 * suppression after a re-entry, not the outcome a close records (it reads the
 * same filtered list). No new period is chosen here: the bound is the one the
 * writer already stamps on every row. A grace window would only lengthen the
 * life of data nothing can read.
 *
 * ── WHY NO FEATURE FLAG ─────────────────────────────────────────────────────
 * `layover_decision_persistence_enabled` governs whether checkpoints are
 * WRITTEN and READ. It must not govern their retention: turning persistence
 * off after travellers reported check-ins would otherwise keep those rows
 * forever. With persistence off nothing new is written, so a pass finds only
 * what was written while it was on. The gate is the schema (2992): where the
 * table is absent the pass is one probe and nothing else.
 *
 * ── WHERE IT RUNS ───────────────────────────────────────────────────────────
 * On the presence expiry scheduler's own tick (one more phase of the same
 * "live operational data leaves at its own expiry" job, the shape the
 * retention proposal gives P1), so it adds no scheduler to index.ts and no row
 * to lib/schedulerCoverage.ts. Its result and failure ledger are its own, so a
 * broken checkpoint phase is never hidden behind a healthy presence phase.
 *
 * ── THE RESULT IS FOUR-WAY, AND THE CLOCK IS AN ARGUMENT ────────────────────
 * `swept · idle · refused · failed`, as the presence and crew sweeps report
 * them. `opts.now` IS the cutoff; there is no `Date.now()` below the tick.
 * Nothing is written per deleted row: re-recording "this traveller was at
 * the airport exit" in a longer-lived table would not have reduced anything.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";
import { auditedLayoverClient, withLayoverSystemAudit } from "./layoverServiceAudit.js";

function parseEnvInt(raw: string | undefined, def: number, max: number): number {
  const v = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(v) && v > 0 && v <= max ? v : def;
}

/** How many checkpoint rows one pass may remove; a full batch reports `complete: false`. */
export const LAYOVER_CHECKPOINT_EXPIRY_BATCH_SIZE = parseEnvInt(
  process.env["LAYOVER_CHECKPOINT_EXPIRY_BATCH_SIZE"],
  200,
  1000,
);

export type LayoverCheckpointExpiryOutcome = "swept" | "idle" | "refused" | "failed";

export type LayoverCheckpointExpiryReason =
  /** The process holds no service-role client. */
  | "no_client"
  /** 2992 is not applied to this database — no statement beyond the probe was issued. */
  | "table_absent"
  /** The bounded due-row read was refused. Nothing was deleted. */
  | "read_failed"
  /** Due rows were read and the DELETE was refused. Nothing was deleted. */
  | "delete_failed"
  /** A real pass. */
  | null;

export interface LayoverCheckpointExpirySweepResult {
  outcome: LayoverCheckpointExpiryOutcome;
  reason: LayoverCheckpointExpiryReason;
  /** Rows the database confirmed it removed — a measurement, never an attempt count. */
  deleted: number;
  /** False when the batch filled up, and on every refusal or failure. */
  complete: boolean;
}

function refused(reason: Exclude<LayoverCheckpointExpiryReason, null>): LayoverCheckpointExpirySweepResult {
  return { outcome: "refused", reason, deleted: 0, complete: false };
}

function failed(reason: Exclude<LayoverCheckpointExpiryReason, null>): LayoverCheckpointExpirySweepResult {
  return { outcome: "failed", reason, deleted: 0, complete: false };
}

/**
 * Does `layover_checkpoints` exist here? A HEAD select — no row is read to find
 * out. Any error and any throw answers "absent", so no DELETE is ever issued
 * against a table this pass could not see. Not memoised.
 */
async function checkpointTablePresent(db: any): Promise<boolean> {
  if (!db) return false;
  try {
    const { error } = await db.from("layover_checkpoints").select("id", { head: true }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

/** One sweep, deterministic in its instant: `opts.now` is the cutoff. */
async function runLayoverCheckpointExpirySweepImpl(
  opts: { client?: any; now: Date; batchSize?: number },
): Promise<LayoverCheckpointExpirySweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  const db = auditedLayoverClient("client" in opts && opts.client !== undefined ? opts.client : getServiceClient());
  if (!db) return refused("no_client");

  if (!(await checkpointTablePresent(db))) return refused("table_absent");

  const limit = opts.batchSize ?? LAYOVER_CHECKPOINT_EXPIRY_BATCH_SIZE;
  const cutoff = opts.now.toISOString();

  // Keys only: the sweep has no business reading where a traveller reported
  // being. Two statements, because PostgREST offers no LIMIT on a DELETE and an
  // unbounded delete is the lock this batching exists to avoid.
  const read = await db
    .from("layover_checkpoints")
    .select("id")
    .lte("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(limit);

  if (read?.error) {
    logger.warn({ err: read.error }, "layover checkpoint expiry sweep could not read due rows — 0 deleted is not a measurement here");
    return failed("read_failed");
  }

  const ids = ((read?.data ?? []) as Array<{ id: unknown }>)
    .map((r) => r.id)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  if (ids.length === 0) return { outcome: "idle", reason: null, deleted: 0, complete: true };

  // `.lte` again on the DELETE: only a row that is still due goes. `.select`
  // so the count is what the database confirmed.
  const del = await db
    .from("layover_checkpoints")
    .delete()
    .in("id", ids)
    .lte("expires_at", cutoff)
    .select("id");
  if (del?.error) {
    logger.warn({ err: del.error, due: ids.length }, "layover checkpoint expiry sweep could not delete due rows — expired check-ins remain in storage");
    return failed("delete_failed");
  }

  const confirmed = Array.isArray(del?.data) ? del.data.length : 0;
  logger.info({ deleted: confirmed, complete: ids.length < limit }, "layover checkpoint expiry sweep removed expired check-ins");
  return { outcome: "swept", reason: null, deleted: confirmed, complete: ids.length < limit };
}

/** The sweep, inside the layover system-audit scope (the presence sweep's posture). */
export function runLayoverCheckpointExpirySweep(
  ...args: Parameters<typeof runLayoverCheckpointExpirySweepImpl>
): ReturnType<typeof runLayoverCheckpointExpirySweepImpl> {
  return withLayoverSystemAudit("layover:checkpoint-expiry", () => runLayoverCheckpointExpirySweepImpl(...args));
}

/**
 * CONSECUTIVE FAILED SWEEPS. `table_absent` is NOT a failure (a database that
 * has not run 2992 has nothing to sweep). `no_client` IS counted.
 */
let _consecutiveFailures = 0;
let _lastError: string | null = null;

export function layoverCheckpointExpiryFailureState(): { consecutiveFailures: number; lastError: string | null } {
  return { consecutiveFailures: _consecutiveFailures, lastError: _lastError };
}

/** Test seam: forget the failure history. */
export function _resetLayoverCheckpointExpiryFailureState(): void {
  _consecutiveFailures = 0;
  _lastError = null;
}

const SUSTAINED_FAILURE_TICKS = 3;

function recordFailure(message: string): void {
  _consecutiveFailures += 1;
  _lastError = message;
  const payload = { consecutiveFailures: _consecutiveFailures, err: message };
  if (_consecutiveFailures >= SUSTAINED_FAILURE_TICKS) {
    logger.error(payload, "layover checkpoint expiry sweep has failed on consecutive ticks — expired check-ins are accumulating and L159's bound is not being kept");
  } else {
    logger.warn(payload, "layover checkpoint expiry sweep failed");
  }
}

/** One tick: reads the clock once, at the edge, and NEVER rejects. */
export async function runLayoverCheckpointExpiryTick(
  opts: { client?: any; now?: Date; batchSize?: number } = {},
): Promise<LayoverCheckpointExpirySweepResult> {
  let result: LayoverCheckpointExpirySweepResult;
  try {
    result = await runLayoverCheckpointExpirySweep({ ...opts, now: opts.now ?? new Date() });
  } catch (err) {
    recordFailure(String((err as any)?.message ?? err));
    return refused("no_client");
  }
  if (result.outcome === "failed" || result.reason === "no_client") {
    recordFailure(result.reason ?? "unknown");
  } else if (result.outcome === "swept" || result.outcome === "idle") {
    _consecutiveFailures = 0;
    _lastError = null;
  }
  return result;
}
