import { z } from "zod";
import type { VisualEvidenceCandidate } from "./mediaVisionProvider.js";

export const IMAGE_UNDERSTANDING_PROVIDER = "self_hosted_siglip";
export const IMAGE_UNDERSTANDING_MODEL = "google/siglip-base-patch16-224";
export const IMAGE_UNDERSTANDING_REVISION = "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed";
export const IMAGE_UNDERSTANDING_TAXONOMY = "travel-scene-v1";
export const IMAGE_UNDERSTANDING_TIMEOUT_MS = 90_000;
export const IMAGE_UNDERSTANDING_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_UNDERSTANDING_MAX_PIXELS = 16_000_000;
export const IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const identifier = z.string().uuid();
export const IMAGE_UNDERSTANDING_TRAVEL_CATEGORIES = {
  beach: "scene", ocean: "scene", mountain: "scene", architecture: "scene", food: "object", sunset: "scene",
  forest: "scene", snow: "scene", desert: "scene", waterfall: "scene", lake: "scene", garden: "scene", boat: "object", market: "scene",
} as const;
const travelCandidateSchema = z.object({
  tag: z.enum(["beach", "ocean", "mountain", "architecture", "food", "sunset", "forest", "snow", "desert", "waterfall", "lake", "garden", "boat", "market"]),
  category: z.enum(["scene", "object"]), confidence: z.number().finite().min(0.5).max(1),
  basis: z.literal("visual_inference"), verified: z.literal(false), eligibleAsObservation: z.literal(false),
}).strict().refine(value => IMAGE_UNDERSTANDING_TRAVEL_CATEGORIES[value.tag] === value.category);
export const imageUnderstandingSourceSchema = z.object({
  assetId: identifier,
  sourceVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ownerId: identifier,
  postId: identifier,
  postMediaId: identifier,
  bucket: z.literal("post-media"),
  path: z.string().min(1).max(1024),
  mediaType: z.enum(["image", "video"]),
  framePath: z.string().max(1040).nullable(),
}).strict();
export type ImageUnderstandingSource = z.infer<typeof imageUnderstandingSourceSchema>;

export const imageUnderstandingRecognitionSchema = z.object({
  modelId: z.literal(IMAGE_UNDERSTANDING_MODEL),
  modelRevision: z.literal(IMAGE_UNDERSTANDING_REVISION),
  taxonomyVersion: z.literal(IMAGE_UNDERSTANDING_TAXONOMY),
  crowdLevel: z.enum(["empty", "quiet", "busy", "social"]).nullable(),
  confidence: z.number().finite().min(0).max(1),
  confidenceKind: z.literal("uncalibrated_similarity"),
  inferenceMs: z.number().finite().nonnegative().max(IMAGE_UNDERSTANDING_TIMEOUT_MS),
  travelCandidates: z.array(travelCandidateSchema).max(6).refine(values => new Set(values.map(value => value.tag)).size === values.length),
}).strict();
export type ImageUnderstandingRecognition = z.infer<typeof imageUnderstandingRecognitionSchema>;

export type ImageUnderstandingJob = {
  kind: "image_understanding";
  key: string;
  source: ImageUnderstandingSource;
  modelId: typeof IMAGE_UNDERSTANDING_MODEL;
  modelRevision: typeof IMAGE_UNDERSTANDING_REVISION;
  taxonomyVersion: typeof IMAGE_UNDERSTANDING_TAXONOMY;
  consentVersion: string;
};

export const imageUnderstandingJobSchema = z.object({
  kind: z.literal("image_understanding"), key: z.string().max(400), source: imageUnderstandingSourceSchema,
  modelId: z.literal(IMAGE_UNDERSTANDING_MODEL), modelRevision: z.literal(IMAGE_UNDERSTANDING_REVISION),
  taxonomyVersion: z.literal(IMAGE_UNDERSTANDING_TAXONOMY), consentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
}).strict();

export type ImageUnderstandingResult = {
  consentVersion: string;
  source: ImageUnderstandingSource;
  recognition: ImageUnderstandingRecognition;
  candidates: VisualEvidenceCandidate[];
  pixelScope: "image" | "stored_poster";
  processedAt: string;
  pixelSha256: string;
  metrics: { inputBytes: number; normalizedBytes: number; elapsedMs: number; estimatedExternalCostUsd: 0 };
};

export const imageUnderstandingResultSchema = z.object({
  consentVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), source: imageUnderstandingSourceSchema,
  recognition: imageUnderstandingRecognitionSchema,
  candidates: z.array(z.object({ mediaId: identifier, kind: z.literal("crowd_level"), value: z.enum(["empty", "quiet", "busy", "social"]), confidence: z.number().finite().min(0).max(1), provider: z.literal(IMAGE_UNDERSTANDING_PROVIDER), basis: z.literal("visual_inference"), verified: z.literal(false), eligibleAsObservation: z.literal(false) }).strict()).max(1),
  pixelScope: z.enum(["image", "stored_poster"]), processedAt: z.string().datetime(), pixelSha256: z.string().regex(/^[a-f0-9]{64}$/),
  metrics: z.object({ inputBytes: z.number().int().positive().max(IMAGE_UNDERSTANDING_MAX_BYTES), normalizedBytes: z.number().int().positive().max(IMAGE_UNDERSTANDING_MAX_OUTPUT_BYTES), elapsedMs: z.number().nonnegative().max(IMAGE_UNDERSTANDING_TIMEOUT_MS), estimatedExternalCostUsd: z.literal(0) }).strict(),
}).strict();

export function sameImageUnderstandingSource(first: ImageUnderstandingSource, second: unknown): boolean {
  const parsed = imageUnderstandingSourceSchema.safeParse(second);
  return parsed.success && (Object.keys(first) as Array<keyof ImageUnderstandingSource>).every(key => first[key] === parsed.data[key]);
}

export type ImageUnderstandingConsent = (input: {
  scope: "media_image_understanding";
  source: ImageUnderstandingSource;
  policyVersion: string;
  signal: AbortSignal;
}) => Promise<boolean>;

export interface ImageUnderstandingJobs {
  enqueue(job: ImageUnderstandingJob): Promise<{ key: string; state: "queued" | "exists" }>;
  read(key: string): Promise<ImageUnderstandingResult | null>;
}

export type ImageUnderstandingContext = {
  sc: any;
  env?: NodeJS.ProcessEnv;
  consentStillGranted?: ImageUnderstandingConsent;
  jobs?: ImageUnderstandingJobs;
};

export async function withImageUnderstandingSignal<Result>(operation: () => Promise<Result>, signal: AbortSignal): Promise<Result> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error("vision_operation_cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(operation).then(
      result => { signal.removeEventListener("abort", cancel); resolve(result); },
      error => { signal.removeEventListener("abort", cancel); reject(error); },
    );
  });
}

export function imageUnderstandingJob(source: ImageUnderstandingSource, consentVersion: string): ImageUnderstandingJob {
  return {
    kind: "image_understanding",
    key: ["vision", source.assetId, source.sourceVersion, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY, consentVersion, source.postMediaId].join(":"),
    source: { ...source }, modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION,
    taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY, consentVersion,
  };
}

export function imageUnderstandingPolicy(env: NodeJS.ProcessEnv, ownerId: string): string | null {
  if (env.MEDIA_IMAGE_UNDERSTANDING_ENABLED !== "true" || env.MEDIA_IMAGE_UNDERSTANDING_PROVIDER !== IMAGE_UNDERSTANDING_PROVIDER) return null;
  const allowed = (env.MEDIA_IMAGE_UNDERSTANDING_ALLOWED_OWNER_IDS ?? "").split(",").map(value => value.trim());
  const policy = env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY ?? "";
  return allowed.includes(ownerId) && /^[A-Za-z0-9._-]{1,80}$/.test(policy) ? policy : null;
}
