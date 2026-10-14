/**
 * §4 `MemoryType` — what the Memory composer may offer. Census H40.
 *
 *   GET /memory-types     { enabled, types, defaultType }
 *
 * The composer (app/memory/new.tsx, edit.tsx) shows its type picker only when
 * `enabled` is true, because POST/PATCH /memories REFUSE an owner's type while
 * `memory_type_enabled` (3803, seeded FALSE) is not ON — the refusal is the
 * honest answer, and the picker is not offered for a choice that would be
 * refused. Not under /memories/: `GET /memories/:id` would match it first.
 *
 * Signed-in only; nothing about any Memory is read. An unreadable flag is a 503,
 * never `enabled: false` — the client tells "not available" from "could not
 * check".
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { DEFAULT_MEMORY_TYPE, MEMORY_TYPES, fieldServed, readCanonicalGates } from "../services/memory/memoryCanonicalFields.js";

const router = Router();

router.get("/memory-types", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const gates = await readCanonicalGates(sc);
  if (gates.memoryType === "unreadable") { sendError(res, "degraded_unavailable", "Memory types could not be checked right now. Please try again."); return; }
  res.json({ enabled: fieldServed(gates.memoryType), types: MEMORY_TYPES, defaultType: DEFAULT_MEMORY_TYPE });
}));

export default router;
