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
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { coarsenPosition, effectiveDiscoveryVisibility } from "../lib/mapTravelers.js";
import { fetchBlockedSet } from "../lib/blocks.js";
import { reverseGeocode } from "../services/geocodingService";
import { checkAndRecordSnapshot, getUserTrustLevel, checkIpCityMismatch } from "../services/location/LocationSafetyService";
import { linkOutcomeSignal } from "../compass/CompassOutcomeEngine.js";
import { invalidateCompassHomeCache } from "./compassHome.js";
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

  // Emergency stop: disable_location_sharing — fail-CLOSED on DB error
  const flagSc = getServiceClient();
  if (flagSc && await isKillSwitchEngaged(flagSc, 'disable_location_sharing')) {
    sendError(res, 'feature_disabled', 'Location sharing is temporarily disabled');
    return;
  }

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

  // Compass Home reads currentCity from user_location_state — a city change
  // (onboarding, manual pick, or GPS move) must be visible on the very next
  // Home open, not up to the cache TTL later.
  if (city !== undefined || manualCity !== undefined || country !== undefined) {
    invalidateCompassHomeCache(user.id);
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

  // Phase 14 — a GPS-verified stamp tied to a recommended trip/postcard is a
  // "stayed" outcome; linkOutcomeSignal no-ops when nothing was recommended.
  if (trustLevel === "gps_verified") {
    void linkOutcomeSignal(
      getServiceClient(), user.id,
      relatedTripId ?? relatedPostcardId, "stayed", "route:gps_stamp",
    );
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
          .eq("flag", "passport_stamps_enabled")
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
            .eq("flag", "passport_memories_enabled")
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

// ── POST /api/location/exit-geofence ─────────────────────────────────────────
/**
 * Called by the mobile client when GPS confirms the user has exited a post's
 * geofence and the confirmation window has elapsed.
 *
 * Sets exited_geofence_at on the post and computes publish_eligible_at =
 * now + GEOFENCE_CONFIRMATION_WINDOW_MINUTES (default 8 minutes).
 * Moves the post to pending_delay status so the background worker picks it
 * up on its next tick.
 * Appends an exit_detected event to delayed_post_location_events.
 */
const GEOFENCE_CONFIRMATION_MINUTES =
  parseInt(process.env.GEOFENCE_CONFIRMATION_MINUTES ?? "8", 10) || 8;

router.post("/location/exit-geofence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const { postId, lat, lng } = req.body ?? {};
  if (!postId || typeof postId !== "string") {
    sendError(res, "invalid_payload", "postId is required");
    return;
  }
  if (typeof lat !== "number" || typeof lng !== "number") {
    sendError(res, "invalid_payload", "lat and lng must be numbers");
    return;
  }

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  // Load the post and verify ownership
  const { data: post, error: loadErr } = await sc
    .from("posts")
    .select("id, author_id, post_status, geofence_radius_meters")
    .eq("id", postId)
    .eq("status", "active")
    .maybeSingle();

  if (loadErr) { sendError(res, "db_error", loadErr.message); return; }
  if (!post) { sendError(res, "not_found", "Post not found"); return; }
  if ((post as any).author_id !== user.id) {
    sendError(res, "forbidden", "Not the author");
    return;
  }
  if ((post as any).post_status !== "pending_location_exit") {
    sendError(res, "invalid_payload", `Post is not pending_location_exit (current: ${(post as any).post_status})`);
    return;
  }

  const now = new Date();
  const eligibleAt = new Date(now.getTime() + GEOFENCE_CONFIRMATION_MINUTES * 60 * 1_000).toISOString();
  const exitedAt = now.toISOString();

  const { error: updateErr } = await sc
    .from("posts")
    .update({
      exited_geofence_at: exitedAt,
      publish_eligible_at: eligibleAt,
      post_status: "pending_delay", // worker picks it up on next tick
    })
    .eq("id", postId);

  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  // Append exit_detected event (non-fatal)
  void sc
    .from("delayed_post_location_events")
    .insert({
      post_id: postId,
      user_id: user.id,
      event_type: "exit_detected",
      lat,
      lng,
      metadata: { confirmation_window_minutes: GEOFENCE_CONFIRMATION_MINUTES },
    });

  res.status(200).json({ ok: true, publishEligibleAt: eligibleAt });
});

// ── GET /api/me/circle-locations ─────────────────────────────────────────────
router.get("/me/circle-locations", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  // 1. Resolve caller's circle members
  const { data: memberRows, error: memberErr } = await sc
    .from("circle_memberships")
    .select("other_id")
    .eq("user_id", user.id);

  if (memberErr) {
    req.log.error({ err: memberErr }, "circle-locations: circle lookup failed");
    sendError(res, "db_error", memberErr.message);
    return;
  }

  const memberIdsRaw: string[] = (memberRows ?? []).map((r: any) => r.other_id as string);

  // Bidirectional block filter (server-enforced, fail-closed): a blocked
  // member's approximate area must not be returned in either direction. If the
  // block list can't be read, return nothing rather than risk a leak — same
  // contract as the discovery/crew maps.
  const blockedSet = await fetchBlockedSet(sc, user.id);
  if (blockedSet === null) {
    res.status(200).json({ ok: true, locations: [] });
    return;
  }
  const memberIds: string[] = memberIdsRaw.filter((id) => !blockedSet.has(id));

  if (memberIds.length === 0) {
    res.status(200).json({ ok: true, locations: [] });
    return;
  }

  // 2. Identify members who explicitly opted out; also capture visibility prefs
  //    for coarsening. Schema default for trusted_circle_share is true, so a
  //    missing prefs row = consented.
  //
  //    The circle share flag (trusted_circle_share) is NOT the whole story: the
  //    master location-sharing switch lives in user_privacy_settings
  //    .allow_location_sharing. When a member turns location sharing OFF that
  //    flag goes false and they must disappear from the circle map entirely,
  //    exactly as listMapTravelers (lib/mapTravelers.ts) excludes them. Fetch
  //    both in parallel and fail-closed on either error.
  const [prefsRes, upsRes] = await Promise.all([
    sc
      .from("user_location_preferences")
      .select("user_id, trusted_circle_share, location_mode, sharing_paused, discovery_visibility")
      .in("user_id", memberIds),
    sc
      .from("user_privacy_settings")
      .select("user_id, allow_location_sharing")
      .in("user_id", memberIds),
  ]);

  if (prefsRes.error) {
    req.log.error({ err: prefsRes.error }, "circle-locations: prefs lookup failed");
    sendError(res, "db_error", prefsRes.error.message);
    return;
  }
  if (upsRes.error) {
    req.log.error({ err: upsRes.error }, "circle-locations: privacy settings lookup failed");
    sendError(res, "db_error", upsRes.error.message);
    return;
  }

  // Master switch OFF → exclude (mirrors upsExcluded in listMapTravelers).
  const locationSharingDisabled = new Set<string>(
    (upsRes.data ?? [])
      .filter((r: any) => r.allow_location_sharing === false)
      .map((r: any) => r.user_id as string),
  );

  const optedOut = new Set<string>();
  const prefsByMemberId = new Map<string, { location_mode?: string | null; sharing_paused?: boolean | null; discovery_visibility?: string | null }>();
  for (const r of prefsRes.data ?? []) {
    const row = r as any;
    if (row.trusted_circle_share === false) optedOut.add(row.user_id as string);
    prefsByMemberId.set(row.user_id as string, row);
  }
  const visibleIds = memberIds.filter(id => !optedOut.has(id) && !locationSharingDisabled.has(id));

  if (visibleIds.length === 0) {
    res.status(200).json({ ok: true, locations: [] });
    return;
  }

  // 3. Fetch location state + profile display info for visible members in parallel.
  const [locationRes, profileRes] = await Promise.all([
    sc
      .from("user_location_state")
      .select("user_id, lat, lng, city, country, updated_at")
      .in("user_id", visibleIds),
    sc
      .from("profiles")
      .select("id, name, avatar_url")
      .in("id", visibleIds),
  ]);

  if (locationRes.error) {
    req.log.error({ err: locationRes.error }, "circle-locations: location state read failed");
    sendError(res, "db_error", locationRes.error.message);
    return;
  }

  const profileMap = new Map(
    (profileRes.data ?? []).map((p: any) => [p.id as string, p])
  );

  // Universal display-name rule: members show real names only when opted in.
  const allowedLocNames = await nameVisibilitySet(sc, visibleIds);

  const locations = (locationRes.data ?? []).map((row: any) => {
    const uid = row.user_id as string;

    // effectiveDiscoveryVisibility()===null means the member is in a
    // sharing-OFF state (sharing_paused, location_mode='off', or
    // discovery_visibility='no_location'). listMapTravelers treats that as
    // EXCLUDE — so must this endpoint: emit NOTHING for them, not a coarsened
    // city_only fallback (which would still leak city/country/updated_at).
    // A member with no prefs row keeps today's default-share behaviour because
    // effectiveDiscoveryVisibility(null) === 'city_only' (non-null).
    const prefs = prefsByMemberId.get(uid) ?? null;
    const vis = effectiveDiscoveryVisibility(prefs);
    if (vis === null) return null;

    const profile = profileMap.get(uid);
    const nameOk = uid === user.id || allowedLocNames.has(uid);

    // Raw coordinates must never leave the server — every entry is coarsened,
    // including the caller's own row if it appears in the circle.
    // Mirrors the same contract as listMapTravelers.
    let lat: number | null = row.lat != null ? Number(row.lat) : null;
    let lng: number | null = row.lng != null ? Number(row.lng) : null;
    if (lat != null && lng != null) {
      const coarsened = coarsenPosition(uid, lat, lng, vis);
      lat = coarsened.lat;
      lng = coarsened.lng;
    }

    return {
      userId:    uid,
      name:      nameOk ? ((profile?.name as string | null) ?? null) : null,
      avatarUrl: (profile?.avatar_url as string | null) ?? null,
      lat,
      lng,
      city:      (row.city as string | null) ?? null,
      country:   (row.country as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  res.status(200).json({ ok: true, locations });
});

export default router;
