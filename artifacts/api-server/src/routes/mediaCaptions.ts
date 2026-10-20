import { Router, json } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { MAX_VTT_BYTES } from "../lib/media/vendors/mediaCaptionSource.js";
import { CaptionError, resolveCaptionSource, readAuthoredCaptions, writeAuthoredCaptions, deleteAuthoredCaptions } from "../services/media/AuthoredCaptionsService.js";
import { readCaptionDraft, publishCaptionDraft } from "../services/media/CaptionDraftService.js";
import { enqueueCaptionAsr, getCaptionAsrStatus, revokeCaptionAsr } from "../services/media/CaptionAsrService.js";

const router = Router();
const generation = z.number().int().positive().max(2147483647);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const writeBody = z.object({ version: generation, revisionKey: revision, vtt: z.string().max(MAX_VTT_BYTES), consent: z.literal(true), language: z.string().max(35).default("und") }).strict();
const deleteBody = z.object({ version: generation, revisionKey: revision }).strict();

router.use("/media/captions", json({ limit: "384kb" }), asyncHandler(async (req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization");
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Captions unavailable."); return; }
  const ownerManagement = req.method === "GET" && req.path === "/source" && req.query.manageDubbing === "1";
  if (!ownerManagement && req.method !== "DELETE" && !(req.method === "GET" && req.path.endsWith("/asr")) && !(await isFlagEnabled(sc, "media_captions_enabled"))) { sendError(res, "feature_disabled", "Captions are not enabled."); return; }
  const limit = checkRateLimit("media_captions", auth.user.id, 120, 60_000);
  if (!limit.allowed) { sendError(res, "rate_limited", "Please wait before trying captions again."); return; }
  res.locals.captionUser = auth.user.id;
  res.locals.captionClient = sc;
  next();
}));

function endpoint(run: (req: any, res: any) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { res.json(await run(req, res)); }
    catch (error) {
      if (error instanceof CaptionError) sendError(res, error.code, error.message);
      else sendError(res, "degraded_unavailable", "Captions unavailable. Please retry.");
    }
  });
}

router.get("/media/captions/source", endpoint(async (req, res) => {
  const parsed = z.string().min(1).max(2048).safeParse(req.query.source);
  if (!parsed.success) throw new CaptionError("invalid_payload", "A video reference is required.");
  const source = await resolveCaptionSource(res.locals.captionClient, res.locals.captionUser, parsed.data);
  if (req.query.manageDubbing === "1" && !source.canEdit) throw new CaptionError("not_found", "Owner management unavailable.");
  return source;
}));

router.get("/media/captions/:assetId", endpoint(async (req, res) => {
  const parsed = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(generation).safeParse(req.query.version);
  if (!parsed.success) throw new CaptionError("invalid_payload", "A video generation is required.");
  if (req.query.language !== undefined && typeof req.query.language !== "string") throw new CaptionError("invalid_payload", "Invalid language.");
  return readAuthoredCaptions(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data, req.query.language);
}));

router.put("/media/captions/:assetId", endpoint(async (req, res) => {
  const parsed = writeBody.safeParse(req.body);
  if (!parsed.success) throw new CaptionError("invalid_payload", "Provide WebVTT, version and explicit consent.");
  return writeAuthoredCaptions(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data.version, parsed.data.vtt, parsed.data.consent, parsed.data.language, undefined, parsed.data.revisionKey);
}));

router.delete("/media/captions/:assetId", endpoint(async (req, res) => {
  const parsed = deleteBody.safeParse(req.body);
  if (!parsed.success) throw new CaptionError("invalid_payload", "A video generation is required.");
  return deleteAuthoredCaptions(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data.version, parsed.data.revisionKey);
}));

router.get("/media/captions/:assetId/draft", endpoint(async (req, res) => {
  const parsed = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(generation).safeParse(req.query.version);
  if (!parsed.success) throw new CaptionError("invalid_payload", "A video generation is required.");
  return readCaptionDraft(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data);
}));

router.post("/media/captions/:assetId/draft/publish", endpoint(async (req, res) => {
  const parsed = z.object({ version: generation, revisionKey: revision, draftId: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true), vtt: z.string().max(MAX_VTT_BYTES) }).strict().safeParse(req.body);
  if (!parsed.success) throw new CaptionError("invalid_payload", "Review and consent are required.");
  return publishCaptionDraft(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data.version, parsed.data.draftId, parsed.data.consent, parsed.data.vtt, parsed.data.revisionKey);
}));

export default router;

router.get("/media/captions/:assetId/asr", endpoint(async (req, res) => getCaptionAsrStatus(res.locals.captionClient, res.locals.captionUser, req.params.assetId)));

router.post("/media/captions/:assetId/asr", endpoint(async (req, res) => {
  const parsed = z.object({ version: generation, revisionKey: revision, expectedConsentEpoch: revision, targetLanguage: z.string().max(35).default(""), consent: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) throw new CaptionError("invalid_payload", "Confirm permission for local transcription of this video.");
  if (!checkRateLimit("media_caption_asr_request", res.locals.captionUser, 5, 3600_000).allowed) throw new CaptionError("rate_limited", "Please wait before requesting more transcription.");
  return enqueueCaptionAsr(res.locals.captionClient, res.locals.captionUser, req.params.assetId, parsed.data.version, parsed.data.revisionKey, parsed.data.targetLanguage, parsed.data.consent, parsed.data.expectedConsentEpoch);
}));

router.delete("/media/captions/:assetId/asr", endpoint(async (req, res) => revokeCaptionAsr(res.locals.captionClient, res.locals.captionUser, req.params.assetId)));
