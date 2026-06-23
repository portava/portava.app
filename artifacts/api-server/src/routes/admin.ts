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
});

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

// ── Safe Return admin routes ──────────────────────────────────────────────────
// All gated by safe_return_admin_logs_enabled feature flag + requireAdmin.

async function isSafeReturnAdminEnabled(sc: any): Promise<boolean> {
  try {
    const { data } = await sc
      .from("feature_flags")
      .select("enabled")
      .eq("key", "safe_return_admin_logs_enabled")
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
    .select("key, enabled, description, updated_at")
    .in("key", flags);

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
        .eq("key", key);
      if (!error) results[key] = enabled;
    }),
  );

  res.json({ ok: true, updated: results });
});

export default router;

