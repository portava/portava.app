/**
 * layoverMapBands — spec §13's map bands SAFE / TIGHT / BLOCKED, computed on
 * the SERVER from the certified budget, one per landside plan stop (census
 * layover L67, and the band L116 / L122 say a pin carries).
 *
 * ── WHY A SECOND BAND, BESIDE `CandidateFeasibility.band` ───────────────────
 * The envelope band (`layoverRankingFeasibility.ts`) is GEOMETRY: a straight-
 * line lower bound against the usable window. It can prove a place unreachable
 * (BLOCKED) and nothing else, so SAFE and TIGHT are spelled there and never
 * produced (census §41, L116). This band answers a different question with
 * different inputs — does THIS stop, as planned, fit THIS certified budget
 * under THIS landside gate — and it can say SAFE, because every term it reads
 * is either certified (the window, the gate) or stated (the stop's own travel
 * and dwell minutes, which `POST /:id/stops` refuses to store as zero for a
 * landside stop). It never re-derives the window and never measures a route.
 *
 * ── THE RULE, IN ORDER; THE FIRST THAT APPLIES WINS ─────────────────────────
 *   airside stop                      → no band. Nothing landside to fit.
 *   landside gate CLOSED              → BLOCKED. Whatever the minutes say.
 *   envelope proved it unreachable    → BLOCKED. The geometry's answer stands.
 *   window or a leg not a number      → no band, with the reason. Unmeasured is
 *                                       never drawn as reachable.
 *   stay + there-and-back > usable    → BLOCKED.
 *   landside gate CAUTION             → TIGHT. An unconfirmed border or a tight
 *                                       window is never SAFE.
 *   the whole plan overflows          → TIGHT. The stop fits; the plan does not.
 *   spare minutes < the margin        → TIGHT. The margin is RETURN_SOON's lead
 *                                       (30 min), not a new number.
 *   otherwise                         → SAFE.
 * The return leg is charged as the outbound leg again — the same approximation
 * `planFitTotals` makes for the ride back — and the SAFE sentence says that the
 * travel time is the one the traveller entered, not a measured route.
 *
 * Pure. Published under `layover_map_bands_enabled` (migration 3633, seeded
 * FALSE): with it off, the overview's stops are exactly what they were.
 */
import type { LandsideClosure, LandsideStatus, LandsideCaution } from "./LayoverConstraints.js";
import { RETURN_SOON_LEAD_MIN } from "./LayoverSafetyEngine.js";

export const MAP_BANDS = ["SAFE", "TIGHT", "BLOCKED"] as const;
export type MapBand = (typeof MAP_BANDS)[number];

/** Spare minutes below which a fitting stop is TIGHT. RETURN_SOON's own lead. */
export const MAP_BAND_TIGHT_MARGIN_MIN = RETURN_SOON_LEAD_MIN;

export interface StopMapBand {
  /** `null` = not banded (airside, or a term is not a number). Never read as reachable. */
  band: MapBand | null;
  /** Why, in the words the map shows. */
  reason: string;
  /** Stay + there-and-back, when every term is stated. */
  neededMin: number | null;
  /** The certified usable minutes this was read against. */
  usableMinutes: number | null;
  /** usable − needed, when both are numbers. */
  spareMin: number | null;
}

export interface MapBandBudget {
  /** The certified landside gate's status (`landsideStatusOf`). */
  landside: LandsideStatus;
  closedBy: readonly LandsideClosure[];
  cautions: readonly LandsideCaution[];
  /** `record.envelope.usableMinutes`. */
  usableMinutes: number;
  /** The plan's clock-only fit (`certifiedPlanFit(...).clockFit`). */
  planClockFit: "fits" | "over" | "unknown";
}

export interface MapBandStop {
  insideAirport?: boolean | null;
  travelMin?: number | null;
  durationMin?: number | null;
  /** The envelope's geometric band for this stop, when it was banded. */
  envelope?: { band?: string | null; reason?: string | null } | null;
}

const CLOSURE_WORDS: Partial<Record<LandsideClosure, string>> = {
  traveller_staying_airside: "you said you are staying airside",
  insufficient_time: "there is not enough time to leave and come back",
  entry_refused: "entry to this country is refused for your passport",
  entry_unconfirmed: "entry to this country is not confirmed for your passport",
  baggage_unknown: "whether your bag is tagged through decides it",
  airport_change: "your next flight leaves from a different airport",
  constraints_unreadable: "your bag and connection details could not be read",
  airport_change_unknown: "it is not known whether your next flight leaves from this airport",
  recheck_unknown: "it is not known whether you must check in again",
};

function positive(v: unknown): number | null {
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) && n > 0 ? n : null;
}

/** One stop's band. See the header for the rule. */
export function mapBandForStop(stop: MapBandStop, budget: MapBandBudget): StopMapBand {
  const usable = Number.isFinite(budget.usableMinutes) ? budget.usableMinutes : null;
  const none = (reason: string, neededMin: number | null = null): StopMapBand =>
    ({ band: null, reason, neededMin, usableMinutes: usable, spareMin: null });
  const banded = (band: MapBand, reason: string, neededMin: number | null): StopMapBand => ({
    band, reason, neededMin, usableMinutes: usable,
    spareMin: neededMin !== null && usable !== null ? usable - neededMin : null,
  });

  if (stop.insideAirport === true) return none("inside the terminal — there is no landside journey to fit");

  // A gate that does not say it is open, closed or cautionary is read as closed.
  if (budget.landside !== "open" && budget.landside !== "caution") {
    const why = budget.closedBy.map((c) => CLOSURE_WORDS[c]).filter(Boolean);
    return banded("BLOCKED", `Your layover does not allow leaving the airport right now${why.length ? ` — ${why.join("; ")}` : ""}.`, null);
  }
  if (stop.envelope?.band === "BLOCKED") {
    return banded("BLOCKED", stop.envelope.reason ?? "Outside your certified safe envelope.", null);
  }

  const travel = positive(stop.travelMin);
  const dwell = positive(stop.durationMin);
  if (usable === null) return none("your usable time could not be certified, so this stop is not banded");
  if (travel === null || dwell === null) {
    return none("this stop's travel time or length is not stated, so it is not banded");
  }
  const needed = dwell + 2 * travel;
  if (needed > usable) {
    return banded("BLOCKED", `About ${needed} min for the stay and the trip there and back — more than your ${usable} usable minutes.`, needed);
  }
  if (budget.landside === "caution") {
    const why = budget.cautions.includes("entry_unconfirmed")
      ? "entry to this country is not confirmed for your passport"
      : "your window is tight";
    return banded("TIGHT", `It fits the clock, but ${why}, so it is not marked safe.`, needed);
  }
  if (budget.planClockFit === "over") {
    return banded("TIGHT", "This stop fits on its own, but your whole plan runs past your window.", needed);
  }
  const spare = usable - needed;
  if (spare < MAP_BAND_TIGHT_MARGIN_MIN) {
    return banded("TIGHT", `Only ${spare} min to spare after the stay and the trip there and back.`, needed);
  }
  return banded("SAFE", `Fits with ${spare} min to spare, using the travel time you entered — not a measured route.`, needed);
}

/** Attach `mapBand` to every stop, or return the stops untouched when the flag is off. */
export function withMapBands<S extends MapBandStop>(stops: readonly S[], budget: MapBandBudget, enabled: boolean): Array<S & { mapBand?: StopMapBand }> {
  if (!enabled) return stops as Array<S & { mapBand?: StopMapBand }>;
  return stops.map((s) => ({ ...s, mapBand: mapBandForStop(s, budget) }));
}
