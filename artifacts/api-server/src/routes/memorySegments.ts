/**
 * §20 "Video scenes as logical segments without duplicating originals" —
 * census-highlights-memories H184; migration 3809 (written, unapplied); B58
 * cluster MEM-SEGMENTS. The rule lives in services/memory/memorySegments.ts.
 *
 *   GET    /memories/:id/segments                        every segment the viewer may see
 *   POST   /memories/:id/items/:itemId/segments          { startMs, endMs, label? }  owner only
 *   DELETE /memories/:id/segments/:segmentId             owner only
 *
 * ── READ: EXACTLY THE ITEM'S AUDIENCE ───────────────────────────────────────
 * GET runs the ladder GET /memories/:id runs, in the same order: the Memory is
 * read (a deleted one is missing); for anyone but the owner, a block in either
 * direction and §23 `canReadMemory(…, "single")` each answer the SAME 404
 * not_found "Memory not found" a missing Memory answers — so the status is never
 * an existence oracle and nothing after this point is reached by someone who
 * cannot read the Memory. Then 3672's item audience: a segment on a photo the
 * owner keeps `only_me` is dropped for everyone else, exactly as the item is,
 * so the response for a hidden item is the response for an item with no
 * segments or one that does not exist. A segment adds NO read grant, and its
 * label — owner text — travels only with an item the viewer is served, i.e. to
 * the audience of that item's caption. A read that fails AFTER the viewer is
 * known to be permitted is a 503 (as the detail route does), never "no
 * segments"; 3809 not applied is `available: false` with no segments, which is
 * true (no segment can exist).
 *
 * ── WRITE: OWNER ONLY, MEASURED, NO OBJECT WRITTEN ──────────────────────────
 * Another person's Memory, a deleted one and a missing one answer one
 * byte-identical 404 (routes/memoryResurfacingControls.ts' convention). The
 * window is checked against the video's MEASURED duration
 * (media_assets.duration_ms, written by routes/posts.ts recordMeasuredDuration):
 * unknown ⇒ 422 duration_unknown, past the end ⇒ 422 segment_out_of_range, an
 * image ⇒ 422 not_a_video. A segment is two integers and a label; it references
 * the item's own `media_url`, served back as `mediaUrl` — this file never calls
 * `sc.storage`, so creating or deleting a segment writes, uploads, copies,
 * moves, transcodes and removes nothing.
 *
 * ── NO FLAG, and why ────────────────────────────────────────────────────────
 * Before 3809 is applied nothing new is reachable: GET serves no segment and
 * every write answers 404 feature_disabled. After it, what becomes reachable is
 * only what an owner explicitly marks on their own video, served to exactly the
 * people who are already served that video and its caption. No other person's
 * data, no new audience, no new storage object.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { canReadMemory, isBlocked } from "../services/memory/memoryReadPolicy.js";
import { hiddenItemKeys, itemKey } from "../services/memory/memoryItemVisibility.js";
import {
  SEGMENT_LABEL_MAX,
  SEGMENTS_PER_ITEM_MAX,
  countItemSegments,
  deleteSegment,
  insertSegment,
  isVideoMediaType,
  measuredDurationFor,
  readSegmentsForMemory,
  windowWithin,
} from "../services/memory/memorySegments.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOT_DEPLOYED = "Marking parts of a video is not available yet.";
const MS_MAX = 2_147_483_647; // 3809's integer columns

const postBody = z
  .object({
    startMs: z.number().int().min(0).max(MS_MAX),
    endMs: z.number().int().min(1).max(MS_MAX),
    label: z.union([z.string(), z.null()]).optional(),
  })
  .strict();

/** A 422 in the API's flat envelope. */
function unprocessable(res: Response, error: "duration_unknown" | "segment_out_of_range" | "not_a_video", message: string): void {
  res.status(422).json({ error, message });
}

/** The caller's own, live Memory — or the refusal already sent. */
async function ownMemory(req: Request, res: Response, sc: any, ownerId: string): Promise<{ id: string } | null> {
  const id = String(req.params.id ?? "");
  const { data, error } = await sc.from("memories").select("id, owner_id, state").eq("id", id).maybeSingle();
  if (error) {
    req.log.error({ err: error, memoryId: id }, "memory segments: memory read failed");
    sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again.");
    return null;
  }
  const row = data as { id: string; owner_id: string; state: string | null } | null;
  if (!row || row.owner_id !== ownerId || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return null; }
  return { id: row.id };
}

router.get("/memories/:id/segments", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const viewerId = auth.user.id;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memoryRow, error: memoryErr } = await sc
    .from("memories")
    .select("id, owner_id, visibility, allowed_user_ids, hidden_user_ids, trip_id, state")
    .eq("id", id)
    .neq("state", "deleted")
    .maybeSingle();
  if (memoryErr) {
    req.log.error({ err: memoryErr, memoryId: id }, "memory segments: memory read failed");
    sendError(res, "degraded_unavailable", "Could not load this Memory. Please try again.");
    return;
  }
  if (!memoryRow) { sendError(res, "not_found", "Memory not found"); return; }
  const memory = memoryRow as any;
  const isOwner = memory.owner_id === viewerId;
  if (!isOwner) {
    if (await isBlocked(sc, viewerId, memory.owner_id)) { sendError(res, "not_found", "Memory not found"); return; }
    if (!(await canReadMemory(sc, memory, viewerId, "single"))) { sendError(res, "not_found", "Memory not found"); return; }
  }

  // The viewer may read the Memory. From here a failed read is a 503, never "no segments".
  const items = await sc.from("memory_items").select("id, media_url, media_type, position").eq("memory_id", id);
  if (items.error || !Array.isArray(items.data)) {
    req.log.error({ err: items.error, memoryId: id }, "memory segments: memory_items read failed — refusing rather than serving segments without their items");
    sendError(res, "degraded_unavailable", "Could not load this Memory. Please try again.");
    return;
  }
  const hidden = isOwner ? { ok: true as const, keys: new Set<string>() } : await hiddenItemKeys(sc, [id]);
  if (!hidden.ok) {
    req.log.error({ memoryId: id, detail: hidden.detail }, "memory segments: memory_items visibility read failed — refusing rather than serving segments of photos whose audience could not be checked");
    sendError(res, "degraded_unavailable", "Could not load this Memory. Please try again.");
    return;
  }
  // §AM (3672): a video the owner keeps only_me is not this viewer's, and neither are its segments.
  const readable = new Map<string, { mediaUrl: string; mediaType: string; position: number }>();
  for (const it of items.data as Array<{ id: string; media_url: string; media_type: string; position: number }>) {
    if (hidden.keys.has(itemKey(id, it.position))) continue;
    if (!isVideoMediaType(it.media_type)) continue;
    readable.set(String(it.id), { mediaUrl: it.media_url, mediaType: it.media_type, position: Number(it.position) });
  }

  const read = await readSegmentsForMemory(sc, id);
  if (read.state === "absent") { res.json({ memoryId: id, available: false, segments: [] }); return; }
  if (read.state === "unreadable") {
    req.log.error({ memoryId: id, detail: read.detail }, "memory segments: memory_media_segments read failed");
    sendError(res, "degraded_unavailable", "Could not load this Memory. Please try again.");
    return;
  }
  const segments = read.rows
    .filter((r) => readable.has(r.itemId))
    .map((r) => {
      const item = readable.get(r.itemId)!;
      // The item's OWN stored reference — the value GET /memories/:id serves as items[].mediaUrl. No new object.
      return { id: r.id, itemId: r.itemId, startMs: r.startMs, endMs: r.endMs, label: r.label, mediaUrl: item.mediaUrl, mediaType: item.mediaType, position: item.position };
    })
    .sort((a, b) => a.position - b.position || a.startMs - b.startMs || a.endMs - b.endMs)
    .map(({ position: _p, ...s }) => s);
  res.json({ memoryId: id, available: true, segments });
}));

router.post("/memories/:id/items/:itemId/segments", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const ownerId = auth.user.id;
  const id = String(req.params.id ?? "");
  const itemId = String(req.params.itemId ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return; }
  const parsed = postBody.safeParse(req.body ?? {});
  if (!parsed.success) { sendError(res, "invalid_payload", "startMs and endMs must be whole milliseconds, with an optional label"); return; }
  const { startMs, endMs } = parsed.data;
  if (startMs >= endMs) { sendError(res, "invalid_payload", "A part must start before it ends."); return; }
  const rawLabel = typeof parsed.data.label === "string" ? parsed.data.label.trim() : "";
  if (rawLabel.length > SEGMENT_LABEL_MAX) { sendError(res, "invalid_payload", `A label is at most ${SEGMENT_LABEL_MAX} characters.`); return; }
  const label = rawLabel.length > 0 ? rawLabel : null;

  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, ownerId);
  if (!mem) return;

  const { data: itemRow, error: itemErr } = await sc
    .from("memory_items")
    .select("id, media_url, media_type")
    .eq("id", itemId)
    .eq("memory_id", mem.id)
    .maybeSingle();
  if (itemErr) {
    req.log.error({ err: itemErr, memoryId: mem.id, itemId }, "memory segments: item read failed");
    sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again.");
    return;
  }
  if (!itemRow) { sendError(res, "not_found", "Item not found"); return; }
  const item = itemRow as { id: string; media_url: string; media_type: string };
  if (!isVideoMediaType(item.media_type)) { unprocessable(res, "not_a_video", "Only a video can be split into parts."); return; }

  const existing = await countItemSegments(sc, item.id);
  if (existing.state === "absent") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
  if (existing.state === "unreadable") {
    req.log.error({ memoryId: mem.id, itemId, detail: existing.detail }, "memory segments: segment count unreadable");
    sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
    return;
  }
  if (existing.count >= SEGMENTS_PER_ITEM_MAX) {
    sendError(res, "conflict", `A video can carry at most ${SEGMENTS_PER_ITEM_MAX} marked parts.`, { exposeDetail: true });
    return;
  }

  const measured = await measuredDurationFor(sc, ownerId, item.media_url);
  if (measured.state === "unreadable") {
    req.log.error({ memoryId: mem.id, itemId, detail: measured.detail }, "memory segments: measured duration unreadable");
    sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
    return;
  }
  if (measured.state === "not_a_video") { unprocessable(res, "not_a_video", "Only a video can be split into parts."); return; }
  if (measured.state === "unknown") {
    req.log.info({ memoryId: mem.id, itemId, why: measured.why }, "memory segments: refused, the video's length was never measured");
    unprocessable(res, "duration_unknown", "This video's length hasn't been measured, so a part of it can't be marked yet.");
    return;
  }
  const within = windowWithin(startMs, endMs, measured.durationMs);
  if (!within.ok) { unprocessable(res, within.code, within.message); return; }

  const written = await insertSegment(sc, { memoryId: mem.id, itemId: item.id, ownerId, startMs, endMs, label });
  if (!written.ok) {
    if (written.reason === "not_deployed") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
    if (written.reason === "duplicate") { sendError(res, "conflict", "That part is already marked.", { exposeDetail: true }); return; }
    req.log.error({ memoryId: mem.id, itemId, detail: written.detail }, "memory segments: insert failed");
    sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
    return;
  }
  const r = written.row;
  res.status(201).json({
    segment: { id: r.id, itemId: r.itemId, startMs: r.startMs, endMs: r.endMs, label: r.label, mediaUrl: item.media_url, mediaType: item.media_type },
  });
}));

router.delete("/memories/:id/segments/:segmentId", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  const segmentId = String(req.params.segmentId ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(segmentId)) { sendError(res, "invalid_payload", "Invalid id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  const out = await deleteSegment(sc, { memoryId: mem.id, segmentId, ownerId: auth.user.id });
  if (out.ok) { res.status(204).send(); return; }
  if (out.reason === "not_deployed") { sendError(res, "feature_disabled", NOT_DEPLOYED); return; }
  if (out.reason === "not_found") { sendError(res, "not_found", "Segment not found"); return; }
  req.log.error({ memoryId: mem.id, segmentId, detail: out.detail }, "memory segments: delete failed");
  sendError(res, "degraded_unavailable", "That could not be removed. Please try again.");
}));

export default router;
