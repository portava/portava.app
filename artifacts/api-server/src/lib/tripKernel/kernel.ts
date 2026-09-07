/**
 * Trips v4 kernel — the one place a consequential trip state change happens.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR, IN ORDER
 * ===========================================
 *   1. Read the aggregate. A FAILED READ WRITES NOTHING — the kernel returns
 *      `read_failed` before it has touched anything. This is the first property
 *      the proof suite mutation-tests, because the failure mode it prevents
 *      (deciding against a row you did not actually read) is silent.
 *   2. Replay check. If an event already carries this command's
 *      `idempotencyKey`, return that event. No second write, no second event.
 *   3. Compare-and-set refusal. If the caller stated an `expectedTripVersion`
 *      and the aggregate has since moved, REFUSE.
 *   4. Decide. Authorization and the state-machine invariant, per command.
 *   5. Apply, as a real compare-and-set:
 *        UPDATE trips SET status = …, version = version + 1
 *         WHERE id = $tripId AND version = $expected
 *      One statement. The predicate and the write cannot be interleaved, so two
 *      concurrent commands cannot both win — the loser matches zero rows and is
 *      told `version_conflict`.
 *   6. Append the event at the version the aggregate reached.
 *
 * WHY THE EVENT IS APPENDED AFTER THE STATE CHANGE
 * ================================================
 * Because the state change is the thing this codebase already serves. ~60
 * routes and every trips read path treat public.trips as the aggregate; the log
 * is being introduced UNDER them, additively. Making the log the write-ahead
 * record instead would mean a failed projection write leaves the log asserting a
 * transition the product never performed — a lie in the one place that is
 * supposed to be authoritative.
 *
 * So: CAS first (atomic, and it is what serializes the command), then append. If
 * the append fails, the kernel COMPENSATES — it reverts the aggregate to the
 * exact version it moved from, guarded by `WHERE version = $new` so it cannot
 * clobber a concurrent writer — and reports `write_failed`. The invariant the
 * kernel actually promises is therefore: NO APPLIED COMMAND WITHOUT AN EVENT.
 * A compensation that itself fails is logged at error level with both ids; it
 * cannot be swallowed.
 *
 * WHAT THIS FILE IS NOT
 * =====================
 * Not a projection engine, not a snapshot store, not a replay mechanism, not a
 * transactional outbox, and not a second status vocabulary. It records
 * transitions of the EXISTING public.trip_status enum. See migration 2316.
 */
import { logger } from "../logger.js";
import type {
  TripCommand,
  TripCommandResult,
  TripEventRecord,
  TripEventType,
  TripStatus,
} from "./types.js";

/** Minimal shape the kernel needs from a supabase-js client. */
type Client = any;

/** Columns of the aggregate root the kernel decides against. */
const TRIP_PROJECTION = "id, owner_id, status, version";

/** Columns of the log the kernel reads back. */
const EVENT_PROJECTION =
  "id, trip_id, aggregate_version, event_type, actor_id, from_status, to_status, payload, idempotency_key, occurred_at";

/** Statuses no command may leave. */
const TERMINAL_STATUSES: readonly TripStatus[] = ["cancelled", "archived"];

interface TripAggregate {
  id: string;
  owner_id: string;
  status: TripStatus;
  /**
   * Absent when the projection did not carry the column. On a database with
   * 2316 applied, trips.version is NOT NULL DEFAULT 1, so this is a number for
   * every real row; the undefined branch exists so the kernel degrades to the
   * pre-kernel write instead of refusing every command outright.
   */
  version?: number | null;
}

function toEventRecord(row: any): TripEventRecord {
  return {
    id: String(row.id),
    tripId: String(row.trip_id),
    aggregateVersion: Number(row.aggregate_version),
    eventType: row.event_type as TripEventType,
    actorId: row.actor_id == null ? null : String(row.actor_id),
    fromStatus: (row.from_status ?? null) as TripStatus | null,
    toStatus: (row.to_status ?? null) as TripStatus | null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    idempotencyKey: String(row.idempotency_key),
    occurredAt: String(row.occurred_at),
  };
}

/**
 * The per-command decision: may this actor issue it, and does the aggregate's
 * current state permit it? Pure — no I/O — so the state machine can be read and
 * tested on its own.
 */
function decide(
  command: TripCommand,
  trip: TripAggregate,
): { ok: true; toStatus: TripStatus; eventType: TripEventType } | { ok: false; result: TripCommandResult } {
  switch (command.type) {
    case "trip.complete": {
      if (trip.owner_id !== command.actorId) {
        return { ok: false, result: { ok: false, error: { code: "forbidden" } } };
      }
      if (trip.status === "completed") {
        return {
          ok: false,
          result: { ok: false, error: { code: "already_in_target_state", status: "completed" } },
        };
      }
      if (TERMINAL_STATUSES.includes(trip.status)) {
        return {
          ok: false,
          result: { ok: false, error: { code: "invalid_state_transition", status: trip.status } },
        };
      }
      return { ok: true, toStatus: "completed", eventType: "trip.completed" };
    }
  }
}

/**
 * Execute one command against one aggregate.
 *
 * The client must be a service-role client: public.trip_events grants nothing to
 * anon or authenticated (migration 2316).
 */
export async function executeTripCommand(
  sc: Client,
  command: TripCommand,
): Promise<TripCommandResult> {
  // ── 1. Read the aggregate. Nothing below this line runs on a failed read. ──
  const read = await sc
    .from("trips")
    .select(TRIP_PROJECTION)
    .eq("id", command.tripId)
    .maybeSingle();

  if (read.error) {
    logger.error(
      { err: read.error, tripId: command.tripId, command: command.type },
      "tripKernel: aggregate read failed; command not applied",
    );
    return { ok: false, error: { code: "read_failed", detail: read.error.message } };
  }
  if (!read.data) {
    return { ok: false, error: { code: "not_found" } };
  }

  const trip = read.data as TripAggregate;
  const hasVersionColumn = typeof trip.version === "number";
  const currentVersion = hasVersionColumn ? (trip.version as number) : 1;
  const idempotencyKey =
    command.idempotencyKey ?? derivedIdempotencyKey(command.type, command.tripId, currentVersion);

  // ── 2. Replay. A key already in the log means this command was applied. ────
  const prior = await sc
    .from("trip_events")
    .select(EVENT_PROJECTION)
    .eq("trip_id", command.tripId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (prior.error) {
    logger.error(
      { err: prior.error, tripId: command.tripId, command: command.type },
      "tripKernel: idempotency probe failed; command not applied",
    );
    return { ok: false, error: { code: "read_failed", detail: prior.error.message } };
  }
  if (prior.data) {
    const event = toEventRecord(prior.data);
    return {
      ok: true,
      outcome: "replayed",
      event,
      tripVersion: currentVersion,
      status: trip.status,
    };
  }

  // ── 3. Caller-stated expectation. Checked AFTER the replay probe so that a
  //       retry of an already-applied command replays instead of reporting a
  //       conflict against the version its own success produced. ─────────────
  if (command.expectedTripVersion !== undefined && command.expectedTripVersion !== currentVersion) {
    return {
      ok: false,
      error: {
        code: "version_conflict",
        actualVersion: currentVersion,
        detail: `expected version ${command.expectedTripVersion}, aggregate is at ${currentVersion}`,
      },
    };
  }

  // ── 4. Decide. ─────────────────────────────────────────────────────────────
  const decision = decide(command, trip);
  if (!decision.ok) return decision.result;

  const fromStatus = trip.status;
  const { toStatus, eventType } = decision;
  const newVersion = currentVersion + 1;

  // ── 5. Apply, as a compare-and-set. The version predicate is part of the
  //       UPDATE, so the check and the write are one statement. ──────────────
  let update = sc
    .from("trips")
    .update({ status: toStatus, version: newVersion, updated_at: new Date().toISOString() })
    .eq("id", command.tripId);
  if (hasVersionColumn) update = update.eq("version", currentVersion);

  const applied = await update.select("id");
  if (applied.error) {
    logger.error(
      { err: applied.error, tripId: command.tripId, command: command.type },
      "tripKernel: aggregate compare-and-set failed",
    );
    return { ok: false, error: { code: "write_failed", detail: applied.error.message } };
  }
  const matched = Array.isArray(applied.data) ? applied.data.length : applied.data ? 1 : 0;
  if (matched === 0) {
    // The predicate did not match: another writer moved the aggregate between
    // the read and this statement. This is the compare-and-set biting.
    return {
      ok: false,
      error: {
        code: "version_conflict",
        actualVersion: currentVersion,
        detail: "aggregate moved between read and write",
      },
    };
  }

  // ── 6. Append the event at the version the aggregate reached. ─────────────
  const appended = await sc
    .from("trip_events")
    .insert({
      trip_id: command.tripId,
      aggregate_version: newVersion,
      event_type: eventType,
      actor_id: command.actorId,
      from_status: fromStatus,
      to_status: toStatus,
      payload: { command: command.type },
      idempotency_key: idempotencyKey,
    })
    .select(EVENT_PROJECTION)
    .single();

  if (appended.error || !appended.data) {
    logger.error(
      { err: appended.error, tripId: command.tripId, command: command.type, version: newVersion },
      "tripKernel: event append failed after the aggregate moved; compensating",
    );
    // Compensate. Guarded by the version we just wrote so a concurrent writer
    // cannot be clobbered by the revert.
    const revert = await sc
      .from("trips")
      .update({ status: fromStatus, version: currentVersion })
      .eq("id", command.tripId)
      .eq("version", newVersion)
      .select("id");
    if (revert.error || (Array.isArray(revert.data) ? revert.data.length : revert.data ? 1 : 0) === 0) {
      logger.error(
        { err: revert.error ?? null, tripId: command.tripId, from: fromStatus, to: toStatus },
        "tripKernel: COMPENSATION FAILED — the aggregate moved without an event. Reconcile by hand.",
      );
    }
    return {
      ok: false,
      error: { code: "write_failed", detail: appended.error?.message ?? "event append returned no row" },
    };
  }

  return {
    ok: true,
    outcome: "applied",
    event: toEventRecord(appended.data),
    tripVersion: newVersion,
    status: toStatus,
  };
}

/**
 * Deterministic idempotency key for a command with no caller-supplied one.
 *
 * Scoped to the aggregate VERSION the command was decided against, not just to
 * the trip: two concurrent retries of the same decision collapse to one event,
 * while a genuinely later command against a moved aggregate gets its own key.
 * A key scoped to (trip, actor) alone would make a legitimate second completion
 * — after a trip was reopened through PATCH /trips/:id/settings — silently
 * replay instead of applying.
 */
export function derivedIdempotencyKey(commandType: string, tripId: string, version: number): string {
  return `${commandType}:${tripId}:v${version}`;
}
