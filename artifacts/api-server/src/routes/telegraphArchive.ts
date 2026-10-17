/**
 * Owner ruling 2026-10-17 — "Allow users to unarchive conversations."
 *
 *   POST /api/threads/:threadId/unarchive
 *       Clears the CALLER'S OWN archived_at for this conversation and answers
 *       the read-back: `{ ok: true, threadId, archivedAt: null, changed }`.
 *       Idempotent — `changed: false` when it was not archived.
 *
 * What an unarchive is, and the four things it is not (another member's view,
 * a conversation the caller left, a block, a Rent-a-Buddy booking's
 * post-completion rules), is services/telegraph/threadArchive.ts.
 *
 * ACTIVE MEMBERS ONLY, refused the way the sibling member routes refuse
 * (PATCH /threads/:id/mute): a non-member — and a member who left — is a 403
 * "Not a member of this thread" before anything is written; an unreadable
 * membership is a retryable 503, never "not a member" and never a write; a
 * failed write is a 500, never "unarchived". The account-state gate is
 * requireUser's. A block is not consulted: the answer is the same across one,
 * so the route cannot be asked "did this person block me?".
 *
 * After a change the caller's own other devices are told (`thread.updated`,
 * which the inbox already re-reads on); nobody else is — an unarchive is not
 * news to the other members.
 */
import { Router } from "express";

import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import { publishToUsers } from "../lib/telegraphEvents.js";
import { unarchiveOwnMembership } from "../services/telegraph/threadArchive.js";

const router = Router();
const log = rootLogger.child({ route: "telegraphArchive" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.post(
  "/threads/:threadId/unarchive",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const threadId = String(req.params.threadId ?? "");
    if (!UUID.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const outcome = await unarchiveOwnMembership(sc, threadId, user.id);
    if (outcome.kind === "unreadable") {
      log.error({ err: outcome.error, threadId }, "unarchive: membership unreadable — refusing rather than asserting the caller is not a member");
      sendError(res, "degraded_unavailable", "We could not check your access to this conversation right now. Please try again shortly.");
      return;
    }
    if (outcome.kind === "not_member") { sendError(res, "forbidden", "Not a member of this thread"); return; }
    if (outcome.kind === "write_failed") {
      log.error({ err: outcome.error, threadId }, "unarchive: write failed");
      sendError(res, "db_error", "This conversation was not unarchived. Please try again.");
      return;
    }
    if (outcome.changed) publishToUsers([user.id], { type: "thread.updated", payload: { threadId } });
    res.status(200).json({ ok: true, threadId, archivedAt: null, changed: outcome.changed });
  }),
);

export default router;
