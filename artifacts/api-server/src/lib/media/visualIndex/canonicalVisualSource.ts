import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_IMAGE_BYTES, UUID, validSource, type ConsentGrant, type VisualSource } from "./contracts.js";
import { toCanonicalModerationStatus } from "../mediaAssetContract.js";

const COLUMNS = "id,version,owner_user_id,media_type,storage_bucket,storage_path,public_url,visibility,size_bytes,processing_status,moderation_status,deleted_at,purge_status";
const VISIBILITIES = new Set(["inherit", "public", "private", "followers", "following", "trip_crew", "shared_moment"]);

export interface VisualSourceAccess {
  read(assetId: string): Promise<VisualSource | null>;
  postIds(source: VisualSource): Promise<string[]>;
  visible(viewerId: string, postId: string, source: VisualSource): Promise<boolean>;
}

export function canonicalVisualSource(row: any): VisualSource | null {
  const source = { assetId: row?.id, sourceVersion: row?.version, bucket: row?.storage_bucket, path: row?.storage_path };
  if (!validSource(source) || !UUID.test(row.owner_user_id) || row.media_type !== "image" || row.processing_status !== "ready" ||
      toCanonicalModerationStatus(row.moderation_status) !== "active" || row.deleted_at !== null || row.purge_status !== "not_requested" ||
      !VISIBILITIES.has(row.visibility) || typeof row.public_url !== "string" || !row.public_url ||
      !Number.isSafeInteger(row.size_bytes) || row.size_bytes < 1 || row.size_bytes > MAX_IMAGE_BYTES) return null;
  return { ...source, ownerId: row.owner_user_id, mediaType: "image", publicUrl: row.public_url, visibility: row.visibility, sizeBytes: row.size_bytes };
}

export async function readVisualConsent(sc: SupabaseClient, source: VisualSource, throwOnError = false): Promise<ConsentGrant | null> {
  const { data, error } = await sc.from("media_visual_index_consents").select("revision,expires_at,revoked_at")
    .eq("asset_id", source.assetId).eq("source_version", source.sourceVersion).eq("owner_id", source.ownerId).maybeSingle();
  if (error && throwOnError) throw new Error("visual consent read unavailable");
  if (error || !data || data.revoked_at !== null || !UUID.test(data.revision)) return null;
  const expiresAtMs = Date.parse(data.expires_at);
  return Number.isFinite(expiresAtMs) ? { allowed: true, expiresAtMs, revision: data.revision } : null;
}

export function createCanonicalVisualAccess(sc: SupabaseClient): VisualSourceAccess {
  return {
    async read(assetId) {
      if (!UUID.test(assetId)) return null;
      const { data, error } = await sc.from("media_assets").select(COLUMNS).eq("id", assetId).maybeSingle();
      if (error) throw new Error("canonical visual source unavailable");
      return canonicalVisualSource(data);
    },
    async postIds(source) {
      const { data: canonical, error } = await sc.from("media_attachments").select("entity_id")
        .eq("media_asset_id", source.assetId).eq("entity_type", "post").limit(65);
      if (error || !Array.isArray(canonical) || canonical.length >= 65) throw new Error("visual source mapping unavailable");
      const { data: legacy, error: legacyError } = await sc.from("post_media").select("post_id")
        .eq("storage_path", source.path).eq("public_url", source.publicUrl).eq("processing_status", "ready").limit(65);
      if (legacyError || !Array.isArray(legacy) || legacy.length >= 65) throw new Error("visual source mapping unavailable");
      const ids = [...new Set([...canonical.map((row) => row.entity_id), ...legacy.map((row) => row.post_id)])];
      if (ids.length > 64 || ids.some((id) => typeof id !== "string" || !UUID.test(id))) throw new Error("invalid visual post mapping");
      return ids;
    },
    async visible(viewerId, postId, source) {
      if (!UUID.test(viewerId) || !UUID.test(postId)) return false;
      const [{ resolveViewer }, { searchMedia }, { authorizeMediaAttachment, authorizeMediaContext, mayViewUnderOverride }] = await Promise.all([
        import("../../../services/media/MediaProjectionService.js"), import("../../../services/media/MediaSearchService.js"), import("../../mediaVisibility.js"),
      ]);
      const { data: post, error } = await sc.from("posts").select("author_id,trip_id").eq("id", postId).maybeSingle();
      if (error || !post || post.author_id !== source.ownerId) return false;
      const viewer = await resolveViewer(sc, viewerId, { needFollows: true });
      const result = await searchMedia(sc, viewer, { mediaId: postId }, Date.now());
      const projected = result.media.find((item) => item.id === postId);
      if (!projected || projected.url !== source.publicUrl || projected.mediaType !== "image") return false;
      const context = post.trip_id ? { contextType: "trip" as const, contextId: post.trip_id } : undefined;
      const entity = { entityType: "post" as const, entityId: postId };
      return await mayViewUnderOverride(sc, viewerId, source.ownerId, source.visibility, { context, entity }) &&
        await authorizeMediaAttachment(sc, viewerId, source.ownerId, source.assetId, entity, context) &&
        await authorizeMediaContext(sc, viewerId, source.ownerId, context);
    },
  };
}
