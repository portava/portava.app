/**
 * Telegraph — unsave.
 *
 *   DELETE /api/me/saved-messages/:messageId
 *
 * The write half of `saved_messages` had a save and no unsave: the table's own
 * RLS carries `saved_messages_delete_own`
 * (baseline/20260819_baseline_structure.sql:31784) and nothing in the tree ever
 * issued the delete it permits. A collection you can add to and not remove from
 * is not the user's collection.
 *
 * ── NOT MOUNTED BY THIS FILE ────────────────────────────────────────────────
 * This router is deliberately its own file rather than another handler in
 * routes/messaging.ts, which the integration lane owns. Mounting it is one line
 * in routes/index.ts, next to the other Telegraph routers.
 *
 * ── THE DELETE IS NOT RE-AUTHORIZED, AND THAT IS THE DESIGN ─────────────────
 * See services/telegraph/savedMessages.ts#unsaveMessage. A save the caller can
 * no longer READ — the sender unsent it, the caller left the thread, the §14.3
 * window moved past it — is exactly the save they are most likely to want gone,
 * and an unsave gated on the same re-authorization the read applies would
 * strand it in the table forever. The delete names the caller's own user id, so
 * it can reach no other person's row.
 *
 * ── IDEMPOTENT ─────────────────────────────────────────────────────────────
 * Unsaving something that is not saved answers 200 `{ ok: true, status:
 * "not_saved" }`, not 404. The caller asked for a state, the state holds. The
 * two statuses are distinguished in the body because a surface that just
 * toggled a bookmark wants to know whether it removed something, and because a
 * FAILED delete must never be reported as either of them — it is a retryable
 * 503, so the owner is told to try again rather than shown a save that is
 * still there.
 */
import { Router } from "express";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { unsaveMessage } from "../services/telegraph/savedMessages.js";

const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.delete(
  "/me/saved-messages/:messageId",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const { messageId } = req.params;
    if (!UUID.test(String(messageId ?? ""))) {
      sendError(res, "invalid_payload", "Invalid message id");
      return;
    }

    const outcome = await unsaveMessage(client, user.id, messageId);

    if (outcome.status === "error") {
      req.log?.error?.(
        { err: outcome.message, messageId, userId: user.id },
        "saved_messages delete failed — refusing to report the save as removed",
      );
      sendError(
        res,
        "degraded_unavailable",
        "We could not remove that saved message right now. Please try again shortly.",
      );
      return;
    }

    res.status(200).json({ ok: true, status: outcome.status });
  }),
);

export default router;
