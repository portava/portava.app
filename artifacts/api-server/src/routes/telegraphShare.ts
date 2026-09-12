/**
 * Telegraph §5 — Universal Portava Sharing.
 *
 *   POST /api/threads/:threadId/share
 *        Share an eligible Portava object into a conversation as a typed
 *        §6.2 PORTAVA_OBJECT message. The body persisted is a REFERENCE plus
 *        the sender's caption — never a copy of the object.
 *
 *   POST /api/threads/:threadId/share-projections
 *        §5.2 layer three: resolve a batch of references into what THIS
 *        viewer is authorized to see RIGHT NOW, or into an explicit
 *        unavailable state (§5.3).
 *
 * ── WHY THE RESOLVE ENDPOINT IS A POST ──────────────────────────────────────
 * It is a READ and it is written as one — it makes no write of any kind. It
 * takes POST because the input is a batch of (type, id) pairs and a thread of
 * fifty cards would otherwise need a query string long enough to be truncated
 * by a proxy, which would silently resolve FEWER references than the client
 * asked about. Under-resolving is the one failure mode this endpoint must not
 * have: a reference that is not resolved renders as the sender's frozen
 * snapshot, which is the §5.3 violation it exists to close.
 *
 * The four write gates (kill switch, active membership, 1:1 block guard, E2EE
 * refusal) live in `lib/telegraphThreadWrite.ts` so this route and the §6.2
 * typed-kind route cannot drift apart from each other or from the ordinary
 * send path.
 *
 * ── THE SENDER MUST BE ABLE TO SEE WHAT THEY SHARE ──────────────────────────
 * `POST /share` resolves the object FOR THE SENDER before writing the message
 * and refuses when the sender cannot see it. Sharing is not a way to launder a
 * reference to something you were never authorized to open.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { guardTelegraphThreadWrite } from "../lib/telegraphThreadWrite.js";
import { publishToThread } from "../lib/telegraphEvents.js";
import { logger as rootLogger } from "../lib/logger.js";
import {
  buildPortavaObjectBody,
  isShareable,
  resolveShareProjections,
  shareableFor,
  SHAREABLE_OBJECT_TYPES,
  type ShareRef,
} from "../services/telegraph/shareables.js";
import { msgTypeOf, type TelegraphObjectType } from "../services/telegraph/vocabulary.js";

const log = rootLogger.child({ route: "telegraphShare" });
const router = Router();

const UUID = /^[0-9a-f-]{36}$/i;

/** A conversation carries at most this many references per resolve request. */
export const MAX_SHARE_REFS = 100;

const ShareSchema = z.object({
  objectType: z.string().min(1).max(40),
  objectId: z.string().min(1).max(200),
  caption: z.string().max(500).nullish(),
});

const ResolveSchema = z.object({
  refs: z
    .array(
      z.object({
        objectType: z.string().min(1).max(40),
        objectId: z.string().min(1).max(200),
        messageId: z.string().max(64).nullish(),
      }),
    )
    .min(1)
    .max(MAX_SHARE_REFS),
});

// ── POST /api/threads/:threadId/share ────────────────────────────────────────

router.post(
  "/threads/:threadId/share",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = ShareSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }
    const { objectType, objectId, caption } = parsed.data;
    if (!isShareable(objectType)) {
      sendError(
        res,
        "invalid_payload",
        `objectType must be one of: ${SHAREABLE_OBJECT_TYPES.join(", ")}`,
      );
      return;
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id);
    if (!guard.ok) {
      sendError(res, guard.code, guard.message);
      return;
    }
    const sc = client;

    // §5.3, applied at the SEND end: you may only share what you can open.
    const shareable = shareableFor(sc, objectType as TelegraphObjectType, objectId);
    if (!shareable) {
      sendError(res, "invalid_payload", "That object family cannot be shared");
      return;
    }
    const senderState = await shareable.getCurrentState(user.id);
    if (!senderState.available) {
      sendError(
        res,
        senderState.reason === "not_found" ? "not_found" : "forbidden",
        "You cannot share this object",
      );
      return;
    }

    const body = buildPortavaObjectBody(objectType as TelegraphObjectType, objectId, caption ?? null);
    const now = new Date().toISOString();

    const { data: msg, error: msgErr } = await sc
      .from("messages")
      .insert({
        thread_id: threadId,
        sender_id: user.id,
        body: JSON.stringify(body),
        created_at: now,
        // §6.2's PORTAVA_OBJECT kind. `messages.msg_type` carries no CHECK
        // constraint (baseline/20260819_baseline_structure.sql:7565), so this
        // needs no migration; `subtype` names the family for renderers that
        // switch on it.
        msg_type: msgTypeOf("PORTAVA_OBJECT"),
        subtype: objectType.toLowerCase(),
      })
      .select("id, thread_id, sender_id, body, created_at, msg_type, subtype")
      .single();

    if (msgErr || !msg) {
      log.error({ err: msgErr, threadId }, "share message insert failed");
      sendError(res, "db_error", msgErr?.message ?? "Failed to share");
      return;
    }

    const { error: bumpErr } = await sc
      .from("message_threads")
      .update({ last_message_at: now, updated_at: now })
      .eq("id", threadId);
    if (bumpErr) {
      log.warn({ err: bumpErr, threadId }, "thread bump after share failed (message was written)");
    }

    const m = msg as any;
    res.status(201).json({
      id: m.id,
      threadId: m.thread_id,
      senderId: m.sender_id,
      createdAt: m.created_at,
      msgType: m.msg_type,
      subtype: m.subtype,
      share: body,
    });

    void publishToThread(sc, threadId, {
      type: "message.created",
      payload: {
        messageId: m.id,
        senderId: m.sender_id,
        msgType: m.msg_type,
        subtype: m.subtype,
        createdAt: m.created_at,
      },
    });
  }),
);

// ── POST /api/threads/:threadId/share-projections ────────────────────────────

router.post(
  "/threads/:threadId/share-projections",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;

    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = ResolveSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid body");
      return;
    }

    const { data: membership, error: mErr } = await client
      .from("message_thread_members")
      .select("user_id, left_at")
      .eq("thread_id", threadId)
      .eq("user_id", user.id)
      .is("left_at", null)
      .maybeSingle();
    if (mErr) {
      sendError(res, "db_error", "Could not verify thread membership");
      return;
    }
    if (!membership) {
      sendError(res, "forbidden", "Not an active member of this thread");
      return;
    }

    const refs: ShareRef[] = [];
    const rejected: Array<{ objectType: string; objectId: string }> = [];
    for (const r of parsed.data.refs) {
      if (!isShareable(r.objectType)) {
        rejected.push({ objectType: r.objectType, objectId: r.objectId });
        continue;
      }
      refs.push({
        objectType: r.objectType as TelegraphObjectType,
        objectId: r.objectId,
        messageId: r.messageId ?? undefined,
      });
    }

    const resolved = await resolveShareProjections(client, user.id, threadId, refs);

    res.status(200).json({
      threadId,
      projections: resolved,
      // A family this server cannot resolve is named, never silently dropped:
      // a dropped ref renders as the sender's snapshot, which is the thing
      // §5.3 forbids.
      unsupported: rejected,
    });
  }),
);

export default router;
