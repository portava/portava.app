/**
 * layoverExternalEventScheduler — the thing that makes the §11 event pipeline
 * actually run.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * `services/layover/layoverExternalEventConsumer.ts` can claim a pending
 * external event and hand it to a replanner. `services/airport/
 * LayoverExternalReplanPort.ts` can assemble the airport, the active sessions
 * and their candidates and run `handleEvent` over them. Until this file existed
 * NOTHING CALLED EITHER: the drain ran in tests and nowhere else, and an event
 * ingested through `POST /api/layover/events` would have sat with
 * `processed_at IS NULL` forever.
 *
 * That is the failure `src/test/schedulerRegistration.test.ts` exists to make
 * impossible, in its own words: "A background job that is written, imported,
 * reviewed and merged but never started looks finished and is red nowhere."
 * There is no pg_cron anywhere in `src/migrations`, so the only thing that can
 * start a worker in this tree is a call from `src/index.ts`. This one is
 * exported as `startLayoverExternalEventScheduler` and called from there.
 *
 * ── THE GATE IS THE INGEST'S OWN FLAG, AND THAT IS DELIBERATE ────────────────
 * `layover_event_ingest_enabled` (seeded FALSE by migration 2981) gates the
 * producer door. This drain reads the same flag, so "the channel is open" is
 * ONE fact with one switch rather than two that can disagree. With the flag off
 * the pass performs NO DATABASE READ AT ALL — not even a count — because a
 * closed channel accumulates nothing to drain.
 *
 * WHAT THAT COSTS, STATED RATHER THAN DISCOVERED: closing the flag while rows
 * are pending STRANDS them. They are not lost — `processed_at` stays NULL and
 * the next open drains them — but no traveller is replanned in the meantime and
 * nothing here shouts about it. The alternative, draining a channel the owner
 * has just closed, is worse: it acts on facts from a producer the owner chose
 * to stop trusting. Whoever closes the flag owns the pending set.
 *
 * ── A DRAIN THAT FAILS IS LOUDER THAN A DRAIN THAT DOES NOTHING ──────────────
 * `DrainReport` distinguishes four outcomes and this scheduler logs them apart:
 * a read failure (we do not know whether there was work), events claimed and
 * replanned, events another worker claimed first, and — the one that matters —
 * events this worker CLAIMED and then failed to replan. That last set is
 * reported at WARN with the event ids, because each one is a session whose plan
 * is stale until the next event for it, and `processed_at` is already stamped
 * so no later drain will retry it. See the consumer's header for why that trade
 * is the right way round, and `releaseExternalEventClaim` for the deliberate,
 * separately-called escape hatch.
 */
import { getServiceClient } from "./supabase.js";
import { isFlagEnabled } from "./featureFlags.js";
import { logger as rootLogger } from "./logger.js";
import { drainPendingExternalEvents } from "../services/layover/layoverExternalEventConsumer.js";
import { layoverExternalReplanPort } from "../services/airport/LayoverExternalReplanPort.js";

const logger = rootLogger.child({ scheduler: "layoverExternalEvent" });

/**
 * How long after boot the first pass runs. Long enough that a deploy's health
 * checks answer before this touches the database.
 */
const STARTUP_DELAY_MS = 90_000;

/**
 * Two minutes. An external event moves a SAFETY input — a delay shortens a
 * usable window, a queue reading moves a return deadline — so the interval is
 * the upper bound on how stale a traveller's plan can be after the world
 * changes. Shorter costs a query against a partial index; longer is a traveller
 * walking back to an airport on arithmetic that stopped being true.
 */
const DRAIN_INTERVAL_MS = 120_000;

/**
 * Events per pass. Bounded so one flood cannot hold a pass open indefinitely;
 * the next tick takes the rest.
 */
const DRAIN_LIMIT = 50;

let _timer: NodeJS.Timeout | null = null;

export interface LayoverDrainOutcome {
  drained: number;
  claimedByAnother: number;
  failedAfterClaim: number;
  unreadable: number;
  skipped: boolean;
  /**
   * WHY this pass did nothing.
   *
   *   no_client    the process holds no service-role client
   *   gate_closed  layover_event_ingest_enabled is off; NO read was performed
   *   read_failed  the pending read was attempted and refused
   *   null         a real pass; the counts above are the result
   */
  reason: "no_client" | "gate_closed" | "read_failed" | null;
}

/**
 * One drain pass.
 *
 * `nowMs` is an argument rather than a clock read so the whole path stays
 * deterministic under test and so ONE instant is used for the claim stamp and
 * for every feasibility recomputation in the pass. Two reads could stamp an
 * event at one instant and certify a deadline against another.
 */
export async function runLayoverExternalEventDrain(
  opts: { client?: any; nowMs: number; limit?: number } = { nowMs: Date.now() },
): Promise<LayoverDrainOutcome> {
  const empty = { drained: 0, claimedByAnother: 0, failedAfterClaim: 0, unreadable: 0 };
  // Explicit null means "no client"; undefined means "use the service client".
  // NOT `opts.client ?? getServiceClient()` — `??` does not short-circuit on an
  // explicit null, so a unit test passing `client: null` would open a socket.
  // lib/intelRetentionScheduler records that exact defect.
  const db = "client" in opts && opts.client !== undefined ? opts.client : getServiceClient();
  if (!db) return { ...empty, skipped: true, reason: "no_client" };

  if (!(await isFlagEnabled(db, "layover_event_ingest_enabled"))) {
    return { ...empty, skipped: true, reason: "gate_closed" };
  }

  const report = await drainPendingExternalEvents(
    db,
    layoverExternalReplanPort(db, { nowMs: opts.nowMs }),
    { limit: opts.limit ?? DRAIN_LIMIT, nowMs: opts.nowMs },
  );

  if (report.readFailed !== null) {
    logger.warn({ err: report.readFailed }, "pending external event read failed — this pass does not know whether there was work");
    return { ...empty, skipped: true, reason: "read_failed" };
  }

  if (report.failedAfterClaim.length > 0) {
    // The ids, not just the count. Each is a session whose plan is stale until
    // the next event for it, and processed_at is already stamped so no later
    // drain will pick it up.
    logger.warn(
      { events: report.failedAfterClaim },
      "external events were CLAIMED and not replanned — processed_at is stamped and these will not be retried",
    );
  }
  if (report.drained.length > 0) {
    logger.info(
      {
        drained: report.drained.length,
        notifications: report.drained.reduce((n, d) => n + d.notifications, 0),
      },
      "external events replanned",
    );
  }

  return {
    drained: report.drained.length,
    claimedByAnother: report.claimedByAnother,
    failedAfterClaim: report.failedAfterClaim.length,
    unreadable: report.unreadable,
    skipped: false,
    reason: null,
  };
}

export function startLayoverExternalEventScheduler(): void {
  if (_timer !== null) return;
  logger.info(
    {
      startupDelayMs: STARTUP_DELAY_MS,
      intervalMs: DRAIN_INTERVAL_MS,
      limit: DRAIN_LIMIT,
      gate: "layover_event_ingest_enabled must be ON; it is seeded FALSE by migration 2981",
    },
    "LayoverExternalEventScheduler scheduled (a no-op on every database where the ingest gate is closed)",
  );
  _timer = setTimeout(function tick() {
    void runLayoverExternalEventDrain({ nowMs: Date.now() }).finally(() => {
      _timer = setTimeout(tick, DRAIN_INTERVAL_MS);
    });
  }, STARTUP_DELAY_MS);
}

export function stopLayoverExternalEventScheduler(): void {
  if (_timer !== null) {
    clearTimeout(_timer);
    _timer = null;
  }
}
