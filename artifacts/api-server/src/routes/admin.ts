/**
 * Admin geo controls
 *
 * Role-gated routes (profiles.role = 'admin' required).
 *
 * Geo zones  (geo_zones table — migration 0034):
 *   GET    /admin/geo-zones          — list
 *   POST   /admin/geo-zones          — create
 *   GET    /admin/geo-zones/:id      — single
 *   PATCH  /admin/geo-zones/:id      — update fields
 *   DELETE /admin/geo-zones/:id      — delete
 *
 * Suspicious GPS review  (location_trust_events — migration 0033):
 *   GET  /admin/suspicious-gps           — unreviewed events
 *   POST /admin/suspicious-gps/:id/resolve — mark reviewed
 *
 * Venue moderation  (discovery_places — migration 0029):
 *   GET  /admin/venues/pending        — provisional community places
 *   POST /admin/venues/:id/moderate   — approve (→ verified) or reject (→ blocked)
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

// ── Admin guard ───────────────────────────────────────────────────────────────

/**
 * Returns the authenticated user's client (from requireUser / _testClient in tests)
 * plus the service client (for bypassing RLS in production).
 *
 * In tests: `sc` is the fake client injected via _setTestClient.
 * In production: `sc` is the real service-role client from getServiceClient().
 */
async function requireAdmin(
  req: any,
  res: any,
): Promise<{ userId: string; client: any; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }

  // Prefer the real service client in production; fall back to the user client
  // (which equals _testClient in tests) so routes are fully testable without
  // real Supabase credentials.
  const sc = getServiceClient() ?? client;
  return { userId: user.id, client, sc };
}

// ── Geo zone schemas ──────────────────────────────────────────────────────────

// Valid zone_type values from the migration comment
const GEO_ZONE_TYPES = ["city", "neighborhood", "district", "venue_area", "safety_zone"] as const;
// Valid safety_rating values from the migration comment
const SAFETY_RATINGS = ["safe", "moderate", "caution", "avoid"] as const;

const createGeoZoneSchema = z.object({
  name:          z.string().min(1).max(200),
  zoneType:      z.enum(GEO_ZONE_TYPES),
  centerLat:     z.number().min(-90).max(90).optional(),
  centerLng:     z.number().min(-180).max(180).optional(),
  radiusMeters:  z.number().positive().max(100_000).optional(),
  boundsJson:    z.record(z.unknown()).optional(),
  city:          z.string().max(120).optional(),
  countryCode:   z.string().max(4).optional(),
  safetyRating:  z.enum(SAFETY_RATINGS).optional(),
  featured:      z.boolean().optional().default(false),
  verified:      z.boolean().optional().default(false),
});

// ── GET /admin/geo-zones ──────────────────────────────────────────────────────

router.get("/admin/geo-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page  = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Number(req.query.limit) || 50);
  const city  = ((req.query.city as string) ?? "").trim() || null;

  let query = sc
    .from("geo_zones")
    .select(
      "id, zone_type, name, city, country_code, center_lat, center_lng, radius_meters, " +
      "safety_rating, featured, verified, created_by, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (city) query = query.ilike("city", `%${city}%`);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ zones: data ?? [], total: count ?? 0, page });
});

// ── POST /admin/geo-zones ─────────────────────────────────────────────────────

router.post("/admin/geo-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createGeoZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc
    .from("geo_zones")
    .insert({
      name:          d.name,
      zone_type:     d.zoneType,
      center_lat:    d.centerLat     ?? null,
      center_lng:    d.centerLng     ?? null,
      radius_meters: d.radiusMeters  ?? null,
      bounds_json:   d.boundsJson    ?? null,
      city:          d.city          ?? null,
      country_code:  d.countryCode   ?? null,
      safety_rating: d.safetyRating  ?? null,
      featured:      d.featured      ?? false,
      verified:      d.verified      ?? false,
      created_by:    admin.userId,
    })
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ zone: data });
});

// ── GET /admin/geo-zones/:id ──────────────────────────────────────────────────

router.get("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("geo_zones")
    .select()
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Geo zone not found"); return; }
  res.json({ zone: data });
});

// ── PATCH /admin/geo-zones/:id ────────────────────────────────────────────────

router.patch("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = createGeoZoneSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;
  const patch: Record<string, unknown> = {};
  if (d.name         !== undefined) patch.name          = d.name;
  if (d.zoneType     !== undefined) patch.zone_type     = d.zoneType;
  if (d.centerLat    !== undefined) patch.center_lat    = d.centerLat;
  if (d.centerLng    !== undefined) patch.center_lng    = d.centerLng;
  if (d.radiusMeters !== undefined) patch.radius_meters = d.radiusMeters;
  if (d.boundsJson   !== undefined) patch.bounds_json   = d.boundsJson;
  if (d.city         !== undefined) patch.city          = d.city;
  if (d.countryCode  !== undefined) patch.country_code  = d.countryCode;
  if (d.safetyRating !== undefined) patch.safety_rating = d.safetyRating;
  if (d.featured     !== undefined) patch.featured      = d.featured;
  if (d.verified     !== undefined) patch.verified      = d.verified;

  if (Object.keys(patch).length === 0) {
    sendError(res, "invalid_payload", "No fields to update");
    return;
  }
  patch.updated_at = new Date().toISOString();

  const { data, error } = await sc
    .from("geo_zones")
    .update(patch)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Geo zone not found"); return; }
  res.json({ zone: data });
});

// ── DELETE /admin/geo-zones/:id ───────────────────────────────────────────────

router.delete("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { error } = await sc.from("geo_zones").delete().eq("id", req.params.id);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(204).end();
});

// ── Suspicious GPS review ─────────────────────────────────────────────────────
// Table: location_trust_events (migration 0033)
// Columns: id, user_id, event_type, confidence (low|medium|high),
//          details (JSONB), reviewed_at, reviewed_by, created_at
// Unreviewed = reviewed_at IS NULL

/** GET /admin/suspicious-gps — unreviewed trust events, oldest first */
router.get("/admin/suspicious-gps", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("location_trust_events")
    .select("id, user_id, event_type, confidence, details, created_at")
    .is("reviewed_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  const events = (data ?? []).map(({ lat: _lat, lng: _lng, ...rest }: Record<string, unknown>) => rest);
  res.json({ events, total: events.length });
});

/** POST /admin/suspicious-gps/:id/resolve — mark a trust event reviewed */
router.post("/admin/suspicious-gps/:id/resolve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const schema = z.object({
    resolution: z.enum(["cleared", "flagged", "banned"]),
    note:       z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data, error } = await sc
    .from("location_trust_events")
    .update({
      reviewed_at:  new Date().toISOString(),
      reviewed_by:  admin.userId,
      // Append review outcome to details so the original signal is preserved
      details: { resolution: parsed.data.resolution, note: parsed.data.note ?? null },
    })
    .eq("id", req.params.id)
    .is("reviewed_at", null)       // idempotency guard
    .select("id, confidence, reviewed_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data)  { sendError(res, "not_found", "Trust event not found or already reviewed"); return; }
  res.json({ event: data });
});

// ── Venue moderation ──────────────────────────────────────────────────────────
// Table: discovery_places (migration 0029)
// status flow: provisional (default) → verified | blocked
// submitted_by references profiles(id)

/** GET /admin/venues/pending — community places awaiting moderation */
router.get("/admin/venues/pending", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("discovery_places")
    .select("id, name, place_type, category, city, neighborhood, blurb, source, submitted_by, created_at")
    .eq("status", "provisional")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ venues: data ?? [], total: (data ?? []).length });
});

/** POST /admin/venues/:id/moderate — approve or reject a provisional discovery place */
router.post("/admin/venues/:id/moderate", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const schema = z.object({
    action: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  // approve → verified; reject → blocked (valid status enum values per migration)
  const newStatus = parsed.data.action === "approve" ? "verified" : "blocked";

  const { data, error } = await sc
    .from("discovery_places")
    .update({ status: newStatus })
    .eq("id", req.params.id)
    .eq("status", "provisional")   // only moderate provisional items
    .select("id, name, status")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Venue not found or not in provisional status"); return; }
  res.json({ venue: data });
});

/**
 * GET /admin/venues/reported
 * Lists community discovery places that have received user reports,
 * ordered by report count descending. Includes report count and most
 * recent report reason so admins can prioritise review.
 */
router.get("/admin/venues/reported", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("discovery_places")
    .select(
      "id, name, place_type, category, city, neighborhood, blurb, status, submitted_by, created_at, " +
      "discovery_place_reports(count)",
    )
    .gt("discovery_place_reports.count" as any, 0)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }

  // Sort by report count descending after fetch (Supabase doesn't support ordering by embedded count)
  const venues = (data ?? [])
    .map((row: any) => ({
      id:           row.id,
      name:         row.name,
      placeType:    row.place_type,
      category:     row.category,
      city:         row.city,
      neighborhood: row.neighborhood,
      blurb:        row.blurb,
      status:       row.status,
      submittedBy:  row.submitted_by,
      createdAt:    row.created_at,
      reportCount:  Array.isArray(row.discovery_place_reports)
        ? (row.discovery_place_reports[0]?.count ?? 0)
        : 0,
    }))
    .filter((v: any) => v.reportCount > 0)
    .sort((a: any, b: any) => b.reportCount - a.reportCount);

  res.json({ venues, total: venues.length });
});

/**
 * PATCH /admin/venues/:id/status
 * Flip the status of any discovery place (active, removed, verified, blocked, provisional).
 * 'removed' is the primary action to hide an inappropriate place from all Discovery feeds.
 * Removed places are automatically excluded from GET /api/discovery/community
 * which filters `.eq('status', 'active')`.
 */
router.patch("/admin/venues/:id/status", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const schema = z.object({
    status: z.enum(["active", "removed", "verified", "blocked", "provisional"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data, error } = await sc
    .from("discovery_places")
    .update({ status: parsed.data.status })
    .eq("id", req.params.id)
    .select("id, name, status")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Venue not found"); return; }
  res.json({ venue: data });
});

// ── Geofence admin controls ───────────────────────────────────────────────────
// Table: geofence_admin_settings (migration 0039)
// Single-row config for default/min/max check-in radius and global no-show flag.

/** GET /admin/geofence-settings — read current admin radius config */
router.get("/admin/geofence-settings", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("geofence_admin_settings")
    .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({
    settings: data ?? {
      default_radius_m: 150,
      min_radius_m: 50,
      max_radius_m: 5000,
      no_show_affects_reliability: false,
    },
  });
});

/** PATCH /admin/geofence-settings — update radius defaults */
const geofenceSettingsSchema = z.object({
  defaultRadiusM:            z.number().int().min(10).max(10_000).optional(),
  minRadiusM:                z.number().int().min(10).max(1_000).optional(),
  maxRadiusM:                z.number().int().min(100).max(50_000).optional(),
  noShowAffectsReliability:  z.boolean().optional(),
}).strict();

router.patch("/admin/geofence-settings", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = geofenceSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.defaultRadiusM           !== undefined) patch.default_radius_m           = parsed.data.defaultRadiusM;
  if (parsed.data.minRadiusM               !== undefined) patch.min_radius_m               = parsed.data.minRadiusM;
  if (parsed.data.maxRadiusM               !== undefined) patch.max_radius_m               = parsed.data.maxRadiusM;
  if (parsed.data.noShowAffectsReliability !== undefined) patch.no_show_affects_reliability = parsed.data.noShowAffectsReliability;

  const { data, error } = await sc
    .from("geofence_admin_settings")
    .update(patch)
    .eq("id", 1)
    .select("default_radius_m, min_radius_m, max_radius_m, no_show_affects_reliability, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ settings: data });
});

/** POST /admin/geofence/:tripId/override-reveal — admin can force-reveal exact location */
router.post("/admin/geofence/:tripId/override-reveal", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("plan_geofences")
    .update({ host_revealed: true, updated_at: new Date().toISOString() })
    .eq("trip_id", req.params.tripId)
    .select("id, trip_id, host_revealed")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data)  { sendError(res, "not_found", "No geofence for this trip"); return; }
  res.json({ geofence: data });
});

/** GET /admin/geofence/:tripId/suspicious-checkins — suspicious check-in events for a trip */
router.get("/admin/geofence/:tripId/suspicious-checkins", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("plan_attendance_events")
    .select("id, user_id, event_type, metadata, created_at")
    .eq("trip_id", req.params.tripId)
    .eq("event_type", "suspicious_check_in")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ events: data ?? [], total: (data ?? []).length });
});

// ── Feature-flag admin routes ─────────────────────────────────────────────────
// All flags seeded by migrations 0037, 0041, 0042 start disabled=false.
// Use these routes to toggle them on as each feature ships.

/**
 * GET /admin/feature-flags
 * Returns every row in feature_flags ordered by flag name.
 */
router.get("/admin/feature-flags", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { data, error } = await sc
    .from("feature_flags")
    .select("flag, enabled, description, updated_at")
    .order("flag");

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ flags: data ?? [] });
});

/**
 * PATCH /admin/feature-flags/:flag
 * Toggle a single feature flag on or off.
 * Body: { enabled: boolean }
 */
const toggleFlagSchema = z.object({ enabled: z.boolean() });

router.patch("/admin/feature-flags/:flag", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = toggleFlagSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", "Body must have { enabled: boolean }");
    return;
  }

  const { data, error } = await sc
    .from("feature_flags")
    .update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() })
    .eq("flag", req.params.flag)
    .select("flag, enabled, description, updated_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data)  { sendError(res, "not_found", `Flag '${req.params.flag}' not found`); return; }

  req.log.info({ flag: data.flag, enabled: data.enabled }, "feature-flag toggled");
  res.json({ flag: data });
});

// ── Safe Return admin routes ──────────────────────────────────────────────────
// All gated by safe_return_admin_logs_enabled feature flag + requireAdmin.

async function isSafeReturnAdminEnabled(sc: any): Promise<boolean> {
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("flag", "safe_return_admin_logs_enabled")
      .maybeSingle();
    return Boolean((data as any)?.enabled);
  } catch { return false; }
}

/**
 * GET /admin/safe-return/logs
 * Returns recent Safe Return events (all users) — admin only.
 */
router.get("/admin/safe-return/logs", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  if (!await isSafeReturnAdminEnabled(sc)) {
    sendError(res, "feature_disabled", "Safe Return admin logs are not enabled");
    return;
  }

  const limit = Math.min(100, parseInt(String((req.query as any).limit ?? "50"), 10) || 50);
  const { data, error } = await sc
    .from("safe_return_events")
    .select("id, session_id, user_id, event_type, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ events: data ?? [], total: (data ?? []).length });
});

/**
 * GET /admin/safe-return/config
 * Returns current Safe Return feature flag states.
 * Gated by safe_return_admin_logs_enabled (seeded TRUE in migration 0040
 * so fresh installs can always reach config without a bootstrap deadlock).
 */
router.get("/admin/safe-return/config", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  if (!await isSafeReturnAdminEnabled(sc)) {
    sendError(res, "feature_disabled", "Safe Return admin is not enabled");
    return;
  }

  const flags = [
    "safe_return_enabled",
    "safe_return_live_share_enabled",
    "safe_return_trusted_circle_alerts_enabled",
    "safe_return_admin_logs_enabled",
  ];

  const { data, error } = await sc
    .from("feature_flags")
    .select("flag, enabled, description, updated_at")
    .in("flag", flags);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ config: data ?? [] });
});

/**
 * PATCH /admin/safe-return/config
 * Update one or more Safe Return feature flags.
 * Body: { flags: { safe_return_enabled?: boolean, ... } }
 * Gated by safe_return_admin_logs_enabled (seeded true in migration 0037).
 */
router.patch("/admin/safe-return/config", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  if (!await isSafeReturnAdminEnabled(sc)) {
    sendError(res, "feature_disabled", "Safe Return admin is not enabled");
    return;
  }

  const allowedFlags = new Set([
    "safe_return_enabled",
    "safe_return_live_share_enabled",
    "safe_return_trusted_circle_alerts_enabled",
    "safe_return_admin_logs_enabled",
  ]);

  const flags = (req.body ?? {}).flags as Record<string, boolean>;
  if (!flags || typeof flags !== "object") {
    sendError(res, "invalid_payload", "Body must have { flags: { flagKey: boolean } }");
    return;
  }

  const updates = Object.entries(flags).filter(
    ([key, val]) => allowedFlags.has(key) && typeof val === "boolean",
  );

  if (updates.length === 0) {
    sendError(res, "invalid_payload", "No valid flag keys provided");
    return;
  }

  const results: Record<string, boolean> = {};
  await Promise.all(
    updates.map(async ([key, enabled]) => {
      const { error } = await sc
        .from("feature_flags")
        .update({ enabled, updated_at: new Date().toISOString() })
        .eq("flag", key);
      if (!error) results[key] = enabled;
    }),
  );

  res.json({ ok: true, updated: results });
});


// ── Admin moderation action ───────────────────────────────────────────────────
//
// PATCH /admin/users/:userId/moderation-action
//
// Applies a moderation action to a user.
// EVERY action writes an audit-log row to moderation_actions (append-only).
// Some actions additionally mutate user_account_states or reports rows.
//
// action_type values:
//   warn | message_limit | invite_limit | hosting_limit | discovery_hidden
//   rent_a_buddy_frozen | temporary_suspension | permanent_ban
//   report_resolved | content_removed | event_removed | circle_removed | booking_frozen

const MODERATION_ACTION_TYPES = [
  "warn",
  "message_limit",
  "invite_limit",
  "hosting_limit",
  "discovery_hidden",
  "rent_a_buddy_frozen",
  "temporary_suspension",
  "permanent_ban",
  "report_resolved",
  "content_removed",
  "event_removed",
  "circle_removed",
  "booking_frozen",
] as const;

const moderationActionSchema = z.object({
  action_type:  z.enum(MODERATION_ACTION_TYPES),
  reason:       z.string().max(1000).optional().nullable(),
  expires_at:   z.string().datetime().optional().nullable(), // for temporary_suspension
  target_ref_id: z.string().uuid().optional().nullable(),   // for report_resolved / content/event/circle/booking actions
});

router.patch("/admin/users/:userId/moderation-action", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;

  const { userId } = req.params;

  const parsed = moderationActionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const { action_type, reason, expires_at, target_ref_id } = parsed.data;

  const now = new Date().toISOString();

  // ── AUDIT LOG: write a moderation_actions row for EVERY action ──────────
  const { data: auditRow, error: auditErr } = await sc
    .from("moderation_actions")
    .insert({
      target_user_id: userId,
      action_type,
      reason:       reason ?? null,
      performed_by: adminUserId,
      created_at:   now,
    })
    .select("id, target_user_id, action_type, reason, performed_by, created_at")
    .single();

  if (auditErr) {
    sendError(res, "db_error", `Audit log write failed: ${auditErr.message}`);
    return;
  }

  const sideEffects: Record<string, unknown> = {};

  // ── SIDE EFFECTS by action_type ──────────────────────────────────────────

  if (action_type === "temporary_suspension") {
    const { error } = await sc.from("user_account_states").upsert(
      {
        user_id:    userId,
        state:      "suspended",
        reason:     reason ?? null,
        expires_at: expires_at ?? null,
        set_by:     adminUserId,
        created_at: now,
      },
      { onConflict: "user_id,state" },
    );
    sideEffects.accountState = error ? "error" : "suspended";
  }

  if (action_type === "permanent_ban") {
    const { error } = await sc.from("user_account_states").upsert(
      {
        user_id:    userId,
        state:      "banned",
        reason:     reason ?? null,
        expires_at: null,
        set_by:     adminUserId,
        created_at: now,
      },
      { onConflict: "user_id,state" },
    );
    sideEffects.accountState = error ? "error" : "banned";
  }

  if (action_type === "report_resolved" && target_ref_id) {
    const { error } = await sc
      .from("reports")
      .update({
        status:           "resolved",
        reviewed_by:      adminUserId,
        reviewed_at:      now,
        moderation_notes: reason ?? null,
        updated_at:       now,
      })
      .eq("id", target_ref_id);
    sideEffects.reportStatus = error ? "error" : "resolved";
  }

  res.json({ action: auditRow, sideEffects });
});

// ── Admin profile moderation — individual action routes ───────────────────────
//
// Convenience endpoints that wrap the existing PATCH /admin/users/:userId/moderation-action
// with a structured audit log + targeted account_status mutation.
// All actions require admin role and write to the moderation_actions audit table.

const PROFILE_MEDIA_BUCKET = "profile-media";

async function logModerationAction(
  sc: any,
  targetUserId: string,
  adminUserId: string,
  actionType: string,
  reason: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await sc.from("moderation_actions").insert({
    target_user_id: targetUserId,
    action_type: actionType,
    reason: reason ?? null,
    performed_by: adminUserId,
    created_at: new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** GET /admin/users/:userId/summary — full profile + trust/safety context for admin */
router.get("/admin/users/:userId/summary", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;
  const { userId } = req.params;

  const [
    profileRes,
    accountStateRes,
    modActionsRes,
    reportsReceivedRes,
    reportsFiledRes,
    trustRes,
    blocksRes,
    mutesRes,
    restrictsRes,
  ] = await Promise.all([
    sc.from("profiles")
      .select("id, handle, username, name, display_name, bio, avatar_url, cover_photo_url, home_city, home_country, role, verified, verification_status, account_status, created_at, spoken_languages, interests")
      .eq("id", userId)
      .maybeSingle(),
    sc.from("user_account_states")
      .select("state, reason, expires_at, set_by, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(10),
    sc.from("moderation_actions")
      .select("id, action_type, reason, performed_by, created_at")
      .eq("target_user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    sc.from("reports")
      .select("id, target_type, reason_code, severity, status, created_at")
      .eq("target_id", userId)
      .in("target_type", ["user", "profile"])
      .order("created_at", { ascending: false })
      .limit(50),
    sc.from("reports")
      .select("id, target_type, target_id, reason_code, severity, status, created_at")
      .eq("reporter_id", userId)
      .order("created_at", { ascending: false })
      .limit(20),
    sc.from("trust_restrictions")
      .select("id, restriction_type, reason, lifted_at, created_at")
      .eq("user_id", userId)
      .is("lifted_at", null),
    sc.from("blocks")
      .select("id", { count: "exact", head: true })
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    sc.from("user_mutes")
      .select("id", { count: "exact", head: true })
      .eq("muter_id", userId),
    sc.from("user_restrictions")
      .select("id", { count: "exact", head: true })
      .eq("restrictor_id", userId),
  ]);

  if (!profileRes.data) { sendError(res, "not_found", "User not found"); return; }

  res.json({
    profile:           profileRes.data,
    accountStates:     accountStateRes.data    ?? [],
    moderationActions: modActionsRes.data      ?? [],
    reportsReceived:   reportsReceivedRes.data ?? [],
    reportsFiled:      reportsFiledRes.data    ?? [],
    trustRestrictions: (trustRes as any).data  ?? [],
    blockCount:        blocksRes.count          ?? 0,
    muteCount:         mutesRes.count           ?? 0,
    restrictCount:     restrictsRes.count       ?? 0,
  });
});

/** POST /admin/users/:userId/verify */
router.post("/admin/users/:userId/verify", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;

  // Audit first (fail-closed): if audit insert fails, do not apply the action
  const auditR = await logModerationAction(sc, userId, adminUserId, "verify", (req.body as any)?.reason ?? null);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { error } = await sc.from("profiles")
    .update({ verified: true, verification_status: "verified", verified_at: now })
    .eq("id", userId);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, verified: true });
});

/** POST /admin/users/:userId/unverify */
router.post("/admin/users/:userId/unverify", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "unverify", (req.body as any)?.reason ?? null);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error } = await sc.from("profiles")
    .update({ verified: false, verification_status: "unverified", verified_at: null })
    .eq("id", userId);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, verified: false });
});

/** POST /admin/users/:userId/warn — record a warning (does not change account status) */
router.post("/admin/users/:userId/warn", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  const { data, error } = await sc.from("moderation_actions").insert({
    target_user_id: userId,
    action_type: "warn",
    reason,
    performed_by: adminUserId,
    created_at: new Date().toISOString(),
  }).select("id, action_type, reason, performed_by, created_at").single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ action: data });
});

/** POST /admin/users/:userId/restrict — restrict user interactions */
router.post("/admin/users/:userId/restrict", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "message_limit", reason);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error: stateErr } = await sc.from("user_account_states")
    .upsert({ user_id: userId, state: "restricted", reason, set_by: adminUserId, created_at: new Date().toISOString() }, { onConflict: "user_id,state" });
  if (stateErr) { sendError(res, "db_error", stateErr.message); return; }

  res.json({ ok: true, restricted: true });
});

/** POST /admin/users/:userId/suspend */
router.post("/admin/users/:userId/suspend", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;
  const expiresAt: string | null = (req.body as any)?.expires_at ?? null;
  const now = new Date().toISOString();

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "temporary_suspension", reason);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error: profileErr } = await sc
    .from("profiles")
    .update({ account_status: "suspended" })
    .eq("id", userId);

  if (profileErr) { sendError(res, "db_error", profileErr.message); return; }

  await sc.from("user_account_states")
    .upsert({ user_id: userId, state: "suspended", reason, expires_at: expiresAt, set_by: adminUserId, created_at: now }, { onConflict: "user_id,state" })
    .then(undefined, () => {});

  res.json({ ok: true, suspended: true });
});

/** POST /admin/users/:userId/ban */
router.post("/admin/users/:userId/ban", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;
  const now = new Date().toISOString();

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "permanent_ban", reason);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error: profileErr } = await sc
    .from("profiles")
    .update({ account_status: "banned" })
    .eq("id", userId);

  if (profileErr) { sendError(res, "db_error", profileErr.message); return; }

  await sc.from("user_account_states")
    .upsert({ user_id: userId, state: "banned", reason, expires_at: null, set_by: adminUserId, created_at: now }, { onConflict: "user_id,state" })
    .then(undefined, () => {});

  res.json({ ok: true, banned: true });
});

/** POST /admin/users/:userId/restore — lift suspension or ban */
router.post("/admin/users/:userId/restore", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;
  const now = new Date().toISOString();

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "account_restored", reason);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error: profileErr } = await sc
    .from("profiles")
    .update({ account_status: "active" })
    .eq("id", userId);

  if (profileErr) { sendError(res, "db_error", profileErr.message); return; }

  await sc.from("user_account_states")
    .upsert({ user_id: userId, state: "active", reason, set_by: adminUserId, updated_at: now }, { onConflict: "user_id" })
    .then(undefined, () => {});

  res.json({ ok: true, restored: true });
});

/** POST /admin/users/:userId/restrict-bio — clear and lock the user's bio */
router.post("/admin/users/:userId/restrict-bio", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "bio_restricted", reason ?? "Bio removed by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const { error } = await sc.from("profiles").update({ bio: null }).eq("id", userId);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, bioRestricted: true });
});

/** POST /admin/users/:userId/restrict-messaging — prevent user from initiating messages */
router.post("/admin/users/:userId/restrict-messaging", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "messaging_restricted", reason ?? "Messaging restricted by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { error } = await sc.from("profile_privacy_settings")
    .upsert({ user_id: userId, allow_messages_from: "nobody", updated_at: now }, { onConflict: "user_id" });
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, messagingRestricted: true });
});

/** POST /admin/users/:userId/restrict-visibility — force profile to private */
router.post("/admin/users/:userId/restrict-visibility", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "visibility_restricted", reason ?? "Profile visibility restricted by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { error } = await sc.from("profile_privacy_settings")
    .upsert({ user_id: userId, profile_visibility: "private", allow_profile_discovery: false, updated_at: now }, { onConflict: "user_id" });
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, visibilityRestricted: true });
});

/** POST /admin/users/:userId/hide-posts — hide all posts from public discovery */
router.post("/admin/users/:userId/hide-posts", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "posts_hidden", reason ?? "Posts hidden by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { error } = await sc.from("profile_privacy_settings")
    .upsert({ user_id: userId, show_posts: false, updated_at: now }, { onConflict: "user_id" });
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true, postsHidden: true });
});

/** DELETE /admin/users/:userId/avatar — remove a user's avatar (admin action) */
router.delete("/admin/users/:userId/avatar", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "content_removed", reason ?? "Avatar removed by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  // Fetch existing avatar URL and delete from storage (fail-open)
  try {
    const { data: profileRow } = await sc.from("profiles").select("avatar_url").eq("id", userId).maybeSingle();
    const oldUrl: string | null = (profileRow as any)?.avatar_url ?? null;
    if (oldUrl) {
      const marker = `/object/public/${PROFILE_MEDIA_BUCKET}/`;
      const idx = oldUrl.indexOf(marker);
      if (idx !== -1) {
        const oldPath = oldUrl.slice(idx + marker.length);
        await sc.storage.from(PROFILE_MEDIA_BUCKET).remove([oldPath]);
      }
    }
  } catch { /* storage delete is best-effort */ }

  const { error } = await sc.from("profiles").update({ avatar_url: null }).eq("id", userId);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true });
});

/** DELETE /admin/users/:userId/cover — remove a user's cover photo (admin action) */
router.delete("/admin/users/:userId/cover", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const { userId } = req.params;
  const reason: string | null = (req.body as any)?.reason ?? null;

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "content_removed", reason ?? "Cover photo removed by admin");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  try {
    const { data: profileRow } = await sc.from("profiles").select("cover_photo_url").eq("id", userId).maybeSingle();
    const oldUrl: string | null = (profileRow as any)?.cover_photo_url ?? null;
    if (oldUrl) {
      const marker = `/object/public/${PROFILE_MEDIA_BUCKET}/`;
      const idx = oldUrl.indexOf(marker);
      if (idx !== -1) {
        const oldPath = oldUrl.slice(idx + marker.length);
        await sc.storage.from(PROFILE_MEDIA_BUCKET).remove([oldPath]);
      }
    }
  } catch { /* storage delete is best-effort */ }

  const { error } = await sc.from("profiles").update({ cover_photo_url: null }).eq("id", userId);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ ok: true });
});

// ── Admin report moderation routes ────────────────────────────────────────────
//
// GET  /admin/reports              — paginated list (filterable by type, status)
// POST /admin/reports/:id/resolve  — mark resolved with action + notes
// POST /admin/reports/:id/dismiss  — dismiss with notes

/** GET /admin/reports — paginated report list with optional type/status filters */
router.get("/admin/reports", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(100, Number(req.query.limit) || 50);
  const type   = (req.query.type   as string | undefined) || null;
  const status = (req.query.status as string | undefined) || "open";

  let query = sc
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason_code, reason_detail, severity, status, created_at, reviewed_at, reviewed_by, moderation_notes", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (type)   query = query.eq("target_type", type);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ reports: data ?? [], total: count ?? 0, page });
});

const resolveReportSchema = z.object({
  action: z.string().max(100),
  notes:  z.string().max(1000).optional().nullable(),
});

/** POST /admin/reports/:id/resolve */
router.post("/admin/reports/:id/resolve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;

  const parsed = resolveReportSchema.safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload"); return; }

  // Fetch report to get target_id before writing audit (fail-closed)
  const { data: reportRow, error: fetchErr } = await sc
    .from("reports")
    .select("id, target_id, status")
    .eq("id", req.params.id)
    .neq("status", "resolved")
    .maybeSingle();

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; }
  if (!reportRow) { sendError(res, "not_found", "Report not found or already resolved"); return; }

  // Audit first (fail-closed)
  const targetId: string = (reportRow as any).target_id as string;
  const auditR = await logModerationAction(sc, targetId, adminUserId, parsed.data.action, parsed.data.notes ?? null);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("reports")
    .update({ status: "resolved", reviewed_by: adminUserId, reviewed_at: now, moderation_notes: parsed.data.notes ?? null, updated_at: now })
    .eq("id", req.params.id)
    .select("id, status, reviewed_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ report: { id: (data as any).id, status: (data as any).status, reviewedAt: (data as any).reviewed_at } });
});

/** POST /admin/reports/:id/dismiss */
router.post("/admin/reports/:id/dismiss", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;
  const notes: string | null = (req.body as any)?.notes ?? null;

  // Fetch report to get target_id before writing audit (fail-closed)
  const { data: reportRow, error: fetchErr } = await sc
    .from("reports")
    .select("id, target_id, status")
    .eq("id", req.params.id)
    .eq("status", "open")
    .maybeSingle();

  if (fetchErr) { sendError(res, "db_error", fetchErr.message); return; }
  if (!reportRow) { sendError(res, "not_found", "Report not found or not in open status"); return; }

  // Audit first (fail-closed)
  const targetId: string = (reportRow as any).target_id as string;
  const auditR = await logModerationAction(sc, targetId, adminUserId, "report_dismissed", notes);
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  const now = new Date().toISOString();
  const { data, error } = await sc
    .from("reports")
    .update({ status: "dismissed", reviewed_by: adminUserId, reviewed_at: now, moderation_notes: notes, updated_at: now })
    .eq("id", req.params.id)
    .select("id, status, reviewed_at")
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ report: data });
});

// ── Admin deletion request queue ──────────────────────────────────────────────
//
// GET  /admin/deletion-requests           — pending deletion requests
// POST /admin/deletion-requests/:id/execute — anonymize + delete

/** GET /admin/deletion-requests — pending account deletion requests */
router.get("/admin/deletion-requests", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const limit = Math.min(100, Number(req.query.limit) || 50);

  const { data, error } = await sc
    .from("user_deletion_requests")
    .select("id, user_id, requested_at, scheduled_at, status")
    .eq("status", "pending")
    .order("scheduled_at", { ascending: true })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ requests: data ?? [], total: (data ?? []).length });
});

/** POST /admin/deletion-requests/:id/execute — anonymize user data and mark completed */
router.post("/admin/deletion-requests/:id/execute", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc, userId: adminUserId } = admin;

  const { data: reqRow, error: reqErr } = await sc
    .from("user_deletion_requests")
    .select("id, user_id, status")
    .eq("id", req.params.id)
    .eq("status", "pending")
    .maybeSingle();

  if (reqErr) { sendError(res, "db_error", reqErr.message); return; }
  if (!reqRow) { sendError(res, "not_found", "Deletion request not found or already executed"); return; }

  const userId = (reqRow as any).user_id as string;
  const now = new Date().toISOString();

  // Audit first (fail-closed)
  const auditR = await logModerationAction(sc, userId, adminUserId, "account_deleted", "Account deletion executed");
  if (!auditR.ok) { sendError(res, "db_error", `Audit write failed: ${auditR.error}`); return; }

  // Delete existing profile media from Storage before nulling the DB fields
  try {
    const { data: profileRow } = await sc
      .from("profiles")
      .select("avatar_url, cover_photo_url")
      .eq("id", userId)
      .maybeSingle();
    const avatarUrl: string | null = (profileRow as any)?.avatar_url ?? null;
    const coverUrl:  string | null = (profileRow as any)?.cover_photo_url ?? null;
    const pathsToDelete: string[] = [];
    for (const url of [avatarUrl, coverUrl]) {
      if (!url) continue;
      const marker = `/object/public/${PROFILE_MEDIA_BUCKET}/`;
      const idx = url.indexOf(marker);
      if (idx !== -1) pathsToDelete.push(url.slice(idx + marker.length));
    }
    if (pathsToDelete.length > 0) {
      await sc.storage.from(PROFILE_MEDIA_BUCKET).remove(pathsToDelete);
    }
  } catch { /* fail-open: storage deletion is best-effort during account deletion */ }

  // Anonymise profile: null out PII fields, set status to deleted
  const { error: profileErr } = await sc.from("profiles").update({
    handle:          null,
    username:        null,
    display_name:    "Deleted User",
    name:            "Deleted User",
    bio:             null,
    avatar_url:      null,
    cover_photo_url: null,
    home_city:       null,
    home_country:    null,
    current_city:    null,
    account_status:  "deleted",
  }).eq("id", userId);

  if (profileErr) { sendError(res, "db_error", profileErr.message); return; }

  // Mark state as deleted
  await sc.from("user_account_states")
    .upsert({ user_id: userId, state: "deleted", reason: "Account deletion executed", set_by: adminUserId, created_at: now }, { onConflict: "user_id,state" })
    .then(undefined, () => {});

  // Mark deletion request completed
  const { error: updateErr } = await sc
    .from("user_deletion_requests")
    .update({ status: "completed", executed_at: now, executed_by: adminUserId })
    .eq("id", req.params.id);

  if (updateErr) { sendError(res, "db_error", updateErr.message); return; }

  res.json({ ok: true, userId, executedAt: now });
});

// ── Dev interaction tester ────────────────────────────────────────────────────
//
// GET /admin/dev/interaction-test
//   ?viewerUserId=<uuid>&targetUserId=<uuid>&sourceType=<string>&sourceId=<uuid>
//
// Returns the full permission context for a viewer → target pair.
// Admin-gated. Intended for QA and integration debugging only.

router.get("/admin/dev/interaction-test", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const viewerUserId  = (req.query.viewerUserId  as string | undefined) ?? "";
  const targetUserId  = (req.query.targetUserId  as string | undefined) ?? "";
  const sourceType    = (req.query.sourceType    as string | undefined) ?? null;
  const sourceId      = (req.query.sourceId      as string | undefined) ?? null;

  const { isUuid } = await import("../lib/followDecisions.js");
  if (!isUuid(viewerUserId)) { sendError(res, "invalid_payload", "viewerUserId must be a valid UUID"); return; }
  if (!isUuid(targetUserId)) { sendError(res, "invalid_payload", "targetUserId must be a valid UUID"); return; }

  const { resolveInteractionPermissions } = await import("../services/interactionPermissions.js");

  try {
    const permissions = await resolveInteractionPermissions(sc, viewerUserId, targetUserId, {
      sourceType,
      sourceId,
    });
    res.json(permissions);
  } catch (err) {
    req.log.error({ err }, "admin/dev/interaction-test: resolver failed");
    sendError(res, "db_error", "Failed to resolve interaction permissions");
  }
});


// ===========================================================================
// Admin trip routes
// ===========================================================================

/**
 * GET /admin/trips
 *
 * Returns trips that have been reported (target_type = 'trip') and are still
 * pending review, newest first.  Each row includes the trip title, owner, and
 * the count of open reports against it so the admin dashboard can triage.
 */
router.get("/admin/trips", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = admin.sc;

  const { data: reports, error } = await sc
    .from("reports")
    .select("id, target_id, reason_code, severity, status, created_at")
    .eq("target_type", "trip")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) { sendError(res, "db_error", error.message); return; }

  if (!reports || reports.length === 0) {
    res.json({ trips: [] });
    return;
  }

  // Collect unique trip IDs from the report rows.
  const tripIds = [...new Set((reports as any[]).map((r: any) => r.target_id as string))];

  const { data: trips } = await sc
    .from("trips")
    .select("id, title, owner_id, visibility, status, created_at")
    .in("id", tripIds);

  const tripMap: Record<string, any> = {};
  (trips ?? []).forEach((t: any) => { tripMap[t.id] = t; });

  const result = tripIds
    .filter((id) => !!tripMap[id])
    .map((id) => {
      const tripReports = (reports as any[]).filter((r: any) => r.target_id === id);
      return {
        trip: tripMap[id],
        pendingReports: tripReports.length,
        highestSeverity: tripReports.reduce((max: string, r: any) => {
          const order: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
          return (order[r.severity] ?? 0) > (order[max] ?? 0) ? r.severity : max;
        }, "low"),
        reports: tripReports,
      };
    });

  res.json({ trips: result });
});

/**
 * POST /admin/trips/:tripId/hide
 *
 * Forces a trip's visibility to 'private' so it no longer appears in public
 * discovery, Passport, or search results.  A moderation_action row is written
 * for the audit trail.
 */
router.post("/admin/trips/:tripId/hide", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = admin.sc;

  const { tripId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tripId)) {
    sendError(res, "invalid_payload", "tripId must be a valid UUID"); return;
  }

  const { data: trip } = await sc.from("trips").select("id, owner_id, visibility").eq("id", tripId).maybeSingle();
  if (!trip) { sendError(res, "not_found", "Trip not found"); return; }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 500) : "Admin hide";

  await sc.from("trips").update({ visibility: "private", updated_at: new Date().toISOString() }).eq("id", tripId);

  await sc.from("moderation_actions").insert({
    target_user_id: (trip as any).owner_id,
    action_type:    "trip_hidden",
    reason,
    performed_by:  admin.userId,
  });

  res.json({ tripId, visibility: "private", hidden: true });
});

/**
 * POST /admin/trips/:tripId/report-resolve
 *
 * Resolves all pending reports against a trip (accepted / rejected by admin).
 * Body: { resolution: 'accepted' | 'rejected', reason?: string }
 */
router.post("/admin/trips/:tripId/report-resolve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = admin.sc;

  const { tripId } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tripId)) {
    sendError(res, "invalid_payload", "tripId must be a valid UUID"); return;
  }

  const resolution = req.body?.resolution;
  if (resolution !== "accepted" && resolution !== "rejected") {
    sendError(res, "invalid_payload", "resolution must be 'accepted' or 'rejected'");
    return;
  }

  const { data: updated, error } = await sc
    .from("reports")
    .update({ status: resolution === "accepted" ? "resolved" : "dismissed",
              updated_at: new Date().toISOString() })
    .eq("target_type", "trip")
    .eq("target_id", tripId)
    .eq("status", "pending")
    .select("id");

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({ tripId, resolution, resolvedCount: (updated ?? []).length });
});

export default router;
