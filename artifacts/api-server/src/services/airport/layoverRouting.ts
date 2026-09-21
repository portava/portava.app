/**
 * layoverRouting — spec §8.1, the half of route robustness that does not need a
 * routed provider: **the ride back is not the ride out**.
 *
 * ── THE ROW THIS IS ABOUT ────────────────────────────────────────────────────
 * census-layover L72 reads *"Return traffic forecast → use future-time
 * estimate, not outbound time"* — NOT-BUILT. Its evidence has been rewritten
 * twice without the finding changing: §18.7 restated it as *"the return is not
 * modelled as outbound × 2; it is not modelled at all"*. L60 asks the same
 * thing of reachability — the journey back happens LATER, under the conditions
 * of that later hour — and until this file nothing under `services/airport/`
 * read the return hour for any purpose except night caution.
 *
 * ── WHY THIS IS NOT A NEW BAND TABLE ────────────────────────────────────────
 * The repository already states future-time transport assumptions.
 * `domain/trips/services/TripDepartureAssumptions.ts` (Trips §14.2, census-trips
 * TR267) publishes PEAK / SHOULDER / OFF_PEAK / NIGHT over the LOCAL departure
 * hour with a factor ≥ 1, a source class and a confidence, and it says in its
 * own header what it is for: *"a drive at 08:00 on a Tuesday takes longer than
 * the same drive at 03:00"*. It was built for one surface and never asked by
 * this one. Every number below is ASKED of that table — `DEPARTURE_FACTORS` and
 * `departureBand` are imported, never re-spelled — so the two surfaces cannot
 * come to disagree about the same hour.
 *
 * ── WHAT IS BEING MULTIPLIED, AND WHY IT IS NOT A FABRICATED LEG ────────────
 * `airport_profiles.traffic_extra_min` is an existing, stated, per-airport term
 * in the buffer: the minutes the ground journey to and from the airport is
 * allowed to cost beyond the flat security/boarding allowance. It has always
 * been charged as a CONSTANT, identical at 03:00 and at 18:00. This file turns
 * it into a forecast taken at the certified return instant.
 *
 * The multiplier applies to that stated term and to nothing else, which is the
 * line between a forecast and an invention:
 *
 *   - an airport whose row says 0 gets 0 at every hour. A traveller with no
 *     stated ground-transport term does not acquire one because it is 18:00.
 *   - the factor is never below 1 (`TripDepartureAssumptions` pins that: *"an
 *     assumption that SHORTENS a lower bound is a contradiction in terms"*), so
 *     this can only ever make a deadline earlier. It fails closed by shape.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * It is a STATIC BAND TABLE, not a traffic feed. There is no traffic source and
 * no transit feed anywhere on this tree — `TravelTimeProvider` measures the
 * absence — so the estimate this produces is `STATIC_DEFAULT` / `LOW` at
 * fallback level 3 and says so in its own provenance. It does not make the
 * return leg MEASURED; census L60's *routed* half and L62's reliability,
 * alternatives, weather and re-entry terms all still wait on a provider this
 * deployment does not have.
 *
 * ── THE RAMP LIVES IN THE CALLER, DELIBERATELY ──────────────────────────────
 * `rawReturnTransportExtraMinutes` is a STEP function of the local hour, and a
 * step function must never reach a deadline unramped: `hardReturn = cutoff −
 * buffer(cutoff)` would move BACKWARDS as the flight moves later, which is the
 * §6.1 L53 defect `9c26efba` closed for `timeOfDayBand`. The ramp is applied in
 * `LayoverSafetyEngine.computeBuffer`, over the SUM of this term and the
 * time-of-day term, because two individually 1-Lipschitz terms do not add to a
 * 1-Lipschitz one. `MAX_RETURN_TRANSPORT_FACTOR` is exported so that caller can
 * size its look-ahead window from the table rather than from a literal.
 */
import {
  DEPARTURE_FACTORS,
  departureBand,
  assumeDeparture,
  type DepartureBand,
} from "../../domain/trips/services/TripDepartureAssumptions.js";
import type { TravelMode } from "../../domain/trips/contracts/TravelTimeProvider.js";

/**
 * The mode the return leg is forecast under.
 *
 * `unknown` is the honest answer — nobody has said how the traveller will come
 * back — and `TripDepartureAssumptions` already states what that means: *"the
 * fastest-mode bound is a drive for any hop over ~250 m, so the drive table
 * applies"*. Naming the constant here keeps the choice visible instead of
 * leaving a reader to infer it from a table lookup.
 */
export const RETURN_TRANSPORT_MODE: TravelMode = "unknown";

/**
 * Which of the assumption model's tables a mode selects.
 *
 * A function rather than a ternary over the constant: TypeScript narrows a
 * `const` to its initializer's literal type, so comparing `RETURN_TRANSPORT_MODE`
 * to `"walk"` in an expression is a compile error rather than a branch. Taking
 * the mode as a parameter keeps the mapping total, which is what makes changing
 * `RETURN_TRANSPORT_MODE` a one-line change.
 */
function tableForMode(m: TravelMode): "drive" | "transit" | "walk" {
  return m === "walk" ? "walk" : m === "transit" ? "transit" : "drive";
}

/** Which of the assumption model's tables `RETURN_TRANSPORT_MODE` selects. */
export const RETURN_TABLE: "drive" | "transit" | "walk" = tableForMode(RETURN_TRANSPORT_MODE);

/**
 * The largest factor the return table can produce. Derived from the table so a
 * change there cannot leave the caller's ramp window too small — which would
 * silently break the L53 monotonicity proof rather than fail loudly.
 */
export const MAX_RETURN_TRANSPORT_FACTOR: number = Math.max(
  ...Object.values(DEPARTURE_FACTORS[RETURN_TABLE]),
);

/** The assumption model's factor for a local hour. ≥ 1 by that table's own rule. */
export function returnTransportFactor(hour: number, weekend: boolean): number {
  return DEPARTURE_FACTORS[RETURN_TABLE][departureBand(hour, weekend)];
}

/**
 * `base × (factor − 1)`, rounded up, in INTEGER arithmetic.
 *
 * THE OBVIOUS SPELLING IS WRONG AND IT WAS MEASURED WRONG BEFORE IT WAS FIXED.
 * `Math.ceil(20 * (1.3 - 1))` is 7, not 6: `1.3 - 1` is 0.30000000000000004 in
 * IEEE-754 and the product lands a hair above 6. Every airport with a
 * `traffic_extra_min` divisible by 10 was charged a whole extra minute of a
 * traveller's window by a rounding artifact, and the §21.1 scenario matrix was
 * the thing that reported it — 7 where 6 was arithmetic.
 *
 * The factors are one-decimal constants and `traffic_extra_min` is an INTEGER
 * column, so scaling the factor to whole percent makes `base × pct` exact and
 * leaves the only rounding in the division, which is where it belongs.
 *
 * `ceil` rather than `round`, deliberately: the rounding of a safety allowance
 * goes against the traveller, which is the direction every other rounding in
 * this surface fails.
 */
function extraFor(base: number, factor: number): number {
  const pct = Math.round((factor - 1) * 100);
  if (pct <= 0) return 0;
  return Math.max(0, Math.ceil((base * pct) / 100));
}

/**
 * The extra ground-transport minutes the return leg is forecast to need over
 * the airport's own flat term, as a RAW STEP function of the local hour.
 *
 * Do not feed this to a deadline directly — see the header.
 */
export function rawReturnTransportExtraMinutes(
  trafficExtraMin: number,
  hour: number,
  weekend: boolean,
): number {
  const base = Number.isFinite(trafficExtraMin) && trafficExtraMin > 0 ? trafficExtraMin : 0;
  if (base === 0) return 0;
  return extraFor(base, returnTransportFactor(hour, weekend));
}

/** The largest extra this airport's term can produce, over every band. */
export function maxReturnTransportExtraMinutes(trafficExtraMin: number): number {
  const base = Number.isFinite(trafficExtraMin) && trafficExtraMin > 0 ? trafficExtraMin : 0;
  return extraFor(base, MAX_RETURN_TRANSPORT_FACTOR);
}

/**
 * The forecast as a stated thing, with the provenance §6.2 asks for.
 *
 * Produced by `assumeDeparture` — the same call the Trips surface makes — so
 * the band, the weekend rule, the timezone fallback and the wording are that
 * model's and not a second reading of the clock. The one thing added here is
 * `extraMinutes`, which is the factor applied to the AIRPORT'S term.
 */
export interface ReturnTransportForecast {
  /** The instant the return leg is forecast FOR. */
  forecastForMs: number;
  band: DepartureBand;
  localHour: number;
  weekend: boolean;
  /** The zone the hour was taken in. `"UTC"` when the airport declared none. */
  timezone: string;
  /** TRUE when no usable zone was supplied and UTC stood in — a guess about a guess. */
  timezoneAssumed: boolean;
  mode: TravelMode;
  /** ≥ 1 always. */
  factor: number;
  /** The airport's own stated term this was applied to. */
  baseMinutes: number;
  /** The RAW extra at this instant. The buffer charges a ramped value ≥ this. */
  extraMinutes: number;
  sourceClass: "STATIC_DEFAULT";
  confidence: "LOW";
  sourceRefs: string[];
  detail: string;
}

const SOURCE_REF = "services/airport/layoverRouting.ts#returnTransportForecast";

export function returnTransportForecast(
  trafficExtraMin: number,
  at: Date,
  timezone: string | null | undefined,
): ReturnTransportForecast {
  const a = assumeDeparture(at, timezone, RETURN_TRANSPORT_MODE);
  const base = Number.isFinite(trafficExtraMin) && trafficExtraMin > 0 ? trafficExtraMin : 0;
  const extraMinutes = rawReturnTransportExtraMinutes(base, a.localHour, a.weekend);
  const forecastForMs = at instanceof Date && Number.isFinite(at.getTime()) ? at.getTime() : Number.NaN;
  return {
    forecastForMs,
    band: a.band,
    localHour: a.localHour,
    weekend: a.weekend,
    timezone: a.timezone,
    timezoneAssumed: a.timezoneAssumed,
    mode: a.mode,
    factor: a.factor,
    baseMinutes: base,
    extraMinutes,
    sourceClass: "STATIC_DEFAULT",
    confidence: "LOW",
    sourceRefs: [SOURCE_REF, ...a.sourceRefs],
    // The assumption model's own sentence, plus what it was applied to. Its
    // wording already names the band, the hour, the zone and whether the zone
    // was assumed, so restating any of that here would be a second copy to rot.
    detail: `return leg forecast at the certified return instant — ${a.detail}; ` +
      `applied to the airport's ${base} min ground-transport term → +${extraMinutes} min`,
  };
}
