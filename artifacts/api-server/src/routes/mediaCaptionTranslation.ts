import { Router, json } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireUser, sendError } from '../lib/http.js';
import { getServiceClient } from '../lib/supabase.js';
import { checkRateLimit } from '../lib/rateLimit.js';
import { MAX_VTT_BYTES } from '../lib/media/vendors/mediaCaptionSource.js';
import type { CaptionTranslationDraftResponse } from '../lib/media/captions/subtitleTranslationContract.js';
import { CaptionError } from '../services/media/AuthoredCaptionsService.js';
import { enqueueCaptionTranslation, getCaptionTranslationStatus, revokeCaptionTranslation, readCaptionTranslationDraft, publishCaptionTranslation } from '../services/media/CaptionTranslationService.js';

const router = Router();
const base = '/media/caption-translations/:assetId';
const generation = z.number().int().positive().max(2147483647);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const requestBody = z.object({ version: generation, revisionKey: revision, sourceLanguage: z.string().min(2).max(35),
  targetLanguage: z.string().min(2).max(35), consent: z.literal(true), expectedConsentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const publishBody = z.object({ version: generation, revisionKey: revision, draftId: revision, reviewed: z.literal(true),
  vtt: z.string().min(1).max(MAX_VTT_BYTES) }).strict();

router.use('/media/caption-translations', json({ limit: '384kb' }), asyncHandler(async (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Authorization');
  const auth = await requireUser(req, res);
  if (!auth) return;
  const client = getServiceClient();
  if (!client) { sendError(res, 'server_not_configured', 'Subtitle translation unavailable.'); return; }
  if (!checkRateLimit('subtitle_translation', auth.user.id, 120, 60_000).allowed) { sendError(res, 'rate_limited', 'Please wait before trying again.'); return; }
  res.locals.translationUser = auth.user.id;
  res.locals.translationClient = client;
  next();
}));

function endpoint(run: (req: any, res: any) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    try { res.json(await run(req, res)); }
    catch (error) {
      if (error instanceof CaptionError) sendError(res, error.code, error.message);
      else sendError(res, 'degraded_unavailable', 'Subtitle translation unavailable. Please retry.');
    }
  });
}

router.get(base, endpoint(async (req, res) => getCaptionTranslationStatus(res.locals.translationClient, res.locals.translationUser, req.params.assetId)));
router.post(base, endpoint(async (req, res) => {
  const parsed = requestBody.safeParse(req.body);
  if (!parsed.success) throw new CaptionError('invalid_payload', 'Confirm permission for local translation of the original captions.');
  if (!checkRateLimit('subtitle_translation_request', res.locals.translationUser, 5, 3600_000).allowed) throw new CaptionError('rate_limited', 'Please wait before requesting more translation.');
  const input = parsed.data;
  return enqueueCaptionTranslation(res.locals.translationClient, res.locals.translationUser, req.params.assetId,
    input.version, input.revisionKey, input.sourceLanguage, input.targetLanguage, input.consent, input.expectedConsentEpoch);
}));
router.delete(base, endpoint(async (req, res) => revokeCaptionTranslation(res.locals.translationClient, res.locals.translationUser, req.params.assetId)));
router.get(`${base}/draft`, endpoint(async (req, res) => {
  const parsed = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(generation).safeParse(req.query.version);
  if (!parsed.success) throw new CaptionError('invalid_payload', 'An original video version is required.');
  const result = await readCaptionTranslationDraft(res.locals.translationClient, res.locals.translationUser, req.params.assetId, parsed.data);
  if (!result) return { draft: null } satisfies CaptionTranslationDraftResponse;
  const { draft } = result;
  return { draft: { draftId: draft.draftId, version: draft.sourceVersion, revisionKey: draft.revisionKey, vtt: draft.vtt,
    language: draft.language, sourceLanguage: draft.sourceLanguage, aiLabel: draft.aiLabel, modelVersion: draft.modelVersion } } satisfies CaptionTranslationDraftResponse;
}));
router.post(`${base}/draft/publish`, endpoint(async (req, res) => {
  const parsed = publishBody.safeParse(req.body);
  if (!parsed.success) throw new CaptionError('invalid_payload', 'Review and publication permission are required.');
  const input = parsed.data;
  return publishCaptionTranslation(res.locals.translationClient, res.locals.translationUser, req.params.assetId,
    input.version, input.draftId, input.revisionKey, input.reviewed, input.vtt);
}));

export default router;
