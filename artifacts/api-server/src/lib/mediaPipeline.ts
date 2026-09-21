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
import { sniffMedia, sniffVoiceAudio, type SniffResult, type VoiceSniffResult } from "./mediaProcessing.js";
import { stripVideoLocationMetadata } from "./videoMetadata.js";

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

/* ===========================================================================
 * VOICE — Telegraph §6.2's VOICE kind, and ONLY that.
 * ===========================================================================
 * Everything above this line is the GENERAL media policy: posts, memories,
 * stories, postcards. Nothing above this line changed when voice arrived, and
 * that is the point. `ALLOWED_MEDIA_MIME` still admits image and video only, so
 * no existing surface accepts one more byte than it did yesterday.
 *
 * Voice gets its own, STRICTLY NARROWER allowlist here rather than its own
 * module, for the reason this file's header gives: the failure this module
 * exists to prevent is two upload paths carrying two copies of a policy and
 * drifting. So voice shares this file, shares `guardUploadRequest`, and above
 * all shares the RATE-LIMIT BUCKET — a caller does not get a fresh upload
 * allowance by switching to the voice endpoint, which is the same property the
 * two general transports already have.
 */

/**
 * The voice upload ceiling.
 *
 * Deliberately far below the 15 MB image cap, and derived from the recording
 * the composer actually makes rather than from "audio is small": AAC-LC mono at
 * 64 kbit/s is 8 KB per second, so §6.2's five-minute voice-note ceiling
 * (`services/telegraph/voice.ts#VOICE_MAX_DURATION_SECONDS`) is ~2.4 MB. 8 MB
 * leaves room for a higher bitrate preset and container overhead without
 * leaving room for a file that is plainly not a voice note.
 *
 * The DURATION cap deliberately does NOT live here. How many bytes an upload
 * may be is transport policy and belongs in this file; how long a voice
 * MESSAGE may run is a §6.2 rule about the kind, belongs with the kind, and
 * keeping it there is what stops this module's `sharp` dependency being pulled
 * into every service that needs to know what a voice note is.
 */
export const VOICE_SIZE_LIMIT = 8 * 1024 * 1024;

/**
 * The voice MIME allowlist — ONE container, three spellings of it.
 *
 * `audio/mp4` is the registered type; `audio/m4a` and `audio/x-m4a` are what
 * iOS and Android clients actually put on the wire for the same bytes. All
 * three resolve to the same extension, and the DECLARATION decides nothing on
 * its own: `verifyUploadedVoiceBytes` re-derives the truth from the bytes and
 * rejects anything whose TRACKS are not all audio — a check the brand cannot
 * make and a mislabelled video cannot pass.
 *
 * WHY THIS IS NOT "WIDENING AN ALLOWLIST". It is a new, closed list reachable
 * from one route, and it is smaller than the list beside it. No caller of
 * `ALLOWED_MEDIA_MIME` can reach it, and no byte that was refused by any
 * existing surface is accepted by any existing surface because of it.
 */
export const ALLOWED_VOICE_MIME: Readonly<Record<string, { ext: string }>> = {
  "audio/mp4": { ext: "m4a" },
  "audio/m4a": { ext: "m4a" },
  "audio/x-m4a": { ext: "m4a" },
};

/** Validate what a voice client SAYS it is about to upload. */
export function validateDeclaredVoiceUpload(input: {
  mimeType: string;
  fileSizeBytes: number;
}): PolicyResult<{ ext: string }> {
  const info = ALLOWED_VOICE_MIME[input.mimeType];
  if (!info) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          `Unsupported voice type: ${input.mimeType}. ` +
          `Supported: ${Object.keys(ALLOWED_VOICE_MIME).join(", ")}`,
      },
    };
  }
  if (input.fileSizeBytes > VOICE_SIZE_LIMIT) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message: `Voice note too large. Maximum ${Math.round(VOICE_SIZE_LIMIT / 1024 / 1024)} MB.`,
      },
    };
  }
  return { ok: true, value: { ext: info.ext } };
}

/**
 * Decide what voice bytes ACTUALLY are, strip their capture location, and
 * prove the strip worked — or refuse.
 *
 * THE LOCATION SCRUB IS THE REASON THIS FUNCTION EXISTS RATHER THAN A BARE
 * SNIFF. An `.m4a` is an MP4 container. `lib/videoMetadata.ts` documents at
 * length that a phone writes its capture coordinates into
 * `moov/udta/©xyz`, `loci`, or an Apple `meta` box, and that the app's
 * location-privacy model held for stills and silently did not hold for video
 * until that module existed. Those boxes live in `moov`, not in the video
 * track: an audio-only recording from the same camera stack can carry them.
 * Assuming a voice recorder never writes one would re-open, for a new asset
 * type, the exact hole that module was written to close — so the scrub runs,
 * and it runs FAIL-CLOSED: bytes whose location markers cannot be proven gone
 * are refused, never stored.
 *
 * Returns the SCRUBBED buffer. Callers must store what comes back, not what
 * they passed in.
 */
export function verifyUploadedVoiceBytes(
  buf: Buffer | null | undefined,
): PolicyResult<{ sniffed: VoiceSniffResult; buffer: Buffer; stripped: string[] }> {
  if (!buf || buf.length === 0) {
    return { ok: false, failure: { code: "invalid_payload", message: "Empty voice file" } };
  }

  const sniffed = sniffVoiceAudio(buf);
  if (!sniffed) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          "Unrecognized voice recording. A voice note must be an MP4/M4A container " +
          "whose every track is audio; anything carrying a video track, and anything " +
          "whose tracks cannot be read, is refused.",
      },
    };
  }

  if (buf.length > VOICE_SIZE_LIMIT) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          `Voice note too large (${Math.round(buf.length / 1024 / 1024)}MB; ` +
          `max ${Math.round(VOICE_SIZE_LIMIT / 1024 / 1024)}MB)`,
      },
    };
  }

  // `stripVideoLocationMetadata` walks ISO-BMFF boxes and is indifferent to
  // whether the tracks inside carry pictures. It guards on `kind === "video"`
  // because its only caller until now was the video path; an `.m4a` is the same
  // container, so it is handed the container it understands. The bytes are
  // this function's own, already proven by the sniff above to carry NO video
  // track, so nothing about that guard is being evaded — a video cannot arrive
  // here whatever brand it claims.
  const scrub = stripVideoLocationMetadata(buf, { kind: "video", mime: "video/mp4", ext: "mp4" });
  if (!scrub.ok) {
    return {
      ok: false,
      failure: {
        code: "invalid_payload",
        message:
          "This recording carries location metadata that could not be removed. " +
          "Please re-record it with location services off.",
      },
    };
  }

  return { ok: true, value: { sniffed, buffer: scrub.buffer, stripped: scrub.stripped } };
}
