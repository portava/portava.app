import { resolveAccountRestriction } from "../../accountStateGate.js";
import { readFlagState } from "../../capability/schemaCapability.js";
import { toCanonicalModerationStatus } from "../mediaAssetContract.js";
import { posterPathFor } from "../../mediaPosterPath.js";
import { imageUnderstandingPolicy, imageUnderstandingSourceSchema, type ImageUnderstandingContext, type ImageUnderstandingSource } from "./imageUnderstandingContract.js";

export async function assertImageUnderstandingSource(ctx: ImageUnderstandingContext, source: ImageUnderstandingSource, signal: AbortSignal): Promise<{ mime: string; pixelPath: string; updatedAt: string }> {
  imageUnderstandingSourceSchema.parse(source);
  signal.throwIfAborted();
  const policyVersion = imageUnderstandingPolicy(ctx.env ?? process.env, source.ownerId);
  if (!policyVersion || !ctx.consentStillGranted) throw new Error("vision_not_authorized");
  const parts = source.path.split("/");
  if (parts.length < 2 || parts[0] !== source.ownerId || parts.some(part => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === "..")) throw new Error("vision_storage_refused");
  const flag = await readFlagState(ctx.sc, "media_vision_provider_enabled");
  const account = await resolveAccountRestriction(ctx.sc, source.ownerId);
  if (flag === "unreadable" || account.state !== "ok") throw new Error("vision_source_unavailable");
  if (flag !== "on" || account.accountStatus !== "active" || account.restriction.kind !== "none") throw new Error("vision_not_authorized");
  const post = await ctx.sc.from("posts").select("id,author_id,status,post_status,deleted_at").eq("id", source.postId).maybeSingle();
  if (post.error) throw new Error("vision_source_unavailable");
  if (!post.data || post.data.author_id !== source.ownerId || post.data.status !== "active" || post.data.post_status !== "published" || post.data.deleted_at !== null) throw new Error("vision_source_refused");
  const attachment = await ctx.sc.from("post_media").select("id,post_id,user_id,storage_bucket,storage_path,media_type,processing_status,moderation_status").eq("id", source.postMediaId).maybeSingle();
  const item = attachment.data;
  if (attachment.error) throw new Error("vision_source_unavailable");
  if (!item || item.post_id !== source.postId || item.user_id !== source.ownerId || item.storage_bucket !== source.bucket || item.storage_path !== source.path || item.media_type !== source.mediaType || item.processing_status !== "ready" || item.moderation_status !== "approved") throw new Error("vision_source_refused");
  const read = await ctx.sc.from("media_assets").select("id,version,owner_user_id,storage_bucket,storage_path,media_type,mime_type,thumbnail_path,processing_status,moderation_status,deleted_at,purge_status,updated_at").eq("id", source.assetId).maybeSingle();
  const asset = read.data;
  if (read.error) throw new Error("vision_source_unavailable");
  if (!asset || asset.id !== source.assetId || asset.version !== source.sourceVersion || asset.owner_user_id !== source.ownerId || asset.storage_bucket !== source.bucket || asset.storage_path !== source.path || asset.media_type !== source.mediaType || asset.processing_status !== "ready" || toCanonicalModerationStatus(asset.moderation_status) !== "active" || asset.deleted_at !== null || asset.purge_status !== "not_requested" || typeof asset.updated_at !== "string" || !Number.isFinite(Date.parse(asset.updated_at))) throw new Error("vision_source_refused");
  const pixelPath = source.mediaType === "video" ? source.framePath : source.path;
  const mime = source.mediaType === "video" ? "image/jpeg" : asset.mime_type;
  if (!pixelPath || (source.mediaType === "video" && (pixelPath !== posterPathFor(source.path) || asset.thumbnail_path !== pixelPath)) || (source.mediaType === "image" && source.framePath !== null) || !["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("vision_pixels_unavailable");
  if (await ctx.consentStillGranted({ scope: "media_image_understanding", source: { ...source }, policyVersion, signal }) !== true) throw new Error("vision_consent_refused");
  signal.throwIfAborted();
  return { mime, pixelPath, updatedAt: asset.updated_at };
}
