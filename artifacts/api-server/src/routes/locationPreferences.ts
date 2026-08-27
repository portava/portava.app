/**
 * Location preference routes
 *
 * GET  /api/me/location-preferences   — load user's location mode + feature overrides
 * PATCH /api/me/location-preferences  — update mode, pause, per-feature visibility
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";
import { LOCATION_MODE_DESCRIPTIONS } from "../services/location/LocationPermissionService";
import { asyncHandler } from "../lib/asyncHandler";
import { invalidateCompassHomeCache } from "./compassHome";
import { _clearMapTravelersCache } from "../lib/mapTravelers.js";

const router = Router();

const VALID_MODES = ["off", "city_only", "nearby", "live_during_activity", "trusted_circle_live"] as const;
const VALID_VISIBILITY = ["city_only", "neighborhood", "venue_tagged", "exact_hidden", "no_location"] as const;

const patchSchema = z.object({
  locationMode:         z.enum(VALID_MODES).optional(),
  sharingPaused:        z.boolean().optional(),
  pulseVisibility:      z.enum(VALID_VISIBILITY).nullable().optional(),
  discoveryVisibility:  z.enum(VALID_VISIBILITY).nullable().optional(),
  safeReturnEnabled:    z.boolean().optional(),
  trustedCircleShare:   z.boolean().optional(),
  hotelBlurEnabled:     z.boolean().optional(),
});

// ── GET /api/me/location-preferences ─────────────────────────────────────────

router.get("/me/location-preferences", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  const { data, error } = await db
    .from("location_preferences")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "location-preferences: read failed");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    // Return defaults — no row yet
    res.status(200).json({
      locationMode:        "city_only",
      sharingPaused:       false,
      pulseVisibility:     null,
      discoveryVisibility: null,
      safeReturnEnabled:   true,
      trustedCircleShare:  false,
      hotelBlurEnabled:    true,
      modeDescriptions:    LOCATION_MODE_DESCRIPTIONS,
    });
    return;
  }

  res.status(200).json({
    locationMode:        data.location_mode ?? "city_only",
    sharingPaused:       Boolean(data.sharing_paused),
    pulseVisibility:     data.pulse_visibility ?? null,
    discoveryVisibility: data.discovery_visibility ?? null,
    safeReturnEnabled:   data.safe_return_enabled !== false,
    trustedCircleShare:  Boolean(data.trusted_circle_share),
    hotelBlurEnabled:    data.hotel_blur_enabled !== false,
    updatedAt:           data.updated_at ?? null,
    modeDescriptions:    LOCATION_MODE_DESCRIPTIONS,
  });
}));

// ── PATCH /api/me/location-preferences ───────────────────────────────────────

router.patch("/me/location-preferences", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  const patch: Record<string, unknown> = {
    user_id:    user.id,
    updated_at: new Date().toISOString(),
  };

  const d = parsed.data;
  if (d.locationMode         !== undefined) patch.location_mode          = d.locationMode;
  if (d.sharingPaused        !== undefined) patch.sharing_paused         = d.sharingPaused;
  if (d.pulseVisibility      !== undefined) patch.pulse_visibility        = d.pulseVisibility;
  if (d.discoveryVisibility  !== undefined) patch.discovery_visibility    = d.discoveryVisibility;
  if (d.safeReturnEnabled    !== undefined) patch.safe_return_enabled     = d.safeReturnEnabled;
  if (d.trustedCircleShare   !== undefined) patch.trusted_circle_share    = d.trustedCircleShare;
  if (d.hotelBlurEnabled     !== undefined) patch.hotel_blur_enabled      = d.hotelBlurEnabled;

  const { error } = await db
    .from("location_preferences")
    .upsert(patch, { onConflict: "user_id" });

  if (error) {
    req.log.error({ err: error }, "location-preferences: upsert failed");
    sendError(res, "db_error", error.message);
    return;
  }

  invalidateCompassHomeCache(user.id);
  // Drop the shared discovery-map candidate cache so an opt-out (e.g. reducing
  // discovery visibility or trusted-circle sharing) takes effect immediately,
  // instead of leaving the user visible on the map for up to the 20s cache TTL.
  _clearMapTravelersCache();

  res.status(200).json({ ok: true });
}));

export default router;
