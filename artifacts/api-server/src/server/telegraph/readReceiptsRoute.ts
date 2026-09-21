/**
 * Telegraph §14.1 `canSeeGroupReadReceipts` / §19 — `GET /api/threads/:threadId/read-receipts`.
 *
 * WHY THIS EXISTS
 * ===============
 * `message_thread_members.last_read_at` has been written since migration 0016
 * and is read by exactly one consumer: the caller's OWN unread count
 * (`routes/messaging.ts:1212`). No route has ever returned anybody else's.
 * census-telegraph T206 recorded the consequence — `canSeeGroupReadReceipts`
 * had nothing to gate — and T73 recorded the same hole from the §7 side. A
 * capability that can only ever be false is a field, not a permission.
 *
 * THE CAPABILITY IS THE GATE HERE, AND THAT IS NOT A CONTRADICTION
 * ===============================================================
 * Elsewhere the capability set is a projection of a gate that lives in the
 * route. Here the route IS the capability's enforcement site: it calls
 * `resolveConversationCapabilities` and refuses when `canSeeGroupReadReceipts`
 * is false. That is still §14.1-conformant — authorization is derived
 * server-side from the eight inputs, at request time, from the database — and
 * it is the opposite of the thing §14.1 forbids, which is a CLIENT telling the
 * server what it may do.
 *
 * WHAT IS DELIBERATELY NOT RETURNED
 * =================================
 *   - A direct thread's receipts. `canSeeGroupReadReceipts` is false for
 *     `direct`, so a DM answers 403. 1:1 read state is already carried by the
 *     existing thread projection and does not need a second, differently-shaped
 *     source of truth.
 *   - Anyone who has LEFT. Their last read position is a fact about a
 *     conversation they are no longer in.
 *   - A member's read position OUTSIDE the caller's own §14.3 window. If the
 *     caller cannot see the messages, "Bob read up to here" is a statement
 *     about content the caller is not authorized to know exists, so the
 *     timestamp is clamped to the caller's own `visible_from` rather than
 *     omitted — omission would itself be a signal.
 */

import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { historyBoundEnabled, membershipSelect, visibleFromOf } from "../../services/groupChatHistoryBound.js";
import { resolveConversationCapabilities } from "../../domain/telegraph/policies/conversationCapabilityPolicy.js";
import { redactForWire } from "../../domain/telegraph/contracts/telegraphReasonCodes.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/threads/:threadId/read-receipts",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const threadId = String(req.params["threadId"] ?? "");
    if (!UUID_RE.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const caps = await resolveConversationCapabilities(sc, { viewerId: user.id, conversationId: threadId });

    // A DEGRADED capability set is a floor, not an answer — including when the
    // boolean came out TRUE. Granting on it would be the exact fail-open the
    // resolver's own header argues against: one of the eight inputs did not
    // read, the answer was computed without it, and acting on that answer is
    // indistinguishable from having checked. 503 says "ask again", which is the
    // only honest thing an unknown authorization can say.
    if (caps.degraded) {
      sendError(res, "degraded_unavailable", "We could not check this conversation right now. Please try again shortly.");
      return;
    }

    if (!caps.capabilities.canSeeGroupReadReceipts) {
      const reason = caps.reasons.canSeeGroupReadReceipts;
      res.status(403).json({
        error: "forbidden",
        message: "Read receipts are not available in this conversation",
        reason: reason === null ? null : redactForWire(reason),
      });
      return;
    }

    const boundOn = await historyBoundEnabled(sc);
    const { data: mine, error: mineErr } = await sc
      .from("message_thread_members")
      .select(membershipSelect("user_id", boundOn))
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (mineErr) { sendError(res, "degraded_unavailable", "We could not read this conversation right now."); return; }
    const myFloor = visibleFromOf(mine as any, boundOn);

    const { data: rows, error } = await sc
      .from("message_thread_members")
      .select("user_id, last_read_at")
      .eq("thread_id", threadId)
      .is("left_at", null);
    if (error) {
      // An unreadable roster is not "nobody has read anything" — that answer
      // would be indistinguishable from a real empty and would be wrong in the
      // direction that makes a user re-send a message somebody already read.
      sendError(res, "degraded_unavailable", "We could not read this conversation right now.");
      return;
    }

    const floorMs = myFloor ? Date.parse(myFloor) : null;
    const receipts = ((rows as any[]) ?? []).map((r) => {
      const raw = (r.last_read_at ?? null) as string | null;
      let lastReadAt = raw;
      if (raw !== null && floorMs !== null && Date.parse(raw) < floorMs) lastReadAt = myFloor;
      return { userId: String(r.user_id), lastReadAt, clamped: lastReadAt !== raw };
    });

    res.status(200).json({ conversationId: threadId, receipts });
  }),
);

export default router;
