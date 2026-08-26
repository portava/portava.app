/**
 * Intelligence Gathering — internal intel API (IG-10, spec §22).
 *
 * GET /v1/internal/intel/redistributable/:subjectId
 *   Returns the live-state snapshots for a place, projected to ONLY their
 *   redistributable fields (lib/intelApiProjection + lib/dataRights) and only
 *   when privacy-eligible and unexpired. This is the INTERNAL shape of the intel
 *   API product — what an external partner endpoint would serve once one exists.
 *
 * INTERNAL ONLY. requireAdmin gates it; there is no external, unauthenticated or
 * generally accessible surface here and no external credential is issued. Egress
 * of these fields to a third party is a separate switch held under Portava's
 * control (spec §22 intel_external_api) and is not built. The value of shipping
 * the projection now is that the field-licensing boundary is enforced and tested
 * before any partner surface can be stood up on top of it.
 */
import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/asyncHandler.js";
import { sendError } from "../lib/http.js";
import { requireAdmin } from "../lib/requireAdmin.js";
import { isKillSwitchEngaged } from "../lib/featureFlags.js";
import { projectSnapshotForApi } from "../lib/intelApiProjection.js";

const router = Router();

router.get("/v1/internal/intel/redistributable/:subjectId", asyncHandler(async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const subjectId = z.string().uuid().safeParse(req.params.subjectId);
  if (!subjectId.success) return sendError(res, "invalid_payload", "subjectId (uuid) required");

  // The global emergency stop must cover EVERY intel live-state serving path, not
  // only the user-facing read (liveClaimRead). When engaged, this internal
  // redistributable view returns nothing, same as the public surface.
  if (await isKillSwitchEngaged(ctx.sc, "disable_intel_live_labels")) {
    return res.json({ subjectId: subjectId.data, fields: [] });
  }

  const now = new Date();
  const { data, error } = await ctx.sc
    .from("intel_state_snapshots")
    .select("*")
    .eq("subject_id", subjectId.data)
    .eq("privacy_eligible", true)
    .gt("expires_at", now.toISOString());
  if (error) return sendError(res, "db_error", "snapshot read failed");

  // Field-level licensing enforced per row; projectSnapshotForApi re-checks
  // privacy_eligible + expiry so a query change can never widen what leaves.
  const projected = ((data as any[]) ?? [])
    .map((row) => projectSnapshotForApi(row, now))
    .filter((r): r is Record<string, unknown> => r !== null);

  res.json({ subjectId: subjectId.data, fields: projected });
}));

export default router;
