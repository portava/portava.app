/**
 * layoverPresenceExpiryScheduler — the PRESENCE half of census-layover L196's
 * "Create presence/crew tables with restrictive policies and expiration jobs".
 *
 * ── WHAT THIS CLOSES, AND WHAT IT DOES NOT ──────────────────────────────────
 * The crew half is built and scheduled (`lib/layoverCrewExpiryScheduler.ts`,
 * 2984 applied). The presence half had a table and no job: migration 3900
 * creates `layover_presence` with `expires_at` documented as "a FILTER, as in
 * 2984 and 2992: every read is bounded by expires_at > now(). Not a retention
 * promise." — and nothing deleted a row whose expiry had passed. This is that
 * job. 3900 even left the index for it (`layover_presence_expiry_idx`), so this
 * module adds no schema of its own.
 *
 * 3900 IS UNAPPLIED IN PRODUCTION. Until it is, every pass is a probe that
 * answers "absent" and issues no other statement: `refused / table_absent`,
 * which is not a failure and is never escalated. When 3900 lands, the next pass
 * picks the table up with no restart.
 *
 * ── WHY DELETE, AND WHY NO GRACE PERIOD ─────────────────────────────────────
 * A presence row says what a traveller was open to, until when, in which
 * layover. Every read in `services/layover/LayoverPresenceStore.ts` is bounded
 * by `expires_at > now`, so a row this sweep removes is one no code path can
 * observe; deleting it changes no answer any caller could get, and keeping it
 * changes only how much personal data outlives its meaning. That is the crew
 * sweep's argument and lib/sensingRetentionScheduler's, and it rules out a grace
 * window for the same reason: a grace only lengthens the life of data nothing
 * can read. The cutoff is `expires_at <= now` — the exact complement of the
 * read filter, so the sweep removes precisely the rows the readers already hide.
 *
 * ── WHY NO FEATURE FLAG ─────────────────────────────────────────────────────
 * `layover_presence_intents_enabled` (3900, seeded FALSE) governs whether
 * presence is READ AND WRITTEN. It does not govern retention, and must not: a
 * flag turned off after travellers shared intents would otherwise leave their
 * expired rows in place indefinitely — a flag would only add a way to keep
 * expired personal data. With the flag off nothing writes the table, so a pass
 * finds nothing due and deletes nothing (`idle`). The gate is the schema.
 *
 * ── WHY NOTHING IS WRITTEN PER DELETED ROW ──────────────────────────────────
 * No `layover_events` row is minted for a swept presence: a retention sweep
 * that re-records "this traveller was present" in a longer-lived table has not
 * reduced anything. A count in a log line is what an operator needs.
 *
 * ── THE RESULT IS FOUR-WAY, AND THE CLOCK IS AN ARGUMENT ────────────────────
 * `swept · idle · refused · failed`, as the crew sweep reports them, so a quiet
 * job and a broken one never share a face. `opts.now` IS the cutoff; there is
 * no `Date.now()` below the tick, so a test proves exactly which rows a pass
 * removes without owning a clock.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";

/** A positive finite env float, else the default (house pattern: layoverCrewExpiryScheduler). */
function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

function parseEnvInt(raw: string | undefined, def: number, max: number): number {
  const v = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(v) && v > 0 && v <= max ? v : def;
}

/** Just after the crew sweep (10 min), so the two probes do not land together at boot. */
const STARTUP_DELAY_MS = 11 * 60 * 1000;

/**
 * Sweep cadence, default ten minutes. The cadence decides only how long a row
 * that is ALREADY invisible lingers in storage. Configurable via
 * LAYOVER_PRESENCE_EXPIRY_SWEEP_INTERVAL_SECONDS; unset, non-numeric or <= 0
 * falls back to the default.
 */
export const LAYOVER_PRESENCE_EXPIRY_SWEEP_INTERVAL_SECONDS = parseEnvFloat(
  process.env["LAYOVER_PRESENCE_EXPIRY_SWEEP_INTERVAL_SECONDS"],
  600,
);
export const LAYOVER_PRESENCE_EXPIRY_INTERVAL_MS = LAYOVER_PRESENCE_EXPIRY_SWEEP_INTERVAL_SECONDS * 1000;

/** How many presence rows one pass may remove; a full batch reports `complete: false`. */
export const LAYOVER_PRESENCE_EXPIRY_BATCH_SIZE = parseEnvInt(
  process.env["LAYOVER_PRESENCE_EXPIRY_BATCH_SIZE"],
  200,
  1000,
);

let _timer: ReturnType<typeof setTimeout> | null = null; let _generation = 0; // which loop is current: a pass re-arms only if no stop() came after its own start()

export type LayoverPresenceExpiryOutcome = "swept" | "idle" | "refused" | "failed";

export type LayoverPresenceExpiryReason =
  /** The process holds no service-role client. */
  | "no_client"
  /** 3900 is not applied to this database — no statement beyond the probe was issued. */
  | "table_absent"
  /** The bounded due-row read was refused. Nothing was deleted. */
  | "read_failed"
  /** Due rows were read and the DELETE was refused. Nothing was deleted. */
  | "delete_failed"
  /** A real pass. */
  | null;

export interface LayoverPresenceExpirySweepResult {
  outcome: LayoverPresenceExpiryOutcome;
  reason: LayoverPresenceExpiryReason;
  /** Rows the database confirmed it removed — a measurement, never an attempt count. */
  deleted: number;
  /** False when the batch filled up, and on every refusal or failure. */
  complete: boolean;
}

function refused(reason: Exclude<LayoverPresenceExpiryReason, null>): LayoverPresenceExpirySweepResult {
  return { outcome: "refused", reason, deleted: 0, complete: false };
}

function failed(reason: Exclude<LayoverPresenceExpiryReason, null>): LayoverPresenceExpirySweepResult {
  return { outcome: "failed", reason, deleted: 0, complete: false };
}

/**
 * Does `layover_presence` exist here? A HEAD select — no row is read to find
 * out. Any error and any throw answers "absent", so no DELETE is ever issued
 * against a table this pass could not see. Not memoised: an operator applying
 * 3900 to a running deployment is picked up by the next pass.
 */
async function presenceTablePresent(db: any): Promise<boolean> {
  if (!db) return false;
  try {
    const { error } = await db.from("layover_presence").select("session_id", { head: true }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

/** One sweep, deterministic in its instant: `opts.now` is the cutoff. */
async function runLayoverPresenceExpirySweepImpl(
  opts: { client?: any; now: Date; batchSize?: number },
): Promise<LayoverPresenceExpirySweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  const db = auditedLayoverClient("client" in opts && opts.client !== undefined ? opts.client : getServiceClient());
  if (!db) return refused("no_client");

  if (!(await presenceTablePresent(db))) return refused("table_absent");

  const limit = opts.batchSize ?? LAYOVER_PRESENCE_EXPIRY_BATCH_SIZE;
  const cutoff = opts.now.toISOString();

  // Keys only: the sweep has no business reading what a traveller was open to.
  // Two statements, because PostgREST offers no LIMIT on a DELETE and an
  // unbounded delete is the table lock this batching exists to avoid.
  const read = await db
    .from("layover_presence")
    .select("session_id")
    .lte("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(limit);

  if (read?.error) {
    logger.warn({ err: read.error }, "layover presence expiry sweep could not read due rows — 0 deleted is not a measurement here");
    return failed("read_failed");
  }

  const keys = ((read?.data ?? []) as Array<{ session_id: unknown }>)
    .map((r) => r.session_id)
    .filter((k): k is string => typeof k === "string" && k.length > 0);

  if (keys.length === 0) return { outcome: "idle", reason: null, deleted: 0, complete: true };

  // `.lte` again on the DELETE: a row whose expiry was pushed forward between
  // the read and the delete (the traveller re-shared) is no longer due and is
  // left alone. `.select` so the count is what the database confirmed.
  const del = await db
    .from("layover_presence")
    .delete()
    .in("session_id", keys)
    .lte("expires_at", cutoff)
    .select("session_id");
  if (del?.error) {
    logger.warn({ err: del.error, due: keys.length }, "layover presence expiry sweep could not delete due rows — expired presence remains in storage");
    return failed("delete_failed");
  }

  const confirmed = Array.isArray(del?.data) ? del.data.length : 0;
  logger.info({ deleted: confirmed, complete: keys.length < limit }, "layover presence expiry sweep removed expired presence rows");
  return { outcome: "swept", reason: null, deleted: confirmed, complete: keys.length < limit };
}

/**
 * CONSECUTIVE FAILED SWEEPS. `table_absent` is NOT a failure — it is
 * production's resting state until 3900 is applied, and an alert that is always
 * on is one nobody reads. `no_client` IS counted: it is a misconfiguration.
 */
let _consecutiveFailures = 0;
let _lastError: string | null = null;

export function layoverPresenceExpiryFailureState(): { consecutiveFailures: number; lastError: string | null } {
  return { consecutiveFailures: _consecutiveFailures, lastError: _lastError };
}

/** Test seam: forget the failure history (does not touch the timer). */
export function _resetLayoverPresenceExpiryFailureState(): void {
  _consecutiveFailures = 0;
  _lastError = null;
}

const SUSTAINED_FAILURE_TICKS = 3;

function recordFailure(message: string): void {
  _consecutiveFailures += 1;
  _lastError = message;
  const payload = { consecutiveFailures: _consecutiveFailures, err: message };
  if (_consecutiveFailures >= SUSTAINED_FAILURE_TICKS) {
    logger.error(payload, "layover presence expiry sweep has failed on consecutive ticks — expired presence rows are accumulating and L196's retention promise is not being kept");
  } else {
    logger.warn(payload, "layover presence expiry sweep failed");
  }
}

/** One tick: reads the clock once, at the edge, and NEVER rejects. */
export async function runLayoverPresenceExpiryTick(
  opts: { client?: any; now?: Date; batchSize?: number } = {},
): Promise<LayoverPresenceExpirySweepResult> {
  let result: LayoverPresenceExpirySweepResult;
  try {
    result = await runLayoverPresenceExpirySweep({ ...opts, now: opts.now ?? new Date() });
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

export function startLayoverPresenceExpiryScheduler(): void {
  if (_timer !== null) return; // already started
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: LAYOVER_PRESENCE_EXPIRY_INTERVAL_MS,
      batchSize: LAYOVER_PRESENCE_EXPIRY_BATCH_SIZE,
      gate: "layover_presence must exist in this database (migration 3900)",
    },
    "LayoverPresenceExpiryScheduler scheduled (no-op wherever migration 3900 is not applied)",
  );
  const generation = ++_generation;
  _timer = setTimeout(function tick() {
    void runLayoverPresenceExpiryTick().finally(() => {
      if (_timer !== null && generation === _generation) { _timer = setTimeout(tick, LAYOVER_PRESENCE_EXPIRY_INTERVAL_MS); _timer.unref?.(); } // a stop() during the run must not re-arm
    });
  }, STARTUP_DELAY_MS);
  // Housekeeping must never be the reason a process refuses to exit.
  _timer.unref?.();
}

export function stopLayoverPresenceExpiryScheduler(): void {
  _generation += 1;
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}

import { auditedLayoverClient, withLayoverSystemAudit } from './layoverServiceAudit.js';
export function runLayoverPresenceExpirySweep(...args: Parameters<typeof runLayoverPresenceExpirySweepImpl>): ReturnType<typeof runLayoverPresenceExpirySweepImpl> { return withLayoverSystemAudit('layover:presence-expiry', () => runLayoverPresenceExpirySweepImpl(...args)); }
