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
import { getServiceClient } from "../lib/supabase";
import { reverseGeocode } from "../services/geocodingService";

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
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

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
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

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
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

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
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

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
  // Cross-check the stamp's claimed city against the user's last known GPS fix
  // from user_location_state. Mismatches (e.g. city spoofing) are flagged
  // pending_review so the Passport can display an unverified badge.
  let trustLevel: "gps_verified" | "manual" | "pending_review" = "manual";

  if (source === "gps" && lat != null) {
    const { data: locState } = await sc
      .from("user_location_state")
      .select("city, last_known_at, source")
      .eq("user_id", user.id)
      .maybeSingle();

    if (locState?.city && city) {
      const normalise = (s: string) => s.toLowerCase().trim();
      const cityMatch = normalise(locState.city) === normalise(city);
      // Accept if the known GPS city matches, or if the last fix is recent (< 30 min)
      const fixAge = locState.last_known_at
        ? Date.now() - new Date(locState.last_known_at as string).getTime()
        : Infinity;
      const recentFix = fixAge < 30 * 60 * 1_000;

      trustLevel = cityMatch && recentFix ? "gps_verified" : "pending_review";
    } else if (locState?.city == null) {
      // No location state on record — cannot verify, flag for review
      trustLevel = "pending_review";
    } else {
      // We have coordinates but no saved state to cross-check
      trustLevel = "gps_verified";
    }
  }

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
        metadata: body.metadata ?? null,
      },
      { onConflict: "user_id,stamp_type,country_code,city", ignoreDuplicates: false },
    )
    .select("id, stamp_type, city, country, country_code, unlocked_at")
    .single();

  if (error) {
    req.log.error({ err: error }, "passport-stamps-gps: upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  res.status(201).json({ ok: true, stamp: { ...stamp, trustLevel } });
});

export default router;
