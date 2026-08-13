/**
 * Admin Media Review routes
 *
 * Mounted at /api (full paths: /api/admin/media/...)
 * All routes require profiles.role = 'admin'.
 *
 * GET  /api/admin/media/processing-failures  — items stuck in non-ready states
 * GET  /api/admin/media/reported             — items with unreviewed reports
 * GET  /api/admin/media/wrong-place          — wrong-place reports for Gems
 * GET  /api/admin/media/gems-pending         — Gems submissions awaiting review
 * GET  /api/admin/media/ai-provenance        — items labelled illustrative/AI-generated
 * POST /api/admin/media/:id/moderate         — approve | reject | flag | delete
 *
 * `reject` HIDES (status flip, reversible, leaves Storage untouched).
 * `delete` DESTROYS (removes the Storage object and its thumbnail, then the
 * row) and is available for target='post_media' only. They are separate verbs
 * on purpose — see the note above moderateSchema.
 *
 * Schema notes (live DB):
 *   reports: target_type, target_id, reason_code, reason_detail, moderation_notes,
 *            reviewed_by, reviewed_at — status: open|reviewed|resolved|dismissed
 *   hidden_gems: status enum = pending|active|hidden|merged
 *                (no reviewed_by/reviewed_at/review_notes columns)
 *   posts: post_status column (not moderation_status); pending_safety_review for flagging
 *   post_media: processing_status, moderation_status (on post_media, not posts)
 */

import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { resolveStoragePath } from "../lib/storagePath.js";
import { resolveContentOwner } from "../lib/contentOwner.js";

const router = Router();

// ── Image dimension parsers ───────────────────────────────────────────────────
// Each parser takes a Buffer containing the first 64 KB of the file and returns
// { width, height } on success or null when the format is not recognised or the
// header is incomplete.  Only the image-specific formats are handled here;
// video objects (mp4, mov, …) return null from all parsers and are handled by
// writing file_size_bytes only.

/** JPEG — walk SOF (Start-Of-Frame) markers (FFC0–FFCB, excl. FFC4/FFC8). */
function parseJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 10) return null;
  if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // must start with SOI

  let i = 2;
  while (i < buf.length - 8) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const type = buf[i + 1]!;
    const isSOF =
      (type >= 0xC0 && type <= 0xC3) ||
      (type >= 0xC5 && type <= 0xC7) ||
      (type >= 0xC9 && type <= 0xCB);
    if (isSOF) {
      // Layout: [FF][type(1)] [length(2)] [precision(1)] [height(2)] [width(2)]
      const height = ((buf[i + 5]! << 8) | buf[i + 6]!) >>> 0;
      const width  = ((buf[i + 7]! << 8) | buf[i + 8]!) >>> 0;
      if (width > 0 && height > 0) return { width, height };
    }
    if (i + 3 >= buf.length) break;
    const segLen = ((buf[i + 2]! << 8) | buf[i + 3]!) >>> 0;
    if (segLen < 2) break;
    i += 2 + segLen;
  }
  return null;
}

/**
 * PNG — fixed IHDR chunk at offset 8.
 * Signature (8 bytes): 89 50 4E 47 0D 0A 1A 0A
 * IHDR layout: [length(4)] ["IHDR"(4)] [width(4)] [height(4)]
 */
function parsePngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (
    buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47 ||
    buf[4] !== 0x0D || buf[5] !== 0x0A || buf[6] !== 0x1A || buf[7] !== 0x0A
  ) return null;
  const width  = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * WebP — three sub-formats (VP8 lossy, VP8L lossless, VP8X extended).
 * Container: RIFF[size(4)]WEBP[chunk-type(4)]…
 */
function parseWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;
  if (
    buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46 || // RIFF
    buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50   // WEBP
  ) return null;

  const variant = buf.toString("ascii", 12, 16);
  if (variant === "VP8 ") {
    // Lossy: 3-byte sync (9D 01 2A) at byte 23, then width/height as 14-bit LE
    if (buf.length < 30) return null;
    const width  = (buf.readUInt16LE(26) & 0x3FFF) + 1;
    const height = (buf.readUInt16LE(28) & 0x3FFF) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (variant === "VP8L") {
    // Lossless: signature byte 0x2F at offset 20, then 14-bit packed width/height
    if (buf.length < 25 || buf[20] !== 0x2F) return null;
    const bits   = buf.readUInt32LE(21);
    const width  = (bits & 0x3FFF) + 1;
    const height = ((bits >>> 14) & 0x3FFF) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (variant === "VP8X") {
    // Extended: width-1 (3 bytes LE) at offset 24, height-1 (3 bytes LE) at 27
    if (buf.length < 30) return null;
    const width  = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
    const height = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * Try JPEG → PNG → WebP in order.  Returns null for unrecognised formats
 * (HEIC, video, etc.) — those rows still receive file_size_bytes if available.
 */
function parseDimensions(buf: Buffer): { width: number; height: number } | null {
  return parseJpegDimensions(buf) ?? parsePngDimensions(buf) ?? parseWebpDimensions(buf) ?? null;
}

/**
 * Fetch up to maxBytes of a URL's body, even when the server ignores the Range
 * header and returns the full file.  The stream is cancelled after maxBytes to
 * avoid reading megabytes into memory.
 */
async function fetchBounded(url: string, maxBytes: number): Promise<Buffer> {
  const resp = await fetch(url, { headers: { Range: `bytes=0-${maxBytes - 1}` } });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status}`);
  }
  if (!resp.body) throw new Error("No response body");

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (value.length >= remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

// ── Pagination helper ─────────────────────────────────────────────────────────

function parsePagination(query: any): { page: number; limit: number; offset: number } {
  const page  = Math.max(1, Number(query.page  ?? 1));
  const limit = Math.min(100, Math.max(1, Number(query.limit ?? 20)));
  return { page, limit, offset: (page - 1) * limit };
}

// ── GET /admin/media/processing-failures ─────────────────────────────────────

router.get("/admin/media/processing-failures", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // Find post_media rows that are not in a terminal-success state.
  // Select list deliberately static so the column checker can resolve it.
  const { data, error, count } = await sc
    .from("post_media")
    .select(
      "id, post_id, media_type, processing_status, moderation_status, public_url, thumbnail_url, storage_path, storage_bucket, created_at, updated_at",
      { count: "exact" },
    )
    .in("processing_status", ["failed", "error", "processing", "pending", "queued"])
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  const rows: any[] = data ?? [];
  const postIds = [...new Set(rows.map((r) => r.post_id).filter(Boolean))];

  let postMap: Record<string, { author_id: string; has_video: boolean; visibility: string }> = {};
  if (postIds.length > 0) {
    const { data: posts } = await sc
      .from("posts")
      .select("id, author_id, has_video, visibility")
      .in("id", postIds);
    for (const p of posts ?? []) postMap[p.id] = p;
  }

  res.json({
    items: rows.map((r) => ({ ...r, post: postMap[r.post_id] ?? null })),
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/reported ─────────────────────────────────────────────────
// Uses the unified reports table: target_type = 'post', status = 'open'

router.get("/admin/media/reported", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason_code, reason_detail, moderation_notes, severity, status, reviewed_by, reviewed_at, created_at, updated_at", { count: "exact" })
    .eq("target_type", "post");

  if (status !== "all") query = query.eq("status", status);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  const rows: any[] = data ?? [];

  // Enrich with primary media thumbnail
  const postIds = [...new Set(rows.map((r) => r.target_id).filter(Boolean))];
  let mediaMap: Record<string, { media_type: string; public_url: string | null; thumbnail_url: string | null }> = {};
  if (postIds.length > 0) {
    const { data: media } = await sc
      .from("post_media")
      .select("post_id, media_type, public_url, thumbnail_url")
      .in("post_id", postIds)
      .eq("sort_order", 0);
    for (const m of media ?? []) {
      if (!mediaMap[m.post_id]) mediaMap[m.post_id] = m;
    }
  }

  res.json({
    items: rows.map((r) => ({ ...r, primaryMedia: mediaMap[r.target_id] ?? null })),
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/wrong-place ──────────────────────────────────────────────
// Wrong-place reports: reports against hidden_gem entities

router.get("/admin/media/wrong-place", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);
  const status = (req.query.status as string) ?? "open";

  let query = sc
    .from("reports")
    .select("id, reporter_id, target_type, target_id, reason_code, reason_detail, moderation_notes, severity, status, reviewed_by, reviewed_at, created_at, updated_at", { count: "exact" })
    .eq("target_type", "hidden_gem");

  if (status !== "all") query = query.eq("status", status);

  query = query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  const { data, error, count } = await query;
  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/gems-pending ─────────────────────────────────────────────
// Hidden gems with status = 'pending' (submitted, not yet approved/rejected)

router.get("/admin/media/gems-pending", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // hidden_gems columns: id, name, category, city, description, vibe_tags,
  // submitted_by, status, image_url, created_at, updated_at.
  // There is no place_id column — the gem itself carries name/category/city.
  const { data, error, count } = await sc
    .from("hidden_gems")
    .select("id, name, category, city, submitted_by, status, description, vibe_tags, image_url, created_at, updated_at", { count: "exact" })
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── GET /admin/media/ai-provenance ────────────────────────────────────────────
// Media items sourced from AI generation (generated_visuals, non-place entities)

router.get("/admin/media/ai-provenance", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const { page, limit, offset } = parsePagination(req.query);

  // Scope to entity_type='post' so every item is backed by a real post row and
  // the moderate action (updating posts.post_status) is guaranteed to match.
  const { data, error, count } = await sc
    .from("generated_visuals")
    .select("id, entity_type, entity_id, image_source_type, accuracy_status, source_url, generated_with_ai, disclaimer_required, created_at", { count: "exact" })
    .eq("generated_with_ai", true)
    .eq("entity_type", "post")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) { sendError(res, "db_error", error.message); return; }

  res.json({
    items: (data as any[]) ?? [],
    pagination: { page, limit, total: count ?? 0, hasMore: (count ?? 0) > offset + limit },
  });
}));

// ── POST /admin/media/backfill-dimensions ─────────────────────────────────────
/**
 * Paginated backfill: populate width, height, and/or file_size_bytes for
 * post_media rows with processing_status='ready' that are still missing one or
 * more of those fields.
 *
 * DESIGN
 * ──────
 * Supported image types (JPEG/PNG/WebP) need all three fields.
 * Video/HEIC and any other format can only be backfilled for file_size_bytes
 * (dimensions require a media decoder not available here).
 *
 * The candidate set is therefore composed of two non-overlapping groups:
 *   A) Any media type where file_size_bytes IS NULL.
 *   B) Supported image types where width IS NULL OR height IS NULL
 *      AND file_size_bytes IS NOT NULL (already handled in a previous batch).
 *
 * Group B is image-only so that video/HEIC rows — which will always have NULL
 * width/height after their file_size is written — never re-enter the set.
 *
 * BATCH CONTRACT
 * ──────────────
 * Body (optional): { limit?: 1–50, after_id?: string }
 *   limit    — rows per call, default 20, max 50.
 *   after_id — opaque cursor: the last id returned by the previous batch.
 *              Omit on the first call.
 * Response includes next_cursor (null when the backfill is complete).
 *
 * SECURITY
 * ────────
 * Only objects whose storage_path resolves to a trusted bucket/path are
 * fetched.  The public_url column is never used as a fetch target to prevent
 * SSRF.  fetchBounded() hard-caps the download at 64 KB regardless of whether
 * the server honours the Range header, so no multi-megabyte original is ever
 * buffered in this process.
 */

// Media types for which parseDimensions() can extract width/height.
const DIMENSION_SUPPORTED_TYPES = new Set([
  "image/jpeg", "image/jpg", "image/png", "image/webp",
]);

const backfillSchema = z.object({
  limit:    z.number().int().min(1).max(50).optional().default(20),
  after_id: z.string().uuid().optional(),
});

router.post("/admin/media/backfill-dimensions", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { sc } = admin;

  const parsed = backfillSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }
  const { limit, after_id: afterId } = parsed.data;

  // ── Build candidate set ────────────────────────────────────────────────────
  // Two queries, each keyset-paginated by id.  They are unioned client-side
  // because PostgREST cannot express the compound type-conditional predicate in
  // a single query without nested AND/OR that supabase-js does not support.

  type Row = {
    id: string;
    storage_path: string | null;
    storage_bucket: string | null;
    media_type: string | null;
    mime_type: string | null;
    width: number | null;
    height: number | null;
    file_size_bytes: number | null;
  };

  // mime_type holds the MIME string (image/jpeg, image/png, image/webp, …).
  // media_type is the coarse enum ('image' | 'video') — not suitable for
  // MIME-specific filtering.
  const COLS = "id, storage_path, storage_bucket, media_type, mime_type, width, height, file_size_bytes";

  // Group A: any type missing file_size_bytes.
  let qA = sc
    .from("post_media")
    .select(COLS)
    .eq("processing_status", "ready")
    .is("file_size_bytes", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (afterId) qA = qA.gt("id", afterId);

  // Group B: supported image MIME types where dimensions are missing and
  // file_size is already populated (avoids duplicates with Group A).
  // Filtered on mime_type (the full MIME string), not media_type (coarse enum).
  let qB = sc
    .from("post_media")
    .select(COLS)
    .eq("processing_status", "ready")
    .in("mime_type", [...DIMENSION_SUPPORTED_TYPES])
    .or("width.is.null,height.is.null")
    .not("file_size_bytes", "is", null)
    .order("id", { ascending: true })
    .limit(limit);
  if (afterId) qB = qB.gt("id", afterId);

  const [resA, resB] = await Promise.all([qA, qB]);
  if (resA.error) { sendError(res, "db_error", resA.error.message); return; }
  if (resB.error) { sendError(res, "db_error", resB.error.message); return; }

  // Merge + dedup by id + sort + take first `limit` rows.
  const merged = new Map<string, Row>();
  for (const r of [...(resA.data ?? []), ...(resB.data ?? [])]) {
    if (!merged.has(r.id)) merged.set(r.id, r as Row);
  }
  const candidates: Row[] = [...merged.values()]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .slice(0, limit);

  // ── Process each candidate ─────────────────────────────────────────────────

  const results: Array<{
    id: string;
    status: "ok" | "skip" | "error";
    width?: number;
    height?: number;
    file_size_bytes?: number;
    note?: string;
    error?: string;
  }> = [];

  for (const row of candidates) {
    try {
      // ── Resolve a signed URL from our own Storage ────────────────────────
      // public_url is deliberately not used — following caller-supplied URLs
      // would be an SSRF risk.  Only objects we can sign from the trusted
      // storage bucket are eligible.
      const bucket = row.storage_bucket ?? "post-media";
      const ref = resolveStoragePath(row.storage_path, bucket);

      if (ref.kind !== "path") {
        results.push({
          id:     row.id,
          status: "skip",
          error:  `storage_path unresolvable (kind='${ref.kind}') — only trusted Storage objects are backfilled`,
        });
        continue;
      }

      const { data: signed, error: signErr } = await (sc.storage as any)
        .from(bucket)
        .createSignedUrl(ref.path, 300); // 5-minute TTL, single use
      if (signErr || !(signed as any)?.signedUrl) {
        results.push({
          id:     row.id,
          status: "error",
          error:  `createSignedUrl failed: ${signErr?.message ?? "no URL returned"}`,
        });
        continue;
      }
      const signedUrl = (signed as any).signedUrl as string;

      // ── HEAD → Content-Length (file_size_bytes) ──────────────────────────
      let fileSize: number | null = null;
      try {
        const headResp = await fetch(signedUrl, { method: "HEAD" });
        if (headResp.ok || headResp.status === 206) {
          const cl = Number(headResp.headers.get("content-length") ?? "0");
          if (cl > 0) fileSize = cl;
        }
      } catch {
        // Non-fatal — carry on to dimension extraction.
      }

      // ── Bounded fetch → first 64 KB → dimensions (image types only) ──────
      // fetchBounded() hard-caps at 64 KB even when the server ignores the
      // Range header, so a 9 MB original is never fully buffered.
      let dims: { width: number; height: number } | null = null;
      // needDims is gated on mime_type (the full MIME string), not media_type
      // (the coarse 'image'|'video' enum).  DIMENSION_SUPPORTED_TYPES contains
      // MIME values, so checking media_type against it would always be false.
      const needDims =
        (row.width === null || row.height === null) &&
        DIMENSION_SUPPORTED_TYPES.has(row.mime_type ?? "");
      if (needDims) {
        try {
          const buf = await fetchBounded(signedUrl, 65536);
          dims = parseDimensions(buf);
        } catch (e: any) {
          results.push({ id: row.id, status: "error", error: `Fetch failed: ${String(e?.message ?? e)}` });
          continue;
        }
      }

      // ── Build patch: only update fields that are currently NULL ───────────
      const patch: Record<string, number> = {};
      if (row.width           === null && dims)              patch.width           = dims.width;
      if (row.height          === null && dims)              patch.height          = dims.height;
      if (row.file_size_bytes === null && fileSize !== null) patch.file_size_bytes = fileSize;

      if (Object.keys(patch).length === 0) {
        results.push({ id: row.id, status: "skip", note: "Nothing to update after fetch" });
        continue;
      }

      const { error: updateErr } = await sc
        .from("post_media")
        .update(patch)
        .eq("id", row.id);

      if (updateErr) {
        results.push({ id: row.id, status: "error", error: updateErr.message });
      } else {
        const note = needDims && !dims
          ? `Dimensions not parsed (unsupported format: ${row.mime_type ?? row.media_type ?? "unknown"})`
          : undefined;
        results.push({
          id:     row.id,
          status: "ok",
          ...(patch.width           !== undefined ? { width:           patch.width }           : {}),
          ...(patch.height          !== undefined ? { height:          patch.height }          : {}),
          ...(patch.file_size_bytes !== undefined ? { file_size_bytes: patch.file_size_bytes } : {}),
          ...(note ? { note } : {}),
        });
      }
    } catch (e: any) {
      results.push({ id: row.id, status: "error", error: String(e?.message ?? e) });
    }
  }

  // ── Cursor ────────────────────────────────────────────────────────────────
  // next_cursor is the id of the last row in this batch.  Pass it as after_id
  // in the next call.  When null, the backfill is complete.
  const lastId = candidates.length > 0
    ? candidates[candidates.length - 1]!.id
    : null;
  const isComplete = candidates.length < limit;

  res.json({
    candidates:   candidates.length,
    ok:           results.filter((r) => r.status === "ok").length,
    skipped:      results.filter((r) => r.status === "skip").length,
    failed:       results.filter((r) => r.status === "error").length,
    next_cursor:  isComplete ? null : lastId,
    results,
  });
}));

// ── POST /admin/media/:id/moderate ────────────────────────────────────────────

/**
 * `delete` is a SEPARATE action from `reject`, deliberately.
 *
 * `reject` remains what it was: a status flip to `moderation_status='rejected'`
 * that hides the media and can be undone by approving again. It does NOT touch
 * Storage. Overloading it to also destroy the object would make every
 * mis-click permanently unrecoverable, and this codebase has nothing to
 * recover with — moderation_actions records a target USER, never which object
 * was removed or where it lived (see docs/admin/moderation-coverage.md §F), so
 * a wrongly deleted file could not even be identified afterwards, let alone
 * restored.
 *
 * `delete` is the irreversible one: it removes the Storage object(s) and the
 * row. Making it a distinct verb keeps triage reversible and forces the
 * destructive path to be chosen on purpose.
 */
const moderateSchema = z.object({
  action: z.enum(["approve", "reject", "flag", "delete"]),
  target: z.enum(["post", "post_media", "hidden_gem", "report"]).optional().default("post"),
  reason: z.string().min(1).max(500).optional(),
});

router.post("/admin/media/:id/moderate", asyncHandler(async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return;
  const { userId, sc } = admin;

  const { id } = req.params;
  if (!id) { sendError(res, "invalid_payload", "id is required"); return; }

  const parsed = moderateSchema.safeParse(req.body);
  if (!parsed.success) {
    sendError(res, "invalid_payload", parsed.error.errors[0]?.message ?? "Invalid body");
    return;
  }
  const { action, target, reason } = parsed.data;
  const now = new Date().toISOString();

  // Each branch selects the updated row (count) to detect zero-match (false positive).
  if (target === "post") {
    const newStatus =
      action === "approve" ? "published" :
      action === "reject"  ? "removed" :
      "pending_safety_review";

    const { data: updated, error } = await sc
      .from("posts")
      .update({ post_status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Post not found" });
      return;
    }

  } else if (target === "post_media" && action === "delete") {
    // The only path in this file that actually removes bytes. Everything else
    // is a status flip; this route previously had no Storage call at all,
    // despite already selecting storage_path/storage_bucket for its listings.
    const { data: row, error: readErr } = await sc
      .from("post_media")
      .select("id, user_id, storage_path, storage_bucket, thumbnail_storage_path")
      .eq("id", id)
      .maybeSingle();

    if (readErr) { sendError(res, "db_error", readErr.message); return; }
    if (!row) { res.status(404).json({ error: "not_found", message: "Media item not found" }); return; }

    const bucket = (row as any).storage_bucket as string | null;
    const ref = resolveStoragePath((row as any).storage_path, bucket ?? "");
    // The thumbnail is a second object. Deleting only the original leaves it
    // behind, still fetchable — the exact orphan this change exists to stop.
    const thumbRef = resolveStoragePath((row as any).thumbnail_storage_path, bucket ?? "");

    if (!bucket || ref.kind === "unresolvable" || thumbRef.kind === "unresolvable") {
      sendError(
        res, "db_error",
        `Cannot derive a storage path for media ${id} ` +
        `(bucket=${bucket ?? "null"}, path=${String((row as any).storage_path)}). ` +
        `Refusing to delete the row, because doing so would orphan the object.`,
        { exposeDetail: true },
      );
      return;
    }

    // Audit BEFORE destroying anything, and fail closed — matching the
    // convention in admin.ts. target_user_id is the media OWNER: that column is
    // `REFERENCES profiles(id)`, so writing a media id there would violate the
    // FK and abort the whole action.
    //
    // Resolved through the shared rule rather than reading post_media.user_id
    // inline, so this and the report paths cannot drift apart. The row is
    // already loaded above, so the lookup is the only extra cost.
    const ownerId = await resolveContentOwner(sc, "post_media", id);
    if (ownerId) {
      const { error: auditErr } = await sc.from("moderation_actions").insert({
        target_user_id: ownerId,
        action_type: "content_removed",
        reason: reason ?? `post_media ${id} deleted by admin`,
        performed_by: userId,
        created_at: now,
        // metadata is the only place the specific object can be recorded;
        // moderation_actions has no content-target column.
        metadata: { target: "post_media", media_id: id, bucket, path: ref.kind === "path" ? ref.path : null },
      });
      if (auditErr) { sendError(res, "db_error", `Audit write failed: ${auditErr.message}`, { exposeDetail: true }); return; }
    }

    const paths = [ref, thumbRef]
      .filter((r): r is { kind: "path"; path: string } => r.kind === "path")
      .map((r) => r.path);

    if (paths.length > 0) {
      const { error: storageErr } = await sc.storage.from(bucket).remove(paths);
      if (storageErr) {
        // Do NOT delete the row: it is the only remaining pointer to the object.
        sendError(
          res, "db_error",
          `Storage removal failed for media ${id}: ${storageErr.message}. Row left intact.`,
          { exposeDetail: true },
        );
        return;
      }
    }

    const { error: delErr } = await sc.from("post_media").delete().eq("id", id);
    if (delErr) { sendError(res, "db_error", delErr.message); return; }

    res.json({ ok: true, id, action, target, deleted: true, objectsRemoved: paths.length });
    return;

  } else if (target === "post_media") {
    const newStatus =
      action === "approve" ? "approved" :
      action === "reject"  ? "rejected" :
      "flagged";

    const { data: updated, error } = await sc
      .from("post_media")
      .update({ moderation_status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Media item not found" });
      return;
    }

  } else if (target === "hidden_gem") {
    // hidden_gems status enum: pending | active | hidden | merged
    const newStatus =
      action === "approve" ? "active" :
      "hidden";

    const { data: updated, error } = await sc
      .from("hidden_gems")
      .update({ status: newStatus })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Hidden gem not found" });
      return;
    }

  } else if (target === "report") {
    // reports status: open | reviewed | resolved | dismissed
    const newStatus =
      action === "approve" ? "resolved" :
      action === "reject"  ? "dismissed" :
      "reviewed";

    const { data: updated, error } = await sc
      .from("reports")
      .update({
        status:           newStatus,
        reviewed_by:      userId,
        reviewed_at:      now,
        moderation_notes: reason ?? null,
      })
      .eq("id", id)
      .select("id");

    if (error) { sendError(res, "db_error", error.message); return; }
    if (!updated || (updated as any[]).length === 0) {
      res.status(404).json({ error: "not_found", message: "Report not found" });
      return;
    }
  }

  res.json({ ok: true, id, action, target });
}));

export default router;
