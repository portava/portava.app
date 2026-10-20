import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { createConfiguredImageVariants } from "../lib/media/imageVariants/bridge.js";
import { ImageVariantsReadError, type createImageVariantsService } from "../services/media/ImageVariantsService.js";

export function createMediaImageVariantsRouter(
  resolveService: (sc: SupabaseClient) => ReturnType<typeof createImageVariantsService> | null = sc => createConfiguredImageVariants(sc)?.service ?? null,
) {
  const router = Router();
  router.get(["/media/image-variants/source", "/media/image-variants/:assetId/:generation/:filename"], asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("Pragma", "no-cache"); res.setHeader("Vary", "Authorization, Cookie"); res.setHeader("X-Content-Type-Options", "nosniff");
    const auth = await requireUser(req, res);
    if (!auth) return;
    if (!checkRateLimit("media_image_variants", auth.user.id, 180, 60_000).allowed) { sendError(res, "rate_limited"); return; }
    const sc = getServiceClient();
    if (!sc) { sendError(res, "degraded_unavailable"); return; }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!res.writableFinished) abort(); };
    req.once("aborted", abort); res.once("close", close);
    try {
      const service = resolveService(sc);
      if (!service) throw new ImageVariantsReadError("feature_disabled");
      if (req.params.assetId && !/^[1-9]\d*$/.test(String(req.params.generation))) throw new ImageVariantsReadError("not_found");
      if (!req.params.assetId || req.params.filename === "descriptor") {
        const lookup = req.params.assetId
          ? { assetId: String(req.params.assetId), sourceVersion: Number(req.params.generation) }
          : { reference: typeof req.query.source === "string" ? req.query.source : "" };
        const descriptor = await service.descriptor(auth.user.id, lookup, controller.signal);
        const body = Buffer.from(JSON.stringify(descriptor));
        res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Content-Length", body.length);
        res.end(req.method === "HEAD" ? undefined : body);
      } else {
        const output = await service.readFile(auth.user.id, { assetId: String(req.params.assetId), sourceVersion: Number(req.params.generation) }, String(req.params.filename), controller.signal);
        res.setHeader("Content-Type", output.mime); res.setHeader("Content-Length", output.bytes.length);
        if (req.method === "HEAD") { output.bytes.fill(0); res.end(); }
        else res.end(output.bytes, () => output.bytes.fill(0));
      }
    } catch (error) {
      if (!controller.signal.aborted && !res.headersSent) sendError(res, error instanceof ImageVariantsReadError ? error.code : "degraded_unavailable");
    } finally {
      req.removeListener("aborted", abort); res.removeListener("close", close);
    }
  }));
  return router;
}
