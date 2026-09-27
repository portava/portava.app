/**
 * mediaVendorStages — where the four vendor seams meet the upload paths
 * (census-media §37). Every stage is behind its own flag, seeded FALSE; with
 * all four off, the only thing any caller does differently is read four flags.
 *
 *   stage        flag (migration)                               seam
 *   ───────────  ─────────────────────────────────────────────  ──────────────────────────
 *   moderation   media_moderation_classifier_enabled (3356)     mediaModerationClassifier
 *   vision       media_vision_provider_enabled (3355)           mediaVisionProvider
 *   transcode    media_transcoder_enabled (3357)                mediaTranscoder
 *   captions     media_captions_enabled (3358)                  mediaCaptionSource
 *
 * THE CALLERS
 *   • `runMediaVendorIngest` — POST /media/upload, after the canonical row is
 *     written (routes/posts.ts). Moderation decides the canonical row's §36
 *     state through MediaModerationService (the one writer of that decision);
 *     vision hands the file to the index; a video goes to the transcoder and
 *     to the caption source. It runs after the response, like the canonical
 *     write before it, and never throws.
 *   • `preDistributionPostMediaStatus` — POST /postcards/:id/media/:mediaId/complete
 *     (routes/postcards.ts): the value the `post_media` row is written with.
 *     Stage off: `approved`, as before. Stage on: the decision (a hold is
 *     `flagged`).
 *   • `moderateVideoOnFrame` — POST /media/upload/poster (routes/mediaVideoPoster.ts):
 *     a general video's frame arrives after its upload, so a frame-capable
 *     classifier gets its look there.
 *   • Search (MediaSearchService tail) reads the vision flag itself, through
 *     `isMediaVisionStageEnabled` below.
 *
 * FLAG READS follow the house CAPABILITY convention (lib/featureFlags
 * isFlagEnabled): absent, false and unreadable all read OFF. For three stages
 * that is plainly safe — off means "no vendor call". For MODERATION it means an
 * unreadable flag table lets an upload through unmoderated, which is exactly
 * today's behaviour; an owner who turns the stage on and wants an unreadable
 * flag to HOLD instead must make that a separate stop (isKillSwitchEngaged
 * semantics). Recorded in census-media §37 as an activation decision.
 */
import { isFlagEnabled } from "../../featureFlags.js";
import { logger } from "../../logger.js";
import { applyCanonicalModerationDecision, type CanonicalModerationOutcome } from "../../../services/media/MediaModerationService.js";
import {
  decidePreDistribution,
  postMediaStatusFor,
  selectMediaModerationClassifier,
  type ModerationSubject,
  type PreDistributionDecision,
} from "./mediaModerationClassifier.js";
import { callVendor, refused, type VendorAnswer } from "./vendorCommon.js";
import { selectMediaVisionProvider, type MediaVisionProvider } from "./mediaVisionProvider.js";
import { selectMediaTranscoder, submitForTranscode, type MediaTranscoder } from "./mediaTranscoder.js";
import { captionTrackFor, captionTrackPathFor, selectMediaCaptionSource, type MediaCaptionSource } from "./mediaCaptionSource.js";
import type { MediaModerationClassifier } from "./mediaModerationClassifier.js";

export const MEDIA_VISION_STAGE_FLAG = "media_vision_provider_enabled";
export const MEDIA_MODERATION_STAGE_FLAG = "media_moderation_classifier_enabled";
export const MEDIA_TRANSCODE_STAGE_FLAG = "media_transcoder_enabled";
export const MEDIA_CAPTIONS_STAGE_FLAG = "media_captions_enabled";

export async function isMediaVisionStageEnabled(sc: unknown): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_VISION_STAGE_FLAG);
}
export async function isMediaModerationStageEnabled(sc: unknown): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_MODERATION_STAGE_FLAG);
}
export async function isMediaTranscodeStageEnabled(sc: unknown): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_TRANSCODE_STAGE_FLAG);
}
export async function isMediaCaptionsStageEnabled(sc: unknown): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_CAPTIONS_STAGE_FLAG);
}

/** The adapters a stage run uses. Injected in tests; env-selected otherwise. */
export interface MediaVendorAdapters {
  classifier: MediaModerationClassifier;
  vision: MediaVisionProvider;
  transcoder: MediaTranscoder;
  captions: MediaCaptionSource;
}

export function selectedMediaVendorAdapters(): MediaVendorAdapters {
  return {
    classifier: selectMediaModerationClassifier().adapter,
    vision: selectMediaVisionProvider().adapter,
    transcoder: selectMediaTranscoder().adapter,
    captions: selectMediaCaptionSource().adapter,
  };
}

export interface VendorIngestSubject {
  assetId: string | null;
  bucket: string;
  path: string;
  mediaType: "image" | "video";
  durationMs: number | null;
}

type StageReport<T> = { state: "off" } | { state: "ran"; result: T };

export interface VendorIngestReport {
  moderation: StageReport<{ decision: PreDistributionDecision; recorded: CanonicalModerationOutcome | "skipped_no_asset" }>;
  vision: StageReport<VendorAnswer<{ accepted: boolean }>>;
  transcode: StageReport<VendorAnswer<{ jobId: string }>>;
  captions: StageReport<VendorAnswer<{ stored: string; cues: number; language: string | null }>>;
}

/** Minimal storage surface the captions stage writes through. */
interface StorageLike {
  storage?: { from(bucket: string): { upload(path: string, body: Buffer, opts: { contentType: string; upsert: boolean }): Promise<{ error: unknown }> } };
}

/**
 * The four ingestion stages for one stored file. NEVER throws; the report is
 * the whole outcome and is logged once. With every flag off it makes four flag
 * reads and nothing else.
 */
export async function runMediaVendorIngest(
  sc: unknown,
  subject: VendorIngestSubject,
  adapters: MediaVendorAdapters = selectedMediaVendorAdapters(),
): Promise<VendorIngestReport> {
  const report: VendorIngestReport = {
    moderation: { state: "off" },
    vision: { state: "off" },
    transcode: { state: "off" },
    captions: { state: "off" },
  };
  try {
    const [moderationOn, visionOn, transcodeOn, captionsOn] = await Promise.all([
      isMediaModerationStageEnabled(sc),
      isMediaVisionStageEnabled(sc),
      isMediaTranscodeStageEnabled(sc),
      isMediaCaptionsStageEnabled(sc),
    ]);

    if (moderationOn) {
      // HOLD FIRST, then decide. The canonical row is born `processing`
      // (lib/mediaAssets writes it, and `processing` is distributable), and a
      // classifier may take up to VENDOR_CALL_TIMEOUT_MS. Holding before the
      // call shrinks the undecided window from the classifier's latency to one
      // round trip after the insert; the final decision then moves the row
      // limited → active / rejected, both allowed by the §36 table.
      let recorded: CanonicalModerationOutcome | "skipped_no_asset" = "skipped_no_asset";
      if (subject.assetId) {
        recorded = await applyCanonicalModerationDecision(sc as any, { bucket: subject.bucket, path: subject.path, decision: "flag" });
      }
      const decision = await decidePreDistribution({
        stageOn: true,
        classifier: adapters.classifier,
        subject: { mediaType: subject.mediaType, bucket: subject.bucket, path: subject.path, framePath: null },
      });
      if (subject.assetId && decision.stage === "on" && decision.decision !== "flag") {
        recorded = await applyCanonicalModerationDecision(sc as any, {
          bucket: subject.bucket,
          path: subject.path,
          decision: decision.decision,
        });
      }
      report.moderation = { state: "ran", result: { decision, recorded } };
    }

    if (visionOn) {
      const v = adapters.vision;
      const answer: VendorAnswer<{ accepted: boolean }> = !subject.assetId
        ? refused("invalid_answer", "no canonical asset id to index under")
        : !v.capabilities.ingest
          ? refused(v.name === "none" ? "not_configured" : "unsupported", `${v.name} does not ingest`)
          : await callVendor(() => v.ingest({
              assetId: subject.assetId as string,
              mediaType: subject.mediaType,
              bucket: subject.bucket,
              path: subject.path,
              framePath: null,
            }));
      report.vision = { state: "ran", result: answer };
    }

    if (transcodeOn && subject.mediaType === "video") {
      report.transcode = {
        state: "ran",
        result: subject.assetId
          ? await submitForTranscode(adapters.transcoder, {
              assetId: subject.assetId,
              bucket: subject.bucket,
              path: subject.path,
              durationMs: subject.durationMs,
            })
          : refused("invalid_answer", "no canonical asset id to transcode under"),
      };
    }

    if (captionsOn && subject.mediaType === "video") {
      report.captions = { state: "ran", result: await captionStage(sc as StorageLike, adapters.captions, subject) };
    }
  } catch (err) {
    logger.warn({ err, path: subject.path }, "media vendor stages threw — report is partial");
  }
  logger.info(
    {
      path: subject.path,
      moderation: report.moderation.state === "ran" ? summarizeDecision(report.moderation.result.decision) : "off",
      moderationRecorded: report.moderation.state === "ran" ? report.moderation.result.recorded : null,
      vision: summarize(report.vision),
      transcode: summarize(report.transcode),
      captions: summarize(report.captions),
    },
    "media vendor stages",
  );
  return report;
}

async function captionStage(
  sc: StorageLike,
  source: MediaCaptionSource,
  subject: VendorIngestSubject,
): Promise<VendorAnswer<{ stored: string; cues: number; language: string | null }>> {
  if (!subject.assetId) return refused("invalid_answer", "no canonical asset id to caption under");
  const track = await captionTrackFor(source, {
    assetId: subject.assetId,
    bucket: subject.bucket,
    path: subject.path,
    durationMs: subject.durationMs,
  });
  if (!track.ok) return track;
  const stored = captionTrackPathFor(subject.path);
  const bucket = sc.storage?.from(subject.bucket);
  if (!bucket) return refused("error", "no storage client");
  // upsert:false — a track, once stored, is replaced only by a deliberate flow, never by a re-run.
  const { error } = await bucket.upload(stored, Buffer.from(track.value.vtt, "utf8"), { contentType: "text/vtt", upsert: false });
  if (error) return refused("error", "the caption track could not be stored");
  return { ok: true, value: { stored, cues: track.value.cues, language: track.value.language } };
}

function summarize(r: StageReport<VendorAnswer<unknown>>): string {
  if (r.state === "off") return "off";
  return r.result.ok ? "ok" : `refused:${r.result.reason}`;
}

function summarizeDecision(d: PreDistributionDecision): string {
  return d.stage === "off" ? "off" : `${d.decision}:${d.basis}`;
}

/**
 * The `post_media.moderation_status` a postcard slot is completed with.
 * Stage off (the seed): `approved` — byte-for-byte what `/complete` wrote before.
 * NEVER throws: a throw here would fail a completion the stage never meant to
 * touch, so an unexpected error with the stage ON holds (`flagged`), and with
 * the stage's flag unreadable the flag reads off (see the header).
 */
export async function preDistributionPostMediaStatus(
  sc: unknown,
  subject: ModerationSubject,
  classifier: MediaModerationClassifier = selectMediaModerationClassifier().adapter,
): Promise<"approved" | "flagged" | "rejected"> {
  let stageOn = false;
  try {
    stageOn = await isMediaModerationStageEnabled(sc);
    const decision = await decidePreDistribution({ stageOn, classifier, subject });
    if (decision.stage === "on") {
      logger.info({ path: subject.path, decision: summarizeDecision(decision) }, "postcard media: pre-distribution moderation");
    }
    return postMediaStatusFor(decision);
  } catch (err) {
    logger.warn({ err, path: subject.path }, "postcard media: pre-distribution moderation threw");
    return stageOn ? "flagged" : "approved";
  }
}

/**
 * A general video's frame has just been stored (POST /media/upload/poster).
 * With the stage on and a frame-capable classifier, the frame can now REJECT
 * or keep HOLDING the video — never approve it (FRAME_ALLOW_CLEARS_VIDEO) —
 * and a video-capable classifier already decided at ingestion. So this only
 * ever tightens: it applies `reject`, and nothing else. NEVER throws.
 */
export async function moderateVideoOnFrame(
  sc: unknown,
  subject: { bucket: string; path: string; framePath: string },
  classifier: MediaModerationClassifier = selectMediaModerationClassifier().adapter,
): Promise<{ state: "off" } | { state: "ran"; decision: PreDistributionDecision; recorded: CanonicalModerationOutcome | "not_applied" }> {
  try {
    if (!(await isMediaModerationStageEnabled(sc))) return { state: "off" };
    if (classifier.capabilities.video) return { state: "ran", decision: { stage: "off" }, recorded: "not_applied" };
    const decision = await decidePreDistribution({
      stageOn: true,
      classifier,
      subject: { mediaType: "video", bucket: subject.bucket, path: subject.path, framePath: subject.framePath },
    });
    if (decision.stage === "on" && decision.decision === "reject") {
      const recorded = await applyCanonicalModerationDecision(sc as any, { bucket: subject.bucket, path: subject.path, decision: "reject" });
      return { state: "ran", decision, recorded };
    }
    return { state: "ran", decision, recorded: "not_applied" };
  } catch (err) {
    logger.warn({ err, path: subject.path }, "video frame moderation threw — nothing applied");
    return { state: "off" };
  }
}
