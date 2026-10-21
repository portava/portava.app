/**
 * LayoverRecommendationService
 *
 * Generates recommendation cards for a layover session by querying Discovery places,
 * inside-airport content, and nearby plans, then running each through the Safety Engine.
 * Produces layover_recommendations rows. Respects LayoverPrivacyGuard rules.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "LayoverRecommendationService" });
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import {
  rankActivities,
  travelTimeSourceFor,
  persistedTravelTimeSource,
  type SafetyRating,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";
// census L293 closes with L47's module, not a second copy of its rule: airside
// 0 is a FACT, landside 0 is an ABSENCE. `layover_recommendations.travel_time_min`
// is `INTEGER NOT NULL DEFAULT 0` exactly like `layover_plan_stops.travel_min`,
// so the read path needs the same classifier the plan path already uses.
import { statedTravelMin, statedDurationMin } from "./LayoverPlanFit.js"; import { consumerLayoverRecord } from "./LayoverSnapshot.js"; import { landsideStatusOf } from "./LayoverConstraints.js";
import { airportPoint, placePoint, landsideLeg, travelTimeProvenanceColumn, type TravelTimeProvider } from "./LayoverTravelTime.js";
// §8 — the outer edge of the safe envelope, which is the half a straight-line
// LOWER BOUND can certify. See LayoverEnvelope's header for why the inner edge
// cannot be, and why a block is the only verdict it may produce.
import { safeEnvelope, bandCandidates, type EnvelopeVerdict } from "./LayoverEnvelope.js";
import type { GeoPoint } from "../../domain/trips/contracts/TravelTimeProvider.js"; import { monitorRecommendationContract } from "./layoverContractMonitor.js"; // census L216 — one line: every anchored citation below is line-pinned
import {
  certifySessionFeasibility,
  certificationHeader,
} from "./LayoverFeasibility.js"; import { resolveLayoverEntry, layoverAirportCountry } from "./layoverEntryGate.js"; import { applyLayoverRankingMode } from "./layoverRankingMode.js";
import { sanitizeRecommendation, type SafeRecommendation } from "./LayoverPrivacyGuard.js"; import { recommendationSnapshotStamp } from "../layover/LayoverDecisionStore.js"; // census L64 (3623)
// §13 L117/L122 — the feasibility state a candidate PIN carries. Attached after
// the privacy sanitiser and deliberately coordinate-free; see that module.
import {
  candidateFeasibilityFrom,
  unbandedCandidateFeasibility,
  AIRSIDE_UNBANDED_REASON,
  NO_POSITION_UNBANDED_REASON,
  STORED_UNBANDED_REASON,
  type CandidateFeasibility,
} from "./layoverRankingFeasibility.js";
import { localHour } from "./AirportTime.js"; import { layoverExperienceFor, type LayoverExperience } from "./layoverExperiencePrimitive.js"; // census L75 — one line: every anchored citation below is line-pinned
// Sensing §11 — intersect feasibility with live Experience value, forecast,
// friction and safe-return (census-sensing S85). Behind
// `layover_live_intersection_enabled` (2851, seeded FALSE) and, behind THAT,
// the Live gates in lib/liveClaimRead: with either closed this reads nothing
// and every card is generated exactly as it was before.
import { isFlagEnabled } from "../../lib/featureFlags.js"; import { landsideMaturityDecision } from "./layoverMaturityGate.js"; // §22 L249 — one line, because every anchored citation below is line-pinned
import { liveLabelsServable, readLiveClaimEnvelopes, liveClaimReadFailed, type LiveClaimEnvelope } from "../../lib/liveClaimRead.js";
import {
  compareByLive,
  intentFromVibeChips,
  intersectLayoverLive,
  type LayoverLiveCandidate,
  type LayoverLiveVerdict,
} from "../../lib/layoverLiveIntersection.js";

/** Literal name so check-flag-polarity resolves the read. `*_enabled` ⇒ capability, fail-closed. */
export const LAYOVER_LIVE_INTERSECTION_FLAG = "layover_live_intersection_enabled";

/** The claim families the intersection consumes. Nothing else is read. */
const LAYOVER_LIVE_CLAIM_TYPES = ["crowd.level", "crowd.trajectory", "queue.wait", "access.walk_in"] as const;

interface LayoverLiveOutcome {
  /** True only when the flag was on AND the pass actually ran. */
  applied: boolean;
  /** False ⇒ the Live gates refused the read; nothing was adjusted. */
  readable: boolean;
  byKey: Map<string, LayoverLiveVerdict>;
  dropped: number;
  frictionAdjusted: number;
}

const LIVE_INTERSECTION_OFF: LayoverLiveOutcome = {
  applied: false, readable: false, byKey: new Map(), dropped: 0, frictionAdjusted: 0,
};

/**
 * Read the live claims for the candidates that HAVE a canonical subject, and
 * grade them. Fail-safe in both directions: a closed flag, closed gates, or any
 * error leaves every card untouched — this pass may shorten a traveller's
 * options but must never be able to empty them by failing.
 */
export async function readLayoverLive(
  db: SupabaseClient,
  session: Pick<LayoverSession, "id" | "vibeChips">,
  candidates: ReadonlyArray<{ key: string; subjectId: string | null; travelTimeMin: number | null; activityTimeMin: number | null }>,
  nowMs: number,
): Promise<LayoverRead<LayoverLiveOutcome>> {
  const flag = await readLiveIntersectionFlag(db, session.id);
  if (flag.kind === "degraded") return readDegraded(LIVE_INTERSECTION_OFF, flag.reasons);
  if (!flag.value) return readValue(LIVE_INTERSECTION_OFF);
  try {
    let readable = false; const reasons: string[] = [];
    try { readable = await liveLabelsServable(db); } catch (err) { logger.warn({ err, sessionId: session.id }, "layover live gates read failed"); }
    const now = new Date(nowMs);
    const graded: LayoverLiveCandidate[] = [];
    for (const c of candidates) {
      let envelopes: LiveClaimEnvelope[] = [];
      let rowReadable = readable && c.subjectId !== null;
      if (rowReadable && c.subjectId) {
        try {
          envelopes = await readLiveClaimEnvelopes(db as any, c.subjectId, { claimTypes: LAYOVER_LIVE_CLAIM_TYPES, now });
          if (liveClaimReadFailed(envelopes)) { rowReadable = false; reasons.push("live_claim_read_failed"); logger.warn({ sessionId: session.id, reason: "live_claim_read_failed" }, "layover live claims unavailable"); } } catch (err) { envelopes = []; rowReadable = false; reasons.push("live_claim_read_failed"); logger.warn({ err, sessionId: session.id }, "layover live claims read failed"); }
      }
      graded.push({ ...c, envelopes, readable: rowReadable });
    }
    const outcome = intersectLayoverLive(graded, { nowMs, intent: intentFromVibeChips(session.vibeChips) });
    const value: LayoverLiveOutcome = {
      applied: true, readable,
      byKey: outcome.byKey,
      dropped: outcome.dropped.length,
      frictionAdjusted: outcome.frictionAdjusted,
    }; return !readable ? readDegraded(value, ["live_gates_closed_or_unreadable"]) : reasons.length ? readDegraded(value, ["live_claim_read_failed"]) : readValue(value);
  } catch (err) {
    logger.warn({ err, sessionId: session.id }, "layover live intersection failed — cards generated without it");
    return readDegraded(LIVE_INTERSECTION_OFF, ["live_intersection_failed"]);
  }
}

/**
 * Which parts of the day does the remaining layover window cover, in the
 * airport's local time? Used to keep recommendations honest: no nightlife
 * cards for a 10:00–14:00 layover, no museum-first ordering at 23:00.
 */
export function timeOfDayContext(
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
): { coversEvening: boolean; coversDaytime: boolean } {
  const tz = airport.timezone || "UTC";
  const hourAt = (ms: number): number => {
    try {
      return localHour(tz, new Date(ms));
    } catch {
      return new Date(ms).getUTCHours();
    }
  };
  // End at the boarding cutoff when known — being "out at 23:00" is irrelevant
  // if boarding is at 22:15. Sample every 30 min for hour-precise coverage
  // (no ceil() overshoot into hours the window never touches), capped at 24h.
  const startMs = Math.max(nowMs, new Date(session.arrivalTime).getTime());
  const endMs = new Date(session.boardingTime ?? session.departureTime).getTime();
  const cappedEndMs = Math.min(endMs, startMs + 24 * 3_600_000);
  const hours = new Set<number>();
  for (let ts = startMs; ts <= cappedEndMs; ts += 30 * 60_000) hours.add(hourAt(ts));
  if (cappedEndMs >= startMs) hours.add(hourAt(cappedEndMs));
  return {
    coversEvening: [...hours].some((h) => h >= 17 || h <= 1),
    coversDaytime: [...hours].some((h) => h >= 9 && h < 18),
  };
}

export interface RecommendationRow {
  id: string;
  sessionId: string;
  recType: string;
  title: string;
  description: string | null;
  safetyRating: SafetyRating;
  /** Null when nobody measured the landside leg — see `statedTravelMin`. */
  travelTimeMin: number | null;
  /** Null when nobody stated a duration. */
  activityTimeMin: number | null;
  returnBufferMin: number;
  hardReturnTime: string | null;
  warningReason: string | null;
  insideAirport: boolean;
  locationLabel: string | null;
  city: string | null;
  neighborhood: string | null;
  sortOrder: number;
  placeId: string | null;
  planItemId: string | null;
  createdAt: string;
}

function rowToRec(row: any): RecommendationRow {
  return {
    id:             row.id,
    sessionId:      row.session_id,
    recType:        row.rec_type,
    title:          row.title,
    description:    row.description ?? null,
    safetyRating:   row.safety_rating,
    travelTimeMin:  statedTravelMin({ travelMin: row.travel_time_min, insideAirport: Boolean(row.inside_airport) }),
    activityTimeMin: statedDurationMin({ durationMin: row.activity_time_min }),
    returnBufferMin: row.return_buffer_min,
    hardReturnTime: row.hard_return_time ?? null,
    warningReason:  row.warning_reason ?? null,
    insideAirport:  Boolean(row.inside_airport),
    locationLabel:  row.location_label ?? null,
    city:           row.city ?? null,
    neighborhood:   row.neighborhood ?? null,
    sortOrder:      row.sort_order ?? 0,
    placeId:        row.place_id ?? null,
    planItemId:     row.plan_item_id ?? null,
    createdAt:      row.created_at,
  };
}

/**
 * Build inside-airport suggestions that are always safe.
 */
function insideAirportCandidates(session: LayoverSession): Array<{
  recType: string;
  title: string;
  description: string;
  travelTimeMin: number;
  travelTimeSource: TravelTimeSource;
  activityTimeMin: number;
  insideAirport: boolean;
  locationLabel: string;
}> {
  const has = (vibe: string) => session.vibeChips.includes(vibe);
  const items: Array<{ recType: string; title: string; description: string; travelTimeMin: number; travelTimeSource: TravelTimeSource; activityTimeMin: number; insideAirport: boolean; locationLabel: string }> = [];
  // Airside: zero travel by construction, so the provenance is the fact that
  // there is no landside leg — not an estimate of one.
  const travelTimeSource: TravelTimeSource = "inside_airport";

  items.push({
    recType: "inside_airport", title: "Airport Lounge / Rest Area",
    description: session.loungeAccess
      ? "Use your lounge access to relax, eat, and recharge."
      : "Find a quiet gate area or pay-per-use lounge to rest.",
    travelTimeMin: 0, travelTimeSource, activityTimeMin: 30, insideAirport: true, locationLabel: "Inside airport",
  });

  if (has("food") || session.layoverMinutes >= 90) {
    items.push({
      recType: "food", title: "Airport Dining",
      description: "Explore terminal restaurants — many airports have excellent local food options.",
      travelTimeMin: 0, travelTimeSource, activityTimeMin: 45, insideAirport: true, locationLabel: "Airport terminals",
    });
  }

  if (has("shopping")) {
    items.push({
      recType: "inside_airport", title: "Duty-Free & Airport Shops",
      description: "Browse duty-free, local souvenirs, and travel essentials.",
      travelTimeMin: 0, travelTimeSource, activityTimeMin: 30, insideAirport: true, locationLabel: "Duty-free zone",
    });
  }

  if (has("culture")) {
    items.push({
      recType: "inside_airport", title: "Airport Art & Culture",
      description: "Many international airports feature galleries, cultural exhibits, and installations.",
      travelTimeMin: 0, travelTimeSource, activityTimeMin: 20, insideAirport: true, locationLabel: "Inside airport",
    });
  }

  items.push({
    recType: "rest", title: "Rest & Sleep Pod",
    description: "Catch some sleep at a transit hotel or airport sleep pod.",
    travelTimeMin: 0, travelTimeSource, activityTimeMin: 60, insideAirport: true, locationLabel: "Airside hotel",
  });

  return items;
}

/**
 * Fetch Discovery places near the airport city and map to candidate activities.
 */
async function fetchDiscoveryPlaces(
  db: SupabaseClient,
  city: string,
  vibeChips: string[],
  /**
   * Where the traveller starts from, when the airport has a usable coordinate.
   * Passed to the travel-time port; `null` is answered NO_COORDINATES, which is
   * a different fact from NO_ROUTED_PROVIDER and is kept apart on purpose.
   */
  from: { lat: number; lng: number } | null,
  departAt: Date,
  provider?: TravelTimeProvider, limit = 8, // provider: TESTS ONLY — see GenerateRecommendationsOptions
): Promise<Array<{
  recType: string;
  title: string;
  description: string;
  travelTimeMin: number | null;
  travelTimeSource: TravelTimeSource;
  activityTimeMin: number | null;
  insideAirport: boolean;
  locationLabel: string;
  city: string;
  neighborhood: string | null;
  placeId: string | null;
  canonicalPlaceId: string | null;
  verified: boolean;
  /**
   * Where the place is, when the row carries a usable coordinate. Published
   * beside the leg because the leg is `null` on this tree and the POSITION is
   * not: it is what the §8 envelope tests, and a candidate whose position the
   * caller never saw cannot be blocked for being unreachable.
   */
  point: GeoPoint | null;
}>> {
  try {
    let query = db
      .from("discovery_places")
      // canonical_location_id is the ONLY bridge from the discovery id space to
      // the canonical places.id an intel subject is keyed on (the bridge
      // lib/coverageAssembly documents). Without it the live intersection has
      // no subject to look up and, correctly, looks nothing up.
      //
      // lat/lng joined the SELECT with census L293: the old code answered "how
      // far is it?" from `place_type` alone and never read a coordinate at all.
      // Reading them does not by itself produce a travel time — see below — but
      // a producer that never asks for the position cannot ever have one.
      .select("id, name, place_type, category, neighborhood, blurb, verified, canonical_location_id, lat, lng")
      .ilike("city", `%${city}%`)
      .eq("status", "active")
      .limit(limit);

    const { data, error } = await query;
    if (error) {
      // supabase-js RESOLVES on a DB error. Unchecked, a failed read is
      // indistinguishable from "no places in this city" (spec Appendix C2).
      logger.warn({ err: error, city }, "discovery_places read failed — landside candidates omitted");
      return [];
    }
    if (!data) return [];

    // ONE port call per place. `landsideLeg` is the whole answer to "how long
    // does it take to get there": a figure only when a ROUTED provider produced
    // one, and otherwise the absence, carrying the port's own reason. On this
    // deployment the provider is `noRoutedProvider`, so every leg comes back
    // null — which is the point of asking rather than assuming.
    const legs = await Promise.all((data as any[]).map((p) =>
      landsideLeg(from, placePoint({ lat: p.lat, lng: p.lng }), departAt, provider),
    ));

    return (data as any[]).map((p, i) => ({
      recType:        mapPlaceTypeToRecType(p.place_type ?? "activity"),
      title:          p.name,
      description:    p.blurb ?? null,
      travelTimeMin:  legs[i]!.minutes,
      travelTimeSource: legs[i]!.source,
      // `discovery_places` HAS NO DURATION COLUMN. `estimateActivityTime` stood
      // here and answered 30 / 90 / 60 by category — a semantic substitute for
      // a field the table does not carry, which is App C1's exact prohibition.
      // Deleted with no replacement: nobody has said how long this takes.
      activityTimeMin: null,
      insideAirport:  false,
      locationLabel:  p.neighborhood ? `${p.neighborhood}, ${city}` : city,
      city,
      neighborhood:   p.neighborhood ?? null,
      placeId:        p.id,
      /** The canonical subject for the live read; null when the row is unbridged. */
      canonicalPlaceId: (p.canonical_location_id as string | null) ?? null,
      verified:       Boolean(p.verified),
      // The same rule the leg is asked with — `(0, 0)` and a non-finite pair
      // are both "no coordinate", not a point in the Gulf of Guinea.
      point:          placePoint({ lat: p.lat, lng: p.lng }),
    }));
  } catch (err) {
    logger.warn({ err, city }, "discovery_places read threw — landside candidates omitted");
    return [];
  }
}

/**
 * Stable identity for a recommendation within a session, independent of the
 * generation that produced it. Persisted as `layover_recommendations.rec_key`
 * (migration 2410) so re-generation UPDATES a card in place instead of
 * deleting and re-inserting it under a new id — which is what nulled every
 * `layover_plan_stops.recommendation_id` (ON DELETE SET NULL) and left the
 * client holding ids that no longer existed.
 */
export function recommendationKey(c: {
  recType: string;
  title: string;
  insideAirport: boolean;
  placeId?: string | null;
  city?: string | null;
}): string {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
  if (c.placeId) return `place:${c.placeId}`;
  if (c.insideAirport) return `inside:${c.recType}:${slug(c.title)}`;
  return `${c.recType}:${slug(c.city ?? "")}:${slug(c.title)}`;
}

function mapPlaceTypeToRecType(placeType: string): string {
  const map: Record<string, string> = {
    restaurant: "food", cafe: "food", bar: "nightlife", pub: "nightlife",
    museum: "activity", park: "activity", shopping: "activity",
    hotel: "rest", spa: "rest", attraction: "activity",
  };
  return map[placeType] ?? "activity";
}

/*
 * DELETED WITH census-layover L293 — `estimateTravelTime(placeType)` and
 * `estimateActivityTime(placeType)`.
 *
 * The first returned 15 minutes for a cafe, restaurant or shop and 25 for
 * anything else. Its own doc comment said what it was: *"A per-category
 * CONSTANT — 15 or 25 minutes — chosen without a coordinate."* The second
 * returned 30 / 90 / 60 for a duration `discovery_places` does not store.
 * Both were semantic substitutes for facts nobody held, and `assess` turned
 * them into a `"safe"` rating and a plan-fit verdict a traveller acts on by
 * leaving an airport.
 *
 * They are not replaced. The travel leg is now asked of the travel-time PORT
 * (`LayoverTravelTime.landsideLeg`), which answers `null` on this deployment
 * because no routed provider is configured; the duration is `null` because no
 * column holds one. Carrying the provenance — which §7's pass did, tagging
 * both `category_default` — was never the fix: a label on an invented number
 * does not stop the number driving the rating.
 */

/**
 * Generate and persist recommendations for a session.
 * Returns the safe (privacy-filtered) recommendation list.
 */
export interface GenerateRecommendationsOptions {
  /**
   * When true (flag `layover_stable_recommendation_ids_enabled`, seeded FALSE), rows are
   * upserted on (session_id, rec_key) and returned WITH their ids; cards that no longer
   * apply are deleted individually. When false, the legacy delete-everything-then-insert
   * path runs unchanged and — as before — the returned cards carry no id.
   */
  stableIds?: boolean;
  travelTimeProvider?: TravelTimeProvider; /** TESTS ONLY (lane B1-R1). Production routes the pre-filtered candidates through LAYOVER_RETURN_CORRIDOR_PROVIDER (Google Routes, behind its gates). */ corridorProvider?: RouteCorridorProvider; // TESTS ONLY. Production reads places with LAYOVER_DEFERRED_LEG_PROVIDER and routes them after the pre-filter.
}

/**
 * Either the cards, or the fact that they could not be produced HONESTLY.
 *
 * `ok: false` is not "the write failed" — a failed write is non-fatal here and
 * always has been. It is "the stored MODERATION STATE could not be read", on
 * the stable-identity path where that state is what suppresses an admin-hidden
 * card. See the stale-scan below.
 */
/**
 * A sanitised card plus the §13 feasibility state its PIN carries.
 *
 * The two are separate objects rather than one widened `SafeRecommendation`
 * because `sanitizeRecommendation` is a PRIVACY boundary: everything it emits
 * has been through it, and a field bolted into its return type would be a field
 * that looks sanitised without having been. `feasibility` is assembled here,
 * from the envelope this request cut, and is coordinate-free by construction —
 * see `layoverRankingFeasibility`.
 */
export type CertifiedRecommendation = SafeRecommendation & Partial<import("../layover/LayoverRecommendationStatus.js").ServedRecommendationStatus> & {
  contract?: import("./LayoverRecommendationContract.js").LayoverRecommendationContract | null; /** §9 persisted executable contract when classification is enabled. */
  feasibility: CandidateFeasibility; /** census L75 — spec §9 ExperiencePrimitive for the card's type: TYPICAL values, never this place's, never read by the safety math. Never absent. */ experience: LayoverExperience; /** lane B1-R1 — §8 with routed terms: the two legs at their own instants, the conservative return, the robustness signals, the band, and the return contract WITH its route (L221). Null for an airside card or one nobody routed. */ routing?: RoutedCardContract | null;
};

export type GenerateResult =
  | { ok: true; recommendations: CertifiedRecommendation[]; liveDisclosure?: ReturnType<typeof readDisclosure>; /** census L296 (App C5): the snapshot every card above was certified under — `snapshotIdFor(session.id, certified.inputHash)`. An add-to-plan must name it. */ snapshotId: string; /** lane B1-R1 — §8's routed union (L66) and its isochrone (L61), cut under the same snapshot; null when nothing landside was evaluated. */ routedEnvelope?: RoutedSafeEnvelope | null }
  | { ok: false; message: string };

export async function generateRecommendations(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
  opts: GenerateRecommendationsOptions = {},
): Promise<GenerateResult> {
  const city = airport.city ?? session.manualCity ?? "Unknown"; const routePublication=await routeSubjectPublicationGate(db,opts.stableIds===true); if(!routePublication.ok){logger.warn({reason:routePublication.reason,sessionId:session.id},"route monitoring state unknown — refusing to publish recommendations");return{ok:false,message:"This plan's route monitoring could not be confirmed. Please try again."};}

  // The certified feasibility for this session at this instant. Every card
  // below is rated against THIS record's deadline — previously each candidate
  // re-derived it, and the audit event derived it a third time. One record,
  // one deadline, one audit trail.
  const certified = (await consumerLayoverRecord(db, airport, session, nowMs)) ?? certifySessionFeasibility(airport, session, { nowMs, entry: await resolveLayoverEntry(db, session.userId, layoverAirportCountry(airport)) });

  // ── §9.1 THE HARD GATE — MEASURED IN USABLE TIME, NOT SCHEDULED TIME ──────
  //
  // `session.layoverMinutes` is the SCHEDULED window: arrival to departure, a
  // number typed in at session creation that knows nothing about immigration,
  // bags, security, traffic or the clock. Gating landside candidates on it is
  // the divergence census-layover L77 names — "a gate exists but it is the
  // wrong gate" — and it is not a rounding error: an international connection
  // with a 95-minute scheduled window and a 150-minute certified buffer has
  // NEGATIVE usable time and was still being offered a city.
  //
  // AND ENTRY (census-discovery §65): the record above certifies with the same
  // corridor the snapshot and the airport routes resolve, so a REFUSED border is
  // verdict `no` and both landside gates below close on it. A data gap is not.
  //
  // ── §22 L249 — AND THE AIRPORT'S OWN DATA MATURITY ───────────────────────
  // `landsideMaturityDecision` is the first consumer `featureAllowedAt` has
  // ever had. Curated profiles enforce L1 in every flag state after 3874.
  // The upper rungs consume this record's screened official/live evidence;
  // missing, expired or conflicting evidence never advances the ladder.
  const usableMinutes = certified.envelope.usableMinutes; const retainBlocked = await recommendationStatusEnabled(db);
  const maturityRead = await landsideMaturityDecision(db, airport, nowMs, { liveConditions: certified.inputs.liveConditions }); const landside = matchRead(maturityRead, { read: (value) => value, degraded: (fallback, reasons) => { logger.warn({ airportId: airport.id, sessionId: session.id, reasons }, "recommendations use conservative maturity fallback"); return fallback; } });
  // 1. Inside-airport suggestions (always generated)
  const insideCandidates = [...insideAirportCandidates(session), ...(await curatedOvernightCandidates(db, airport, certified.envelope.overnight === true, nowMs))]; // §21.1 L223 (LAYOVER 165 B2-CURATE): an OVERNIGHT window gets the airport's published, unexpired airside lodging and lounges — none when nothing is curated
  // 2. Discovery places near airport city — filtered and ranked for the time
  //    of day the traveler will actually be out there, and gated on the
  //    airport's data maturity as well as on the traveller's usable minutes.
  const tod = timeOfDayContext(airport, session, nowMs);
  let discoveryCandidates = session.wantsToLeave && usableMinutes >= 90 && landside.allowed && certified.verdict !== "no" && landsideStatusOf(certified) !== "closed"
    ? await withLayoverRoutesBudget(session, () => fetchDiscoveryPlaces(db, city, session.vibeChips, airportPoint(airport), new Date(nowMs), opts.travelTimeProvider ?? LAYOVER_DEFERRED_LEG_PROVIDER)) // L260: read WITHOUT routing; the survivors of the cheap filters are routed below
    : [];
  if (!tod.coversEvening) {
    // Daytime-only window: nightlife cards would be dishonest.
    discoveryCandidates = discoveryCandidates.filter((c) => c.recType !== "nightlife");
  }
  discoveryCandidates = [...discoveryCandidates].sort((a, b) => {
    const rank = (c: typeof a) =>
      (c.verified ? 0 : 2) + // verified places lead
      (tod.coversEvening && c.recType === "nightlife" ? -1 : 0) + // nightlife shines in the evening
      (!tod.coversDaytime && (c.recType === "activity" || c.recType === "culture") ? 3 : 0); // sights sink at night
    return rank(a) - rank(b);
  });

  // 3. Quick city escape for long layovers — same gate, same reason. The
  //    "half-day" wording and the 120-minute tour are claims about time the
  //    traveller actually has, so they are measured in the same units.
  const cityEscapeCandidates = session.wantsToLeave && usableMinutes >= 180 && landside.allowed && certified.verdict !== "no" && landsideStatusOf(certified) !== "closed"
    ? [{
        recType: "quick_city_escape",
        title: `Quick City Tour — ${city}`,
        description: `A short exploration of ${city}'s highlights — ideal for a ${usableMinutes >= 240 ? "half-day" : "quick"} layover.`,
        // The literal 30 that stood here was census L293's third number: a
        // journey to a whole city, costed the same from every airport on earth.
        // Deleted, not relabelled.
        travelTimeMin: null as number | null,
        travelTimeSource: "unmeasured" as const,
        // NOT deleted with it, and the difference is the whole of App C1. This
        // is not a substitute for a fact about a place: there is no place, and
        // no field was queried. It is the length of tour the card OFFERS,
        // derived from the traveller's own certified usable window — a plan
        // this product is making, stated in the same breath as it is made.
        activityTimeMin: usableMinutes >= 240 ? 120 : 60,
        insideAirport: false,
        locationLabel: city,
        city,
        neighborhood: null as null,
        placeId: null as null,
        verified: false,
      }]
    : [];

  // ── §8 / §6.1 — A CERTAINLY-UNREACHABLE PLACE IS BLOCKED, NOT RATED ───────
  //
  // census-layover L50 ("block unsafe recommendations") read NOT-BUILT with the
  // right observation: *"Every landside card is now `not_recommended`, which is
  // a RATING and not a block: the cards are still generated, still persisted
  // and still served."* A `not_recommended` card still carries an "Add to plan"
  // control and still occupies the list a traveller reads.
  //
  // A rating is all `assess` can produce, because it has no measured leg to
  // refuse on. The envelope does: a great-circle distance is a LOWER BOUND on
  // travel time, so a place whose round trip exceeds the certified window at
  // that bound cannot fit however it is reached. That is the one landside
  // verdict this tree can prove, and a proof is what a block needs.
  //
  // It matters most for the defect L61 names — `fetchDiscoveryPlaces` matches
  // with `ilike("city", "%…%")`, so a place in a DIFFERENT city whose name
  // contains the string was a candidate, was rated, and was served. Its
  // distance now blocks it.
  //
  // FAILS OPEN, everywhere. No airport coordinate, no place coordinate, no
  // envelope, a bound that could not be computed — each leaves the card
  // standing and lets `assess` rate it as before. Nothing is withheld without
  // the proof.
  // `certified.confidence` is NOT decoration. It is what contracts the planning
  // edge (`ENVELOPE_UNCERTAINTY_BUDGET` holds back 25% of the window at LOW,
  // which is what every production session on this tree certifies), and
  // `routes/airport.ts` has been publishing the envelope FOR THE MAP with it
  // since census L63 — `safeEnvelopeFor(airport, record)`. Omitting it here
  // banded candidates against a WIDER disc than the one the traveller was
  // shown: the map drew the contracted edge and nothing was ever measured
  // against it. One envelope, one confidence, both surfaces.
  const envelope = safeEnvelope(usableMinutes, airportPoint(airport), certified.confidence);
  const bands = await bandCandidates(
    envelope,
    discoveryCandidates.map((c) => ({ key: recommendationKey(c), point: c.point })),
    new Date(nowMs),
  );
  const blocked: Array<{ key: string; verdict: EnvelopeVerdict }> = [];
  const reachableDiscovery = discoveryCandidates.filter((c) => {
    const v = bands.get(recommendationKey(c));
    if (v?.band !== "BLOCKED") return true;
    blocked.push({ key: recommendationKey(c), verdict: v });
    return retainBlocked;
  }); const routed = await applyRoutedRecommendationPass({ db, session, record: certified, airport: airportPoint(airport), outerBound: envelope, bands, candidates: reachableDiscovery, keyOf: (c) => recommendationKey(c), landsideAllowed: landsideStatusOf(certified) !== "closed", corridorProvider: opts.corridorProvider }); // lane B1-R1: §8 with ROUTED terms — the survivors of the cheap filters (L260) are routed both ways at their own instants (L60), judged by the formula (L65) with the §8.1 signals (L68–L71, L282); the terms are written onto each candidate for `assess`, and the routed band replaces the straight-line one on its pin (a routed BLOCKED stays visible, rated, with its reason)
  if (blocked.length > 0) {
    logger.info(
      {
        sessionId: session.id,
        blocked: blocked.length,
        usableMinutes,
        radiusMetres: envelope?.radiusMetres ?? null,
        reasons: blocked.map((b) => b.verdict.reason),
      },
      "layover envelope blocked candidates outside the certified outer bound",
    );
  }

  const allCandidates = [
    ...insideCandidates.map((c) => ({ ...c, city: null as null, neighborhood: null as null, placeId: null as null, canonicalPlaceId: null as null, verified: true, point: null as GeoPoint | null })),
    ...reachableDiscovery,
    ...cityEscapeCandidates.map((c) => ({ ...c, canonicalPlaceId: null as null, point: null as GeoPoint | null })),
  ];

  // ── Sensing §11: intersect feasibility with live intelligence ──────────────
  // The live pass runs BEFORE `assess`, because what it produces is one of
  // `assess`'s inputs: a live queue is minutes the traveller will stand still,
  // and the existing safe-return arithmetic — not this pass — then decides
  // whether the card still fits the certified deadline. Flag off, gates
  // closed, no reading, or any error: `byKey` is empty and every branch below
  // falls through to the numbers the card already had.
  const liveRead = await readLayoverLive(
    db, session,
    allCandidates.map((c) => ({
      key: recommendationKey(c),
      subjectId: (c as { canonicalPlaceId?: string | null }).canonicalPlaceId ?? null,
      travelTimeMin: c.travelTimeMin,
      activityTimeMin: c.activityTimeMin,
    })),
    nowMs,
  ); const live = matchRead(liveRead, { read: (value) => value, degraded: (fallback, reasons) => { logger.warn({ sessionId: session.id, reasons }, "recommendations use degraded live evidence"); return fallback; } });
  const assessable = live.applied
    ? [...allCandidates]
        // A Live-qualified unsafe density or refused walk-in is not a card.
        .filter((c) => retainBlocked || !live.byKey.get(recommendationKey(c))?.drop)
        // Stable: `compareByLive` answers 0 for every pair without readings, so
        // the existing time-of-day order survives untouched where the world is
        // silent.
        .sort((x, y) => compareByLive(live.byKey.get(recommendationKey(x)), live.byKey.get(recommendationKey(y))))
    : allCandidates;
  if (live.applied) {
    logger.info(
      { sessionId: session.id, readable: live.readable, dropped: live.dropped, frictionAdjusted: live.frictionAdjusted },
      "layover live intersection applied",
    );
  }

  // ── §9.1 — SAFETY IS THE PRIMARY SORT KEY, ABOVE EVERY PREFERENCE ─────────
  //
  // Everything above this line orders by preference: `verified` first, then a
  // time-of-day nudge, then the live pass. None of it knows whether a card
  // still fits the certified window, so the top card could be a museum the
  // traveller cannot get back from while a `safe` café sat below it.
  //
  // `rankActivities` is the engine's own safety-first comparator and it had NO
  // CALLER OUTSIDE ITS TEST until this line existed. It re-sorts by the
  // certified rating and, within a rating, by travel time; `sort` is stable, so
  // every ordering decision made above survives as the tiebreak beneath it.
  //
  // `certified` — the whole RECORD, deadline AND envelope — is passed deliberately; see the note on
  // `rankActivities`. Its envelope is the ONE usable time every card is rated against (census-layover
  // §75: the deadline minus now overstated it before landing). Omitting it certifies NOTHING, and a
  // second deadline derivation here would be the duplicate-buffer defect `9c26efba` closed.
  const frictionAdjusted = assessable.map((candidate) => {
    // §11's friction, as minutes: the live queue is added to the activity time
    // the safety engine is given, so the CARD's own rating and hard return time
    // account for it. Without a reading this is the candidate's own number.
    const verdict = live.byKey.get(recommendationKey(candidate));
    return verdict?.adjustedActivityMin !== undefined
      ? { ...candidate, activityTimeMin: verdict.adjustedActivityMin }
      : candidate;
  });
  if (frictionAdjusted.some(c => travelTimeProvenanceColumn(travelTimeSourceFor(c)).travel_time_source !== undefined) && !(await canPersistTravelProvenance(db))) return { ok: false, message: "Travel-time provenance is unavailable; recommendations could not be refreshed." }; const ranked = rankActivities(airport, session, frictionAdjusted, nowMs, certified); const stamp = await recommendationStamp(db, session, certified); // 2745 readiness precedes supersession and recommendation writes. Census L64/B2-RECS-A: one stored citation and immutable supersession history.

  // Assess each through safety engine
  const rows: any[] = [];
  const keys: string[] = [];
  // Provenance per row, kept BESIDE the row like `keys` — and, when the row's
  // own columns cannot express it, IN the row as well: 2745 added
  // `travel_time_source` for exactly the figures they cannot.
  const sources: TravelTimeSource[] = [];
  let sortOrder = 0;
  const objectiveEvidence = await loadObjectiveEvidence(db, session, airport.id, ranked, recommendationKey, nowMs); const ranking = await applyLayoverRankingMode(db, session, ranked, { keyOf: recommendationKey, live: live.byKey, preferences: session.vibeChips, evidence: objectiveEvidence, routing: new Map([...routed.byKey].map(([key, value]) => [key, routedCardContract(value)])) }); // census L78/L242: evidence fills only named objective terms; safety ratings and eligible universe are unchanged
  for (const candidate of ranking.served) {
    const key = recommendationKey(candidate);
    const activityTimeMin = candidate.activityTimeMin;
    // WHAT GOES IN THE TWO NOT-NULL COLUMNS. `travel_time_min` and
    // `activity_time_min` are `INTEGER NOT NULL DEFAULT 0 / 30` (0127), so an
    // absence has to be written as SOME integer. It is written as 0 — the one
    // value the read path can tell apart from a stated figure for a landside
    // row, the identical arrangement L47 left on `layover_plan_stops.travel_min`.
    // `getRecommendations` and the return below run it back through
    // `statedTravelMin` / `statedDurationMin`, so the absence survives the trip.
    const storedTravelMin   = candidate.assessment.statedTravelMin ?? 0;
    const storedActivityMin = candidate.assessment.statedActivityMin ?? 0;
    // The assessment `rankActivities` already made, against the SAME certified
    // deadline. Re-calling `assess` here would be a third derivation of a
    // number this request has already computed twice.
    const a = candidate.assessment;
    keys.push(key);
    const source = travelTimeSourceFor(candidate);
    sources.push(source);
    const row = {
      session_id:       session.id,
      rec_type:         candidate.recType,
      title:            candidate.title,
      description:      (candidate as any).description ?? null,
      safety_rating:    a.rating,
      travel_time_min:  storedTravelMin,
      activity_time_min: storedActivityMin,
      return_buffer_min: a.returnBufferMin,
      hard_return_time: a.hardReturnTime.toISOString(),
      warning_reason:   a.warningReason,
      inside_airport:   candidate.insideAirport,
      location_label:   (candidate as any).locationLabel ?? null,
      city:             (candidate as any).city ?? null,
      neighborhood:     (candidate as any).neighborhood ?? null,
      sort_order:       sortOrder++,
      place_id:         (candidate as any).placeId ?? null,
      ...travelTimeProvenanceColumn(source), ...stamp.column, ...stamp.spec({ card: candidate, assessment: a, key, mapBand: bands.get(key)?.band ?? null, live: live.byKey, liveBlocked: live.byKey.get(key)?.drop === true, preferences: session.vibeChips, objectiveEvidence: objectiveEvidence.get(key), routing: candidate.insideAirport ? undefined : routedCardContract(routed.byKey.get(key)) }), // `{}` unless the row cannot say it itself; census L64: `{ snapshot_id }` only when the computation is stored; lane B2-RECS-A: the 3871 columns, `{}` with the status flag OFF
    };
    rows.push(row);
  }

  // id per row, known only on the stable-identity path.
  const idByKey = new Map<string, string>();
  // Stored moderation state per key, re-read after the write on the
  // stable-identity path so a regenerated card is served under the status an
  // admin last set for it. Empty on the legacy path, where a card has no
  // identity that outlives the DELETE and therefore no prior state to carry.
  const statusByKey = new Map<string, string>();

  if (opts.stableIds) {
    // Stable identity: upsert in place on (session_id, rec_key), then remove
    // only the cards that no longer apply. Existing ids — and therefore
    // layover_plan_stops.recommendation_id — survive a regeneration.
    //
    // `status` is deliberately ABSENT from the upsert payload. PostgREST's
    // merge-duplicates upsert emits ON CONFLICT DO UPDATE SET only for the
    // columns the payload carries, so an admin's hide/flag on an existing row
    // is left standing by the write itself. Adding `status` here would reset
    // every moderated card to 'active' on the next dashboard load — which is
    // exactly the durability this path exists to provide.
    const keyed = rows.map((row, i) => ({ ...row, rec_key: keys[i] }));
    if (keyed.length > 0) {
      const { data: written, error: upError } = await db
        .from("layover_recommendations")
        .upsert(keyed, { onConflict: "session_id,rec_key" })
        .select("id, rec_key");
      if (upError) {
        logger.warn({ err: upError, sessionId: session.id }, "recommendation upsert failed"); if(routePublication.required)return{ok:false,message:"This plan and its route monitoring could not be saved. Please try again."};
      } else {
        for (const w of (written ?? []) as any[]) {
          if (w?.id && w?.rec_key) idByKey.set(w.rec_key, w.id);
        }
      }
    }
    const { data: existing, error: exError } = await db
      .from("layover_recommendations")
      .select("id, rec_key, status")
      .eq("session_id", session.id);
    if (exError) {
      // NOT non-fatal. This read is the ONLY source of `statusByKey`, and
      // `statusByKey` is what drops an admin-hidden card from the returned set
      // on this path. Letting it stay empty served every hidden card straight
      // back to the traveller the moment the table hiccuped — the hide would
      // have been one failed SELECT wide. Refuse: the caller answers 503 and
      // the client retries, rather than showing moderated cards or claiming
      // "no recommendations".
      logger.warn(
        { err: exError, sessionId: session.id },
        "recommendation moderation state unreadable — refusing to serve cards whose hidden/flagged state is unknown",
      );
      return { ok: false, message: String(exError.message ?? "layover_recommendations unreadable") };
    } else {
      const live = new Set(keys);
      for (const r of (existing ?? []) as any[]) {
        // Identity is rec_key and ONLY rec_key. A row is matched to a freshly
        // generated card because it carries that card's key, never because the
        // two happen to read alike — text similarity is not identity.
        if (!r?.rec_key || !live.has(r.rec_key)) continue;
        if (r.id) idByKey.set(r.rec_key, r.id);
        if (typeof r.status === "string") statusByKey.set(r.rec_key, r.status);
      }
      const stale = ((existing ?? []) as any[])
        .filter((r) => !r.rec_key || !live.has(r.rec_key))
        .map((r) => r.id as string);
      if (stale.length > 0) {
        const { error: delError } = await db
          .from("layover_recommendations")
          .delete()
          .eq("session_id", session.id)
          .in("id", stale);
        if (delError) { logger.warn({ err: delError, sessionId: session.id }, "stale recommendation delete failed"); if(routePublication.required)return{ok:false,message:"Outdated plan routes could not be retired. Please try again."}; }
      }
    }
  } else {
    // Legacy path (flag off): delete old recs for this session and insert fresh
    // ones (non-fatal). Ids are not returned — see GenerateRecommendationsOptions.
    const { error: delError } = await db.from("layover_recommendations").delete().eq("session_id", session.id);
    if (delError) {
      logger.warn({ err: delError, sessionId: session.id }, "recommendation delete failed (non-fatal)");
    } else if (rows.length > 0) {
      const { error: insError } = await db.from("layover_recommendations").insert(rows);
      if (insError) logger.warn({ err: insError, sessionId: session.id }, "recommendation insert failed (non-fatal)");
    }
  }

  // Emit event (non-fatal). The metadata is the audit record for every
  // safety_rating / return_buffer_min / hard_return_time written above (spec
  // §23 "audit all server-side changes to certification fields"): the rules
  // version, the inputs the deadline was derived from, and what was written.
  {
    const { cutoffMs, breakdown, hardReturnTime } = certified.deadline;
    const ratings: Record<string, number> = {};
    for (const r of rows) ratings[r.safety_rating] = (ratings[r.safety_rating] ?? 0) + 1; const contract = monitorRecommendationContract({ sessionId: session.id, record: certified, rows, keys, bands, stampSnapshotId: stamp.snapshotId }); // census L216: every WRITTEN card against the record it was rated with; observes, never gates
    const { error: evtError } = await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "recommendation_generated",
      metadata:   {
        // `count` is what was WRITTEN, not what was returned: a moderated card
        // is still generated and still persisted, it is only withheld from the
        // traveller. `moderationHidden` is how many of those there were, so the
        // gap between the two is auditable rather than invisible.
        count: rows.length,
        moderationHidden: keys.filter((k) => statusByKey.get(k) === USER_HIDDEN_RECOMMENDATION_STATUS).length, contract, // census L216: counts only — GET /admin/layover/metrics folds these over its window
        // Spec §2.1 "versioned, explainable and replayable" / §20 DecisionRecord:
        // the certification header identifies the exact computation the ratings
        // and deadlines written above came out of, and `inputHash` is what makes
        // a replay checkable rather than a re-derivation that happens to agree.
        ...certificationHeader(certified),
        stableIds: Boolean(opts.stableIds), ...ranking.event, ...(stamp.snapshotId !== null ? { snapshotId: stamp.snapshotId } : stamp.reason !== "stamp_disabled" ? { snapshotStampRefused: stamp.reason } : {}), pairing: recommendationPairingFor(session.id, certified.inputHash, rows, keys), // census L64: nothing at all with the flag OFF; census L296: `pairing` is what POST /stops/from-recommendation checks an add against
        inputs: {
          airportId: airport.id,
          iataCode: airport.iataCode,
          airportVerified: airport.verified,
          timezone: airport.timezone,
          flightType: session.flightType,
          immigrationRequired: session.immigrationRequired,
          checkedBags: session.checkedBags,
          wantsToLeave: session.wantsToLeave,
          cutoff: new Date(cutoffMs).toISOString(),
          computedAt: new Date(nowMs).toISOString(),
        },
        breakdown,
        hardReturnTime: hardReturnTime.toISOString(),
        ratings,
        // §22 L249 / L250 — the rung this airport was on when these cards were
        // written, and whether the gate was ENFORCING it. `flagOn: false` is the
        // whole product today, so the audit trail says which of the two worlds a
        // stored card came from rather than leaving a reader to infer it from the
        // flag's value at the time they read the event.
        maturity: {
          level: landside.level,
          gateEnforced: Boolean(airport.curation) || landside.flagOn, flagOn: landside.flagOn,
          landsideAllowed: landside.allowed,
          cappedBy: landside.cappedBy,
          observationCount: landside.observationCount,
          observationsReadable: landside.signalsReadable, ...readDisclosure(maturityRead),
        },
      },
    });
    if (evtError) logger.warn({ err: evtError, sessionId: session.id }, "recommendation_generated event failed (non-fatal)");
  }

  // L259:3895's triggers publish each persisted recommendation and its route watches atomically; copied stop watches survive regeneration.
  //
  // A card whose stored row is admin-hidden is dropped here, so regeneration
  // cannot smuggle a moderated card back onto the traveller's dashboard. The
  // suppression uses the same constant as `getRecommendations` and the plan-add
  // read, so the three cannot drift apart. `flagged` deliberately stays visible
  // — see USER_HIDDEN_RECOMMENDATION_STATUS.
  //
  // On the legacy path `statusByKey` is empty, so nothing is dropped and the
  // returned set is byte-identical to what it was before this filter existed.
  return { ok: true, snapshotId: snapshotIdFor(session.id, certified.inputHash), liveDisclosure: readDisclosure(liveRead), routedEnvelope: routed.envelope, recommendations: rows.flatMap((row, idx) => {
    const status = statusByKey.get(keys[idx]);
    if (status === USER_HIDDEN_RECOMMENDATION_STATUS) return [];
    // census L122 — the pin's band, from the envelope THIS request cut. An
    // airside row was never handed to `bandCandidates` (it has no position and
    // no landside leg), so it gets the explicit unbanded state with the reason,
    // not a measured-looking `UNCERTIFIED` it never earned.
    const feasibility = row.inside_airport
      ? unbandedCandidateFeasibility(AIRSIDE_UNBANDED_REASON)
      : candidateFeasibilityFrom(bands.get(keys[idx]), NO_POSITION_UNBANDED_REASON);
    return [{ ...sanitizeRecommendation({
      id:              idByKey.get(keys[idx]),
      recType:         row.rec_type,
      title:           row.title,
      description:     row.description,
      safetyRating:    row.safety_rating,
      // Read back out of the row through the same classifier the persisted read
      // path uses, so a card served from this response and the same card served
      // from `getRecommendations` a second later cannot disagree about whether
      // its journey was ever measured.
      travelTimeMin:   statedTravelMin({ travelMin: row.travel_time_min, insideAirport: Boolean(row.inside_airport) }),
      travelTimeSource: sources[idx],
      activityTimeMin: statedDurationMin({ durationMin: row.activity_time_min }),
      returnBufferMin: row.return_buffer_min,
      hardReturnTime:  row.hard_return_time,
      warningReason:   row.warning_reason,
      insideAirport:   row.inside_airport,
      locationLabel:   row.location_label,
      city:            row.city,
      neighborhood:    row.neighborhood,
      sortOrder:       row.sort_order,
      placeId:         row.place_id ?? null,
      planItemId:      null,
    }), feasibility, experience: layoverExperienceFor({ recType: row.rec_type, title: row.title, insideAirport: Boolean(row.inside_airport) }), routing: row.inside_airport ? null : routedCardContract(routed.byKey.get(keys[idx])), ...stamp.served(row) }]; // census L75: from the served row alone, after it was rated — getRecommendations gives the same card the same descriptor; lane B2-RECS-A (L50): `status` / `available` / `statusReason` — a BLOCKED card is served, visibly unavailable, with its reason
  }) };
}

/**
 * The one moderation state that suppresses a recommendation from its owner.
 *
 * `layover_recommendations.status` is CHECK-constrained to ('active','hidden',
 * 'flagged') by 0127:132-134, and `POST /admin/airport/reports/:id/resolve`
 * (routes/airport.ts) maps its three admin actions onto exactly those:
 *
 *   approve      -> 'active'   the report was rejected; show it
 *   hide         -> 'hidden'   the report was upheld; stop showing it
 *   keep_flagged -> 'flagged'  still under review
 *
 * So the user-visible set is everything that is NOT 'hidden'. `flagged` is
 * deliberately still visible: the admin contract offers `keep_flagged` as an
 * outcome DISTINCT from `hide`, and collapsing them here would silently make
 * "leave it up while we look at it" mean "take it down".
 *
 * This is a moderation filter, not a safety-band filter. It says nothing about
 * whether an unsafe recommendation should be blocked (spec L50); that is a
 * separate, unanswered product question and is not decided here.
 */
export const USER_HIDDEN_RECOMMENDATION_STATUS = "hidden" as const;

/**
 * Fetch persisted recommendations for a session, as the session's owner sees
 * them.
 *
 * Excludes admin-hidden rows. Admin and service inspection paths deliberately
 * do NOT go through here — `GET /admin/airport/reports` queries
 * `layover_recommendations` directly for `status='flagged'`, and the resolve
 * route reads by id — so an admin can still see and act on everything.
 */
export type RecommendationsRead =
  | { ok: true; recommendations: CertifiedRecommendation[]; /** census L296: each served row as (recKey, digest), so the stored path can ask whether the newest generation certified THESE rows. */ pairingCards: Array<[string, string]> }
  | { ok: false; message: string };

export async function getRecommendations(
  db: SupabaseClient,
  sessionId: string,
): Promise<RecommendationsRead> {
  {
    const { data, error } = await db
      .from("layover_recommendations")
      .select("*")
      .eq("session_id", sessionId)
      .neq("status", USER_HIDDEN_RECOMMENDATION_STATUS)
      .order("sort_order", { ascending: true });

    // supabase-js RESOLVES on a database error, so an unchecked `error` reads
    // as an empty result. Returning [] here is the fail-closed direction for a
    // read, but it must be logged rather than silently indistinguishable from
    // "this session has no recommendations".
    // Returning [] here made "the table could not be read" and "this layover
    // has nothing to do" the same answer on the dashboard. They are not the
    // same answer, and on this surface the difference is a traveller sitting
    // in a terminal being told there is nothing worth their four hours.
    if (error) {
      logger.warn({ err: error, sessionId }, "recommendation read failed — refusing rather than reporting an empty layover");
      return { ok: false, message: String(error.message ?? "layover_recommendations unreadable") };
    }

    // census L122 — the stored path re-cuts NO envelope. It has no airport, no
    // session and no certified window: `getRecommendations` takes a sessionId
    // and a client, which is all the route needs to serve a card it wrote
    // earlier. So every card here is explicitly UNBANDED with the reason, and
    // the client renders "we have not re-checked this against your current
    // window" rather than a band that would be a claim about an older one. The
    // route regenerates whenever `layover_safety_engine_enabled` is on, so the
    // banded path is the one a traveller actually gets there.
    const servedOf = await storedStatusProjector(db, sessionId, (data ?? []) as Array<Record<string, unknown>>); return { ok: true, pairingCards: (data ?? []).map((row: any) => [recommendationRowKey(row), recommendationCardDigest(row)] as [string, string]), recommendations: (data ?? []).map((row: any) => ({ ...sanitizeRecommendation({
      id:             row.id,
      recType:        row.rec_type,
      title:          row.title,
      description:    row.description,
      safetyRating:   row.safety_rating,
      // A landside zero is an ABSENCE, not a free journey (census L293 / L47).
      travelTimeMin:  statedTravelMin({ travelMin: row.travel_time_min, insideAirport: Boolean(row.inside_airport) }),
      // 2745's column, READ rather than a provenance inferred from the row. The
      // select is `*`, so on a database that has not applied 2745 the key is
      // simply absent — the same answer as NULL, and the same answer as a
      // writer that said nothing: `unknown_provenance`, never a measurement.
      travelTimeSource: persistedTravelTimeSource({
        insideAirport: Boolean(row.inside_airport),
        travelTimeMin: row.travel_time_min,
        provenance:    row.travel_time_source ?? null,
      }),
      activityTimeMin: statedDurationMin({ durationMin: row.activity_time_min }),
      returnBufferMin: row.return_buffer_min,
      hardReturnTime: row.hard_return_time,
      warningReason:  row.warning_reason,
      insideAirport:  row.inside_airport,
      locationLabel:  row.location_label,
      city:           row.city,
      neighborhood:   row.neighborhood,
      sortOrder:      row.sort_order,
      placeId:        row.place_id,
      planItemId:     row.plan_item_id,
    }), feasibility: unbandedCandidateFeasibility(
      row.inside_airport ? AIRSIDE_UNBANDED_REASON : STORED_UNBANDED_REASON,
    ), experience: layoverExperienceFor({ recType: row.rec_type, title: row.title, insideAirport: Boolean(row.inside_airport) }), ...servedOf(row) })) }; // census L75: the same descriptor the generate path attaches; lane B2-RECS-A (L38/L50/L97): a stored card's status as served now (SUPERSEDED / EXPIRED / STALE projected), nothing for an unclassified card
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// census-layover L296 — Appendix C5: "Never certify a recommendation against a
// snapshot other than the one returned with it." Appendix A names the refusal:
// RECOMMENDATION_EXPIRED, "Recommendation certified under stale snapshot".
//
// Appended at the TAIL so no cited line above moves; ESM hoists the imports.
//
// THE PAIRING. A generation certifies every card against ONE record, whose
// identity is `snapshotIdFor(session.id, certified.inputHash)`. The response
// carries that id (`GenerateResult.snapshotId`), and the generation's audit
// event (`recommendation_generated`, layover_events — applied in production)
// records `pairing`: the same id plus every card it wrote, as recKey → a digest
// of the columns the card is certified by. `POST /stops/from-recommendation`
// adds a card only when the request names the NEWEST generation's snapshot AND
// that generation certified this card as the row now stands.
//
// WHY A DIGEST AND NOT ONLY A KEY LIST. The event insert is non-fatal (§72.5).
// When a generation's event is lost, the newest RECORDED generation is the one
// before it, and a key list would let a client holding that older snapshot add
// a card the lost generation REWROTE in place (stable ids upsert on rec_key) —
// the plan would copy numbers certified under a snapshot the client never saw.
// The digest refuses exactly that, and still lets an unchanged card through,
// because an unchanged card IS the card the older snapshot certified.
//
// FAIL-CLOSED READS. An unreadable event is `unreadable` (the route answers
// 503); a missing or malformed pairing is "no generation recorded" (409).
// Neither is ever a pass.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from "node:crypto";
import { snapshotIdFor } from "./layoverLedger.js";
import { withLayoverRoutesBudget, LAYOVER_DEFERRED_LEG_PROVIDER } from "./LayoverTravelTime.js"; import { applyRoutedRecommendationPass, routedCardContract, type RoutedCardContract } from "./LayoverRoutedFeasibility.js"; import type { RoutedSafeEnvelope } from "./LayoverEnvelope.js"; import type { RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js"; // lane B1-R1 imports on this one line, so no line below moves
import { routeSubjectPublicationGate } from "./LayoverRouteSubjects.js";

/** Appendix A's sentence for `RECOMMENDATION_EXPIRED`, verbatim. */
export const RECOMMENDATION_EXPIRED_MESSAGE = "Recommendation certified under stale snapshot";

/** What one generation certified: its snapshot, and each card it wrote as recKey → digest. */
export interface RecommendationPairing {
  snapshotId: string;
  cards: Record<string, string>;
}

/**
 * The columns a card is certified BY — its rating, its deadline and the facts
 * the rating was computed from — and that `POST /stops/from-recommendation`
 * copies into the plan. A change to any of them is a different card.
 */
const CERTIFIED_CARD_COLUMNS = [
  "rec_type", "title", "description", "safety_rating", "travel_time_min", "activity_time_min",
  "return_buffer_min", "hard_return_time", "warning_reason", "inside_airport", "location_label",
  "city", "neighborhood", "place_id",
] as const;
const NUMERIC_CARD_COLUMNS: ReadonlySet<string> = new Set(["travel_time_min", "activity_time_min", "return_buffer_min"]);

/**
 * One value, as the generation wrote it and as PostgREST reads it back. The one
 * representation that differs on the wire is a `timestamptz`: written as
 * `toISOString()` ("…Z"), read back as "…+00:00". Both parse to one instant.
 */
function certifiedCardValue(column: string, v: unknown): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (column === "hard_return_time") {
    const ms = Date.parse(String(v));
    return Number.isFinite(ms) ? new Date(ms).toISOString() : String(v);
  }
  if (column === "inside_airport") return Boolean(v);
  if (NUMERIC_CARD_COLUMNS.has(column)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v);
  }
  return String(v);
}

/** A digest of a `layover_recommendations` row's certified columns. Identity, not security. */
export function recommendationCardDigest(row: Record<string, unknown>): string {
  const values = CERTIFIED_CARD_COLUMNS.map((c) => certifiedCardValue(c, row[c]));
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, 32);
}

/**
 * A stored row's identity within its session: its `rec_key` when it has one
 * (the stable path writes it), otherwise the same `recommendationKey` the
 * generation derived it from (the legacy path writes no key).
 */
export function recommendationRowKey(row: Record<string, unknown>): string {
  if (typeof row.rec_key === "string" && row.rec_key !== "") return row.rec_key;
  return recommendationKey({
    recType: String(row.rec_type ?? ""),
    title: String(row.title ?? ""),
    insideAirport: Boolean(row.inside_airport),
    placeId: (row.place_id as string | null | undefined) ?? null,
    city: (row.city as string | null | undefined) ?? null,
  });
}

/** The pairing a generation records beside the cards it wrote. */
export function recommendationPairingFor(
  sessionId: string,
  inputHash: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  keys: ReadonlyArray<string>,
): RecommendationPairing {
  const cards: Record<string, string> = {};
  rows.forEach((row, i) => { cards[keys[i]!] = recommendationCardDigest(row); });
  return { snapshotId: snapshotIdFor(sessionId, inputHash), cards };
}

/** The `pairing` an event carries, or null when it carries none this code can read. */
function pairingOf(metadata: unknown): RecommendationPairing | null {
  const p = (metadata as { pairing?: unknown } | null | undefined)?.pairing as { snapshotId?: unknown; cards?: unknown } | undefined;
  if (!p || typeof p.snapshotId !== "string" || !/^snap:[0-9a-f]{32}$/.test(p.snapshotId)) return null;
  if (!p.cards || typeof p.cards !== "object" || Array.isArray(p.cards)) return null;
  const cards: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.cards as Record<string, unknown>)) {
    if (typeof v !== "string") return null;
    cards[k] = v;
  }
  return { snapshotId: p.snapshotId, cards };
}

const hasCard = (p: RecommendationPairing, key: string): boolean => Object.prototype.hasOwnProperty.call(p.cards, key);

export type RecommendationPairingRead =
  | { ok: true; pairing: RecommendationPairing | null }
  | { ok: false; message: string };

/**
 * The pairing of the session's NEWEST generation — the newest
 * `recommendation_generated` event, never the newest overview or safety answer
 * (those are snapshots of the session, not of the cards). `pairing: null` is an
 * ANSWER (no generation recorded one); `ok: false` is "could not look".
 */
export async function newestRecommendationPairing(
  db: SupabaseClient,
  sessionId: string,
): Promise<RecommendationPairingRead> {
  try {
    const { data, error } = await db
      .from("layover_events")
      .select("metadata, created_at")
      .eq("session_id", sessionId)
      .eq("event_type", "recommendation_generated")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      logger.warn({ err: error, sessionId }, "recommendation_generated read failed — no card can be paired with a snapshot");
      return { ok: false, message: String(error.message ?? "layover_events unreadable") };
    }
    const newest = Array.isArray(data) ? (data[0] as { metadata?: unknown } | undefined) : undefined;
    return { ok: true, pairing: pairingOf(newest?.metadata) };
  } catch (err) {
    logger.warn({ err, sessionId }, "recommendation_generated read threw — no card can be paired with a snapshot");
    return { ok: false, message: String((err as Error)?.message ?? err) };
  }
}

export type RecommendationPairingCheck =
  | { ok: true; snapshotId: string }
  | { ok: false; kind: "expired"; why: "no_snapshot_named" | "no_generation_recorded" | "snapshot_superseded" | "card_not_certified_as_it_stands" }
  | { ok: false; kind: "unreadable"; message: string };

/** Pure: may `row`, named under `snapshotId`, be added given the newest generation's `pairing`? */
export function judgeRecommendationPairing(
  pairing: RecommendationPairing | null,
  snapshotId: string,
  row: Record<string, unknown>,
): RecommendationPairingCheck {
  if (pairing === null) return { ok: false, kind: "expired", why: "no_generation_recorded" };
  if (pairing.snapshotId !== snapshotId) return { ok: false, kind: "expired", why: "snapshot_superseded" };
  const key = recommendationRowKey(row);
  if (!hasCard(pairing, key) || pairing.cards[key] !== recommendationCardDigest(row)) {
    return { ok: false, kind: "expired", why: "card_not_certified_as_it_stands" };
  }
  return { ok: true, snapshotId };
}

/**
 * The add's check. `named` is the request's `snapshotId`, untrusted: anything
 * but a non-empty string is "none", and none is refused before anything is read.
 */
export async function checkRecommendationPairing(
  db: SupabaseClient,
  sessionId: string,
  row: Record<string, unknown>,
  named: unknown,
): Promise<RecommendationPairingCheck> {
  const snapshotId = typeof named === "string" && named.trim() !== "" ? named : null;
  if (snapshotId === null) return { ok: false, kind: "expired", why: "no_snapshot_named" };
  const read = await newestRecommendationPairing(db, sessionId);
  if (!read.ok) return { ok: false, kind: "unreadable", message: read.message };
  return judgeRecommendationPairing(read.pairing, snapshotId, row);
}

/**
 * The stored path's snapshot (`GET /:id/recommendations` with the safety engine
 * off): the newest generation's, but ONLY when that generation certified every
 * served row exactly as it stands. Otherwise `snapshotId: null`, and the route
 * regenerates rather than label rows with a snapshot they were not computed in.
 */
export async function storedRecommendationPairing(
  db: SupabaseClient,
  sessionId: string,
  served: ReadonlyArray<readonly [string, string]>,
): Promise<{ ok: true; snapshotId: string | null } | { ok: false; message: string }> {
  const read = await newestRecommendationPairing(db, sessionId);
  if (!read.ok) return read;
  const p = read.pairing;
  if (p === null || served.length === 0) return { ok: true, snapshotId: null };
  const paired = served.every(([key, digest]) => hasCard(p, key) && p.cards[key] === digest);
  return { ok: true, snapshotId: paired ? p.snapshotId : null };
}

// LAYOVER 165 lane B2-CURATE (L223) — imported at the TAIL so no cited line above moves; ESM hoists it. One call site:
// the inside-airport candidates of `generateRecommendations`.
import { curatedOvernightCandidates } from "./airportCuration.js";

// LAYOVER 165 lane B2-RECS-A (census L26/L38/L44/L50/L97) — imported at the TAIL so no cited line above moves; ESM
// hoists it. Three one-line call sites: the generation's stamp (`recommendationStamp`, which also supersedes the
// session's stale cards before they are rewritten), each written row's 3871 columns (`stamp.spec`), and the served
// status of a generated card (`stamp.served`) and of a stored one (`storedStatusProjector` in getRecommendations).
// With layover_recommendation_status_enabled OFF every one of them is `{}` and reads nothing beyond the flag.
import { recommendationStamp, storedStatusProjector, recommendationStatusEnabled } from "../layover/LayoverRecommendationStatus.js";

import { matchRead, readDisclosure, readValue, readDegraded, type LayoverRead } from "../layover/layoverRead.js";
import { canPersistTravelProvenance } from "./LayoverTravelProvenanceSchema.js";
import { loadObjectiveEvidence } from "./LayoverObjectiveEvidenceStore.js";

/** Keep an unreadable rollout flag distinct from a deliberate disabled value. */
async function readLiveIntersectionFlag(db: SupabaseClient, sessionId: string): Promise<LayoverRead<boolean>> {
  try {
    const { data, error } = await db.from("feature_flags").select("enabled").eq("flag", LAYOVER_LIVE_INTERSECTION_FLAG).maybeSingle();
    if (error) { logger.warn({ err: error, sessionId }, "layover live flag read failed"); return readDegraded(false, ["live_flag_unreadable"]); }
    return readValue(data?.enabled === true);
  } catch (err) {
    logger.warn({ err, sessionId }, "layover live flag read threw");
    return readDegraded(false, ["live_flag_unreadable"]);
  }
}
