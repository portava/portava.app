/**
 * Canonical external-place routes (media audit Phase 6).
 *
 *   GET  /api/places/canonical/:id        — normalized place + all provider refs
 *   POST /api/admin/places/ingest         — resolve provider records → places (admin)
 *   POST /api/admin/places/:id/merge      — merge :id into { intoId } (admin)
 *   POST /api/admin/places/:id/unmerge    — reverse a merge (admin)
 *
 * Flag-gated by `external_places_enabled` (OFF = dormant; reads 404, ingest
 * no-ops via the resolver). Merge model is LOSSLESS: a merged place keeps its
 * own references and just points `merged_into_place_id` at the survivor; the
 * canonical read aggregates across the group, so unmerge is a one-field revert.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { resolveExternalPlace, toCanonicalPlace, type ExternalPlaceRecord } from "../lib/places/placeResolve.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAdmin(req: any, res: any): Promise<{ userId: string; sc: any } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return null; }
  const { data } = await sc.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (!data || (data as any).role !== "admin") {
    res.status(403).json({ error: "forbidden", message: "Admin role required" });
    return null;
  }
  return { userId: auth.user.id, sc };
}

/** Load a place + every reference in its merge group (self + merged-in rows). */
async function loadGroup(sc: any, survivorId: string): Promise<{ place: any; refs: any[] } | null> {
  const { data: place } = await sc.from("places").select("*").eq("id", survivorId).maybeSingle();
  if (!place) return null;
  const { data: merged } = await sc.from("places").select("id").eq("merged_into_place_id", survivorId);
  const ids = [survivorId, ...((merged as any[]) ?? []).map((m) => m.id)];
  const { data: refs } = await sc.from("external_place_references").select("*").in("place_id", ids);
  return { place, refs: (refs as any[]) ?? [] };
}

// ── GET /api/places/canonical/:id ─────────────────────────────────────────────
router.get("/places/canonical/:id", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }
  if (!(await isFlagEnabled(sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  const { data: place } = await sc.from("places").select("*").eq("id", id).maybeSingle();
  if (!place) { sendError(res, "not_found", "Place not found"); return; }
  // Follow a merge to the survivor so a stale id still resolves.
  const survivorId = (place as any).merged_into_place_id ?? id;
  const group = await loadGroup(sc, survivorId);
  if (!group) { sendError(res, "not_found", "Place not found"); return; }
  res.json({ place: toCanonicalPlace(group.place, group.refs) });
}));

// ── POST /api/admin/places/ingest ─────────────────────────────────────────────
const recordSchema = z.object({
  provider: z.string().min(1).max(40),
  providerPlaceId: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  primaryCategory: z.string().max(80).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  city: z.string().max(200).nullable().optional(),
  neighborhood: z.string().max(200).nullable().optional(),
  countryCode: z.string().max(4).nullable().optional(),
  providerUrl: z.string().url().max(1000).nullable().optional(),
  attribution: z.string().max(200).nullable().optional(),
  rawCategory: z.string().max(120).nullable().optional(),
  canonicalLocationId: z.string().uuid().nullable().optional(),
});

router.post("/admin/places/ingest", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const parsed = z.object({ records: z.array(recordSchema).min(1).max(500) }).safeParse(req.body);
  if (!parsed.success) { sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid records"); return; }

  if (!(await isFlagEnabled(admin.sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  let created = 0, linked = 0, skipped = 0;
  const placeIds: string[] = [];
  for (const rec of parsed.data.records) {
    const r = await resolveExternalPlace(admin.sc, rec as ExternalPlaceRecord);
    if (!r) { skipped++; continue; }
    placeIds.push(r.placeId);
    if (r.created) created++; else linked++;
  }
  res.json({ ok: true, created, linked, skipped, placeIds });
}));

// ── POST /api/admin/places/:id/merge ──────────────────────────────────────────
router.post("/admin/places/:id/merge", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { id } = req.params;
  const parsed = z.object({ intoId: z.string().uuid() }).safeParse(req.body);
  if (!UUID_RE.test(id) || !parsed.success) { sendError(res, "invalid_payload", "Invalid ids"); return; }
  const intoId = parsed.data.intoId;
  if (id === intoId) { sendError(res, "invalid_payload", "Cannot merge a place into itself"); return; }

  const [{ data: loser }, { data: survivor }] = await Promise.all([
    admin.sc.from("places").select("id, merged_into_place_id").eq("id", id).maybeSingle(),
    admin.sc.from("places").select("id, merged_into_place_id").eq("id", intoId).maybeSingle(),
  ]);
  if (!loser || !survivor) { sendError(res, "not_found", "Place not found"); return; }
  if ((survivor as any).merged_into_place_id) { sendError(res, "invalid_payload", "Target is itself merged; merge into the survivor"); return; }

  const { count } = await admin.sc.from("external_place_references")
    .select("id", { count: "exact", head: true }).eq("place_id", id);
  const { error } = await admin.sc.from("places")
    .update({ merged_into_place_id: intoId, status: "duplicate", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) { sendError(res, "db_error", error.message); return; }

  await admin.sc.from("place_merge_log").insert({
    action: "merge", survivor_place_id: intoId, affected_place_id: id,
    admin_id: admin.userId, ref_count: count ?? 0,
  });
  res.json({ ok: true, survivorId: intoId, mergedId: id });
}));

// ── POST /api/admin/places/:id/unmerge ────────────────────────────────────────
router.post("/admin/places/:id/unmerge", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  const { data: place } = await admin.sc.from("places").select("id, merged_into_place_id").eq("id", id).maybeSingle();
  if (!place) { sendError(res, "not_found", "Place not found"); return; }
  if (!(place as any).merged_into_place_id) { sendError(res, "invalid_payload", "Place is not merged"); return; }
  const survivorId = (place as any).merged_into_place_id;

  const { error } = await admin.sc.from("places")
    .update({ merged_into_place_id: null, status: "active", updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) { sendError(res, "db_error", error.message); return; }

  await admin.sc.from("place_merge_log").insert({
    action: "unmerge", survivor_place_id: survivorId, affected_place_id: id, admin_id: admin.userId, ref_count: 0,
  });
  res.json({ ok: true, restoredId: id });
}));

export default router;
