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

export default router;
