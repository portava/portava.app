/**
 * Resumable MESSAGE-media upload (Telegraph §16.2 "Resumable/chunked upload for
 * poor travel connectivity", census-telegraph T223; migration 3656, flag seeded
 * FALSE).
 *
 *   POST   /api/media/upload-session           what is already stored + signed URLs for what is not
 *   POST   /api/media/upload-session/assemble  concatenate, verify, then store through /media/upload's path
 *   DELETE /api/media/upload-session           abandon: remove the parts
 *
 * Body on all three: { uploadId: uuid, mimeType, totalBytes }.
 *
 * THE PROTOCOL IS THE POSTCARD ONE (lib/postcardMediaTransport.ts), unchanged:
 * fixed 4 MiB parts PUT straight to Storage at signed URLs (upsert), a session
 * that LISTS what landed and signs only what is missing — so a dropped part, an
 * expired URL or an app relaunch all resume from the same call — and an assemble
 * that refuses (never repairs) a short session, a wrong-sized part or bytes of
 * the wrong kind. Only the slot differs: a message upload has no `post_media`
 * row, so a session is (caller, client upload id, declared mime and size),
 * restated on every call and re-checked at assemble.
 *
 * INVARIANTS
 *   • requireUser on every route; flag `message_media_resumable_upload_enabled`
 *     (false on error) — OFF answers 404 and the client keeps /media/upload.
 *   • The emergency stop `disable_media_uploads` is honoured on every route,
 *     read fail-CLOSED; the per-user upload budget is /media/upload's own
 *     (guardUploadRequest), spent once per assembled upload — switching
 *     transport buys no fresh allowance.
 *   • No client-chosen storage path. Parts live at
 *     message-upload-parts/<caller id>/<upload id>.parts/NNNNN, derived from the
 *     AUTHENTICATED id and a uuid; nobody can address another person's parts.
 *     That prefix is outside every `<user id>/…` owner prefix, so no client
 *     storage policy grants a read of raw parts.
 *   • The assembled bytes are stored by `storeVerifiedMediaUpload`
 *     (routes/posts.ts) — the exact code /media/upload runs: kind sniffed from
 *     the bytes, EXIF/GPS strip + orientation + thumbnail + feed variant for
 *     images (fail-closed), container location scrub + probe for video
 *     (fail-closed), stored at <caller id>/<ts>.<ext>, media_assets recorded.
 *     The answer is /media/upload's 201, so POST /threads/:id/media and every
 *     reader are unchanged.
 *   • Parts are removed after a successful assemble and after a content refusal;
 *     abandoned ones by lib/messageMediaPartsSweep.ts.
 */

import { Router } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { isFlagEnabled, isKillSwitchEngaged } from "../lib/featureFlags.js";
import { guardUploadRequest, validateDeclaredUpload, type MediaKind } from "../lib/mediaPipeline.js";
import {
  RESUMABLE_CHUNK_BYTES,
  assembleParts,
  listParts,
  mintPartUploadUrls,
  partPathFor,
  partSizeFor,
  summarizeParts,
  type StorageBucketLike,
} from "../lib/postcardMediaTransport.js";
import { storeVerifiedMediaUpload } from "./posts.js";
import { MESSAGE_PARTS_PREFIX } from "../lib/messageMediaPartsSweep.js";

const router = Router();

const STORAGE_BUCKET = "post-media";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The postcard transport's session budget, shared by id: one allowance for every part-upload door. */
const SESSION_RATE = { id: "media_upload_session", limit: 240, windowMs: 5 * 60_000 } as const;

/** The server-derived base path for a caller's upload. Never built from anything but the auth id and a uuid. */
export function messagePartsBase(userId: string, uploadId: string): string {
  return `${MESSAGE_PARTS_PREFIX}/${userId}/${uploadId.toLowerCase()}`;
}

interface Session {
  storagePath: string;
  mimeType: string;
  kind: MediaKind;
  totalBytes: number;
}

async function preamble(req: any, res: any): Promise<{ sc: any; user: { id: string }; session: Session; bucket: StorageBucketLike } | null> {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const sc = getServiceClient();
  if (!sc) {
    sendError(res, "server_not_configured", "Storage not configured");
    return null;
  }
  if (!(await isFlagEnabled(sc, "message_media_resumable_upload_enabled"))) {
    sendError(res, "not_found", "Resumable upload is not available.");
    return null;
  }
  if (await isKillSwitchEngaged(sc, "disable_media_uploads")) {
    sendError(res, "feature_disabled", "Media uploads are temporarily disabled");
    return null;
  }
  const rl = checkRateLimit(SESSION_RATE.id, auth.user.id, SESSION_RATE.limit, SESSION_RATE.windowMs);
  if (!rl.allowed) {
    res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
    sendError(res, "rate_limited", "Too many upload requests. Please wait a moment.");
    return null;
  }
  const uploadId = typeof req.body?.uploadId === "string" ? req.body.uploadId : "";
  const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType.split(";")[0].trim() : "";
  const totalBytes = Number(req.body?.totalBytes);
  if (!UUID_RE.test(uploadId)) {
    sendError(res, "invalid_payload", "uploadId must be a uuid");
    return null;
  }
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) {
    sendError(res, "invalid_payload", "totalBytes must be a positive integer");
    return null;
  }
  const declared = validateDeclaredUpload({ mimeType, fileSizeBytes: totalBytes });
  if (!declared.ok) {
    sendError(res, declared.failure.code, declared.failure.message);
    return null;
  }
  return {
    sc,
    user: { id: auth.user.id },
    session: { storagePath: messagePartsBase(auth.user.id, uploadId), mimeType, kind: declared.value.mediaType, totalBytes },
    bucket: sc.storage.from(STORAGE_BUCKET) as StorageBucketLike,
  };
}

function allPartPaths(storagePath: string, totalBytes: number): string[] {
  const count = Math.ceil(totalBytes / RESUMABLE_CHUNK_BYTES);
  return Array.from({ length: count }, (_, i) => partPathFor(storagePath, i));
}

// ── POST /media/upload-session ────────────────────────────────────────────────
router.post(
  "/media/upload-session",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res);
    if (!ctx) return;
    const { session, bucket } = ctx;
    const listed = await listParts(bucket, session.storagePath);
    if (!listed.ok) {
      req.log?.error?.({ err: listed.failure.message }, "message upload session: parts listing failed");
      sendError(res, "upstream_error", "We couldn't read the upload's progress. Please try again.");
      return;
    }
    const summary = summarizeParts(listed.parts, session.totalBytes, RESUMABLE_CHUNK_BYTES);
    const minted = await mintPartUploadUrls(bucket, session.storagePath, summary.missing);
    if (!minted.ok) {
      req.log?.error?.({ err: minted.failure.message }, "message upload session: signing failed");
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
        size: partSizeFor(u.index, session.totalBytes, RESUMABLE_CHUNK_BYTES),
        uploadUrl: u.uploadUrl,
      })),
    });
  }),
);

// ── POST /media/upload-session/assemble ───────────────────────────────────────
router.post(
  "/media/upload-session/assemble",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res);
    if (!ctx) return;
    const { sc, user, session, bucket } = ctx;
    // One assembled upload spends one unit of /media/upload's own budget.
    const guard = await guardUploadRequest(sc, user.id);
    if (!guard.ok) {
      if (guard.failure.code === "rate_limited") res.setHeader("Retry-After", Math.ceil(guard.failure.retryAfterMs / 1000).toString());
      sendError(res, guard.failure.code, guard.failure.message);
      return;
    }
    const assembled = await assembleParts(bucket, session.storagePath, session.totalBytes, session.kind, RESUMABLE_CHUNK_BYTES);
    if (!assembled.ok) {
      const f = assembled.failure;
      if (f.kind === "incomplete") {
        sendError(res, "conflict", `Upload incomplete: ${f.message}.`);
        return;
      }
      if (f.kind === "content") {
        await bucket.remove(allPartPaths(session.storagePath, session.totalBytes)).then(undefined, () => {});
        sendError(res, "invalid_payload", f.message);
        return;
      }
      req.log?.error?.({ err: f.message }, "message upload session: assembly read failed");
      sendError(res, "upstream_error", "We couldn't finish the upload. Please try again.");
      return;
    }
    await storeVerifiedMediaUpload(req, res, sc, user, assembled.buffer, session.mimeType);
    // Stored (201) or refused for its CONTENT (400): the parts are no longer needed.
    // Any other answer (a storage outage) keeps them, so the client's retry re-assembles.
    if (res.statusCode === 201 || res.statusCode === 400) {
      await bucket.remove(allPartPaths(session.storagePath, session.totalBytes)).then(undefined, () => {});
    }
  }),
);

// ── DELETE /media/upload-session ──────────────────────────────────────────────
router.delete(
  "/media/upload-session",
  asyncHandler(async (req, res) => {
    const ctx = await preamble(req, res);
    if (!ctx) return;
    const { session, bucket } = ctx;
    const { error } = await bucket.remove(allPartPaths(session.storagePath, session.totalBytes));
    if (error) {
      sendError(res, "upstream_error", "We couldn't remove the partial upload. Please try again.");
      return;
    }
    res.status(200).json({ removed: true });
  }),
);

export default router;
