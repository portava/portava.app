/**
 * LayoverTemporalFreedom — the LAYOVER ADAPTER onto the generalised Temporal
 * Freedom Engine (spec §7, §18 `TemporalFreedomService`).
 *
 * ── WHY THIS FILE IS AN ADAPTER AND NOT AN ENGINE ───────────────────────────
 * census-layover L56/L57/L178 all read "Absent" / "no generic engine", and that
 * was measured against `services/airport/`. It is false about the repository:
 * `domain/trips/invariants/TripFreedomEngine.ts` IS the generalised engine the
 * layover spec §7 describes — the same `FreedomWindow`, the same commitment
 * ordering, the same "a window is a LOWER BOUND on free time" rule — built for
 * the Trips spec's own §7.3 and imported here without one line of it changing.
 *
 * The layover spec says what to do about that in its own words:
 *
 *   §7:  "Layover is its first high-stakes adapter."
 *   §7:  "Keep airport-specific logic in the Layover adapter, not in the
 *         generalized engine."
 *   Developer rule 14: "Always keep the generalized Temporal Freedom Engine
 *         free of airport-specific assumptions; use adapters."
 *
 * So writing a SECOND freedom engine under `services/airport/` would have been
 * the one thing the spec explicitly forbids. Everything airport-shaped —
 * boarding-cutoff anchoring, the exit-delay model, the return buffer — is
 * computed in `LayoverSafetyEngine` and arrives here as plain numbers; this
 * file translates them into the engine's vocabulary and translates its answer
 * back. It imports NOTHING from `AirportProfileService` or
 * `LayoverSessionService`, and nothing from `LayoverSafetyEngine` either —
 * which is what keeps the dependency one-directional and is asserted by test.
 *
 * ── THE LAYOVER AS TWO COMMITMENTS ──────────────────────────────────────────
 * A layover is exactly the shape the engine already computes between:
 *
 *   arrival    the inbound flight. `startsAt` wheels-down; `endsAt` the earliest
 *              instant the traveller is standing landside (wheels-down + the
 *              exit-delay model). The window opens when they are released from
 *              it, which is `leaveAt()`'s own rule.
 *   departure  the outbound flight. `requiredArrivalAt` is the cutoff — boarding
 *              time when the session carries one, departure otherwise, which is
 *              `layoverCutoffMs`'s rule and not a second one. `prepMinutes` is
 *              the certified return buffer: every minute that must be COMPLETE
 *              before the cutoff (security, immigration, bags, traffic,
 *              time-of-day, live conditions).
 *
 * The travel term between them is **0, and that is a fact rather than an
 * estimate**: both commitments are at the same airport, and a journey from a
 * point to itself is zero minutes long. It is emphatically NOT the landside
 * journey — that is charged per candidate in `assess`, as `statedTravelMin × 2`,
 * and is `null` on this tree because no routed provider exists. Putting the
 * landside leg here would double-charge it and would also be a number nobody
 * measured. The engine's `TRAVEL_UNKNOWN` constraint therefore does not fire
 * for a layover, and the window's honesty rests on `prepMinutes` and on
 * `confidence`, which is where the layover's real uncertainty lives.
 *
 * ── WHAT THE ENGINE THEN GIVES BACK, THAT THIS SURFACE DID NOT HAVE ─────────
 * `endsAt = cutoff + tolerance − travel − prep` is, term for term,
 * `computeReturnDeadline`'s `hardReturnTime`. That equality is not a comment:
 * `layoverTemporalFreedom.test.ts` sweeps it over a grid of sessions and
 * airports and fails if the two ever differ by a millisecond, which is the
 * tripwire that stops this from becoming a second way to compute the number a
 * traveller acts on.
 *
 * What is NEW is the failure case. When prep alone does not fit between the two
 * commitments the engine does not return a zero-length window: it returns a
 * `TEMPORAL_CONFLICT` carrying `shortfallMinutes`. Before this, a traveller
 * whose buffer ate their whole layover saw `usableMinutes: 0` and a sentence
 * about not having enough time; the number they were short by existed nowhere.
 * §7.2's rule — "a conflict is not silently rendered as a normal itinerary" —
 * is what that number is for.
 *
 * ── WHAT THIS DOES NOT CLOSE ────────────────────────────────────────────────
 * `certified` is false for every layover this tree can produce and the type
 * cannot express otherwise: the engine certifies only at HIGH confidence, and
 * the buffer terms behind `prepMinutes` are AIRPORT_PROFILE at best (MEDIUM for
 * a verified airport, LOW for every other, and production has 0 verified
 * airports). A certified freedom window needs a real distribution behind the
 * buffer, not a different adapter.
 */
import {
  computeFreedomWindows,
  leaveAt,
  type EngineCommitment,
  type FreedomWindow,
  type HopTravel,
  type TemporalConflict,
} from "../../domain/trips/invariants/TripFreedomEngine.js";
import type { TravelConfidence } from "../../lib/travelEstimate.js";
import type { GeoPoint } from "../../domain/trips/contracts/TravelTimeProvider.js";

const MS_PER_MIN = 60_000;

/** Stable ids for the two commitments a layover is made of. */
export const LAYOVER_ARRIVAL_COMMITMENT_ID = "layover:arrival";
export const LAYOVER_DEPARTURE_COMMITMENT_ID = "layover:departure";

/**
 * Everything the adapter needs, as plain values.
 *
 * Deliberately NOT an `AirportProfile` and a `LayoverSession`: taking the
 * domain objects would make this file airport-shaped in its signature and would
 * force it to re-derive the cutoff and the buffer, which are already certified
 * once per request. Every field below is a number the caller has already
 * computed; this module computes none of them and reads no clock.
 */
export interface LayoverFreedomContext {
  /** Wheels-down, epoch ms. */
  arrivalMs: number;
  /** Scheduled outbound departure, epoch ms. The commitment's `startsAt`. */
  departureMs: number;
  /**
   * The instant the outbound flight stops waiting — `layoverCutoffMs`'s answer,
   * passed in rather than re-derived. The commitment's `requiredArrivalAt`.
   */
  cutoffMs: number;
  /** Wheels-down → standing landside, minutes. */
  exitDelayMin: number;
  /** The certified return buffer: minutes that must be complete by the cutoff. */
  returnBufferMin: number;
  /** Both commitments are here. `null` when the airport has no usable coordinate. */
  airportPoint: GeoPoint | null;
  /** Identifies the place on both commitments. */
  airportPlaceId: string | null;
  /**
   * Weakest confidence behind the buffer terms — `bufferEstimates`'s own
   * `rowConf` rule, passed in for the same reason the minutes are. It can never
   * be HIGH on this tree, so the window is never `certified`.
   */
  confidence: TravelConfidence;
}

/**
 * The §7 answer for one layover: at most one window, and the conflict that
 * replaced it when there is none.
 *
 * Both are returned. A caller that reads only `window` still behaves exactly as
 * it did before this file existed (no window ⇒ no usable time); a caller that
 * reads `conflict` can say by how much.
 */
export interface LayoverFreedomResult {
  /** The single between-commitments window, or `null` when it does not exist. */
  window: FreedomWindow | null;
  /** §7.2 — why there is no window. `null` when there is one. */
  conflict: TemporalConflict | null;
  /** The two commitments, exactly as the generalised engine read them. */
  commitments: EngineCommitment[];
}

/**
 * Spec §7 `Commitment`, as the generalised engine's `EngineCommitment`.
 *
 * Six of the spec's eight members map straight across — `type`, `startsAt`,
 * `requiredArrivalAt`, `location` (`place`), `preparationTime` (`prepMinutes`),
 * `latenessTolerance` (`latenessToleranceMinutes`). The other two,
 * `hardConstraints` and `confidence`, live on the WINDOW in this engine rather
 * than on the commitment; that divergence is real and is recorded in the census
 * rather than papered over here, because `EngineCommitment` is the Trips
 * domain's type and widening it is that lane's decision, not this one's.
 *
 * `latenessToleranceMinutes` is 0 for both, and that is a safety statement:
 * an aircraft does not wait, so there is no tolerance to spend. The spec's
 * `latenessTolerance` exists for commitments that can absorb one (a dinner
 * reservation); a flight is the canonical case that cannot.
 */
export function layoverCommitments(ctx: LayoverFreedomContext): EngineCommitment[] {
  const place = { placeId: ctx.airportPlaceId, point: ctx.airportPoint };
  return [
    {
      id: LAYOVER_ARRIVAL_COMMITMENT_ID,
      type: "inbound_flight",
      startsAt: new Date(ctx.arrivalMs),
      // The traveller is required to be on the inbound flight when it lands;
      // the deadline they are ordered by is therefore wheels-down itself.
      requiredArrivalAt: new Date(ctx.arrivalMs),
      // NOT unknown. The exit-delay model is exactly a statement about when the
      // inbound flight releases the traveller, so `PREVIOUS_END_UNKNOWN` must
      // not fire for a layover — it would downgrade a window whose start this
      // surface knows better than any other input it holds.
      endsAt: new Date(ctx.arrivalMs + ctx.exitDelayMin * MS_PER_MIN),
      place,
      flexibility: "fixed",
      prepMinutes: 0,
      latenessToleranceMinutes: 0,
    },
    {
      id: LAYOVER_DEPARTURE_COMMITMENT_ID,
      type: "outbound_flight",
      startsAt: new Date(ctx.departureMs),
      requiredArrivalAt: new Date(ctx.cutoffMs),
      endsAt: null,
      place,
      flexibility: "fixed",
      prepMinutes: ctx.returnBufferMin,
      latenessToleranceMinutes: 0,
    },
  ];
}

/**
 * The hop between the two commitments: zero minutes, because they are the same
 * airport. See the header for why this is a fact and not an estimate, and why
 * the landside journey does NOT belong here.
 *
 * `routed: false` is honest for the same reason: nothing routed anything. The
 * engine reads `routed` only to report it, and `confidence` is the caller's.
 */
function samePlaceHop(confidence: TravelConfidence): HopTravel {
  return { travelMinutes: 0, confidence, routed: false, unknownReason: null };
}

/**
 * §18 `TemporalFreedomService.buildFreedomWindow(context)`.
 *
 * Returns the ONE window a layover has, or the conflict that replaced it. The
 * engine can in principle return several; a layover has exactly two
 * commitments, so it returns at most one "between" window and this narrows to
 * it rather than handing a caller an array it would have to index.
 */
export function buildFreedomWindow(ctx: LayoverFreedomContext): LayoverFreedomResult {
  const commitments = layoverCommitments(ctx);
  const result = computeFreedomWindows({
    commitments,
    hops: [samePlaceHop(ctx.confidence)],
    participants: [],
    // No window before the inbound flight and none after the outbound: a
    // layover is the gap BETWEEN them and nothing else. Passing trip bounds
    // would invent two windows this surface has no answer for.
    tripStart: null,
    tripEnd: null,
  });
  const between = result.windows.find((w) => w.position === "between") ?? null;
  const conflict = result.conflicts[0] ?? null;
  return { window: between, conflict, commitments };
}

/**
 * §18 `TemporalFreedomService.calculateCommitmentEnvelope(context)`.
 *
 * The protected band in front of a commitment: from `mustLeaveBy` to
 * `requiredArrivalAt`, the minutes the traveller may NOT spend on anything
 * else. For a layover the commitment is the outbound flight and the envelope is
 * `[hardReturnTime, cutoff]` — the same interval `computeReturnDeadline`
 * publishes, derived here from the commitment itself so the two cannot drift.
 *
 * It is computed from the SAME commitments `buildFreedomWindow` uses, so an
 * envelope and a window returned for one context always agree at the boundary:
 * `envelope.mustLeaveBy === window.endsAt` whenever a window exists. Swept in
 * the test rather than argued here.
 */
export interface CommitmentEnvelope {
  commitmentId: string;
  type: string;
  /** ISO. The instant the traveller must be at the commitment. */
  requiredArrivalAt: string;
  /** ISO. The last instant they are still free: arrival + tolerance − reserved. */
  mustLeaveBy: string;
  /** Minutes reserved ahead of the commitment: travel + preparation. */
  reservedMinutes: number;
  /** The hop into the commitment. 0 for a layover — see the header. */
  travelMinutes: number;
  preparationMinutes: number;
  latenessToleranceMinutes: number;
  confidence: TravelConfidence;
  /** Never true on this tree: the engine certifies only at HIGH confidence. */
  certified: boolean;
}

export function calculateCommitmentEnvelope(ctx: LayoverFreedomContext): CommitmentEnvelope {
  const [, departure] = layoverCommitments(ctx);
  const hop = samePlaceHop(ctx.confidence);
  const travelMinutes = hop.travelMinutes ?? 0;
  const reservedMinutes = travelMinutes + departure!.prepMinutes;
  const arriveByMs =
    departure!.requiredArrivalAt!.getTime() + departure!.latenessToleranceMinutes * MS_PER_MIN;
  return {
    commitmentId: departure!.id,
    type: departure!.type,
    requiredArrivalAt: new Date(arriveByMs).toISOString(),
    mustLeaveBy: new Date(arriveByMs - reservedMinutes * MS_PER_MIN).toISOString(),
    reservedMinutes,
    travelMinutes,
    preparationMinutes: departure!.prepMinutes,
    latenessToleranceMinutes: departure!.latenessToleranceMinutes,
    confidence: ctx.confidence,
    certified: ctx.confidence === "HIGH",
  };
}

/**
 * The instant the traveller is released from the inbound flight, as the
 * generalised engine's own `leaveAt` decides it.
 *
 * Exported and used by `computeWindow` instead of `arrival + exitDelay` spelled
 * a second time, so "when does the window open" has one definition for this
 * surface and it is the engine's.
 */
export function earliestLandsideMs(ctx: LayoverFreedomContext): number {
  const [arrival] = layoverCommitments(ctx);
  const at = leaveAt(arrival!);
  /* c8 ignore next -- arrival always carries a start and an end, so leaveAt is total here */
  return at ? at.getTime() : ctx.arrivalMs + ctx.exitDelayMin * MS_PER_MIN;
}

/**
 * §18's named service object.
 *
 * The spec lists `TemporalFreedomService` with these two members and nothing
 * else. It is a plain object rather than a class because every member is pure:
 * there is no state to hold, no client to inject, and a class would invite one.
 */
export const TemporalFreedomService = {
  buildFreedomWindow,
  calculateCommitmentEnvelope,
} as const;
