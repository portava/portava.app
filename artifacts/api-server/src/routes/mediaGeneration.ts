import { Router, type Response } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { enqueueGeneration } from "../lib/media/generation/worker.js";
import { GenerationError, generationInput } from "../lib/media/generation/higgsfield.js";
import { deleteGeneration, generationAvailability, listGenerationJobs, previewGeneration, publicJob, reserveGeneration } from "../lib/media/generation/service.js";

function failure(res: Response, error: unknown) {
  const code = error instanceof GenerationError ? error.code : "generation_unavailable";
  if (code === "generation_disabled") return sendError(res, "feature_disabled");
  if (code === "generation_not_found") return sendError(res, "not_found");
  if (code === "generation_budget_exceeded") return sendError(res, "rate_limited", "The generation allowance has been reached. Try again tomorrow.");
  if (code === "generation_request_conflict") return res.status(409).json({ error: code, message: "This request was already used for a different draft." });
  return sendError(res, "degraded_unavailable", "Generation is temporarily unavailable.");
}
export function createMediaGenerationRouter(env: Record<string, string | undefined> = process.env) {
  const router = Router();
  router.use("/media/generation", (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  router.get("/media/generation", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res); if (!auth) return;
    try {
      const availability = await generationAvailability(auth.client, env);
      // Existing private drafts remain manageable with new submissions disabled.
      const jobs = await listGenerationJobs(auth.client, auth.user.id);
      res.json({ ...availability, jobs });
    } catch (error) { failure(res, error); }
  }));
  router.post("/media/generation", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res); if (!auth) return;
    const parsed = generationInput.safeParse(req.body);
    if (!parsed.success) return sendError(res, "invalid_payload");
    if (!checkRateLimit("media_generation_submit", auth.user.id, 8, 60_000).allowed) return sendError(res, "rate_limited");
    try {
      const job = await reserveGeneration(auth.client, auth.user.id, parsed.data, env);
      await enqueueGeneration(job.id);
      res.status(202).json(publicJob(job));
    }
    catch (error) { failure(res, error); }
  }));
  router.get("/media/generation/:id/preview", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res); if (!auth) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return sendError(res, "invalid_payload");
    try { res.json(await previewGeneration(auth.client, auth.user.id, id.data)); }
    catch (error) { failure(res, error); }
  }));
  router.delete("/media/generation/:id", asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res); if (!auth) return;
    const id = z.string().uuid().safeParse(req.params.id);
    if (!id.success) return sendError(res, "invalid_payload");
    try { const deletedId = await deleteGeneration(auth.client, auth.user.id, id.data); if (deletedId) await enqueueGeneration(deletedId); res.status(202).json({ accepted: true }); }
    catch (error) { failure(res, error); }
  }));
  return router;
}
