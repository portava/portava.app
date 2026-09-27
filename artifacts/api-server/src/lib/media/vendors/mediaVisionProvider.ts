/**
 * mediaVisionProvider — the vision / visual-index seam (census-media §37:
 * MD63 evidence extraction, MD289 "looks social", MD293 "look like this").
 *
 * WHAT NONE OF THIS TIER CAN DO. No module here reads a pixel for meaning.
 * `lib/media/pHashUtils` hashes an image to collapse near-duplicates of ONE
 * place's uploads; it is not a scene model and not a cross-place index, and it
 * must not be stretched into either (MediaSearchService's header says so). A
 * scene signal ("this looks busy") and a visual index ("places that look like
 * this") both need a vision provider: a hosted model or an inference tier the
 * owner chooses, pays for, and clears for sending users' photographs to.
 *
 * WHAT THIS FILE IS. The adapter contract, the refusing default, and the one
 * function that turns a provider's answer into something the product may use:
 * `deriveVisualEvidenceCandidates` (MD63). Its output is a CANDIDATE, typed so
 * it cannot be anything else:
 *
 *   basis: "visual_inference", verified: false, eligibleAsObservation: false
 *
 * §9: PHOTO ≠ TRUTH, VISUAL INFERENCE ≠ VERIFIED FACT. A provider cannot mark a
 * signal verified — the field is a literal `false`, not something copied from
 * the answer — and nothing here writes `intel_observations` (MD65 keeps that
 * boundary as a recorded safety decision). A candidate narrows a search a
 * viewer asked for; it is never stored as a fact about a place.
 *
 * THE ANSWER IS NOT TRUSTED. `deriveVisualEvidenceCandidates` keeps a signal
 * only for a media id the caller ASKED about (a provider cannot inject a
 * result), only in the closed vocabulary below, and only with a confidence in
 * [0, 1]. `validateSimilarMedia` does the same for the index: known-shaped ids,
 * the seed excluded, duplicates dropped, bounded length. The search gate then
 * decides every id the index proposes again (MediaSearchService tail): the index
 * can PROPOSE media, never DISCLOSE it.
 *
 * CANDIDATE VENDORS — named with the capability each must have; not chosen
 * (that is the owner's decision, with its cost and data-protection review):
 *   sceneSignals  a hosted image-labelling / scene model that returns a crowd or
 *                 activity estimate per image with a confidence (e.g. Google
 *                 Cloud Vision label + object detection, AWS Rekognition
 *                 DetectLabels, Azure AI Vision image analysis), or a
 *                 self-hosted captioning / zero-shot model on an inference tier.
 *   similarMedia  an image-embedding model plus a vector index keyed by our
 *                 media ids (e.g. CLIP-family embeddings in pgvector, or a
 *                 hosted vector store), with deletion when the media is deleted.
 *   ingest        the same provider accepting a server-side reference (a
 *                 signed URL or the bytes) at upload time, so signals and the
 *                 index exist before anyone searches.
 * Env (by name only): MEDIA_VISION_PROVIDER selects the adapter; the adapter's
 * own credentials (e.g. GOOGLE_APPLICATION_CREDENTIALS, or AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_REGION, or a VECTOR_INDEX_URL / VECTOR_INDEX_KEY
 * pair) are the adapter's business and are read nowhere else.
 */
import {
  boundedConfidence,
  callVendor,
  refused,
  selectVendor,
  type VendorAnswer,
  type VendorSelection,
} from "./vendorCommon.js";

/** §38 "looks social": the crowd/activity vocabulary a scene signal may use. Closed. */
export const CROWD_LEVELS = ["empty", "quiet", "busy", "social"] as const;
export type CrowdLevel = (typeof CROWD_LEVELS)[number];

/**
 * OWNER DECISION, stated as a value rather than buried in a predicate (census-media
 * MD289: "what counts as 'looks social' is a classifier choice"). Which crowd
 * levels satisfy "looks social", and how sure the provider must be. Changing
 * either is a product decision, not a refactor.
 */
export const LOOKS_SOCIAL_LEVELS: readonly CrowdLevel[] = ["busy", "social"];
export const LOOKS_SOCIAL_MIN_CONFIDENCE = 0.6;

/** A media item as the vision seam sees it: the id the viewer sees, and the storage key the index was fed. */
export interface VisualMediaRef {
  /** The id a search result carries (a post id on today's projection). */
  mediaId: string;
  /** `bucket/path` — the key the provider indexed at ingestion. Null when the item has none. */
  storageKey: string | null;
}

export interface VisualSceneSignal {
  mediaId: string;
  kind: "crowd_level";
  value: CrowdLevel;
  confidence: number;
}

export interface VisualSimilarity {
  mediaId: string;
  /** Provider similarity in [0, 1]; higher is closer. Used only for ORDER. */
  score: number;
}

export interface VisionIngestSubject {
  assetId: string;
  mediaType: "image" | "video";
  bucket: string;
  path: string;
  /** A server-stored frame for a video (its poster), when one exists yet. */
  framePath: string | null;
}

export interface MediaVisionProvider {
  readonly name: string;
  readonly capabilities: {
    sceneSignals: boolean;
    similarMedia: boolean;
    ingest: boolean;
  };
  sceneSignals(input: { items: VisualMediaRef[] }): Promise<VendorAnswer<VisualSceneSignal[]>>;
  similarMedia(input: { seed: VisualMediaRef; limit: number }): Promise<VendorAnswer<VisualSimilarity[]>>;
  ingest(input: VisionIngestSubject): Promise<VendorAnswer<{ accepted: boolean }>>;
}

/** The default: answers every call with `not_configured`. It is the production adapter until the owner picks a vendor. */
export const REFUSING_VISION_PROVIDER: MediaVisionProvider = Object.freeze({
  name: "none",
  capabilities: Object.freeze({ sceneSignals: false, similarMedia: false, ingest: false }),
  async sceneSignals() { return refused<VisualSceneSignal[]>("not_configured", "no vision provider is configured"); },
  async similarMedia() { return refused<VisualSimilarity[]>("not_configured", "no visual index is configured"); },
  async ingest() { return refused<{ accepted: boolean }>("not_configured", "no vision provider is configured"); },
});

/** Adapters written so far. EMPTY: no vendor has been chosen. Add `name: () => adapter` once one is. */
export const IMPLEMENTED_VISION_PROVIDERS: Readonly<Record<string, () => MediaVisionProvider>> = Object.freeze({});

let _override: MediaVisionProvider | null = null;

/** Test seam. Pass null to restore env selection. */
export function _setMediaVisionProviderForTest(p: MediaVisionProvider | null): void {
  _override = p;
}

export function selectMediaVisionProvider(env: NodeJS.ProcessEnv = process.env): VendorSelection<MediaVisionProvider> {
  if (_override) return { adapter: _override, configured: _override.name, configuredButUnknown: false };
  return selectVendor(env.MEDIA_VISION_PROVIDER, IMPLEMENTED_VISION_PROVIDERS, REFUSING_VISION_PROVIDER);
}

export function getMediaVisionProvider(): MediaVisionProvider {
  return selectMediaVisionProvider().adapter;
}

// ── MD63 — the EVIDENCE EXTRACTION stage's output type ───────────────────────

/** What §9's EVIDENCE EXTRACTION stage may produce from pixels: a candidate, never a fact. */
export interface VisualEvidenceCandidate {
  mediaId: string;
  kind: "crowd_level";
  value: CrowdLevel;
  confidence: number;
  provider: string;
  basis: "visual_inference";
  /** VISUAL INFERENCE ≠ VERIFIED FACT. A literal, never read from the provider. */
  verified: false;
  /** MD65: media never writes an observation. A literal. */
  eligibleAsObservation: false;
}

/**
 * MD63: turn a provider's scene answer into evidence CANDIDATES.
 *
 * Kept: a signal about a media id in `askedFor`, of kind `crowd_level`, whose
 * value is in CROWD_LEVELS and whose confidence is a number in [0, 1]. At most
 * one candidate per media id — the most confident; a tie keeps the first.
 * Everything else is dropped, and the count of drops is returned so a caller
 * can log a provider that answers junk.
 */
export function deriveVisualEvidenceCandidates(
  provider: string,
  signals: unknown,
  askedFor: ReadonlySet<string>,
): { candidates: VisualEvidenceCandidate[]; dropped: number } {
  const best = new Map<string, VisualEvidenceCandidate>();
  let dropped = 0;
  const list = Array.isArray(signals) ? signals : [];
  if (!Array.isArray(signals)) dropped = 1;
  for (const raw of list) {
    const s = raw as Partial<VisualSceneSignal> | null;
    const mediaId = typeof s?.mediaId === "string" ? s.mediaId : null;
    const value = typeof s?.value === "string" && (CROWD_LEVELS as readonly string[]).includes(s.value) ? (s.value as CrowdLevel) : null;
    const confidence = boundedConfidence(s?.confidence);
    if (!mediaId || !askedFor.has(mediaId) || s?.kind !== "crowd_level" || value === null || confidence === null) {
      dropped++;
      continue;
    }
    const prev = best.get(mediaId);
    if (prev && prev.confidence >= confidence) continue;
    best.set(mediaId, {
      mediaId,
      kind: "crowd_level",
      value,
      confidence,
      provider,
      basis: "visual_inference",
      verified: false,
      eligibleAsObservation: false,
    });
  }
  return { candidates: [...best.values()], dropped };
}

/** MD289: does this candidate satisfy "looks social" under the owner's thresholds above? */
export function candidateLooksSocial(c: VisualEvidenceCandidate): boolean {
  return LOOKS_SOCIAL_LEVELS.includes(c.value) && c.confidence >= LOOKS_SOCIAL_MIN_CONFIDENCE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * MD293: the index's proposal, validated. Ids must be UUID-shaped (the id space
 * a search result uses), the seed is excluded, duplicates keep their best score,
 * the list is ordered by score and capped at `limit`. A malformed entry is
 * dropped, never repaired.
 */
export function validateSimilarMedia(
  answer: unknown,
  seedMediaId: string,
  limit: number,
): { ids: string[]; dropped: number } {
  const byId = new Map<string, number>();
  let dropped = 0;
  const list = Array.isArray(answer) ? answer : [];
  if (!Array.isArray(answer)) dropped = 1;
  for (const raw of list) {
    const r = raw as Partial<VisualSimilarity> | null;
    const id = typeof r?.mediaId === "string" && UUID_RE.test(r.mediaId) ? r.mediaId.toLowerCase() : null;
    const score = boundedConfidence(r?.score);
    if (!id || score === null || id === seedMediaId.toLowerCase()) {
      dropped++;
      continue;
    }
    const prev = byId.get(id);
    if (prev === undefined || score > prev) byId.set(id, score);
  }
  const ids = [...byId.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit))
    .map(([id]) => id);
  return { ids, dropped };
}

/** Ask for scene candidates over `items`. Refusals pass through unchanged; a valid answer becomes candidates. */
export async function sceneCandidatesFor(
  provider: MediaVisionProvider,
  items: VisualMediaRef[],
): Promise<VendorAnswer<{ candidates: VisualEvidenceCandidate[]; dropped: number }>> {
  if (items.length === 0) return { ok: true, value: { candidates: [], dropped: 0 } };
  if (!provider.capabilities.sceneSignals) {
    return provider.name === REFUSING_VISION_PROVIDER.name
      ? refused("not_configured", "no vision provider is configured")
      : refused("unsupported", `${provider.name} does not produce scene signals`);
  }
  const answer = await callVendor(() => provider.sceneSignals({ items }));
  if (!answer.ok) return answer;
  return { ok: true, value: deriveVisualEvidenceCandidates(provider.name, answer.value, new Set(items.map((i) => i.mediaId))) };
}

/** Ask the index for media that look like `seed`. The caller must already have gated `seed` for the viewer. */
export async function similarMediaFor(
  provider: MediaVisionProvider,
  seed: VisualMediaRef,
  limit: number,
): Promise<VendorAnswer<{ ids: string[]; dropped: number }>> {
  if (!provider.capabilities.similarMedia) {
    return provider.name === REFUSING_VISION_PROVIDER.name
      ? refused("not_configured", "no visual index is configured")
      : refused("unsupported", `${provider.name} has no visual index`);
  }
  const answer = await callVendor(() => provider.similarMedia({ seed, limit }));
  if (!answer.ok) return answer;
  return { ok: true, value: validateSimilarMedia(answer.value, seed.mediaId, limit) };
}
