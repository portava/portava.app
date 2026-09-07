/**
 * Trips v4 kernel — the typed command contract.
 *
 * WHAT A TripCommand IS
 * =====================
 * A consequential trip state change, expressed as data rather than as an
 * `UPDATE` buried in a route handler. The kernel is the only thing allowed to
 * turn one into a state change, and every applied command leaves a row in
 * public.trip_events. The v4 spec's phrasing: "consequential Trip state
 * mutations must ultimately pass through the canonical Trip Kernel."
 *
 * Today exactly ONE command exists — `trip.complete`, the reference
 * implementation. That is deliberate. A command contract with fifteen members
 * and one implementation is a wish list; one member routed end to end, with the
 * ratchet in src/scripts/checkDirectTripWrites.ts counting the ~200 direct
 * writes still outside, is a spine plus a measured distance to travel.
 *
 * TWO FIELDS THAT ARE NOT OPTIONAL EXTRAS
 * =======================================
 * `idempotencyKey` — every command carries one. A retry of a command already
 * applied must not append a second event or move the aggregate a second time.
 * The uniqueness is enforced by the database (UNIQUE (trip_id,
 * idempotency_key), migration 2316), not by an application-side "check then
 * write" that a concurrent second request would slip straight through.
 *
 * `expectedTripVersion` — optimistic concurrency. The caller states which
 * version of the aggregate it decided against; if the aggregate has moved on,
 * the command is REFUSED rather than applied to a state it was not computed
 * for. Enforced as a real compare-and-set: the UPDATE carries
 * `WHERE id = $tripId AND version = $expected`, so the check and the write are
 * one statement and cannot be interleaved.
 */

/** public.trip_status — the EXISTING enum. The kernel introduces no new vocabulary. */
export type TripStatus =
  | "draft"
  | "planning"
  | "upcoming"
  | "active"
  | "completed"
  | "cancelled"
  | "archived";

/** Event types the log accepts. Mirrors trip_events_event_type_check in 2316. */
export type TripEventType = "trip.completed";

export interface TripCommandBase {
  /** Aggregate the command addresses. */
  readonly tripId: string;
  /** Who issued it. Recorded as trip_events.actor_id. */
  readonly actorId: string;
  /**
   * Command de-duplication key, unique per trip.
   *
   * Optional ONLY at the boundary. When a caller has no natural key the kernel
   * derives a deterministic, version-scoped one (`derivedIdempotencyKey`) from
   * the aggregate it just read, and stores it on the event exactly like a
   * supplied key. There is no path that writes an event without one:
   * trip_events.idempotency_key is NOT NULL and UNIQUE per trip (2316).
   */
  readonly idempotencyKey?: string;
  /**
   * The aggregate version the caller decided against. When omitted, the kernel
   * uses the version it reads itself, which still gives compare-and-set against
   * concurrent writers but expresses no caller-side expectation.
   */
  readonly expectedTripVersion?: number;
}

/**
 * Mark a trip completed. The simplest consequential mutation in the existing
 * routes: one column on the aggregate root, owner-only, no child tables, no
 * fan-out. Chosen as the reference precisely because nothing else has to change
 * for it to be routed through the kernel.
 */
export interface CompleteTripCommand extends TripCommandBase {
  readonly type: "trip.complete";
}

export type TripCommand = CompleteTripCommand;

/** A row of the append-only log, as the kernel returns it. */
export interface TripEventRecord {
  readonly id: string;
  readonly tripId: string;
  readonly aggregateVersion: number;
  readonly eventType: TripEventType;
  readonly actorId: string | null;
  readonly fromStatus: TripStatus | null;
  readonly toStatus: TripStatus | null;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

/**
 * Why a command was refused.
 *
 *   read_failed              the aggregate could not be read. NOTHING was
 *                            written — the kernel never writes on a failed read.
 *   not_found                no such trip.
 *   forbidden                the actor may not issue this command.
 *   invalid_state_transition the aggregate is in a state this command cannot
 *                            leave (e.g. completing a cancelled trip).
 *   already_in_target_state  the command would be a no-op. Not an error to the
 *                            caller, but not an event either: the log records
 *                            changes, not requests.
 *   version_conflict         compare-and-set lost. The aggregate moved between
 *                            the read and the write, or expectedTripVersion was
 *                            stale on arrival.
 *   write_failed             the write itself failed. Always logged.
 */
export type TripKernelErrorCode =
  | "read_failed"
  | "not_found"
  | "forbidden"
  | "invalid_state_transition"
  | "already_in_target_state"
  | "version_conflict"
  | "write_failed";

export interface TripKernelError {
  readonly code: TripKernelErrorCode;
  /** Operator-facing detail. Never returned to a client verbatim. */
  readonly detail?: string;
  /** Present for already_in_target_state / invalid_state_transition. */
  readonly status?: TripStatus;
  /** Present for version_conflict: what the aggregate's version actually is. */
  readonly actualVersion?: number;
}

export type TripCommandResult =
  | {
      readonly ok: true;
      /** "applied" — the aggregate moved. "replayed" — this key was already applied. */
      readonly outcome: "applied" | "replayed";
      readonly event: TripEventRecord;
      readonly tripVersion: number;
      readonly status: TripStatus;
    }
  | { readonly ok: false; readonly error: TripKernelError };
