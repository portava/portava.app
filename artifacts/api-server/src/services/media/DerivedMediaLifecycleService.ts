import type { SupabaseClient } from "@supabase/supabase-js";
import { isAbsolute, join } from "node:path";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { AdaptiveArtifacts } from "../../lib/media/adaptive/artifacts.js";
import { createAdaptiveQueueBridge } from "../../lib/media/adaptive/runtime.js";
import { eraseVisualIndexAsset } from "../../lib/media/visualIndex/postgresVisualIndex.js";
import { purgeAuthoredCaptionTracks } from "./AuthoredCaptionsService.js";
import { purgeRevokedTranslationDrafts, revokeCaptionTranslation } from "./CaptionTranslationService.js";
import { eraseDubbingSource } from "../../lib/media/dubbing/composition.js";
import { validAssetId } from "../../lib/media/adaptive/types.js";

export interface DerivativeErasureSource {
  id: string;
  owner_user_id?: string;
  version: number;
  storage_bucket: string;
  storage_path: string;
  size_bytes?: number;
  media_type: string;
  deleted_at: string | null;
  moderation_status: string;
  purge_status: string;
}

const DERIVATIVE_TABLES = ["media_derivative_jobs", "media_caption_manifests", "media_visual_embeddings", "media_image_understanding_artifacts", "media_dubbing_artifacts"] as const;
type DerivativeSchema = Record<typeof DERIVATIVE_TABLES[number], boolean>;

async function existingPrivateRoot(root: string): Promise<string> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Original private artifact volume unavailable");
  return realpath(root);
}

async function existingImageRoot(root: string): Promise<string> {
  const resolved = await existingPrivateRoot(root);
  const expected = "portava-private-image-variants:v1\n";
  const handle = await open(join(resolved, ".image-variants-root"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(expected)) throw new Error("Original image artifact root marker unavailable");
    const buffer = Buffer.alloc(stat.size);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead !== buffer.length || buffer.toString() !== expected) throw new Error("Invalid image artifact root marker");
  } finally { await handle.close(); }
  for (const name of ["assets", "locks", "revoked"]) await existingPrivateRoot(join(resolved, name));
  return resolved;
}

export async function derivativeSchemaStatus(sc: SupabaseClient): Promise<DerivativeSchema | null> {
  const { data: marker, error: markerError } = await sc.from("feature_flags").select("flag")
    .eq("flag", "media_derivative_jobs_enabled").maybeSingle();
  if (markerError || marker === undefined) throw new Error("Derivative erasure schema unavailable");
  if (!marker) return null;
  if (marker.flag !== "media_derivative_jobs_enabled") throw new Error("Derivative erasure schema invalid");
  const { data, error } = await sc.rpc("media_derivative_schema_status");
  if (error) throw new Error("Derivative erasure schema unavailable");
  if (!data || typeof data !== "object" || Array.isArray(data)
    || DERIVATIVE_TABLES.some(table => typeof data[table] !== "boolean")
    || data.media_derivative_jobs !== true) throw new Error("Derivative erasure schema invalid");
  return data as DerivativeSchema;
}

async function purgeCaptionTranslation(sc: SupabaseClient, source: DerivativeErasureSource): Promise<void> {
  const marker = await sc.from("feature_flags").select("flag").eq("flag", "media_caption_translation_enabled").maybeSingle();
  if (marker.error) throw new Error("Caption translation erasure schema unavailable");
  if (marker.data === null) return;
  if (marker.data?.flag !== "media_caption_translation_enabled") throw new Error("Caption translation erasure schema invalid");
  if (!source.owner_user_id || !validAssetId(source.owner_user_id)) throw new Error("Canonical source owner required for translation erasure");
  const revoked = await revokeCaptionTranslation(sc, source.owner_user_id, source.id);
  await purgeRevokedTranslationDrafts(sc, source.id);
  if (revoked.revoked !== true || revoked.cleanupPending !== false) throw new Error("Caption translation cleanup needs retry; writer quiescence unconfirmed");
  const remaining = await sc.from("media_caption_translation_consents").select("id")
    .eq("asset_id", source.id).eq("cleanup_pending", true).limit(1);
  if (remaining.error || !Array.isArray(remaining.data) || remaining.data.length) throw new Error("Caption translation cleanup debt unconfirmed");
  const retained = await sc.from("media_caption_translation_artifacts").select("id").eq("asset_id", source.id).limit(1);
  if (retained.error || !Array.isArray(retained.data) || retained.data.length) throw new Error("Caption translation retained cleanup debt unconfirmed");
}

export async function purgeDerivedMedia(sc: SupabaseClient, source: DerivativeErasureSource, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!source.deleted_at && !["owner_deleted", "removed"].includes(source.moderation_status)) throw new Error("Source must be withdrawn before derivative erasure");
  const schema = await derivativeSchemaStatus(sc);
  if (!schema) return;
  if (schema.media_derivative_jobs) {
    await createAdaptiveQueueBridge(sc).cancelAsset(source.id);
    const { data, error } = await sc.from("media_derivative_jobs").select("id")
      .eq("asset_id", source.id).eq("kind", "adaptive_video").limit(1);
    if (error || !Array.isArray(data)) throw new Error("Adaptive erasure state unavailable");
    if (data.length || env.MEDIA_ADAPTIVE_ROOT) {
      if (!env.MEDIA_ADAPTIVE_ROOT || !isAbsolute(env.MEDIA_ADAPTIVE_ROOT)) throw new Error("Adaptive erasure requires the original private artifact volume");
      const artifacts = new AdaptiveArtifacts(await existingPrivateRoot(env.MEDIA_ADAPTIVE_ROOT));
      await artifacts.assertCleanupRoot();
      await artifacts.erase(source.id);
    }
  }
  if (source.media_type === "video" && schema.media_caption_manifests) {
    await purgeCaptionTranslation(sc, source);
    await purgeAuthoredCaptionTracks(sc, source.id);
  }
  if (schema.media_visual_embeddings) {
    await eraseVisualIndexAsset(sc, { assetId: source.id, sourceVersion: source.version, bucket: source.storage_bucket, path: source.storage_path });
  }
  if (schema.media_dubbing_artifacts) {
    if (!source.owner_user_id || !validAssetId(source.owner_user_id)) throw new Error("Canonical source owner required for dubbing erasure");
    await eraseDubbingSource(sc, source.owner_user_id, source.id, env);
  }
  if (source.media_type === "image") {
    const { data, error } = await sc.from("media_derivative_jobs").select("id")
      .eq("asset_id", source.id).eq("kind", "image_variants").limit(1);
    if (error || !Array.isArray(data)) throw new Error("Image variant erasure state unavailable");
    if (data.length || env.MEDIA_IMAGE_VARIANTS_ROOT) {
      if (!env.MEDIA_IMAGE_VARIANTS_ROOT || !isAbsolute(env.MEDIA_IMAGE_VARIANTS_ROOT)) throw new Error("Image variant erasure requires the original private artifact volume");
      if (!source.owner_user_id || source.storage_bucket !== "post-media") throw new Error("Canonical image source required for erasure");
      const { createImageVariantsRuntime, imageVariantsConfigFromEnv } = await import("../../lib/media/imageVariants/runtime.js");
      const root = await existingImageRoot(env.MEDIA_IMAGE_VARIANTS_ROOT);
      const runtime = createImageVariantsRuntime(sc, { ...imageVariantsConfigFromEnv(env), root });
      await runtime.eraseSource({ assetId: source.id, ownerUserId: source.owner_user_id, sourceVersion: source.version,
        bucket: source.storage_bucket, path: source.storage_path, sizeBytes: source.size_bytes ?? 0 });
    }
  }
}
