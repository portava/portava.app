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
  assess,
  computeReturnDeadline,
  travelTimeSourceFor,
  LAYOVER_ENGINE_VERSION,
  type SafetyRating,
  type TravelTimeSource,
} from "./LayoverSafetyEngine.js";
import { sanitizeRecommendation, type SafeRecommendation } from "./LayoverPrivacyGuard.js";
import { localHour } from "./AirportTime.js";

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
  travelTimeMin: number;
  activityTimeMin: number;
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
    travelTimeMin:  row.travel_time_min,
    activityTimeMin: row.activity_time_min,
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
  limit = 8,
): Promise<Array<{
  recType: string;
  title: string;
  description: string;
  travelTimeMin: number;
  travelTimeSource: TravelTimeSource;
  activityTimeMin: number;
  insideAirport: boolean;
  locationLabel: string;
  city: string;
  neighborhood: string | null;
  placeId: string | null;
  verified: boolean;
}>> {
  try {
    let query = db
      .from("discovery_places")
      .select("id, name, place_type, category, neighborhood, blurb, verified")
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

    return (data as any[]).map((p) => ({
      recType:        mapPlaceTypeToRecType(p.place_type ?? "activity"),
      title:          p.name,
      description:    p.blurb ?? null,
      travelTimeMin:  estimateTravelTime(p.place_type),
      // The SELECT above reads no coordinate; estimateTravelTime is a category
      // constant. Carry that fact rather than let the number pose as a route.
      travelTimeSource: "category_default" as const,
      activityTimeMin: estimateActivityTime(p.place_type),
      insideAirport:  false,
      locationLabel:  p.neighborhood ? `${p.neighborhood}, ${city}` : city,
      city,
      neighborhood:   p.neighborhood ?? null,
      placeId:        p.id,
      verified:       Boolean(p.verified),
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

/**
 * A per-category CONSTANT — 15 or 25 minutes — chosen without a coordinate.
 * It is not a route and must never be presented as one: every caller tags the
 * result TravelTimeSource "category_default" (spec §2.1 "never fabricate
 * freshness"). Building a routed estimate is out of scope here; carrying the
 * provenance is the obligation this tree can meet honestly.
 */
function estimateTravelTime(placeType: string): number {
  const near = ["cafe", "restaurant", "shopping"];
  if (near.includes(placeType)) return 15;
  return 25;
}

function estimateActivityTime(placeType: string): number {
  const quick = ["cafe", "shopping"];
  if (quick.includes(placeType)) return 30;
  const long = ["museum", "park", "attraction"];
  if (long.includes(placeType)) return 90;
  return 60;
}

/**
 * Generate and persist recommendations for a session.
 * Returns the safe (privacy-filtered) recommendation list.
 */
export interface GenerateRecommendationsOptions {
  /**
   * When true (flag `layover_stable_recommendation_ids_enabled`, seeded FALSE), rows
   * are upserted on (session_id, rec_key) and returned WITH their ids; cards
   * that no longer apply are deleted individually. When false, the legacy
   * delete-everything-then-insert path runs unchanged and — as before — the
   * returned cards carry no id.
   */
  stableIds?: boolean;
}

export async function generateRecommendations(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
  opts: GenerateRecommendationsOptions = {},
): Promise<SafeRecommendation[]> {
  const city = airport.city ?? session.manualCity ?? "Unknown";

  // 1. Inside-airport suggestions (always generated)
  const insideCandidates = insideAirportCandidates(session);

  // 2. Discovery places near airport city — filtered and ranked for the
  //    time of day the traveler will actually be out there.
  const tod = timeOfDayContext(airport, session, nowMs);
  let discoveryCandidates = session.wantsToLeave && session.layoverMinutes >= 90
    ? await fetchDiscoveryPlaces(db, city, session.vibeChips)
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

  // 3. Quick city escape for long layovers
  const cityEscapeCandidates = session.wantsToLeave && session.layoverMinutes >= 180
    ? [{
        recType: "quick_city_escape",
        title: `Quick City Tour — ${city}`,
        description: `A short exploration of ${city}'s highlights — ideal for a ${session.layoverMinutes >= 240 ? "half-day" : "quick"} layover.`,
        travelTimeMin: 30,
        travelTimeSource: "category_default" as const,
        activityTimeMin: session.layoverMinutes >= 240 ? 120 : 60,
        insideAirport: false,
        locationLabel: city,
        city,
        neighborhood: null as null,
        placeId: null as null,
        verified: false,
      }]
    : [];

  const allCandidates = [
    ...insideCandidates.map((c) => ({ ...c, city: null as null, neighborhood: null as null, placeId: null as null, verified: true })),
    ...discoveryCandidates,
    ...cityEscapeCandidates,
  ];

  // Assess each through safety engine
  const rows: any[] = [];
  const keys: string[] = [];
  // Provenance per row, kept BESIDE the row like `keys`: the row object is the
  // insert/upsert payload and layover_recommendations has no column for it.
  const sources: TravelTimeSource[] = [];
  let sortOrder = 0;

  for (const candidate of allCandidates) {
    const a = assess(airport, session, candidate, nowMs);
    keys.push(recommendationKey(candidate));
    sources.push(travelTimeSourceFor(candidate));
    const row = {
      session_id:       session.id,
      rec_type:         candidate.recType,
      title:            candidate.title,
      description:      (candidate as any).description ?? null,
      safety_rating:    a.rating,
      travel_time_min:  candidate.travelTimeMin,
      activity_time_min: candidate.activityTimeMin,
      return_buffer_min: a.returnBufferMin,
      hard_return_time: a.hardReturnTime.toISOString(),
      warning_reason:   a.warningReason,
      inside_airport:   candidate.insideAirport,
      location_label:   (candidate as any).locationLabel ?? null,
      city:             (candidate as any).city ?? null,
      neighborhood:     (candidate as any).neighborhood ?? null,
      sort_order:       sortOrder++,
      place_id:         (candidate as any).placeId ?? null,
    };
    rows.push(row);
  }

  // id per row, known only on the stable-identity path.
  const idByKey = new Map<string, string>();

  if (opts.stableIds) {
    // Stable identity: upsert in place on (session_id, rec_key), then remove
    // only the cards that no longer apply. Existing ids — and therefore
    // layover_plan_stops.recommendation_id — survive a regeneration.
    const keyed = rows.map((row, i) => ({ ...row, rec_key: keys[i] }));
    if (keyed.length > 0) {
      const { data: written, error: upError } = await db
        .from("layover_recommendations")
        .upsert(keyed, { onConflict: "session_id,rec_key" })
        .select("id, rec_key");
      if (upError) {
        logger.warn({ err: upError, sessionId: session.id }, "recommendation upsert failed (non-fatal)");
      } else {
        for (const w of (written ?? []) as any[]) {
          if (w?.id && w?.rec_key) idByKey.set(w.rec_key, w.id);
        }
      }
    }
    const { data: existing, error: exError } = await db
      .from("layover_recommendations")
      .select("id, rec_key")
      .eq("session_id", session.id);
    if (exError) {
      logger.warn({ err: exError, sessionId: session.id }, "recommendation stale-scan failed (non-fatal)");
    } else {
      const live = new Set(keys);
      const stale = ((existing ?? []) as any[])
        .filter((r) => !r.rec_key || !live.has(r.rec_key))
        .map((r) => r.id as string);
      if (stale.length > 0) {
        const { error: delError } = await db
          .from("layover_recommendations")
          .delete()
          .eq("session_id", session.id)
          .in("id", stale);
        if (delError) logger.warn({ err: delError, sessionId: session.id }, "stale recommendation delete failed (non-fatal)");
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
    const { cutoffMs, breakdown, hardReturnTime } = computeReturnDeadline(airport, session);
    const ratings: Record<string, number> = {};
    for (const r of rows) ratings[r.safety_rating] = (ratings[r.safety_rating] ?? 0) + 1;
    const { error: evtError } = await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "recommendation_generated",
      metadata:   {
        count: rows.length,
        engineVersion: LAYOVER_ENGINE_VERSION,
        stableIds: Boolean(opts.stableIds),
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
      },
    });
    if (evtError) logger.warn({ err: evtError, sessionId: session.id }, "recommendation_generated event failed (non-fatal)");
  }

  // Return privacy-safe view
  return rows.map((row, idx) => sanitizeRecommendation({
    id:             idByKey.get(keys[idx]),
    recType:        row.rec_type,
    title:          row.title,
    description:    row.description,
    safetyRating:   row.safety_rating,
    travelTimeMin:  row.travel_time_min,
    travelTimeSource: sources[idx],
    activityTimeMin: row.activity_time_min,
    returnBufferMin: row.return_buffer_min,
    hardReturnTime: row.hard_return_time,
    warningReason:  row.warning_reason,
    insideAirport:  row.inside_airport,
    locationLabel:  row.location_label,
    city:           row.city,
    neighborhood:   row.neighborhood,
    sortOrder:      idx,
    placeId:        row.place_id ?? null,
    planItemId:     null,
  }));
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
export async function getRecommendations(
  db: SupabaseClient,
  sessionId: string,
): Promise<SafeRecommendation[]> {
  try {
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
    if (error) {
      logger.warn({ err: error, sessionId }, "recommendation read failed; serving none");
      return [];
    }

    return (data ?? []).map((row: any) => sanitizeRecommendation({
      id:             row.id,
      recType:        row.rec_type,
      title:          row.title,
      description:    row.description,
      safetyRating:   row.safety_rating,
      travelTimeMin:  row.travel_time_min,
      // No column carries provenance; inferred from inside_airport, which is
      // exact only while no "measured" producer exists (see travelTimeSourceFor).
      travelTimeSource: travelTimeSourceFor({ insideAirport: Boolean(row.inside_airport) }),
      activityTimeMin: row.activity_time_min,
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
    }));
  } catch {
    return [];
  }
}
