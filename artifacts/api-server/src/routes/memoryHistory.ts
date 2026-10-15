/**
 * A Memory's fact history — §3 `memory_snapshots` (migration 3811), read by its
 * OWNER. Census-highlights-memories H35, B58 cluster MEM-SNAPSHOTS.
 *
 *   GET /memories/:id/history   { memoryId, history: { state, cap, extractor,
 *                                 prunedBefore, versions[] } }
 *
 * Each version is the Memory's FACTS at one write — lifecycle state, visibility,
 * precision rung, place references and the place's name then, time window,
 * source mode, type, item count — oldest first, with the keys that changed.
 * Never a title, caption, coordinate or person: 3811 does not store them
 * (services/memory/memorySnapshots.ts).
 *
 * OWNER ONLY, AND NO ORACLE. Someone else's Memory, a missing one and a deleted
 * one get the same 404 after the same single read, so the answer says nothing
 * about whether a Memory exists. A malformed id is 400, as GET /memories/:id. A
 * Memory or history that could not be read is a 503, never an empty history.
 * `history.state` tells "this database keeps no history" (`not_deployed`, 3811
 * unapplied) from "nothing written since history began" (`none_recorded`: no
 * backfill, open owner question Q-H35) and from versions (`recorded`).
 *
 * READ-ONLY. Mounted from routes/index.ts on an existing line (that file is
 * cited by line). Not in routes/memories.ts, whose lines the census cites.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  MEMORY_SNAPSHOT_CAP,
  MEMORY_SNAPSHOT_EXTRACTOR_VERSION,
  readMemoryHistory,
} from "../services/memory/memorySnapshots.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get("/memories/:id/history", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

  const { data: memory, error } = await sc.from("memories").select("id, owner_id, state").eq("id", id).maybeSingle();
  if (error) {
    req.log.error({ memoryId: id, code: (error as { code?: unknown }).code }, "memory history: memory read failed — refusing rather than answering not_found");
    sendError(res, "degraded_unavailable", "This Memory's history could not be read right now. Please try again.");
    return;
  }
  const row = memory as { owner_id?: unknown; state?: unknown } | null;
  if (!row || row.owner_id !== auth.user.id || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return; }

  const history = await readMemoryHistory(sc, id, auth.user.id);
  if (history.state === "unreadable") {
    req.log.error({ memoryId: id, detail: history.detail }, "memory history: memory_snapshots unreadable — refusing rather than answering an empty history");
    sendError(res, "degraded_unavailable", "This Memory's history could not be read right now. Please try again.");
    return;
  }
  res.json({
    memoryId: id,
    history: {
      state: history.state,
      cap: MEMORY_SNAPSHOT_CAP,
      extractor: MEMORY_SNAPSHOT_EXTRACTOR_VERSION,
      prunedBefore: history.prunedBefore,
      versions: history.versions,
    },
  });
}));

export default router;
