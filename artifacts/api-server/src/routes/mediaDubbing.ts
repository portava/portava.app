import { Router, json, type Request, type Response, type NextFunction } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import type { MediaJobQueue } from "../lib/media/jobs/queue.js";
import { DUBBING_DISCLOSURE_VERSION, DUBBING_LABEL, DubbingError, languageSchema, validateDubbingInput, type SyntheticSpeechDescriptor, type TimedDubbingInput } from "../lib/media/dubbing/contracts.js";
import { dubbingRevision, type DubbingManifest } from "../lib/media/dubbing/render.js";
import { decodeWave } from "../lib/media/dubbing/wav.js";
import type { DubbingPlaybackOptions } from "../lib/media/dubbing/options.js";

const requestSchema = z.object({ targetLanguage: languageSchema, explicitOptIn: z.literal(true), disclosureVersion: z.literal(DUBBING_DISCLOSURE_VERSION), expectedConsentRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const assetSchema = z.string().uuid();

export interface MediaDubbingDependencies {
  enabled(): Promise<boolean>;
  authenticate(request: Request, response: Response): Promise<string | null>;
  engine?: SyntheticSpeechDescriptor;
  queue: Pick<MediaJobQueue, "enqueue">;
  grantAndLoad(input: { assetId: string; actorId: string; targetLanguage: string; disclosureVersion: typeof DUBBING_DISCLOSURE_VERSION; expectedConsentRevision: string }): Promise<TimedDubbingInput>;
  consentState(input: { assetId: string; actorId: string; targetLanguage: string }): Promise<{ consentRevision: string; optedIn: boolean }>;
  assertCurrent(input: TimedDubbingInput): Promise<void>;
  revoke(input: { assetId: string; actorId: string }): Promise<void>;
  read(input: { assetId: string; viewerId: string; targetLanguage: string }): Promise<{ audio: Buffer; manifest: DubbingManifest } | null>;
  assertReadable(input: { assetId: string; viewerId: string; manifest: DubbingManifest }): Promise<void>;
  playbackOptions?(input: { assetId: string; viewerId: string }): Promise<DubbingPlaybackOptions>;
}

export function createMediaDubbingRouter(dependencies?: MediaDubbingDependencies): Router {
  const router = Router();
  router.use("/media/:assetId/dubbing", (_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    next();
  });
  router.use("/media/:assetId/dubbing", json({ limit: "2kb", strict: true }));
  const identity = async (request: Request, response: Response, requireEnabled = true) => {
    if (!dependencies || (requireEnabled && !await dependencies.enabled())) { response.status(503).json({ error: "dubbing_unavailable" }); return null; }
    const actorId = await dependencies.authenticate(request, response);
    if (!actorId) { if (!response.headersSent) response.status(401).json({ error: "authentication_required" }); return null; }
    const parsed = assetSchema.safeParse(request.params.assetId);
    if (!parsed.success) { response.status(400).json({ error: "invalid_input" }); return null; }
    return { assetId: parsed.data, actorId };
  };
  const failure = (response: Response, error: unknown) => {
    if (response.headersSent) return;
    const code = error instanceof DubbingError ? error.code : "dubbing_unavailable";
    const status = code === "invalid_input" || code === "unsupported_language" ? 400 : code === "consent_required" || code === "source_revoked" ? 409 : 503;
    response.status(status).json({ error: code });
  };
  router.post("/media/:assetId/dubbing", asyncHandler(async (request, response) => {
    try {
      const actor = await identity(request, response);
      if (!actor || !dependencies) return;
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) throw new DubbingError("invalid_input");
      if (!dependencies.engine) throw new DubbingError("not_configured");
      if (parsed.data.targetLanguage !== dependencies.engine.language) throw new DubbingError("unsupported_language");
      const input = validateDubbingInput(await dependencies.grantAndLoad({ ...actor, targetLanguage: parsed.data.targetLanguage, disclosureVersion: parsed.data.disclosureVersion, expectedConsentRevision: parsed.data.expectedConsentRevision }));
      if (input.assetId !== actor.assetId || input.ownerId !== actor.actorId || input.requestedBy !== actor.actorId || input.targetLanguage !== parsed.data.targetLanguage) throw new DubbingError("source_revoked");
      await dependencies.assertCurrent(input);
      const jobId = await dependencies.queue.enqueue({ assetId: input.assetId, ownerUserId: input.ownerId, sourceVersion: input.sourceVersion, kind: "dubbing", modelVersion: dependencies.engine.modelVersion, targetLanguage: input.targetLanguage, revisionKey: dubbingRevision(input, dependencies.engine) });
      if (!jobId) throw new DubbingError("not_configured");
      response.status(202).json({ jobId, label: DUBBING_LABEL, status: "queued", originalPreserved: true });
    } catch (error) { failure(response, error); }
  }));
  router.delete("/media/:assetId/dubbing", asyncHandler(async (request, response) => {
    try {
      const actor = await identity(request, response, false);
      if (!actor || !dependencies) return;
      await dependencies.revoke(actor);
      response.status(204).end();
    } catch (error) { failure(response, error); }
  }));
  router.get("/media/:assetId/dubbing", asyncHandler(async (request, response) => {
    try {
      const actor = await identity(request, response, false);
      if (!actor || !dependencies) return;
      const language = languageSchema.safeParse(request.query.language);
      if (!language.success) throw new DubbingError("invalid_input");
      const state = await dependencies.consentState({ ...actor, targetLanguage: language.data });
      response.json({ ...state, label: DUBBING_LABEL, disclosureVersion: DUBBING_DISCLOSURE_VERSION });
    } catch (error) { failure(response, error); }
  }));
  router.get("/media/:assetId/dubbing/options", asyncHandler(async (request, response) => {
    try {
      const actor = await identity(request, response, false);
      if (!actor || !dependencies) return;
      if (!dependencies.playbackOptions) throw new DubbingError("not_configured");
      response.json(await dependencies.playbackOptions({ assetId: actor.assetId, viewerId: actor.actorId }));
    } catch (error) { failure(response, error); }
  }));
  router.get("/media/:assetId/dubbing/audio", asyncHandler(async (request, response) => {
    try {
      const actor = await identity(request, response);
      if (!actor || !dependencies) return;
      const language = languageSchema.safeParse(request.query.language);
      if (!language.success) throw new DubbingError("invalid_input");
      const output = await dependencies.read({ assetId: actor.assetId, viewerId: actor.actorId, targetLanguage: language.data });
      if (!output) { response.status(404).json({ error: "not_found" }); return; }
      const manifest = output.manifest;
      if (manifest.kind !== "synthetic_dubbing" || manifest.label !== DUBBING_LABEL || manifest.assetId !== actor.assetId || manifest.language !== language.data || manifest.voiceCloning !== false || manifest.training !== false || manifest.originalPreserved !== true || manifest.bytes !== output.audio.length || manifest.sha256 !== createHash("sha256").update(output.audio).digest("hex")) throw new DubbingError("integrity_failed");
      const audio = decodeWave(output.audio);
      if (audio.sampleRate !== manifest.sampleRate || audio.samples.length / 2 / audio.sampleRate * 1000 !== manifest.durationMs) throw new DubbingError("integrity_failed");
      await dependencies.assertReadable({ assetId: actor.assetId, viewerId: actor.actorId, manifest });
      response.setHeader("X-AI-Generated", "synthetic-dubbing");
      response.setHeader("Content-Disposition", 'inline; filename="ai-dub.wav"');
      response.type("audio/wav").send(output.audio);
    } catch (error) { failure(response, error); }
  }));
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = (error as { status?: number } | null)?.status;
    response.status(status === 413 ? 413 : 400).json({ error: "invalid_input" });
  });
  return router;
}

export default createMediaDubbingRouter();
