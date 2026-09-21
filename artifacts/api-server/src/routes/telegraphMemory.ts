/**
 * Telegraph §10 — save to Memory, and the end-of-night recap.
 *
 *   POST /api/me/memory-drafts   §10.2: promote ONE saved message into a
 *                                PRIVATE Memory draft.
 *   GET  /api/threads/:threadId/recap   §10.3: the end-of-night recap for a
 *                                confirmed plan window. A READ. Writes nothing.
 *
 * ── WHY THE DRAFT ROUTE TAKES ONE MESSAGE ID ────────────────────────────────
 * §10.2: "Telegraph never automatically converts whole conversations into
 * Memories." This route is the only thing in the Telegraph tree that writes a
 * `memories` row, it takes `messageId` (singular, not an array, not a
 * threadId), and it writes exactly one row per call with
 * `state='draft'` and `visibility='only_me'` as literals. A caller cannot ask
 * for a published Memory, cannot ask for a visible one, and cannot ask for a
 * whole thread.
 *
 * ── RE-AUTHORIZATION AT PROMOTION ───────────────────────────────────────────
 * A save is not a permanent grant. The message is re-read at promotion time
 * and refused when the caller is no longer an active member of its thread,
 * when it has been deleted, or when it is outside the caller's §14.3 window —
 * the same three rules `GET /me/saved-messages` applies.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import {
  buildRecap,
  draftTitleFor,
  memoryDraftRow,
  recapHeadline,
  type DraftSource,
  type RecapRow,
} from "../services/telegraph/memoryNotes.js";
import {
  historyBoundEnabled,
  membershipSelect,
  visibleFromOf,
  withinWindow,
} from "../services/groupChatHistoryBound.js";

const log = rootLogger.child({ route: "telegraphMemory" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** How many rows a recap window scans. */
export const RECAP_SCAN_LIMIT = 400;

const DraftSchema = z.object({
  /** SINGULAR. §10.2 has no bulk form and neither does this. */
  messageId: z.string().regex(UUID),
  title: z.string().max(120).nullish(),
  caption: z.string().max(1000).nullish(),
});

// ── POST /api/me/memory-drafts ───────────────────────────────────────────────

router.post(
  "/me/memory-drafts",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    // A body naming a thread or a list is refused BY NAME, so the absence of a
    // bulk path is visible to a caller rather than only to a reader of the code.
    const body = req.body ?? {};
    for (const forbidden of ["threadId", "messageIds", "conversationId", "all"]) {
      if (Object.prototype.hasOwnProperty.call(body, forbidden)) {
        sendError(
          res,
          "invalid_payload",
          `"${forbidden}" is not accepted. §10.2: Telegraph never converts whole conversations into Memories; promote one message at a time.`,
        );
        return;
      }
    }

    const parsed = DraftSchema.safeParse(body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "messageId is required");
      return;
    }

    const { data: msg, error: msgErr } = await client
      .from("messages")
      .select("id, thread_id, sender_id, body, created_at, deleted_at, msg_type, subtype, media_type, media_url")
      .eq("id", parsed.data.messageId)
      .maybeSingle();
    if (msgErr) {
      sendError(res, "db_error", "Could not read that message");
      return;
    }
    if (!msg || (msg as any).deleted_at) {
      sendError(res, "not_found", "That message is not available");
      return;
    }
    const m = msg as any;

    // Re-authorize: active membership plus the §14.3 window.
    const boundOn = await historyBoundEnabled(client);
    const { data: membership, error: memErr } = await client
      .from("message_thread_members")
      .select(membershipSelect("user_id, left_at", boundOn))
      .eq("thread_id", m.thread_id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (memErr) {
      sendError(res, "db_error", "Could not verify your access to that message");
      return;
    }
    if (!membership || (membership as any).left_at !== null) {
      sendError(res, "forbidden", "You no longer have access to that message");
      return;
    }
    const visibleFrom = visibleFromOf(membership as any, boundOn);
    if (!withinWindow(m.created_at, visibleFrom)) {
      sendError(res, "forbidden", "That message is outside your history window");
      return;
    }

    const source: DraftSource =
      m.media_url && m.media_type ? "media"
      : (m.msg_type === "location" || m.subtype === "discovery_card") ? "place_share"
      : m.msg_type === "voice" ? "voice_note"
      : "message";

    const row = memoryDraftRow({
      messageId: m.id,
      ownerId: user.id,
      title: parsed.data.title ?? draftTitleFor(source, typeof m.body === "string" ? m.body : null),
      caption: parsed.data.caption ?? null,
      occurredAt: m.created_at ?? null,
      source,
    });

    const { data: created, error: createErr } = await client
      .from("memories")
      .insert(row)
      .select("id, owner_id, state, visibility, title, starts_at")
      .single();
    if (createErr || !created) {
      log.error({ err: createErr, messageId: m.id }, "memory draft insert failed");
      sendError(res, "db_error", createErr?.message ?? "Could not create the draft");
      return;
    }

    // Record the save too, so the saved list and the draft agree.
    const { error: saveErr } = await client
      .from("saved_messages")
      .insert({ user_id: user.id, message_id: m.id });
    if (saveErr) {
      log.warn({ err: saveErr, messageId: m.id }, "saved_messages insert failed (draft was created)");
    }

    const c = created as any;
    res.status(201).json({
      draft: {
        id: c.id,
        ownerId: c.owner_id,
        state: c.state,
        visibility: c.visibility,
        title: c.title,
        occurredAt: c.starts_at ?? null,
        fromMessageId: m.id,
        source,
      },
    });
  }),
);

// ── GET /api/threads/:threadId/recap ─────────────────────────────────────────

router.get(
  "/threads/:threadId/recap",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const planIdRaw = typeof req.query.planId === "string" ? req.query.planId : null;
    if (planIdRaw !== null && !UUID.test(planIdRaw)) {
      sendError(res, "invalid_payload", "Invalid planId");
      return;
    }

    const boundOn = await historyBoundEnabled(client);
    const { data: membership, error: memErr } = await client
      .from("message_thread_members")
      .select(membershipSelect("user_id, left_at", boundOn))
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (memErr) {
      sendError(res, "db_error", "Could not verify thread membership");
      return;
    }
    if (!membership || (membership as any).left_at !== null) {
      sendError(res, "forbidden", "Not an active member of this thread");
      return;
    }
    const visibleFrom = visibleFromOf(membership as any, boundOn);

    // §10.3: CONFIRMED session context. The window is the plan's own, and a
    // thread with no completed plan has no session to recap — it does not get
    // a made-up one from "the last few hours".
    let planQuery = client
      .from("meetups")
      .select("id, title, starts_at, ends_at, status, chat_thread_id")
      .eq("chat_thread_id", threadId)
      .limit(20);
    if (planIdRaw) planQuery = planQuery.eq("id", planIdRaw);
    const { data: plans, error: planErr } = await planQuery;
    if (planErr) {
      sendError(res, "db_error", "Could not read this conversation's plans");
      return;
    }

    const nowMs = Date.now();
    const candidates = ((plans as any[]) ?? [])
      .filter((p) => p.starts_at && p.status !== "cancelled")
      .filter((p) => Date.parse(p.ends_at ?? p.starts_at) <= nowMs)
      .sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
    const plan = candidates[0] ?? null;

    if (!plan) {
      res.status(200).json({
        recap: null,
        headline: "",
        reason: "no_completed_plan",
      });
      return;
    }

    const { data: invites, error: invErr } = await client
      .from("meetup_invites")
      .select("user_id, status")
      .eq("meetup_id", plan.id)
      .in("status", ["going", "maybe"]);
    if (invErr) {
      sendError(res, "db_error", "Could not read who was there");
      return;
    }
    const participantIds = [
      ...new Set([
        ...((invites as any[]) ?? []).map((i) => i.user_id as string),
        ...(plan.creator_id ? [plan.creator_id as string] : []),
      ]),
    ].filter(Boolean);

    let q = client
      .from("messages")
      .select("id, sender_id, created_at, deleted_at, msg_type, subtype, media_type, media_url, body")
      .eq("thread_id", threadId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(RECAP_SCAN_LIMIT);
    if (visibleFrom) q = q.gte("created_at", visibleFrom);
    const { data: rows, error: rowErr } = await q;
    if (rowErr) {
      sendError(res, "db_error", "Could not read this conversation");
      return;
    }

    const windowed = ((rows as any[]) ?? []).filter((r) => withinWindow(r.created_at, visibleFrom));

    const recap = buildRecap({
      threadId,
      planId: plan.id as string,
      windowStartsAt: (plan.starts_at as string) ?? null,
      windowEndsAt: (plan.ends_at as string) ?? null,
      rows: windowed as RecapRow[],
      participantIds,
    });

    res.status(200).json({
      recap,
      headline: recapHeadline(recap.counts),
      /**
       * §10.3, said out loud: this endpoint created nothing. Every action in
       * `curateActions` is an offer the user may decline.
       */
      wrote: "nothing",
    });
  }),
);

export default router;
