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
import {
  revokeJourneyConsentAndDeleteSegments,
  revokesJourneyConsent,
  type JourneyConsentRevocationPatch,
} from "../lib/journeySegmentRetention";
import { invalidateCompassHomeCache } from "./compassHome";

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
  journeyObservationEnabled: z.boolean().optional(),
});

// ── GET /api/me/location-preferences ─────────────────────────────────────────

router.get("/me/location-preferences", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { user } = auth;

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  const { data, error } = await db
    .from("user_location_preferences")
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
      journeyObservationEnabled: false,
      journeyConsentScope: null,
      journeyConsentVersion: null,
      journeyConsentGrantedAt: null,
      journeyConsentRevokedAt: null,
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
    journeyObservationEnabled: data.journey_observation_enabled === true,
    journeyConsentScope: data.journey_consent_scope ?? null,
    journeyConsentVersion: data.journey_consent_version ?? null,
    journeyConsentGrantedAt: data.journey_consent_granted_at ?? null,
    journeyConsentRevokedAt: data.journey_consent_revoked_at ?? null,
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
  if (
    parsed.data.journeyObservationEnabled === true
    && (
      parsed.data.sharingPaused === true
      || (
        parsed.data.locationMode !== undefined
        && parsed.data.locationMode !== "live_during_activity"
        && parsed.data.locationMode !== "trusted_circle_live"
      )
    )
  ) {
    sendError(
      res,
      "invalid_payload",
      "Journey observation consent requires an unpaused live location mode",
    );
    return;
  }

  const db = getServiceClient();
  if (!db) { sendError(res, "server_not_configured"); return; }

  const patch: JourneyConsentRevocationPatch = {};

  const d = parsed.data;
  if (d.locationMode         !== undefined) patch.location_mode          = d.locationMode;
  if (d.sharingPaused        !== undefined) patch.sharing_paused         = d.sharingPaused;
  if (d.pulseVisibility      !== undefined) patch.pulse_visibility        = d.pulseVisibility;
  if (d.discoveryVisibility  !== undefined) patch.discovery_visibility    = d.discoveryVisibility;
  if (d.safeReturnEnabled    !== undefined) patch.safe_return_enabled     = d.safeReturnEnabled;
  if (d.trustedCircleShare   !== undefined) patch.trusted_circle_share    = d.trustedCircleShare;
  if (d.hotelBlurEnabled     !== undefined) patch.hotel_blur_enabled      = d.hotelBlurEnabled;
  if (d.journeyObservationEnabled === false) {
    patch.journey_observation_enabled = false;
  }
  if (revokesJourneyConsent(patch)) {
    try {
      await revokeJourneyConsentAndDeleteSegments(db, user.id, patch);
    } catch (revocationError: any) {
      req.log.error({ err: revocationError }, "location-preferences: atomic Journey revocation failed");
      sendError(res, "db_error", revocationError?.message ?? "Location revocation failed");
      return;
    }
  } else {
    const { error } = await db
      .from("user_location_preferences")
      .upsert(
        { user_id: user.id, ...patch, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );

    if (error) {
      req.log.error({ err: error }, "location-preferences: upsert failed");
      sendError(res, "db_error", error.message);
      return;
    }
  }

  if (d.journeyObservationEnabled === true) {
    const { data: consentResult, error: consentError } = await db.rpc(
      "set_journey_observation_consent_v1",
      {
        p_user_id: user.id,
        p_enabled: true,
      },
    );
    if (consentError) {
      req.log.error({ err: consentError }, "location-preferences: Journey consent update failed");
      sendError(res, "db_error", consentError.message);
      return;
    }
    if (consentResult === "not_eligible") {
      sendError(
        res,
        "invalid_payload",
        "Journey observation consent requires an unpaused live location mode",
      );
      return;
    }
  }

  invalidateCompassHomeCache(user.id);

  res.status(200).json({ ok: true });
}));

export default router;
