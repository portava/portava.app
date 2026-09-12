/**
 * Trips §14.2 — "Route chains carry expected departure/arrival, FUTURE-TIME
 * TRAFFIC/TRANSIT ASSUMPTIONS, cost, party size, reliability, and fallback
 * route references." This module is the assumptions term. census-trips TR267.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * ================================
 * There is no traffic source and no transit feed anywhere on this tree
 * (TravelTimeProvider.ts measures the absence). What CAN be stated honestly
 * is the shape of the assumption a planner makes when it has no data: a drive
 * at 08:00 on a Tuesday takes longer than the same drive at 03:00; a transit
 * hop at 03:00 may not have a service at all. This file states those
 * assumptions ONCE, as a static band table, labelled STATIC_DEFAULT / LOW,
 * and carries them beside the travel bound — never inside it.
 *
 * THE BOUND IS UNTOUCHED
 * ======================
 * TripFeasibilityEngine's soundness claim is that a straight-line INFEASIBLE
 * is a real verdict because the travel term is a lower bound no route can
 * beat. Multiplying that term by 1.6 would make every INFEASIBLE at peak a
 * guess. So `withDepartureAssumptions` returns the inner provider's estimate
 * UNCHANGED and adds `assumption` + `expectedMinutes` beside it. Conflicts,
 * windows and feasibility keep reading the bound; an "expected arrival" reads
 * the assumption, and says so.
 *
 * A ROUTED PROVIDER HAS NOTHING TO ASSUME
 * =======================================
 * A routed provider was given `departAt` and answered for that departure;
 * layering a static band over a live route would double-count. The wrapper
 * passes a routed inner through with `assumption: null`.
 */
import { localHour, localDayString, isValidTimezone } from "../../../services/airport/AirportTime.js";
import type {
  TravelAssumption,
  TravelMode,
  TravelTimeProvider,
  TravelTimeQuery,
  TravelTimeResult,
} from "../contracts/TravelTimeProvider.js";

export const DEPARTURE_BANDS = ["PEAK", "SHOULDER", "OFF_PEAK", "NIGHT"] as const;
export type DepartureBand = (typeof DEPARTURE_BANDS)[number];

export interface DepartureAssumption extends TravelAssumption {
  band: DepartureBand;
}

export const DEPARTURE_ASSUMPTIONS_MODEL = "TripDepartureAssumptions/static-bands";
const SOURCE_REF = "domain/trips/services/TripDepartureAssumptions.ts#assumeDeparture";

/**
 * Multipliers over the free-flow bound, by mode and band. Every entry is ≥ 1,
 * pinned by src/test/tripDepartureAssumptions.test.ts, because an assumption
 * that SHORTENS a lower bound is a contradiction in terms.
 *
 *   drive    peak traffic; night is free-flow, which is what the bound already is
 *   transit  peak is frequent but crowded; off-peak headways stretch; at night
 *            many networks stop, so the factor is large AND the service is
 *            flagged unlikely
 *   walk     walking does not queue; the night question is a safety one, not
 *            a time one, and belongs to the priority switch (§17.2)
 *   unknown  the fastest-mode bound is a drive for any hop over ~250 m
 *            (TravelTimeProvider header), so the drive table applies
 */
export const DEPARTURE_FACTORS: Readonly<Record<"drive" | "transit" | "walk", Readonly<Record<DepartureBand, number>>>> = {
  drive:   { PEAK: 1.6, SHOULDER: 1.3, OFF_PEAK: 1.1, NIGHT: 1.0 },
  transit: { PEAK: 1.2, SHOULDER: 1.3, OFF_PEAK: 1.5, NIGHT: 2.0 },
  walk:    { PEAK: 1.0, SHOULDER: 1.0, OFF_PEAK: 1.0, NIGHT: 1.0 },
};

/** The band for a LOCAL hour. Weekday peaks are the commute; weekends have none. */
export function departureBand(hour: number, weekend: boolean): DepartureBand {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (weekend) {
    if (h >= 23 || h < 7) return "NIGHT";
    if (h >= 11 && h < 19) return "SHOULDER";
    return "OFF_PEAK";
  }
  if (h >= 23 || h < 6) return "NIGHT";
  if ((h >= 7 && h < 9) || (h >= 16 && h < 19)) return "PEAK";
  if (h === 6 || h === 9 || h === 15 || (h >= 19 && h < 21)) return "SHOULDER";
  return "OFF_PEAK";
}

function tableFor(mode: TravelMode): "drive" | "transit" | "walk" {
  return mode === "walk" ? "walk" : mode === "transit" ? "transit" : "drive";
}

/**
 * State the assumption for one departure. Pure: the same instant, zone and
 * mode always give the same band, factor and wording.
 */
export function assumeDeparture(
  departAt: Date,
  timezone: string | null | undefined,
  mode: TravelMode | undefined,
): DepartureAssumption {
  const tzKnown = typeof timezone === "string" && timezone.length > 0 && isValidTimezone(timezone);
  const tz = tzKnown ? (timezone as string) : "UTC";
  const valid = departAt instanceof Date && Number.isFinite(departAt.getTime());
  const hour = valid ? localHour(tz, departAt) : 12;
  const day = valid ? localDayString(tz, departAt) : null;
  const dow = day ? new Date(`${day}T00:00:00Z`).getUTCDay() : 3;
  const weekend = dow === 0 || dow === 6;
  const m: TravelMode = mode && mode !== "unknown" ? mode : "unknown";
  const band = departureBand(hour, weekend);
  const factor = DEPARTURE_FACTORS[tableFor(m)][band];
  const transitServiceLikely = !(m === "transit" && band === "NIGHT");
  const detail = [
    `${band.toLowerCase().replace("_", "-")} departure at ${String(hour).padStart(2, "0")}:00 ${tz}${weekend ? " (weekend)" : ""}`,
    m === "unknown" ? "mode not stated: the drive table applies over the fastest-mode bound" : `mode ${m}`,
    `factor ×${factor.toFixed(2)} over the free-flow bound`,
    tzKnown ? null : "the trip declared no timezone; UTC stood in",
    transitServiceLikely ? null : "transit at night: a service may not run at all",
    "a static assumption, not a measurement",
  ].filter((x): x is string => x !== null).join("; ");
  return {
    band, localHour: hour, weekend, timezone: tz, timezoneAssumed: !tzKnown, mode: m, factor,
    transitServiceLikely, sourceClass: "STATIC_DEFAULT", confidence: "LOW", sourceRefs: [SOURCE_REF], detail,
  };
}

export interface AssumingTravelTimeProvider extends TravelTimeProvider {
  /** Which assumption model rides on this provider's answers. */
  readonly assumptionsModel: string;
}

/**
 * Wrap a provider so every estimate carries the departure assumption beside
 * the bound. The inner's `id`, `routed` and `estimate` are reported unchanged:
 * the number is still the inner's number, and a consumer that pins
 * `provider.id === "straight-line"` is told the truth.
 */
export function withDepartureAssumptions(inner: TravelTimeProvider, timezone: string | null | undefined): AssumingTravelTimeProvider {
  return {
    id: inner.id,
    routed: inner.routed,
    assumptionsModel: DEPARTURE_ASSUMPTIONS_MODEL,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      const r = await inner.estimate(q);
      if (!r || r.kind !== "estimate") return r;
      if (inner.routed) return { ...r, assumption: null, expectedMinutes: r.estimate.minutes };
      const assumption = assumeDeparture(q.departAt, timezone, q.mode);
      return { ...r, assumption, expectedMinutes: Math.max(r.estimate.minutes, Math.ceil(r.estimate.minutes * assumption.factor)) };
    },
  };
}
