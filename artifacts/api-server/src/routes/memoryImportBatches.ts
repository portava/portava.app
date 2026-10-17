import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  abortMemoryImportBatch, createMemoryImportBatch, getMemoryImportBatch, stepMemoryImportBatch,
  memoryImportAvailability, memoryImportCreateSchema, memoryImportStepSchema,
  type MemoryImportFailure, type MemoryImportResult,
} from "../services/memory/memoryImportBatches.js";

const router = Router();
const uuid = z.string().uuid();

router.use("/memory-import-batches", (_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
  next();
});

function reject(res: Response, reason: MemoryImportFailure) {
  if (reason === "not_found") return sendError(res, "not_found", "Import batch or source not found");
  if (reason === "invalid_payload") return sendError(res, "invalid_payload", "Invalid import request");
  if (reason === "feature_disabled") return sendError(res, "feature_disabled", "Historical backfill is not available");
  if (reason === "idempotency_conflict" || reason === "checkpoint_conflict") {
    return res.status(409).json({ error: reason, message: "Import request conflicts with stored progress" });
  }
  return sendError(res, "degraded_unavailable", "Import progress could not be confirmed. Read progress before retrying.", { reason });
}

function respond(res: Response, result: MemoryImportResult, created = false) {
  if (!result.ok) return reject(res, result.reason);
  return res.status(created && !result.duplicate ? 201 : 200).json(result);
}

async function gate(req: Request, res: Response, write: boolean) {
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const client = getServiceClient();
  if (!client) { sendError(res, "server_not_configured", "Service client not ready"); return null; }
  const unavailable = await memoryImportAvailability(client, write);
  if (unavailable) { reject(res, unavailable); return null; }
  return { client, ownerId: auth.user.id };
}

router.post("/memory-import-batches", asyncHandler(async (req: Request, res: Response) => {
  const access = await gate(req, res, true);
  if (!access) return;
  const body = memoryImportCreateSchema.safeParse(req.body);
  const key = uuid.safeParse(req.get("Idempotency-Key"));
  if (!body.success || !key.success) { reject(res, "invalid_payload"); return; }
  respond(res, await createMemoryImportBatch(access.client, access.ownerId, key.data, body.data.memoryIds), true);
}));

router.get("/memory-import-batches/:id", asyncHandler(async (req: Request, res: Response) => {
  const access = await gate(req, res, false);
  if (!access) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success) { reject(res, "not_found"); return; }
  respond(res, await getMemoryImportBatch(access.client, access.ownerId, id.data));
}));

router.post("/memory-import-batches/:id/step", asyncHandler(async (req: Request, res: Response) => {
  const access = await gate(req, res, true);
  if (!access) return;
  const id = uuid.safeParse(req.params.id);
  const body = memoryImportStepSchema.safeParse(req.body);
  if (!id.success || !body.success) { reject(res, "invalid_payload"); return; }
  respond(res, await stepMemoryImportBatch(access.client, access.ownerId, id.data, body.data.checkpoint, body.data.limit));
}));

router.post("/memory-import-batches/:id/abort", asyncHandler(async (req: Request, res: Response) => {
  const access = await gate(req, res, false);
  if (!access) return;
  const id = uuid.safeParse(req.params.id);
  if (!id.success || !z.object({}).strict().safeParse(req.body ?? {}).success) { reject(res, "invalid_payload"); return; }
  respond(res, await abortMemoryImportBatch(access.client, access.ownerId, id.data));
}));

export default router;
