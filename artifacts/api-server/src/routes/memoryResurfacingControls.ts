/**
 * §11 per-Memory user controls — the owner's own switches on their Memory.
 * Census H36 / H87 / H88 / H187. Storage: migration 3671
 * (`memory_resurfacing_preferences`), written and unapplied.
 *
 *   GET    /memories/:id/resurfacing-controls            the controls ON
 *   PUT    /memories/:id/resurfacing-controls/:control   turn one ON
 *   DELETE /memories/:id/resurfacing-controls/:control   turn one OFF
 *
 * OWNER ONLY. Another person's Memory is a 404, the same answer as a Memory
 * that does not exist (no oracle). A deleted Memory is a 404 too.
 * 3671 not applied ⇒ 404 feature_disabled; unreadable ⇒ 503, never "no controls".
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import {
  clearMemoryControl,
  isMemoryResurfacingControl,
  MEMORY_RESURFACING_CONTROLS,
  readMemoryControls,
  setMemoryControl,
  type ControlWrite,
} from "../services/memory/memoryResurfacingControls.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's own, live Memory — or the refusal already sent. */
async function ownMemory(req: Request, res: Response, sc: any, ownerId: string): Promise<{ id: string; visibility: string | null } | null> {
  const id = String(req.params.id ?? "");
  if (!UUID_RE.test(id)) { sendError(res, "invalid_payload", "Invalid memory id"); return null; }
  const { data, error } = await sc.from("memories").select("id, owner_id, visibility, state").eq("id", id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again."); return null; }
  const row = data as { id: string; owner_id: string; visibility: string | null; state: string | null } | null;
  if (!row || row.owner_id !== ownerId || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return null; }
  return { id: row.id, visibility: row.visibility };
}

function sendWrite(req: Request, res: Response, out: ControlWrite): void {
  if (out.ok) { res.status(204).send(); return; }
  if (out.reason === "not_deployed") { sendError(res, "feature_disabled", "Memory privacy controls are not available yet."); return; }
  if (out.reason === "not_private") { sendError(res, "conflict", "Make this Memory private (only me) before keeping it private forever.", { exposeDetail: true, reason: "not_private" }); return; }
  req.log.error({ detail: out.detail }, "memory resurfacing controls: write failed");
  sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
}

router.get("/memories/:id/resurfacing-controls", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  const read = await readMemoryControls(sc, auth.user.id, [mem.id]);
  if (read.state === "absent") { sendError(res, "feature_disabled", "Memory privacy controls are not available yet."); return; }
  if (read.state === "unreadable") { sendError(res, "degraded_unavailable", "Your privacy settings could not be read. Please try again."); return; }
  const on = read.byMemory.get(mem.id) ?? new Set();
  res.json({ memoryId: mem.id, controls: MEMORY_RESURFACING_CONTROLS.map((c) => ({ control: c, on: on.has(c) })) });
}));

router.put("/memories/:id/resurfacing-controls/:control", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const control = String(req.params.control ?? "");
  if (!isMemoryResurfacingControl(control)) { sendError(res, "invalid_payload", `control must be one of ${MEMORY_RESURFACING_CONTROLS.join(", ")}`); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  sendWrite(req, res, await setMemoryControl(sc, { ownerId: auth.user.id, memoryId: mem.id, control, currentVisibility: mem.visibility }));
}));

router.delete("/memories/:id/resurfacing-controls/:control", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const control = String(req.params.control ?? "");
  if (!isMemoryResurfacingControl(control)) { sendError(res, "invalid_payload", `control must be one of ${MEMORY_RESURFACING_CONTROLS.join(", ")}`); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const mem = await ownMemory(req, res, sc, auth.user.id);
  if (!mem) return;
  sendWrite(req, res, await clearMemoryControl(sc, { ownerId: auth.user.id, memoryId: mem.id, control }));
}));

export default router;
