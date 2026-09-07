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
import { assess, type SafetyRating } from "./LayoverSafetyEngine.js";
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
  travelTimeMin: number | null;
  activityTimeMin: number;
  insideAirport: boolean;
  locationLabel: string;
}> {
  const has = (vibe: string) => session.vibeChips.includes(vibe);
  const items: Array<{ recType: string; title: string; description: string; travelTimeMin: number; activityTimeMin: number; insideAirport: boolean; locationLabel: string }> = [];

  items.push({
    recType: "inside_airport", title: "Airport Lounge / Rest Area",
    description: session.loungeAccess
      ? "Use your lounge access to relax, eat, and recharge."
      : "Find a quiet gate area or pay-per-use lounge to rest.",
    travelTimeMin: 0, activityTimeMin: 30, insideAirport: true, locationLabel: "Inside airport",
  });

  if (has("food") || session.layoverMinutes >= 90) {
    items.push({
      recType: "food", title: "Airport Dining",
      description: "Explore terminal restaurants — many airports have excellent local food options.",
      travelTimeMin: 0, activityTimeMin: 45, insideAirport: true, locationLabel: "Airport terminals",
    });
  }

  if (has("shopping")) {
    items.push({
      recType: "inside_airport", title: "Duty-Free & Airport Shops",
      description: "Browse duty-free, local souvenirs, and travel essentials.",
      travelTimeMin: 0, activityTimeMin: 30, insideAirport: true, locationLabel: "Duty-free zone",
    });
  }

  if (has("culture")) {
    items.push({
      recType: "inside_airport", title: "Airport Art & Culture",
      description: "Many international airports feature galleries, cultural exhibits, and installations.",
      travelTimeMin: 0, activityTimeMin: 20, insideAirport: true, locationLabel: "Inside airport",
    });
  }

  items.push({
    recType: "rest", title: "Rest & Sleep Pod",
    description: "Catch some sleep at a transit hotel or airport sleep pod.",
    travelTimeMin: 0, activityTimeMin: 60, insideAirport: true, locationLabel: "Airside hotel",
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
  travelTimeMin: number | null;
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

    const { data } = await query;
    if (!data) return [];

    return (data as any[]).map((p) => ({
      recType:        mapPlaceTypeToRecType(p.place_type ?? "activity"),
      title:          p.name,
      description:    p.blurb ?? null,
      travelTimeMin:  null, // unknown: no routing provider exists (see above)
      activityTimeMin: estimateActivityTime(p.place_type),
      insideAirport:  false,
      locationLabel:  p.neighborhood ? `${p.neighborhood}, ${city}` : city,
      city,
      neighborhood:   p.neighborhood ?? null,
      placeId:        p.id,
      verified:       Boolean(p.verified),
    }));
  } catch {
    return [];
  }
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
 * DELETED: estimateTravelTime(placeType).
 *
 * It returned 15 minutes for a cafe/restaurant/shopping place and 25 for
 * anything else, and it never looked at a coordinate — indeed
 * `fetchDiscoveryPlaces` does not even SELECT lat/lng, and matches its city with
 * `ilike %city%`, so a place in a different city whose name contains the string
 * would score the same 15 minutes as one across the airport road.
 *
 * That number was doubled into a round trip by the safety engine and turned
 * directly into "safe" / "not recommended". It was the load-bearing input to a
 * verdict about whether somebody would make their flight, and it was a constant.
 *
 * There is no replacement because there is nothing honest to replace it with:
 * this repo has no routing provider. MAPBOX_TOKEN and GOOGLE_MAPS_API_KEY are
 * both geocoding-only (src/services/geocodingService.ts), and no Directions,
 * Distance Matrix or Isochrone client exists. Straight-line distance is not
 * travel time and must not be substituted for it.
 *
 * So a landside candidate's travel time is `null`, the safety engine refuses to
 * rate it, and the traveller is told we cannot work it out — which is true.
 */

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
export async function generateRecommendations(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
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
        // Was a hardcoded 30 minutes for "a short exploration of the city",
        // at every airport on earth. Unknown for the same reason as above.
        travelTimeMin: null as number | null,
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
  let sortOrder = 0;

  for (const candidate of allCandidates) {
    const a = assess(airport, session, candidate, nowMs);
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

  // Delete old recs for this session and insert fresh ones (non-fatal)
  {
    const { error: delError } = await db.from("layover_recommendations").delete().eq("session_id", session.id);
    if (delError) {
      logger.warn({ err: delError, sessionId: session.id }, "recommendation delete failed (non-fatal)");
    } else if (rows.length > 0) {
      const { error: insError } = await db.from("layover_recommendations").insert(rows);
      if (insError) logger.warn({ err: insError, sessionId: session.id }, "recommendation insert failed (non-fatal)");
    }
  }

  // Emit event (non-fatal)
  {
    const { error: evtError } = await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "recommendation_generated",
      metadata:   { count: rows.length },
    });
    if (evtError) logger.warn({ err: evtError, sessionId: session.id }, "recommendation_generated event failed (non-fatal)");
  }

  // Return privacy-safe view
  return rows.map((row, idx) => sanitizeRecommendation({
    recType:        row.rec_type,
    title:          row.title,
    description:    row.description,
    safetyRating:   row.safety_rating,
    travelTimeMin:  row.travel_time_min,
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

/** Fetch persisted recommendations for a session. */
export async function getRecommendations(
  db: SupabaseClient,
  sessionId: string,
): Promise<SafeRecommendation[]> {
  try {
    const { data } = await db
      .from("layover_recommendations")
      .select("*")
      .eq("session_id", sessionId)
      .order("sort_order", { ascending: true });

    return (data ?? []).map((row: any) => sanitizeRecommendation({
      id:             row.id,
      recType:        row.rec_type,
      title:          row.title,
      description:    row.description,
      safetyRating:   row.safety_rating,
      travelTimeMin:  row.travel_time_min,
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
