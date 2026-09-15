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
 * ── WHICH ID THE PLAN IS KEYED ON, AND WHERE THERE IS NO ID AT ALL ──────────
 * `layover_plan_stops.place_id` is a `discovery_places.id`. Discovery does not
 * serve that id everywhere: `GET /discovery/community` serves the bare uuid,
 * `GET /discovery` and `GET /discovery/feed` serve `db/<uuid>` for a curated
 * row and `<type>/<id>` (`node/4242`) for a LIVE OSM element. `layoverSubjectId`
 * maps a served id back, through `lib/placeIdBridge.ts`'s own classifier rather
 * than a second prefix-stripper — the bridge is where that id space is already
 * spelled out and census L6 forbids the copy.
 *
 * An OSM element maps to NOTHING, and that is not a lookup miss: the element has
 * never entered `discovery_places`, so no stop can name it, so no traveller can
 * ever have stated how long it takes. `no_layover_subject` says exactly that,
 * and it is a DIFFERENT fact from "you have a plan and this place is not in it".
 *
 * ── AND WHY EVERY ABSENCE CARRIES ITS OWN REASON ────────────────────────────
 * A term with no figure used to come back as the bare word `unmeasured`, which
 * collapsed at least four different situations into one string:
 *
 *   no routed provider is configured        the PORT has nothing to say, for
 *                                           every place on this deployment
 *   the traveller has no stop for this      the plan was READ; this place is
 *     place                                 not in it
 *   the stop's landside travel is the       the column is NOT NULL DEFAULT 0,
 *     column's NOT-NULL zero                so the row cannot hold "nobody said"
 *   the id has no layover subject           an OSM element; not a miss, an
 *                                           impossibility
 *
 * (The fifth — the plan-stops READ failed — is not an absence at all and never
 * reaches this shape: it returns the refusal arm below.)
 *
 * They are trivially confusable because all four produce the same missing
 * number, which is the same masquerade, one level down, that the three states
 * in `discoveryLayoverMode.ts` are kept apart for. So each term carries its own
 * `absence`, and travel additionally carries the PORT's own word verbatim —
 * because "the port had nothing AND you have no stop" is two facts and a single
 * slot can only hold one of them.
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

import { parseServedPlaceId } from "./placeIdBridge.js";
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

/**
 * WHY a term has no figure. One value per situation, and no shared "unknown":
 * two different absences that read alike are the defect this type exists for.
 */
export type TermAbsence =
  /**
   * The served id has no layover subject and never can — a live OSM element,
   * which has never entered `discovery_places`, so no stop can name it.
   */
  | "no_layover_subject"
  /** The plan was READ, successfully, and holds no stop for this place. */
  | "no_plan_stop"
  /**
   * A stop exists and its landside `travel_min` is the column's NOT-NULL zero.
   * `INTEGER NOT NULL DEFAULT 0` cannot hold "nobody said", so outside the
   * terminal that zero is the LACK of a journey time, not a journey of none.
   */
  | "stop_travel_unstated"
  /**
   * A stop exists and its `duration_min` is not a figure a traveller chose
   * (the column's own CHECK is BETWEEN 5 AND 720).
   */
  | "stop_duration_unstated";

/** One term — a figure and where it came from, or an absence and which one. */
export interface StatedTerm {
  /** The minutes, or `null`. Never a substituted number. */
  value: number | null;
  /** Where the figure came from. `null` exactly when `value` is null. */
  source: StatedTimingSource;
  /** Which absence this is. `null` exactly when `value` is a figure. */
  absence: TermAbsence | null;
  /**
   * The travel-time PORT's own reason, verbatim, when the port was asked and
   * had nothing — `NO_ROUTED_PROVIDER` on this deployment. It rides BESIDE
   * `absence` rather than inside it because "the port has no routed provider"
   * and "you have no stop here" are two true facts about the same missing
   * number, and one slot can only hold one of them. Always `null` on the
   * activity term, which the port has no opinion about.
   */
  portReason: string | null;
}

/** One candidate's two terms, each with the provenance of the term beside it. */
export interface StatedCandidateTiming {
  travelTimeMin: number | null;
  travelSource: StatedTimingSource;
  activityTimeMin: number | null;
  activitySource: StatedTimingSource;
  /**
   * The same two terms as the four fields above, with the ABSENCE reason the
   * flat pair cannot carry. Not a second computation: the four flat fields are
   * READ OFF these two records below, which is what stops the two views ever
   * disagreeing. The flat pair is kept because it is the vocabulary
   * `certifiedActionUniverse` reads.
   */
  travel: StatedTerm;
  activity: StatedTerm;
  /**
   * TRUE only when the traveller's own stop says this stop is inside the
   * terminal — in which case a zero landside leg is a FACT rather than an
   * absence, which is the one place the two can be told apart.
   */
  insideAirport: boolean;
}

/**
 * The id `layover_plan_stops.place_id` would carry for a served Discovery id,
 * or `null` when no such subject can exist.
 *
 *   `db/<uuid>`      a curated row — the uuid IS the subject.
 *   `node/4242`      a live OSM element. NO subject, and never one: it has
 *                    never entered `discovery_places`, so no stop can name it.
 *   anything else    served as-is (`GET /discovery/community` emits the bare
 *                    `discovery_places.id`), so it is its own subject.
 */
export function layoverSubjectId(servedId: string): string | null {
  const parsed = parseServedPlaceId(servedId);
  if (parsed.kind === "db") return parsed.uuid;
  if (parsed.kind === "osm") return null;
  return servedId;
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
    // A stop with no `place_id` names no place, so it can time no place.
    //
    // (This read `placeId === ""` rather than the natural `placeId.length === 0`
    // because a source guard in discoveryLayoverMode.test.ts asserted this
    // module contained NO DIGIT AT ALL. That guard is gone — it was a property
    // of the text standing in for a property of the behaviour, and it passed
    // for a fabricated value imported from another file. What replaced it
    // asserts the behaviour: "a missing input must NOT acquire a value" in that
    // same suite. The spelling is free again.)
    if (typeof placeId !== "string" || placeId.length === 0) continue;
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

  // The subject each served id maps to, resolved ONCE. `null` is not a lookup
  // miss — see the header: an OSM element can never have a stop.
  const subjects = candidates.map((c) => layoverSubjectId(c.id));

  // ONE port call per candidate, exactly as `fetchDiscoveryPlaces` does. It
  // cannot throw into this function — `estimateTravel` turns a rejecting
  // provider into `PROVIDER_UNAVAILABLE`, which is an absence and not an error.
  const legs = await Promise.all(
    candidates.map((c, i) => {
      const subject = subjects[i];
      const stop = subject !== null ? stops.get(subject) : undefined;
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
    const subject = subjects[i];
    const stop = subject !== null ? stops.get(subject) : undefined;
    const leg = legs[i];
    const insideAirport = stop?.insideAirport === true;

    // The one absence that belongs to the ID rather than to either term: an
    // OSM element has no subject, so BOTH terms are absent for that reason and
    // neither "you have no stop" nor "the stop said nothing" is true of it.
    const noSubject = subject === null;

    // A ROUTED answer supersedes a self-report; a self-report supersedes
    // nothing. Inside the terminal `statedTravelMin` has already answered 0,
    // and that 0 is a fact about the geometry rather than an estimate.
    const portMinutes = leg && leg.minutes !== null ? leg.minutes : null;
    const portReason = leg && leg.minutes === null ? (leg.reason ?? null) : null;
    const travelValue = portMinutes !== null ? portMinutes : (stop ? stop.travelMin : null);
    const travel: StatedTerm = {
      value: travelValue,
      source: portMinutes !== null
        ? "routed_port"
        : travelValue !== null ? "traveller_plan_stop" : "unmeasured",
      // Each arm names the situation it IS, and only that one. Precedence runs
      // outward: no subject at all, then no stop, then a stop that stated
      // nothing — the port's own word rides alongside in `portReason` so the
      // "no routed provider" fact is never displaced by one of the others.
      absence: travelValue !== null
        ? null
        : noSubject ? "no_layover_subject"
        : !stop ? "no_plan_stop"
        : "stop_travel_unstated",
      portReason,
    };

    const activityValue = stop ? stop.durationMin : null;
    const activity: StatedTerm = {
      value: activityValue,
      source: activityValue !== null ? "traveller_plan_stop" : "unmeasured",
      absence: activityValue !== null
        ? null
        : noSubject ? "no_layover_subject"
        : !stop ? "no_plan_stop"
        : "stop_duration_unstated",
      // The port measures journeys, not dwell. It was never asked about this
      // term, and a reason copied over from the other one would be a borrowed
      // explanation for a different absence.
      portReason: null,
    };

    // ONE shape for every candidate. There is deliberately no second branch for
    // "nothing was stated": the records above already carry the absence AND why,
    // and a branch that skips them is a branch a fabricated default can hide
    // behind — which is exactly what a mutation of this file proved on
    // 2026-09-15. The four flat fields are READ OFF the two records, never
    // recomputed, so the two views cannot drift.
    byId.set(c.id, {
      travelTimeMin: travel.value,
      travelSource: travel.source,
      activityTimeMin: activity.value,
      activitySource: activity.source,
      travel,
      activity,
      insideAirport,
    });
  });

  return { ok: true, byId };
}
