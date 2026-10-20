import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { loadMemoryForCommand } from "../services/memory/MemoryDomainService.js";
import { lifecycleStateOf } from "../lib/memoryCommandBus.js";
import { captureMemorySnapshot, replayStoredMemorySnapshot } from "../services/memory/MemorySnapshotStore.js";
import type { MemorySnapshotFailure } from "../services/memory/MemorySnapshot.js";

const router = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(res: Response, reason: MemorySnapshotFailure) {
  if (reason === "not_found") sendError(res, "not_found", "Memory snapshot not found");
  else if (reason === "not_deployed" || reason === "feature_disabled") sendError(res, "feature_disabled", "Memory snapshots are not available.");
  else if (reason === "conflict") sendError(res, "conflict", "The Memory changed. Please try again.");
  else sendError(res, "degraded_unavailable", "This Memory snapshot cannot be replayed safely right now.");
}

async function authorized(req: Request, res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  const auth = await requireUser(req, res);
  if (!auth) return null;
  const memoryId = String(req.params.id ?? "").toLowerCase();
  if (!UUID.test(memoryId)) { refuse(res, "not_found"); return null; }
  const client = getServiceClient();
  if (!client) { refuse(res, "unavailable"); return null; }
  const loaded = await loadMemoryForCommand(client, memoryId);
  if (!loaded.ok) { refuse(res, loaded.http.code === "not_found" ? "not_found" : "unavailable"); return null; }
  if (loaded.row.owner_id !== auth.user.id || lifecycleStateOf(loaded.row.state) === "DELETED") {
    refuse(res, "not_found"); return null;
  }
  if (lifecycleStateOf(loaded.row.state) === null) { refuse(res, "unavailable"); return null; }
  return { client, scope: { ownerId: auth.user.id, memoryId } };
}

router.post("/memories/:id/snapshots", asyncHandler(async (req: Request, res: Response) => {
  const context = await authorized(req, res);
  if (!context) return;
  if (req.body && (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length > 0)) {
    sendError(res, "invalid_payload", "Snapshots are captured from stored evidence, not client-supplied facts."); return;
  }
  const result = await captureMemorySnapshot(context.client, context.scope);
  if (!result.ok) { refuse(res, result.reason); return; }
  res.json({ snapshot: { id: result.value.id, revision: result.value.revision,
    source_version: result.value.snapshot.source.source_version, captured_at: result.value.snapshot.source.captured_at } });
}));

router.get("/memories/:id/snapshots/:snapshotId/replay", asyncHandler(async (req: Request, res: Response) => {
  const context = await authorized(req, res);
  if (!context) return;
  const result = await replayStoredMemorySnapshot(context.client, context.scope, String(req.params.snapshotId ?? "").toLowerCase());
  if (!result.ok) { refuse(res, result.reason); return; }
  res.json({ replay: result.value });
}));

export default router;
