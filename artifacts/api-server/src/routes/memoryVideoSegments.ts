import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError, type ApiErrorCode } from "../lib/http.js";
import {
  createMemoryVideoSegment, deleteMemoryVideoSegment, listMemoryVideoSegments, MemoryVideoSegmentsError,
} from "../services/memory/memoryVideoSegmentsService.js";

const router = Router();
const path = "/memories/:id/items/:itemId/video-segments";

function sendFailure(res: Response, error: unknown): void {
  const reason = error instanceof MemoryVideoSegmentsError ? error.reason : "unavailable";
  const code: ApiErrorCode = reason === "disabled" ? "feature_disabled" : reason === "not_found" ? "not_found"
    : reason === "unavailable" ? "degraded_unavailable"
      : reason === "invalid_payload" || reason === "invalid_bounds" ? "invalid_payload" : "conflict";
  const message = reason === "disabled" ? "Video segments are not available yet." : reason === "not_found" ? "Memory video not found."
    : reason === "unavailable" ? "Video segments are unavailable. Please try again."
      : reason === "invalid_bounds" ? "Choose a segment within the video's duration."
        : reason === "invalid_payload" ? "Invalid video segment."
          : reason === "limit_reached" ? "This video already has 100 segments. Remove one before adding another."
            : "The video or segment changed. Reload before trying again.";
  sendError(res, code, message);
}

function privateResponse(res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Authorization");
}

router.get(path, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  try {
    res.json(await listMemoryVideoSegments(auth.client, {
      ownerId: auth.user.id, memoryId: String(req.params.id), itemId: String(req.params.itemId),
    }));
  } catch (error) { sendFailure(res, error); }
}));

router.post(path, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  try {
    const result = await createMemoryVideoSegment(auth.client, {
      ownerId: auth.user.id, memoryId: String(req.params.id), itemId: String(req.params.itemId),
    }, req.body);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) { sendFailure(res, error); }
}));

router.delete(`${path}/:segmentId`, asyncHandler(async (req: Request, res: Response) => {
  privateResponse(res);
  const auth = await requireUser(req, res);
  if (!auth) return;
  try {
    await deleteMemoryVideoSegment(auth.client, {
      ownerId: auth.user.id, memoryId: String(req.params.id), itemId: String(req.params.itemId),
    }, req.params.segmentId);
    res.status(204).send();
  } catch (error) { sendFailure(res, error); }
}));

export default router;
