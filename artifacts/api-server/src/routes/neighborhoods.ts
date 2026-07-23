/**
 * neighborhoods.ts — Neighborhood Match v1 routes
 *
 *   GET  /cities/neighborhoods            — cached/refreshed per-city areas (flag-gated)
 *   PUT  /trips/:tripId/area-preferences  — member upserts own stay preferences
 *   POST /trips/:tripId/neighborhood-match — personalized area ranking (flag-gated)
 *   POST /trips/:tripId/location-check    — pure-math fit check for a candidate stay
 *
 * Scores come exclusively from OpenStreetMap POI density (see
 * ../lib/neighborhoodMatch.ts). Responses always carry sampleSize +
 * confidence, and degrade to { areas: [], reason: 'no_data' } — never
 * fabricated areas presented as verified.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { requireUser, requireTripMember, sendError } from "../lib/http.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import {
  CATEGORIES,
  refreshCityNeighborhoods,
  rankAreas,
  centerOfGravity,
  haversineKm,
  type ComputedArea,
  type AreaPreferences,
} from "../lib/neighborhoodMatch.js";

const router = Router();
const UUID_RE = /^[0-9a-f-]{36}$/i;

const FLAG = "neighborhood_match_enabled";
const DISCLAIMER =
  "Scores derived from OpenStreetMap data density — verify neighborhoods before booking.";
const NO_DATA_MESSAGE =
  "No neighborhood data could be derived from OpenStreetMap for this city yet — try again later.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** DB row → camelCase API shape (raw, un-ranked). */
function toPublicArea(a: ComputedArea): any {
  return {
    name:           a.name,
    centerLat:      a.center_lat,
    centerLng:      a.center_lng,
    radiusM:        a.radius_m,
    source:         a.source,
    categoryScores: a.category_scores ?? {},
    poiCounts:      a.poi_counts ?? {},
    dayNight:       a.day_night ?? {},
    sampleSize:     a.sample_size ?? 0,
    confidence:     a.confidence ?? "low",
    computedAt:     a.computed_at ?? null,
  };
}

/** Accepted trip membership: owner (trips.owner_id) or accepted trip_members row. */
async function checkMembership(
  sc: any,
  trip: any,
  userId: string,
): Promise<boolean> {
  if ((trip as any).owner_id === userId) return true;
  const membership = await requireTripMember(sc, (trip as any).id, userId);
  return Boolean(membership);
}

/** Load the caller's stored preferences for a trip; defaults on any failure. */
async function loadPreferences(sc: any, tripId: string, userId: string): Promise<AreaPreferences> {
  try {
    const { data } = await sc
      .from("trip_area_preferences")
      .select("sleep_vs_play, priorities")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return {};
    return {
      sleepVsPlay: ((data as any).sleep_vs_play as AreaPreferences["sleepVsPlay"]) ?? null,
      priorities:  ((data as any).priorities as Record<string, number>) ?? {},
    };
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GET /api/cities/neighborhoods?city=&lat=&lng=
// ---------------------------------------------------------------------------
const CityQuerySchema = z.object({
  city: z.string().min(1).max(200),
  lat:  z.coerce.number().min(-90).max(90),
  lng:  z.coerce.number().min(-180).max(180),
});

router.get("/cities/neighborhoods", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!(await isFlagEnabled(sc, FLAG))) { sendError(res, "feature_disabled"); return; }

  const parsed = CityQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "city, lat and lng are required");
    return;
  }
  const { city, lat, lng } = parsed.data;

  const areas = await refreshCityNeighborhoods(sc, city, lat, lng, { force: false });

  if (areas.length === 0) {
    res.json({ areas: [], reason: "no_data", message: NO_DATA_MESSAGE });
    return;
  }

  res.json({
    city,
    areas: areas.map(toPublicArea),
    disclaimer: DISCLAIMER,
  });
}));

// ---------------------------------------------------------------------------
// PUT /api/trips/:tripId/area-preferences
// ---------------------------------------------------------------------------
const PrioritySchema = z.record(
  z.enum(CATEGORIES),
  z.number().min(0).max(1),
);

const PreferencesSchema = z.object({
  sleepVsPlay: z.enum(["inside", "close", "away"]).nullable().optional(),
  priorities:  PrioritySchema.optional(),
});

router.put("/trips/:tripId/area-preferences", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = PreferencesSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
    return;
  }
  const b = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc.from("trips").select("id, owner_id").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  if (!(await checkMembership(sc, trip, user.id))) {
    sendError(res, "not_member", "You must be an accepted trip member to set area preferences");
    return;
  }

  // Merge with the existing row so a partial PUT doesn't clobber the other field.
  const { data: existing } = await sc
    .from("trip_area_preferences")
    .select("sleep_vs_play, priorities")
    .eq("trip_id", tripId)
    .eq("user_id", user.id)
    .maybeSingle();

  const row = {
    trip_id:       tripId,
    user_id:       user.id,
    sleep_vs_play: b.sleepVsPlay !== undefined
      ? b.sleepVsPlay
      : ((existing as any)?.sleep_vs_play ?? null),
    priorities:    b.priorities !== undefined
      ? b.priorities
      : ((existing as any)?.priorities ?? {}),
    updated_at:    new Date().toISOString(),
  };

  const { data: saved, error } = await sc
    .from("trip_area_preferences")
    .upsert(row, { onConflict: "trip_id,user_id" })
    .select("*")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  const s = (saved as any) ?? row;
  res.json({
    tripId,
    sleepVsPlay: s.sleep_vs_play ?? null,
    priorities:  s.priorities ?? {},
    updatedAt:   s.updated_at ?? row.updated_at,
  });
}));

// ---------------------------------------------------------------------------
// POST /api/trips/:tripId/neighborhood-match
// ---------------------------------------------------------------------------
router.post("/trips/:tripId/neighborhood-match", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!(await isFlagEnabled(sc, FLAG))) { sendError(res, "feature_disabled"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id, destination_city, destination_country, destination_lat, destination_lng")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  if (!(await checkMembership(sc, trip, user.id))) {
    sendError(res, "not_member", "You must be an accepted trip member");
    return;
  }

  const t = trip as any;
  const destLat = typeof t.destination_lat === "number" ? t.destination_lat : null;
  const destLng = typeof t.destination_lng === "number" ? t.destination_lng : null;
  if (!t.destination_city || destLat === null || destLng === null) {
    sendError(res, "invalid_payload", "trip_missing_destination_coords");
    return;
  }

  const prefs = await loadPreferences(sc, tripId, user.id);

  const areas = await refreshCityNeighborhoods(sc, t.destination_city, destLat, destLng, {
    force:   false,
    country: t.destination_country ?? null,
  });

  if (areas.length === 0) {
    res.json({ areas: [], reason: "no_data", message: NO_DATA_MESSAGE });
    return;
  }

  const ranked = rankAreas(areas, prefs);

  // Compass pick: top area, with a "why" built ONLY from its top factors.
  const top = ranked[0];
  const why = top.factors.length > 0
    ? `${top.name} ranks highest for you (${top.matchScore}/100) based on ${top.factors
        .map((f) => f.label.toLowerCase())
        .join(", ")}.`
    : `${top.name} ranks highest for you (${top.matchScore}/100), but no category stood out — treat this as a weak signal.`;

  const compassPick: any = {
    name:       top.name,
    matchScore: top.matchScore,
    why,
    confidence: top.confidence,
  };
  if (top.caveat) compassPick.caveat = top.caveat;

  res.json({
    areas: ranked.map((r) => {
      const out: any = {
        name:           r.name,
        matchScore:     r.matchScore,
        factors:        r.factors,
        categoryScores: r.categoryScores,
        dayNight:       r.dayNight,
        sampleSize:     r.sampleSize,
        confidence:     r.confidence,
      };
      if (r.caveat) out.caveat = r.caveat;
      return out;
    }),
    compassPick,
    disclaimer: DISCLAIMER,
  });
}));

// ---------------------------------------------------------------------------
// POST /api/trips/:tripId/location-check  (no flag — pure math over trip data)
// ---------------------------------------------------------------------------
const LocationCheckSchema = z.object({
  lat:  z.number().min(-90).max(90),
  lng:  z.number().min(-180).max(180),
  name: z.string().max(200).optional(),
});

const GOOD_FIT_KM  = 2.5;
const FAR_KM       = 6;
const MIN_POINTS   = 3;

router.post("/trips/:tripId/location-check", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { tripId } = req.params;
  if (!UUID_RE.test(tripId)) { sendError(res, "invalid_payload", "Invalid tripId"); return; }

  const parsed = LocationCheckSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "lat and lng are required");
    return;
  }
  const { lat, lng, name } = parsed.data;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { data: trip } = await sc
    .from("trips")
    .select("id, owner_id, destination_city")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  if (!(await checkMembership(sc, trip, user.id))) {
    sendError(res, "not_member", "You must be an accepted trip member");
    return;
  }

  // ── Gather located trip points ─────────────────────────────────────────────
  const points: Array<{ lat: number; lng: number }> = [];

  // Plan items: DEFENSIVE — the canonical trip_plan_items schema stores no GPS
  // coordinates, but some deployments carry lat/lng columns. A failing select
  // (unknown column) simply contributes zero points.
  try {
    const { data: planItems, error: planErr } = await sc
      .from("trip_plan_items")
      .select("lat, lng, removed_at")
      .eq("trip_id", tripId);
    if (!planErr) {
      for (const it of (planItems as any[]) ?? []) {
        if (it.removed_at != null) continue;
        if (Number.isFinite(it.lat) && Number.isFinite(it.lng)) {
          points.push({ lat: it.lat, lng: it.lng });
        }
      }
    }
  } catch { /* fail-soft: no plan-item points */ }

  // Saved places (lat/lng are canonical columns here).
  let savedPlaces: Array<{ name: string; lat: number; lng: number }> = [];
  try {
    const { data: placeRows, error: placeErr } = await sc
      .from("trip_saved_places")
      .select("place_name, lat, lng")
      .eq("trip_id", tripId);
    if (!placeErr) {
      savedPlaces = ((placeRows as any[]) ?? [])
        .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
        .map((p) => ({ name: (p.place_name as string) ?? "Saved place", lat: p.lat, lng: p.lng }));
    }
  } catch { /* fail-soft: no saved-place points */ }
  for (const p of savedPlaces) points.push({ lat: p.lat, lng: p.lng });

  // ── Nearest saved places to the candidate location ─────────────────────────
  const nearestSavedPlaces = savedPlaces
    .map((p) => ({ name: p.name, km: Math.round(haversineKm(lat, lng, p.lat, p.lng) * 10) / 10 }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 5);

  // ── Area fit: stored areas only (never triggers a network refresh) ─────────
  let storedAreas: ComputedArea[] = [];
  if ((trip as any).destination_city) {
    try {
      const { data: areaRows } = await sc
        .from("neighborhood_areas")
        .select("*")
        .eq("city_name", (trip as any).destination_city);
      storedAreas = ((areaRows as any[]) ?? []) as ComputedArea[];
    } catch { storedAreas = []; }
  }

  let areaFit: { areaName: string; matchScore?: number } | null = null;
  if (storedAreas.length > 0) {
    let best: ComputedArea | null = null;
    let bestM = Infinity;
    for (const a of storedAreas) {
      const dM = haversineKm(lat, lng, a.center_lat, a.center_lng) * 1000;
      if (dM < bestM) { bestM = dM; best = a; }
    }
    if (best && bestM <= Math.max(best.radius_m ?? 1200, 1800)) {
      areaFit = { areaName: best.name };
      // Personalised score when the caller has (or defaults to) preferences.
      const prefs = await loadPreferences(sc, tripId, user.id);
      const ranked = rankAreas(storedAreas, prefs);
      const match = ranked.find((r) => r.name === best!.name);
      if (match) areaFit.matchScore = match.matchScore;
    }
  }

  // ── Verdict vs center of gravity ───────────────────────────────────────────
  const cog = points.length > 0 ? centerOfGravity(points, storedAreas) : null;
  const distanceToCenterOfGravityKm =
    cog !== null ? Math.round(haversineKm(lat, lng, cog.lat, cog.lng) * 10) / 10 : null;

  let verdict: "good_fit" | "moderate" | "consider_alternatives" | "insufficient_data";
  if (points.length < MIN_POINTS || distanceToCenterOfGravityKm === null) {
    verdict = "insufficient_data";
  } else if (distanceToCenterOfGravityKm <= GOOD_FIT_KM) {
    verdict = "good_fit";
  } else if (distanceToCenterOfGravityKm > FAR_KM) {
    verdict = "consider_alternatives";
  } else {
    verdict = "moderate";
  }

  res.json({
    name: name ?? null,
    distanceToCenterOfGravityKm,
    nearestSavedPlaces,
    areaFit,
    centerOfGravity: cog,
    locatedPoints: points.length,
    verdict,
    thresholdNote:
      `good_fit ≤ ${GOOD_FIT_KM} km from the center of gravity of your ${points.length} located trip points; ` +
      `consider_alternatives > ${FAR_KM} km; insufficient_data below ${MIN_POINTS} located points.`,
  });
}));

export default router;
