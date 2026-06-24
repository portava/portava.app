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
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
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
  emitLayoverEvent,
} from "../services/airport/LayoverSessionService.js";
import {
  assess,
  safetyLabel,
} from "../services/airport/LayoverSafetyEngine.js";
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

// ── Admin guard (same pattern as admin.ts) ────────────────────────────────────
async function requireAdminGuard(req: any, res: any): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;
  const { data, error } = await client
    .from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  const sc = getServiceClient() ?? client;
  return { userId: user.id, sc };
}

const router = Router();

// ── Feature flag helper ────────────────────────────────────────────────────────

async function isFlagEnabled(db: ReturnType<typeof getServiceClient>, flag: string): Promise<boolean> {
  if (!db) return false;
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("key", flag)
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const searchSchema = z.object({
  iata:  z.string().max(4).optional(),
  lat:   z.coerce.number().min(-90).max(90).optional(),
  lng:   z.coerce.number().min(-180).max(180).optional(),
  city:  z.string().max(100).optional(),
  q:     z.string().max(100).optional(),
});

const createSessionSchema = z.object({
  airportId:           z.string().uuid().optional().nullable(),
  tripId:              z.string().uuid().optional().nullable(),
  arrivalTime:         z.string().datetime(),
  departureTime:       z.string().datetime(),
  boardingTime:        z.string().datetime().optional().nullable(),
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

  // Validate time window
  const arrivalMs   = new Date(parsed.data.arrivalTime).getTime();
  const departureMs = new Date(parsed.data.departureTime).getTime();
  if (departureMs <= arrivalMs) {
    sendError(res, "invalid_payload", "departureTime must be after arrivalTime");
    return;
  }

  const session = await createSession(sc, { userId: user.id, ...parsed.data });
  if (!session) {
    sendError(res, "db_error", "Failed to create layover session");
    return;
  }

  // Suggest Safe Return if context is risky
  const layoverHour = new Date(parsed.data.arrivalTime).getUTCHours();
  const isNight = layoverHour >= 22 || layoverHour < 6;
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
      const { data: flagRow } = await sc.from("feature_flags").select("enabled").eq("key", "passport_stamps_enabled").maybeSingle();
      if ((flagRow as any)?.enabled) {
        const airportCity = session.manualCity ?? null;
        if (airportCity) {
          await createStamp(sc, {
            userId: user.id, stampType: "activity",
            city: airportCity, tripId: session.tripId ?? null,
            sourceType: "layover_session", verificationLevel: "checkin",
          });
          await emitLayoverEvent(sc, session.id, user.id, "passport_seam_emitted", { type: "layover_start" });
        }
      }
    } catch {}
  })();

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

  const session = await getSession(sc, req.params.id, user.id);
  if (!session) { sendError(res, "not_found", "Session not found"); return; }

  const airport = buildFallbackProfile({
    iataCode: session.manualIata ?? "UNK",
    city:     session.manualCity ?? "Unknown",
    country:  session.manualCountry ?? "Unknown",
  });

  // Assess a generic "leaving airport" activity to get overall safety
  const a = assess(airport, session, {
    title:          "Leaving airport",
    travelTimeMin:  20,
    activityTimeMin: 30,
    insideAirport:  false,
  });

  res.json({
    featureEnabled:  true,
    overallRating:   a.rating,
    overallLabel:    safetyLabel(a.rating),
    availableMinutes: a.availableMinutes,
    usableMinutes:   a.usableMinutes,
    returnBufferMin: a.returnBufferMin,
    hardReturnTime:  a.hardReturnTime.toISOString(),
    warningReason:   a.warningReason,
    breakdown:       a.breakdown,
    layoverMinutes:  session.layoverMinutes,
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

  const airport = buildFallbackProfile({
    iataCode: session.manualIata ?? "UNK",
    city:     session.manualCity ?? "Unknown",
    country:  session.manualCountry ?? "Unknown",
  });

  const answer = await answerLayoverQuestion(sc, { question: parsed.data.question, session, airport });

  await emitLayoverEvent(sc, session.id, user.id, "compass_question_asked", {
    involvesLeaving: answer.involvesLeaving,
  });

  res.json({ ok: true, ...answer });
});

// ── POST /api/airport/sessions/:id/plan ──────────────────────────────────────

router.post("/airport/sessions/:id/plan", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

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

  const planSchema = z.object({
    title:        z.string().min(1).max(200),
    tripId:       z.string().uuid().optional().nullable(),
    startsAt:     z.string().datetime().optional().nullable(),
    locationName: z.string().max(300).optional().nullable(),
    city:         z.string().max(100).optional().nullable(),
    notes:        z.string().max(1000).optional().nullable(),
  });
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data: item, error } = await sc.from("trip_plan_items").insert({
    trip_id:       parsed.data.tripId ?? session.tripId,
    title:         parsed.data.title,
    starts_at:     parsed.data.startsAt ?? null,
    location_name: parsed.data.locationName ?? null,
    city:          parsed.data.city ?? session.manualCity ?? null,
    notes:         parsed.data.notes ?? null,
    category:      "layover",
    created_by:    user.id,
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

  const airport = buildFallbackProfile({
    iataCode: session.manualIata ?? "UNK",
    city:     session.manualCity ?? "Unknown",
    country:  session.manualCountry ?? "Unknown",
  });

  const { computeBuffer: compute } = await import("../services/airport/LayoverSafetyEngine.js");
  const breakdown = compute(airport, session, new Date(session.departureTime));
  const bufferMin = breakdown.totalBuffer;
  const cutoff    = session.boardingTime ?? session.departureTime;
  const hardReturn = new Date(new Date(cutoff).getTime() - bufferMin * 60000);

  await emitLayoverEvent(sc, session.id, user.id, "return_deadline_set", {
    minutesBefore: parsed.data.minutesBefore,
    hardReturnTime: hardReturn.toISOString(),
  });

  res.json({
    ok: true,
    hardReturnTime: hardReturn.toISOString(),
    bufferMinutes: bufferMin,
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

  // Emit Telegraph suggestion event (no private location in payload)
  await emitLayoverEvent(sc, session.id, user.id, "telegraph_suggestion_sent", {
    intent:   intent?.intent ?? "layover_activity",
    city:     session.manualCity ?? null,
    // NOTE: no coords, no neighborhood — city-level only
  });

  res.json({
    ok: true,
    intent: intent?.intent ?? "layover_activity",
    confidence: intent?.confidence ?? 0.7,
    city: session.manualCity ?? null,
  });
});

// ── GET /api/airport/pulse ────────────────────────────────────────────────────

router.get("/airport/pulse", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

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

  let query = sc
    .from("posts")
    .select("id, author_id, content, media_urls, created_at, location_city, location_country, profiles!author_id(id, username, full_name, avatar_url)")
    .eq("status", "active")
    .eq("visibility", "public")
    .ilike("location_city", `%${city}%`)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  const posts = (data ?? []).map((row: any) => {
    const profile = Array.isArray(row.profiles) ? row.profiles[0] : row.profiles;
    return {
      id:          row.id,
      authorId:    row.author_id,
      content:     row.content,
      mediaUrls:   row.media_urls ?? [],
      createdAt:   row.created_at,
      locationCity:    row.location_city ?? null,
      locationCountry: row.location_country ?? null,
      author: profile ? {
        id: profile.id, username: profile.username,
        name: profile.full_name ?? profile.username, avatarUrl: profile.avatar_url ?? null,
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
  const admin = await requireAdminGuard(req, res);
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
  const admin = await requireAdminGuard(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data } = await sc.from("airport_profiles").select("*").order("name");
  res.json({ profiles: data ?? [] });
});

export default router;
