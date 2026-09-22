/**
 * layoverCrewExpiryScheduler — census-layover L196's "expiration jobs", built.
 *
 * ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
 * L196 reads: "Create presence/crew tables with restrictive policies and
 * **expiration jobs**." Migration 2984 built the tables and, under a heading of
 * its own, declined to build the job:
 *
 *   > EXPIRY IS A COLUMN, NOT A JOB
 *   > L196 asks for "expiration jobs" and this migration does NOT provide one …
 *   > There is no scheduler in this tree … shipping a column named `expires_at`
 *   > that nothing sweeps would be a retention promise nothing keeps.
 *   > So the column is a FILTER, not a promise: every read in
 *   > `services/layover/LayoverCrewStore.ts` is bounded by `expires_at > now()`,
 *   > so an unswept crew is invisible rather than stale-but-live. The row
 *   > survives until something deletes it. That is honest and it is not
 *   > retention; L196 stays N.
 *
 * This is the something that deletes it. 2984 even left the index for it —
 * `layover_crews_expiry_idx`, commented "the sweep read, for whenever something
 * is built to do the sweeping" — so this module adds no schema of its own.
 *
 * ── WHY DELETE, AND WHY WITH NO GRACE PERIOD ─────────────────────────────────
 * A crew is a list of PEOPLE: who was travelling with whom, in which city, at
 * which hour. `expires_at` already makes it unreadable — every read in
 * LayoverCrewStore is bounded by it — so a row this sweep removes is one no
 * code path in the tree can observe. Deleting it changes no answer any caller
 * could get, and keeping it changes only how much personal data sits in the
 * database after it has stopped meaning anything.
 *
 * That is lib/sensingRetentionScheduler's argument, and it applies here for the
 * same reason. It is also why there is NO grace window between expiry and
 * deletion: a grace can only lengthen the retention of data nothing can read.
 * The one thing a grace would buy — not racing an in-flight request — is
 * already bought by the read filter, which hid the row before this sweep ever
 * looked at it.
 *
 * `layover_crew_members` is not swept separately and must not be: 2984 declares
 * `crew_id UUID NOT NULL REFERENCES layover_crews(id) ON DELETE CASCADE`, so
 * the membership rows go with the crew in the same statement. A second DELETE
 * against the member table would be a second, weaker answer to the same
 * question — and one that could orphan a crew if it ran alone.
 *
 * ── WHY NOTHING IS WRITTEN WHEN A CREW IS SWEPT ──────────────────────────────
 * Migration 2985 adds crew vocabulary to `layover_events`, so emitting a
 * `crew_expired` event per deleted crew would typecheck and would look
 * diligent. It is declined. `layover_events` rows are user-linked, and a
 * retention sweep that MINTS a personal row naming the user and the hour for
 * every personal row it removes has not reduced anything — it has re-recorded
 * the fact in a table with a longer life. A count in a log line carries what an
 * operator needs; who was in the crew is exactly what this job exists to forget.
 *
 * ── WHY THERE IS NO FEATURE FLAG ─────────────────────────────────────────────
 * The same reason lib/sensingRetentionScheduler has none, stated again rather
 * than inherited. 2984 seeds no flag, seeding one is an owner decision, and the
 * thing a flag would protect against does not exist here: the rows this DELETEs
 * are already invisible to every reader, so there is no behaviour to roll back
 * to. A flag would only add a way to leave expired personal data in place.
 *
 * WHAT GATES IT INSTEAD is the schema — but READ THE NEXT PARAGRAPH BEFORE
 * RELYING ON THAT, because the obvious reading of it is wrong about production.
 * `crewTablesPresent` probes before every pass, and a probe that fails for ANY
 * reason — table missing, database unreachable, permission refused, socket
 * thrown — answers "absent" and the DELETE is never attempted. Where the tables
 * do not exist this scheduler is an inert heartbeat. When they appear, the next
 * pass picks them up with no restart.
 *
 * 2984 IS APPLIED TO PRODUCTION. An earlier version of this header said it was
 * "applied to no database in this repository's own capability snapshot", and
 * that was FALSE when it was written: `layover_crews` and `layover_crew_members`
 * are in the 2026-09-21 capture AND the 2026-09-22 one, and
 * production-applied-migrations.json carries 2984_layover_crews at version
 * 20260916115643. The sentence was inherited from 2984's own header, which was
 * accurate on the day it was written and stopped being so when the migration
 * was applied. A schema gate cannot be reasoned about from a migration file's
 * recollection of itself; it has to be read from the capture.
 *
 * SO WHAT ACTUALLY HOLDS ON PRODUCTION TODAY IS EMPTINESS, NOT ABSENCE. Both
 * crew tables exist there and both are EMPTY — measured 2026-09-22: 0 crews, 0
 * members, so `expires_at <= now()` selects nothing and this sweep deletes
 * nothing. That is a fact about the data, and unlike a schema gate it stops
 * being true the moment Layover crews carry traffic. From that moment this
 * scheduler deletes expired crews on production automatically, on its own
 * cadence, with no flag. That is the intended behaviour and the paragraph below
 * argues for it — but it should be entered deliberately rather than discovered,
 * which is why it is written down here instead of left to a stale sentence.
 *
 * ── THE RESULT IS FOUR-WAY, NOT A BOOLEAN ────────────────────────────────────
 * `{ deleted: 0 }` was four different facts wearing one face: nothing was due,
 * the table could not be read, the DELETE was refused, and the tables do not
 * exist. Three of those are reasons to act and one is health. So `outcome`
 * separates them — `swept` · `idle` · `refused` · `failed` — and `complete`
 * separates a batch that finished the backlog from one that merely filled up.
 * `deleted` is a COUNT and is only ever non-zero on a pass that the database
 * confirmed.
 *
 * ── THE CLOCK IS AN ARGUMENT ─────────────────────────────────────────────────
 * The cutoff comes from `opts.now`, never from `Date.now()` inside the sweep. A
 * sweep whose cutoff is read from the wall clock can only be tested against the
 * wall clock, and a test written that way either asserts nothing or asserts a
 * date that stops being true. `runLayoverCrewExpiryTick` is the seam that reads
 * the clock, once, at the edge.
 */
import { logger } from "./logger.js";
import { getServiceClient } from "./supabase.js";

/**
 * The crew tables, as string literals.
 *
 * NOT imported from `services/layover/LayoverCrewStore.ts`, for the reason that
 * file's own header gives at length: `check:write-path-columns` resolves a
 * read/write site only when it can see `.from("<literal>")` in the AST, and
 * `.from(CONSTANT)` is a blind spot it cannot diff against the live schema.
 * Duplicating the literal is what makes this site checkable.
 */
const CREW_TABLE = "layover_crews";

/** A positive finite env float, else the default (house pattern: eventWaitlistSweeper). */
function parseEnvFloat(raw: string | undefined, def: number): number {
  const v = raw !== undefined ? parseFloat(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : def;
}

function parseEnvInt(raw: string | undefined, def: number, max: number): number {
  const v = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(v) && v > 0 && v <= max ? v : def;
}

/**
 * Later than the intel schedulers (the latest is 8 minutes) and later than the
 * sensing sweep (9), so the boot burst is not made worse by a probe that will
 * answer "absent" on every database this repository knows about.
 */
const STARTUP_DELAY_MS = 10 * 60 * 1000;

/**
 * Sweep cadence, default ten minutes.
 *
 * `CREW_TTL_MINUTES` is 12 hours, so the cadence decides only how long a row
 * that is ALREADY invisible lingers in storage — not whether anything is
 * correct. Ten minutes keeps that window short without turning an indexed
 * delete into a busy loop. Configurable via
 * LAYOVER_CREW_EXPIRY_SWEEP_INTERVAL_SECONDS; anything unset, non-numeric or
 * <= 0 falls back to the default.
 */
export const LAYOVER_CREW_EXPIRY_SWEEP_INTERVAL_SECONDS = parseEnvFloat(
  process.env["LAYOVER_CREW_EXPIRY_SWEEP_INTERVAL_SECONDS"],
  600,
);
export const LAYOVER_CREW_EXPIRY_INTERVAL_MS = LAYOVER_CREW_EXPIRY_SWEEP_INTERVAL_SECONDS * 1000;

/**
 * How many crews one pass may remove.
 *
 * Bounded so a first sweep against a long-unswept table is a series of small
 * indexed deletes rather than one statement that locks the table for however
 * long the backlog takes. A full batch is reported as `complete: false`, so the
 * caller can see that the backlog outlived the pass.
 */
export const LAYOVER_CREW_EXPIRY_BATCH_SIZE = parseEnvInt(
  process.env["LAYOVER_CREW_EXPIRY_BATCH_SIZE"],
  200,
  1000,
);

let _timer: ReturnType<typeof setTimeout> | null = null;

/**
 * WHY THIS PASS DID WHAT IT DID.
 *
 *   swept    rows were due and the database confirmed their removal
 *   idle     the sweep RAN and nothing was due — a measurement, and healthy
 *   refused  the sweep did not run: no client, or the tables are not here
 *   failed   the sweep ran and the database refused it
 *
 * `idle` and `refused` are the pair that matters. Collapsing them is how a
 * permanently broken job becomes indistinguishable from a correctly quiet one,
 * which is the defect lib/intelRetentionScheduler's header records and
 * lib/callSweepScheduler's failure ledger exists to catch.
 */
export type LayoverCrewExpiryOutcome = "swept" | "idle" | "refused" | "failed";

export type LayoverCrewExpiryReason =
  /** The process holds no service-role client. */
  | "no_client"
  /** 2984 is not applied to this database — no statement was issued. */
  | "tables_absent"
  /** The bounded id read was refused. Nothing was deleted. */
  | "read_failed"
  /** Ids were read and the DELETE was refused. Nothing was deleted. */
  | "delete_failed"
  /** A real pass. */
  | null;

export interface LayoverCrewExpirySweepResult {
  outcome: LayoverCrewExpiryOutcome;
  reason: LayoverCrewExpiryReason;
  /**
   * Crews the database confirmed it removed. Never an attempt count, and never
   * non-zero on a pass that did not run — `0` here is only ever a measurement.
   */
  deleted: number;
  /**
   * False when the batch filled up, which means rows were probably still due
   * when the pass ended. True on a pass that reached the end of the backlog.
   * Always false on a refusal or a failure: a pass that did not run has not
   * finished anything.
   */
  complete: boolean;
}

function refused(reason: Exclude<LayoverCrewExpiryReason, null>): LayoverCrewExpirySweepResult {
  return { outcome: "refused", reason, deleted: 0, complete: false };
}

function failed(reason: Exclude<LayoverCrewExpiryReason, null>): LayoverCrewExpirySweepResult {
  return { outcome: "failed", reason, deleted: 0, complete: false };
}

/**
 * Do the crew tables exist here?
 *
 * A HEAD select, so it returns no rows — this must not read a crew's contents
 * to find out whether crews exist. Any error, and any throw, answers "absent":
 * the two are indistinguishable for this purpose and both mean "do not issue a
 * DELETE". Deliberately NOT memoised, unlike `sensingStorePresent`: an operator
 * applying 2984 to a running deployment should be picked up by the next pass,
 * and a probe every ten minutes costs nothing next to that.
 */
async function crewTablesPresent(db: any): Promise<boolean> {
  if (!db) return false;
  try {
    const { error } = await db.from(CREW_TABLE).select("id", { head: true }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

/**
 * One sweep, deterministic in its instant.
 *
 * `opts.now` IS the cutoff. There is no `Date.now()` in this function, so a
 * caller can prove exactly which rows a pass would remove without owning a
 * clock — the same property migration 2315 gave its purge function on purpose.
 */
export async function runLayoverCrewExpirySweep(
  opts: { client?: any; now: Date; batchSize?: number },
): Promise<LayoverCrewExpirySweepResult> {
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — `??` does not short-circuit on an
  // explicit null, so a unit test passing `client: null` would get a REAL
  // client and open a socket. lib/intelRetentionScheduler records that defect.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return refused("no_client");

  if (!(await crewTablesPresent(db))) return refused("tables_absent");

  const limit = opts.batchSize ?? LAYOVER_CREW_EXPIRY_BATCH_SIZE;
  const cutoff = opts.now.toISOString();

  // Ids only. A sweep has no business reading a crew's title, city or meeting
  // point — it needs to know which rows to remove and nothing else, and a
  // projection that carries the contents is a copy of them into this process's
  // memory and, on a failure, into whatever logs the error.
  //
  // Two statements rather than one `DELETE … WHERE expires_at < $1 LIMIT $2`:
  // PostgREST does not offer LIMIT on a delete, and an unbounded delete is the
  // table-lock this batching exists to avoid.
  const read = await db
    .from(CREW_TABLE)
    .select("id")
    .lt("expires_at", cutoff)
    .order("expires_at", { ascending: true })
    .limit(limit);

  if (read?.error) {
    // supabase-js RESOLVES on a database error, so this branch is the normal
    // failure path and not an exotic one. Reporting it as `deleted: 0` would be
    // the plausible-empty-operational-state defect this tree has been bitten by
    // repeatedly: a sweep that cannot read anything is not a sweep that found
    // nothing.
    logger.warn(
      { err: read.error },
      "layover crew expiry sweep could not read due crews — 0 deleted is not a measurement here",
    );
    return failed("read_failed");
  }

  const ids = ((read?.data ?? []) as Array<{ id: string }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (ids.length === 0) {
    // A pass that RAN and found nothing due. This is health, and it is the one
    // zero in this module that means what it says.
    return { outcome: "idle", reason: null, deleted: 0, complete: true };
  }

  const del = await db.from(CREW_TABLE).delete().in("id", ids);
  if (del?.error) {
    logger.warn(
      { err: del.error, due: ids.length },
      "layover crew expiry sweep could not delete due crews — expired crew rows remain in storage",
    );
    return failed("delete_failed");
  }

  // What the database CONFIRMED, not what was asked for. A delete that matched
  // fewer rows than it targeted (a concurrent sweep, a cascade from a deleted
  // session) deleted fewer rows, and the count must say so.
  const confirmed = Array.isArray(del?.data) ? del.data.length : ids.length;

  logger.info(
    { deleted: confirmed, complete: ids.length < limit },
    "layover crew expiry sweep removed expired crews",
  );

  return {
    outcome: "swept",
    reason: null,
    deleted: confirmed,
    // A batch that filled up says nothing about what is left behind it.
    complete: ids.length < limit,
  };
}

/**
 * CONSECUTIVE FAILED SWEEPS.
 *
 * The failure shapes most likely to be SUSTAINED — a renamed column, a revoked
 * grant, an RLS change — are exactly the ones that would otherwise go unnoticed
 * indefinitely while expired crew rows accumulated. The counter resets ONLY on
 * a pass that actually ran.
 *
 * `tables_absent` is deliberately NOT a failure. 2984 is applied to no database
 * in this repository's capability snapshot, so counting it would put this
 * scheduler into sustained-failure escalation on boot, every boot, everywhere —
 * and an alert that is always on is an alert nobody reads by the time the real
 * one fires. `no_client` IS counted: a process with no service client is a
 * misconfiguration, not a documented resting state.
 */
let _consecutiveFailures = 0;
let _lastError: string | null = null;

/** Consecutive failed sweeps, and the last failure — for tests and health. */
export function layoverCrewExpiryFailureState(): {
  consecutiveFailures: number;
  lastError: string | null;
} {
  return { consecutiveFailures: _consecutiveFailures, lastError: _lastError };
}

/** Test seam: forget the failure history (does not touch the timer). */
export function _resetLayoverCrewExpiryFailureState(): void {
  _consecutiveFailures = 0;
  _lastError = null;
}

/** Escalate once the failure looks sustained rather than transient. */
const SUSTAINED_FAILURE_TICKS = 3;

/**
 * Run one tick and keep the failure ledger.
 *
 * This is where the clock is read — once, at the edge — so that everything
 * below it is a pure function of the instant it was given. It NEVER rejects:
 * the timer's reschedule below is unconditional by construction rather than by
 * a `.catch()` that a resolved PostgREST error would have walked straight past.
 */
export async function runLayoverCrewExpiryTick(
  opts: { client?: any; now?: Date; batchSize?: number } = {},
): Promise<LayoverCrewExpirySweepResult> {
  let result: LayoverCrewExpirySweepResult;
  try {
    result = await runLayoverCrewExpirySweep({
      ...opts,
      now: opts.now ?? new Date(),
    });
  } catch (err) {
    // A client that throws rather than resolving. Not reachable through
    // supabase-js's own error path, which is exactly why it must not be able to
    // kill the timer if a wiring bug ever produces it.
    recordFailure(String((err as any)?.message ?? err));
    return refused("no_client");
  }

  if (result.outcome === "failed" || result.reason === "no_client") {
    recordFailure(result.reason ?? "unknown");
  } else if (result.outcome === "swept" || result.outcome === "idle") {
    _consecutiveFailures = 0;
    _lastError = null;
  }
  // `tables_absent` leaves the ledger exactly as it was: it is neither a
  // failure to escalate nor a pass that proves the previous failures are over.
  return result;
}

function recordFailure(message: string): void {
  _consecutiveFailures += 1;
  _lastError = message;
  const payload = { consecutiveFailures: _consecutiveFailures, err: message };
  if (_consecutiveFailures >= SUSTAINED_FAILURE_TICKS) {
    logger.error(
      payload,
      "layover crew expiry sweep has failed on consecutive ticks — expired crew rows are accumulating and L196's retention promise is not being kept",
    );
  } else {
    logger.warn(payload, "layover crew expiry sweep failed");
  }
}

export function startLayoverCrewExpiryScheduler(): void {
  if (_timer !== null) return; // already started
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: LAYOVER_CREW_EXPIRY_INTERVAL_MS,
      batchSize: LAYOVER_CREW_EXPIRY_BATCH_SIZE,
      gate: "layover_crews must exist in this database (migration 2984)",
    },
    "LayoverCrewExpiryScheduler scheduled (no-op wherever migration 2984 is not applied)",
  );
  _timer = setTimeout(function tick() {
    void runLayoverCrewExpiryTick().finally(() => {
      _timer = setTimeout(tick, LAYOVER_CREW_EXPIRY_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
  // The sweep is housekeeping; it must never be the reason a process refuses to
  // exit. Every other scheduler in this band relies on the process being
  // long-lived, and unref keeps a test that forgets to stop it from hanging.
  _timer.unref?.();
}

export function stopLayoverCrewExpiryScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
