import { createHash } from "node:crypto";

export const VISUAL_DIMENSIONS = 512;
export const VISUAL_MODEL_REPO = "openai/clip-vit-base-patch32";
export const VISUAL_MODEL_REVISION = "d44250afa9f05af7eca021052567539406661018";
export const VISUAL_MODEL_ID = `${VISUAL_MODEL_REPO}@${VISUAL_MODEL_REVISION}:clip-rgb224-v1`;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_INDEX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const TEXT_QUERY_TTL_MS = 5 * 60 * 1000;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface SourceIdentity {
  assetId: string;
  sourceVersion: number;
  bucket: string;
  path: string;
}

export interface VisualSource extends SourceIdentity {
  ownerId: string;
  mediaType: "image";
  publicUrl: string;
  visibility: string;
  sizeBytes: number;
}

export interface IndexedImage {
  source: SourceIdentity;
  modelId: string;
  vector: number[];
  contentSha256: string;
  expiresAtMs: number;
  consentRevision: string;
  publication?: { jobId: string; leaseToken: string };
}

export interface VisualIndexStore {
  commit(entry: IndexedImage, lease: { jobId: string; leaseToken: string }): Promise<void>;
  seed(postId: string, modelId: string): Promise<IndexedImage[]>;
  nearest(vector: number[], modelId: string, limit: number): Promise<Array<{ entry: IndexedImage; score: number }>>;
  current(entries: IndexedImage[]): Promise<boolean[]>;
  erase(source: SourceIdentity): Promise<void>;
  discard(source: SourceIdentity, lease: { jobId: string; leaseToken: string }): Promise<void>;
}

export interface ConsentGrant {
  allowed: true;
  expiresAtMs: number;
  revision: string;
}

export interface ImageIndexJob {
  kind: "media_visual_image";
  key: string;
  modelId: string;
  source: SourceIdentity;
  consentRevision: string;
  expiresAtMs: number;
}

export interface TextIndexJob {
  kind: "media_visual_text";
  key: string;
  modelId: string;
  viewerId: string;
  language: "en";
  text: string;
  expiresAtMs: number;
}

export type VisualIndexJob = ImageIndexJob | TextIndexJob;

export interface VisualJobContext {
  jobId: string;
  leaseToken: string;
  signal: AbortSignal;
  assertLease(): Promise<void>;
}

export interface ClipEncoder {
  readonly modelId: string;
  image(bytes: Buffer, signal: AbortSignal): Promise<number[]>;
  text(text: string, signal: AbortSignal): Promise<number[]>;
}

export function validSource(value: unknown): value is SourceIdentity {
  const source = value as SourceIdentity | null;
  return Boolean(source && UUID.test(source.assetId) && Number.isSafeInteger(source.sourceVersion) && source.sourceVersion > 0 &&
    source.bucket === "post-media" && typeof source.path === "string" && source.path.length > 0 && source.path.length <= 1024 &&
    !source.path.startsWith("/") && !source.path.includes("\\") && !/[\x00-\x1f]/.test(source.path) &&
    !source.path.split("/").some((part) => part === "." || part === ".." || part === ""));
}

export function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.assetId === right.assetId && left.sourceVersion === right.sourceVersion && left.bucket === right.bucket && left.path === right.path;
}

export function generationKey(source: SourceIdentity, modelId = VISUAL_MODEL_ID): string {
  if (!validSource(source)) throw new Error("invalid source identity");
  return createHash("sha256").update(JSON.stringify([source.assetId, source.sourceVersion, source.bucket, source.path, modelId])).digest("hex");
}

export function textQueryKey(viewerId: string, text: string, language: string, modelId = VISUAL_MODEL_ID): string {
  if (!UUID.test(viewerId) || language !== "en" || typeof text !== "string" || !text.trim() || text.length > 512 || /[\x00-\x1f]/.test(text)) {
    throw new Error("unsupported visual text query");
  }
  return createHash("sha256").update(JSON.stringify([viewerId, language, text, modelId])).digest("hex");
}

export function normalizeVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== VISUAL_DIMENSIONS || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("invalid visual vector");
  }
  const norm = Math.hypot(...value);
  if (!Number.isFinite(norm) || norm < 1e-12) throw new Error("invalid visual vector norm");
  return value.map((item) => item / norm);
}
