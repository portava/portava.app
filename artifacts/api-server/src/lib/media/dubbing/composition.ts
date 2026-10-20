import type { SupabaseClient } from "@supabase/supabase-js";
import type { Router } from "express";
import { requireUser } from "../../http.js";
import { checkRateLimit } from "../../rateLimit.js";
import { isFlagEnabled } from "../../featureFlags.js";
import { createMediaJobQueue, MediaJobError } from "../jobs/queue.js";
import { runMediaWorkerPass, type MediaJobHandler } from "../jobs/worker.js";
import { readCaptionAsset, readCaptionSnapshot, recheckCaptionAsset } from "../../../services/media/AuthoredCaptionsService.js";
import { createMediaDubbingRouter, type MediaDubbingDependencies } from "../../../routes/mediaDubbing.js";
import { DubbingError } from "./contracts.js";
import { parseDubbingEnvironment, type DubbingEnvironment } from "./config.js";
import { dubbingSourceFromCaptionSnapshot } from "./captionBridge.js";
import { createDubbingStore } from "./store.js";
import { createDubbingHandler } from "./handler.js";
import { readDubbingPlaybackOptions } from "./options.js";

export interface DubbingCompositionOptions {
  client: SupabaseClient;
  env?: DubbingEnvironment;
}
export interface DubbingRouterOptions extends DubbingCompositionOptions {
  authenticate?: MediaDubbingDependencies["authenticate"];
  rateLimit?: typeof checkRateLimit;
}

function configuredStore(client: SupabaseClient, bucketName: string | undefined) {
  return createDubbingStore(client, bucketName, {
    async loadTranslatedSource(assetId, ownerId, language) {
      const asset = await readCaptionAsset(client, assetId);
      if (asset.owner_user_id !== ownerId) throw new DubbingError("consent_required");
      const snapshot = await readCaptionSnapshot(client, ownerId, assetId, asset.version);
      await recheckCaptionAsset(client, ownerId, asset);
      return dubbingSourceFromCaptionSnapshot(asset, snapshot, language);
    },
    async canRead(assetId, viewerId) {
      try {
        const asset = await readCaptionAsset(client, assetId);
        await recheckCaptionAsset(client, viewerId, asset);
        return true;
      } catch { return false; }
    },
  });
}

async function enabled(client: SupabaseClient): Promise<boolean> {
  return await isFlagEnabled(client, "media_dubbing_enabled") && await isFlagEnabled(client, "media_derivative_jobs_enabled");
}

export function createConfiguredMediaDubbingRouter(options: DubbingRouterOptions): Router {
  const config = parseDubbingEnvironment(options.env);
  const store = configuredStore(options.client, config.bucketName);
  const authenticate = options.authenticate ?? (async (request, response) => (await requireUser(request, response))?.user.id ?? null);
  const rateLimit = options.rateLimit ?? checkRateLimit;
  return createMediaDubbingRouter({
    ...store,
    engine: config.descriptor,
    queue: createMediaJobQueue(options.client),
    enabled: async () => config.status === "configured" && await enabled(options.client),
    playbackOptions: async ({ assetId, viewerId }) => readDubbingPlaybackOptions(options.client, assetId, viewerId,
      config.status === "configured" && await enabled(options.client), options.env),
    async authenticate(request, response) {
      const actorId = await authenticate(request, response);
      if (!actorId) return null;
      const operation = request.method === "DELETE" ? "withdraw" : request.method === "POST" ? "generate" : "read";
      const limit = rateLimit(`media_dubbing_${operation}`, actorId, 120, 60_000);
      if (!limit.allowed) {
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))));
        response.status(429).json({ error: "rate_limited" });
        return null;
      }
      return actorId;
    },
  });
}

export function createMediaDubbingCleanup(options: DubbingCompositionOptions) {
  const config = parseDubbingEnvironment(options.env);
  const store = configuredStore(options.client, config.bucketName);
  return Object.freeze({ revoke: store.revoke, eraseOwned: store.eraseOwned });
}

export async function eraseDubbingSource(client: SupabaseClient, sourceOwner: string, assetId: string, env: DubbingEnvironment = process.env): Promise<void> {
  const cleanup = createMediaDubbingCleanup({ client, env });
  if (await cleanup.eraseOwned(sourceOwner, assetId) === 100) throw new DubbingError("cleanup_failed");
}

export async function createMediaDubbingWorker(options: DubbingCompositionOptions) {
  const config = parseDubbingEnvironment(options.env);
  if (!config.runtime || !config.descriptor || !config.bucketName) return { status: "disabled", reason: "not_configured" } as const;
  if (!await enabled(options.client)) return { status: "disabled", reason: "flags_off" } as const;
  let engine;
  try {
    const { createPiperSpeech } = await import("./piper.js");
    engine = await createPiperSpeech(config.runtime);
  } catch { return { status: "disabled", reason: "runtime_unavailable" } as const; }
  if (!await enabled(options.client)) return { status: "disabled", reason: "flags_off" } as const;
  const store = configuredStore(options.client, config.bucketName);
  const queue = createMediaJobQueue(options.client);
  const handler = createDubbingHandler({ ...store, engine, jobError: (code, retryable) => new MediaJobError(code, retryable) });
  return Object.freeze({
    status: "ready" as const, handler, queue,
    async runPass(signal: AbortSignal) {
      return runMediaWorkerPass(queue, handler, { enabled: !signal.aborted && await enabled(options.client), concurrency: 1, leaseSeconds: 90, signal });
    },
  });
}

export async function createConfiguredDubbingHandler(client: SupabaseClient, env: DubbingEnvironment = process.env): Promise<MediaJobHandler | null> {
  const worker = await createMediaDubbingWorker({ client, env });
  return worker.status === "ready" ? worker.handler : null;
}
