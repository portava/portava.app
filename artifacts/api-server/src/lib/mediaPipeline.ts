/**
 * mediaPipeline — the single source of truth for what may be uploaded.
 *
 * WHY THIS EXISTS
 * ---------------
 * There are two upload TRANSPORTS, and that is fine — they solve different
 * problems:
 *
 *   A. POST /api/media/upload            — client posts bytes to the API server,
 *                                          which processes and stores them.
 *                                          Used by posts, memories, stories.
 *   B. upload-url -> PUT -> /complete    — client PUTs straight to Supabase
 *                                          Storage against a signed URL, and the
 *                                          server verifies afterwards. Used by
 *                                          postcards. Gives upload progress and
 *                                          cancellation (XHR), and avoids
 *                                          proxying 100 MB videos through an
 *                                          autoscale process.
 *
 * What was NOT fine is that each transport also carried its own POLICY, and the
 * two drifted:
 *
 *   - Rate limiting existed on A and nowhere on B, so a client could mint signed
 *     upload URLs without bound and push 100 MB objects at the storage bill.
 *   - The image cap was 15 MB on A and 20 MB on B, for the same photo from the
 *     same picker. The 15 was the number with documented reasoning behind it.
 *   - A sniffed magic bytes before storing anything. B verified images only
 *     (routes/postcards.ts gated its whole processing block on
 *     `media_type === 'image'`), so an uploaded "video" was never inspected at
 *     all — its declared byte count was the only thing ever checked.
 *   - `video/webm` was accepted by B's allowlist but unknown to sniffMedia.
 *
 * That drift is the same failure mode that produced the postcard blank-video
 * bug and, before it, the EXIF/GPS leak that routes/postcards.ts documents as an
 * "Audit privacy fix": a guarantee written once, applied to one call site, and
 * silently absent from the sibling. Policy lives here now so a new surface
 * inherits it instead of re-deriving it.
 *
 * Transport stays with the route. Policy lives here.
 */

import { checkRateLimit } from "./rateLimit.js";
import { isKillSwitchEngaged } from "./featureFlags.js";
import { sniffMedia, type SniffResult } from "./mediaProcessing.js";

export type MediaKind = "image" | "video";

/**
 * Upload size ceilings, shared by both transports.
 *
 * The image cap is 15 MB, not the 20 MB the postcard path used. The dominant
 * source is a 12 MP phone photo re-encoded at the pickers' CAPTURE_QUALITY of
 * 0.92, which lands around 4-8 MB; the case that does not fit is a 48 MP source
 * at that quality (~15-18 MB), reachable only with HEIF-Max / ProRAW explicitly
 * enabled. If that becomes common the number to move to is 25 MB — chosen to
 * clear 48 MP-at-q92 with headroom — and moving it HERE moves it everywhere,
 * which was the whole point.
 */
export const MEDIA_SIZE_LIMITS: Readonly<Record<MediaKind, number>> = {
  image: 15 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

/**
 * Declared MIME allowlist — the UNION of what the two transports accepted
 * before consolidation, so nothing a client could previously upload starts
 * failing. `video/webm` came from the postcard path only; it is honoured here
 * and is now recognised by sniffMedia too.
 *
 * A declared type is a hint, never a fact: it decides the size ceiling and the
 * storage extension, and `verifyUploadedBytes` re-decides the truth from the
 * bytes themselves.
 */
export const ALLOWED_MEDIA_MIME: Readonly<
  Record<string, { mediaType: MediaKind; ext: string }>
> = {
  "image/jpeg": { mediaType: "image", ext: "jpg" },
  "image/jpg": { mediaType: "image", ext: "jpg" },
  "image/png": { mediaType: "image", ext: "png" },
  "image/webp": { mediaType: "image", ext: "webp" },
  "image/heic": { mediaType: "image", ext: "heic" },
  "video/mp4": { mediaType: "video", ext: "mp4" },
  "video/quicktime": { mediaType: "video", ext: "mov" },
  "video/webm": { mediaType: "video", ext: "webm" },
};

/** Per-user upload budget. Both transports draw on the SAME bucket — an
 *  attacker does not get a fresh allowance by switching endpoint. */
export const UPLOAD_RATE_LIMIT = 30;
export const UPLOAD_RATE_WINDOW_MS = 5 * 60_000;
const UPLOAD_LIMITER_ID = "media_upload";

export type PolicyFailure =
  | { code: "feature_disabled"; message: string }
  | { code: "rate_limited"; message: string; retryAfterMs: number }
  | { code: "invalid_payload"; message: string };

export type PolicyResult<T> = { ok: true; value: T } | { ok: false; failure: PolicyFailure };

/**
 * Gate that must pass before ANY upload is accepted or any signed upload URL is
 * minted: the emergency stop, then the per-user rate limit.
 *
 * The kill switch is read with isKillSwitchEngaged, so an unreadable flag
 * ENGAGES the stop rather than disengaging it.
 */
export async function guardUploadRequest(
  sc: unknown,
  userId: string,
): Promise<PolicyResult<null>> {
  if (await isKillSwitchEngaged(sc as any, "disable_media_uploads")) {
    return {
      ok: false,
      failure: { code: "feature_disabled", message: "Media uploads are temporarily disabled" },
    };
  }

  const rl = checkRateLimit(UPLOAD_LIMITER_ID, userId, UPLOAD_RATE_LIMIT, UPLOAD_RATE_WINDOW_MS);
  if (!rl.allowed) {
    return {
      ok: false,
      failure: {
        code: "rate_limited",
        message: "Too many uploads. Please wait a moment.",
        retryAfterMs: rl.retryAfterMs,
      },
    };
  }

  return { ok: true, value: null };
}

/**
 * Validate what the client SAYS it is about to upload. Used by the signed-URL
 * transport, which has no bytes to inspect yet.
 */
export function validateDeclaredUpload(input: {
  mimeType: string;
  fileSizeBytes: number;
}): PolicyResult<{ mediaType: MediaKind; ext: string }> {
  const info = ALLOWED_MEDIA_MIME[input.mimeType];
  if (!info) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          `Unsupported MIME type: ${input.mimeType}. ` +
          `Supported: ${Object.keys(ALLOWED_MEDIA_MIME).join(", ")}`,
      },
    };
  }

  const limit = MEDIA_SIZE_LIMITS[info.mediaType];
  if (input.fileSizeBytes > limit) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message: `File too large. Maximum ${Math.round(limit / 1024 / 1024)} MB for ${info.mediaType}.`,
      },
    };
  }

  return { ok: true, value: { mediaType: info.mediaType, ext: info.ext } };
}

/**
 * Decide what the bytes ACTUALLY are, and reject anything that disagrees with
 * what was promised.
 *
 * This is the check the signed-URL transport never applied to video. It matters
 * most there, precisely because on that transport the bytes reach permanent
 * storage before the server ever sees them — so "we validated the declaration"
 * is not validation, it is a client assertion about a file the client already
 * wrote.
 *
 * Enforces, in order: non-empty, recognisable, within the ceiling for its REAL
 * kind, and matching the declared kind when one was declared. Callers should
 * treat a failure as fatal for the upload (fail-closed), which for the
 * signed-URL transport means refusing completion so the client can retry.
 */
export function verifyUploadedBytes(
  buf: Buffer | null | undefined,
  declaredKind?: MediaKind,
): PolicyResult<SniffResult> {
  if (!buf || buf.length === 0) {
    return { ok: false, failure: { code: "invalid_payload", message: "Empty file body" } };
  }

  const sniffed = sniffMedia(buf);
  if (!sniffed) {
    return {
      ok: false,
      failure: { code: "invalid_payload", message: "Unrecognized or corrupt media file" },
    };
  }

  const limit = MEDIA_SIZE_LIMITS[sniffed.kind];
  if (buf.length > limit) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          `File too large (${Math.round(buf.length / 1024 / 1024)}MB; ` +
          `max ${Math.round(limit / 1024 / 1024)}MB)`,
      },
    };
  }

  // A declared image that sniffs as video (or the reverse) is not a size or
  // format question — it means the stored object is not the thing the row
  // describes, and every downstream consumer (thumbnailer, feed variant,
  // renderer) would treat it as the wrong type.
  if (declaredKind && sniffed.kind !== declaredKind) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message: `Uploaded bytes are ${sniffed.kind}, but ${declaredKind} was declared`,
      },
    };
  }

  return { ok: true, value: sniffed };
}
