/**
 * POST /api/media/upload/poster?path=<uid>/<ms>.<ext>   (raw image body)
 *
 * §37 "Thumbnail generation" for a video uploaded through the GENERAL route
 * (`POST /media/upload`). The device extracts a frame (the server has no video
 * decoder in this tier); this route re-encodes it with no metadata, stores it
 * at the video's derived poster path, and records it on the video's canonical
 * `media_assets` row. Policy lives in lib/mediaVideoPoster.ts; this file is
 * transport only.
 *
 * INVARIANTS
 *   • requireUser. The video must be the caller's own, in the /media/upload
 *     layout, uploaded within the attach window, and present in storage.
 *   • The emergency stop and the per-user upload budget are the SAME ones
 *     /media/upload uses (lib/mediaPipeline.guardUploadRequest) — a poster does
 *     not buy a fresh allowance.
 *   • The bytes must be an image (sniffed, not declared) and decodable.
 *   • Written once: a second poster for the same video is 409, never a swap.
 */
import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { guardUploadRequest, verifyUploadedBytes } from "../lib/mediaPipeline.js";
import { makeVideoPoster } from "../lib/mediaProcessing.js";
import { POSTER_MAX_BYTES, POSTER_MAX_DIM } from "../lib/postcardMediaTransport.js";
import {
  POSTER_BUCKET,
  isAlreadyExists,
  parseOwnVideoPath,
  recordPosterOnAsset,
  videoObjectExists,
  type PosterBucketLike,
} from "../lib/mediaVideoPoster.js";
import { collectBody } from "./postcardMediaTransport.js";

const router = Router();

let _assetRetryDelayMs: number | null = null;
/** Test seam: shorten the canonical-row retry delay. */
export function _setPosterAssetRetryDelay(ms: number | null): void {
  _assetRetryDelayMs = ms;
}

router.post(
  "/media/upload/poster",
  collectBody(POSTER_MAX_BYTES),
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Storage not configured");
      return;
    }
    const guard = await guardUploadRequest(sc, user.id);
    if (!guard.ok) {
      if (guard.failure.code === "rate_limited") {
        res.setHeader("Retry-After", Math.ceil(guard.failure.retryAfterMs / 1000).toString());
      }
      sendError(res, guard.failure.code, guard.failure.message);
      return;
    }

    const video = parseOwnVideoPath(user.id, req.query.path, Date.now());
    if (!video.ok) {
      sendError(res, video.code, video.message);
      return;
    }

    const verified = verifyUploadedBytes((req as any).rawBody as Buffer, "image");
    if (!verified.ok) {
      sendError(res, verified.failure.code, verified.failure.message);
      return;
    }

    const bucket = sc.storage.from(POSTER_BUCKET) as unknown as PosterBucketLike;
    const exists = await videoObjectExists(bucket, video);
    if (exists === "error") {
      req.log?.error?.({ path: video.path }, "video poster: storage list failed");
      sendError(res, "db_error", "We couldn't check this video. Please try again.");
      return;
    }
    if (exists === "absent") {
      sendError(res, "not_found", "Video not found");
      return;
    }

    let poster;
    try {
      poster = await makeVideoPoster((req as any).rawBody as Buffer, POSTER_MAX_DIM);
    } catch (err) {
      req.log?.warn?.({ err, path: video.path }, "video poster: undecodable frame refused");
      sendError(res, "invalid_payload", "The poster image could not be read.");
      return;
    }

    const { error } = await bucket.upload(video.posterPath, poster.buffer, { contentType: poster.mime, upsert: false });
    if (error) {
      if (isAlreadyExists(error)) {
        sendError(res, "conflict", "This video already has a poster.");
        return;
      }
      req.log?.error?.({ err: error, path: video.path }, "video poster: storage write failed");
      sendError(res, "db_error", "We couldn't save the poster. Please try again.");
      return;
    }

    const asset = await recordPosterOnAsset(
      sc,
      { userId: user.id, storagePath: video.path, posterPath: video.posterPath },
      _assetRetryDelayMs !== null ? { delayMs: _assetRetryDelayMs } : {},
    );
    if (asset === "updated") void moderateVideoOnFrame(sc, { bucket: POSTER_BUCKET, path: video.path, framePath: video.posterPath }); /* census-media §37 (MD283): only ever tightens; off while 3356 is */ if (asset !== "updated") {
      req.log?.warn?.({ path: video.path, asset }, "video poster: stored, but not recorded on a canonical media_assets row");
    }

    res.status(201).json({
      thumbnailUrl: `${POSTER_BUCKET}/${video.posterPath}`,
      thumbnailPath: video.posterPath,
      width: poster.width,
      height: poster.height,
      assetRecorded: asset === "updated",
    });
  }),
);

export default router;

// census-media §37 (MD283): a frame-capable classifier's look at the stored frame. Imported at the
// TAIL so the anchored route line above does not move; ESM hoists imports.
import { moderateVideoOnFrame } from "../lib/media/vendors/mediaVendorStages.js";
