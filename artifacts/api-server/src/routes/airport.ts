/**
 * Airport / Layover Mode routes
 *
 * All routes gated by 'airport_mode_enabled' feature flag.
 *
 * GET    /api/airport/search                         — resolve airport by IATA, GPS, or city
 * POST   /api/airport/sessions                       — create layover session
 * PATCH  /api/airport/sessions/:id                   — update session
 * GET    /api/airport/sessions/:id/recommendations   — get rated recommendations
 * GET    /api/airport/sessions/:id/safety            — get overall safety rating
 * POST   /api/airport/sessions/:id/compass           — ask a layover Compass question
 * POST   /api/airport/sessions/:id/plan              — create a layover plan (stub)
 * POST   /api/airport/sessions/:id/return-deadline   — set return deadline reminder
 * POST   /api/airport/sessions/:id/telegraph         — send Telegraph layover suggestion
 * GET    /api/airport/pulse                          — Airport Pulse feed
 * DELETE /api/airport/sessions/:id                   — end/cancel session
 *
 * Admin routes under /api/admin/airport:
 *   POST /api/admin/airport/profiles                 — upsert airport profile
 *   PATCH /api/admin/airport/profiles/:id/buffers    — update buffer defaults
 *   GET  /api/admin/airport/profiles                 — list profiles
 *
 * Privacy: exact GPS NEVER in responses. All location info is city-level only.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError, isAcceptedTripMember, canEditPlan } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
// Capability gates are read through the SHARED fail-closed helper. This file
// used to define its own `isFlagEnabled` under the same name that failed OPEN
// (`if (error) return true; if (data == null) return true;`) as a dev-env
// convenience — the exact inverse of the shared contract, feeding every gate in
// this router. All five flags it reads (airport_mode_enabled, layover_*,
// airport_pulse_enabled) are seeded and enabled in production, so deleting the
// shadow is behaviour-neutral there and only changes the unhealthy-DB case,
// which now stays closed like every other capability gate in the codebase.
import { isFlagEnabled } from "../lib/featureFlags.js";
import { logger } from "../lib/logger.js";
import { resolveMediaForPosts } from "../lib/postMediaResolve.js";
import { isPostPublished } from "../lib/postVisibility.js";
import { nameVisibilitySet, presentedName } from "../lib/publicIdentity.js";
import {
  resolveByIata,
  resolveByGps,
  resolveByCity,
  searchAirports,
  buildFallbackProfile,
  upsertAirportProfile,
} from "../services/airport/AirportProfileService.js";
import {
  createSession,
  updateSession,
  endSession,
  getSession,
  getActiveSession,
  listSessions,
  setShareStatus,
  setReturnReminder,
  expireOldSessions,
  emitLayoverEvent,
  type LayoverSession,
} from "../services/airport/LayoverSessionService.js";
import {
  assess,
  safetyLabel,
  computeWindow,
  adviseLeaving,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  wallTimeToUtc,
  formatLocalTime,
  localDayString,
  localHour,
} from "../services/airport/AirportTime.js";
import { resolveCanonicalLocation } from "../lib/canonicalLocations.js";
import {
  generateRecommendations,
  getRecommendations,
} from "../services/airport/LayoverRecommendationService.js";
import { answerLayoverQuestion } from "../services/airport/LayoverCompassService.js";
import {
  shouldSuggestSafeReturn,
  suggestSafeReturn,
} from "../services/airport/LayoverNotificationService.js";
import { createStamp } from "../services/passport/PassportStampService.js";
import { detectIntent } from "../services/telegraphIntent.js";

import { requireAdmin } from "../lib/requireAdmin.js";

const router = Router();

// ── Airport profile resolution helper ────────────────────────────────────────
/**
 * Resolves airport profile from session.airportId (real DB row with admin-
 * configured buffers), falling back to a defaults profile built from manual
 * fields. Used by safety, compass, return-deadline, and plan endpoints.
 */
async function resolveAirportForSession(sc: any, session: any) {
  if (session.airportId) {
    try {
      const { data } = await sc
        .from("airport_profiles")
        .select("*")
        .eq("id", session.airportId)
        .maybeSingle();
      if (data) {
        return {
          id: (data as any).id,
          iataCode: (data as any).iata_code,
          name: (data as any).name,
          city: (data as any).city,
          country: (data as any).country,
          countryCode: (data as any).country_code,
          timezone: (data as any).timezone ?? "UTC",
          lat: Number((data as any).lat),
          lng: Number((data as any).lng),
          domesticBufferMin: (data as any).domestic_buffer_min ?? 60,
          domesticBufferMax: (data as any).domestic_buffer_max ?? 90,
          internationalBufferMin: (data as any).international_buffer_min ?? 120,
          internationalBufferMax: (data as any).international_buffer_max ?? 180,
          immigrationExtraMin: (data as any).immigration_extra_min ?? 30,
          checkedBagsExtraMin: (data as any).checked_bags_extra_min ?? 15,
          trafficExtraMin: (data as any).traffic_extra_min ?? 20,
          verified: Boolean((data as any).verified),
        };
      }
    } catch { /* fall through to fallback */ }
  }
  return buildFallbackProfile({
    iataCode: session.manualIata    ?? "UNK",
    city:     session.manualCity    ?? "Unknown",
    country:  session.manualCountry ?? "Unknown",
    name:     session.manualAirportName ?? "Unknown Airport",
  });
}

// ── Trip timeline mirror ──────────────────────────────────────────────────────
/**
 * Upsert a single trip_plan_items summary row for a trip-linked session so the
 * layover shows up in the trip timeline / Today / Next Up. Dedupe by
 * (source_type='layover_session', source_id=session.id). Best-effort.
 */
async function mirrorSessionToTrip(
  sc: any,
  client: any,
  session: LayoverSession,
  airport: { city: string; iataCode: string; name: string; timezone: string } | null,
  userId: string,
): Promise<void> {
  if (!session.tripId) return;
  try {
    const member = await isAcceptedTripMember(client, session.tripId, userId);
    if (!member) return;
    const city  = airport?.city && airport.city !== "Unknown" ? airport.city : session.manualCity ?? "stopover city";
    const iata  = airport?.iataCode && airport.iataCode !== "UNK" ? airport.iataCode : session.manualIata ?? "";
    const title = iata ? `Layover in ${city} (${iata})` : `Layover in ${city}`;
    const tz    = airport?.timezone ?? "UTC";
    const record: Record<string, unknown> = {
      trip_id:       session.tripId,
      creator_id:    userId,
      title,
      category:      "layover",
      status:        "confirmed",
      source_type:   "layover_session",
      source_id:     session.id,
      day_date:      localDayString(tz, new Date(session.arrivalTime)),
      starts_at:     session.arrivalTime,
      ends_at:       session.departureTime,
      location_name: airport?.name ?? session.manualAirportName ?? null,
      updated_at:    new Date().toISOString(),
    };
    const { data: existing } = await sc
      .from("trip_plan_items")
      .select("id")
      .eq("trip_id", session.tripId)
      .eq("source_type", "layover_session")
      .eq("source_id", session.id)
      .is("removed_at", null)
      .maybeSingle();
    if ((existing as any)?.id) {
      await sc.from("trip_plan_items").update(record).eq("id", (existing as any).id);
    } else {
      await sc.from("trip_plan_items").insert(record);
    }
  } catch { /* best-effort */ }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const searchSchema = z.object({
  iata:  z.string().max(4).optional(),
  lat:   z.coerce.number().min(-90).max(90).optional(),
  lng:   z.coerce.number().min(-180).max(180).optional(),
  city:  z.string().max(100).optional(),
  q:     z.string().max(100).optional(),
});

const WALL_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/;

const createSessionSchema = z.object({
  airportId:           z.string().uuid().optional().nullable(),
  /** Preferred airport reference: IATA code from the airport picker. */
  iata:                z.string().min(2).max(4).optional().nullable(),
  tripId:              z.string().uuid().optional().nullable(),
  /** UTC instants (legacy path). Optional when *Local wall times are sent. */
  arrivalTime:         z.string().datetime().optional(),
  departureTime:       z.string().datetime().optional(),
  boardingTime:        z.string().datetime().optional().nullable(),
  /** Airport-local wall times ("YYYY-MM-DDTHH:mm") — converted server-side. */
  arrivalLocal:        z.string().regex(WALL_TIME_RE).optional().nullable(),
  departureLocal:      z.string().regex(WALL_TIME_RE).optional().nullable(),
  boardingLocal:       z.string().regex(WALL_TIME_RE).optional().nullable(),
  flightType:          z.enum(["domestic", "international"]).optional().default("domestic"),
  immigrationRequired: z.boolean().optional().default(false),
  checkedBags:         z.boolean().optional().default(false),
  loungeAccess:        z.boolean().optional().default(false),
  wantsToLeave:        z.boolean().optional().default(true),
  comfortLevel:        z.enum(["safe_only", "moderate", "adventurous"]).optional().default("moderate"),
  vibeChips:           z.array(z.string().max(30)).max(10).optional().default([]),
  manualAirportName:   z.string().max(200).optional().nullable(),
  manualCity:          z.string().max(100).optional().nullable(),
  manualCountry:       z.string().max(100).optional().nullable(),
  manualIata:          z.string().max(4).optional().nullable(),
});

const updateSessionSchema = createSessionSchema.partial().omit({ arrivalTime: true, departureTime: true }).extend({
  arrivalTime:   z.string().datetime().optional(),
  departureTime: z.string().datetime().optional(),
});

const compassSchema = z.object({
  question: z.string().min(1).max(500),
});

const returnDeadlineSchema = z.object({
  minutesBefore: z.number().int().min(5).max(120).optional().default(30),
});

const telegraphLayoverSchema = z.object({
  message: z.string().min(1).max(600),
});

const adminProfileSchema = z.object({
  iataCode:               z.string().min(2).max(4).toUpperCase(),
  name:                   z.string().max(200),
  city:                   z.string().max(100),
  country:                z.string().max(100),
  countryCode:            z.string().max(3),
  timezone:               z.string().max(50).optional(),
  lat:                    z.number().min(-90).max(90),
  lng:                    z.number().min(-180).max(180),
  domesticBufferMin:      z.number().int().min(30).max(240).optional(),
  domesticBufferMax:      z.number().int().min(30).max(240).optional(),
  internationalBufferMin: z.number().int().min(60).max(360).optional(),
  internationalBufferMax: z.number().int().min(60).max(360).optional(),
  immigrationExtraMin:    z.number().int().min(0).max(120).optional(),
  checkedBagsExtraMin:    z.number().int().min(0).max(60).optional(),
  trafficExtraMin:        z.number().int().min(0).max(60).optional(),
  verified:               z.boolean().optional(),
});

// ── GET /api/airport/search ───────────────────────────────────────────────────

router.get("/airport/search", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ airports: [], featureEnabled: false });
    return;
  }

  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid query");
    return;
  }
  const { iata, lat, lng, city, q } = parsed.data;

  let results: Awaited<ReturnType<typeof searchAirports>> = [];
  if (q) {
    results = await searchAirports(sc, q);
  } else if (iata) {
    const r = await resolveByIata(sc, iata);
    results = r ? [r] : [];
  } else if (lat != null && lng != null) {
    const r = await resolveByGps(sc, lat, lng);
    results = r ? [r] : [];
  } else if (city) {
    const r = await resolveByCity(sc, city);
    results = r ? [r] : [];
  }

  res.json({ airports: results, featureEnabled: true });
});

// ── POST /api/airport/sessions ────────────────────────────────────────────────

router.post("/airport/sessions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled", "Airport / Layover Mode is not yet enabled");
    return;
  }

  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const p = parsed.data;

  // ── Resolve the airport up front (picker IATA, explicit id, or manual) ──────
  let airport: Awaited<ReturnType<typeof resolveByIata>> = null;
  if (p.airportId) {
    const resolved = await resolveAirportForSession(sc, { airportId: p.airportId });
    airport = resolved.iataCode === "UNK" ? null : resolved;
  }
  if (!airport && (p.iata ?? p.manualIata)) {
    airport = await resolveByIata(sc, (p.iata ?? p.manualIata)!);
  }
  if (!airport && p.manualCity) {
    airport = await resolveByCity(sc, p.manualCity);
  }

  // Ensure a DB profile row exists so the session can reference it (static and
  // fallback resolutions carry id=null). Best-effort: manual_* fields remain.
  if (airport && !airport.id) {
    const up = await upsertAirportProfile(sc, user.id, airport as any);
    if (up.ok && up.id) airport = { ...airport, id: up.id };
  }

  // ── Times: prefer airport-local wall times, converted in the airport's tz ───
  // Wall times without a resolved airport would silently be converted as UTC
  // and shift every downstream hard-return computation by hours — reject.
  if ((p.arrivalLocal || p.departureLocal || p.boardingLocal) && !airport) {
    sendError(res, "invalid_payload", "Pick an airport (or pass its IATA code) to use local wall times — the timezone must be known");
    return;
  }
  const tz = airport?.timezone ?? "UTC";
  let arrivalIso   = p.arrivalTime   ?? null;
  let departureIso = p.departureTime ?? null;
  let boardingIso  = p.boardingTime  ?? null;
  if (p.arrivalLocal) {
    const d = wallTimeToUtc(tz, p.arrivalLocal);
    if (!d) { sendError(res, "invalid_payload", "arrivalLocal is not a valid local time"); return; }
    arrivalIso = d.toISOString();
  }
  if (p.departureLocal) {
    const d = wallTimeToUtc(tz, p.departureLocal);
    if (!d) { sendError(res, "invalid_payload", "departureLocal is not a valid local time"); return; }
    departureIso = d.toISOString();
  }
  if (p.boardingLocal) {
    const d = wallTimeToUtc(tz, p.boardingLocal);
    if (!d) { sendError(res, "invalid_payload", "boardingLocal is not a valid local time"); return; }
    boardingIso = d.toISOString();
  }

  if (!arrivalIso || !departureIso) {
    sendError(res, "invalid_payload", "Arrival and departure times are required");
    return;
  }
  const arrivalMs   = new Date(arrivalIso).getTime();
  const departureMs = new Date(departureIso).getTime();
  if (departureMs <= arrivalMs) {
    sendError(res, "invalid_payload", "Departure must be after arrival");
    return;
  }
  if (departureMs <= Date.now()) {
    sendError(res, "invalid_payload", "This layover has already departed — set a departure time in the future");
    return;
  }
  if (departureMs - arrivalMs > 48 * 3_600_000) {
    sendError(res, "invalid_payload", "A layover window cannot exceed 48 hours");
    return;
  }
  if (boardingIso) {
    const boardingMs = new Date(boardingIso).getTime();
    if (boardingMs <= arrivalMs || boardingMs > departureMs) {
      sendError(res, "invalid_payload", "Boarding time must fall between arrival and departure");
      return;
    }
  }

  // ── Universal location bridge: canonical city row (best-effort) ─────────────
  let canonicalCityId: string | null = null;
  if (airport && airport.city && airport.city !== "Unknown") {
    try {
      const r = await resolveCanonicalLocation(sc, {
        id:          `layover-city/${airport.iataCode}`,
        type:        "city",
        name:        airport.city,
        country:     airport.country,
        countryCode: airport.countryCode,
        lat:         airport.lat,
        lng:         airport.lng,
      });
      canonicalCityId = r.canonicalId ?? null;
    } catch { /* non-fatal */ }
  }

  const session = await createSession(sc, {
    userId:              user.id,
    airportId:           airport?.id ?? null,
    tripId:              p.tripId ?? null,
    arrivalTime:         arrivalIso,
    departureTime:       departureIso,
    boardingTime:        boardingIso,
    flightType:          p.flightType,
    immigrationRequired: p.immigrationRequired,
    checkedBags:         p.checkedBags,
    loungeAccess:        p.loungeAccess,
    wantsToLeave:        p.wantsToLeave,
    comfortLevel:        p.comfortLevel,
    vibeChips:           p.vibeChips,
    manualAirportName:   p.manualAirportName ?? airport?.name ?? null,
    manualCity:          p.manualCity ?? airport?.city ?? null,
    manualCountry:       p.manualCountry ?? airport?.country ?? null,
    manualIata:          p.manualIata ?? airport?.iataCode ?? null,
    canonicalCityId,
  });
  if (!session) {
    sendError(res, "db_error", "Failed to create layover session", { exposeDetail: true });
    return;
  }

  // Suggest Safe Return if context is risky — night check in the airport's tz.
  const localArrivalHour = localHour(tz, new Date(arrivalIso));
  const isNight = localArrivalHour >= 22 || localArrivalHour < 6;
  const { suggest, reasons } = shouldSuggestSafeReturn(session, {
    isNightLayover:    isNight,
    isLeavingAirport:  session.wantsToLeave,
    isNewCountry:      false, // would check profiles.home_country vs airport.country
  });
  if (suggest) {
    await suggestSafeReturn(sc, session, reasons);
  }

  // Passport seam: emit layover stamp
  void (async () => {
    try {
      const { data: flagRow } = await sc.from("feature_flags").select("enabled").eq("flag", "passport_stamps_enabled").maybeSingle();
      if ((flagRow as any)?.enabled) {
        const airportCity = (airport?.city && airport.city !== "Unknown" ? airport.city : null) ?? session.manualCity ?? null;
        if (airportCity) {
          await createStamp(sc, {
            userId: user.id, stampType: "activity",
            city: airportCity, tripId: session.tripId ?? null,
            sourceType: "layover_session", verificationLevel: "checkin",
          });
          await emitLayoverEvent(sc, session.id, user.id, "passport_seam_emitted", { type: "layover_start" });
        }
      }
    } catch (err) {
      // Best-effort seam, but a silently lost layover stamp is a product-integrity
      // gap — make the failure visible in the server log.
      logger.warn({ err, sessionId: session.id, userId: user.id }, "layover passport seam failed — stamp not emitted");
    }
  })();

  // Trip timeline mirror (best-effort)
  await mirrorSessionToTrip(sc, auth.client, session, airport, user.id);

  res.status(201).json({ ok: true, session, safeReturnSuggested: suggest, safeReturnReasons: reasons });
});

// ── PATCH /api/airport/sessions/:id ──────────────────────────────────────────

router.patch("/airport/sessions/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = updateSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const session = await updateSession(sc, req.params.id, user.id, parsed.data);
  if (!session) {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }

  // Keep the trip timeline mirror in sync with the updated window.
  const airportForMirror = await resolveAirportForSession(sc, session);
  await mirrorSessionToTrip(
    sc, auth.client, session,
    airportForMirror.iataCode === "UNK" ? null : airportForMirror,
    user.id,
  );

  res.json({ ok: true, session });
});

// ── GET /api/airport/sessions/:id/recommendations ────────────────────────────

router.get("/airport/sessions/:id/recommendations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ recommendations: [], featureEnabled: false }); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  // Resolve airport profile
  const airportId = session.airportId;
  let airport = null;
  if (airportId) {
    const { data } = await sc.from("airport_profiles").select("*").eq("id", airportId).maybeSingle();
    if (data) {
      airport = {
        id: (data as any).id, iataCode: (data as any).iata_code, name: (data as any).name,
        city: (data as any).city, country: (data as any).country, countryCode: (data as any).country_code,
        timezone: (data as any).timezone ?? "UTC", lat: Number((data as any).lat), lng: Number((data as any).lng),
        domesticBufferMin: (data as any).domestic_buffer_min ?? 60,
        domesticBufferMax: (data as any).domestic_buffer_max ?? 90,
        internationalBufferMin: (data as any).international_buffer_min ?? 120,
        internationalBufferMax: (data as any).international_buffer_max ?? 180,
        immigrationExtraMin: (data as any).immigration_extra_min ?? 30,
        checkedBagsExtraMin: (data as any).checked_bags_extra_min ?? 15,
        trafficExtraMin: (data as any).traffic_extra_min ?? 20,
        verified: Boolean((data as any).verified),
      };
    }
  }

  if (!airport) {
    airport = buildFallbackProfile({
      iataCode:    session.manualIata    ?? "UNK",
      city:        session.manualCity    ?? "Unknown",
      country:     session.manualCountry ?? "Unknown",
      name:        session.manualAirportName ?? "Unknown Airport",
    });
  }

  const isSafetyEnabled = await isFlagEnabled(sc, "layover_safety_engine_enabled");

  // Try persisted recs first; regenerate if empty or safety engine is enabled
  let recs = await getRecommendations(sc, session.id);
  if (recs.length === 0 || isSafetyEnabled) {
    recs = await generateRecommendations(sc, airport, session);
  }

  res.json({ recommendations: recs, featureEnabled: true });
});

// ── GET /api/airport/sessions/:id/safety ─────────────────────────────────────

router.get("/airport/sessions/:id/safety", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ featureEnabled: false }); return;
  }

  if (!await isFlagEnabled(sc, "layover_safety_engine_enabled")) {
    res.json({ featureEnabled: false }); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const airport = await resolveAirportForSession(sc, session);

  // Assess a generic "leaving airport" activity to get overall safety
  const a = assess(airport, session, {
    title:          "Leaving airport",
    travelTimeMin:  20,
    activityTimeMin: 30,
    insideAirport:  false,
  });

  const window = computeWindow(airport, session);
  const advice = adviseLeaving(airport, session, window);

  res.json({
    featureEnabled:  true,
    overallRating:   a.rating,
    overallLabel:    safetyLabel(a.rating),
    availableMinutes: a.availableMinutes,
    usableMinutes:   window.usableMinutes,
    returnBufferMin: a.returnBufferMin,
    hardReturnTime:  window.hardReturnTime.toISOString(),
    warningReason:   a.warningReason,
    breakdown:       a.breakdown,
    layoverMinutes:  session.layoverMinutes,
    tier:            window.tier,
    tierLabel:       window.tierLabel,
    advice,
  });
});

// ── POST /api/airport/sessions/:id/compass ────────────────────────────────────

router.post("/airport/sessions/:id/compass", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled", "Airport Mode is not enabled"); return;
  }
  if (!await isFlagEnabled(sc, "layover_compass_enabled")) {
    sendError(res, "feature_disabled", "Layover Compass is not yet enabled"); return;
  }

  const parsed = compassSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", "question is required (max 500 chars)");
    return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const airport = await resolveAirportForSession(sc, session);

  const answer = await answerLayoverQuestion(sc, { question: parsed.data.question, session, airport });

  await emitLayoverEvent(sc, session.id, user.id, "compass_question_asked", {
    involvesLeaving: answer.involvesLeaving,
  });

  res.json({ ok: true, ...answer });
});

// ── POST /api/airport/sessions/:id/plan ──────────────────────────────────────

const layoverPlanSchema = z.object({
  title:        z.string().min(1).max(200),
  tripId:       z.string().uuid("tripId must be a valid UUID"),
  startsAt:     z.string().datetime().optional().nullable(),
  locationName: z.string().max(300).optional().nullable(),
  city:         z.string().max(100).optional().nullable(),
  notes:        z.string().max(1000).optional().nullable(),
});

router.post("/airport/sessions/:id/plan", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user, client } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return;
  }
  if (!await isFlagEnabled(sc, "layover_plans_enabled")) {
    sendError(res, "feature_disabled", "Layover plan creation is not yet enabled"); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const parsed = layoverPlanSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const tripId = parsed.data.tripId;

  // Caller must be an accepted trip member with plan edit permission
  const member = await isAcceptedTripMember(client, tripId, user.id);
  if (!member) { sendError(res, "not_member", "You must be an accepted trip member to add items"); return; }
  const permitted = await canEditPlan(client, tripId, user.id);
  if (permitted === null) { sendError(res, "not_found", "Trip not found"); return; }
  if (!permitted) { sendError(res, "forbidden", "You don't have permission to add items to this plan"); return; }

  const { data: item, error } = await sc.from("trip_plan_items").insert({
    trip_id:       tripId,
    creator_id:    user.id,
    title:         parsed.data.title,
    starts_at:     parsed.data.startsAt ?? null,
    location_name: parsed.data.locationName ?? parsed.data.city ?? session.manualCity ?? null,
    notes:         parsed.data.notes ?? null,
    category:      "layover",
    source_type:   "layover_activity",
    source_id:     `${session.id}:${Date.now()}`,
  }).select("id").maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }

  await emitLayoverEvent(sc, session.id, user.id, "plan_created", { planItemId: (item as any)?.id });

  res.status(201).json({ ok: true, planItemId: (item as any)?.id });
});

// ── POST /api/airport/sessions/:id/return-deadline ───────────────────────────

router.post("/airport/sessions/:id/return-deadline", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = returnDeadlineSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload"); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const airport = await resolveAirportForSession(sc, session);

  const window     = computeWindow(airport, session);
  const hardReturn = window.hardReturnTime;
  const remindAt   = new Date(hardReturn.getTime() - parsed.data.minutesBefore * 60000);

  // Persist the reminder instant so the client can (re)schedule local
  // notifications after restarts, and other surfaces can render it.
  const saved = await setReturnReminder(sc, session.id, user.id, remindAt.toISOString());
  if (!saved) { sendError(res, "db_error", "Could not save the reminder", { exposeDetail: true }); return; }

  await emitLayoverEvent(sc, session.id, user.id, "return_deadline_set", {
    minutesBefore: parsed.data.minutesBefore,
    hardReturnTime: hardReturn.toISOString(),
    reminderAt: remindAt.toISOString(),
  });

  res.json({
    ok: true,
    hardReturnTime: hardReturn.toISOString(),
    hardReturnLocal: formatLocalTime(airport.timezone, hardReturn),
    reminderAt: remindAt.toISOString(),
    bufferMinutes: window.returnBufferMin,
    reminderMinutesBefore: parsed.data.minutesBefore,
  });
});

// ── POST /api/airport/sessions/:id/telegraph ─────────────────────────────────

router.post("/airport/sessions/:id/telegraph", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const parsed = telegraphLayoverSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload"); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  // Detect intent — layover messages get a layover_activity intent
  const intent = detectIntent(parsed.data.message);

  // Resolve a real conversation to open: the trip's chat thread when this
  // layover is linked to a trip the user belongs to.
  let threadId: string | null = null;
  if (session.tripId) {
    try {
      const member = await isAcceptedTripMember(auth.client, session.tripId, user.id);
      if (member) {
        const { data: thread } = await sc
          .from("message_threads")
          .select("id")
          .eq("thread_type", "trip")
          .eq("trip_id", session.tripId)
          .maybeSingle();
        threadId = (thread as any)?.id ?? null;
      }
    } catch { /* thread stays null */ }
  }

  const airport = await resolveAirportForSession(sc, session);

  // Emit Telegraph suggestion event (no private location in payload)
  await emitLayoverEvent(sc, session.id, user.id, "telegraph_suggestion_sent", {
    intent:   intent?.intent ?? "layover_activity",
    city:     airport.city !== "Unknown" ? airport.city : session.manualCity ?? null,
    threadId,
    // NOTE: no coords, no neighborhood — city-level only
  });

  res.json({
    ok: true,
    intent: intent?.intent ?? "layover_activity",
    confidence: intent?.confidence ?? 0.7,
    city: airport.city !== "Unknown" ? airport.city : session.manualCity ?? null,
    threadId,
  });
});

// ── Session listing, overview & dashboard support ─────────────────────────────

function publicAirport(a: any) {
  return {
    id:          a.id ?? null,
    iataCode:    a.iataCode,
    name:        a.name,
    city:        a.city,
    country:     a.country,
    countryCode: a.countryCode ?? null,
    timezone:    a.timezone ?? "UTC",
    lat:         a.lat ?? null,
    lng:         a.lng ?? null,
    verified:    Boolean(a.verified),
  };
}

function serializeWindow(w: ReturnType<typeof computeWindow>) {
  return {
    ...w,
    hardReturnTime:  w.hardReturnTime.toISOString(),
    earliestOutTime: w.earliestOutTime.toISOString(),
  };
}

function stopRowToJson(row: any) {
  return {
    id:               row.id,
    title:            row.title,
    description:      row.description ?? null,
    stopOrder:        row.stop_order ?? 0,
    durationMin:      row.duration_min ?? 30,
    travelMin:        row.travel_min ?? 0,
    placeId:          row.place_id ?? null,
    recommendationId: row.recommendation_id ?? null,
    lat:              row.lat != null ? Number(row.lat) : null,
    lng:              row.lng != null ? Number(row.lng) : null,
    locationLabel:    row.location_label ?? null,
    insideAirport:    Boolean(row.inside_airport),
    source:           row.source ?? "user",
  };
}

async function loadStops(sc: any, sessionId: string): Promise<any[]> {
  try {
    const { data } = await sc
      .from("layover_plan_stops")
      .select("*")
      .eq("session_id", sessionId)
      .order("stop_order", { ascending: true })
      .order("created_at", { ascending: true });
    return (data ?? []).map(stopRowToJson);
  } catch {
    return [];
  }
}

/** Does the planned itinerary fit inside the usable window? */
function computePlanFit(window: ReturnType<typeof computeWindow>, stops: any[]) {
  const totalPlannedMin = stops.reduce(
    (sum, s) => sum + (s.durationMin ?? 0) + (s.travelMin ?? 0), 0,
  );
  // Approximate the ride back as the travel time of the last outside stop.
  const lastOutside = [...stops].reverse().find((s) => !s.insideAirport);
  const returnTravelMin = lastOutside ? (lastOutside.travelMin ?? 0) : 0;
  const neededMin = totalPlannedMin + returnTravelMin;
  return {
    totalPlannedMin,
    returnTravelMin,
    neededMin,
    usableMinutes: window.usableMinutes,
    fitsWindow:    neededMin <= window.usableMinutes,
    overflowMin:   Math.max(0, neededMin - window.usableMinutes),
    backByTime:    window.hardReturnTime.toISOString(),
  };
}

/**
 * Other travelers with an active, opted-in layover in the same city.
 * City-level only, block-filtered both directions, fail-closed to empty.
 */
async function cityPresence(
  sc: any,
  userId: string,
  city: string | null,
): Promise<{ count: number; travelers: Array<{ id: string; handle: string | null; name: string | null; avatarUrl: string | null }> }> {
  const empty = { count: 0, travelers: [] as Array<{ id: string; handle: string | null; name: string | null; avatarUrl: string | null }> };
  if (!city || city === "Unknown") return empty;
  try {
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await sc
      .from("layover_sessions")
      .select("user_id, manual_city, airport_profiles(city)")
      .eq("status", "active")
      .eq("share_city_status", true)
      .neq("user_id", userId)
      .gt("departure_time", nowIso)
      .limit(100);
    if (error) return empty;

    const target = city.trim().toLowerCase();
    const userIds: string[] = Array.from(new Set(
      ((rows ?? []) as any[])
        .filter((r: any) => {
          const c = (r.airport_profiles?.city ?? r.manual_city ?? "").trim().toLowerCase();
          return c === target;
        })
        .map((r: any) => r.user_id as string),
    ));
    if (userIds.length === 0) return empty;

    // Exclude blocked users in both directions — fail closed on error.
    const { data: blockRows, error: blockErr } = await sc
      .from("blocks")
      .select("blocker_id, blocked_id")
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
    if (blockErr) return empty;
    const excluded = new Set<string>();
    for (const b of (blockRows ?? []) as any[]) {
      excluded.add(b.blocker_id === userId ? b.blocked_id : b.blocker_id);
    }
    const visible = userIds.filter((id) => !excluded.has(id));
    if (visible.length === 0) return empty;

    let travelers: Array<{ id: string; handle: string | null; name: string | null; avatarUrl: string | null }> = [];
    try {
      const shown = visible.slice(0, 6);
      const { data: profiles } = await sc
        .from("profiles")
        .select("id, handle, name, avatar_url")
        .in("id", shown);
      const allowedNames = await nameVisibilitySet(sc, shown);
      travelers = ((profiles ?? []) as any[]).map((p) => ({
        id: p.id,
        handle: p.handle ?? null,
        name: (p.id === userId || allowedNames.has(p.id as string)) ? (p.name ?? null) : null,
        avatarUrl: p.avatar_url ?? null,
      }));
    } catch { /* count-only */ }

    return { count: visible.length, travelers };
  } catch {
    return empty;
  }
}

// ── GET /api/airport/sessions ─────────────────────────────────────────────────

router.get("/airport/sessions", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ sessions: [], featureEnabled: false }); return;
  }

  const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
  const status = ["active", "completed", "cancelled", "expired"].includes(statusParam ?? "")
    ? statusParam as "active" | "completed" | "cancelled" | "expired"
    : undefined;

  if (status === "active") await expireOldSessions(sc);
  const sessions = await listSessions(sc, user.id, status);
  res.json({ sessions, featureEnabled: true });
});

// ── GET /api/airport/sessions/active ──────────────────────────────────────────

router.get("/airport/sessions/active", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ session: null, featureEnabled: false }); return;
  }

  await expireOldSessions(sc);
  const session = await getActiveSession(sc, user.id);
  if (!session) { res.json({ session: null, featureEnabled: true }); return; }

  const airport = await resolveAirportForSession(sc, session);
  res.json({
    session,
    airport: publicAirport(airport),
    featureEnabled: true,
  });
});

// ── GET /api/airport/sessions/:id/overview ────────────────────────────────────
// One-shot dashboard payload: session + airport + window + tier + leave advice
// + plan stops + fit + sharing/presence + localized times.

router.get("/airport/sessions/:id/overview", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ featureEnabled: false }); return;
  }

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const airport = await resolveAirportForSession(sc, session);
  const window  = computeWindow(airport, session);
  const advice  = adviseLeaving(airport, session, window);
  const stops   = await loadStops(sc, session.id);
  const planFit = computePlanFit(window, stops);
  const tz      = airport.timezone ?? "UTC";
  const now     = new Date();

  const presence = session.shareCityStatus
    ? await cityPresence(sc, user.id, airport.city !== "Unknown" ? airport.city : session.manualCity)
    : { count: 0, travelers: [] };

  res.json({
    ok: true,
    featureEnabled: true,
    session,
    airport: publicAirport(airport),
    window: serializeWindow(window),
    advice,
    stops,
    planFit,
    share: {
      enabled: session.shareCityStatus,
      othersInCity: presence.count,
    },
    returnReminderAt: session.returnReminderAt,
    localTimes: {
      timezone:       tz,
      airportNow:     formatLocalTime(tz, now),
      airportToday:   localDayString(tz, now),
      arrivalLocal:   formatLocalTime(tz, new Date(session.arrivalTime)),
      arrivalDay:     localDayString(tz, new Date(session.arrivalTime)),
      departureLocal: formatLocalTime(tz, new Date(session.departureTime)),
      departureDay:   localDayString(tz, new Date(session.departureTime)),
      boardingLocal:  session.boardingTime ? formatLocalTime(tz, new Date(session.boardingTime)) : null,
      hardReturnLocal: formatLocalTime(tz, window.hardReturnTime),
    },
  });
});

// ── Mini-itinerary plan stops ─────────────────────────────────────────────────

const stopCreateSchema = z.object({
  title:         z.string().min(1).max(200),
  description:   z.string().max(500).optional().nullable(),
  durationMin:   z.number().int().min(5).max(720),
  travelMin:     z.number().int().min(0).max(240).optional().default(0),
  locationLabel: z.string().max(300).optional().nullable(),
  insideAirport: z.boolean().optional().default(false),
  lat:           z.number().min(-90).max(90).optional().nullable(),
  lng:           z.number().min(-180).max(180).optional().nullable(),
  placeId:       z.string().uuid().optional().nullable(),
});
const stopUpdateSchema = stopCreateSchema.partial();
const MAX_STOPS = 12;

/** Shared guard: flag on, session exists & owned. Returns null after replying. */
async function requireOwnedSession(req: any, res: any): Promise<{ sc: any; user: any; session: LayoverSession } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { user } = auth;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return null;
  }
  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return null; }
  return { sc, user, session };
}

async function respondWithStops(res: any, sc: any, session: LayoverSession) {
  const airport = await resolveAirportForSession(sc, session);
  const window  = computeWindow(airport, session);
  const stops   = await loadStops(sc, session.id);
  res.json({ ok: true, stops, planFit: computePlanFit(window, stops) });
}

router.get("/airport/sessions/:id/stops", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  await respondWithStops(res, ctx.sc, ctx.session);
});

router.post("/airport/sessions/:id/stops", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;
  if (!await isFlagEnabled(sc, "layover_plans_enabled")) {
    sendError(res, "feature_disabled", "Layover plans are not yet enabled"); return;
  }

  const parsed = stopCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid stop");
    return;
  }

  const existing = await loadStops(sc, session.id);
  if (existing.length >= MAX_STOPS) {
    sendError(res, "invalid_payload", `A layover plan can have at most ${MAX_STOPS} stops`);
    return;
  }

  const { error } = await sc.from("layover_plan_stops").insert({
    session_id:     session.id,
    title:          parsed.data.title,
    description:    parsed.data.description ?? null,
    stop_order:     existing.length,
    duration_min:   parsed.data.durationMin,
    travel_min:     parsed.data.travelMin,
    location_label: parsed.data.locationLabel ?? null,
    inside_airport: parsed.data.insideAirport,
    lat:            parsed.data.lat ?? null,
    lng:            parsed.data.lng ?? null,
    place_id:       parsed.data.placeId ?? null,
    source:         "user",
  });
  if (error) { sendError(res, "db_error", error.message); return; }

  await emitLayoverEvent(sc, session.id, user.id, "plan_stop_added", { title: parsed.data.title });
  await respondWithStops(res, sc, session);
});

router.post("/airport/sessions/:id/stops/from-recommendation", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;
  if (!await isFlagEnabled(sc, "layover_plans_enabled")) {
    sendError(res, "feature_disabled", "Layover plans are not yet enabled"); return;
  }

  const recId = typeof req.body?.recommendationId === "string" ? req.body.recommendationId : null;
  if (!recId) { sendError(res, "invalid_payload", "recommendationId is required"); return; }

  const { data: rec } = await sc
    .from("layover_recommendations")
    .select("*")
    .eq("id", recId)
    .eq("session_id", session.id)
    .maybeSingle();
  if (!rec) { sendError(res, "not_found", "Recommendation not found for this session"); return; }

  const existing = await loadStops(sc, session.id);
  if (existing.length >= MAX_STOPS) {
    sendError(res, "invalid_payload", `A layover plan can have at most ${MAX_STOPS} stops`);
    return;
  }
  if (existing.some((s) => s.recommendationId === recId)) {
    sendError(res, "invalid_payload", "This recommendation is already in your plan");
    return;
  }

  const { error } = await sc.from("layover_plan_stops").insert({
    session_id:        session.id,
    title:             (rec as any).title,
    description:       (rec as any).description ?? null,
    stop_order:        existing.length,
    duration_min:      Math.min(720, Math.max(5, (rec as any).activity_time_min ?? 30)),
    travel_min:        Math.min(240, Math.max(0, (rec as any).travel_time_min ?? 0)),
    location_label:    (rec as any).location_label ?? null,
    inside_airport:    Boolean((rec as any).inside_airport),
    place_id:          (rec as any).place_id ?? null,
    recommendation_id: recId,
    source:            "recommendation",
  });
  if (error) { sendError(res, "db_error", error.message); return; }

  await emitLayoverEvent(sc, session.id, user.id, "plan_stop_added", { recommendationId: recId });
  await respondWithStops(res, sc, session);
});

router.patch("/airport/sessions/:id/stops/:stopId", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  const parsed = stopUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid update");
    return;
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const d = parsed.data;
  if (d.title         !== undefined) patch.title          = d.title;
  if (d.description   !== undefined) patch.description    = d.description;
  if (d.durationMin   !== undefined) patch.duration_min   = d.durationMin;
  if (d.travelMin     !== undefined) patch.travel_min     = d.travelMin;
  if (d.locationLabel !== undefined) patch.location_label = d.locationLabel;
  if (d.insideAirport !== undefined) patch.inside_airport = d.insideAirport;
  if (d.lat           !== undefined) patch.lat            = d.lat;
  if (d.lng           !== undefined) patch.lng            = d.lng;

  const { data: updated, error } = await sc
    .from("layover_plan_stops")
    .update(patch)
    .eq("id", req.params.stopId)
    .eq("session_id", session.id)
    .select("id")
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!updated) { sendError(res, "not_found", "Stop not found"); return; }

  await emitLayoverEvent(sc, session.id, user.id, "plan_stop_updated", { stopId: req.params.stopId });
  await respondWithStops(res, sc, session);
});

router.delete("/airport/sessions/:id/stops/:stopId", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  const { data: removed, error } = await sc
    .from("layover_plan_stops")
    .delete()
    .eq("id", req.params.stopId)
    .eq("session_id", session.id)
    .select("id")
    .maybeSingle();
  if (error) { sendError(res, "db_error", error.message); return; }
  if (!removed) { sendError(res, "not_found", "Stop not found"); return; }

  // Compact remaining order.
  const remaining = await loadStops(sc, session.id);
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].stopOrder !== i) {
      await sc.from("layover_plan_stops").update({ stop_order: i }).eq("id", remaining[i].id);
    }
  }

  await emitLayoverEvent(sc, session.id, user.id, "plan_stop_removed", { stopId: req.params.stopId });
  await respondWithStops(res, sc, session);
});

router.post("/airport/sessions/:id/stops/reorder", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  const orderedIds = Array.isArray(req.body?.orderedIds)
    ? (req.body.orderedIds as unknown[]).filter((x): x is string => typeof x === "string")
    : null;
  if (!orderedIds || orderedIds.length === 0) {
    sendError(res, "invalid_payload", "orderedIds is required"); return;
  }

  const current = await loadStops(sc, session.id);
  const currentIds = new Set(current.map((s) => s.id));
  const sameSet = orderedIds.length === current.length && orderedIds.every((id) => currentIds.has(id));
  if (!sameSet) {
    sendError(res, "invalid_payload", "orderedIds must contain exactly the current stop ids");
    return;
  }

  for (let i = 0; i < orderedIds.length; i++) {
    await sc.from("layover_plan_stops")
      .update({ stop_order: i, updated_at: new Date().toISOString() })
      .eq("id", orderedIds[i])
      .eq("session_id", session.id);
  }

  await emitLayoverEvent(sc, session.id, user.id, "plan_reordered", { count: orderedIds.length });
  await respondWithStops(res, sc, session);
});

// ── PATCH /api/airport/sessions/:id/share ─────────────────────────────────────

router.patch("/airport/sessions/:id/share", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : null;
  if (enabled === null) { sendError(res, "invalid_payload", "enabled (boolean) is required"); return; }

  const updated = await setShareStatus(sc, session.id, user.id, enabled);
  if (!updated) { sendError(res, "db_error", "Could not update sharing", { exposeDetail: true }); return; }

  res.json({ ok: true, session: updated });
});

// ── GET /api/airport/sessions/:id/presence ────────────────────────────────────
// Who else (opted in) has an active layover in the same city. City-level only.

router.get("/airport/sessions/:id/presence", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  // Reciprocity: you only see others when you're sharing too.
  if (!session.shareCityStatus) {
    res.json({ ok: true, sharing: false, count: 0, travelers: [] });
    return;
  }

  const airport = await resolveAirportForSession(sc, session);
  const city = airport.city !== "Unknown" ? airport.city : session.manualCity;
  const presence = await cityPresence(sc, user.id, city ?? null);

  res.json({ ok: true, sharing: true, city: city ?? null, ...presence });
});

// ── GET /api/airport/sessions/:id/buddies ─────────────────────────────────────
// Local buddies available during the layover window — reuses the Rent-a-Buddy
// marketplace (no separate booking path; client links to buddy profiles).

router.get("/airport/sessions/:id/buddies", async (req, res) => {
  const ctx = await requireOwnedSession(req, res);
  if (!ctx) return;
  const { sc, user, session } = ctx;

  const airport = await resolveAirportForSession(sc, session);
  const city = airport.city !== "Unknown" ? airport.city : session.manualCity;
  if (!city) { res.json({ ok: true, city: null, buddies: [] }); return; }

  try {
    const { data: buddies, error } = await sc
      .from("rent_buddy_profiles")
      .select(
        "id, user_id, display_name, tagline, city, country, categories, " +
        "hourly_rate_usd, average_rating, review_count, verified, " +
        "cover_photo_url, buddy_level, available_now",
      )
      .eq("status", "active")
      .ilike("city", `%${city}%`)
      .order("review_count", { ascending: false })
      .limit(12);
    if (error) { res.json({ ok: true, city, buddies: [] }); return; }

    let rows = (buddies ?? []) as any[];
    rows = rows.filter((b) => b.user_id !== user.id);

    // Exclude blocked users in both directions — fail CLOSED on an unreadable
    // blocks table, exactly as the layover-travellers count above does. `error`
    // was not bound here, so a PostgREST rejection (which supabase-js RESOLVES
    // rather than throws, leaving the catch below unreached) produced an empty
    // exclusion set and recommended a blocked person as someone to MEET during
    // the layover. No block set → no buddies.
    try {
      const { data: blockRows, error: blockErr } = await sc
        .from("blocks")
        .select("blocker_id, blocked_id")
        .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);
      if (blockErr) {
        res.json({ ok: true, city, buddies: [] });
        return;
      }
      const excluded = new Set<string>();
      for (const b of (blockRows ?? []) as any[]) {
        excluded.add(b.blocker_id === user.id ? b.blocked_id : b.blocker_id);
      }
      rows = rows.filter((b) => !excluded.has(b.user_id));
    } catch { rows = []; }

    // Availability during the layover's airport-local day(s).
    const tz = airport.timezone ?? "UTC";
    const days: string[] = [];
    const start = new Date(session.arrivalTime).getTime();
    const end   = new Date(session.departureTime).getTime();
    for (let t = start; t <= end; t += 24 * 3_600_000) {
      const day = localDayString(tz, new Date(t));
      if (!days.includes(day)) days.push(day);
    }
    const lastDay = localDayString(tz, new Date(end));
    if (!days.includes(lastDay)) days.push(lastDay);

    const availableSet = new Set<string>();
    if (rows.length > 0) {
      try {
        const { data: avail } = await sc
          .from("rent_buddy_availability")
          .select("buddy_id, date")
          .in("buddy_id", rows.map((b) => b.id))
          .in("date", days);
        for (const a of (avail ?? []) as any[]) availableSet.add(a.buddy_id);
      } catch { /* availability unknown */ }
    }

    const result = rows
      .map((b) => ({
        id:                    b.id,
        userId:                b.user_id,
        displayName:           b.display_name ?? null,
        tagline:               b.tagline ?? null,
        city:                  b.city ?? null,
        country:               b.country ?? null,
        categories:            b.categories ?? [],
        hourlyRateUsd:         b.hourly_rate_usd ?? null,
        averageRating:         b.average_rating ?? null,
        reviewCount:           b.review_count ?? 0,
        verified:              Boolean(b.verified),
        coverPhotoUrl:         b.cover_photo_url ?? null,
        buddyLevel:            b.buddy_level ?? null,
        availableNow:          Boolean(b.available_now),
        availableDuringLayover: availableSet.has(b.id),
      }))
      .sort((a, b) => Number(b.availableDuringLayover) - Number(a.availableDuringLayover))
      .slice(0, 6);

    res.json({ ok: true, city, buddies: result });
  } catch {
    res.json({ ok: true, city, buddies: [] });
  }
});

// ── GET /api/airport/pulse ────────────────────────────────────────────────────

router.get("/airport/pulse", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    res.json({ posts: [], featureEnabled: false }); return;
  }
  if (!await isFlagEnabled(sc, "airport_pulse_enabled")) {
    res.json({ posts: [], featureEnabled: false, reason: "airport_pulse_not_enabled" }); return;
  }

  const schema = z.object({
    city:   z.string().max(100).optional(),
    iata:   z.string().max(4).optional(),
    limit:  z.coerce.number().int().min(1).max(50).optional().default(20),
    before: z.string().datetime().optional(),
  });
  const q = schema.safeParse(req.query);
  if (!q.success) { sendError(res, "invalid_payload"); return; }

  const { city, limit, before } = q.data;
  if (!city) {
    sendError(res, "invalid_payload", "city is required for airport pulse");
    return;
  }

  // Delayed-publish gate (§23/§37). `status='active'` is exactly what POST
  // /posts writes for a delayed-geotag post; the publication state lives in
  // `post_status`, which this query neither selected nor read. Airport Pulse is
  // keyed on location_city, so an ungated read announced "this person is in
  // this city right now" — the one thing delayed geotagging exists to prevent.
  // Same canonical predicate as the Wall / global / Following feeds, applied at
  // the query and again in memory (lib/postVisibility.isPostPublished).
  let query = sc
    .from("posts")
    .select("id, author_id, content, media_urls, created_at, location_city, location_country, post_status, profiles!author_id(id, username, display_name, name, full_name, avatar_url)")
    .eq("status", "active")
    .eq("visibility", "public")
    .eq("post_status", "published")
    .ilike("location_city", `%${city}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  const rows = ((data ?? []) as any[]).filter((r) => isPostPublished(r));
  const authorIds = [...new Set(rows.map((r: any) => r.author_id as string))];
  const allowedNames = await nameVisibilitySet(sc, authorIds);

  // post_media is canonical for storage-backed media; posts.media_urls holds
  // external references only (ruled 2026-08-12). One query per page, then a
  // pure merge — see lib/postMediaResolve.ts.
  const mediaByPost = await resolveMediaForPosts(sc, rows);
  const posts = rows.map((row: any) => {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    const nameAllowed = profile && (profile.id === user.id || allowedNames.has(profile.id as string));
    return {
      id:          row.id,
      authorId:    row.author_id,
      content:     row.content,
      mediaUrls:   mediaByPost.get(row.id) ?? row.media_urls ?? [],
      createdAt:   row.created_at,
      locationCity:    row.location_city ?? null,
      locationCountry: row.location_country ?? null,
      author: profile ? {
        id: profile.id, username: profile.username,
        name: presentedName(profile, Boolean(nameAllowed)), avatarUrl: profile.avatar_url ?? null,
      } : null,
    };
  });

  res.json({ posts, total: posts.length, city, featureEnabled: true });
});

// ── DELETE /api/airport/sessions/:id ─────────────────────────────────────────

router.delete("/airport/sessions/:id", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!await isFlagEnabled(sc, "airport_mode_enabled")) {
    sendError(res, "feature_disabled"); return;
  }

  const session = await endSession(sc, req.params.id, user.id, "cancelled");
  if (!session) {
    sendError(res, "not_found", "Session not found or already closed");
    return;
  }

  // Passport seam: safe layover completed only on explicit completion
  res.json({ ok: true, session });
});

// ── Admin: POST /api/admin/airport/profiles ───────────────────────────────────

router.post("/admin/airport/profiles", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const parsed = adminProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const result = await upsertAirportProfile(sc, userId, parsed.data);
  if (!result.ok) { sendError(res, "db_error", result.error); return; }

  res.status(201).json({ ok: true, id: result.id });
});

// ── Admin: GET /api/admin/airport/profiles ─────────────────────────────────

router.get("/admin/airport/profiles", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data } = await sc.from("airport_profiles").select("*").order("name");
  res.json({ profiles: data ?? [] });
});

// ── Admin: PATCH /api/admin/airport/profiles/:id ────────────────────────────

const patchProfileSchema = z.object({
  name:                    z.string().min(1).max(200).optional(),
  city:                    z.string().max(100).optional(),
  country:                 z.string().max(100).optional(),
  timezone:                z.string().max(50).optional(),
  domesticBufferMin:       z.number().int().min(0).max(240).optional(),
  domesticBufferMax:       z.number().int().min(0).max(360).optional(),
  internationalBufferMin:  z.number().int().min(0).max(360).optional(),
  internationalBufferMax:  z.number().int().min(0).max(480).optional(),
  immigrationExtraMin:     z.number().int().min(0).max(120).optional(),
  checkedBagsExtraMin:     z.number().int().min(0).max(60).optional(),
  trafficExtraMin:         z.number().int().min(0).max(60).optional(),
  verified:                z.boolean().optional(),
});

router.patch("/admin/airport/profiles/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = patchProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.name !== undefined)                   updates.name                    = d.name;
  if (d.city !== undefined)                   updates.city                    = d.city;
  if (d.country !== undefined)                updates.country                 = d.country;
  if (d.timezone !== undefined)               updates.timezone                = d.timezone;
  if (d.domesticBufferMin !== undefined)      updates.domestic_buffer_min     = d.domesticBufferMin;
  if (d.domesticBufferMax !== undefined)      updates.domestic_buffer_max     = d.domesticBufferMax;
  if (d.internationalBufferMin !== undefined) updates.international_buffer_min = d.internationalBufferMin;
  if (d.internationalBufferMax !== undefined) updates.international_buffer_max = d.internationalBufferMax;
  if (d.immigrationExtraMin !== undefined)    updates.immigration_extra_min   = d.immigrationExtraMin;
  if (d.checkedBagsExtraMin !== undefined)    updates.checked_bags_extra_min  = d.checkedBagsExtraMin;
  if (d.trafficExtraMin !== undefined)        updates.traffic_extra_min       = d.trafficExtraMin;
  if (d.verified !== undefined)               updates.verified                = d.verified;
  updates.updated_at = new Date().toISOString();

  if (Object.keys(updates).length === 1) {
    sendError(res, "invalid_payload", "No fields to update");
    return;
  }

  const { data, error } = await sc
    .from("airport_profiles")
    .update(updates)
    .eq("id", req.params.id)
    .select("id, iata_code, name, verified, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Airport profile not found"); return; }
  res.json({ ok: true, profile: data });
});

// ── Admin: DELETE /api/admin/airport/profiles/:id ───────────────────────────

router.delete("/admin/airport/profiles/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { error } = await sc
    .from("airport_profiles")
    .delete()
    .eq("id", req.params.id);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true });
});

// ── Admin: GET /api/admin/airport/sessions ──────────────────────────────────
// Lists active layover sessions for monitoring (city-level only, no GPS).

router.get("/admin/airport/sessions", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limitRaw = parseInt(String(req.query.limit ?? "50"), 10);
  const limit    = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);

  const { data, error } = await sc
    .from("layover_sessions")
    .select(
      "id, user_id, status, flight_type, layover_minutes, manual_city, manual_country, manual_iata, " +
      "wants_to_leave, comfort_level, created_at, arrival_time, departure_time"
    )
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ sessions: data ?? [], count: (data ?? []).length });
});

// ── Admin: GET /api/admin/airport/caution-zones ─────────────────────────────
// Lists system geo_zones associated with airports (is_system=true, airport ref in metadata).

router.get("/admin/airport/caution-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const iata = req.query.iata ? String(req.query.iata).toUpperCase() : undefined;

  let q = sc
    .from("geo_zones")
    .select("id, name, zone_type, center_lat, center_lng, radius_meters, country_code, city, metadata, created_at")
    .eq("is_system", true)
    .order("created_at", { ascending: false });

  if (iata) {
    q = q.contains("metadata", { iata_code: iata });
  }

  const { data, error } = await q;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ zones: data ?? [] });
});

// ── Admin: POST /api/admin/airport/caution-zones ─────────────────────────────

const cautionZoneSchema = z.object({
  iataCode:     z.string().min(3).max(4).toUpperCase(),
  name:         z.string().min(1).max(200),
  zoneType:     z.enum(["safety_zone", "no_go_zone", "caution_zone"]),
  centerLat:    z.number().min(-90).max(90),
  centerLng:    z.number().min(-180).max(180),
  radiusMeters: z.number().int().min(50).max(50000).default(1000),
  countryCode:  z.string().max(2).optional().nullable(),
  city:         z.string().max(100).optional().nullable(),
  note:         z.string().max(1000).optional().nullable(),
});

router.post("/admin/airport/caution-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId } = admin;

  const parsed = cautionZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc.from("geo_zones").insert({
    name:          d.name,
    zone_type:     d.zoneType,
    center_lat:    d.centerLat,
    center_lng:    d.centerLng,
    radius_meters: d.radiusMeters,
    country_code:  d.countryCode ?? null,
    city:          d.city ?? null,
    created_by:    userId,
    is_system:     true,
    metadata:      { iata_code: d.iataCode, note: d.note ?? null, source: "admin" },
  }).select("id").maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ ok: true, id: (data as any)?.id });
});

// ── Admin: DELETE /api/admin/airport/caution-zones/:id ───────────────────────

router.delete("/admin/airport/caution-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { error } = await sc
    .from("geo_zones")
    .delete()
    .eq("id", req.params.id)
    .eq("is_system", true);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true });
});

// ── Admin: GET /api/admin/airport/verified-places ────────────────────────────
// Lists discovery_places near airports awaiting or already verified by admin.

router.get("/admin/airport/verified-places", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const statusFilter = req.query.status ? String(req.query.status) : "pending";
  const city         = req.query.city   ? String(req.query.city)   : undefined;
  const limitRaw     = parseInt(String(req.query.limit ?? "50"), 10);
  const limit        = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);

  let q = sc
    .from("discovery_places")
    .select("id, city, name, place_type, category, blurb, verified, status, created_at, submitted_by")
    .eq("status", statusFilter)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (city) q = q.ilike("city", `%${city}%`);

  const { data, error } = await q;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ places: data ?? [] });
});

// ── Admin: PATCH /api/admin/airport/verified-places/:id ──────────────────────

const verifyPlaceSchema = z.object({
  status:   z.enum(["approved", "rejected", "pending"]).optional(),
  verified: z.boolean().optional(),
  note:     z.string().max(500).optional().nullable(),
});

router.patch("/admin/airport/verified-places/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = verifyPlaceSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const updates: Record<string, unknown> = {};
  if (parsed.data.status   !== undefined) updates.status   = parsed.data.status;
  if (parsed.data.verified !== undefined) updates.verified = parsed.data.verified;
  if (parsed.data.note     !== undefined) updates.note     = parsed.data.note;

  if (Object.keys(updates).length === 0) {
    sendError(res, "invalid_payload", "No fields to update"); return;
  }

  const { data, error } = await sc
    .from("discovery_places")
    .update(updates)
    .eq("id", req.params.id)
    .select("id, status, verified")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Place not found"); return; }
  res.json({ ok: true, place: data });
});

// ── Admin: GET /api/admin/airport/reports ────────────────────────────────────
// Lists layover_recommendations that are flagged for admin review.

router.get("/admin/airport/reports", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limitRaw = parseInt(String(req.query.limit ?? "50"), 10);
  const limit    = isNaN(limitRaw) || limitRaw < 1 ? 50 : Math.min(limitRaw, 200);

  const { data, error } = await sc
    .from("layover_recommendations")
    .select("id, session_id, title, description, rec_type, safety_rating, source, status, created_at")
    .eq("status", "flagged")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ reports: data ?? [], count: (data ?? []).length });
});

// ── Admin: POST /api/admin/airport/reports/:id/resolve ───────────────────────

const resolveReportSchema = z.object({
  action: z.enum(["approve", "hide", "keep_flagged"]),
});

router.post("/admin/airport/reports/:id/resolve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = resolveReportSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", "action must be one of: approve, hide, keep_flagged");
    return;
  }

  const newStatus = parsed.data.action === "approve"
    ? "active"
    : parsed.data.action === "hide"
    ? "hidden"
    : "flagged";

  const { data, error } = await sc
    .from("layover_recommendations")
    .update({ status: newStatus })
    .eq("id", req.params.id)
    .select("id, status")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Recommendation not found"); return; }
  res.json({ ok: true, id: (data as any).id, status: (data as any).status });
});

export default router;
