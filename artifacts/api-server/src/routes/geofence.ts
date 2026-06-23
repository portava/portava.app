/**
 * Plan geofence routes (gated by plan_geofence_enabled flag)
 *
 * GET  /api/trips/:tripId/geofence              — load geofence (privacy-filtered by membership)
 * POST /api/trips/:tripId/geofence              — create/update geofence (owner only)
 * POST /api/trips/:tripId/geofence/check-in     — member check-in (radius + window validation)
 * GET  /api/trips/:tripId/geofence/attendance   — host attendance dashboard
 * POST /api/trips/:tripId/geofence/attendance/:userId/override  — host manual override
 *
 * PRIVACY: exact lat/lng stored server-side only. Public responses return
 * visibility labels, distance buckets, and status text — never raw coordinates.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { calculateDistanceMeters } from "../lib/locationVerify.js";
import { checkAndRecordSnapshot } from "../services/location/LocationSafetyService.js";

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const PUBLIC_PREVIEW_LEVELS = ["city_only", "neighborhood", "venue_tagged"] as const;
const EXACT_VISIBILITY       = ["exact_after_acceptance", "exact_private_host_reveal"] as const;
const ATTENDANCE_STATUSES    = ["not_checked_in","on_the_way","nearby","arrived","late","no_show","left"] as const;

// ── Schema ────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  lat:                       z.number().min(-90).max(90),
  lng:                       z.number().min(-180).max(180),
  checkInRadiusM:            z.number().int().min(50).max(5000).default(150),
  publicPreviewLevel:        z.enum(PUBLIC_PREVIEW_LEVELS).default("neighborhood"),
  exactVisibility:           z.enum(EXACT_VISIBILITY).default("exact_after_acceptance"),
  checkInRequired:           z.boolean().default(false),
  checkInWindowStart:        z.string().datetime().optional().nullable(),
  checkInWindowEnd:          z.string().datetime().optional().nullable(),
  arrivalStatusVisible:      z.boolean().default(true),
  noShowAffectsReliability:  z.boolean().default(false),
  locationName:              z.string().max(300).optional().nullable(),
  city:                      z.string().max(120).optional().nullable(),
  neighborhood:              z.string().max(120).optional().nullable(),
  venueName:                 z.string().max(200).optional().nullable(),
  hostEnabled:               z.boolean().default(true),
});

const overrideSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES),
  note:   z.string().max(500).optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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

/** Returns 'owner' | 'member' | null (non-accepted / not found). */
async function getMemberRole(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
  userId: string,
): Promise<"owner" | "member" | null> {
  if (!db) return null;
  try {
    const { data: trip } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if ((trip as any)?.owner_id === userId) return "owner";

    const { data: member } = await db
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .eq("role", "member")
      .maybeSingle();
    return member ? "member" : null;
  } catch {
    return null;
  }
}

/** Admin default radius — returns 150 if table missing. */
async function getAdminDefaults(db: ReturnType<typeof getServiceClient>) {
  try {
    const { data } = await db!
      .from("geofence_admin_settings")
      .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability")
      .eq("id", 1)
      .maybeSingle();
    return {
      defaultRadiusM:           (data as any)?.default_radius_m             ?? 150,
      minRadiusM:               (data as any)?.min_radius_m                 ?? 50,
      maxRadiusM:               (data as any)?.max_radius_m                 ?? 5000,
      noShowAffectsReliability: (data as any)?.no_show_affects_reliability  ?? false,
    };
  } catch {
    return { defaultRadiusM: 150, minRadiusM: 50, maxRadiusM: 5000, noShowAffectsReliability: false };
  }
}

/** Write an attendance event (never auto-punishes). */
async function writeAttendanceEvent(
  db: ReturnType<typeof getServiceClient>,
  opts: {
    geofenceId: string;
    tripId: string;
    userId: string;
    eventType: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db!.from("plan_attendance_events").insert({
      geofence_id: opts.geofenceId,
      trip_id:     opts.tripId,
      user_id:     opts.userId,
      event_type:  opts.eventType,
      actor_id:    opts.actorId ?? null,
      metadata:    opts.metadata ?? {},
    });
  } catch {
    // non-fatal
  }
}

/** Upsert a check-in row and write the matching attendance event. */
async function upsertCheckin(
  db: ReturnType<typeof getServiceClient>,
  opts: {
    geofenceId: string;
    tripId: string;
    userId: string;
    status: string;
    eventType: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db!.from("plan_checkins").upsert(
    {
      geofence_id:   opts.geofenceId,
      trip_id:       opts.tripId,
      user_id:       opts.userId,
      status:        opts.status,
      checked_in_at: opts.status === "arrived" || opts.status === "late" ? new Date().toISOString() : undefined,
      updated_at:    new Date().toISOString(),
    },
    { onConflict: "geofence_id,user_id" },
  );
  await writeAttendanceEvent(db, {
    geofenceId: opts.geofenceId,
    tripId:     opts.tripId,
    userId:     opts.userId,
    eventType:  opts.eventType,
    actorId:    opts.actorId,
    metadata:   opts.metadata ?? {},
  });
}

// ── GET /api/trips/:tripId/geofence ───────────────────────────────────────────
// Non-accepted viewers see only public preview level (city/neighborhood/venue label).
// Accepted members see exact location only when host's exactVisibility allows it
// (or when the host has explicitly revealed it).

router.get("/trips/:tripId/geofence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    res.status(200).json({ geofence: null, featureEnabled: false });
    return;
  }

  const { tripId } = req.params;
  const role = await getMemberRole(db, tripId, user.id);

  const { data, error } = await db
    .from("plan_geofences")
    .select(
      "id, trip_id, check_in_radius_m, public_preview_level, exact_visibility, " +
      "check_in_required, check_in_window_start, check_in_window_end, " +
      "arrival_status_visible, no_show_affects_reliability, host_enabled, host_revealed, " +
      "location_name, city, neighborhood, venue_name, created_at, updated_at",
    )
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

  const g = data as any;

  // Non-members get a stripped public card (no coords, no check-in data)
  if (!role) {
    res.status(200).json({
      featureEnabled: true,
      geofence: {
        id:               g.id,
        publicPreviewLevel: g.public_preview_level ?? "neighborhood",
        city:             g.city ?? null,
        neighborhood:     g.neighborhood ?? null,
        venueName:        g.venue_name ?? null,
        locationName:     g.public_preview_level === "venue_tagged" ? (g.location_name ?? null) : null,
        exactRevealLabel: "Exact meetup revealed after acceptance",
        hostEnabled:      g.host_enabled,
        viewerRole:       "none",
      },
    });
    return;
  }

  // Accepted members: build base response (still no raw lat/lng)
  const isAccepted = role === "owner" || role === "member";
  const revealExact = isAccepted && (
    g.exact_visibility === "exact_after_acceptance" ||
    (g.exact_visibility === "exact_private_host_reveal" && g.host_revealed === true)
  );

  // Fetch caller's own check-in status
  let myStatus: string = "not_checked_in";
  if (isAccepted) {
    const { data: chk } = await db
      .from("plan_checkins")
      .select("status")
      .eq("geofence_id", g.id)
      .eq("user_id", user.id)
      .maybeSingle();
    myStatus = (chk as any)?.status ?? "not_checked_in";
  }

  const exactLabel = revealExact
    ? (g.location_name ?? g.venue_name ?? g.neighborhood ?? g.city ?? "Exact location shared")
    : (g.exact_visibility === "exact_after_acceptance"
        ? "Exact meetup revealed after acceptance"
        : "Exact location will be shared when the host reveals it");

  res.status(200).json({
    featureEnabled: true,
    geofence: {
      id:                       g.id,
      publicPreviewLevel:       g.public_preview_level ?? "neighborhood",
      exactVisibility:          g.exact_visibility ?? "exact_after_acceptance",
      checkInRequired:          g.check_in_required ?? false,
      checkInWindowStart:       g.check_in_window_start ?? null,
      checkInWindowEnd:         g.check_in_window_end ?? null,
      arrivalStatusVisible:     g.arrival_status_visible ?? true,
      noShowAffectsReliability: g.no_show_affects_reliability ?? false,
      hostEnabled:              g.host_enabled,
      hostRevealed:             g.host_revealed ?? false,
      city:                     g.city ?? null,
      neighborhood:             g.neighborhood ?? null,
      venueName:                g.venue_name ?? null,
      // Exact location label (never raw coords)
      locationLabel:            exactLabel,
      locationName:             revealExact ? (g.location_name ?? null) : null,
      exactLocationRevealed:    revealExact,
      checkInRadiusM:           g.check_in_radius_m,
      myCheckInStatus:          myStatus,
      viewerRole:               role,
      createdAt:                g.created_at,
      updatedAt:                g.updated_at,
    },
  });
});

// ── POST /api/trips/:tripId/geofence ──────────────────────────────────────────
// Owner creates/updates geofence with full host settings.

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

  const { data: trip } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can set a geofence");
    return;
  }

  // Validate radius against admin settings
  const adminDefaults = await getAdminDefaults(db);
  const radiusM = Math.max(
    adminDefaults.minRadiusM,
    Math.min(adminDefaults.maxRadiusM, parsed.data.checkInRadiusM),
  );

  const d = parsed.data;
  const record = {
    trip_id:                    tripId,
    lat:                        d.lat,
    lng:                        d.lng,
    check_in_radius_m:          radiusM,
    public_preview_level:       d.publicPreviewLevel,
    exact_visibility:           d.exactVisibility,
    check_in_required:          d.checkInRequired,
    check_in_window_start:      d.checkInWindowStart ?? null,
    check_in_window_end:        d.checkInWindowEnd ?? null,
    arrival_status_visible:     d.arrivalStatusVisible,
    no_show_affects_reliability: d.noShowAffectsReliability,
    location_name:              d.locationName ?? null,
    city:                       d.city ?? null,
    neighborhood:               d.neighborhood ?? null,
    venue_name:                 d.venueName ?? null,
    host_enabled:               d.hostEnabled,
    created_by:                 user.id,
    updated_at:                 new Date().toISOString(),
  };

  // Upsert on trip_id (UNIQUE added in migration 0039)
  const { data: existing } = await db
    .from("plan_geofences")
    .select("id")
    .eq("trip_id", tripId)
    .maybeSingle();

  let writeError: any = null;
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

  res.status(201).json({ ok: true, effectiveRadiusM: radiusM });
});

// ── POST /api/trips/:tripId/geofence/reveal ────────────────────────────────────
// Host reveals exact location to accepted members (when exactVisibility = host_reveal).

router.post("/trips/:tripId/geofence/reveal", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Plan geofencing is not enabled");
    return;
  }

  const { tripId } = req.params;
  const { data: trip } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can reveal the exact location");
    return;
  }

  const { error } = await db
    .from("plan_geofences")
    .update({ host_revealed: true, updated_at: new Date().toISOString() })
    .eq("trip_id", tripId);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true });
});

// ── POST /api/trips/:tripId/geofence/check-in ─────────────────────────────────
// Accepted member checks in. Validates: accepted role, within radius, within window.
// Stores arrival status without exposing coordinates publicly.
// Routes suspicious GPS through LocationSafetyService → location_trust_event.

const checkInSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

router.post("/trips/:tripId/geofence/check-in", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Plan geofencing is not enabled");
    return;
  }

  const parsed = checkInSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId } = req.params;
  const { lat, lng } = parsed.data;

  // Must be accepted member
  const role = await getMemberRole(db, tripId, user.id);
  if (!role) {
    sendError(res, "not_member", "You must be an accepted trip member to check in");
    return;
  }

  // Load geofence
  const { data: gf, error: gfErr } = await db
    .from("plan_geofences")
    .select("id, lat, lng, check_in_radius_m, check_in_required, check_in_window_start, check_in_window_end, host_enabled, trip_id")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (gfErr) { sendError(res, "db_error", gfErr.message); return; }
  if (!gf || !(gf as any).host_enabled) {
    sendError(res, "not_found", "No active geofence for this trip");
    return;
  }

  const geofence = gf as any;
  const geofenceId = geofence.id;

  // Validate time window (if set)
  const now = new Date();
  if (geofence.check_in_window_start && new Date(geofence.check_in_window_start) > now) {
    res.status(200).json({
      ok: false,
      reason: "window_not_open",
      message: "Check-in window has not opened yet. Come back closer to the meetup time.",
    });
    return;
  }
  if (geofence.check_in_window_end && new Date(geofence.check_in_window_end) < now) {
    res.status(200).json({
      ok: false,
      reason: "window_closed",
      message: "The check-in window has closed. Contact the host if you have trouble.",
    });
    return;
  }

  // Check suspicious GPS (fire-and-forget trust event, never auto-punishes)
  const trustResult = await checkAndRecordSnapshot(db, user.id, lat, lng);
  const isSuspicious = !trustResult.trusted;

  // Compute distance from meetup (coords are private — we just use them for math)
  const distanceM = calculateDistanceMeters(lat, lng, geofence.lat, geofence.lng);
  const radiusM   = geofence.check_in_radius_m ?? 150;

  if (isSuspicious) {
    // Write a trust event and allow a fallback/manual-review path
    await writeAttendanceEvent(db, {
      geofenceId,
      tripId,
      userId: user.id,
      eventType: "suspicious_check_in",
      metadata: {
        suspicionReason: trustResult.suspicionReason,
        distanceBucket: distanceM <= radiusM ? "inside" : "outside",
      },
    });
    res.status(200).json({
      ok: false,
      reason: "suspicious_gps",
      message: "We couldn't verify your location. Your check-in has been flagged for review. Contact the host if you need assistance.",
    });
    return;
  }

  if (distanceM > radiusM) {
    // Outside radius — friendly message, no coordinates leaked
    res.status(200).json({
      ok: false,
      reason: "outside_radius",
      message: `You're not close enough to check in yet. Make sure you're at the meetup location.`,
    });
    return;
  }

  // Determine if this is a late check-in
  const isLate = Boolean(geofence.check_in_window_end && new Date(geofence.check_in_window_end) <= now);
  const arrivalStatus = isLate ? "late" : "arrived";
  const eventType     = isLate ? "late_check_in" : "checked_in_successfully";

  await upsertCheckin(db, {
    geofenceId,
    tripId,
    userId: user.id,
    status:    arrivalStatus,
    eventType,
    metadata:  { distanceBucket: distanceM <= 100 ? "same_venue" : "inside_radius" },
  });

  res.status(200).json({
    ok: true,
    status: arrivalStatus,
    message: isLate ? "You're checked in (late arrival recorded)." : "You're checked in! 🎉",
  });
});

// ── GET /api/trips/:tripId/geofence/attendance ────────────────────────────────
// Host attendance dashboard — counts + per-attendee status text (no pins).

router.get("/trips/:tripId/geofence/attendance", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Plan geofencing is not enabled");
    return;
  }

  const { tripId } = req.params;

  // Must be trip owner to see full attendance
  const { data: trip } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can view attendance");
    return;
  }

  const { data: gf } = await db
    .from("plan_geofences")
    .select("id, check_in_radius_m, check_in_window_start, check_in_window_end")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!gf) {
    res.status(200).json({ attendance: null, message: "No geofence configured" });
    return;
  }

  const geofenceId = (gf as any).id;

  // Accepted members
  const { data: members } = await db
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .eq("role", "member");

  const memberIds: string[] = (members ?? []).map((m: any) => m.user_id);

  // Check-in rows
  const { data: checkins } = await db
    .from("plan_checkins")
    .select("user_id, status, checked_in_at, updated_at")
    .eq("geofence_id", geofenceId);

  const checkinMap: Record<string, any> = {};
  for (const c of checkins ?? []) checkinMap[(c as any).user_id] = c;

  // Profiles for attendees
  const allIds = [...memberIds];
  const profileMap: Record<string, any> = {};
  if (allIds.length > 0) {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", allIds);
    for (const p of profiles ?? []) profileMap[(p as any).id] = p;
  }

  // Build attendee list (status text only — never map pins or coordinates)
  const STATUS_LABEL: Record<string, string> = {
    not_checked_in: "Not checked in",
    on_the_way:     "On the way",
    nearby:         "Nearby",
    arrived:        "Arrived",
    late:           "Arrived (late)",
    no_show:        "No-show",
    left:           "Left",
  };

  const attendees = memberIds.map((uid) => {
    const p = profileMap[uid] ?? {};
    const c = checkinMap[uid];
    return {
      userId:   uid,
      handle:   (p.handle as string) ?? "",
      name:     (p.name   as string) ?? "",
      avatarUrl:(p.avatar_url as string | null) ?? null,
      status:   (c?.status as string) ?? "not_checked_in",
      statusLabel: STATUS_LABEL[(c?.status as string) ?? "not_checked_in"] ?? "Unknown",
      checkedInAt: (c?.checked_in_at as string | null) ?? null,
    };
  });

  // Totals
  const totals = {
    accepted:    memberIds.length,
    checkedIn:   attendees.filter((a) => a.status === "arrived" || a.status === "late").length,
    nearby:      attendees.filter((a) => a.status === "nearby").length,
    onTheWay:    attendees.filter((a) => a.status === "on_the_way").length,
    noShow:      attendees.filter((a) => a.status === "no_show").length,
    left:        attendees.filter((a) => a.status === "left").length,
    notCheckedIn:attendees.filter((a) => a.status === "not_checked_in").length,
  };

  res.json({
    geofenceId,
    checkInRadiusM:     (gf as any).check_in_radius_m,
    checkInWindowStart: (gf as any).check_in_window_start ?? null,
    checkInWindowEnd:   (gf as any).check_in_window_end   ?? null,
    totals,
    attendees,
  });
});

// ── POST /api/trips/:tripId/geofence/attendance/:userId/override ──────────────
// Host manually overrides a member's attendance status.

router.post("/trips/:tripId/geofence/attendance/:userId/override", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  if (!await isFeatureEnabled(db)) {
    sendError(res, "feature_disabled", "Plan geofencing is not enabled");
    return;
  }

  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId, userId } = req.params;

  const { data: trip } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can override attendance");
    return;
  }

  const { data: gf } = await db
    .from("plan_geofences")
    .select("id")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (!gf) { sendError(res, "not_found", "No geofence configured for this trip"); return; }

  const geofenceId = (gf as any).id;

  // Upsert check-in with override
  await db.from("plan_checkins").upsert(
    {
      geofence_id:  geofenceId,
      trip_id:      tripId,
      user_id:      userId,
      status:       parsed.data.status,
      override_by:  user.id,
      override_note: parsed.data.note ?? null,
      updated_at:   new Date().toISOString(),
    },
    { onConflict: "geofence_id,user_id" },
  );

  await writeAttendanceEvent(db, {
    geofenceId,
    tripId,
    userId,
    eventType: "host_manual_override",
    actorId:   user.id,
    metadata:  { newStatus: parsed.data.status, note: parsed.data.note ?? null },
  });

  res.json({ ok: true, userId, newStatus: parsed.data.status });
});

export default router;
