/**
 * Plan geofence routes (Phase 3 seam — gated by plan_geofence_enabled flag)
 *
 * GET  /api/trips/:tripId/geofence   — load geofence for a trip
 * POST /api/trips/:tripId/geofence   — create/update geofence
 *
 * PRIVACY: exact lat/lng are stored server-side only. Public responses
 * return visibility labels and arrival status — never raw coordinates.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

const VISIBILITY_VALUES = ["hidden_until_accepted", "accepted_members", "public_approximate"] as const;

const createSchema = z.object({
  lat:               z.number().min(-90).max(90),
  lng:               z.number().min(-180).max(180),
  checkInRadiusM:    z.number().int().min(50).max(5000).default(150),
  visibility:        z.enum(VISIBILITY_VALUES).default("hidden_until_accepted"),
  hostEnabled:       z.boolean().default(true),
});

async function isFeatureEnabled(db: ReturnType<typeof getServiceClient>): Promise<boolean> {
  if (!db) return false;
  try {
    const { data } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("key", "plan_geofence_enabled")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch {
    return false;
  }
}

async function isTripMember(db: ReturnType<typeof getServiceClient>, tripId: string, userId: string): Promise<boolean> {
  if (!db) return false;
  try {
    const { data: trip } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();

    if ((trip as any)?.owner_id === userId) return true;

    // Only accepted members (role='member') can access geofence data;
    // invited/pending users are excluded to prevent coordinate leakage.
    const { data: member } = await db
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .eq("role", "member")
      .maybeSingle();

    return Boolean(member);
  } catch {
    return false;
  }
}

// ── GET /api/trips/:tripId/geofence ───────────────────────────────────────────

router.get("/trips/:tripId/geofence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    res.status(200).json({ geofence: null, featureEnabled: false });
    return;
  }

  const { tripId } = req.params;

  if (!await isTripMember(db, tripId, user.id)) {
    sendError(res, "forbidden", "Not a trip member");
    return;
  }

  const { data, error } = await db
    .from("plan_geofences")
    .select("id, check_in_radius_m, visibility, arrival_status, host_enabled, created_at, updated_at")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (error) {
    req.log.error({ err: error }, "geofence: read failed");
    sendError(res, "db_error", error.message);
    return;
  }

  if (!data) {
    res.status(200).json({ geofence: null, featureEnabled: true });
    return;
  }

  // Exact coords are NEVER returned — only visibility labels
  res.status(200).json({
    featureEnabled: true,
    geofence: {
      id:               (data as any).id,
      checkInRadiusM:   (data as any).check_in_radius_m,
      visibility:       (data as any).visibility,
      arrivalStatus:    (data as any).arrival_status,
      hostEnabled:      (data as any).host_enabled,
      createdAt:        (data as any).created_at,
      updatedAt:        (data as any).updated_at,
    },
  });
});

// ── POST /api/trips/:tripId/geofence ──────────────────────────────────────────

router.post("/trips/:tripId/geofence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Plan geofencing is not enabled");
    return;
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId } = req.params;

  // Must be trip owner to set a geofence
  const { data: trip } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can set a geofence");
    return;
  }

  // Manual upsert — plan_geofences has no UNIQUE(trip_id) in the current schema,
  // so we check for an existing row first, then update or insert accordingly.
  const { data: existing } = await db
    .from("plan_geofences")
    .select("id")
    .eq("trip_id", tripId)
    .maybeSingle();

  const record = {
    trip_id:           tripId,
    lat:               parsed.data.lat,
    lng:               parsed.data.lng,
    check_in_radius_m: parsed.data.checkInRadiusM,
    visibility:        parsed.data.visibility,
    host_enabled:      parsed.data.hostEnabled,
    created_by:        user.id,
    updated_at:        new Date().toISOString(),
  };

  let writeError: Error | null = null;

  if ((existing as any)?.id) {
    const { error } = await db
      .from("plan_geofences")
      .update(record)
      .eq("id", (existing as any).id);
    writeError = error;
  } else {
    const { error } = await db
      .from("plan_geofences")
      .insert(record);
    writeError = error;
  }

  if (writeError) {
    req.log.error({ err: writeError }, "geofence: write failed");
    sendError(res, "db_error", writeError.message);
    return;
  }

  res.status(201).json({ ok: true });
});

export default router;
