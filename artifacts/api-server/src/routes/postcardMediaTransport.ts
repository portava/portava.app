/**
 * Postcard media transport — the poster and the resumable byte path for a
 * reserved `post_media` slot (Media spec §37). The policy lives in
 * lib/postcardMediaTransport.ts; this file is transport only.
 *
 *   POST   /api/postcards/:id/media/:mediaId/poster                  raw image body → stored as <storage_path>.poster.jpg
 *   POST   /api/postcards/:id/media/:mediaId/upload-session          what is already stored + signed URLs for what is not
 *   POST   /api/postcards/:id/media/:mediaId/upload-session/assemble concatenate the parts into the slot's object
 *   DELETE /api/postcards/:id/media/:mediaId/upload-session          abandon: remove the parts
 *
 * The slot is the one `POST /postcards/:id/media/upload-url` reserved, and
 * `/complete` (routes/postcards.ts) is unchanged in what it verifies: every
 * path here ends by putting bytes where the signed-URL PUT would have put
 * them, so the verification, location scrub and duration probe that run at
 * `/complete` run over them exactly as before.
 *
 * INVARIANTS
 *   • requireUser on every route; the slot must be the caller's own
 *     (`post_media.user_id`), under the named post, and still `pending`.
 *   • The emergency stop `disable_media_uploads` is honoured on every route,
 *     read fail-CLOSED (an unreadable flag stops uploads).
 *   • No client-chosen storage path exists anywhere here. The poster's path and
 *     every part's path are DERIVED from the slot's server-written storage_path.
 *   • Nothing a part says about itself is trusted until `assemble` has checked
 *     every part's size, the total against the size declared at reservation,
 *     and the assembled bytes' kind.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { MEDIA_SIZE_LIMITS, verifyUploadedBytes, type MediaKind } from "../lib/mediaPipeline.js";
import { makeVideoPoster } from "../lib/mediaProcessing.js"; import { renewPendingSlot } from "../services/media/PendingUploadSweep.js";
import {
  POSTER_MAX_BYTES,
  POSTER_MAX_DIM,
  RESUMABLE_CHUNK_BYTES,
  assembleParts,
  listParts,
  mintPartUploadUrls,
  partPathFor,
  partSizeFor,
  posterPathFor,
  summarizeParts,
  type StorageBucketLike,
} from "../lib/postcardMediaTransport.js";

const router = Router();

const STORAGE_BUCKET = "post-media";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-user budgets. Parts are many small requests per upload, so they get their own bucket. */
const POSTER_RATE = { id: "media_poster", limit: 60, windowMs: 5 * 60_000 } as const;
const SESSION_RATE = { id: "media_upload_session", limit: 240, windowMs: 5 * 60_000 } as const;

interface Slot {
  id: string;
  user_id: string;
  post_id: string;
  storage_path: string;
  media_type: MediaKind;
  file_size_bytes: number | null;
  processing_status: string;
}

type SlotResult =
  | { ok: true; slot: Slot }
  | { ok: false; code: "invalid_payload" | "db_error" | "not_found" | "forbidden" | "conflict"; message: string };

/**
 * Load the caller's reserved slot. A read ERROR is reported as such, never as
 * "not found" — a store outage must not read as a missing upload to a client
 * that would then start a fresh one.
 */
async function loadOwnedPendingSlot(sc: any, userId: string, postId: string, mediaId: string): Promise<SlotResult> {
  if (!UUID_RE.test(postId) || !UUID_RE.test(mediaId)) {
    return { ok: false, code: "invalid_payload", message: "Invalid id" };
  }
  const { data, error } = await sc
    .from("post_media")
    .select("id, user_id, post_id, storage_path, media_type, file_size_bytes, processing_status")
    .eq("id", mediaId)
    .eq("post_id", postId)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error", message: "We couldn't load this upload. Please try again." };
  if (!data) return { ok: false, code: "not_found", message: "Media not found" };
  const slot = data as Slot;
  if (slot.user_id !== userId) return { ok: false, code: "forbidden", message: "Not your media" };
  if (!slot.storage_path) return { ok: false, code: "conflict", message: "This upload slot has no storage path yet." };
  if (slot.processing_status !== "pending") {
    return { ok: false, code: "conflict", message: "This media item is no longer accepting an upload." };
  }
  if (slot.media_type !== "image" && slot.media_type !== "video") {
    return { ok: false, code: "conflict", message: "Unsupported media slot." };
  }
  return { ok: true, slot };
}

/** Shared preamble: auth, service client, emergency stop, rate limit, slot. */
async function preamble(
  req: any,
  res: any,
  rate: { id: string; limit: number; windowMs: number },
): Promise<{ sc: any; slot: Slot; bucket: StorageBucketLike } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Storage not configured");
    return null;
  }
  if (await isKillSwitchEngaged(sc, "disable_media_uploads")) {
    sendError(res, "feature_disabled", "Media uploads are temporarily disabled");
    return null;
  }
  const rl = checkRateLimit(rate.id, auth.user.id, rate.limit, rate.windowMs);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many upload requests. Please wait a moment.");
    return null;
  }
  const loaded = await loadOwnedPendingSlot(sc, auth.user.id, String(req.params.id ?? ""), String(req.params.mediaId ?? ""));
  if (!loaded.ok) {
    if (loaded.code === "db_error") req.log?.error?.({ mediaId: req.params.mediaId }, "postcard transport: slot read failed");
    sendError(res, loaded.code, loaded.message);
    return null;
  }
  return { sc, slot: loaded.slot, bucket: sc.storage.from(STORAGE_BUCKET) as StorageBucketLike };
}

/** Bounded raw-body collector: stops buffering the moment the ceiling is passed. */
export function collectBody(limitBytes: number) {
  return (req: any, res: any, next: any) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > limitBytes) {
        done = true;
        sendError(res, "invalid_payload", `Too large. Maximum ${Math.round(limitBytes / 1024 / 1024)} MB.`);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", (err: unknown) => {
      if (done) return;
      done = true;
      next(err);
    });
  };
}

/** The declared size a resumable session is pinned to, or null when it cannot be one. */
function sessionTotal(slot: Slot): number | null {
  const total = slot.file_size_bytes;
  if (typeof total !== "number" || !Number.isInteger(total) || total <= 0) return null;
  if (total > MEDIA_SIZE_LIMITS[slot.media_type]) return null;
  return total;
}

// ── POST /postcards/:id/media/:mediaId/poster ─────────────────────────────────
router.post(
  "/postcards/:id/media/:mediaId/poster",
  collectBody(POSTER_MAX_BYTES),
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res, POSTER_RATE);
    if (!ctx) return;
    const { slot, bucket } = ctx;
    if (slot.media_type !== "video") {
      sendError(res, "invalid_payload", "Only a video has a poster.");
      return;
    }
    const verified = verifyUploadedBytes(req.rawBody as Buffer, "image");
    if (!verified.ok) {
      sendError(res, verified.failure.code, verified.failure.message);
      return;
    }
    let poster;
    try {
      poster = await makeVideoPoster(req.rawBody as Buffer, POSTER_MAX_DIM);
    } catch (err) {
      req.log?.warn?.({ err, mediaId: slot.id }, "postcard poster: undecodable frame refused");
      sendError(res, "invalid_payload", "The poster image could not be read.");
      return;
    }
    const thumbnailPath = posterPathFor(slot.storage_path);
    const { error } = await bucket.upload(thumbnailPath, poster.buffer, { contentType: poster.mime, upsert: true });
    if (error) {
      req.log?.error?.({ err: error, mediaId: slot.id }, "postcard poster: storage write failed");
      sendError(res, "db_error", "We couldn't save the poster. Please try again.");
      return;
    }
    res.status(201).json({ thumbnailPath, width: poster.width, height: poster.height });
  }),
);

// ── POST /postcards/:id/media/:mediaId/upload-session ─────────────────────────
router.post(
  "/postcards/:id/media/:mediaId/upload-session",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res, SESSION_RATE);
    if (!ctx) return;
    const { slot, bucket } = ctx;
    const totalBytes = sessionTotal(slot);
    if (totalBytes == null) {
      sendError(res, "conflict", "This upload was reserved without a usable size; use a single upload.");
      return;
    }
    const listed = await listParts(bucket, slot.storage_path);
    if (!listed.ok) {
      req.log?.error?.({ mediaId: slot.id, err: listed.failure.message }, "upload session: parts listing failed");
      sendError(res, "upstream_error", "We couldn't read the upload's progress. Please try again.");
      return;
    }
    const summary = summarizeParts(listed.parts, totalBytes, RESUMABLE_CHUNK_BYTES);
    const renewed = summary.missing.length > 0 ? await renewPendingSlot(ctx.sc, slot.id) : { ok: true as const }; const minted = renewed.ok ? await mintPartUploadUrls(bucket, slot.storage_path, summary.missing) : { ok: false as const, failure: { kind: "infra" as const, message: `slot renewal failed: ${renewed.message}` } }; // census-discovery §81 (DV-77): the sweep must see every live authority before it exists
    if (!minted.ok) {
      req.log?.error?.({ mediaId: slot.id, err: minted.failure.message }, "upload session: signing failed");
      sendError(res, "upstream_error", "We couldn't prepare the upload. Please try again.");
      return;
    }
    res.status(200).json({
      chunkBytes: summary.chunkBytes,
      totalBytes: summary.totalBytes,
      partCount: summary.partCount,
      receivedParts: summary.received,
      receivedBytes: summary.receivedBytes,
      complete: summary.complete,
      missingParts: minted.urls.map((u) => ({
        index: u.index,
        size: partSizeFor(u.index, totalBytes, RESUMABLE_CHUNK_BYTES),
        uploadUrl: u.uploadUrl,
      })),
    });
  }),
);

// ── POST /postcards/:id/media/:mediaId/upload-session/assemble ────────────────
router.post(
  "/postcards/:id/media/:mediaId/upload-session/assemble",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res, SESSION_RATE);
    if (!ctx) return;
    const { slot, bucket } = ctx;
    const totalBytes = sessionTotal(slot);
    if (totalBytes == null) {
      sendError(res, "conflict", "This upload was reserved without a usable size.");
      return;
    }
    const assembled = await assembleParts(bucket, slot.storage_path, totalBytes, slot.media_type, RESUMABLE_CHUNK_BYTES);
    if (!assembled.ok) {
      const f = assembled.failure;
      if (f.kind === "incomplete") {
        // Resumable, by construction: ask for the session again and send what is missing.
        sendError(res, "conflict", `Upload incomplete: ${f.message}.`);
        return;
      }
      if (f.kind === "content") {
        // The bytes are not what was declared. Nothing is stored; the parts go.
        await bucket.remove(listedPartPaths(slot.storage_path, totalBytes)).then(undefined, () => {});
        sendError(res, "invalid_payload", f.message);
        return;
      }
      req.log?.error?.({ mediaId: slot.id, err: f.message }, "upload session: assembly read failed");
      sendError(res, "upstream_error", "We couldn't finish the upload. Please try again.");
      return;
    }
    // Content type from the SNIFFED bytes — the declared type is a client assertion.
    const { error } = await bucket.upload(slot.storage_path, assembled.buffer, {
      contentType: assembled.sniffed.mime,
      upsert: true,
    });
    if (error) {
      req.log?.error?.({ err: error, mediaId: slot.id }, "upload session: assembled write failed");
      sendError(res, "upstream_error", "We couldn't finish the upload. Please try again.");
      return;
    }
    // Best-effort: the slot's object now exists, so leftover parts are only cost.
    // The sweep and the media delete remove them too (removeTransportArtifacts).
    await bucket.remove(listedPartPaths(slot.storage_path, totalBytes)).then(undefined, () => {});
    res.status(200).json({ assembled: true, totalBytes });
  }),
);

// ── DELETE /postcards/:id/media/:mediaId/upload-session ───────────────────────
router.delete(
  "/postcards/:id/media/:mediaId/upload-session",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res, SESSION_RATE);
    if (!ctx) return;
    const { slot, bucket } = ctx;
    const totalBytes = sessionTotal(slot) ?? MEDIA_SIZE_LIMITS[slot.media_type];
    const { error } = await bucket.remove(listedPartPaths(slot.storage_path, totalBytes));
    if (error) {
      sendError(res, "upstream_error", "We couldn't remove the partial upload. Please try again.");
      return;
    }
    res.status(200).json({ removed: true });
  }),
);

/** Every part path a session of this size could have written. `remove` tolerates absent keys. */
function listedPartPaths(storagePath: string, totalBytes: number): string[] {
  const count = Math.ceil(totalBytes / RESUMABLE_CHUNK_BYTES);
  return Array.from({ length: count }, (_, i) => partPathFor(storagePath, i));
}

export default router;
