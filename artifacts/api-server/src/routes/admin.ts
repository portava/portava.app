/**
 * Admin geo controls
 *
 * Role-gated routes (admin role required via X-Admin-Key header or profiles.role='admin').
 *
 * Routes:
 *   GET  /admin/geo-zones          — list geo zones
 *   POST /admin/geo-zones          — create / update a geo zone
 *   GET  /admin/geo-zones/:id      — get single geo zone
 *   PATCH /admin/geo-zones/:id     — update geo zone fields
 *   DELETE /admin/geo-zones/:id    — soft-delete geo zone
 *
 *   GET  /admin/suspicious-gps     — suspicious GPS trust-event review queue
 *   POST /admin/suspicious-gps/:id/resolve — mark trust event reviewed
 *
 *   GET  /admin/venues/pending     — pending venue moderation queue
 *   POST /admin/venues/:id/moderate — approve / reject a venue
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http";
import { getServiceClient } from "../lib/supabase";

const router = Router();

// ── Admin guard middleware ────────────────────────────────────────────────────

async function requireAdmin(req: any, res: any): Promise<{ userId: string } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const { client, user } = auth;

  // Check profile role
  const { data, error } = await client
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (error || !data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  return { userId: user.id };
}

// ── Geo zones ─────────────────────────────────────────────────────────────────

const createGeoZoneSchema = z.object({
  name:          z.string().min(1).max(200),
  zoneType:      z.enum(["city", "neighborhood", "venue", "geofence", "safe_zone", "exclusion_zone"]),
  centerLat:     z.number().min(-90).max(90).optional(),
  centerLng:     z.number().min(-180).max(180).optional(),
  radiusMeters:  z.number().int().min(1).max(100000).optional(),
  city:          z.string().max(120).optional(),
  countryCode:   z.string().max(4).optional(),
  isSystem:      z.boolean().optional().default(false),
  metadata:      z.record(z.unknown()).optional(),
});

/** GET /admin/geo-zones */
router.get("/admin/geo-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
  const city = (req.query.city as string | undefined)?.trim() || null;

  let query = sc
    .from("geo_zones")
    .select("id, name, zone_type, center_lat, center_lng, radius_meters, city, country_code, is_system, created_by, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (city) query = query.ilike("city", `%${city}%`);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ zones: data ?? [], total: count ?? 0, page });
});

/** POST /admin/geo-zones */
router.post("/admin/geo-zones", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const parsed = createGeoZoneSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;

  const { data, error } = await sc
    .from("geo_zones")
    .insert({
      name:           d.name,
      zone_type:      d.zoneType,
      center_lat:     d.centerLat ?? null,
      center_lng:     d.centerLng ?? null,
      radius_meters:  d.radiusMeters ?? null,
      city:           d.city ?? null,
      country_code:   d.countryCode ?? null,
      is_system:      d.isSystem ?? false,
      created_by:     admin.userId,
      metadata:       d.metadata ?? null,
    })
    .select()
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(201).json({ zone: data });
});

/** GET /admin/geo-zones/:id */
router.get("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const { data, error } = await sc
    .from("geo_zones")
    .select()
    .eq("id", req.params.id)
    .maybeSingle();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Geo zone not found"); return; }
  res.json({ zone: data });
});

/** PATCH /admin/geo-zones/:id */
router.patch("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const patchSchema = createGeoZoneSchema.partial();
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }
  const d = parsed.data;
  const patch: Record<string, unknown> = {};
  if (d.name          !== undefined) patch.name          = d.name;
  if (d.zoneType      !== undefined) patch.zone_type     = d.zoneType;
  if (d.centerLat     !== undefined) patch.center_lat    = d.centerLat;
  if (d.centerLng     !== undefined) patch.center_lng    = d.centerLng;
  if (d.radiusMeters  !== undefined) patch.radius_meters = d.radiusMeters;
  if (d.city          !== undefined) patch.city          = d.city;
  if (d.countryCode   !== undefined) patch.country_code  = d.countryCode;
  if (d.isSystem      !== undefined) patch.is_system     = d.isSystem;
  if (d.metadata      !== undefined) patch.metadata      = d.metadata;

  if (Object.keys(patch).length === 0) {
    sendError(res, "invalid_payload", "No fields to update");
    return;
  }

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

/** DELETE /admin/geo-zones/:id */
router.delete("/admin/geo-zones/:id", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const { error } = await sc.from("geo_zones").delete().eq("id", req.params.id);
  if (error) { sendError(res, "db_error", error.message); return; }
  res.status(204).end();
});

// ── Suspicious GPS review queue ────────────────────────────────────────────────

/** GET /admin/suspicious-gps  — trust events pending review */
router.get("/admin/suspicious-gps", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);
  const status = (req.query.status as string) || "pending_review";

  const { data, error } = await sc
    .from("location_trust_events")
    .select("id, user_id, event_type, trust_level, metadata, created_at, resolved_at, resolved_by")
    .eq("trust_level", status)
    .is("resolved_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ events: data ?? [], total: (data ?? []).length });
});

/** POST /admin/suspicious-gps/:id/resolve — mark resolved */
router.post("/admin/suspicious-gps/:id/resolve", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const resolutionSchema = z.object({
    resolution: z.enum(["cleared", "flagged", "banned"]),
    note: z.string().max(500).optional(),
  });
  const parsed = resolutionSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const { data, error } = await sc
    .from("location_trust_events")
    .update({
      resolved_at:  new Date().toISOString(),
      resolved_by:  admin.userId,
      trust_level:  parsed.data.resolution === "cleared" ? "gps_verified" : "suspicious",
      metadata:     { resolution: parsed.data.resolution, note: parsed.data.note ?? null },
    })
    .eq("id", req.params.id)
    .select("id, trust_level, resolved_at")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Trust event not found"); return; }
  res.json({ event: data });
});

// ── Venue moderation queue ─────────────────────────────────────────────────────

/** GET /admin/venues/pending */
router.get("/admin/venues/pending", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const limit = Math.min(100, parseInt(req.query.limit as string) || 50);

  const { data, error } = await sc
    .from("place_profiles")
    .select("id, name, place_type, city, country_code, osm_id, submitted_by, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) { sendError(res, "db_error", error.message); return; }
  res.json({ venues: data ?? [], total: (data ?? []).length });
});

/** POST /admin/venues/:id/moderate */
router.post("/admin/venues/:id/moderate", async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client unavailable"); return; }

  const schema = z.object({
    action: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid payload");
    return;
  }

  const newStatus = parsed.data.action === "approve" ? "verified" : "rejected";
  const { data, error } = await sc
    .from("place_profiles")
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("id, name, status")
    .single();

  if (error) { sendError(res, "db_error", error.message); return; }
  if (!data) { sendError(res, "not_found", "Venue not found"); return; }
  res.json({ venue: data });
});

export default router;
