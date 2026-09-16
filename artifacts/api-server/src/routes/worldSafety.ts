import { Router } from "express";
import { requireAdmin } from "../lib/requireAdmin.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.post("/admin/world-safety/:placeId", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const placeId = String(req.params.placeId ?? "");
  const { constrained, validUntil, source, zoneId } = req.body ?? {};
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiry = Date.parse(String(validUntil ?? ""));
  if (!UUID.test(placeId) || typeof constrained !== "boolean" || !Number.isFinite(expiry) || expiry <= nowMs) {
    res.status(400).json({ error: "placeId, explicit constrained boolean, and future validUntil are required" });
    return;
  }
  const sc = getServiceClient();
  if (!sc) { res.status(503).json({ error: "service unavailable" }); return; }
  const { data: place, error: placeError } = await sc.from("places")
    .select("id, status, merged_into_place_id").eq("id", placeId).maybeSingle();
  if (placeError || !place || place.status !== "active" || place.merged_into_place_id) {
    res.status(404).json({ error: "active, canonical, non-merged place not found" }); return;
  }
  const provenance = { source: typeof source === "string" && source.trim() ? source.trim() : "admin_advisory", authority: "admin", actorId: admin.userId };
  const { data, error } = await sc.from("world_safety_constraints").upsert({
    place_id: placeId, zone_id: typeof zoneId === "string" && zoneId.trim() ? zoneId.trim() : null,
    zone_key: typeof zoneId === "string" && zoneId.trim() ? zoneId.trim() : "",
    constrained, valid_until: new Date(expiry).toISOString(),
     provenance, created_by: admin.userId, updated_by: admin.userId, updated_at: nowIso,
  }, { onConflict: "place_id,zone_key" }).select("*").single();
  if (error) { res.status(500).json({ error: "safety constraint write failed" }); return; }
  res.status(200).json({ constraint: data });
}));

export default router;