import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { createCanonicalVisualAccess } from "../lib/media/visualIndex/canonicalVisualSource.js";
import { createLocalVisualIndexProvider } from "../lib/media/visualIndex/localVisualIndexProvider.js";
import { MAX_INDEX_RETENTION_MS, UUID } from "../lib/media/visualIndex/contracts.js";
import { assertVisualIndexOwnerActive, ownsVisualStorage, visualIndexWorkEnabled } from "../lib/media/visualIndex/visualIndexPolicy.js";

const identity = z.string().regex(UUID);
const versionBody = z.object({ sourceVersion: z.number().int().positive().max(2147483647) }).strict();
const consentBody = versionBody.extend({ scope: z.literal("media_visual_index"), expiresAt: z.string().datetime() }).strict();

export function createMediaVisualIndexRouter(env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  for (const action of ["consent", "enqueue"] as const) {
    router.post(`/media/visual-index/:assetId/${action}`, asyncHandler(async (req, res) => {
      res.setHeader("Cache-Control", "private, no-store");
      const auth = await requireUser(req, res);
      if (!auth) return;
      const userId = auth.user.id;
      if (!UUID.test(userId)) return sendError(res, "unauthenticated");
      const assetId = identity.safeParse(req.params.assetId);
      const body = (action === "consent" ? consentBody : versionBody).safeParse(req.body);
      if (!assetId.success || !body.success) return sendError(res, "invalid_payload");
      const expiresAtMs = action === "consent" ? Date.parse((body.data as z.infer<typeof consentBody>).expiresAt) : null;
      if (expiresAtMs !== null && (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now() || expiresAtMs > Date.now() + MAX_INDEX_RETENTION_MS)) return sendError(res, "invalid_payload");
      if (!checkRateLimit("visual_index_consent_enqueue", userId, 20, 60_000).allowed) return sendError(res, "rate_limited");
      let consentGranted = false;
      try {
        const ctx = { sc: auth.client, env };
        if (!await visualIndexWorkEnabled(ctx)) return sendError(res, "feature_disabled");
        const source = await createCanonicalVisualAccess(auth.client).read(assetId.data);
        if (!source || source.ownerId !== userId || source.sourceVersion !== body.data.sourceVersion || !ownsVisualStorage(source)) return sendError(res, "not_found");
        await assertVisualIndexOwnerActive(auth.client, userId);
        if (action === "consent") {
          const reply = await auth.client.rpc("media_visual_index_consent", { p_asset_id: source.assetId, p_actor_id: userId,
            p_source_version: source.sourceVersion, p_allowed: true, p_expires_at: new Date(expiresAtMs!).toISOString() });
          if (reply.error || typeof reply.data !== "string" || !UUID.test(reply.data)) throw new Error("visual consent write unavailable");
          consentGranted = true;
        } else {
          const grant = await auth.client.from("media_visual_index_consents").select("revision,expires_at,revoked_at")
            .eq("asset_id", source.assetId).eq("owner_id", userId).eq("source_version", source.sourceVersion).maybeSingle();
          if (grant.error) throw new Error("visual consent read unavailable");
          if (!grant.data || !UUID.test(grant.data.revision) || grant.data.revoked_at !== null || !(Date.parse(grant.data.expires_at) > Date.now())) return sendError(res, "not_found");
        }
        const result = await createLocalVisualIndexProvider(ctx).ingest({ assetId: source.assetId, sourceVersion: source.sourceVersion,
          bucket: source.bucket, path: source.path, mediaType: "image", framePath: null });
        if (!result.ok || !result.value.accepted) throw new Error("visual queue unavailable");
        res.status(202).json({ accepted: true, state: "queued", assetId: source.assetId, sourceVersion: source.sourceVersion });
      } catch {
        if (consentGranted) res.status(503).json({ error: "degraded_unavailable", message: "Consent was recorded, but queue acceptance could not be confirmed.", retryable: true, consentGranted: true, queued: null, state: "queue_unconfirmed" });
        else sendError(res, "degraded_unavailable", "Visual indexing is unavailable.");
      }
    }));
  }
  router.delete("/media/visual-index/:assetId/consent", asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const auth = await requireUser(req, res);
    if (!auth) return;
    const userId = auth.user.id;
    if (!UUID.test(userId)) return sendError(res, "unauthenticated");
    const assetId = identity.safeParse(req.params.assetId);
    const body = versionBody.safeParse(req.body);
    if (!assetId.success || !body.success) return sendError(res, "invalid_payload");
    try {
      const { data: source, error } = await auth.client.from("media_assets").select("id,owner_user_id,version").eq("id", assetId.data).maybeSingle();
      if (error) throw new Error("visual source unavailable");
      if (!source || source.owner_user_id !== userId || source.version !== body.data.sourceVersion) return sendError(res, "not_found");
      const reply = await auth.client.rpc("media_visual_index_consent", { p_asset_id: assetId.data, p_actor_id: userId,
        p_source_version: body.data.sourceVersion, p_allowed: false, p_expires_at: null });
      if (reply.error || reply.data !== null) throw new Error("visual revoke unavailable");
      const grant = await auth.client.from("media_visual_index_consents").select("revoked_at").eq("asset_id", assetId.data).maybeSingle();
      const vectors = await auth.client.from("media_visual_embeddings").select("asset_id").eq("asset_id", assetId.data).limit(1);
      if (grant.error || vectors.error || (grant.data && !grant.data.revoked_at) || !Array.isArray(vectors.data) || vectors.data.length !== 0) throw new Error("visual revoke incomplete");
      res.status(204).end();
    } catch { sendError(res, "degraded_unavailable", "Visual index revocation could not be confirmed."); }
  }));
  return router;
}
