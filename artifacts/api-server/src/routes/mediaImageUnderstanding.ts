import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { imageUnderstandingPolicy, withImageUnderstandingSignal } from "../lib/media/vendors/imageUnderstandingContract.js";
import { createImageUnderstandingProvider, readImageUnderstandingArtifact, sourceForImageUnderstandingAttachment } from "../lib/media/vendors/imageUnderstandingProvider.js";

const attachmentSchema = z.string().uuid();
const grantSchema = z.object({ sourceVersion: z.number().int().positive().max(2147483647), policyVersion: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), scope: z.literal("media_image_understanding") }).strict();

export function createMediaImageUnderstandingRouter(env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  router.get("/media/image-understanding/:postMediaId", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    res.setHeader("Cache-Control", "private, no-store");
    const postMediaId = attachmentSchema.safeParse(req.params.postMediaId);
    if (!postMediaId.success) return sendError(res, "invalid_payload");
    const reply = await readImageUnderstandingArtifact({ sc: auth.client, env }, { viewerId: auth.user.id, postMediaId: postMediaId.data });
    if (!reply.ok) return sendError(res, reply.reason === "error" || reply.reason === "timeout" ? "degraded_unavailable" : "not_found");
    const artifact = reply.value;
    res.json({ source: { assetId: artifact.source.assetId, sourceVersion: artifact.source.sourceVersion, postId: artifact.source.postId, postMediaId: artifact.source.postMediaId },
      model: { id: artifact.recognition.modelId, revision: artifact.recognition.modelRevision, taxonomyVersion: artifact.recognition.taxonomyVersion },
      processedAt: artifact.processedAt, inferenceMs: artifact.recognition.inferenceMs, pixelScope: artifact.pixelScope,
      confidenceKind: artifact.recognition.confidenceKind, candidates: artifact.recognition.travelCandidates,
      verified: false, eligibleAsObservation: false, unsupported: ["specific_landmark", "city", "country", "face_identity", "sensitive_attributes"] });
  }));
  router.post("/media/image-understanding/:postMediaId/consent", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const postMediaId = attachmentSchema.safeParse(req.params.postMediaId);
    const body = grantSchema.safeParse(req.body);
    if (!postMediaId.success || !body.success) return sendError(res, "invalid_payload");
    const policy = imageUnderstandingPolicy(env, auth.user.id);
    if (!policy || body.data.policyVersion !== policy) return sendError(res, "feature_disabled");
    if (!checkRateLimit("image_understanding_consent", auth.user.id, 20, 60_000).allowed) return sendError(res, "rate_limited");
    const signal = AbortSignal.timeout(10_000);
    try {
      const answer = await withImageUnderstandingSignal(async () => {
        const attachment = await auth.client.from("post_media").select("id,post_id,user_id,storage_bucket,storage_path").eq("id", postMediaId.data).eq("user_id", auth.user.id).maybeSingle();
        if (attachment.error || !attachment.data) return null;
        const ctx = { sc: auth.client, env };
        const source = await sourceForImageUnderstandingAttachment(ctx, attachment.data);
        if (source.ownerId !== auth.user.id || source.sourceVersion !== body.data.sourceVersion) return null;
        signal.throwIfAborted();
        const granted = await auth.client.rpc("media_image_understanding_grant", { p_source: source, p_owner_user_id: auth.user.id, p_policy_version: policy });
        if (granted.error || granted.data !== true) return null;
        signal.throwIfAborted();
        return createImageUnderstandingProvider(ctx).ingest({ assetId: source.assetId, sourceVersion: source.sourceVersion, mediaType: source.mediaType, bucket: source.bucket, path: source.path, framePath: source.framePath });
      }, signal);
      if (!answer?.ok) return sendError(res, "not_found");
      res.status(202).json({ accepted: true, state: "queued", jobKey: answer.value.jobKey, verified: false });
    } catch { sendError(res, "degraded_unavailable", "Image understanding is unavailable."); }
  }));
  router.delete("/media/image-understanding/:postMediaId/consent", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const postMediaId = attachmentSchema.safeParse(req.params.postMediaId);
    if (!postMediaId.success) return sendError(res, "invalid_payload");
    try {
      const reply = await withImageUnderstandingSignal(async () => auth.client.rpc("media_image_understanding_revoke", { p_post_media_id: postMediaId.data, p_owner_user_id: auth.user.id }), AbortSignal.timeout(10_000));
      if (reply.error) return sendError(res, "degraded_unavailable");
      res.status(204).end();
    } catch { sendError(res, "degraded_unavailable"); }
  }));
  return router;
}
