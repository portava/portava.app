import type { SupabaseClient } from "@supabase/supabase-js";
import { isAbsolute } from "node:path";
import { createMediaJobQueue, MediaJobError } from "../jobs/queue.js";
import { decodeAdaptiveOutput } from "./descriptor.js";
import { createSelfHostedAdaptive } from "./service.js";
import { ADAPTIVE_KIND, ADAPTIVE_PIPELINE, type AdaptiveJobs } from "./jobs.js";
import type { AdaptiveConfig } from "./types.js";

export function adaptiveConfig(env: NodeJS.ProcessEnv = process.env): AdaptiveConfig | null {
  if (env.MEDIA_ADAPTIVE_ENABLED !== "true") return null;
  const root = env.MEDIA_ADAPTIVE_ROOT;
  const apiBaseUrl = env.MEDIA_ADAPTIVE_API_BASE_URL;
  const storageOrigin = env.SUPABASE_URL;
  const ffmpeg = env.MEDIA_FFMPEG_BINARY;
  const ffprobe = env.MEDIA_FFPROBE_BINARY;
  if (!root || !isAbsolute(root) || !apiBaseUrl || !storageOrigin || !ffmpeg || !isAbsolute(ffmpeg) || !ffprobe || !isAbsolute(ffprobe)) return null;
  try {
    for (const address of [apiBaseUrl, storageOrigin]) {
      const url = new URL(address);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    }
    return { enabled: true, root, apiBaseUrl, storageOrigin, ffmpeg, ffprobe };
  } catch { return null; }
}

export function createAdaptiveQueueBridge(client: SupabaseClient): AdaptiveJobs {
  const queue = createMediaJobQueue(client);
  return {
    async enqueue(source) {
      const { data, error } = await client.from("media_assets").select("owner_user_id")
        .eq("id", source.assetId).eq("version", source.sourceVersion).eq("storage_bucket", source.bucket)
        .eq("storage_path", source.path).eq("size_bytes", source.sizeBytes).maybeSingle();
      if (error || !data || typeof data.owner_user_id !== "string") throw new MediaJobError("source_unavailable");
      const id = await queue.enqueue({ assetId: source.assetId, ownerUserId: data.owner_user_id, sourceVersion: source.sourceVersion,
        kind: ADAPTIVE_KIND, modelVersion: ADAPTIVE_PIPELINE });
      if (!id) throw new MediaJobError("enqueue_refused");
      return { id };
    },
    async ready(assetId, sourceVersion) {
      const { data, error } = await client.rpc("media_derivative_ready", { p_asset_id: assetId, p_source_version: sourceVersion,
        p_kind: ADAPTIVE_KIND, p_model_version: ADAPTIVE_PIPELINE, p_target_language: "", p_revision_key: "" });
      if (error) throw new MediaJobError("queue_unavailable", true);
      return decodeAdaptiveOutput(data, { assetId, sourceVersion });
    },
    async cancelAsset(assetId) {
      const { data, error } = await client.rpc("media_derivative_cancel_asset", { p_asset_id: assetId });
      if (error || data !== true) throw new MediaJobError("cancellation_unconfirmed", true);
    },
  };
}

export function createConfiguredAdaptiveRuntime(client: SupabaseClient, env: NodeJS.ProcessEnv = process.env) {
  const config = adaptiveConfig(env);
  if (!config) return null;
  try { return createSelfHostedAdaptive(client, config, createAdaptiveQueueBridge(client)); } catch { return null; }
}
