/**
 * LayoverRecommendationService
 *
 * Generates recommendation cards for a layover session by querying Discovery places,
 * inside-airport content, and nearby plans, then running each through the Safety Engine.
 * Produces layover_recommendations rows. Respects LayoverPrivacyGuard rules.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import { assess, type SafetyRating } from "./LayoverSafetyEngine.js";
import { sanitizeRecommendation, type SafeRecommendation } from "./LayoverPrivacyGuard.js";

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
  travelTimeMin: number;
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
      travelTimeMin:  estimateTravelTime(p.place_type),
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
    restaurant: "food", cafe: "food", bar: "nightlife",
    museum: "activity", park: "activity", shopping: "activity",
    hotel: "rest", spa: "rest", attraction: "activity",
  };
  return map[placeType] ?? "activity";
}

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
export async function generateRecommendations(
  db: SupabaseClient,
  airport: AirportProfile,
  session: LayoverSession,
  nowMs = Date.now(),
): Promise<SafeRecommendation[]> {
  const city = airport.city ?? session.manualCity ?? "Unknown";

  // 1. Inside-airport suggestions (always generated)
  const insideCandidates = insideAirportCandidates(session);

  // 2. Discovery places near airport city
  const discoveryCandidates = session.wantsToLeave && session.layoverMinutes >= 90
    ? await fetchDiscoveryPlaces(db, city, session.vibeChips)
    : [];

  // 3. Quick city escape for long layovers
  const cityEscapeCandidates = session.wantsToLeave && session.layoverMinutes >= 180
    ? [{
        recType: "quick_city_escape",
        title: `Quick City Tour — ${city}`,
        description: `A short exploration of ${city}'s highlights — ideal for a ${session.layoverMinutes >= 240 ? "half-day" : "quick"} layover.`,
        travelTimeMin: 30,
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

  // Delete old recs for this session and insert fresh ones
  try {
    await db.from("layover_recommendations").delete().eq("session_id", session.id);
    if (rows.length > 0) {
      await db.from("layover_recommendations").insert(rows);
    }
  } catch { /* non-fatal */ }

  // Emit event
  try {
    await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "recommendation_generated",
      metadata:   { count: rows.length },
    });
  } catch { /* non-fatal */ }

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
