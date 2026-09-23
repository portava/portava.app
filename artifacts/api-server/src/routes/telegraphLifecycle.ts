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
 * ── THE RACE, CLOSED ────────────────────────────────────────────────────────
 * This header used to say §7.4's read-vs-unsend race "is not" resolved
 * transactionally, "because a lock needs a SECURITY DEFINER function and
 * therefore a migration no database has", and described the compensation scheme
 * that stood in for one: read the receipts again after the write, and if a read
 * landed inside the window, PUT THE MESSAGE BACK.
 *
 * The migration exists — 2325 wrote the locking function and 3000 made it write
 * the whole row — and nothing called it. This route now does, through
 * `unsendBeforeSeen`, and the compensation is gone with the window it covered.
 * Three things follow, and all three are visible to a client:
 *
 *   * The route no longer writes `messages` at all. The function decides and
 *     writes inside one locked statement pair.
 *   * `raceDetected` is now always `false` on a success rather than a
 *     measurement that could have been `null`, because a lock has nothing to be
 *     unsure about, and `compensated` is always `false` because nothing is ever
 *     put back.
 *   * The `unverifiable` refusal cannot happen and is gone. It existed only for
 *     "the re-read failed, so we could not tell" — there is no re-read.
 *
 * What did NOT change is every other field, status code and error string on
 * this endpoint. The old handler's row is also the new one's: `unsent_at`,
 * `deleted_at` and an empty body — except that the old one forgot `unsent_at`
 * entirely (`unsentPatch` wrote only `deleted_at` and `body`), so an "unsend"
 * was stored as a delete and the §13.2 outbox published `message.deleted`. The
 * function sets all four columns, so it now publishes `message.unsent`.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import { publishToThread } from "../lib/telegraphEvents.js";
import {
  receiptFor,
  unsendBeforeSeen,
  refusalForOutcome,
  unsendRefusalMessage,
  DELIVERED_UNAVAILABLE,
  type LifecycleMessage,
  type ReceiptMember,
  type UnsendRefusal,
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

    // ── ONE CALL, AND THE ADAPTER THAT KEEPS THE PUBLISHED SHAPE ────────────
    //
    // Everything the old handler did between here and the response — read the
    // message, read the receipts, decide, write, re-read, compensate — is one
    // call now. The mapping below is the whole of what is left, and it exists
    // so that a client written against this endpoint before the change sees the
    // same field names, the same error strings and the same status codes.
    const verdict = await unsendBeforeSeen(client, {
      messageId,
      actorId: user.id,
      threadId,
    });

    if (verdict === null) {
      // The call failed, or answered with something this build cannot read.
      // Neither is permission and neither is refusal, and the old handler's
      // rule for that case was the same: fail closed, say nothing changed.
      log.error({ messageId, threadId }, "unsend function gave no readable verdict");
      sendError(res, "db_error", "Could not unsend that message");
      return;
    }

    // A message that is not in this thread answers exactly as it did before:
    // this endpoint's own 404, not one of the unsend refusals.
    if (verdict.outcome === "not_found") {
      sendError(res, "not_found", "That message is not available");
      return;
    }

    if (verdict.outcome !== "unsent") {
      // `already_deleted` and `already_unsent` are one answer on the wire. The
      // function distinguishes them because the §13.1 command endpoint
      // publishes two reason codes; this endpoint published one, and keeps
      // publishing one.
      const refusal: UnsendRefusal = refusalForOutcome(verdict.outcome);

      res.status(refusal === "not_sender" || refusal === "not_a_member" ? 403 : 409).json({
        error: refusal,
        message: unsendRefusalMessage(refusal, verdict.seenBy),
        seenBy: verdict.seenBy,
        recipientCount: verdict.recipientCount,
        // Stated on the refusals that used to carry them, and now always
        // false rather than sometimes null: the lock means there was no
        // window to detect a race in, and nothing was written to put back.
        ...(refusal === "seen_by_recipient" ? { raceDetected: false, compensated: false } : {}),
      });
      return;
    }

    const unsentAt = verdict.unsentAt ?? new Date().toISOString();

    // §13.2 `message.unsent`, as the realtime nudge. It carries no body because
    // there is none.
    //
    // 2810's outbox trigger fires on the same UPDATE and would write the
    // DURABLE event in the same transaction — but only where 2810 has been
    // applied AND `telegraph_message_kernel_enabled` is true, since the trigger
    // reads that flag and RETURNs NULL when it is not. 2810 is applied to no
    // database, so on every deployment that exists there is no trigger to fire
    // and this publish is the ONLY notification. That is why it is here and not
    // deleted as a duplicate, and why the client keeps a polling fallback.
    void publishToThread(client, threadId, {
      type: "message.unsent",
      payload: { messageId, unsentAt, senderId: user.id },
    }, { excludeUserId: user.id });

    res.status(200).json({
      id: messageId,
      unsent: true,
      unsentAt,
      seenBy: 0,
      recipientCount: verdict.recipientCount,
      // Both were measurements the compensation scheme had to make, and either
      // could come back null when the re-read failed. Under the lock they are
      // facts: no read landed inside the window, and nothing was put back.
      raceDetected: false,
      compensated: false,
      /**
       * Said out loud because §7.4 asks for something this deployment cannot
       * give: there is no UNSENT lifecycle state to set, so the row is a
       * tombstone and the existing readers still render a redacted slot.
       *
       * Migration 2810 added `messages.lifecycle_state` and 3000 makes the
       * unsend write 'unsent' to it, so the STORAGE distinction exists now.
       * This field stays null because the distinction still does not reach a
       * reader: 81 non-test files read `messages` and four mention `unsent_at`,
       * so what a person sees is the deleted-message slot either way. Turning
       * this into a claim would be a claim about readers that have not changed.
       */
      lifecycleState: null,
      lifecycleStateUnavailableReason:
        "public.messages now records lifecycle_state = 'unsent', but no reader in this " +
        "codebase distinguishes it from a delete, so what a person sees is unchanged.",
    });
  }),
);

// ── POST /api/threads/:threadId/seen ─────────────────────────────────────────

/** How many rows one seen-advance will scan to name what crossed. */
export const SEEN_SCAN_LIMIT = 500;

const SeenSchema = z.object({
  /**
   * The threshold, expressed as a MESSAGE rather than a clock reading. That is
   * the whole point — see the header below.
   */
  upToMessageId: z.string().min(1).max(64),
});

/**
 * §7.2 "Seen = crossed the approved visibility threshold", and §13.2's
 * `message.seen`.
 *
 * ── THE TWO DEFECTS THIS CLOSES ─────────────────────────────────────────────
 * census-telegraph T70: seen "is whatever the client asserts:
 * `routes/messaging.ts:1202-1218` stamps `message_thread_members.last_read_at
 * = now()` on any authenticated call, with no visibility predicate the server
 * can check."
 *
 * census-telegraph T179: "`read.updated` … carries a THREAD-LEVEL
 * `lastReadAt`, not a per-message seen fact, so no consumer can answer 'was
 * *this* message seen'."
 *
 * ── WHY THE THRESHOLD IS A MESSAGE AND NOT A TIMESTAMP ──────────────────────
 * `now()` is not checkable: the server cannot tell a claim about what was on
 * screen from a claim about what the clock said. A MESSAGE ID is checkable,
 * and every clause the check applies is a real refusal:
 *
 *   - it must exist, in THIS thread (a 404 that does not distinguish "no such
 *     message" from "not yours", because the distinction is itself a
 *     disclosure);
 *   - it must not be a tombstone;
 *   - it must be inside the caller's own §14.3 window, so a member cannot
 *     assert they read past a bound that exists to stop them seeing it;
 *   - and the marker it sets is the MESSAGE's `created_at`, never the request
 *     time, so "seen" cannot run ahead of what was actually sent.
 *
 * ── WHY THE MARKER ONLY EVER GOES FORWARD ───────────────────────────────────
 * A backwards write would re-open §7.4's unseen-unsend window on a message a
 * recipient has already read, which is the one thing that rule exists to
 * prevent. A request that would move it back is answered `advanced: false` and
 * writes nothing — stated rather than silently ignored, because a client that
 * cannot tell a refusal from a success will keep sending it.
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not add per-message receipt rows, and §7.3 forbids them ("Do not
 * create permanent row-per-message-per-user receipt explosions"). The
 * per-message fact is DERIVED from the one row per member that already exists,
 * exactly as `GET /threads/:id/receipts` derives it. And it does not replace
 * the legacy `POST /threads/:id/read` in `routes/messaging.ts`, which still
 * stamps `now()`: this is a second, checkable path, not a removal of the first,
 * and until the legacy path is retired T70 is only half closed.
 */
router.post(
  "/threads/:threadId/seen",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = SeenSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "upToMessageId is required");
      return;
    }

    const gate = await memberGate(client, threadId, user.id);
    if (!gate.ok) {
      sendError(res, gate.code as any, gate.message);
      return;
    }

    // The threshold message, bound to this thread in the QUERY as well as in
    // the check — two gates, because this one decides what a person may assert
    // about someone else's message.
    const { data: target, error: targetErr } = await client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("id", parsed.data.upToMessageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (targetErr) {
      log.error({ threadId, message: targetErr.message }, "seen threshold read failed");
      sendError(res, "db_error", "Could not read that message");
      return;
    }
    const t = target as any;
    if (!t || t.deleted_at != null || !withinWindow(t.created_at, gate.visibleFrom)) {
      sendError(res, "not_found", "No such message in this conversation");
      return;
    }
    const threshold = String(t.created_at);
    const thresholdMs = Date.parse(threshold);
    if (Number.isNaN(thresholdMs)) {
      sendError(res, "not_found", "No such message in this conversation");
      return;
    }

    // The caller's own marker. A failed read is never treated as "they have
    // read nothing" — that would move the marker backwards to the beginning.
    const { data: mine, error: mineErr } = await client
      .from("message_thread_members")
      .select("user_id, last_read_at")
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (mineErr || !mine) {
      log.error({ threadId, message: mineErr?.message }, "seen marker read failed");
      sendError(res, "db_error", "Could not read your position in this conversation");
      return;
    }
    const previous = ((mine as any).last_read_at ?? null) as string | null;
    const previousMs = previous ? Date.parse(previous) : null;

    if (previousMs !== null && !Number.isNaN(previousMs) && previousMs >= thresholdMs) {
      res.status(200).json({
        threadId,
        readerId: user.id,
        lastReadAt: previous,
        advanced: false,
        seenMessageIds: [],
        reason: "already_past_this_message",
      });
      return;
    }

    // What CROSSED. Everything in this member's window, at or before the
    // threshold, after their previous marker, that they did not send
    // themselves — a person does not "see" their own message.
    const floor = previous ?? gate.visibleFrom;
    let q = client
      .from("messages")
      .select(MESSAGE_COLUMNS)
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(SEEN_SCAN_LIMIT);
    if (floor) q = q.gte("created_at", floor);
    const { data: rows, error: rowsErr } = await q;
    if (rowsErr) {
      log.error({ threadId, message: rowsErr.message }, "seen crossing read failed");
      sendError(res, "db_error", "Could not read this conversation");
      return;
    }

    const crossed = ((rows as any[]) ?? [])
      .filter((r) => r.deleted_at == null)
      .filter((r) => r.sender_id !== user.id)
      .filter((r) => withinWindow(r.created_at, gate.visibleFrom))
      .filter((r) => {
        const at = Date.parse(r.created_at);
        if (Number.isNaN(at)) return false;
        if (at > thresholdMs) return false;
        if (previousMs !== null && !Number.isNaN(previousMs) && at <= previousMs) return false;
        return true;
      })
      .map((r) => String(r.id));

    const { error: writeErr } = await client
      .from("message_thread_members")
      .update({ last_read_at: threshold })
      .eq("thread_id", threadId)
      .eq("user_id", user.id);
    if (writeErr) {
      log.error({ threadId, message: writeErr.message }, "seen marker write failed");
      sendError(res, "db_error", "Could not record that you read this");
      return;
    }

    res.status(200).json({
      threadId,
      readerId: user.id,
      lastReadAt: threshold,
      advanced: true,
      seenMessageIds: crossed,
      /**
       * §7.3, stated in the response: this created no receipt rows. The
       * per-message answer is derived from the one row per member that already
       * existed.
       */
      receiptRowsWritten: 0,
      scanned: ((rows as any[]) ?? []).length,
    });

    if (crossed.length > 0) {
      void publishToThread(
        client,
        threadId,
        { type: "message.seen", payload: { readerId: user.id, messageIds: crossed, seenAt: threshold } },
        { excludeUserId: user.id },
      );
    }
    // Kept alongside, for the consumers that only want the marker.
    void publishToThread(
      client,
      threadId,
      { type: "read.updated", payload: { userId: user.id, lastReadAt: threshold } },
      { excludeUserId: user.id },
    );
  }),
);

export default router;
