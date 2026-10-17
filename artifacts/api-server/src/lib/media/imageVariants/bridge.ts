import type { SupabaseClient } from "@supabase/supabase-js";
import { isAbsolute, resolve } from "node:path";
import { createMediaJobQueue } from "../jobs/queue.js";
import { createImageVariantsService } from "../../../services/media/ImageVariantsService.js";
import { createImageVariantsRuntime, imageVariantsConfigFromEnv } from "./runtime.js";
import { createImageVariantsAccess, imageSource } from "./canonical.js";
import { UUID } from "./contracts.js";

export interface ImageVariantsIngestSubject {
  assetId: string | null;
  sourceVersion?: number | null;
  bucket: string;
  path: string;
  mediaType: "image" | "video";
}

export function createConfiguredImageVariants(sc: SupabaseClient, env: NodeJS.ProcessEnv = process.env) {
  const config = imageVariantsConfigFromEnv(env);
  if (!config.enabled) return null;
  const origin = new URL(config.storageOrigin);
  if (!isAbsolute(config.root) || resolve(config.root) === "/" || origin.protocol !== "https:" ||
      origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw new Error("image variants configuration unavailable");
  const runtime = createImageVariantsRuntime(sc, config, { queue: createMediaJobQueue(sc) });
  return { ...runtime, service: createImageVariantsService(sc, config, runtime) };
}

export async function enqueueConfiguredImageVariants(sc: unknown, subject: ImageVariantsIngestSubject,
  env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.MEDIA_IMAGE_VARIANTS_ENABLED !== "1" || subject.mediaType !== "image" || !subject.assetId || !UUID.test(subject.assetId) ||
      typeof subject.sourceVersion !== "number" || !Number.isSafeInteger(subject.sourceVersion) || subject.sourceVersion < 1 || subject.sourceVersion > 2147483647 ||
      subject.bucket !== "post-media" || typeof subject.path !== "string" || !subject.path || subject.path.length > 1024) return null;
  const client = sc as SupabaseClient | null;
  if (!client || typeof client.from !== "function" || typeof client.rpc !== "function") throw new Error("image variants client unavailable");
  const configured = createConfiguredImageVariants(client, env);
  if (!configured) return null;
  const signal = AbortSignal.timeout(10_000);
  const access = createImageVariantsAccess(client, imageVariantsConfigFromEnv(env));
  if (!await access.enabled(signal)) return null;
  const row = await access.row(subject.assetId, signal);
  const source = imageSource(row);
  if (!source || row?.media_type !== "image" || source.assetId !== subject.assetId || source.sourceVersion !== subject.sourceVersion ||
      source.bucket !== subject.bucket || source.path !== subject.path) return null;
  return configured.enqueue(source, signal);
}
