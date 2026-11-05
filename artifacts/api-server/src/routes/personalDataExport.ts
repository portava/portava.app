/**
 * GET /api/me/export — "Download your data" (Settings → Account).
 *
 * The person's own rows across the sections lib/personalDataExport.ts lists,
 * as one JSON file. All or nothing: a section that cannot be read fails the
 * request, so a file that arrives is never missing a section without saying
 * so. A restricted account may still call it (lib/restrictedAccountAccess.ts,
 * OD-TRUST-5: "preserve access to … permitted data exports").
 */
import { Router, type Request, type Response } from "express";
import { asyncHandler } from "../lib/asyncHandler.js";
import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { checkRateLimit } from "../lib/rateLimit.js";
import { buildPersonalDataExport, ExportReadError } from "../lib/personalDataExport.js";

/** Building the file reads ~40 tables; five an hour is plenty for one person. */
export const EXPORT_HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

const router = Router();

router.get("/me/export", asyncHandler(async (req: Request, res: Response) => {
  const auth = await requireUser(req, res);
  if (!auth) return;
  const sc = getServiceClient();
  if (!sc) { sendError(res, "server_not_configured", "Service client not available"); return; }

  const limit = checkRateLimit("personal-data-export", auth.user.id, EXPORT_HOURLY_LIMIT, HOUR_MS);
  if (!limit.allowed) {
    res.setHeader("Retry-After", String(Math.ceil(limit.retryAfterMs / 1000)));
    sendError(res, "rate_limited", "You have downloaded your data a few times this hour. Try again later.");
    return;
  }

  try {
    const file = await buildPersonalDataExport(sc, auth.user.id);
    const day = file.generatedAt.slice(0, 10);
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `attachment; filename="portava-data-${day}.json"`);
    res.json(file);
  } catch (err) {
    const section = err instanceof ExportReadError ? err.section : "unknown";
    req.log.error({ err, userId: auth.user.id, section }, "me/export failed");
    sendError(res, "db_error", "Your data could not be gathered right now. Nothing was sent; please try again.");
  }
}));

export default router;
