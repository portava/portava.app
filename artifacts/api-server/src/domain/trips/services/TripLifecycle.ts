/**
 * Trips spec §3.1 — the primary lifecycle, derived, PURE.
 *
 * §3.1 is thirteen states:
 *
 *   IDEA → PLANNING → BOOKED → PRE_DEPARTURE → TRAVELING → IN_DESTINATION
 *        → RETURNING → COMPLETED → MEMORY
 *   Alternative states: DISRUPTED | CANCELLED | ABANDONED | ARCHIVED
 *
 * and one sentence that decides the SHAPE of this file:
 *
 *   "Lifecycle is computed from canonical facts plus explicit user actions. Do
 *    not store boolean soup such as isActive/isStarted/isFinished/isTraveling
 *    when a single state machine can express the semantics."
 *
 * WHAT EXISTED, AND WHY THIS IS NOT A MIGRATION
 * =============================================
 * census-trips TR35: "Seven states against thirteen: BOOKED, PRE_DEPARTURE,
 * TRAVELING vs IN_DESTINATION vs RETURNING, MEMORY, DISRUPTED and ABANDONED
 * have no representation, so the states that carry the spec's operational
 * meaning are exactly the missing ones." Measured again on this branch
 * 2026-09-13: `PRE_DEPARTURE`, `IN_DESTINATION` and `TRAVELING` have ZERO
 * occurrences in artifacts/api-server/src and travel-buddy-standalone/src, and
 * `ABANDONED` has one — a goal status in a test, not a trip lifecycle state.
 *
 * census-trips §68.2 classified TR35 as needing "a lifecycle migration and the
 * code that moves through it". §3.1's own sentence says otherwise, and its
 * sibling already settled the argument in this tree: §3.2's eight operational
 * phases are derived, not stored (domain/trips/services/TripOperationalPhase.ts,
 * whose header quotes the same sentence for the same reason). Storing a
 * thirteen-value column beside the seven-value one would be TWO state machines
 * for one concept — the divergence `domain/trips/invariants/tripStatus.ts` was
 * extracted to end, one level up.
 *
 * THE STORED STATUS IS NOT REPLACED
 * =================================
 * `computeTripStatus` (invariants/tripStatus.ts) stays exactly as it is: it is
 * the STORAGE vocabulary, `trips.status`, seven values, and it carries the two
 * explicit terminal acts (cancel, archive) that no derivation may recompute
 * away. This file reads that answer as a fact and derives §3.1's thirteen over
 * it. Nothing here is written anywhere.
 *
 * THE ORDER IS THE RULE
 * =====================
 * The first clause that holds names the state. Explicit acts first, because a
 * traveller who cancelled a trip did not "become" anything else; then
 * DISRUPTED, which §3.1 lists as an alternative state and which overrides the
 * forward chain for as long as it lasts and no longer; then identity (a trip
 * with no subject is an IDEA whatever its dates say); then the calendar —
 * after the trip, before it, inside it — and within each of those the facts
 * that distinguish its states. Every answer carries the clause that produced
 * it, so a consumer can disagree with a reason rather than a word.
 *
 * A FACT THAT WAS NOT READ IS NOT A FACT THAT IS FALSE
 * ====================================================
 * Every fact below is `| null`, and null means NOT READ rather than zero. A
 * clause that needs an unread fact cannot fire, and the state it could have
 * named is recorded in `unread` instead of being silently ruled out. A caller
 * that reads nothing but the `trips` row still gets a lawful answer over the
 * calendar, and the answer says which states it could not consider. Treating
 * an unread count as 0 would have made ABANDONED fire on every trip whose
 * reservations nobody looked at.
 *
 * WHERE THE FACTS COME FROM, AND WHETHER THEY EXIST IN PRODUCTION
 * ===============================================================
 * Deliberately, every one is a table production already carries
 * (baseline/20260907_production_tables.txt): `trips` (dates, timezone,
 * status), `trip_reservations` (0172 — confirmed bookings and the flight /
 * transport legs), `trip_plan_items` (0010 — items actually carried out),
 * `passport_memories` (`trip_id` — the trip became a memory). §3.1 is the one
 * §3 requirement that needs nothing from 2760-2795 and nothing from a flag, so
 * it is derived from what a deployment has TODAY rather than from what a
 * migration would give it.
 *
 * DISRUPTED is the exception and says so: the register it would be read from
 * (`trip_disruptions`, 2785) is in no database, so a caller that cannot read
 * one passes null and the answer names `activeDisruptions` as unread.
 */
import { localClock } from "./TripOperationalPhase.js";

/** §3.1's nine forward states, in the spec's order. */
export const TRIP_FORWARD_LIFECYCLE = [
  "IDEA", "PLANNING", "BOOKED", "PRE_DEPARTURE", "TRAVELING", "IN_DESTINATION", "RETURNING", "COMPLETED", "MEMORY",
] as const;

/** §3.1's four alternative states. */
export const TRIP_ALTERNATIVE_LIFECYCLE = ["DISRUPTED", "CANCELLED", "ABANDONED", "ARCHIVED"] as const;

export const TRIP_LIFECYCLE_STATES = [...TRIP_FORWARD_LIFECYCLE, ...TRIP_ALTERNATIVE_LIFECYCLE] as const;
export type TripLifecycleState = (typeof TRIP_LIFECYCLE_STATES)[number];

/**
 * How long before departure a trip is PRE_DEPARTURE rather than BOOKED. Two
 * days, which is the window §11.2's departure-day logistics and §18.1's
 * offline bundle both treat as "about to travel".
 */
export const PRE_DEPARTURE_HOURS = 48;

/** A confirmed flight or transport reservation, as `trip_reservations` (0172) holds it. */
export interface LifecycleTravelLeg {
  id: string;
  /** ISO instant of departure; null when the booking carries no time. */
  startsAt: string | null;
  /** ISO instant of arrival; null when the booking carries no time. */
  endsAt: string | null;
}

export interface LifecycleInputs {
  now: Date;
  /** IANA zone the trip's days are counted in; null → UTC. */
  timezone: string | null;
  /** YYYY-MM-DD. */
  startDate: string | null;
  endDate: string | null;
  /** `computeTripStatus`'s answer — the stored seven, carrying the explicit terminal acts. */
  storedStatus: string | null;
  title: string | null;
  destinationCity: string | null;
  /** `trip_reservations` with status 'confirmed', any type. NULL = not read. */
  confirmedBookings: number | null;
  /** Confirmed 'flight' / 'transport' reservations. NULL = not read. */
  travelLegs: readonly LifecycleTravelLeg[] | null;
  /** `trip_plan_items` with status 'done'. NULL = not read. */
  completedPlanItems: number | null;
  /** `passport_memories` for this trip. NULL = not read. */
  recordedMemories: number | null;
  /** Active rows in the §17 disruption register. NULL = not read. */
  activeDisruptions: number | null;
  /** Override for tests and for a deployment that wants a different window. */
  preDepartureHours?: number;
}

export interface LifecycleDecision {
  state: TripLifecycleState;
  /** The clause that produced the state. */
  reason: string;
  /**
   * Facts a clause on the path to this answer needed and could not read. Empty
   * when every fact the derivation consulted was supplied.
   */
  unread: readonly string[];
  evidence: {
    localDate: string;
    storedStatus: string | null;
    outboundLegId: string | null;
    returnLegId: string | null;
  };
}

/** Whole days from `a` to `b`, both YYYY-MM-DD. Negative when `b` is earlier. */
function daysBetween(a: string, b: string): number {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return NaN;
  return Math.round((pb - pa) / 86_400_000);
}

/** The legs with a parseable departure, in departure order. */
function orderedLegs(legs: readonly LifecycleTravelLeg[]): LifecycleTravelLeg[] {
  return legs
    .filter((l) => Number.isFinite(Date.parse(String(l.startsAt))))
    .slice()
    .sort((x, y) => Date.parse(String(x.startsAt)) - Date.parse(String(y.startsAt)));
}

export function deriveTripLifecycle(inputs: LifecycleInputs): LifecycleDecision {
  const { date } = localClock(inputs.now, inputs.timezone);
  const nowMs = inputs.now.getTime();
  const unread: string[] = [];
  const evidence = {
    localDate: date,
    storedStatus: inputs.storedStatus ?? null,
    outboundLegId: null as string | null,
    returnLegId: null as string | null,
  };
  const answer = (state: TripLifecycleState, reason: string): LifecycleDecision =>
    ({ state, reason, unread: unread.slice(), evidence });

  // 1. Explicit terminal acts. A cancelled or archived trip is that, and no
  //    fact recomputes it — the same rule computeTripStatus applies first.
  if (inputs.storedStatus === "archived") return answer("ARCHIVED", "trips.status is 'archived' — an explicit user action, terminal");
  if (inputs.storedStatus === "cancelled") return answer("CANCELLED", "trips.status is 'cancelled' — an explicit user action, terminal");

  // 2. DISRUPTED — §3.1's alternative state, for as long as it lasts.
  if (inputs.activeDisruptions === null) unread.push("activeDisruptions");
  else if (inputs.activeDisruptions > 0) return answer("DISRUPTED", `${inputs.activeDisruptions} active disruption(s) on the trip`);

  // 3. Identity. A trip with no subject is an IDEA whatever its dates say —
  //    the same two fields computeTripStatus reads as 'draft'.
  if (!inputs.title || !inputs.destinationCity) return answer("IDEA", "no title or no destination city: the trip has no subject yet");

  // 4. No dates: there is a subject and no when.
  const start = inputs.startDate ? inputs.startDate.slice(0, 10) : null;
  const end = inputs.endDate ? inputs.endDate.slice(0, 10) : null;
  if (!start) return answer("PLANNING", "a subject with no start date");

  // An open-ended trip is never past its end — the rule computeTripStatus
  // already applies (`!end || today <= end` is 'active'). Treating a missing
  // end as "ends on the first day" would have retired every open-ended trip
  // the day after it began, and the two vocabularies would disagree about the
  // same row.
  const last = end;

  // ── After the trip ────────────────────────────────────────────────────────
  if (last !== null && date > last) {
    // 5. MEMORY — it is over AND it produced something that outlives it.
    if (inputs.recordedMemories === null) unread.push("recordedMemories");
    else if (inputs.recordedMemories > 0) return answer("MEMORY", `${inputs.recordedMemories} memory/memories recorded against the trip after it ended`);

    // 6. ABANDONED — over, and nothing was ever confirmed or carried out.
    //    BOTH facts are required: a trip whose bookings nobody read is not
    //    evidence of abandonment, it is evidence of an unread table.
    if (inputs.confirmedBookings === null) unread.push("confirmedBookings");
    if (inputs.completedPlanItems === null) unread.push("completedPlanItems");
    if (inputs.confirmedBookings === 0 && inputs.completedPlanItems === 0) {
      return answer("ABANDONED", `local date ${date} is past ${last} and nothing was ever confirmed or carried out`);
    }

    // 7. COMPLETED.
    return answer("COMPLETED", `local date ${date} is past ${last}`);
  }

  // ── Before the trip ───────────────────────────────────────────────────────
  if (date < start) {
    const legs = inputs.travelLegs === null ? null : orderedLegs(inputs.travelLegs);
    if (legs === null) unread.push("travelLegs");
    const outbound = legs?.[0] ?? null;
    if (outbound) evidence.outboundLegId = outbound.id;

    // 8. PRE_DEPARTURE — departure is imminent. The booked leg decides when it
    //    has one; otherwise the trip's first day does. §3.1's chain runs
    //    through BOOKED, but it is a path and not a precondition: "the day
    //    before you travel" is PRE_DEPARTURE whether or not the flight was
    //    typed into this app.
    const windowHours = inputs.preDepartureHours ?? PRE_DEPARTURE_HOURS;
    const legDeparture = outbound ? Date.parse(String(outbound.startsAt)) : NaN;
    if (Number.isFinite(legDeparture) && legDeparture - nowMs <= windowHours * 3_600_000) {
      return answer("PRE_DEPARTURE", `the outbound leg ${outbound!.id} departs within ${windowHours}h`);
    }
    const daysToStart = daysBetween(date, start);
    if (Number.isFinite(daysToStart) && daysToStart * 24 <= windowHours) {
      return answer("PRE_DEPARTURE", `the trip's first day ${start} is ${daysToStart} day(s) from local date ${date}`);
    }

    // 9. BOOKED.
    if (inputs.confirmedBookings === null) unread.push("confirmedBookings");
    else if (inputs.confirmedBookings > 0) return answer("BOOKED", `${inputs.confirmedBookings} confirmed reservation(s) and departure is not yet within ${windowHours}h`);

    // 10. PLANNING.
    return answer("PLANNING", `dates and a destination, nothing confirmed, ${daysToStart} day(s) before the first day`);
  }

  // ── Inside the trip's dates ───────────────────────────────────────────────
  const legs = inputs.travelLegs === null ? null : orderedLegs(inputs.travelLegs);
  if (legs === null) unread.push("travelLegs");
  const outbound = legs && legs.length > 0 ? legs[0]! : null;
  // The return leg is the last one, and only when it is not also the outbound.
  const returnLeg = legs && legs.length > 1 ? legs[legs.length - 1]! : null;
  if (outbound) evidence.outboundLegId = outbound.id;
  if (returnLeg) evidence.returnLegId = returnLeg.id;

  // 11. TRAVELING — the outbound leg is under way.
  if (outbound) {
    const dep = Date.parse(String(outbound.startsAt));
    const arr = Date.parse(String(outbound.endsAt));
    if (Number.isFinite(dep) && dep <= nowMs && (!Number.isFinite(arr) || nowMs < arr)) {
      return answer("TRAVELING", `the outbound leg ${outbound.id} is under way`);
    }
  }

  // 12. RETURNING — the return leg has begun.
  if (returnLeg) {
    const dep = Date.parse(String(returnLeg.startsAt));
    if (Number.isFinite(dep) && dep <= nowMs) {
      return answer("RETURNING", `the return leg ${returnLeg.id} has departed`);
    }
  }

  // 13. IN_DESTINATION — inside the dates with neither leg under way.
  return answer("IN_DESTINATION", `local date ${date} is within ${start}..${end ?? "open"} and no travel leg is under way`);
}
