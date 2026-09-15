/**
 * discoveryLayoverTiming — where Discovery's Layover mode gets the two time
 * terms the certified action universe needs, and where it refuses to invent
 * them.
 *
 * census-discovery A14 / census-layover §25 L269: *"Discovery — only show
 * experiences from the certified action universe in Layover mode."*
 *
 * ── THE PROBLEM THIS FILE IS THE ANSWER TO ──────────────────────────────────
 * `certifiedActionUniverse(snapshot, candidates)` reads two fields off every
 * candidate — `travelTimeMin` and `activityTimeMin` — and admits nothing
 * without both. `discovery_places` carries NEITHER. It has `city`, `name`,
 * `place_type`, `category`, a blurb, an image, a rating, ages, and (since
 * migration 0060) `lat`/`lng`. There is no duration column and no travel
 * column, on that table or on any other place table in this tree:
 * `places` (2028), `place_days` (2063), `place_living_cache` (2047) and
 * `hidden_gems` (0043) were all read and none carries a typical visit length.
 *
 * So a naive wiring hands the contract two nulls and gets `admittedIds: []`
 * with every candidate `UNMEASURED` — an empty Layover Discovery that can never
 * be anything else. The temptation at that point is a category average, and
 * THAT IS THE DEFECT THIS ROW EXISTS TO CLOSE. The Layover lane already deleted
 * exactly that number from exactly these rows:
 *
 *   LayoverRecommendationService.fetchDiscoveryPlaces
 *     "`discovery_places` HAS NO DURATION COLUMN. `estimateActivityTime` stood
 *      here and answered 30 / 90 / 60 by category — a semantic substitute for a
 *      field the table does not carry, which is App C1's exact prohibition.
 *      Deleted with no replacement: nobody has said how long this takes."
 *
 * Re-deriving it one module over, under a new name, would be the same
 * fabrication with a longer commit message.
 *
 * ── SO WHAT IS LEFT, AND IT IS NOT NOTHING ──────────────────────────────────
 * Two REAL producers exist on this tree, and this file asks both.
 *
 * 1. TRAVEL — the travel-time PORT, `services/airport/LayoverTravelTime.ts`'s
 *    `landsideLeg`. It is the module the Layover lane already asks for exactly
 *    these places, and it fails closed in every direction: no coordinates, no
 *    routed provider, a provider that throws, a stale estimate, an answer it
 *    cannot read — each a DISTINCT reason and each producing an absence rather
 *    than a number. On this deployment `LAYOVER_TRAVEL_TIME_PROVIDER` is
 *    `noRoutedProvider`, so it answers `null` / `NO_ROUTED_PROVIDER` for every
 *    place. It is asked anyway, because the day a routed provider is configured
 *    this file changes by zero lines, and because a producer that never asks
 *    for the position cannot ever have an answer.
 *
 *    The straight-line adapter is deliberately NOT substituted for it. A great
 *    circle is a genuine LOWER BOUND: it can REFUSE a journey and can never
 *    certify one (`domain/trips/contracts/TravelTimeProvider.ts`), and
 *    `certifiedActionUniverse` already uses the bound for precisely the half it
 *    is good for — the §8 envelope's block. Feeding it in here as a measurement
 *    would let it admit cards, which is the asymmetry the whole port is built
 *    around.
 *
 * 2. ACTIVITY (and travel's fallback) — `layover_plan_stops`, the traveller's
 *    OWN mini-itinerary for THIS session. A stop carries `place_id`,
 *    `duration_min` and `travel_min`, and both numbers arrive from a write
 *    boundary that refuses to invent them: `stopCreateSchema.durationMin` is
 *    REQUIRED (`z.number().int().min(5).max(720)`, no `.default()`), and
 *    `landsideTravelRefusal` in `routes/airport.ts` REFUSES a landside stop
 *    that arrives without a travel time — "the stop is the traveller's own,
 *    they know roughly how far it is". The from-a-recommendation path refuses
 *    on the same two grounds. This is a stated measurement, not a substituted
 *    one; it is narrow (only places this traveller has already planned), and
 *    narrow-and-true is the trade this census keeps making.
 *
 *    The columns are `INTEGER NOT NULL DEFAULT 0 / 30`, so the row cannot hold
 *    "nobody said". `LayoverPlanFit`'s `statedTravelMin` / `statedDurationMin`
 *    are the classifiers that turn those back into `null`, and they are CALLED
 *    here rather than re-spelled — a second copy of the stated/absent rule is
 *    what census L6 forbids and what L47 cost.
 *
 * ── AND ONE THING THIS FILE MUST NEVER DO ───────────────────────────────────
 * A FAILED READ IS NOT AN ABSENT MEASUREMENT. `layover_plan_stops` failing
 * would leave every term null, every candidate `UNMEASURED`, and an item list
 * that is byte-identical to "we looked and nothing fits". That is the
 * masquerade owner ruling D11 and `11` §9 forbid, so the read's error is
 * BOUND and returned as a refusal for the caller to send. supabase-js RESOLVES
 * on a database error; an unguarded read here is a confident statement about a
 * traveller's plan that was never read.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { statedDurationMin, statedTravelMin } from "../services/airport/LayoverPlanFit.js";
import { landsideLeg, placePoint } from "../services/airport/LayoverTravelTime.js";
import type { TravelTimeProvider, GeoPoint } from "../domain/trips/contracts/TravelTimeProvider.js";

/** The table a stated duration can come from. Named so a refusal can say it. */
export const LAYOVER_TIMING_SOURCE_TABLE = "layover_plan_stops";

/** Where a figure came from, or that there is no figure. */
export type StatedTimingSource =
  /** A ROUTED provider answered the port. Has no producer on this tree today. */
  | "routed_port"
  /** The traveller's own stop in their own layover plan for this session. */
  | "traveller_plan_stop"
  /** Nobody stated it. NOT a zero, and never rendered as one. */
  | "unmeasured";

/** One candidate's two terms, each with the provenance of the term beside it. */
export interface StatedCandidateTiming {
  travelTimeMin: number | null;
  travelSource: StatedTimingSource;
  activityTimeMin: number | null;
  activitySource: StatedTimingSource;
  /**
   * TRUE only when the traveller's own stop says this stop is inside the
   * terminal — in which case a zero landside leg is a FACT rather than an
   * absence, which is the one place the two can be told apart.
   */
  insideAirport: boolean;
}

export type LayoverTimingRead =
  | { ok: true; byId: Map<string, StatedCandidateTiming> }
  | { ok: false; reason: "layover_plan_stops_unreadable"; message: string };

/** The identity and position a candidate must carry to be timed at all. */
export interface TimeableCandidate {
  id: string;
  lat?: number | null;
  lng?: number | null;
}

export interface StatedTimingOptions {
  /** The airport, from the snapshot's own envelope. `null` when it has none. */
  centre: GeoPoint | null;
  /** The instant the certified record was computed at. Not a second clock. */
  departAt: Date;
  /** Injectable for tests and for the day a routed provider is configured. */
  provider?: TravelTimeProvider;
}

/**
 * Resolve the two time terms for a page of Discovery candidates.
 *
 * Returns a REFUSAL when the plan could not be read, and a map — possibly full
 * of absences — when it could. The difference between those two answers is the
 * whole reason this returns a result type instead of a map.
 */
export async function statedLayoverTimings(
  db: SupabaseClient,
  sessionId: string,
  candidates: ReadonlyArray<TimeableCandidate>,
  opts: StatedTimingOptions,
): Promise<LayoverTimingRead> {
  // `error` is BOUND. See the header: an unreadable plan is not an unmeasured
  // one, and supabase-js resolves rather than throwing on a failed read.
  const { data, error } = await db
    .from(LAYOVER_TIMING_SOURCE_TABLE)
    .select("place_id, duration_min, travel_min, inside_airport")
    .eq("session_id", sessionId);
  if (error) {
    return {
      ok: false,
      reason: "layover_plan_stops_unreadable",
      message: String((error as { message?: string }).message ?? "layover_plan_stops unreadable"),
    };
  }

  // The traveller's own stops, keyed by the place they are a stop AT. Rows with
  // no `place_id` are a stop the traveller typed by hand; they name no place, so
  // they can time no place.
  const stops = new Map<string, { travelMin: number | null; durationMin: number | null; insideAirport: boolean }>();
  for (const row of ((data ?? []) as Array<Record<string, unknown>>)) {
    const placeId = row.place_id;
    // No digit appears anywhere in this module's code, and the source guard in
    // discoveryLayoverMode.test.ts pins that: every minute here comes off a row
    // or off the port, so a literal could only ever be a fabricated one.
    if (typeof placeId !== "string" || placeId === "") continue;
    const insideAirport = row.inside_airport === true;
    const shape = {
      travelMin: row.travel_min as number | null,
      durationMin: row.duration_min as number | null,
      insideAirport,
    };
    // `statedTravelMin` / `statedDurationMin` are the layover domain's own
    // classifiers for "is this a figure, or the column's NOT NULL default?".
    stops.set(placeId, {
      travelMin: statedTravelMin({ travelMin: shape.travelMin, insideAirport }),
      durationMin: statedDurationMin({ durationMin: shape.durationMin }),
      insideAirport,
    });
  }

  // ONE port call per candidate, exactly as `fetchDiscoveryPlaces` does. It
  // cannot throw into this function — `estimateTravel` turns a rejecting
  // provider into `PROVIDER_UNAVAILABLE`, which is an absence and not an error.
  const legs = await Promise.all(
    candidates.map((c) => {
      const stop = stops.get(c.id);
      if (stop?.insideAirport === true) return Promise.resolve(null);
      return landsideLeg(
        opts.centre,
        placePoint({ lat: c.lat ?? null, lng: c.lng ?? null }),
        opts.departAt,
        opts.provider,
      );
    }),
  );

  const byId = new Map<string, StatedCandidateTiming>();
  candidates.forEach((c, i) => {
    const stop = stops.get(c.id);
    const leg = legs[i];
    const insideAirport = stop?.insideAirport === true;

    // A ROUTED answer supersedes a self-report; a self-report supersedes
    // nothing. Inside the terminal `statedTravelMin` has already answered 0,
    // and that 0 is a fact about the geometry rather than an estimate.
    const portMinutes = leg && leg.minutes !== null ? leg.minutes : null;
    const travelTimeMin = portMinutes !== null ? portMinutes : (stop ? stop.travelMin : null);
    const travelSource: StatedTimingSource = portMinutes !== null
      ? "routed_port"
      : travelTimeMin !== null ? "traveller_plan_stop" : "unmeasured";

    const activityTimeMin = stop ? stop.durationMin : null;
    const activitySource: StatedTimingSource =
      activityTimeMin !== null ? "traveller_plan_stop" : "unmeasured";

    // ONE shape for every candidate. There is deliberately no second branch for
    // "nothing was stated": the four values above already carry the absence, and
    // a branch that skips them is a branch a fabricated default can hide behind
    // — which is exactly what a mutation of this file proved on 2026-09-15.
    byId.set(c.id, { travelTimeMin, travelSource, activityTimeMin, activitySource, insideAirport });
  });

  return { ok: true, byId };
}
