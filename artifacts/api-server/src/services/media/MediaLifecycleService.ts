/**
 * MediaLifecycleService — durable processing attempts and owner-authorized
 * deletion for `media_assets`.
 *
 * SCHEMA: migrations 2951 (attempt counters, retry clock, lease columns and
 * `media_processing_attempts`), 2952 (`deleted_at` / `purge_status` and
 * `media_asset_lifecycle_events`) and 2953 (retention timestamps). All three are
 * already applied to production and CI; 2955 revokes the client write grants on
 * the three tables, so every write below is a service-role write by design.
 *
 * TWO INVARIANTS RUN THROUGH THE WHOLE FILE:
 *
 *   1. EVERY state transition is a CONDITIONAL update that re-asserts what the
 *      caller believed — the asset id AND the lease token it holds (or, for the
 *      claim, the attempt count it read). PostgREST answers an UPDATE matching
 *      ZERO rows with `error: null`, so "no error" is not proof of a write. Each
 *      one therefore `.select()`s the row back and checks it, which is what makes
 *      a lost race observable instead of silently successful.
 *   2. Storage purge is NOT part of the authorization transition. Soft delete
 *      commits the row state and the audit event synchronously; the bytes are
 *      retained until explicit admin permanent-deletion authority. The existing
 *      cleanup worker handles authorized purges and records failures for retry.
 *      An unconfirmed purge never reactivates the withdrawn asset.
 *
 * `moderation_status='owner_deleted'` and `processing_status IN
 * ('queued','removed')` are all inside the CHECK vocabularies migration 2250
 * (re-asserted by 2470) and 0191 lay down.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { boundedMediaQueueOperation } from "../../lib/media/jobs/queue.js";
import { purgeDerivedMedia, type DerivativeErasureSource } from "./DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "./MediaCleanupTransport.js";
import { validAssetId, validVersion } from "../../lib/media/adaptive/types.js";
import { captionArtifactPath, MAX_CAPTION_ARTIFACT_BYTES, rebaseCaptionArtifact, requirePrivateCaptionStorage, uploadCaptionArtifact, validateCaptionArtifact, type CaptionAsset } from "./AuthoredCaptionsService.js";
import { appStorageUrlInfo, configuredStorageOrigin } from "../../lib/mediaUrl.js";
import { memoryRecoveryStorageRef, reviewUnboundMemoryReferences } from "../memory/memoryMediaBinding.js";
import { logger } from "../../lib/logger.js"; import { isFlagEnabled } from "../../lib/featureFlags.js";

/** The subset of the request logger this service needs. */
export interface LifecycleLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export const DEFAULT_PROCESSING_MAX_ATTEMPTS = 5;
export const DEFAULT_PROCESSING_LEASE_MS = 5 * 60_000;
export const DEFAULT_RETRY_BASE_MS = 30_000;

export interface ProcessingClaim {
  assetId: string;
  attemptNumber: number;
  leaseToken: string;
  leaseUntil: string;
}

export interface ProcessingResult {
  ok: boolean;
  terminal: boolean;
  attemptNumber: number;
  nextRetryAt: string | null;
}

export interface SoftDeleteResult {
  ok: boolean;
  alreadyDeleted: boolean;
  purgeScheduled: boolean;
  /** Legacy response shape; retained soft deletion never starts this promise. */
  purge?: Promise<void>;
}

export interface RetainedOriginalReceipt {
  id: string;
  generation: string;
  bucket: string;
  sourcePath: string;
  retainedPath: string;
  objectId: string;
  objectVersion: string;
  sha256: string;
  size: number;
}

type RetentionOptions = { signal?: AbortSignal; timeoutMs?: number; operationTimeoutMs?: number };
interface RetentionObjectIdentity { id: string; version: string; size: number }

async function retainedObjectIdentity(sc: SupabaseClient, bucket: string, path: string, size: number | undefined,
  allowAbsent = false,
): Promise<RetentionObjectIdentity | null> {
  const { data, error } = await sc.storage.from(bucket).info(path);
  // Only the provider's object-missing code proves absence. Bucket failures,
  // authorization errors, proxy 404s and outages are not safe write preconditions.
  if (allowAbsent && !data && error?.status === 404 && error.statusCode === "NoSuchKey") return null;
  if (error || !data || !validAssetId(data.id) || data.bucketId !== bucket || data.name !== path
    || typeof data.version !== "string" || !data.version.trim() || data.version.length > 200
    || typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0 || size !== undefined && data.size !== size) throw new Error("Retained object identity unavailable");
  return { id: data.id, version: data.version, size: data.size };
}

async function measureRetainedObject(sc: SupabaseClient, bucket: string, path: string, expectedSize: number,
  signal: AbortSignal, operationTimeoutMs = 5000, expected?: { id: string; version: string },
  onChunk?: (chunk: Uint8Array) => void,
): Promise<RetentionObjectIdentity & { sha256: string }> {
  const original = await retainedObjectIdentity(sc, bucket, path, expectedSize);
  if (!original || expected && (original.id !== expected.id || original.version !== expected.version)) throw new Error("Retained original changed during verification");
  const download = await sc.storage.from(bucket).download(path).asStream();
  if (download.error || !download.data) throw new Error("Retained original bytes unavailable");
  const reader = download.data.getReader(), hash = createHash("sha256");
  let size = 0;
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await boundedMediaQueueOperation(() => reader.read(), signal, operationTimeoutMs);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw new Error("Invalid retained object stream");
      size += part.value.byteLength;
      if (size > original.size) throw new Error("Retained original size changed");
      hash.update(part.value);
      onChunk?.(part.value);
    }
    if (size !== original.size) throw new Error("Retained original size changed");
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const after = await retainedObjectIdentity(sc, bucket, path, expectedSize);
  if (!after || after.id !== original.id || after.version !== original.version) throw new Error("Retained original changed during verification");
  return { ...original, sha256: hash.digest("hex") };
}

/** Measure the retained original before reserving any transfer. This step does
 * not copy/remove bytes or claim recovery is complete. Its durable receipt is
 * the identity used to reconcile later Storage operations, including timeouts.
 * Stream the bytes instead of buffering a whole video, and refuse a changing
 * object or unknown private-bucket state before writing the reservation. */
export async function prepareRetainedMediaOriginal(client: SupabaseClient, assetId: string, generation: string,
  options: RetentionOptions = {},
): Promise<RetainedOriginalReceipt> {
  if (!validAssetId(assetId) || !validAssetId(generation)) throw new Error("Invalid retention identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const read = await sc.from("media_assets")
      .select("id,storage_bucket,storage_path,size_bytes,deleted_at,purge_status,recovery_generation,recovery_snapshot")
      .eq("id", assetId).maybeSingle();
    const asset = read.data;
    if (read.error || !asset || asset.id !== assetId || asset.recovery_generation !== generation
      || asset.deleted_at === null || asset.purge_status !== "retained" || !asset.recovery_snapshot
      || typeof asset.storage_bucket !== "string" || !asset.storage_bucket || typeof asset.storage_path !== "string" || !asset.storage_path
      || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0) throw new Error("Retained source unavailable");
    const bucketName = asset.storage_bucket, sourcePath = asset.storage_path, expectedSize = Number(asset.size_bytes);
    const bucket = await sc.storage.getBucket(bucketName);
    if (bucket.error || bucket.data?.id !== bucketName || bucket.data.public !== false) throw new Error("Private retention bucket unavailable");
    const original = await measureRetainedObject(sc, bucketName, sourcePath, expectedSize, signal, options.operationTimeoutMs);
    const { sha256, size } = original;
    const prepared = await sc.rpc("prepare_media_original_retention", { p_asset: assetId, p_generation: generation,
      p_object_id: original.id, p_object_version: original.version, p_sha256: sha256, p_size: size });
    const receipt = prepared.data?.receipt;
    if (prepared.error || prepared.data?.ok !== true || !receipt || !validAssetId(receipt.id)
      || receipt.generation !== generation || receipt.bucket !== asset.storage_bucket || receipt.sourcePath !== asset.storage_path
      || receipt.retainedPath !== `_retained/${assetId}/${generation}/original`
      || receipt.objectId !== original.id || receipt.objectVersion !== original.version || receipt.sha256 !== sha256 || receipt.size !== size) {
      throw new Error("Retention preparation unconfirmed");
    }
    return receipt as RetainedOriginalReceipt;
  }, options);
}

export interface RetainedOriginalCopy {
  id: string;
  preparationId: string;
  generation: string;
  token: string;
  objectId: string;
  objectVersion: string;
  sha256: string;
  size: number;
}

async function readRetainedOriginalPreparation(sc: SupabaseClient, assetId: string, generation: string): Promise<RetainedOriginalReceipt> {
  const ready = await sc.rpc("postcard_canonical_lifecycle_ready");
  if (ready.error || ready.data !== true) throw new Error("Retention storage protections unavailable");
  const prepared = await sc.from("media_asset_lifecycle_events").select("id,details")
    .eq("media_asset_id", assetId).eq("event_type", "retention_original_prepared").eq("details->>generation", generation).maybeSingle();
  const detail = prepared.data?.details;
  if (prepared.error || !prepared.data || !validAssetId(prepared.data.id) || !detail || detail.generation !== generation
    || typeof detail.bucket !== "string" || !detail.bucket || typeof detail.sourcePath !== "string" || !detail.sourcePath
    || detail.retainedPath !== `_retained/${assetId}/${generation}/original` || !validAssetId(detail.objectId)
    || typeof detail.objectVersion !== "string" || !detail.objectVersion.trim()
    || !Number.isSafeInteger(detail.size) || detail.size <= 0 || detail.size > 5_000_000_000
    || typeof detail.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(detail.sha256)) throw new Error("Retention preparation unavailable");
  const receipt = { ...detail, id: prepared.data.id } as RetainedOriginalReceipt;
  const bucket = await sc.storage.getBucket(receipt.bucket);
  if (bucket.error || bucket.data?.id !== receipt.bucket || bucket.data.public !== false) throw new Error("Private retention bucket unavailable");
  return receipt;
}

interface MediaCopySource {
  bucket: string; sourcePath: string; destinationPath: string;
  objectId: string; objectVersion: string; sha256: string; size: number;
}

/** One transfer engine for original retention, fresh-key copies and encoded
 * caption uploads. Uncertain Storage writes never retry. */
async function copyReservedMediaObject(sc: SupabaseClient, assetId: string, source: MediaCopySource,
  authority: { eventType: string; identityKey: "generation" | "reservationId"; identityValue: string; objectPath?: string;
    claim: (token: string, newDispatch: boolean) => PromiseLike<{ data: any; error: unknown }>;
    write?: { prepare: () => Promise<Uint8Array>; dispatch: (bytes: Uint8Array) => PromiseLike<unknown> } },
  signal: AbortSignal, options: RetentionOptions,
): Promise<{ copied: RetentionObjectIdentity & { sha256: string }; token: string }> {
  let query = sc.from("media_asset_lifecycle_events").select("id")
    .eq("media_asset_id", assetId).eq("event_type", authority.eventType).eq(`details->>${authority.identityKey}`, authority.identityValue);
  if (authority.objectPath !== undefined) query = query.eq("details->>sourcePath", authority.objectPath);
  const started = await query.maybeSingle();
  if (started.error) throw new Error("Retention copy state unavailable");
  const destination = await retainedObjectIdentity(sc, source.bucket, source.destinationPath, source.size, true);
  if (destination && !started.data) throw new Error("Retention destination already occupied");
  if (!destination && started.data) throw new Error("Retention copy outcome unknown; reconciliation required");
  let bytes: Uint8Array | undefined;
  if (!started.data && authority.write) {
    bytes = await authority.write.prepare();
    if (bytes.byteLength !== source.size || createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error("Restoration encoded bytes changed");
  } else if (!started.data) {
    const current = await measureRetainedObject(sc, source.bucket, source.sourcePath, source.size, signal, options.operationTimeoutMs,
      { id: source.objectId, version: source.objectVersion });
    if (current.sha256 !== source.sha256) throw new Error("Retained original hash changed");
  }
  const token = randomUUID();
  const claim = await authority.claim(token, !started.data);
  if (claim.error || claim.data?.ok !== true || typeof claim.data.execute !== "boolean" || !validAssetId(claim.data.token)
    || claim.data.execute && (claim.data.token !== token || !!started.data)) throw new Error("Retention copy authority unconfirmed");
  if (claim.data.execute) {
    signal.throwIfAborted();
    try {
      if (authority.write) await authority.write.dispatch(bytes!);
      else await sc.storage.from(source.bucket).copy(source.sourcePath, source.destinationPath);
    }
    catch { signal.throwIfAborted(); }
  }
  const copied = await measureRetainedObject(sc, source.bucket, source.destinationPath, source.size, signal, options.operationTimeoutMs);
  if (copied.id === source.objectId || copied.sha256 !== source.sha256) throw new Error("Retained copy integrity mismatch");
  return { copied, token: claim.data.token as string };
}

/** Copy once, then reconcile the reserved destination. An uncertain dispatch is
 * never retried merely because the destination is still absent. The original
 * remains intact until a separately verified removal phase owns that action. */
export async function copyRetainedMediaOriginal(client: SupabaseClient, assetId: string, generation: string,
  options: RetentionOptions = {},
): Promise<RetainedOriginalCopy> {
  if (!validAssetId(assetId) || !validAssetId(generation)) throw new Error("Invalid retention identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const receipt = await readRetainedOriginalPreparation(sc, assetId, generation);
    const { copied, token } = await copyReservedMediaObject(sc, assetId, { ...receipt, destinationPath: receipt.retainedPath }, {
      eventType: "retention_original_copy_started", identityKey: "generation", identityValue: generation,
      claim: async token => sc.rpc("advance_media_original_retention", { p_asset: assetId, p_generation: generation,
        p_preparation: receipt.id, p_phase: "copy_started", p_token: token }),
    }, signal, options);
    const committed = await sc.rpc("advance_media_original_retention", { p_asset: assetId, p_generation: generation,
      p_preparation: receipt.id, p_phase: "copied", p_token: token, p_object_id: copied.id,
      p_object_version: copied.version, p_sha256: copied.sha256, p_size: copied.size });
    const result = committed.data?.receipt;
    if (committed.error || committed.data?.ok !== true || !result || !validAssetId(result.id)
      || result.preparationId !== receipt.id || result.generation !== generation || result.token !== token
      || result.objectId !== copied.id || result.objectVersion !== copied.version || result.sha256 !== receipt.sha256 || result.size !== receipt.size) {
      throw new Error("Retention copy receipt unconfirmed");
    }
    return result as RetainedOriginalCopy;
  }, options);
}

async function readRetainedOriginalCopy(sc: SupabaseClient, assetId: string, generation: string,
  prepared: RetainedOriginalReceipt,
): Promise<RetainedOriginalCopy> {
  const read = await sc.from("media_asset_lifecycle_events").select("id,details")
    .eq("media_asset_id", assetId).eq("event_type", "retention_original_copied").eq("details->>generation", generation).maybeSingle();
  const copy = read.data?.details;
  if (read.error || !read.data || !validAssetId(read.data.id) || !copy || copy.preparationId !== prepared.id
    || copy.generation !== generation || !validAssetId(copy.token) || !validAssetId(copy.objectId) || copy.objectId === prepared.objectId
    || typeof copy.objectVersion !== "string" || !copy.objectVersion.trim() || copy.objectVersion.length > 200
    || copy.sha256 !== prepared.sha256 || copy.size !== prepared.size) throw new Error("Verified retention copy unavailable");
  return { ...copy, id: read.data.id } as RetainedOriginalCopy;
}

export interface RetainedOriginalRemoval extends RetainedOriginalCopy {
  copyId: string;
  sourceAbsent: true;
}

/** Remove the original once, only after verifying its durable private copy.
 * A missing response never releases the dispatch claim. Reconciliation checks
 * both objects again; a recreated original is not automatically erased. */
export async function removeCopiedMediaOriginal(client: SupabaseClient, assetId: string, generation: string,
  options: RetentionOptions = {},
): Promise<RetainedOriginalRemoval> {
  if (!validAssetId(assetId) || !validAssetId(generation)) throw new Error("Invalid retention identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const prepared = await readRetainedOriginalPreparation(sc, assetId, generation);
    const copy = await readRetainedOriginalCopy(sc, assetId, generation, prepared);
    const copyId = copy.id, objectId = copy.objectId, objectVersion = copy.objectVersion;
    const verifyCopy = async () => {
      const current = await measureRetainedObject(sc, prepared.bucket, prepared.retainedPath, prepared.size, signal,
        options.operationTimeoutMs, { id: objectId, version: objectVersion });
      if (current.sha256 !== prepared.sha256) throw new Error("Retained copy integrity mismatch");
    };
    await verifyCopy();
    const source = await retainedObjectIdentity(sc, prepared.bucket, prepared.sourcePath, prepared.size, true);
    if (source) {
      const current = await measureRetainedObject(sc, prepared.bucket, prepared.sourcePath, prepared.size, signal,
        options.operationTimeoutMs, { id: prepared.objectId, version: prepared.objectVersion });
      if (current.sha256 !== prepared.sha256) throw new Error("Retained original hash changed");
    }
    const args = { p_asset: assetId, p_generation: generation, p_preparation: prepared.id,
      p_object_id: objectId, p_object_version: objectVersion, p_sha256: prepared.sha256, p_size: prepared.size };
    const token = randomUUID();
    const claim = await sc.rpc("advance_media_original_retention", { ...args, p_phase: "removal_started", p_token: token });
    if (claim.error || claim.data?.ok !== true || typeof claim.data.execute !== "boolean" || !validAssetId(claim.data.token)
      || claim.data.execute && claim.data.token !== token) throw new Error("Retention removal authority unconfirmed");
    if (source && claim.data.execute) {
      signal.throwIfAborted();
      // No blind retries: the returned error is not proof that removal failed.
      try { await sc.storage.from(prepared.bucket).remove([prepared.sourcePath]); }
      catch { signal.throwIfAborted(); }
    }
    if (await retainedObjectIdentity(sc, prepared.bucket, prepared.sourcePath, prepared.size, true)) {
      throw new Error("Retention removal outcome unknown or source recreated; reconciliation required");
    }
    await verifyCopy();
    const committed = await sc.rpc("advance_media_original_retention", { ...args, p_phase: "removed", p_token: claim.data.token });
    const result = committed.data?.receipt;
    if (committed.error || committed.data?.ok !== true || !result || !validAssetId(result.id)
      || result.generation !== generation || result.preparationId !== prepared.id || result.copyId !== copyId
      || result.token !== claim.data.token || result.sourceAbsent !== true || result.objectId !== objectId
      || result.objectVersion !== objectVersion || result.sha256 !== prepared.sha256 || result.size !== prepared.size) {
      throw new Error("Retention removal receipt unconfirmed");
    }
    return result as RetainedOriginalRemoval;
  }, options);
}

export interface MediaRestorationReservation {
  unboundMemoryReview: { ownerId: string; fingerprint: string; total: number; storageOrigin: string | null; reviewed: true };
  id: string;
  ownerId: string;
  retiredVersion: number;
  authoredFingerprint: string;
  generation: string;
  assetVersion: number;
  assetFingerprint: string;
  bucket: string;
  sourcePath: string;
  retainedPath: string;
  destinationPath: string;
  preparationId: string;
  copyId: string;
  objectId: string;
  objectVersion: string;
  sha256: string;
  size: number;
  reason: string;
  sources: Array<{ id: string; postId: string; fingerprint: string }>;
  parents: Array<{ id: string; fingerprint: string }>;
  dependencies: Array<{ bucket: string; sourcePath: string;
    references: Array<{ kind: "canonical_thumbnail" | "source_thumbnail" | "source_feed"; id: string }> }>;
  authored: {
    caption: { asset_id: string; source_version: number; revision_key: string; object_path: string | null; fingerprint: string; source: CaptionAsset } | null;
    memoryItems: Array<{ itemId: string; memoryId: string; ownerId: string; assetId: string; itemMediaUrl: string;
      sourcePostId: string | null; memoryFingerprint: string; itemFingerprint: string }>;
    passportBindings: Array<{ id: string; ownerId: string; photoUrl: string; fingerprint: string }>;
    attachments: Array<{ id: string; assetId: string; entityType: string; entityId: string; fingerprint: string }>;
    memoryBindings: Array<{ id: string; memoryId: string; itemId: string; ownerId: string; assetId: string;
      itemMediaUrl: string | null; sourcePostId: string | null;
      operationFingerprint: string; memoryFingerprint: string; itemFingerprint: string; segmentFingerprint: string | null;
      segment: { id: string; memoryId: string; itemId: string; ownerId: string; assetId: string; assetVersion: number;
        durationMs: number; startMs: number; endMs: number; label: string | null; source: "owner_asserted" } | null }>;
    consents: { asr: Record<string, unknown>[]; translation: Record<string, unknown>[]; dubbing: Record<string, unknown>[];
      asrEpoch: Record<string, unknown> | null; translationEpoch: Record<string, unknown> | null; dubbingEpoch: Record<string, unknown> | null };
  };
}

function decodeMediaRestorationReservation(receipt: any, assetId: string, generation: string, reason: string,
  prepared: RetainedOriginalReceipt, copy: RetainedOriginalCopy,
): MediaRestorationReservation {
  const fingerprint = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!receipt || !validAssetId(receipt.id) || receipt.generation !== generation || !validAssetId(receipt.ownerId) || !validVersion(receipt.retiredVersion)
    || !validVersion(receipt.assetVersion) || !fingerprint(receipt.assetFingerprint) || !fingerprint(receipt.authoredFingerprint)
    || receipt.bucket !== prepared.bucket || receipt.sourcePath !== prepared.sourcePath || receipt.retainedPath !== prepared.retainedPath
    || receipt.preparationId !== prepared.id || receipt.copyId !== copy.id || receipt.objectId !== copy.objectId
    || receipt.objectVersion !== copy.objectVersion || receipt.sha256 !== copy.sha256 || receipt.size !== copy.size
    || receipt.reason !== reason.trim() || typeof receipt.destinationPath !== "string"
    || !["jpg", "png", "webp", "heic", "heif", "mp4", "mov", "webm"].some(ext => receipt.destinationPath === `_recovered/${assetId}/${receipt.id}/original.${ext}`)
    || !Array.isArray(receipt.sources) || !receipt.sources.length || !Array.isArray(receipt.parents) || !receipt.parents.length
    || receipt.sources.some((source: any) => !source || !validAssetId(source.id) || !validAssetId(source.postId) || !fingerprint(source.fingerprint))
    || receipt.parents.some((parent: any) => !parent || !validAssetId(parent.id) || !fingerprint(parent.fingerprint))
    || new Set(receipt.sources.map((source: any) => source.id)).size !== receipt.sources.length
    || new Set(receipt.parents.map((parent: any) => parent.id)).size !== receipt.parents.length
    || receipt.sources.some((source: any) => !receipt.parents.some((parent: any) => parent.id === source.postId))) throw new Error("Restoration reservation unconfirmed");
  const unbound = receipt.unboundMemoryReview;
  if (!unbound || unbound.ownerId !== receipt.ownerId || !fingerprint(unbound.fingerprint) || unbound.reviewed !== true
    || !Number.isSafeInteger(unbound.total) || unbound.total < 0
    || (unbound.storageOrigin === null ? unbound.total !== 0 : typeof unbound.storageOrigin !== "string")) {
    throw new Error("Restoration Memory reference review unavailable");
  }
  if (!Array.isArray(receipt.dependencies)) throw new Error("Restoration dependency manifest unavailable");
  const sourceParts = prepared.sourcePath.split("/");
  const restoredRoot = sourceParts.length === 4 && sourceParts[0] === "_recovered" && sourceParts[1] === assetId
    && validAssetId(sourceParts[2]) ? sourceParts.slice(0, 3).join("/") + "/" : null;
  const paths = new Set<string>(), references = new Set<string>();
  for (const dependency of receipt.dependencies) {
    if (!dependency || dependency.bucket !== prepared.bucket || typeof dependency.sourcePath !== "string"
      || !dependency.sourcePath || dependency.sourcePath.length > 2048
      || (dependency.sourcePath.split("/")[0]?.toLowerCase() !== receipt.ownerId
        && !(restoredRoot && dependency.sourcePath.startsWith(restoredRoot)))
      || dependency.sourcePath.split("/").some((part: string) => part === "." || part === "..") || dependency.sourcePath.includes("\\")
      || paths.has(dependency.sourcePath) || !Array.isArray(dependency.references) || !dependency.references.length) {
      throw new Error("Restoration dependency manifest invalid");
    }
    paths.add(dependency.sourcePath);
    for (const reference of dependency.references) {
      if (!reference || !validAssetId(reference.id)
        || (reference.kind === "canonical_thumbnail" ? reference.id !== assetId
          : !["source_thumbnail", "source_feed"].includes(reference.kind) || !receipt.sources.some((source: any) => source.id === reference.id))
        || references.has(`${reference.kind}:${reference.id}`)) throw new Error("Restoration dependency reference invalid");
      references.add(`${reference.kind}:${reference.id}`);
    }
  }
  const authored = receipt.authored;
  if (!authored || !Array.isArray(authored.memoryBindings) || !Array.isArray(authored.memoryItems) || !Array.isArray(authored.passportBindings) || !Array.isArray(authored.attachments) || !authored.consents) throw new Error("Restoration authored review unavailable");
  const attachmentIds = new Set<string>();
  for (const attachment of authored.attachments) {
    if (!attachment || !validAssetId(attachment.id) || attachment.assetId !== assetId || !validAssetId(attachment.entityId)
      || typeof attachment.entityType !== "string" || !attachment.entityType || !fingerprint(attachment.fingerprint)
      || attachmentIds.has(attachment.id)) throw new Error("Restoration attachment binding invalid");
    attachmentIds.add(attachment.id);
  }
  const itemIds = new Set<string>();
  for (const binding of authored.memoryItems) {
    if (!binding || !validAssetId(binding.itemId) || !validAssetId(binding.memoryId) || binding.ownerId !== receipt.ownerId
      || binding.assetId !== assetId || typeof binding.itemMediaUrl !== "string" || !binding.itemMediaUrl
      || binding.sourcePostId !== null && !validAssetId(binding.sourcePostId)
      || !fingerprint(binding.memoryFingerprint) || !fingerprint(binding.itemFingerprint) || itemIds.has(binding.itemId)) {
      throw new Error("Restoration Memory item binding invalid");
    }
    itemIds.add(binding.itemId);
  }
  const passportIds = new Set<string>();
  for (const binding of authored.passportBindings) {
    if (!binding || !validAssetId(binding.id) || binding.ownerId !== receipt.ownerId
      || typeof binding.photoUrl !== "string" || !binding.photoUrl || !fingerprint(binding.fingerprint)
      || passportIds.has(binding.id) || !authored.attachments.some((a: { entityType: string; entityId: string }) => a.entityType === "memory" && a.entityId === binding.id)) {
      throw new Error("Restoration Passport binding invalid");
    }
    passportIds.add(binding.id);
  }
  if (authored.attachments.some((a: { entityType: string; entityId: string }) => a.entityType === "memory" && !passportIds.has(a.entityId))) {
    throw new Error("Restoration Passport binding unavailable");
  }
  const caption = authored.caption;
  if (caption !== null && (!caption || caption.asset_id !== assetId || !validVersion(caption.source_version)
    || !fingerprint(caption.revision_key) || !fingerprint(caption.fingerprint)
    || !caption.source || caption.source.id !== assetId || caption.source.owner_user_id !== receipt.ownerId
    || caption.source.storage_bucket !== receipt.bucket || caption.source.storage_path !== receipt.sourcePath
    || caption.source.version !== receipt.retiredVersion || caption.source.deleted_at !== null || caption.source.purge_status !== "not_requested"
    || caption.object_path !== null && (caption.source_version !== receipt.retiredVersion
      || caption.source.media_type !== "video" || !Number.isSafeInteger(caption.source.duration_ms) || caption.source.duration_ms <= 0
      || caption.source.processing_status !== "ready" || !["active", "approved"].includes(caption.source.moderation_status)
      || caption.object_path !== captionArtifactPath(assetId, caption.source_version, caption.revision_key)))) throw new Error("Restoration caption review invalid");
  const operations = new Set<string>();
  for (const binding of authored.memoryBindings) {
    if (!binding || !validAssetId(binding.id) || !validAssetId(binding.memoryId) || !validAssetId(binding.itemId)
      || binding.ownerId !== receipt.ownerId || binding.assetId !== assetId || operations.has(binding.id)
      || binding.sourcePostId !== null && !validAssetId(binding.sourcePostId)
      || binding.itemMediaUrl !== null && typeof binding.itemMediaUrl !== "string"
      || !fingerprint(binding.operationFingerprint) || !fingerprint(binding.memoryFingerprint) || !fingerprint(binding.itemFingerprint)) {
      throw new Error("Restoration Memory binding invalid");
    }
    operations.add(binding.id);
    const segment = binding.segment;
    if (segment === null ? binding.segmentFingerprint !== null : !segment || !fingerprint(binding.segmentFingerprint)
      || ["id", "memoryId", "itemId", "ownerId", "assetId"].some(key => segment[key] !== binding[key])
      || segment.assetVersion !== receipt.retiredVersion || !Number.isSafeInteger(segment.durationMs) || segment.durationMs <= 0
      || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < 0
      || segment.startMs >= segment.endMs || segment.endMs > segment.durationMs || segment.source !== "owner_asserted"
      || segment.label !== null && (typeof segment.label !== "string" || segment.label !== segment.label.trim() || !segment.label || Array.from(segment.label).length > 160)) {
      throw new Error("Restoration Memory segment invalid");
    }
  }
  for (const family of ["asr", "translation", "dubbing"]) {
    const rows = authored.consents[family];
    if (!Array.isArray(rows) || rows.some((row: any) => !row || row.asset_id !== assetId || row.owner_user_id !== receipt.ownerId
      || !validVersion(row.source_version))) throw new Error("Restoration consent review invalid");
    const epoch = authored.consents[`${family}Epoch`];
    if (epoch !== null && (!epoch || epoch.asset_id !== assetId)) throw new Error("Restoration consent epoch invalid");
  }
  return receipt as MediaRestorationReservation;
}

function validateRestorationReferenceSources(reservation: MediaRestorationReservation): void {
  if (reservation.unboundMemoryReview.storageOrigin !== null
    && reservation.unboundMemoryReview.storageOrigin !== configuredStorageOrigin()) throw new Error("Restoration Memory reference origin changed");
  // Match the Memory writer's origin/path parser before new authority. Physical
  // reconciliation and abort use only immutable object receipts, so changed
  // URL configuration cannot prevent safe cancellation of an existing review.
  for (const binding of reservation.authored.memoryBindings) if (binding.segment !== null) {
    const ref = typeof binding.itemMediaUrl === "string" ? memoryRecoveryStorageRef(binding.itemMediaUrl) : null;
    if (!ref || ref.bucket !== reservation.bucket || ref.path !== reservation.sourcePath) throw new Error("Restoration Memory source invalid");
  }
  for (const binding of reservation.authored.memoryItems) {
    const ref = memoryRecoveryStorageRef(binding.itemMediaUrl);
    if (!ref || ref.bucket !== reservation.bucket || ref.path !== reservation.sourcePath) throw new Error("Restoration Memory item source invalid");
  }
  for (const binding of reservation.authored.passportBindings) {
    const ref = appStorageUrlInfo(binding.photoUrl);
    if (!ref || ref.bucket !== reservation.bucket || ref.path !== reservation.sourcePath) throw new Error("Restoration Passport source invalid");
  }
}

/** Reserve an admin-reviewed restoration, without publishing or copying bytes.
 * All existing source IDs and row fingerprints remain bound to this receipt.
 * Physical restoration and source/canonical activation must consume it later. */
export async function prepareRetainedMediaRestoration(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reason: string, options: RetentionOptions = {},
): Promise<MediaRestorationReservation> {
  if (![actorId, assetId, generation].every(validAssetId) || !reason.trim() || reason.length > 1000) throw new Error("Invalid restoration review");
  return withMediaCleanup(client, async (sc, signal) => {
    const prepared = await readRetainedOriginalPreparation(sc, assetId, generation);
    const copy = await readRetainedOriginalCopy(sc, assetId, generation, prepared);
    const current = await measureRetainedObject(sc, prepared.bucket, prepared.retainedPath, prepared.size, signal,
      options.operationTimeoutMs, { id: copy.objectId, version: copy.objectVersion });
    if (current.sha256 !== copy.sha256) throw new Error("Retained copy integrity mismatch");
    const memoryReview = await reviewUnboundMemoryReferences(sc, assetId, { bucket: prepared.bucket, path: prepared.sourcePath }, actorId);
    const result = await sc.rpc("prepare_media_restoration", { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reason: reason,
      p_memory_review: memoryReview });
    if (result.error || result.data?.ok !== true) throw new Error("Restoration reservation unconfirmed");
    const reservation = decodeMediaRestorationReservation(result.data.receipt, assetId, generation, reason, prepared, copy);
    validateRestorationReferenceSources(reservation);
    return reservation;
  }, options);
}

interface MeasuredRestorationDependency {
  bucket: string; sourcePath: string; objectId: string; objectVersion: string; sha256: string; size: number;
}
export interface VerifiedRestorationDependencies {
  id: string; generation: string; reservationId: string; objects: MeasuredRestorationDependency[];
  authoredFingerprint: string;
  caption: VerifiedRetainedCaption | null;
}

interface VerifiedRetainedCaption extends MeasuredRestorationDependency {
  manifestFingerprint: string; revisionKey: string; sourceVersion: number;
  tracks: Array<{ language: string; sourceKind: string; revision: number; vttSha256: string }>;
}

async function readRestorationReservation(sc: SupabaseClient, assetId: string, generation: string, reservationId: string) {
  const prepared = await readRetainedOriginalPreparation(sc, assetId, generation);
  const retained = await readRetainedOriginalCopy(sc, assetId, generation, prepared);
  const read = await sc.from("media_asset_lifecycle_events").select("id,details")
    .eq("id", reservationId).eq("media_asset_id", assetId).eq("event_type", "restoration_prepared").eq("details->>generation", generation).maybeSingle();
  if (read.error || read.data?.id !== reservationId || typeof read.data.details?.reason !== "string") throw new Error("Restoration reservation unavailable");
  return decodeMediaRestorationReservation({ ...read.data.details, id: read.data.id }, assetId, generation,
    read.data.details.reason, prepared, retained);
}

/** Verify every declared object before any restoration dispatch. Measurements
 * are bound to the existing reviewed reservation; no file or source is changed.
 * An alias of the original uses its verified retained copy, never the old key. */
export async function verifyMediaRestorationDependencies(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, options: RetentionOptions = {},
): Promise<VerifiedRestorationDependencies> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId)) throw new Error("Invalid restoration identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    const objects: MeasuredRestorationDependency[] = [];
    validateRestorationReferenceSources(reservation);
    for (const dependency of reservation.dependencies) {
      const originalAlias = dependency.sourcePath === reservation.sourcePath;
      const path = originalAlias ? reservation.retainedPath : dependency.sourcePath;
      const identity = await retainedObjectIdentity(sc, dependency.bucket, path, undefined);
      if (!identity || identity.size < 1 || identity.size > 5 * 1024 ** 3) throw new Error("Restoration dependency size invalid");
      const measured = await measureRetainedObject(sc, dependency.bucket, path, identity.size, signal, options.operationTimeoutMs,
        originalAlias ? { id: reservation.objectId, version: reservation.objectVersion } : identity);
      if (originalAlias && (measured.sha256 !== reservation.sha256 || measured.size !== reservation.size)) throw new Error("Restoration original alias changed");
      objects.push({ bucket: dependency.bucket, sourcePath: dependency.sourcePath,
        objectId: measured.id, objectVersion: measured.version, sha256: measured.sha256, size: measured.size });
    }
    // Match PostgreSQL COLLATE "C", including non-ASCII legacy filenames.
    objects.sort((a, b) => Buffer.compare(Buffer.from(a.sourcePath), Buffer.from(b.sourcePath)));
    let caption: VerifiedRetainedCaption | null = null;
    const manifest = reservation.authored.caption;
    if (manifest?.object_path) {
      const identity = await retainedObjectIdentity(sc, "post-media", manifest.object_path, undefined);
      if (!identity || identity.size < 1 || identity.size > MAX_CAPTION_ARTIFACT_BYTES) throw new Error("Retained caption size invalid");
      const chunks: Uint8Array[] = [];
      const measured = await measureRetainedObject(sc, "post-media", manifest.object_path, identity.size, signal,
        options.operationTimeoutMs, identity, chunk => chunks.push(chunk.slice()));
      const tracks = validateCaptionArtifact(Buffer.concat(chunks, identity.size), manifest.source);
      caption = { bucket: "post-media", sourcePath: manifest.object_path, objectId: measured.id, objectVersion: measured.version,
        sha256: measured.sha256, size: measured.size, manifestFingerprint: manifest.fingerprint,
        revisionKey: manifest.revision_key, sourceVersion: manifest.source_version,
        tracks: tracks.map(track => ({ language: track.language, sourceKind: track.sourceKind, revision: track.revision,
          vttSha256: createHash("sha256").update(track.vtt, "utf8").digest("hex") })) };
    }
    const committed = await sc.rpc("verify_media_restoration_dependencies", { p_actor: actorId, p_asset: assetId,
      p_generation: generation, p_reservation: reservationId, p_objects: objects, p_caption: caption });
    const result = committed.data?.receipt;
    const expectedCaption = caption;
    if (committed.error || committed.data?.ok !== true || !result || !validAssetId(result.id)
      || result.generation !== generation || result.reservationId !== reservationId || result.authoredFingerprint !== reservation.authoredFingerprint
      || !Array.isArray(result.objects)
      || result.objects.length !== objects.length || result.objects.some((object: any, index: number) => {
        const expected = objects[index]!;
        return !object || Object.keys(expected).some(key => object[key] !== expected[key as keyof MeasuredRestorationDependency]);
      }) || (expectedCaption === null ? result.caption !== null : !result.caption
        || Object.keys(expectedCaption).filter(key => key !== "tracks").some(key => result.caption[key] !== expectedCaption[key as keyof VerifiedRetainedCaption])
        || !Array.isArray(result.caption.tracks) || result.caption.tracks.length !== expectedCaption.tracks.length
        || result.caption.tracks.some((track: any, index: number) => Object.keys(expectedCaption.tracks[index]!).some(key => track?.[key] !== expectedCaption.tracks[index]![key as keyof VerifiedRetainedCaption["tracks"][number]])))) {
      throw new Error("Restoration dependency verification unconfirmed");
    }
    return result as VerifiedRestorationDependencies;
  }, options);
}

export interface RestorationOriginalCopy extends Omit<RetainedOriginalCopy, "preparationId"> {
  reservationId: string;
}

/** Copy into the reserved fresh key without changing source/canonical records
 * or signing authority. Reconciliation never creates a replacement reservation. */
export async function copyMediaRestorationOriginal(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, options: RetentionOptions = {},
): Promise<RestorationOriginalCopy> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId)) throw new Error("Invalid restoration identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    const args = { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reservation: reservationId };
    const { copied, token } = await copyReservedMediaObject(sc, assetId, { bucket: reservation.bucket,
      sourcePath: reservation.retainedPath, destinationPath: reservation.destinationPath,
      objectId: reservation.objectId, objectVersion: reservation.objectVersion, sha256: reservation.sha256, size: reservation.size }, {
      eventType: "restoration_copy_started", identityKey: "reservationId", identityValue: reservationId,
      claim: async (token, newDispatch) => {
        if (newDispatch) validateRestorationReferenceSources(reservation);
        return sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "copy_started", p_token: token });
      },
    }, signal, options);
    const committed = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "copied", p_token: token,
      p_object_id: copied.id, p_object_version: copied.version, p_sha256: copied.sha256, p_size: copied.size });
    const result = committed.data?.receipt;
    if (committed.error || committed.data?.ok !== true || !result || !validAssetId(result.id) || result.reservationId !== reservationId
      || result.generation !== generation || result.token !== token || result.objectId !== copied.id || result.objectVersion !== copied.version
      || result.sha256 !== reservation.sha256 || result.size !== reservation.size) throw new Error("Restoration copy receipt unconfirmed");
    return result as RestorationOriginalCopy;
  }, options);
}

export interface RestorationDependencyCopy extends RestorationOriginalCopy {
  sourcePath: string;
  destinationPath: string;
  verificationId: string;
  reusedOriginal: boolean;
}

/** One object from the reviewed dependency manifest. Shared references consume
 * the same path receipt; an original alias consumes the original copy owner.
 * No source metadata, read authority or canonical locator is activated here. */
export async function copyMediaRestorationDependency(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, sourcePath: string, options: RetentionOptions = {},
): Promise<RestorationDependencyCopy> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId) || typeof sourcePath !== "string" || !sourcePath) throw new Error("Invalid restoration dependency identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    if (!reservation.dependencies.some(dependency => dependency.sourcePath === sourcePath)) throw new Error("Restoration dependency not reviewed");
    const read = await sc.from("media_asset_lifecycle_events").select("id,details")
      .eq("media_asset_id", assetId).eq("event_type", "restoration_dependencies_verified").eq("details->>reservationId", reservationId).maybeSingle();
    const verification = read.data?.details;
    if (read.error || !read.data || !validAssetId(read.data.id) || !verification || verification.generation !== generation
      || verification.reservationId !== reservationId || verification.authoredFingerprint !== reservation.authoredFingerprint || !Array.isArray(verification.objects)) throw new Error("Verified restoration dependencies unavailable");
    const objects = verification.objects.filter((object: any) => object?.sourcePath === sourcePath);
    const expected = objects[0];
    if (objects.length !== 1 || expected.bucket !== reservation.bucket || !validAssetId(expected.objectId)
      || typeof expected.objectVersion !== "string" || !expected.objectVersion.trim() || expected.objectVersion.length > 200
      || typeof expected.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(expected.sha256)
      || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 5 * 1024 ** 3) throw new Error("Verified restoration dependency invalid");
    const verificationId = read.data.id;
    if (sourcePath === reservation.sourcePath) {
      if (expected.objectId !== reservation.objectId || expected.objectVersion !== reservation.objectVersion
        || expected.sha256 !== reservation.sha256 || expected.size !== reservation.size) throw new Error("Restoration original alias changed");
      const copied = await copyMediaRestorationOriginal(sc, actorId, assetId, generation, reservationId, { ...options, signal });
      return { ...copied, sourcePath, destinationPath: reservation.destinationPath, verificationId, reusedOriginal: true };
    }
    const destinationPath = `_recovered/${assetId}/${reservationId}/objects/${createHash("sha256").update(sourcePath, "utf8").digest("hex")}`;
    const args = { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reservation: reservationId, p_source_path: sourcePath };
    const { copied, token } = await copyReservedMediaObject(sc, assetId, { ...expected, destinationPath }, {
      eventType: "restoration_dependency_copy_started", identityKey: "reservationId", identityValue: reservationId, objectPath: sourcePath,
      claim: async (token, newDispatch) => {
        if (newDispatch) validateRestorationReferenceSources(reservation);
        const claim = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "copy_started", p_token: token });
        if (claim.error || claim.data?.sourcePath !== sourcePath || claim.data.destinationPath !== destinationPath
          || claim.data.verificationId !== verificationId) throw new Error("Restoration dependency copy authority unconfirmed");
        return claim;
      },
    }, signal, options);
    const committed = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "copied", p_token: token,
      p_object_id: copied.id, p_object_version: copied.version, p_sha256: copied.sha256, p_size: copied.size });
    const result = committed.data?.receipt;
    if (committed.error || committed.data?.ok !== true || !result || !validAssetId(result.id)
      || result.reservationId !== reservationId || result.generation !== generation || result.token !== token
      || result.sourcePath !== sourcePath || result.destinationPath !== destinationPath || result.verificationId !== verificationId
      || result.objectId !== copied.id || result.objectVersion !== copied.version || result.sha256 !== expected.sha256 || result.size !== expected.size) {
      throw new Error("Restoration dependency copy receipt unconfirmed");
    }
    return { ...result, reusedOriginal: false } as RestorationDependencyCopy;
  }, options);
}

interface CaptionRebasePlan {
  id: string; generation: string; reservationId: string; verificationId: string; authoredFingerprint: string;
  sourcePath: string; destinationPath: string; revisionKey: string; targetSource: CaptionAsset; sha256: string; size: number;
}
export interface RestorationCaptionCopy extends RestorationOriginalCopy {
  rebaseId: string; verificationId: string; sourcePath: string; destinationPath: string; revisionKey: string; targetSource: CaptionAsset;
}

function captionRestorationTarget(reservation: MediaRestorationReservation) {
  const caption = reservation.authored.caption;
  if (!caption?.object_path || !validVersion(reservation.assetVersion + 1)) throw new Error("Restoration caption unavailable");
  const targetSource: CaptionAsset = { ...caption.source, storage_path: reservation.destinationPath, version: reservation.assetVersion + 1 };
  const revisionKey = createHash("sha256").update(`restoration-caption:${reservation.id}`, "utf8").digest("hex");
  return { targetSource, revisionKey, destinationPath: captionArtifactPath(targetSource.id, targetSource.version, revisionKey) };
}

function decodeCaptionRebasePlan(data: any, reservation: MediaRestorationReservation): CaptionRebasePlan {
  const target = captionRestorationTarget(reservation);
  if (!data || !validAssetId(data.id) || !validAssetId(data.verificationId) || data.generation !== reservation.generation
    || data.reservationId !== reservation.id || data.authoredFingerprint !== reservation.authoredFingerprint
    || data.sourcePath !== reservation.authored.caption?.object_path || data.destinationPath !== target.destinationPath
    || data.revisionKey !== target.revisionKey || !data.targetSource
    || Object.keys(data.targetSource).length !== Object.keys(target.targetSource).length
    || Object.keys(target.targetSource).some(key => data.targetSource[key] !== target.targetSource[key as keyof CaptionAsset])
    || !/^[a-f0-9]{64}$/.test(data.sha256 ?? "") || !Number.isSafeInteger(data.size)
    || data.size < 1 || data.size > MAX_CAPTION_ARTIFACT_BYTES) throw new Error("Restoration caption plan unconfirmed");
  return data as CaptionRebasePlan;
}

async function readCaptionRebasePlan(sc: SupabaseClient, assetId: string, reservation: MediaRestorationReservation): Promise<CaptionRebasePlan | null> {
  const result = await sc.from("media_asset_lifecycle_events").select("id,details").eq("media_asset_id", assetId)
    .eq("event_type", "restoration_caption_prepared").eq("details->>reservationId", reservation.id).maybeSingle();
  if (result.error) throw new Error("Restoration caption plan unavailable");
  return result.data ? decodeCaptionRebasePlan({ ...result.data.details, id: result.data.id }, reservation) : null;
}

/** Stage one fresh caption artifact. Track content/revisions stay unchanged;
 * its manifest is committed only by future atomic canonical activation, which
 * must match the actual UPDATE RETURNING source to this target identity. */
export async function stageMediaRestorationCaption(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, options: RetentionOptions = {},
): Promise<RestorationCaptionCopy> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId)) throw new Error("Invalid restoration identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    const target = captionRestorationTarget(reservation), manifest = reservation.authored.caption!;
    const args = { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reservation: reservationId, p_source_path: manifest.object_path };
    let plan = await readCaptionRebasePlan(sc, assetId, reservation);
    let encoded: Uint8Array | undefined;
    let verified: VerifiedRestorationDependencies | undefined;
    const encode = async () => {
      validateRestorationReferenceSources(reservation);
      await requirePrivateCaptionStorage(sc);
      if (!verified) {
        const read = await sc.from("media_asset_lifecycle_events").select("id,details").eq("media_asset_id", assetId)
          .eq("event_type", "restoration_dependencies_verified").eq("details->>reservationId", reservationId).maybeSingle();
        if (read.error || !read.data || read.data.id !== plan?.verificationId) throw new Error("Restoration caption verification unavailable");
        verified = { ...read.data.details, id: read.data.id } as VerifiedRestorationDependencies;
      }
      const proof = verified.caption;
      if (verified.generation !== generation || verified.reservationId !== reservationId || verified.authoredFingerprint !== reservation.authoredFingerprint
        || !proof || proof.sourcePath !== manifest.object_path || proof.bucket !== "post-media" || proof.sourceVersion !== manifest.source_version
        || proof.manifestFingerprint !== manifest.fingerprint || proof.revisionKey !== manifest.revision_key
        || !validAssetId(proof.objectId) || typeof proof.objectVersion !== "string" || !proof.objectVersion.trim()
        || !Number.isSafeInteger(proof.size) || proof.size < 1 || proof.size > MAX_CAPTION_ARTIFACT_BYTES
        || !/^[a-f0-9]{64}$/.test(proof.sha256)) throw new Error("Restoration caption verification invalid");
      const chunks: Uint8Array[] = [];
      const measured = await measureRetainedObject(sc, "post-media", proof.sourcePath, proof.size, signal, options.operationTimeoutMs,
        { id: proof.objectId, version: proof.objectVersion }, chunk => chunks.push(chunk.slice()));
      if (measured.sha256 !== proof.sha256) throw new Error("Retained caption bytes changed");
      return rebaseCaptionArtifact(Buffer.concat(chunks, proof.size), manifest.source, target.targetSource);
    };
    if (!plan) {
      verified = await verifyMediaRestorationDependencies(sc, actorId, assetId, generation, reservationId, { ...options, signal });
      encoded = await encode();
      const prepared = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "caption_prepared", p_token: randomUUID(),
        p_sha256: createHash("sha256").update(encoded).digest("hex"), p_size: encoded.byteLength });
      if (prepared.error || prepared.data?.ok !== true) throw new Error("Restoration caption preparation unconfirmed");
      plan = decodeCaptionRebasePlan(prepared.data.receipt, reservation);
      if (plan.sha256 !== createHash("sha256").update(encoded).digest("hex") || plan.size !== encoded.byteLength
        || plan.verificationId !== verified.id) throw new Error("Restoration caption preparation identity changed");
    }
    const { copied, token } = await copyReservedMediaObject(sc, assetId, { bucket: "post-media", sourcePath: plan.sourcePath,
      destinationPath: plan.destinationPath, objectId: "", objectVersion: "", sha256: plan.sha256, size: plan.size }, {
      eventType: "restoration_caption_started", identityKey: "reservationId", identityValue: reservationId,
      write: { prepare: async () => encoded ?? encode(), dispatch: bytes => uploadCaptionArtifact(sc, target.targetSource, target.revisionKey, bytes) },
      claim: async (token, newDispatch) => {
        if (newDispatch) validateRestorationReferenceSources(reservation);
        const claim = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "caption_started", p_token: token });
        if (claim.error || claim.data?.destinationPath !== plan!.destinationPath || claim.data.rebaseId !== plan!.id
          || claim.data.verificationId !== plan!.verificationId) throw new Error("Restoration caption dispatch unconfirmed");
        return claim;
      },
    }, signal, options);
    const result = await sc.rpc("advance_media_restoration_copy", { ...args, p_phase: "caption_written", p_token: token,
      p_object_id: copied.id, p_object_version: copied.version, p_sha256: copied.sha256, p_size: copied.size });
    const receipt = result.data?.receipt;
    if (result.error || result.data?.ok !== true || !receipt || !validAssetId(receipt.id) || receipt.rebaseId !== plan.id
      || receipt.token !== token || receipt.objectId !== copied.id || receipt.objectVersion !== copied.version
      || receipt.sha256 !== plan.sha256 || receipt.size !== plan.size) throw new Error("Restoration caption completion unconfirmed");
    decodeCaptionRebasePlan({ ...receipt, id: plan.id }, reservation);
    return receipt as RestorationCaptionCopy;
  }, options);
}

export interface MediaRestorationActivation {
  id: string; generation: string; reservationId: string; version: number; bucket: string; destinationPath: string;
}

/** Verify the actual private destinations immediately before the atomic domain
 * commit. This returns an audit receipt, not a signed URL or visibility grant. */
export async function activateMediaRestoration(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, options: RetentionOptions = {},
): Promise<MediaRestorationActivation> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId)) throw new Error("Invalid restoration identity");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    const prior = await sc.from("media_asset_lifecycle_events").select("id").eq("media_asset_id", assetId)
      .eq("event_type", "restoration_activated").eq("details->>generation", generation).maybeSingle();
    if (prior.error) throw new Error("Restoration activation state unavailable");
    const objects: Array<{ receiptId: string; path: string; objectId: string; objectVersion: string; sha256: string; size: number }> = [];
    if (!prior.data) {
      validateRestorationReferenceSources(reservation);
      const required = new Map<string, { event: string; sourcePath: string | null }>([[reservation.destinationPath, { event: "restoration_copied", sourcePath: null }]]);
      for (const dependency of reservation.dependencies) if (dependency.sourcePath !== reservation.sourcePath) {
        required.set(`_recovered/${assetId}/${reservationId}/objects/${createHash("sha256").update(dependency.sourcePath, "utf8").digest("hex")}`,
          { event: "restoration_dependency_copied", sourcePath: dependency.sourcePath });
      }
      if (reservation.authored.caption?.object_path) {
        const plan = await readCaptionRebasePlan(sc, assetId, reservation);
        if (!plan) throw new Error("Restoration caption is not staged");
        required.set(plan.destinationPath, { event: "restoration_caption_written", sourcePath: plan.sourcePath });
      }
      const read = await sc.from("media_asset_lifecycle_events").select("id,event_type,details").eq("media_asset_id", assetId)
        .eq("details->>reservationId", reservationId).in("event_type", ["restoration_copied", "restoration_dependency_copied", "restoration_caption_written"]);
      if (read.error || !Array.isArray(read.data) || read.data.length !== required.size) throw new Error("Restoration transfers incomplete");
      const seen = new Set<string>();
      for (const row of read.data) {
        const detail = row.details, path = detail?.destinationPath ?? reservation.destinationPath;
        const expected = required.get(path);
        if (!expected || seen.has(path) || row.event_type !== expected.event || !validAssetId(row.id)
          || detail?.reservationId !== reservationId || detail.generation !== generation || (detail.sourcePath ?? null) !== expected.sourcePath
          || !validAssetId(detail.objectId) || typeof detail.objectVersion !== "string" || !detail.objectVersion.trim()
          || !/^[a-f0-9]{64}$/.test(detail.sha256 ?? "") || !Number.isSafeInteger(detail.size) || detail.size <= 0 || detail.size > 5 * 1024 ** 3) {
          throw new Error("Restoration transfer receipt invalid");
        }
        seen.add(path);
        const measured = await measureRetainedObject(sc, reservation.bucket, path, detail.size, signal, options.operationTimeoutMs,
          { id: detail.objectId, version: detail.objectVersion });
        if (measured.sha256 !== detail.sha256) throw new Error("Restoration destination bytes changed");
        objects.push({ receiptId: row.id, path, objectId: measured.id, objectVersion: measured.version, sha256: measured.sha256, size: measured.size });
      }
      objects.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }
    const result = await sc.rpc("activate_media_restoration", { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reservation: reservationId, p_objects: objects });
    const receipt = result.data?.receipt;
    if (result.error || result.data?.ok !== true || !receipt || !validAssetId(receipt.id)
      || receipt.generation !== generation || receipt.reservationId !== reservationId || receipt.version !== reservation.assetVersion + 1
      || receipt.bucket !== reservation.bucket || receipt.destinationPath !== reservation.destinationPath) throw new Error("Restoration activation unconfirmed");
    return { id: receipt.id, generation, reservationId, version: receipt.version, bucket: receipt.bucket, destinationPath: receipt.destinationPath };
  }, options);
}

export interface RestorationCancellation {
  id: string; generation: string; reservationId: string; reason: string; abortId: string; paths: string[];
}

/** Abort through the existing cancellation owner. A durable request fences new
 * copies; only completed physical transfers can enter one-dispatch cleanup.
 * Every removal targets this reservation's fresh keys, never retained sources. */
export async function abortMediaRestoration(client: SupabaseClient, actorId: string, assetId: string,
  generation: string, reservationId: string, reason: string, options: RetentionOptions = {},
): Promise<RestorationCancellation> {
  if (![actorId, assetId, generation, reservationId].every(validAssetId) || !reason.trim() || reason.length > 1000) throw new Error("Invalid restoration abort review");
  return withMediaCleanup(client, async (sc, signal) => {
    const reservation = await readRestorationReservation(sc, assetId, generation, reservationId);
    const args = { p_actor: actorId, p_asset: assetId, p_generation: generation, p_reservation: reservationId, p_reason: reason.trim() };
    const destinations = new Map<string, string | null>([[reservation.destinationPath, null]]);
    for (const dependency of reservation.dependencies) if (dependency.sourcePath !== reservation.sourcePath) {
      destinations.set(`_recovered/${assetId}/${reservationId}/objects/${createHash("sha256").update(dependency.sourcePath, "utf8").digest("hex")}`, dependency.sourcePath);
    }
    const captionPlan = await readCaptionRebasePlan(sc, assetId, reservation);
    if (captionPlan) destinations.set(captionPlan.destinationPath, captionPlan.sourcePath);
    const paths = [...destinations.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    type AbortCopy = { sourcePath: string | null; destinationPath: string; token: string; copy: RestorationOriginalCopy | null };
    const request = async () => {
      const result = await sc.rpc("cancel_media_restoration", { ...args, p_phase: "request_abort" });
      const data = result.data, receipt = data?.receipt;
      if (result.error || data?.ok !== true || !receipt || !validAssetId(receipt.id)
        || receipt.generation !== generation || receipt.reservationId !== reservationId || receipt.reason !== reason.trim()
        || data.bucket !== reservation.bucket || !Array.isArray(data.paths) || data.paths.length !== paths.length
        || data.paths.some((path: unknown, index: number) => path !== paths[index]) || !Array.isArray(data.copies)
        || typeof data.pending !== "boolean" || new Set(data.copies.map((copy: any) => copy?.destinationPath)).size !== data.copies.length) {
        throw new Error("Restoration abort authority unconfirmed");
      }
      for (const item of data.copies as AbortCopy[]) {
        if (!item || !destinations.has(item.destinationPath) || destinations.get(item.destinationPath) !== item.sourcePath
          || !validAssetId(item.token) || item.copy !== null && (!validAssetId(item.copy.id)
            || item.copy.reservationId !== reservationId || item.copy.generation !== generation || item.copy.token !== item.token
            || !validAssetId(item.copy.objectId) || typeof item.copy.objectVersion !== "string" || !item.copy.objectVersion.trim()
            || !/^[a-f0-9]{64}$/.test(item.copy.sha256) || !Number.isSafeInteger(item.copy.size) || item.copy.size <= 0 || item.copy.size > 5_000_000_000)) {
          throw new Error("Restoration abort copy inventory invalid");
        }
      }
      if (data.pending !== data.copies.some((item: AbortCopy) => item.copy === null)) throw new Error("Restoration abort settlement unconfirmed");
      return data as { receipt: { id: string }; copies: AbortCopy[]; pending: boolean; cancelled: RestorationCancellation | null };
    };
    let state = await request();
    const abortId = state.receipt.id;
    const verifyRetained = async () => {
      const current = await measureRetainedObject(sc, reservation.bucket, reservation.retainedPath, reservation.size, signal,
        options.operationTimeoutMs, { id: reservation.objectId, version: reservation.objectVersion });
      if (current.sha256 !== reservation.sha256) throw new Error("Retained copy integrity mismatch");
    };
    await verifyRetained();
    if (state.pending) {
      // Each listed operation already has its one dispatch claim. Existing copy
      // owners may observe its destination and record completion, never recopy.
      for (const item of state.copies) if (!item.copy) {
        if (item.sourcePath === null) await copyMediaRestorationOriginal(sc, actorId, assetId, generation, reservationId, { ...options, signal });
        else if (captionPlan && item.destinationPath === captionPlan.destinationPath) await stageMediaRestorationCaption(sc, actorId, assetId, generation, reservationId, { ...options, signal });
        else await copyMediaRestorationDependency(sc, actorId, assetId, generation, reservationId, item.sourcePath, { ...options, signal });
      }
      state = await request();
      if (state.receipt.id !== abortId || state.pending) throw new Error("Restoration abort settlement unconfirmed");
    }
    const validCancellation = (value: any): value is RestorationCancellation => value && validAssetId(value.id)
      && value.generation === generation && value.reservationId === reservationId && value.abortId === abortId
      && value.reason === reason.trim() && Array.isArray(value.paths) && value.paths.length === paths.length
      && value.paths.every((path: unknown, index: number) => path === paths[index]);
    if (!state.cancelled) for (const path of paths) {
      const existing = await retainedObjectIdentity(sc, reservation.bucket, path, undefined, true);
      if (existing) {
        const copy = state.copies.find(item => item.destinationPath === path)?.copy;
        if (!copy) throw new Error("Restoration abort destination has no verified copy");
        const measured = await measureRetainedObject(sc, reservation.bucket, path, copy.size, signal,
          options.operationTimeoutMs, { id: copy.objectId, version: copy.objectVersion });
        if (measured.sha256 !== copy.sha256) throw new Error("Restoration abort destination integrity mismatch");
      }
      const token = randomUUID();
      const claim = await sc.rpc("cancel_media_restoration", { ...args, p_phase: "removal_started", p_path: path, p_token: token });
      if (claim.error || claim.data?.ok !== true || typeof claim.data.execute !== "boolean" || !validAssetId(claim.data.token)
        || claim.data.abortId !== abortId || claim.data.execute && claim.data.token !== token) throw new Error("Restoration cleanup authority unconfirmed");
      if (existing && claim.data.execute) {
        signal.throwIfAborted();
        try { await sc.storage.from(reservation.bucket).remove([path]); } catch { signal.throwIfAborted(); }
      }
      if (await retainedObjectIdentity(sc, reservation.bucket, path, undefined, true)) throw new Error("Restoration cleanup outcome unknown or destination recreated");
      const observed = await sc.rpc("cancel_media_restoration", { ...args, p_phase: "absent", p_path: path, p_token: claim.data.token });
      const receipt = observed.data?.receipt;
      if (observed.error || observed.data?.ok !== true || !receipt || !validAssetId(receipt.id) || receipt.abortId !== abortId
        || receipt.generation !== generation || receipt.reservationId !== reservationId || receipt.bucket !== reservation.bucket
        || receipt.path !== path || receipt.token !== claim.data.token || receipt.absent !== true) throw new Error("Restoration cleanup absence unconfirmed");
    }
    for (const path of paths) if (await retainedObjectIdentity(sc, reservation.bucket, path, undefined, true)) throw new Error("Restoration cleanup destination recreated");
    await verifyRetained();
    if (state.cancelled) {
      if (!validCancellation(state.cancelled)) throw new Error("Restoration cancellation receipt invalid");
      return state.cancelled;
    }
    const result = await sc.rpc("cancel_media_restoration", { ...args, p_phase: "cancel" });
    if (result.error || result.data?.ok !== true || !validCancellation(result.data.receipt)) throw new Error("Restoration cancellation unconfirmed");
    return result.data.receipt;
  }, options);
}

export interface RetryProcessingResult {
  ok: boolean;
  alreadyQueued: boolean; /** census-media §30: set on a refusal that wrote nothing — see retryRefusal at the end of this file. */ notRetryable?: boolean; workerDisabled?: boolean; /** tm-followups WP-17: the asset read or the re-queue write FAILED — an outage, never "not found". */ dbError?: string;
}

function token(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function retryAt(attempt: number, now: number): string {
  const delay = DEFAULT_RETRY_BASE_MS * Math.min(32, 2 ** Math.max(0, attempt - 1));
  return new Date(now + delay).toISOString();
}

/**
 * Atomically claims a due processing asset. The conditional update makes
 * duplicate workers harmless: only one lease token can be persisted.
 */
export async function claimMediaProcessing(
  sc: SupabaseClient,
  assetId: string,
  opts: { leaseMs?: number; now?: Date } = {},
): Promise<ProcessingClaim | null> {
  const now = opts.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_PROCESSING_LEASE_MS));
  const leaseToken = token();
  const { data: row, error: readError } = await sc
    .from("media_assets")
    .select("id, processing_status, processing_attempt_count, processing_next_retry_at, processing_lease_until, processing_terminal")
    .eq("id", assetId)
    .maybeSingle();
  if (readError || !row || row.processing_terminal) return null;
  const due = !row.processing_next_retry_at || new Date(row.processing_next_retry_at).getTime() <= now.getTime();
  const leaseFree = !row.processing_lease_until || new Date(row.processing_lease_until).getTime() <= now.getTime();
  if (!due || !leaseFree || !["processing", "failed", "queued", "uploaded"].includes(row.processing_status)) return null;
  const attemptNumber = Number(row.processing_attempt_count ?? 0) + 1;
  const { data: claimed, error } = await sc.from("media_assets").update({
    processing_status: "processing",
    processing_attempt_count: attemptNumber,
    processing_last_attempt_at: now.toISOString(),
    processing_lease_until: leaseUntil.toISOString(),
    processing_lease_token: leaseToken,
    processing_error: null,
    updated_at: now.toISOString(),
  }).eq("id", assetId).eq("processing_attempt_count", Number(row.processing_attempt_count ?? 0))
    .select("id, processing_lease_token").maybeSingle();
  // Supabase returns error=null for an UPDATE matching zero rows. Requiring
  // the updated row (and the exact lease token) makes a lost race observable.
  if (error || !claimed || claimed.id !== assetId || claimed.processing_lease_token !== leaseToken) return null;
  const { error: attemptError } = await sc.from("media_processing_attempts").upsert({
    media_asset_id: assetId,
    attempt_number: attemptNumber,
    lease_token: leaseToken,
    status: "claimed",
    started_at: now.toISOString(),
  }, { onConflict: "media_asset_id,attempt_number" });
  if (attemptError) {
    // The lease was taken but its attempt row did not land, so nothing would
    // ever record how this attempt ended. Release the lease so the asset is
    // claimable again at its next due time; a failed release is not recoverable
    // here either, and both paths answer "no claim" — the lease simply expires.
    const { error: releaseError } = await sc.from("media_assets").update({
      processing_lease_until: null,
      processing_lease_token: null,
      processing_error: "Could not persist processing attempt",
      updated_at: new Date().toISOString(),
    }).eq("id", assetId).eq("processing_lease_token", leaseToken);
    if (releaseError) {
      console.warn(
        "MediaLifecycleService: a lease whose attempt row failed to persist could not be released — it will expire instead",
        { assetId, code: (releaseError as any)?.code, message: (releaseError as any)?.message },
      );
    }
    return null;
  }
  return { assetId, attemptNumber, leaseToken, leaseUntil: leaseUntil.toISOString() };
}

export async function completeMediaProcessing(
  sc: SupabaseClient,
  claim: ProcessingClaim,
  input: { width: number; height: number; durationMs?: number | null; thumbnailPath?: string | null; thumbnailUrl?: string | null },
): Promise<boolean> {
  if (!Number.isInteger(input.width) || input.width <= 0 || !Number.isInteger(input.height) || input.height <= 0) {
    throw new Error(`completeMediaProcessing: positive dimensions required for ${claim.assetId}`);
  }
  const now = new Date().toISOString();
  const { data: updated, error } = await sc.from("media_assets").update({
    processing_status: "ready",
    processing_completed_at: now,
    processing_next_retry_at: null,
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    processing_terminal: false,
    width: input.width,
    height: input.height,
    duration_ms: input.durationMs ?? null,
    thumbnail_path: input.thumbnailPath ?? null,
    thumbnail_url: input.thumbnailUrl ?? null,
    updated_at: now,
  }).eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken)
    .select("id, processing_lease_token").maybeSingle();
  if (error || !updated || updated.id !== claim.assetId || updated.processing_lease_token !== null) return false;
  const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
    status: "succeeded",
    completed_at: now,
  }).eq("media_asset_id", claim.assetId).eq("attempt_number", claim.attemptNumber).eq("lease_token", claim.leaseToken)
    .select("media_asset_id, attempt_number, lease_token").maybeSingle();
  return !attemptError && !!attempt &&
    attempt.media_asset_id === claim.assetId &&
    Number(attempt.attempt_number) === claim.attemptNumber &&
    attempt.lease_token === claim.leaseToken;
}

export async function failMediaProcessing(
  sc: SupabaseClient,
  claim: ProcessingClaim,
  message: string,
  opts: { maxAttempts?: number; now?: Date } = {},
): Promise<ProcessingResult> {
  const now = opts.now ?? new Date();
  const terminal = claim.attemptNumber >= (opts.maxAttempts ?? DEFAULT_PROCESSING_MAX_ATTEMPTS);
  const nextRetryAt = terminal ? null : retryAt(claim.attemptNumber, now.getTime());
  const nowIso = now.toISOString();
  const { data: updated, error } = await sc.from("media_assets").update({
    // 'failed' either way: `processing_terminal` is what distinguishes a run
    // that will be retried from one that will not, so the status stays the
    // single value the 0191 CHECK vocabulary has for a failed attempt.
    processing_status: "failed",
    processing_terminal: terminal,
    processing_error: message.slice(0, 2000),
    processing_next_retry_at: nextRetryAt,
    processing_lease_until: null,
    processing_lease_token: null,
    updated_at: nowIso,
  }).eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken)
    .select("id, processing_lease_token").maybeSingle();
  if (error || !updated || updated.id !== claim.assetId || updated.processing_lease_token !== null) {
    return { ok: false, terminal, attemptNumber: claim.attemptNumber, nextRetryAt };
  }
  const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
    status: terminal ? "terminal_failure" : "retryable_failure",
    error_message: message.slice(0, 2000),
    completed_at: nowIso,
  }).eq("media_asset_id", claim.assetId)
    .eq("attempt_number", claim.attemptNumber)
    .eq("lease_token", claim.leaseToken)
    .select("media_asset_id, attempt_number, lease_token").maybeSingle();
  return {
    ok: !attemptError && !!attempt &&
      attempt.media_asset_id === claim.assetId &&
      Number(attempt.attempt_number) === claim.attemptNumber &&
      attempt.lease_token === claim.leaseToken,
    terminal,
    attemptNumber: claim.attemptNumber,
    nextRetryAt,
  };
}

export async function recoverStaleMediaProcessing(
  sc: SupabaseClient,
  opts: { now?: Date; retryAfterMs?: number; limit?: number } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const cutoff = now.toISOString();
  const nextRetry = new Date(now.getTime() + (opts.retryAfterMs ?? DEFAULT_RETRY_BASE_MS)).toISOString();
  const { data, error } = await sc.from("media_assets")
    .select("id, processing_attempt_count, processing_lease_token")
    .eq("processing_status", "processing")
    .lt("processing_lease_until", cutoff)
    .limit(opts.limit ?? 100);
  if (error || !data) return 0;
  let recovered = 0;
  for (const row of data as Array<{ id: string; processing_attempt_count?: number; processing_lease_token?: string }>) {
    const result = await sc.from("media_assets").update({
      processing_status: "failed",
      processing_error: "Processing lease expired; scheduled for retry",
      processing_next_retry_at: nextRetry,
      processing_lease_until: null,
      processing_lease_token: null,
      updated_at: cutoff,
    }).eq("id", row.id).eq("processing_lease_token", row.processing_lease_token ?? "")
      .select("id, processing_lease_token").maybeSingle();
    if (!result.error && result.data?.id === row.id && result.data?.processing_lease_token === null) {
      const { data: attempt, error: attemptError } = await sc.from("media_processing_attempts").update({
        status: "recovered",
        error_message: "Processing lease expired; scheduled for retry",
        completed_at: cutoff,
      }).eq("media_asset_id", row.id)
        .eq("attempt_number", Number(row.processing_attempt_count ?? 0))
        .eq("lease_token", row.processing_lease_token ?? "")
        .select("media_asset_id, attempt_number, lease_token").maybeSingle();
      if (!attemptError && attempt &&
          attempt.media_asset_id === row.id &&
          Number(attempt.attempt_number) === Number(row.processing_attempt_count ?? 0) &&
          attempt.lease_token === row.processing_lease_token) {
        recovered++;
      }
    }
  }
  return recovered;
}

const PURGE_COLUMNS = "id, version, storage_bucket, storage_path, size_bytes, thumbnail_path, owner_user_id, media_type, deleted_at, moderation_status, purge_status, updated_at";
const PURGE_RETRY_COOLDOWN_MS = 300000;
const PURGE_STALE_PENDING_MS = 1800000;

interface PurgeOptions {
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  expectedVersion?: number;
}

interface PurgeSource extends DerivativeErasureSource {
  owner_user_id: string;
  thumbnail_path: string | null;
  deleted_at: string;
  updated_at: string;
}

function withdrawnPurgeSource(asset: any, allowCompleted = false): asset is PurgeSource {
  return asset && validAssetId(asset.id) && validAssetId(asset.owner_user_id) && validVersion(asset.version)
    && typeof asset.deleted_at === "string" && Number.isFinite(Date.parse(asset.deleted_at))
    && ["owner_deleted", "removed"].includes(asset.moderation_status) && (["pending", "failed"].includes(asset.purge_status) || allowCompleted && asset.purge_status === "completed")
    && typeof asset.storage_bucket === "string" && asset.storage_bucket.length > 0
    && typeof asset.storage_path === "string" && asset.storage_path.length > 0;
}

async function purgeStorage(client: SupabaseClient, assetId: string, actorUserId: string, options: PurgeOptions = {}): Promise<void> {
  let claimedVersion: number | undefined;
  try {
    await withMediaCleanup(client, async (sc, signal) => {
      const { data: asset, error } = await sc.from("media_assets").select(PURGE_COLUMNS).eq("id", assetId).maybeSingle();
      if (error || !withdrawnPurgeSource(asset, true) || asset.id !== assetId || asset.owner_user_id !== actorUserId
        || (options.expectedVersion !== undefined && asset.version !== options.expectedVersion)) throw new Error("Media purge source changed or unavailable");
      claimedVersion = asset.version;
      const manifest = await sc.rpc("advance_media_object_purge", { p_asset: assetId, p_version: claimedVersion, p_phase: "manifest" });
      const paths: unknown = manifest.data?.paths, generation: unknown = manifest.data?.generation;
      const requiredPaths = [asset.storage_path, asset.thumbnail_path].filter((path): path is string => typeof path === "string" && path.length > 0);
      // SQL supplies exact locators from canonical records and durable receipts.
      // Bound extra locators to this owner or this asset's private lifecycle keys;
      // never interpret a manifest as authority over an arbitrary bucket path.
      const validPurgePath = (path: unknown): path is string => {
        if (typeof path !== "string" || !path || Array.from(path).length > 2048
          || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) return false;
        if (requiredPaths.includes(path) || path.split("/")[0]?.toLowerCase() === asset.owner_user_id) return true;
        const [namespace, id, operation, kind, object, ...extra] = path.split("/");
        if (namespace === "manual-captions") return id === assetId && kind === undefined && /^v[1-9][0-9]*-[a-f0-9]{64}\.json$/.test(operation ?? "");
        if (id !== assetId || !validAssetId(operation) || extra.length) return false;
        return namespace === "_retained" ? kind === "original" && object === undefined
          : namespace === "_recovered" && (object === undefined && /^original\.[a-z0-9]+$/.test(kind ?? "")
            || kind === "objects" && /^[a-f0-9]{64}$/.test(object ?? ""));
      };
      if (manifest.error || manifest.data?.ok !== true || manifest.data.bucket !== asset.storage_bucket
        || generation !== null && (typeof generation !== "string" || !validAssetId(generation)) || !Array.isArray(paths) || !paths.length
        || new Set(paths).size !== paths.length || paths.some(path => !validPurgePath(path))
        || requiredPaths.some(path => !paths.includes(path))) throw new Error("Media purge manifest unavailable");
      const purgePaths = paths as string[];
      const validCompletion = (receipt: any, version: number) => receipt && validAssetId(receipt.id)
        && receipt.purgeProtocol === "verified-objects-v1" && receipt.claimVersion === version && receipt.generation === generation
        && receipt.bucket === asset.storage_bucket && receipt.objectCount === purgePaths.length
        && Array.isArray(receipt.paths) && receipt.paths.length === purgePaths.length
        && receipt.paths.every((path: unknown, index: number) => path === purgePaths[index]);
      if (asset.purge_status === "completed") {
        const receipt = manifest.data.completion;
        if (!receipt || !Number.isSafeInteger(receipt.claimVersion) || receipt.claimVersion >= asset.version
          || !validCompletion(receipt, receipt.claimVersion)) throw new Error("Media purge completion unconfirmed");
        for (const path of purgePaths) {
          if (await retainedObjectIdentity(sc, asset.storage_bucket, path, undefined, true)) throw new Error("Media purge object recreated");
        }
        return;
      }
      await purgeDerivedMedia(sc, asset, options.env);
      signal.throwIfAborted();
      const { data: current, error: currentError } = await sc.from("media_assets").select(PURGE_COLUMNS)
        .eq("id", assetId).eq("version", claimedVersion).eq("owner_user_id", actorUserId).maybeSingle();
      if (currentError || !withdrawnPurgeSource(current) || current.storage_bucket !== asset.storage_bucket
        || current.storage_path !== asset.storage_path || current.thumbnail_path !== asset.thumbnail_path) throw new Error("Media purge source changed or unavailable");
      for (const path of purgePaths) {
        signal.throwIfAborted();
        const existing = await retainedObjectIdentity(sc, asset.storage_bucket, path, undefined, true);
        const token = randomUUID();
        const args = { p_asset: assetId, p_version: claimedVersion, p_path: path };
        const claim = await sc.rpc("advance_media_object_purge", { ...args, p_phase: "started", p_token: token });
        if (claim.error || claim.data?.ok !== true || typeof claim.data.execute !== "boolean" || !validAssetId(claim.data.token)
          || claim.data.execute && claim.data.token !== token) throw new Error("Media object purge authority unconfirmed");
        if (existing && claim.data.execute) {
          try { await sc.storage.from(asset.storage_bucket).remove([path]); }
          catch { signal.throwIfAborted(); }
        }
        if (await retainedObjectIdentity(sc, asset.storage_bucket, path, undefined, true)) {
          throw new Error("Media object purge outcome unknown or object recreated; reconciliation required");
        }
        const absent = await sc.rpc("advance_media_object_purge", { ...args, p_phase: "absent", p_token: claim.data.token });
        const receipt = absent.data?.receipt;
        if (absent.error || absent.data?.ok !== true || !receipt || !validAssetId(receipt.id) || receipt.absent !== true
          || receipt.path !== path || receipt.bucket !== asset.storage_bucket || receipt.generation !== generation
          || receipt.token !== claim.data.token) throw new Error("Media object absence receipt unconfirmed");
      }
      // Prior receipts are evidence of observations, not eternal absence.
      // Recheck all locators before committing completion and its audit together.
      for (const path of purgePaths) {
        if (await retainedObjectIdentity(sc, asset.storage_bucket, path, undefined, true)) throw new Error("Media purge object recreated");
      }
      const completion = await sc.rpc("advance_media_object_purge", { p_asset: assetId, p_version: claimedVersion, p_phase: "completed" });
      const receipt = completion.data?.receipt;
      if (completion.error || completion.data?.ok !== true || !validCompletion(receipt, asset.version)) throw new Error("Media purge completion unconfirmed");
    }, options);
  } catch (error) {
    if (claimedVersion !== undefined) {
      try {
        await withMediaCleanup(client, async sc => {
          const message = error instanceof Error ? error.message : "Media purge failed";
          const { data: failed, error: recordError } = await sc.from("media_assets")
            .update({ purge_status: "failed", purge_error: message.slice(0, 2000), updated_at: new Date().toISOString() })
            .eq("id", assetId).eq("owner_user_id", actorUserId).eq("version", claimedVersion)
            .in("purge_status", ["pending", "failed"]).select("id").maybeSingle();
          if (recordError) throw recordError;
          if (failed?.id === assetId) {
            const { error: auditError } = await sc.from("media_asset_lifecycle_events").insert({ media_asset_id: assetId, actor_user_id: actorUserId,
              event_type: "purge_failed", details: { error: message.slice(0, 2000) } });
            if (auditError) throw auditError;
          }
        }, { timeoutMs: 5000, operationTimeoutMs: options.operationTimeoutMs });
      } catch (recordError) { logger.warn({ assetId, err: recordError }, "media purge failure could not be recorded"); }
    }
    throw error;
  }
}

export async function purgeWithdrawnAccountMedia(client: SupabaseClient, assetId: string, ownerUserId: string,
  options: PurgeOptions & { expectedVersion: number }): Promise<void> {
  if (!validAssetId(assetId) || !validAssetId(ownerUserId) || !validVersion(options.expectedVersion)) throw new Error("Invalid account Media purge identity");
  await purgeStorage(client, assetId, ownerUserId, options);
}

export async function retryFailedMediaPurges(client: SupabaseClient, options: PurgeOptions & { limit?: number } = {}) {
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid purge retry bound");
  return withMediaCleanup(client, async (sc, signal) => {
    const result = { attempted: 0, completed: 0, failed: 0, skipped: 0 };
    const candidates: PurgeSource[] = [];
    for (const status of ["failed", "pending"]) {
      signal.throwIfAborted();
      const cutoff = new Date(Date.now() - (status === "failed" ? PURGE_RETRY_COOLDOWN_MS : PURGE_STALE_PENDING_MS)).toISOString();
      const { data: rows, error } = await sc.from("media_assets").select(PURGE_COLUMNS)
        .eq("purge_status", status).lte("updated_at", cutoff).not("deleted_at", "is", null)
        .order("updated_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
      if (error || !Array.isArray(rows)) throw new Error("Media purge retry state unavailable");
      for (const row of rows) {
        if (!withdrawnPurgeSource(row)) throw new Error("Invalid media purge retry source");
        candidates.push(row);
      }
    }
    candidates.sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));
    for (const row of candidates.slice(0, limit)) {
      signal.throwIfAborted();
      const { data: claim, error: claimError } = await sc.from("media_assets")
        .update({ purge_status: "pending", updated_at: new Date(Date.now()).toISOString() })
        .eq("id", row.id).eq("owner_user_id", row.owner_user_id).eq("version", row.version)
        .eq("purge_status", row.purge_status).eq("updated_at", row.updated_at).select("id, version, purge_status").maybeSingle();
      if (claimError) throw new Error("Media purge retry claim unconfirmed");
      if (!claim) { result.skipped++; continue; }
      if (claim.id !== row.id || !validVersion(claim.version) || claim.version <= row.version || claim.purge_status !== "pending") throw new Error("Invalid media purge retry claim");
      result.attempted++;
      try {
        await purgeStorage(client, row.id, row.owner_user_id, { ...options, signal, expectedVersion: claim.version });
        result.completed++;
      } catch { result.failed++; }
    }
    signal.throwIfAborted();
    return result;
  }, { ...options, timeoutMs: options.timeoutMs ?? 120000 });
}

/** Hide and retain the canonical source. Only explicit admin authority queues purge. */
export async function softDeleteMediaAsset(
  sc: SupabaseClient,
  assetId: string,
  actorUserId: string,
  opts: { logger?: LifecycleLogger | null } = {},
): Promise<SoftDeleteResult> {
  const refused: SoftDeleteResult = { ok: false, alreadyDeleted: false, purgeScheduled: false };
  try {
    const { data, error } = await sc.rpc("retire_media_asset", { p_asset: assetId, p_actor: actorUserId });
    if (error || !data || data.ok !== true || typeof data.alreadyDeleted !== "boolean" || data.purgeScheduled !== false) return refused;
    return { ok: true, alreadyDeleted: data.alreadyDeleted, purgeScheduled: false };
  } catch (error) {
    (opts.logger ?? logger).warn({ assetId, err: error }, "media asset retention could not be confirmed");
    return refused;
  }
}

/** Owner-only retry request. It clears terminal state but leaves attempt history. */
export async function retryMediaProcessing(
  sc: SupabaseClient,
  assetId: string,
  actorUserId: string,
): Promise<RetryProcessingResult> {
  const { data: asset, error: readError } = await sc.from("media_assets")
    .select("id, owner_user_id, processing_status, processing_terminal, purge_status")
    .eq("id", assetId).maybeSingle();
  if (readError) return { ok: false, alreadyQueued: false, dbError: readError.message }; if (!asset || asset.owner_user_id !== actorUserId || asset.purge_status === "completed") {
    return { ok: false, alreadyQueued: false };
  }
  if (asset.processing_status === "queued" || asset.processing_status === "processing") {
    return { ok: true, alreadyQueued: true };
  } const refusal = await retryRefusal(sc, asset.processing_status); if (refusal) return refusal; // census-media §30: only a FAILED run is re-queued, and only while a worker will claim it
  const { data: requeued, error } = await sc.from("media_assets").update({
    processing_status: "queued",
    processing_terminal: false,
    processing_next_retry_at: new Date().toISOString(),
    processing_lease_until: null,
    processing_lease_token: null,
    processing_error: null,
    updated_at: new Date().toISOString(),
  }).eq("id", assetId).eq("owner_user_id", actorUserId).eq("processing_status", "failed").select("id, processing_status").maybeSingle();
  return error ? { ok: false, alreadyQueued: false, dbError: error.message } : requeued?.id === assetId && requeued?.processing_status === "queued" ? { ok: true, alreadyQueued: false } : { ok: false, alreadyQueued: false, notRetryable: true };
}

// ── census-media §30 (MD338): what an owner's retry may re-queue ─────────────
//
// Appended at the end, and the lines of retryMediaProcessing that call it were
// extended in place, because the census cites this file by line.
//
// THE DEFECT. The retry used to refuse only `queued` and `processing`, so a
// `ready` asset was re-queued too — and every canonical reader serves `ready`
// only (`services/wall/WallCandidateLoaders.ts`, `services/intel/PresenceVerifier.ts`),
// so one POST took the owner's asset off every read path. Nothing claimed
// queued work either, so it stayed off them.
//
// THE RULE NOW. Only `failed` is retryable: it is the one value this file writes
// for a run that did not produce a ready asset (`failMediaProcessing` writes it,
// terminal or not; `recoverStaleMediaProcessing` writes it when a lease lapses).
// `ready` has nothing to retry; `removed` is an owner deletion; `rejected` and
// `expired` are not processing outcomes an owner can undo. `queued` and
// `processing` are still answered as `alreadyQueued`, unchanged. The UPDATE is
// also conditional on `processing_status = 'failed'` and reads its row back
// (invariant 1 above), so an asset that became `ready` between the read and the
// write is not re-queued by a lost race either.
//
// AND ONLY WHILE SOMETHING WILL CLAIM IT. A failed asset re-queued while the
// processing worker (`lib/media/mediaProcessingWorker.ts`) is off would be
// parked in `queued` for good — the second half of the same defect. So the
// retry reads the worker's own flag and refuses, writing nothing, while it is
// off, absent or unreadable (isFlagEnabled is fail-closed).

/** The worker's capability flag. Seeded FALSE by migration 3338. */
export const MEDIA_PROCESSING_WORKER_FLAG = "media_processing_worker_enabled";

/**
 * Is the processing worker allowed to run? One reader, shared by the worker's
 * pass and by the retry, so "the worker is on" and "a retry may queue work for
 * it" cannot disagree. Fail-closed: absent, false or unreadable ⇒ false.
 */
export async function isMediaProcessingWorkerEnabled(sc: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(sc, MEDIA_PROCESSING_WORKER_FLAG);
}

/** Why a retry of an owner's own, non-queued asset writes nothing — or null to proceed. */
async function retryRefusal(sc: SupabaseClient, processingStatus: unknown): Promise<RetryProcessingResult | null> {
  if (processingStatus !== "failed") return { ok: false, alreadyQueued: false, notRetryable: true };
  if (!(await isMediaProcessingWorkerEnabled(sc))) return { ok: false, alreadyQueued: false, workerDisabled: true };
  return null;
}

// ── census-media §32.13: the measured size, written where the lifecycle is ────
//
// Appended at the end, because the census cites this file by line.
//
// The processing worker (`lib/media/mediaProcessingWorker.ts`) replaces an
// honest zero `size_bytes` with the stored object's measured size before the
// asset can be completed `ready`. That write used to live in the worker itself,
// which made a file named "worker" a writer of `media_assets` — canonical
// storage, not a projection — and `check:projection-consumers` rightly refused
// it. It is a lease-conditioned lifecycle write like every other in this file,
// so it lives here and keeps invariant 1: conditional on the asset id, the lease
// token the caller holds AND the zero it read (so a recorded size, which every
// upload-route row has, is never overwritten), and read back, because a
// zero-row UPDATE is `error: null` too.

/**
 * Record the stored object's measured size over an honest zero, while `claim`
 * still holds the lease. True only when exactly this asset's row came back: a
 * write error, a lost lease or a size someone else already recorded are all false,
 * and the caller fails the attempt retryably rather than completing it.
 */
export async function recordMeasuredMediaSize(sc: SupabaseClient, claim: ProcessingClaim, sizeBytes: number): Promise<boolean> {
  if (!(Number.isInteger(sizeBytes) && sizeBytes > 0)) return false;
  const { data, error } = await sc.from("media_assets").update({ size_bytes: sizeBytes })
    .eq("id", claim.assetId).eq("processing_lease_token", claim.leaseToken).eq("size_bytes", 0)
    .select("id, size_bytes");
  if (error || !Array.isArray(data) || data.length !== 1) return false;
  return data[0]?.id === claim.assetId && Number(data[0]?.size_bytes) === sizeBytes;
}
