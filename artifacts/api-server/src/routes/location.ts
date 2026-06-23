/**
 * Location routes
 *
 * GET  /api/me/location-state              — current saved location state
 * POST /api/me/location-state              — upsert from client GPS or manual city
 * POST /api/location/reverse-geocode       — server-side reverse geocode
 * GET  /api/me/passport-stamps/gps         — GPS-earned stamps list
 * POST /api/me/passport-stamps/gps         — create/upsert GPS stamp
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase.js";
import { reverseGeocode } from "../services/geocodingService";
import { checkAndRecordSnapshot, getUserTrustLevel, checkIpCityMismatch } from "../services/location/LocationSafetyService";
import { createStamp } from "../services/passport/PassportStampService.js";
import { createSuggestedMemory } from "../services/passport/PassportMemoryService.js";

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function isValidLat(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -90 && v <= 90;
}
function isValidLng(v: unknown): v is number {
  return typeof v === "number" && isFinite(v) && v >= -180 && v <= 180;
}
function sanitizeText(v: unknown, maxLen = 128): string | null {
  if (typeof v !== "string") return null;
  return v.trim().slice(0, maxLen) || null;
}

// ── GET /api/me/location-state ───────────────────────────────────────────────
router.get("/me/location-state", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { data, error } = await sc
    .from("user_location_state")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "location-state: read failed");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    res.status(200).json({ ok: true, locationState: null });
    return;
  }

  res.status(200).json({
    ok: true,
    locationState: {
      permissionStatus: data.permission_status ?? null,
      source: data.source ?? null,
      coords: data.lat != null && data.lng != null
        ? { lat: Number(data.lat), lng: Number(data.lng), accuracyMeters: data.accuracy_meters != null ? Number(data.accuracy_meters) : null }
        : null,
      place: {
        city: data.city ?? null,
        district: data.district ?? null,
        country: data.country ?? null,
        countryCode: data.country_code ?? null,
        formatted: data.formatted_location ?? null,
      },
      lastKnownAt: data.last_known_at ?? null,
      manualCity: data.manual_city ?? null,
      manualCountry: data.manual_country ?? null,
      manualSelectedAt: data.manual_selected_at ?? null,
      updatedAt: data.updated_at ?? null,
    },
  });
});

// ── POST /api/me/location-state ──────────────────────────────────────────────
router.post("/me/location-state", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const body = req.body ?? {};
  const source = sanitizeText(body.source, 32);
  const permissionStatus = sanitizeText(body.permissionStatus, 32);
  const manualCity = sanitizeText(body.manualCity);
  const manualCountry = sanitizeText(body.manualCountry);

  // Coords — only accept if both lat+lng are valid
  let lat: number | null = null;
  let lng: number | null = null;
  let accuracyMeters: number | null = null;
  if (body.coords) {
    const rawLat = Number(body.coords.lat);
    const rawLng = Number(body.coords.lng);
    if (isValidLat(rawLat) && isValidLng(rawLng)) {
      lat = rawLat;
      lng = rawLng;
      const rawAcc = Number(body.coords.accuracyMeters);
      if (isFinite(rawAcc) && rawAcc >= 0) accuracyMeters = rawAcc;
    }
  }

  // Place
  const place = body.place ?? {};
  const city = sanitizeText(place.city);
  const district = sanitizeText(place.district);
  const country = sanitizeText(place.country);
  const countryCode = sanitizeText(place.countryCode, 8);
  const formatted = sanitizeText(place.formatted, 256);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    user_id: user.id,
    updated_at: now,
  };

  if (permissionStatus) patch.permission_status = permissionStatus;
  if (source) patch.source = source;
  if (lat != null) { patch.lat = lat; patch.lng = lng; patch.accuracy_meters = accuracyMeters; patch.last_known_at = now; }
  if (city !== undefined) patch.city = city;
  if (district !== undefined) patch.district = district;
  if (country !== undefined) patch.country = country;
  if (countryCode !== undefined) patch.country_code = countryCode;
  if (formatted !== undefined) patch.formatted_location = formatted;
  if (manualCity !== undefined) {
    patch.manual_city = manualCity;
    patch.manual_country = manualCountry ?? null;
    if (manualCity) patch.manual_selected_at = now;
  }

  const { error } = await sc
    .from("user_location_state")
    .upsert(patch, { onConflict: "user_id" });

  if (error) {
    req.log.error({ err: error }, "location-state: upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Anti-fake GPS: run safety checks asynchronously for GPS fixes — non-blocking
  if (source === "gps" && lat != null && lng != null) {
    checkAndRecordSnapshot(sc, user.id, lat, lng).catch((err) => {
      req.log.warn({ err }, "location-state: safety check failed (non-fatal)");
    });
  }

  // IP–city mismatch: run asynchronously when a city is present — non-blocking
  if (city) {
    const requestIp = req.ip ?? (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
    checkIpCityMismatch(sc, user.id, city, requestIp).catch((err) => {
      req.log.warn({ err }, "location-state: IP mismatch check failed (non-fatal)");
    });
  }

  res.status(200).json({ ok: true });
});

// ── POST /api/location/reverse-geocode ───────────────────────────────────────
router.post("/location/reverse-geocode", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;

  const body = req.body ?? {};
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  if (!isValidLat(lat) || !isValidLng(lng)) {
    sendError(res, "invalid_payload", "lat must be -90..90 and lng must be -180..180");
    return;
  }

  try {
    const place = await reverseGeocode(lat, lng);
    res.status(200).json({ ok: true, place });
  } catch (e) {
    req.log.error({ err: e }, "reverse-geocode: failed");
    res.status(200).json({ ok: true, place: { city: null, district: null, country: null, countryCode: null, formatted: null } });
  }
});

// ── GET /api/me/passport-stamps/gps ─────────────────────────────────────────
router.get("/me/passport-stamps/gps", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const { data, error } = await sc
    .from("passport_stamps_gps")
    .select("id, stamp_type, city, district, country, country_code, source, unlocked_at, related_postcard_id, related_trip_id, metadata")
    .eq("user_id", user.id)
    .order("unlocked_at", { ascending: false });

  if (error) {
    req.log.error({ err: error }, "passport-stamps-gps: read failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(200).json({ ok: true, stamps: data ?? [] });
});

// ── POST /api/me/passport-stamps/gps ────────────────────────────────────────
router.post("/me/passport-stamps/gps", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: sc, user } = auth;

  const body = req.body ?? {};
  const VALID_TYPES = [
    "city_visit", "postcard_created", "hidden_gem_shared",
    "food_spot_shared", "trip_checkin", "highlight_shared",
  ];
  const stampType = sanitizeText(body.stampType, 64);
  if (!stampType || !VALID_TYPES.includes(stampType)) {
    sendError(res, "invalid_payload", `stampType must be one of: ${VALID_TYPES.join(", ")}`);
    return;
  }

  const city = sanitizeText(body.city);
  const district = sanitizeText(body.district);
  const country = sanitizeText(body.country);
  const countryCode = sanitizeText(body.countryCode, 8);
  const source = sanitizeText(body.source, 32) ?? "gps";
  const relatedPostcardId = typeof body.relatedPostcardId === "string" ? body.relatedPostcardId : null;
  const relatedTripId = typeof body.relatedTripId === "string" ? body.relatedTripId : null;

  let lat: number | null = null;
  let lng: number | null = null;
  if (body.lat != null && body.lng != null) {
    const rLat = Number(body.lat);
    const rLng = Number(body.lng);
    if (isValidLat(rLat) && isValidLng(rLng)) { lat = rLat; lng = rLng; }
  }

  // Phase 6: trust-level gating.
  // Consult location_trust_events via getUserTrustLevel to decide stamp trust.
  // A single high-confidence event → suspicious → pending_review.
  // Two+ medium events → review → pending_review.
  // No recent events → trusted → gps_verified.
  let trustLevel: "gps_verified" | "manual" | "pending_review" = "manual";

  if (source === "gps") {
    const userTrust = await getUserTrustLevel(sc, user.id);
    trustLevel = userTrust === "trusted" ? "gps_verified" : "pending_review";
  }

  // Merge trustLevel into metadata so it is durably persisted with the stamp.
  // The client can read trustLevel from metadata.trust_level to show a verified/
  // pending badge on the Passport without needing a schema migration.
  const stampMetadata = {
    ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
    trust_level: trustLevel,
    trust_checked_at: new Date().toISOString(),
  };

  // Upsert — unique on (user_id, stamp_type, country_code, city)
  const { data: stamp, error } = await sc
    .from("passport_stamps_gps")
    .upsert(
      {
        user_id: user.id,
        stamp_type: stampType,
        city,
        district,
        country,
        country_code: countryCode,
        lat,
        lng,
        source,
        related_postcard_id: relatedPostcardId,
        related_trip_id: relatedTripId,
        metadata: stampMetadata,
      },
      { onConflict: "user_id,stamp_type,country_code,city", ignoreDuplicates: false },
    )
    .select("id, stamp_type, city, country, country_code, unlocked_at, metadata")
    .single();

  if (error) {
    req.log.error({ err: error }, "passport-stamps-gps: upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  // Fire-and-forget: also award a city stamp in the new passport_stamps table
  // (gated by passport_stamps_enabled feature flag; city stamps always GPS-verified)
  if (stampType === "city_visit" && city && trustLevel === "gps_verified") {
    void (async () => {
      try {
        const sc = getServiceClient();
        if (!sc) return;
        const { data: flagRow } = await sc
          .from("feature_flags")
          .select("enabled")
          .eq("key", "passport_stamps_enabled")
          .maybeSingle();
        if (!(flagRow as any)?.enabled) return;
        const result = await createStamp(sc, {
          userId: user.id,
          stampType: "city",
          country: country ?? null,
          city,
          verificationLevel: "gps",
          sourceType: "gps_pipeline",
        });
        if (result?.isNew) {
          const { data: memFlagRow } = await sc
            .from("feature_flags")
            .select("enabled")
            .eq("key", "passport_memories_enabled")
            .maybeSingle();
          if ((memFlagRow as any)?.enabled) {
            await createSuggestedMemory(sc, {
              userId: user.id,
              title: `${city}${country ? `, ${country}` : ""}`,
              country: country ?? null,
              city,
              district: district ?? null,
              category: "city_visit",
              sourceType: "gps_pipeline",
              verificationLevel: "gps",
              suggestionReason: "You visited a new city",
            } as any);
          }
        }
      } catch {}
    })();
  }

  res.status(201).json({ ok: true, stamp: { ...stamp, trustLevel } });
});

export default router;
