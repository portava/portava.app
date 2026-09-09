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
import { nameVisibilitySet } from "../lib/publicIdentity.js";
import { calculateDistanceMeters } from "../lib/locationVerify.js";
import { checkAndRecordSnapshot } from "../services/location/LocationSafetyService.js";
import { createStamp } from "../services/passport/PassportStampService.js";
import { recordContributionIfEnabled } from "../services/passport/PassportContributionService.js";
import { createSuggestedMemory } from "../services/passport/PassportMemoryService.js";
import { recordTrustEvent } from "../services/trust/TrustEventService.js";
import { recordActivityEvent } from "../compass/CompassActiveUserRewardEngine.js";
import { endFairExposure } from "../compass/CompassFairExposureEngine.js";
import { logger as rootLogger } from "../lib/logger.js";
import { affectedRows } from "../lib/affectedRows.js";

const logger = rootLogger.child({ route: "geofence" });

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const PUBLIC_PREVIEW_LEVELS = ["city_only", "neighborhood", "venue_tagged"] as const;
const EXACT_VISIBILITY       = ["exact_after_acceptance", "exact_private_host_reveal"] as const;
const ATTENDANCE_STATUSES    = ["not_checked_in","on_the_way","nearby","arrived","late","no_show","left"] as const;

// Accepted trip-membership roles — mirrors ACCEPTED_TRIP_ROLES in
// lib/circleAccessGuard.ts. An accepted co_host/viewer is a full member for
// geofence purposes (view + check-in); only pending invitees are excluded.
const ACCEPTED_TRIP_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

// Trip visibility values that expose a non-member public preview card. Mirrors
// GET /trips/:tripId gating in routes/trips-expansion.ts (private/invite → no
// preview). A missing value is treated as "private" (no preview).
const PUBLIC_PREVIEW_VISIBILITIES = new Set(["public", "buddies"]);

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

/**
 * Is plan geofencing on?
 *
 * `unknown` exists for the same reason it does in routes/safeReturn.ts: an
 * unreadable `feature_flags` used to answer FALSE, and every caller renders
 * false as a 404 "Plan geofencing is not enabled". A member standing at the
 * meetup trying to check in was told the feature does not exist, when a retry
 * would have worked.
 */
type FlagState = "on" | "off" | "unknown";

async function readFeatureFlag(db: ReturnType<typeof getServiceClient>): Promise<FlagState> {
  if (!db) return "unknown";
  try {
    const { data, error } = await db
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "plan_geofence_enabled")
      .maybeSingle();
    if (error) {
      logger.error({ err: error }, "geofence: feature flag unreadable");
      return "unknown";
    }
    return (data as any)?.enabled ? "on" : "off";
  } catch (err) {
    logger.error({ err }, "geofence: feature flag read threw");
    return "unknown";
  }
}

async function isFeatureEnabled(db: ReturnType<typeof getServiceClient>): Promise<boolean> {
  return (await readFeatureFlag(db)) === "on";
}

/**
 * Returns 'owner' | 'member' | 'invited' | null (non-accepted / not found), or
 * 'unknown' when an AUTHORIZATION INPUT could not be read.
 *
 * `null` and `unknown` both DENY — nothing is served on an unreadable gate, and
 * that posture does not change. What changes is what the caller is allowed to
 * SAY. `null` supports "you are not an accepted member of this trip"; a failed
 * read supports no claim about this person's membership at all, and answering
 * it with that sentence is a confident statement assembled from a query that
 * did not run. This is the rule lib/http.ts states for TripAccessUnavailableError.
 */
async function getMemberRole(
  db: ReturnType<typeof getServiceClient>,
  tripId: string,
  userId: string,
): Promise<"owner" | "member" | "invited" | "unknown" | null> {
  if (!db) return "unknown";
  try {
    const { data: trip, error: tripErr } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", tripId)
      .maybeSingle();
    if (tripErr) {
      logger.error({ err: tripErr, tripId }, "geofence: trips read failed — membership NOT determined");
      return "unknown";
    }
    if ((trip as any)?.owner_id === userId) return "owner";

    const { data: member, error: memberErr } = await db
      .from("trip_members")
      .select("user_id, role, status")
      .eq("trip_id", tripId)
      .eq("user_id", userId)
      .maybeSingle();
    if (memberErr) {
      logger.error({ err: memberErr, tripId, userId }, "geofence: trip_members read failed — membership NOT determined");
      return "unknown";
    }
    if (!member) return null;

    // Mirror circleAccessGuard's acceptance rule: role must be in the accepted
    // set AND (status is null OR exactly "accepted"). A pending invitee — role
    // outside the set, or status set to anything other than "accepted" — is
    // "invited" and must not gain member-level view/check-in access.
    const m = member as { role?: string | null; status?: string | null };
    const roleAccepted = ACCEPTED_TRIP_ROLES.has(m.role ?? "");
    const statusAccepted = m.status == null || m.status === "accepted";
    return roleAccepted && statusAccepted ? "member" : "invited";
  } catch (err) {
    logger.error({ err, tripId, userId }, "geofence: getMemberRole threw — membership NOT determined");
    return "unknown";
  }
}

export interface AdminGeofenceDefaults {
  defaultRadiusM: number;
  minRadiusM: number;
  maxRadiusM: number;
  noShowAffectsReliability: boolean;
}

/**
 * Admin-configured geofence policy (the singleton `geofence_admin_settings`
 * row, id = 1).
 *
 * ── EMPTY vs UNREADABLE ─────────────────────────────────────────────────────
 * NO ROW is a real, legitimate state: nobody has configured the singleton, and
 * the shipped defaults (150 / 50 / 5000 m) are the policy. That still returns
 * `ok: true`.
 *
 * An ERROR is not that. supabase-js RESOLVES on a DB error, so the old
 * `const { data } = await …; (data as any)?.min_radius_m ?? 50` collapsed both
 * into the hardcoded numbers — and the numbers are a POLICY CLAMP, not a
 * cosmetic default. An admin who tightened `max_radius_m` to, say, 200 m so a
 * check-in cannot be claimed from half a city away had that clamp silently
 * widened back to 5000 m for the duration of any read blip, and the geofence
 * was written with the loose radius and kept it permanently. The failure is not
 * transient the way the read is.
 *
 * So the result is a discriminated union — deliberately NOT a nullable settings
 * object, which invites the same `?? DEFAULTS` coercion one call site later
 * (the reasoning lib/exclusionSet.ts spells out for `ExclusionSet`). The one
 * caller refuses the write with `degraded_unavailable` (503, retryable), which
 * denies exactly one geofence save and nothing else.
 */
export type AdminGeofenceDefaultsResult =
  | { ok: true; defaults: AdminGeofenceDefaults }
  | { ok: false; reason: string };

export const GEOFENCE_FALLBACK_DEFAULTS: AdminGeofenceDefaults = {
  defaultRadiusM: 150,
  minRadiusM: 50,
  maxRadiusM: 5000,
  noShowAffectsReliability: false,
};

async function getAdminDefaults(
  db: ReturnType<typeof getServiceClient>,
): Promise<AdminGeofenceDefaultsResult> {
  const { data, error } = await db!
    .from("geofence_admin_settings")
    .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    return { ok: false, reason: String((error as any)?.message ?? (error as any)?.code ?? error) };
  }
  return {
    ok: true,
    defaults: {
      defaultRadiusM:           (data as any)?.default_radius_m             ?? GEOFENCE_FALLBACK_DEFAULTS.defaultRadiusM,
      minRadiusM:               (data as any)?.min_radius_m                 ?? GEOFENCE_FALLBACK_DEFAULTS.minRadiusM,
      maxRadiusM:               (data as any)?.max_radius_m                 ?? GEOFENCE_FALLBACK_DEFAULTS.maxRadiusM,
      noShowAffectsReliability: (data as any)?.no_show_affects_reliability  ?? GEOFENCE_FALLBACK_DEFAULTS.noShowAffectsReliability,
    },
  };
}

/**
 * Write an attendance event (never auto-punishes).
 *
 * Advisory, but no longer SILENT. `await db.from(…).insert(…)` bound nothing, so
 * the resolved `{ error }` was discarded and the `catch` could never see it —
 * supabase-js resolves rather than throws. `plan_attendance_events` is the trail
 * that explains a `suspicious_check_in` or a host's `host_manual_override`
 * after the fact, so a write that vanishes takes the explanation with it.
 * Returns whether the row landed; callers that report an outcome use it.
 */
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
): Promise<boolean> {
  try {
    const { error } = await db!.from("plan_attendance_events").insert({
      geofence_id: opts.geofenceId,
      trip_id:     opts.tripId,
      user_id:     opts.userId,
      event_type:  opts.eventType,
      actor_id:    opts.actorId ?? null,
      metadata:    opts.metadata ?? {},
    });
    if (error) {
      logger.error(
        { err: error, geofenceId: opts.geofenceId, eventType: opts.eventType },
        "geofence: attendance event write failed — this action is not in the audit trail",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, geofenceId: opts.geofenceId, eventType: opts.eventType }, "geofence: attendance event write threw");
    return false;
  }
}

/**
 * Upsert a check-in row and write the matching attendance event.
 *
 * Returns `true` only when the plan_checkins write succeeded. supabase-js
 * RESOLVES (does not throw) on a DB error, so the caller MUST honour this
 * boolean — otherwise a failed write would still report a successful check-in.
 * The attendance event is best-effort telemetry and stays non-fatal, but is
 * skipped when the load-bearing check-in write failed.
 */
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
): Promise<boolean> {
  const { error } = await db!.from("plan_checkins").upsert(
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
  if (error) return false;

  await writeAttendanceEvent(db, {
    geofenceId: opts.geofenceId,
    tripId:     opts.tripId,
    userId:     opts.userId,
    eventType:  opts.eventType,
    actorId:    opts.actorId,
    metadata:   opts.metadata ?? {},
  });
  return true;
}

// ── GET /api/trips/:tripId/geofence ───────────────────────────────────────────
// Non-accepted viewers see only public preview level (city/neighborhood/venue label).
// Accepted members see exact location only when host's exactVisibility allows it
// (or when the host has explicitly revealed it).

router.get("/trips/:tripId/geofence", async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const { client: db, user } = auth;

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { res.status(200).json({ geofence: null, featureEnabled: false }); return; }
  }

  const { tripId } = req.params;
  const role = await getMemberRole(db, tripId, user.id);
  if (role === "unknown") {
    // Refuse rather than serve the non-member preview: the preview is narrower,
    // but which shape a viewer gets is an authorization answer and there is no
    // evidence for either one.
    sendError(res, "degraded_unavailable", "We could not check your access to this trip. Please try again.");
    return;
  }

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

  // Invited (pending) members cannot access geofence at all
  if (role === "invited") {
    sendError(res, "forbidden", "Pending invitees cannot access geofence");
    return;
  }

  // Non-members get a stripped public card (no coords, no check-in data)
  if (!role) {
    // GEOFENCE-2: never emit a public preview card for a trip that is not itself
    // publicly visible. Mirror GET /trips/:tripId visibility gating
    // (routes/trips-expansion.ts): only "public"/"buddies" trips expose a
    // non-member preview; "private"/"invite" (or a missing value) reveal nothing.
    const { data: tripVis } = await db
      .from("trips")
      .select("visibility")
      .eq("id", tripId)
      .maybeSingle();
    const visibility = ((tripVis as any)?.visibility ?? "private") as string;
    if (!PUBLIC_PREVIEW_VISIBILITIES.has(visibility)) {
      sendError(res, "not_found", "No geofence preview available");
      return;
    }

    // F5: gate the public fields by the preview-level hierarchy. Each level is a
    // superset of the coarser one; never leak a finer field than the level
    // permits.
    //   city_only     → city only
    //   neighborhood  → city + neighborhood
    //   venue_tagged  → city + neighborhood + venueName + locationName
    const level = (g.public_preview_level ?? "neighborhood") as string;
    const showNeighborhood = level === "neighborhood" || level === "venue_tagged";
    const showVenue        = level === "venue_tagged";

    res.status(200).json({
      featureEnabled: true,
      geofence: {
        id:                 g.id,
        publicPreviewLevel: level,
        city:               g.city ?? null,
        neighborhood:       showNeighborhood ? (g.neighborhood ?? null) : null,
        venueName:          showVenue ? (g.venue_name ?? null) : null,
        locationName:       showVenue ? (g.location_name ?? null) : null,
        exactRevealLabel:   "Exact meetup revealed after acceptance",
        hostEnabled:        g.host_enabled,
        viewerRole:         "none",
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

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { sendError(res, "feature_disabled", "Plan geofencing is not enabled"); return; }
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

  // Validate radius against admin settings. An unreadable settings row refuses
  // the save rather than clamping to the shipped defaults — see the doc on
  // getAdminDefaults: the clamp an admin configured is a policy, and silently
  // substituting the wide built-in bounds writes a geofence that outlives the
  // blip.
  const adminSettings = await getAdminDefaults(db);
  if (!adminSettings.ok) {
    (req as any).log?.error?.(
      { reason: adminSettings.reason, where: "POST /trips/:tripId/geofence" },
      "geofence admin settings unreadable — refusing rather than clamping to built-in defaults",
    );
    sendError(res, "degraded_unavailable", "Geofence settings could not be verified right now. Please try again.");
    return;
  }
  const adminDefaults = adminSettings.defaults;
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

  // Upsert on trip_id (UNIQUE added in migration 0039).
  // supabase-js RESOLVES on a DB error, so an unbound `error` read an
  // unreadable plan_geofences row as "no geofence set yet" and took the INSERT
  // branch against a trip that already has one: the unique index rejects it and
  // the host's edit to the meeting point — radius, check-in window, exact
  // visibility — is reported as a raw db_error while the OLD geofence stays
  // live. The same "refuse rather than guess" rule the admin-settings read
  // above already follows.
  const { data: existing, error: existingErr } = await db
    .from("plan_geofences")
    .select("id")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (existingErr) {
    req.log.error({ err: existingErr, tripId }, "geofence: existing-row lookup failed — refusing to insert over a possible existing geofence");
    sendError(res, "db_error", existingErr.message);
    return;
  }

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

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { sendError(res, "feature_disabled", "Plan geofencing is not enabled"); return; }
  }

  const { tripId } = req.params;
  const { data: trip, error: tripErr } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "geofence reveal: trips read failed");
    sendError(res, "degraded_unavailable", "We could not verify trip ownership. Please try again.");
    return;
  }
  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can reveal the exact location");
    return;
  }

  // `.select("trip_id")` so a zero-row UPDATE is visible.
  //
  // Without RETURNING, PostgREST answers a matched-nothing UPDATE with 204 —
  // the same answer as a successful one — so a host with no `plan_geofences`
  // row got `{ ok: true }` and a UI that says the exact address is now shared
  // with their group, while `host_revealed` was never set on anything. This is
  // the safe direction for the members' privacy and the WRONG one for the
  // host's understanding: they believe people can find the meetup and stop
  // telling them where it is.
  const { data: revealed, error } = await db
    .from("plan_geofences")
    .update({ host_revealed: true, updated_at: new Date().toISOString() })
    .eq("trip_id", tripId)
    .select("trip_id");

  if (error) {
    req.log.error({ err: error, tripId }, "geofence reveal: update failed");
    sendError(res, "db_error", error.message);
    return;
  }
  if (affectedRows(revealed) === 0) {
    req.log.warn({ tripId }, "geofence reveal: no geofence row matched — nothing was revealed");
    sendError(res, "not_found", "No geofence configured for this trip");
    return;
  }
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

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { sendError(res, "feature_disabled", "Plan geofencing is not enabled"); return; }
  }

  const parsed = checkInSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId } = req.params;
  const { lat, lng } = parsed.data;

  // Must be an accepted member (owner or member) — invited/pending users cannot check in
  const role = await getMemberRole(db, tripId, user.id);
  if (role === "unknown") {
    // Still denied — but "you are not an accepted trip member" is a claim about
    // this person, and it must not be made out of a read that failed.
    sendError(res, "degraded_unavailable", "We could not check your trip membership. Please try again.");
    return;
  }
  if (role !== "owner" && role !== "member") {
    sendError(res, "not_member", "You must be an accepted trip member to check in");
    return;
  }

  // Load geofence
  const { data: gf, error: gfErr } = await db
    .from("plan_geofences")
    .select("id, lat, lng, check_in_radius_m, check_in_required, check_in_window_start, check_in_window_end, host_enabled, trip_id, city, neighborhood, location_name")
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
  // Window-closed: allow check-in but mark as late (creates late_check_in trust event)
  // Users who arrive late are still admitted; the trust engine logs it.

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

  const checkinPersisted = await upsertCheckin(db, {
    geofenceId,
    tripId,
    userId: user.id,
    status:    arrivalStatus,
    eventType,
    metadata:  { distanceBucket: distanceM <= 100 ? "same_venue" : "inside_radius" },
  });

  // The check-in row write is load-bearing: if it failed, the member is NOT
  // recorded as arrived, so we must NOT report success (nor award trust/stamp).
  if (!checkinPersisted) {
    req.log.error({ tripId, geofenceId, userId: user.id }, "geofence: check-in write failed");
    sendError(res, "db_error", "Check-in could not be saved. Please try again.");
    return;
  }

  // Feed plan attendance into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(db, {
    userId: user.id,
    eventType: "plan_attended",
    category: "plan_attendance",
    delta: isLate ? 2 : 5,
    severity: "minor",
    sourceType: "geofence_checkin",
    sourceId: geofenceId,
    dedupWindowHours: 24,
  });

  // Fire-and-forget: award a plan check-in stamp + suggested memory behind feature flag
  const gfCity: string | null = (geofence as any).city ?? null;
  const gfNeighborhood: string | null = (geofence as any).neighborhood ?? null;
  const gfLocationName: string | null = (geofence as any).location_name ?? null;
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
        stampType: "plan",
        tripId,
        city: gfCity,
        neighborhood: gfNeighborhood,
        verificationLevel: "checkin",
        sourceType: "geofence_checkin",
      });
      // §20 ledger (TABLE 21): a geofence check-in is a CONFIRMATION of
      // real-world plan attendance — one of the three types
      // PassportReputationService counts as `confirmations`, and until now it
      // had no writer anywhere. Keyed on the geofence so re-entering the fence
      // cannot double-credit.
      void recordContributionIfEnabled(sc, {
        userId: user.id,
        eventType: "plan_attendance_verified",
        sourceType: "geofence_checkin",
        sourceId: geofenceId,
        verificationLevel: "checkin",
        metadata: { city: gfCity, category: "meetup" },
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
            title: gfLocationName ?? gfCity ?? "Meetup check-in",
            country: null,
            city: gfCity,
            neighborhood: gfNeighborhood,
            category: "meetup",
            tripId,
            sourceType: "geofence_checkin",
            verificationLevel: "checkin",
            suggestionReason: "You checked in to a trip meetup",
          });
        }
      }
    } catch {}
  })();

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

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { sendError(res, "feature_disabled", "Plan geofencing is not enabled"); return; }
  }

  const { tripId } = req.params;

  // Must be trip owner to see full attendance
  const { data: trip, error: tripErr } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "geofence attendance: trips read failed");
    sendError(res, "degraded_unavailable", "We could not verify trip ownership. Please try again.");
    return;
  }
  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can view attendance");
    return;
  }

  const { data: gf, error: gfErr } = await db
    .from("plan_geofences")
    .select("id, check_in_radius_m, check_in_window_start, check_in_window_end")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (gfErr) {
    req.log.error({ err: gfErr, tripId }, "geofence attendance: geofence read failed");
    sendError(res, "degraded_unavailable", "Attendance could not be loaded. Please try again.");
    return;
  }
  if (!gf) {
    res.status(200).json({ attendance: null, message: "No geofence configured" });
    return;
  }

  const geofenceId = (gf as any).id;

  // ── THE TWO READS THAT MAKE THIS PAGE A SAFETY SURFACE ────────────────────
  //
  // This is the host's answer to "who has actually turned up, and who has not".
  // Both reads were unchecked, so an unreadable `trip_members` produced an
  // EMPTY roster (nobody is expected — so nobody is missing) and an unreadable
  // `plan_checkins` marked every expected member "Not checked in". Either way
  // the totals rendered cleanly and confidently out of nothing, and the second
  // is worse than the first: a host scanning for who has not arrived would see
  // the whole group flagged, or an empty list, with no indication that the
  // page was guessing.
  const { data: members, error: membersErr } = await db
    .from("trip_members")
    .select("user_id")
    .eq("trip_id", tripId)
    .eq("role", "member");

  if (membersErr) {
    req.log.error({ err: membersErr, tripId }, "geofence attendance: trip_members read failed");
    sendError(res, "degraded_unavailable", "Attendance could not be loaded. Please try again.");
    return;
  }

  const memberIds: string[] = (members ?? []).map((m: any) => m.user_id);

  // Check-in rows
  const { data: checkins, error: checkinsErr } = await db
    .from("plan_checkins")
    .select("user_id, status, checked_in_at, updated_at")
    .eq("geofence_id", geofenceId);

  if (checkinsErr) {
    req.log.error({ err: checkinsErr, geofenceId }, "geofence attendance: plan_checkins read failed");
    sendError(res, "degraded_unavailable", "Attendance could not be loaded. Please try again.");
    return;
  }

  const checkinMap: Record<string, any> = {};
  for (const c of checkins ?? []) checkinMap[(c as any).user_id] = c;

  // Profiles for attendees. Cosmetic only — a missing profile costs a handle,
  // not an attendance status — so a failure degrades the labels and is logged
  // rather than refusing the whole page.
  const allIds = [...memberIds];
  const profileMap: Record<string, any> = {};
  if (allIds.length > 0) {
    const { data: profiles, error: profilesErr } = await db
      .from("profiles")
      .select("id, handle, name, avatar_url")
      .in("id", allIds);
    if (profilesErr) req.log.warn({ err: profilesErr, tripId }, "geofence attendance: profiles read failed — names omitted");
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

  // Universal display-name rule: attendees show @handle unless opted in.
  const allowedAttendeeNames = await nameVisibilitySet(db, memberIds);

  const attendees = memberIds.map((uid) => {
    const p = profileMap[uid] ?? {};
    const c = checkinMap[uid];
    const nameOk = uid === user.id || allowedAttendeeNames.has(uid);
    return {
      userId:   uid,
      handle:   (p.handle as string) ?? "",
      name:     nameOk ? ((p.name as string) ?? "") : "",
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

  {
    const flag = await readFeatureFlag(db);
    if (flag === "unknown") {
    sendError(res, "degraded_unavailable", "Plan geofencing availability could not be confirmed. Please try again.");
    return;
    }
    if (flag === "off") { sendError(res, "feature_disabled", "Plan geofencing is not enabled"); return; }
  }

  const parsed = overrideSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { tripId, userId } = req.params;

  const { data: trip, error: tripErr } = await db
    .from("trips")
    .select("owner_id")
    .eq("id", tripId)
    .maybeSingle();

  if (tripErr) {
    req.log.error({ err: tripErr, tripId }, "geofence override: trips read failed");
    sendError(res, "degraded_unavailable", "We could not verify trip ownership. Please try again.");
    return;
  }
  if (!trip || (trip as any).owner_id !== user.id) {
    sendError(res, "forbidden", "Only the trip owner can override attendance");
    return;
  }

  const { data: gf, error: gfErr } = await db
    .from("plan_geofences")
    .select("id")
    .eq("trip_id", tripId)
    .maybeSingle();

  if (gfErr) {
    req.log.error({ err: gfErr, tripId }, "geofence override: geofence read failed");
    sendError(res, "degraded_unavailable", "We could not load this trip's geofence. Please try again.");
    return;
  }
  if (!gf) { sendError(res, "not_found", "No geofence configured for this trip"); return; }

  const geofenceId = (gf as any).id;

  // ── THE WRITE WHOSE RESULT WAS NEVER LOOKED AT ────────────────────────────
  //
  // `await db.from("plan_checkins").upsert(…)` bound nothing at all. supabase-js
  // RESOLVES on a database error, so a failed upsert was indistinguishable from
  // a successful one, and the handler answered `{ ok: true, newStatus }` either
  // way. Worse, the `no_show` branch below then fed `recordActivityEvent` and
  // `endFairExposure` — a reliability penalty against the member — off a status
  // change that may never have been stored. A host who marks someone present
  // after a dispute must be able to trust that the record changed.
  //
  // `.select("user_id")` makes a zero-row upsert visible too. Zero here is a
  // FAILURE, not an idempotent no-op: an upsert is supposed to insert when it
  // does not update, so nothing matching means nothing was written.
  const { data: overridden, error: overrideErr } = await db
    .from("plan_checkins")
    .upsert(
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
    )
    .select("user_id");

  if (overrideErr || affectedRows(overridden) === 0) {
    req.log.error(
      { err: overrideErr, tripId, geofenceId, userId, status: parsed.data.status },
      "geofence override: attendance status NOT changed",
    );
    sendError(res, "db_error", "Attendance status could not be updated. Please try again.");
    return;
  }

  const auditWritten = await writeAttendanceEvent(db, {
    geofenceId,
    tripId,
    userId,
    eventType: "host_manual_override",
    actorId:   user.id,
    metadata:  { newStatus: parsed.data.status, note: parsed.data.note ?? null },
  });
  if (!auditWritten) {
    req.log.error({ tripId, geofenceId, userId }, "geofence override: applied but NOT recorded in the attendance audit trail");
  }

  // Compass activity ingestion for no-show: record event + end fair-exposure.
  // Reached only now that the status change is confirmed stored — this is a
  // reliability penalty and must never be applied for a write that failed.
  if (parsed.data.status === "no_show") {
    const sc = getServiceClient();
    void Promise.resolve(recordActivityEvent(sc, userId, "no_show")).catch((err: unknown) =>
      req.log.warn({ err, userId }, "geofence override: recordActivityEvent failed (non-fatal)"),
    );
    void Promise.resolve(endFairExposure(sc, userId, "no_show")).catch((err: unknown) =>
      req.log.warn({ err, userId }, "geofence override: endFairExposure failed (non-fatal)"),
    );
  }

  res.json({
    ok: true,
    userId,
    newStatus: parsed.data.status,
    ...(auditWritten ? {} : { auditIncomplete: true }),
  });
});

export default router;
