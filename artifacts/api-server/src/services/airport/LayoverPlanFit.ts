/**
 * The minute arithmetic behind "does this plan fit?", in ONE place.
 *
 * WHY IT IS A MODULE. Three callers ask this question — the plan routes
 * (`computePlanFit`), the Compass `simulatePlan` tool and the crew branch
 * solver (`branchNeededMinutes`) — and until now each carried its own copy.
 * `LayoverCrewService` said so in a comment: *"Deliberately the SAME arithmetic
 * as `computePlanFit` in routes/airport.ts … if the two ever diverge the crew
 * number is the wrong one."* Census L47 is what a divergence costs, so the
 * arithmetic is written once and the copies call it.
 *
 * WHAT IT REFUSES TO DO, which is the whole point (census L47). It does not
 * charge an unstated leg zero minutes. `layover_plan_stops.travel_min` is
 * `INTEGER NOT NULL DEFAULT 0` (migration 0127), so the row cannot hold "nobody
 * said": an unmeasured journey is stored as the number zero. Inside the
 * terminal that zero IS the fact — an airside stop has no landside leg, by
 * construction rather than by estimate, which is the same distinction
 * `TRAVEL_TIME_SOURCES` draws between `inside_airport` and `category_default`.
 * OUTSIDE it, zero minutes to a place in the city is not a travel time; it is
 * the absence of one.
 *
 * So the totals here are a LOWER BOUND whenever anything is unstated, and the
 * caller is told. A lower bound can REFUSE a plan — if even it overflows, the
 * plan certainly does not fit — and it can never CERTIFY one.
 */

/** A stop as the plan arithmetic reads it. Nothing else is consumed. */
export interface PlanFitStop {
  durationMin?: number | null;
  travelMin?: number | null;
  insideAirport?: boolean | null;
}

/**
 * The minutes a stop's journey takes, or `null` when nobody has said.
 * Airside is 0 by construction; landside needs a positive stated figure.
 */
export function statedTravelMin(s: PlanFitStop): number | null {
  if (s.insideAirport === true) return 0;
  const v = Number(s.travelMin);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The minutes a stop lasts, or `null` when nobody has said. The column's own
 * CHECK is `BETWEEN 5 AND 720`, so a non-positive value is never a duration a
 * traveller chose — it is a missing one, and `duration_min ?? 30` used to hand
 * it a thirty-minute substitute.
 */
export function statedDurationMin(s: PlanFitStop): number | null {
  const v = Number(s.durationMin);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface PlanFitTotals {
  /** Dwell + outbound leg over every stop, counting only what is stated. */
  totalPlannedMin: number;
  /**
   * The ride back, approximated by the outbound leg of the LAST stop outside
   * the airport — and 0 when that leg is itself unstated, which is the second
   * zero the old arithmetic charged a traveller.
   */
  returnTravelMin: number;
  /** `totalPlannedMin + returnTravelMin`. A lower bound when anything is unstated. */
  neededMin: number;
  /** Landside stops whose journey is not a stated figure. */
  unstatedTravelStops: number;
  /** Stops whose dwell time is not a stated figure. */
  unstatedDurationStops: number;
  /** TRUE when `neededMin` omits a leg, so the real total is larger. */
  neededMinIsLowerBound: boolean;
}

/** Total the plan, and say what it could not total. */
export function planFitTotals(stops: readonly PlanFitStop[]): PlanFitTotals {
  let unstatedTravelStops = 0;
  let unstatedDurationStops = 0;
  let totalPlannedMin = 0;
  for (const s of stops) {
    const travel = statedTravelMin(s);
    const dwell = statedDurationMin(s);
    if (travel === null) unstatedTravelStops += 1;
    if (dwell === null) unstatedDurationStops += 1;
    totalPlannedMin += (dwell ?? 0) + (travel ?? 0);
  }
  const lastOutside = [...stops].reverse().find((s) => s.insideAirport !== true);
  const returnTravelMin = lastOutside ? (statedTravelMin(lastOutside) ?? 0) : 0;
  const unstated = unstatedTravelStops + unstatedDurationStops;
  return {
    totalPlannedMin,
    returnTravelMin,
    neededMin: totalPlannedMin + returnTravelMin,
    unstatedTravelStops,
    unstatedDurationStops,
    neededMinIsLowerBound: unstated > 0,
  };
}

/**
 * §6.1's plan-level answer, three-valued because a lower bound can refuse but
 * never certify.
 *
 *   "over"     the lower bound already exceeds the usable window. Certain.
 *   "unknown"  it does not, but a leg is unstated. The plan may well fit;
 *              nobody has measured it, and "fits with room" would be inventing
 *              the measurement.
 *   "fits"     every leg is stated and the total is inside the window.
 */
export type PlanFitVerdict = "fits" | "over" | "unknown";

export function planFitVerdict(totals: PlanFitTotals, usableMinutes: number): PlanFitVerdict {
  if (totals.neededMin > usableMinutes) return "over";
  return totals.neededMinIsLowerBound ? "unknown" : "fits";
}
