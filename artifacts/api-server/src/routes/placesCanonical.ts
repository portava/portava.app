/**
 * Canonical external-place routes (media audit Phase 6).
 *
 *   GET  /api/places/canonical/:id        — normalized place + all provider refs
 *   POST /api/admin/places/ingest         — resolve provider records → places (admin)
 *   POST /api/admin/places/:id/merge      — merge :id into { intoId } (admin)
 *   POST /api/admin/places/:id/unmerge    — reverse a merge (admin)
 *
 * Flag-gated by `external_places_enabled` (OFF = dormant: reads 404; ingest, merge and unmerge answer
 * feature_disabled). A merged place keeps its own references and points `merged_into_place_id` at the survivor;
 * the canonical read aggregates the group. Every merge/unmerge is recorded in place_merge_log BEFORE it is applied,
 * never applied unrecorded, and unmerge reverses only a merge the log records (lib/places/placeMerge.ts).
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { resolveExternalPlace, toCanonicalPlace, type ExternalPlaceRecord } from "../lib/places/placeResolve.js";
import { requireAdmin } from "../lib/requireAdmin.js"; import { mergePlace, unmergePlace, sendPlaceMergeRefusal } from "../lib/places/placeMerge.js"; // same line on purpose: this file is cited by line

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // Dormant like ingest and the canonical read (header :9): OFF, absent or
  // unreadable refuses before anything is read or written.
  if (!(await isFlagEnabled(admin.sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  // MAIN wrote the place here and then the place_merge_log row, never reading
  // the log insert's result: a failed log write answered 200 over a merge with
  // no record. mergePlace (lib/places/placeMerge.ts) checks every precondition
  // read (a failed read is 503, not "not found"; an already-merged place, or one
  // other places are merged into, is 409), WRITES THE LOG ROW FIRST, moves the
  // place only from the state it read (a concurrent change is 409, not an
  // overwrite), and withdraws the row only in the two cases its header names.
  // An outcome it cannot establish keeps the row. Every failure is an error
  // answer.
  // place_merge_log is written by this call (3504's ledger cites this line):
  const out = await mergePlace(admin.sc, { placeId: id, intoId, adminId: admin.userId }, req.log);
  if (!out.ok) { sendPlaceMergeRefusal(res, out); return; }

  // Same success body as main.
  res.json({ ok: true, survivorId: intoId, mergedId: id });
}));

// ── POST /api/admin/places/:id/unmerge ────────────────────────────────────────
router.post("/admin/places/:id/unmerge", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid id"); return; }

  // Dormant like the merge (header :9).
  if (!(await isFlagEnabled(admin.sc, "external_places_enabled"))) { sendError(res, "feature_disabled"); return; }

  // MAIN reverted merged_into_place_id here without reading place_merge_log,
  // then wrote its unmerge row without reading the result. unmergePlace reverses
  // only a merge the log RECORDS as current (the newest row for this place must
  // be a 'merge' naming its survivor, else 409 and nothing changes) and records
  // the unmerge before applying it, exactly as the merge does.
  const out = await unmergePlace(admin.sc, { placeId: id, adminId: admin.userId }, req.log);
  if (!out.ok) { sendPlaceMergeRefusal(res, out); return; }

  // Same success body as main. Status returns to 'active' as on main: the status
  // before the merge is not recorded (lib/places/placeMerge.ts header).
  res.json({ ok: true, restoredId: id });
}));

// ── GET /api/places/:id/thin-buckets ─────────────────────────────────────────
/**
 * Returns coverage buckets for a place that have fewer than 5 posts, sorted by
 * scarcity (lowest post_count first).  Used by the Living Page UI to show
 * "Be the first" content prompts.
 *
 * Cached 30 min per place (in-process, LRU-style Map).
 */

const THIN_BUCKET_THRESHOLD = 5;
const THIN_BUCKET_CACHE_TTL_MS = 30 * 60 * 1_000; // 30 min
const thinBucketCache = new Map<string, { data: any; expiresAt: number }>();

router.get("/places/:id/thin-buckets", asyncHandler(async (req, res) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured"); return; }

  const { id } = req.params;
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid place id"); return; }

  // In-process cache
  const cached = thinBucketCache.get(id);
  if (cached && cached.expiresAt > Date.now()) {
    res.json(cached.data);
    return;
  }

  const { data, error } = await sc
    .from("place_coverage_buckets")
    .select("bucket, post_count")
    .eq("canonical_place_id", id)
    .lt("post_count", THIN_BUCKET_THRESHOLD)
    .order("post_count", { ascending: true });

  if (error) { sendError(res, "db_error", error.message); return; }

  const buckets = ((data as any[]) ?? []).map((row) => ({
    bucket:     row.bucket as string,
    post_count: row.post_count as number,
  }));

  const response = { buckets };
  thinBucketCache.set(id, { data: response, expiresAt: Date.now() + THIN_BUCKET_CACHE_TTL_MS });

  res.json(response);
}));

export default router;
