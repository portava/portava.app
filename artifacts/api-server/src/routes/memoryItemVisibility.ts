/**
 * PUT /memories/:id/items/:itemId/visibility — §10, a photo's own audience
 * (migration 3672). Census H80. Body: `{ "visibility": "only_me" | null }`.
 *
 * OWNER ONLY. Someone else's Memory, a deleted Memory and a photo that is not
 * on this Memory are all 404. 3672 not applied ⇒ 404 feature_disabled.
 */
import { Router, type Request, type Response } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { HIDDEN_ITEM_VISIBILITY, setItemVisibility } from "../services/memory/memoryItemVisibility.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.put("/memories/:id/items/:itemId/visibility", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const id = String(req.params.id ?? "");
  const itemId = String(req.params.itemId ?? "");
  if (!UUID_RE.test(id) || !UUID_RE.test(itemId)) { sendError(res, "invalid_payload", "Invalid id"); return; }
  const raw = (req.body ?? {}).visibility;
  if (raw !== null && raw !== HIDDEN_ITEM_VISIBILITY) { sendError(res, "invalid_payload", "visibility must be \"only_me\" or null"); return; }
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }
  const { data, error } = await sc.from("memories").select("id, owner_id, state").eq("id", id).maybeSingle();
  if (error) { sendError(res, "degraded_unavailable", "Your Memory could not be read. Please try again."); return; }
  const row = data as { owner_id: string; state: string | null } | null;
  if (!row || row.owner_id !== auth.user.id || row.state === "deleted") { sendError(res, "not_found", "Memory not found"); return; }
  const out = await setItemVisibility(sc, { memoryId: id, itemId, visibility: raw });
  if (out.ok) { res.status(204).send(); return; }
  if (out.reason === "not_deployed") { sendError(res, "feature_disabled", "Photo privacy is not available yet."); return; }
  if (out.reason === "not_found") { sendError(res, "not_found", "Photo not found"); return; }
  req.log.error({ detail: out.detail }, "memory item visibility: write failed");
  sendError(res, "degraded_unavailable", "That could not be saved. Please try again.");
}));

export default router;
