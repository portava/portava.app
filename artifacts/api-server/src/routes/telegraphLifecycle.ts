/**
 * Telegraph §7 — receipts and unsend-before-seen.
 *
 *   GET  /api/threads/:threadId/receipts?messageIds=a,b,c
 *        §7.3's Sent / Seen / "Seen by N", derived per request from the one
 *        receipt row per member that already exists. No receipt table.
 *
 *   POST /api/threads/:threadId/messages/:messageId/unsend
 *        §7.4. Refuses once any eligible recipient has seen the message.
 *
 * ── WHY THIS IS NOT THE EXISTING DELETE ─────────────────────────────────────
 * `DELETE /api/messages/:messageId` (routes/groupChat.ts) already exists and is
 * unconditional: a sender may delete their own message at any time, seen or
 * not, and every reader renders a redacted slot in its place. That is a
 * DELETE — the recipients know a message was there and is gone.
 *
 * §7.4 is a different operation with a different promise: an UNSEND is only
 * permitted while nobody has seen the message, and its point is that there was
 * nothing to notice. This route does not replace the delete and does not weaken
 * it; a sender who has been seen can still delete, and will still leave a slot.
 * The census records the distinction rather than claiming the delete was
 * "fixed", because deleting a seen message is a capability travellers have
 * today and §7.4 does not ask for it to be removed.
 *
 * ── THE RACE ────────────────────────────────────────────────────────────────
 * §7.4 wants the read-vs-unsend race resolved transactionally. It is not,
 * because a lock needs a SECURITY DEFINER function and therefore a migration no
 * database has. What happens instead is compensation: the receipts are read
 * again after the write, and if a read landed inside the window the message is
 * PUT BACK — body and all — and the caller is told it could not be unsent. The
 * outcome is right; the window is real. See `services/telegraph/unsend.ts`.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import {
  detectReadRace,
  planUnsend,
  receiptFor,
  restorePatch,
  seenByRecipients,
  unsendRefusalMessage,
  unsentPatch,
  DELIVERED_UNAVAILABLE,
  type LifecycleMessage,
  type ReceiptMember,
} from "../services/telegraph/unsend.js";
import {
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";

const log = rootLogger.child({ route: "telegraphLifecycle" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** How many messages one receipts request may ask about. */
export const RECEIPTS_MAX_IDS = 100;

const MESSAGE_COLUMNS = "id, thread_id, sender_id, created_at, deleted_at, edited_at, body";
const MEMBER_COLUMNS = "user_id, last_read_at, left_at";

type Gate =
  | { ok: true; visibleFrom: string | null }
  | { ok: false; code: string; message: string };

/** Active membership plus this member's §14.3 window, error observed. */
async function memberGate(client: any, threadId: string, userId: string): Promise<Gate> {
  const boundOn = await historyBoundEnabled(client);
  const { data, error } = await client
    .from("message_thread_members")
    .select(membershipSelect("user_id, left_at", boundOn))
    .eq("thread_id", threadId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, code: "db_error", message: "Could not verify thread membership" };
  if (!data || (data as any).left_at !== null) {
    return { ok: false, code: "forbidden", message: "Not an active member of this thread" };
  }
  return { ok: true, visibleFrom: visibleFromOf(data as any, boundOn) };
}

/**
 * Every member row of the thread, which is what a receipt is derived from.
 *
 * This is the §7.3 shape the spec asks for: ONE row per member per thread, read
 * per request. There is no row per message per user anywhere in this path, and
 * adding one is what T74 forbids.
 */
async function readMembers(
  client: any,
  threadId: string,
): Promise<{ ok: true; members: ReceiptMember[] } | { ok: false }> {
  const { data, error } = await client
    .from("message_thread_members")
    .select(MEMBER_COLUMNS)
    .eq("thread_id", threadId);
  if (error) return { ok: false };
  return { ok: true, members: ((data as any[]) ?? []) as ReceiptMember[] };
}

// ── GET /api/threads/:threadId/receipts ──────────────────────────────────────

router.get(
  "/threads/:threadId/receipts",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }

    const raw = typeof req.query.messageIds === "string" ? req.query.messageIds : "";
    const ids = raw
      .split(",")
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);
    if (ids.length === 0) {
      sendError(res, "invalid_payload", "messageIds is required");
      return;
    }
    if (ids.length > RECEIPTS_MAX_IDS) {
      sendError(res, "invalid_payload", `At most ${RECEIPTS_MAX_IDS} messageIds per request`);
      return;
    }
    if (ids.some((id: string) => !UUID.test(id))) {
      sendError(res, "invalid_payload", "Invalid messageId");
      return;
    }

    const gate = await memberGate(client, threadId, user.id);
    if (!gate.ok) {
      sendError(res, gate.code as any, gate.message);
      return;
    }

    const membersRead = await readMembers(client, threadId);
    if (!membersRead.ok) {
      // A failed member read is not "nobody has seen it" — that would be a
      // receipt asserting a negative it never measured.
      sendError(res, "db_error", "Could not read this conversation's receipts");
      return;
    }

    const { data: rows, error: rowErr } = await client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .in("id", ids);
    if (rowErr) {
      sendError(res, "db_error", "Could not read those messages");
      return;
    }

    const messages = ((rows as any[]) ?? []) as LifecycleMessage[];
    const receipts = messages
      .filter((m) => withinWindow(m.created_at, gate.visibleFrom))
      // §7.3's receipts are the SENDER's view of their own message. A recipient
      // asking who else has read a message they did not send is a different
      // question with a different policy, and this route does not answer it.
      .filter((m) => m.sender_id === user.id)
      .map((m) => receiptFor(m, membersRead.members));

    res.status(200).json({
      threadId,
      receipts,
      /**
       * §7.1 names a DELIVERED state. Nothing on this deployment produces a
       * delivery signal, so every receipt reports `delivered: null` and says
       * why, rather than reporting a false it never measured.
       */
      deliveredUnavailableReason: DELIVERED_UNAVAILABLE,
      /** §7.3's prohibition, stated by the endpoint that could have broken it. */
      receiptStorage: "one row per member per thread; none per message",
    });
  }),
);

// ── POST /api/threads/:threadId/messages/:messageId/unsend ───────────────────

const UnsendSchema = z.object({}).passthrough();

router.post(
  "/threads/:threadId/messages/:messageId/unsend",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId, messageId } = req.params;

    if (!UUID.test(threadId) || !UUID.test(messageId)) {
      sendError(res, "invalid_payload", "Invalid id");
      return;
    }
    UnsendSchema.parse(req.body ?? {});

    const gate = await memberGate(client, threadId, user.id);
    // A non-member is refused before anything about the message is read, so
    // this endpoint cannot be used to probe another thread's contents.
    if (!gate.ok) {
      sendError(res, gate.code as any, gate.message);
      return;
    }

    const { data: msg, error: msgErr } = await client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", messageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (msgErr) {
      sendError(res, "db_error", "Could not read that message");
      return;
    }
    if (!msg) {
      sendError(res, "not_found", "That message is not available");
      return;
    }
    const message = msg as LifecycleMessage;

    const before = await readMembers(client, threadId);
    if (!before.ok) {
      // Fail closed. An unreadable receipt state must never read as "unseen".
      sendError(res, "db_error", "Could not read this conversation's receipts");
      return;
    }

    // Snapshot the seen set NOW, before anything is written. Computing it
    // later, next to the "after" read, would make the comparison depend on the
    // client not aliasing its rows.
    const seenBefore = seenByRecipients(message, before.members);

    const plan = planUnsend({
      message,
      members: before.members,
      actorId: user.id,
      actorIsActiveMember: true,
    });
    if (!plan.eligible) {
      res.status(plan.refusal === "not_sender" || plan.refusal === "not_a_member" ? 403 : 409).json({
        error: plan.refusal,
        message: unsendRefusalMessage(plan.refusal, plan.seenBy),
        seenBy: plan.seenBy,
        recipientCount: plan.recipientCount,
      });
      return;
    }

    const originalBody = typeof message.body === "string" ? message.body : "";
    const nowIso = new Date().toISOString();

    // The write is guarded on `deleted_at IS NULL` in the statement itself, so
    // two concurrent unsends of the same message cannot both succeed.
    const { data: updated, error: updErr } = await client
      .from("messages")
      .update(unsentPatch(nowIso))
      .eq("id", messageId)
      .eq("sender_id", user.id)
      .is("deleted_at", null)
      .select("id");
    if (updErr) {
      log.error({ err: updErr, messageId }, "unsend write failed");
      sendError(res, "db_error", "Could not unsend that message");
      return;
    }
    if (!updated || (updated as any[]).length === 0) {
      // Someone else's write got there first.
      res.status(409).json({
        error: "already_gone",
        message: unsendRefusalMessage("already_gone", 0),
        seenBy: 0,
        recipientCount: plan.recipientCount,
      });
      return;
    }

    // ── Compensation, not a lock ─────────────────────────────────────────────
    //
    // Putting the message back is always safe: it returns the conversation to
    // the state it was in a moment ago. So both reasons to compensate are
    // handled the same way — a race we DETECTED, and a race we COULD NOT RULE
    // OUT because the re-read failed.
    //
    // The second one is the point. An earlier version of this handler skipped
    // the race check entirely when the after-read failed, which made the one
    // branch whose whole job is to catch a §7.4 violation the one branch that
    // assumed there had not been one. Every other receipt read in this file
    // fails closed; this one now does too.
    const restore = async (): Promise<boolean> => {
      const { error } = await client
        .from("messages")
        .update(restorePatch(originalBody))
        .eq("id", messageId);
      if (error) log.error({ err: error, messageId }, "unsend compensation failed");
      return !error;
    };

    const after = await readMembers(client, threadId);

    if (!after.ok) {
      // We cannot tell whether a read landed. Put it back and say so.
      if (await restore()) {
        res.status(409).json({
          error: "unverifiable",
          message:
            "We could not confirm nobody had seen this message, so it was not unsent. " +
            "Nothing changed — you can try again.",
          seenBy: 0,
          recipientCount: plan.recipientCount,
          raceDetected: null,
          compensated: true,
        });
        return;
      }
      // Could not re-read AND could not put it back. The sender is told the
      // truth rather than being handed a success.
      res.status(200).json({
        id: messageId,
        unsent: true,
        raceDetected: null,
        compensated: false,
        message:
          "This message was unsent, but we could not confirm nobody had already seen it.",
        seenBy: 0,
      });
      return;
    }

    const raced = detectReadRace(seenBefore, seenByRecipients(message, after.members));
    if (raced.length > 0) {
      if (!(await restore())) {
        // The message stays unsent and the sender is told the truth: we could
        // not put it back. Silence here would be the worst option of the three.
        res.status(200).json({
          id: messageId,
          unsent: true,
          raceDetected: true,
          compensated: false,
          message:
            "Someone read this message as you unsent it, and we could not put it back. It is gone.",
          seenBy: raced.length,
        });
        return;
      }
      res.status(409).json({
        error: "seen_by_recipient",
        message: unsendRefusalMessage("seen_by_recipient", raced.length),
        seenBy: raced.length,
        recipientCount: plan.recipientCount,
        raceDetected: true,
        compensated: true,
      });
      return;
    }

    res.status(200).json({
      id: messageId,
      unsent: true,
      unsentAt: nowIso,
      seenBy: 0,
      recipientCount: plan.recipientCount,
      /**
       * Said out loud because §7.4 asks for something this deployment cannot
       * give: there is no UNSENT lifecycle state to set, so the row is a
       * tombstone and the existing readers still render a redacted slot.
       */
      lifecycleState: null,
      lifecycleStateUnavailableReason:
        "public.messages has no lifecycle column; an unsent message is a tombstone, " +
        "indistinguishable in storage from a deleted one.",
    });
  }),
);

export default router;
