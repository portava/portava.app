import type { SupabaseClient } from "@supabase/supabase-js";
import { authorizeMediaAccess } from "../../mediaAccess.js";
import { isFlagEnabled } from "../../featureFlags.js";
import { appStorageUrlInfo, configuredStorageOrigin } from "../../mediaUrl.js";
import { ADAPTIVE_LIMITS, validAssetId, validVersion, type AdaptiveSource } from "./types.js";

export async function adaptiveEnabled(sc: SupabaseClient, enabled: boolean): Promise<boolean> {
  return enabled && await isFlagEnabled(sc, "media_transcoder_enabled");
}

export async function canonicalSource(sc: SupabaseClient, assetId: string): Promise<AdaptiveSource | null> {
  if (!validAssetId(assetId)) return null;
  const { data, error } = await sc.from("media_assets")
    .select("id, version, owner_user_id, storage_bucket, storage_path, size_bytes, media_type, processing_status, moderation_status, deleted_at, purge_status")
    .eq("id", assetId).maybeSingle();
  if (error) throw new Error("canonical media read unavailable");
  if (!data || data.id !== assetId || !validVersion(data.version) || data.media_type !== "video" ||
      data.processing_status !== "ready" || !["active", "approved"].includes(data.moderation_status) ||
      data.deleted_at !== null || data.purge_status !== "not_requested" || data.storage_bucket !== "post-media" ||
      typeof data.storage_path !== "string" || data.storage_path.length > 1024 || !data.storage_path ||
      typeof data.owner_user_id !== "string" || !validAssetId(data.owner_user_id) || data.storage_path.split("/")[0] !== data.owner_user_id ||
      data.storage_path.split("/").some((part: string) => !part || part === "." || part === "..") || /[\\\x00-\x1f]/.test(data.storage_path) ||
      !validVersion(data.size_bytes) || data.size_bytes > ADAPTIVE_LIMITS.inputBytes) return null;
  return { assetId, sourceVersion: data.version, bucket: data.storage_bucket, path: data.storage_path, sizeBytes: data.size_bytes };
}

export function sameSource(left: AdaptiveSource | null, right: AdaptiveSource): boolean {
  return !!left && left.assetId === right.assetId && left.sourceVersion === right.sourceVersion &&
    left.bucket === right.bucket && left.path === right.path && left.sizeBytes === right.sizeBytes;
}

export async function authorizeAdaptive(sc: SupabaseClient, viewerId: string, source: AdaptiveSource): Promise<boolean> {
  return sameSource(await canonicalSource(sc, source.assetId), source) &&
    await authorizeMediaAccess(sc, viewerId, source.bucket, source.path);
}

export async function adaptiveAssetForReference(sc: SupabaseClient, reference: string): Promise<string | null> {
  if (reference.length > 4096) return null;
  let normalized = reference;
  try {
    const url = new URL(reference);
    if (url.origin !== configuredStorageOrigin() || url.username || url.password || url.hash) return null;
    normalized = `${url.origin}${url.pathname.replace(/^\/storage\/v1\/object\/sign\//, "/storage/v1/object/public/")}`;
  } catch {}
  const storage = appStorageUrlInfo(normalized);
  if (!storage || storage.bucket !== "post-media") return null;
  const { data, error } = await sc.from("media_assets").select("id")
    .eq("storage_bucket", storage.bucket).eq("storage_path", storage.path).maybeSingle();
  if (error || !data || !validAssetId(data.id)) return null;
  return data.id;
}
