/**
 * mediaModerationClassifier — the §36 SAFETY MODERATION stage's decider
 * (census-media §37: MD269 for every media file, MD283 for video).
 *
 * §36's pipeline puts safety moderation between processing and distribution.
 * This tree has the STATE MACHINE (MediaModerationService, MD274/MD351) and an
 * admin console that can move a file between states, and nothing that DECIDES:
 * the postcard transport writes `approved` unconditionally and a general upload
 * lands `processing`, which is distributable (census-media §9.2, §20.6). A
 * decider is either a classifier (a vendor) or a person (a staffed review).
 * This file is the seam for both:
 *
 *   • a CLASSIFIER adapter answers allow / restrict / block;
 *   • with the stage ON and NO classifier (the refusing default), every file is
 *     HELD for staffed review — `flag` — which is non-distributable in both
 *     vocabularies (post_media `flagged`, canonical `limited`) and reversible by
 *     the existing admin verb (POST /admin/media/:id/moderate approve).
 *
 * So flipping the stage on before a vendor exists is the OPERATOR path the
 * census names ("a staffed hold"), and it fails closed: nothing new distributes
 * until a moderator approves it. Flipping it on is an owner decision, because it
 * means every new upload waits for a person.
 *
 * THE DECISION TABLE (stage on) — `decidePreDistribution`:
 *
 *   classifier says            image            video
 *   ─────────────────────────  ───────────────  ─────────────────────────────
 *   block                      reject           reject
 *   restrict                   flag (hold)      flag (hold)
 *   allow (whole file)         approve          approve   (video-capable only)
 *   allow (ONE FRAME only)     —                flag (hold): one frame cannot
 *                                               clear a clip (FRAME_ALLOW_CLEARS_VIDEO)
 *   refused / error / timeout  flag (hold)      flag (hold)
 *   malformed answer           flag (hold)      flag (hold)
 *
 * With the stage OFF the function answers `{ stage: "off" }` and every caller
 * writes exactly what it wrote before this file existed.
 *
 * CANDIDATE VENDORS — named with the capability each must have; not chosen:
 *   image           a hosted image-safety classifier returning per-category
 *                   likelihoods (e.g. Google Cloud Vision SafeSearch, AWS
 *                   Rekognition DetectModerationLabels, Azure AI Content Safety,
 *                   Hive, Sightengine).
 *   video           the same vendors' ASYNC video moderation (Rekognition
 *                   StartContentModeration, Google Video Intelligence explicit
 *                   content, Hive / Sightengine video) — an async job, so the
 *                   adapter polls or receives a callback; the hold covers the gap.
 *   videoFrame      any image classifier over the server-stored poster frame
 *                   (routes/mediaVideoPoster.ts). Can REJECT or HOLD a video; by
 *                   the table above it cannot APPROVE one.
 * Env (by name only): MEDIA_MODERATION_CLASSIFIER selects the adapter; its
 * credentials (e.g. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION,
 * GOOGLE_APPLICATION_CREDENTIALS, AZURE_CONTENT_SAFETY_ENDPOINT /
 * AZURE_CONTENT_SAFETY_KEY) are the adapter's business.
 */
import type { MediaModerationDecision } from "../../../services/media/MediaModerationService.js";
import {
  boundedConfidence,
  callVendor,
  refused,
  selectVendor,
  type VendorAnswer,
  type VendorRefusal,
  type VendorSelection,
} from "./vendorCommon.js";

export type ClassifierVerdict = "allow" | "restrict" | "block";

export interface ModerationSubject {
  mediaType: "image" | "video";
  bucket: string;
  path: string;
  /** For a video: its server-stored poster frame, when one exists yet. */
  framePath: string | null;
}

export interface ClassifierAnswer {
  verdict: ClassifierVerdict;
  /** Vendor category labels, for the audit trail only; never shown to users. */
  labels: string[];
  confidence: number;
}

export interface MediaModerationClassifier {
  readonly name: string;
  readonly capabilities: {
    image: boolean;
    /** Classifies the whole clip (an async video job behind the adapter). */
    video: boolean;
    /** Classifies a single still frame of a video. */
    videoFrame: boolean;
  };
  /** `target` says which object the adapter must read: the file itself, or a video's frame. */
  classify(input: { subject: ModerationSubject; target: "file" | "frame" }): Promise<VendorAnswer<ClassifierAnswer>>;
}

export const REFUSING_MODERATION_CLASSIFIER: MediaModerationClassifier = Object.freeze({
  name: "none",
  capabilities: Object.freeze({ image: false, video: false, videoFrame: false }),
  async classify() { return refused<ClassifierAnswer>("not_configured", "no moderation classifier is configured"); },
});

/** Adapters written so far. EMPTY: no vendor has been chosen. */
export const IMPLEMENTED_MODERATION_CLASSIFIERS: Readonly<Record<string, () => MediaModerationClassifier>> = Object.freeze({});

/**
 * OWNER DECISION, stated as a value. May a single frame's "allow" clear a whole
 * video? No: a poster is one instant of a clip that can be minutes long. A
 * frame can reject or hold a video; approving one takes a video-capable
 * classifier or a person.
 */
export const FRAME_ALLOW_CLEARS_VIDEO = false;

let _override: MediaModerationClassifier | null = null;

export function _setMediaModerationClassifierForTest(c: MediaModerationClassifier | null): void {
  _override = c;
}

export function selectMediaModerationClassifier(env: NodeJS.ProcessEnv = process.env): VendorSelection<MediaModerationClassifier> {
  if (_override) return { adapter: _override, configured: _override.name, configuredButUnknown: false };
  return selectVendor(env.MEDIA_MODERATION_CLASSIFIER, IMPLEMENTED_MODERATION_CLASSIFIERS, REFUSING_MODERATION_CLASSIFIER);
}

export type PreDistributionBasis =
  /** The classifier read the whole file. */
  | "classifier"
  /** The classifier read only a video's frame. */
  | "classifier_frame"
  /** No classifier: held for staffed review. */
  | "hold_no_classifier"
  /** The classifier cannot read this kind of file (or a video has no frame yet): held. */
  | "hold_unsupported"
  /** The classifier refused, threw, timed out or answered junk: held. */
  | "hold_classifier_failed"
  /** A frame said "allow"; one frame does not clear a video: held. */
  | "hold_frame_only";

export type PreDistributionDecision =
  | { stage: "off" }
  | {
      stage: "on";
      decision: Extract<MediaModerationDecision, "approve" | "flag" | "reject">;
      basis: PreDistributionBasis;
      classifier: string;
      labels: string[];
      refusal: VendorRefusal | null;
    };

function validAnswer(a: ClassifierAnswer | null | undefined): ClassifierAnswer | null {
  if (!a || typeof a !== "object") return null;
  if (a.verdict !== "allow" && a.verdict !== "restrict" && a.verdict !== "block") return null;
  const confidence = boundedConfidence(a.confidence);
  if (confidence === null) return null;
  const labels = Array.isArray(a.labels) ? a.labels.filter((l): l is string => typeof l === "string").slice(0, 20) : [];
  return { verdict: a.verdict, labels, confidence };
}

/**
 * The §36 safety-moderation decision for one file. NEVER throws. With the
 * stage off it decides nothing; with it on, every path that is not a valid
 * classifier verdict ends in `flag` (held).
 */
export async function decidePreDistribution(input: {
  stageOn: boolean;
  classifier: MediaModerationClassifier;
  subject: ModerationSubject;
}): Promise<PreDistributionDecision> {
  if (!input.stageOn) return { stage: "off" };
  const c = input.classifier;
  const hold = (basis: PreDistributionBasis, refusal: VendorRefusal | null = null): PreDistributionDecision =>
    ({ stage: "on", decision: "flag", basis, classifier: c.name, labels: [], refusal });

  if (c.name === REFUSING_MODERATION_CLASSIFIER.name) return hold("hold_no_classifier", "not_configured");

  const { subject } = input;
  let target: "file" | "frame";
  if (subject.mediaType === "image") {
    if (!c.capabilities.image) return hold("hold_unsupported", "unsupported");
    target = "file";
  } else if (c.capabilities.video) {
    target = "file";
  } else if (c.capabilities.videoFrame && subject.framePath) {
    target = "frame";
  } else {
    return hold("hold_unsupported", "unsupported");
  }

  const answer = await callVendor(() => c.classify({ subject, target }));
  if (!answer.ok) return hold("hold_classifier_failed", answer.reason);
  const v = validAnswer(answer.value);
  if (!v) return hold("hold_classifier_failed", "invalid_answer");

  const basis: PreDistributionBasis = target === "frame" ? "classifier_frame" : "classifier";
  if (v.verdict === "block") return { stage: "on", decision: "reject", basis, classifier: c.name, labels: v.labels, refusal: null };
  if (v.verdict === "restrict") return { stage: "on", decision: "flag", basis, classifier: c.name, labels: v.labels, refusal: null };
  if (target === "frame" && !FRAME_ALLOW_CLEARS_VIDEO) {
    return { stage: "on", decision: "flag", basis: "hold_frame_only", classifier: c.name, labels: v.labels, refusal: null };
  }
  return { stage: "on", decision: "approve", basis, classifier: c.name, labels: v.labels, refusal: null };
}

/**
 * The value a postcard `post_media` row is written with at `/complete`. Stage
 * off: `approved`, exactly what the route wrote before this seam. Stage on:
 * the legacy vocabulary `post_media_moderation_status_check` admits
 * (approve → approved, flag → flagged, reject → rejected). `flagged` and
 * `rejected` are refused by every post_media distribution reader
 * (lib/mediaEligibility NON_DISTRIBUTABLE_MEDIA_MODERATION_STATES; routes/posts
 * filterPostMedia) — which is why a hold is `flagged` and never `pending`:
 * `pending` on a READY row passes those readers.
 */
export function postMediaStatusFor(d: PreDistributionDecision): "approved" | "flagged" | "rejected" {
  if (d.stage === "off") return "approved";
  if (d.decision === "approve") return "approved";
  if (d.decision === "reject") return "rejected";
  return "flagged";
}
