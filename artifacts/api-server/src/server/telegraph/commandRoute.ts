/**
 * Telegraph §13.1 — `POST /api/telegraph/commands`.
 *
 * One typed door for the commands that have no other one. §13.1 names eighteen;
 * this endpoint issues the two that migrations 2810/2811 made representable and
 * that no route has ever offered — `UNSEND_MESSAGE` and `ADD_REACTION` — plus
 * `REMOVE_REACTION`, and REFUSES the rest by name, telling a caller where each
 * actually lives.
 *
 * WHY NOT A ROUTE EACH
 * ====================
 * Two reasons, and the second is the real one. The shallow reason is that these
 * commands share an envelope, an authorization path and a failure vocabulary,
 * so three endpoints would restate all three. The real reason is that both
 * commands depend on schema NO DATABASE HAS: `messages.unsent_at` (2810) and
 * `public.message_reactions` (2811). A single door can carry a single gate —
 * `telegraph_message_kernel_enabled`, read once — and answer
 * `feature_disabled` everywhere the schema is absent. Three routes would be
 * three places to forget it, and forgetting it means a 42703 from PostgREST
 * rather than a refusal a client can read.
 *
 * THE ACTOR COMES FROM THE TOKEN, NEVER FROM THE BODY
 * ==================================================
 * A body that names an actor is REFUSED rather than ignored. Silently
 * overriding it would let a caller believe they had acted as someone else —
 * the same rule `server/trips/commandRoute.ts` states, for the same reason.
 *
 * AUTHORIZATION IS HERE *AND* IN THE HANDLER
 * ==========================================
 * The route establishes conversation membership before dispatching anything, so
 * a non-member never reaches a handler; each handler then re-checks what IT
 * needs (ownership of the message being unsent, the §7.4 seen-state rule). The
 * outer check is not redundant: it is what keeps a stranger from probing which
 * message ids exist by watching which refusal they get.
 */

import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { publishToThread } from "../../lib/telegraphEvents.js";
import { messageKernelEnabled } from "../../services/telegraphMessageKernel.js";
import { createCoordinationSession } from "../../services/telegraph/coordinationSessions.js";
import {
  ISSUABLE_COMMANDS,
  LEGACY_PATH_COMMANDS,
  SCHEMA_GATED_COMMANDS,
  UNIMPLEMENTED_COMMANDS,
  isIssuable,
  refusal,
  success,
  type TelegraphCommandResult,
} from "../../domain/telegraph/commands/telegraphCommands.js";
import { redactForWire } from "../../domain/telegraph/contracts/telegraphReasonCodes.js";

const router = Router();
const log = rootLogger.child({ route: "telegraphCommands.kernel" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reason codes that mean "you may not", so they map to 403 rather than 409. */
const FORBIDDEN_REASONS = new Set<string>([
  "TELEGRAPH_AUTH_NOT_MEMBER",
  "TELEGRAPH_AUTH_LEFT_THREAD",
  "TELEGRAPH_AUTH_NOT_SENDER",
  "TELEGRAPH_AUTH_BLOCKED",
]);

router.post(
  "/telegraph/commands",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const body = (req.body ?? {}) as Record<string, unknown>;

    // A body that names an actor is refused, not ignored. See the header.
    if ("actorUserId" in body || "actorId" in body || "senderId" in body) {
      sendError(res, "invalid_payload", "The actor is taken from the verified token; it may not be supplied.");
      return;
    }

    const type = String(body["type"] ?? "").trim();
    const conversationId = String(body["conversationId"] ?? body["threadId"] ?? "").trim();
    const params = (body["params"] ?? {}) as Record<string, unknown>;

    if (!type) { sendError(res, "invalid_payload", "type is required"); return; }
    if (!UUID_RE.test(conversationId)) { sendError(res, "invalid_payload", "conversationId must be a uuid"); return; }

    if (!isIssuable(type)) {
      const legacy = LEGACY_PATH_COMMANDS[type];
      if (legacy) {
        // 409, not 400: the command is real and this is the wrong door. A 400
        // would read as "you made that up".
        res.status(409).json({
          error: "wrong_endpoint",
          message: `${type} is issued by ${legacy}. This endpoint only issues commands with no other writer, so that the guards on the existing path are never routed around.`,
          issuable: ISSUABLE_COMMANDS,
        });
        return;
      }
      if (UNIMPLEMENTED_COMMANDS.includes(type)) {
        res.status(501).json({
          error: "not_implemented",
          message: `${type} is named by Telegraph §13.1 and nothing in this repository implements it.`,
          issuable: ISSUABLE_COMMANDS,
        });
        return;
      }
      sendError(res, "invalid_payload", `Unknown command: ${type}`);
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    // The gate is PER COMMAND, not per endpoint. `SCHEMA_GATED_COMMANDS` names
    // the three that need columns and tables 2810/2811 add; answering
    // feature_disabled for those is the difference between a refusal a client
    // can render and a 42703 it cannot. CREATE_COORDINATION_SESSION needs none
    // of that schema — it writes a `messages` row through columns every
    // deployment already has — and gating it here would put a live capability
    // behind a switch that exists for a different reason. See the note on
    // ISSUABLE_COMMANDS.
    if (SCHEMA_GATED_COMMANDS.has(type) && !(await messageKernelEnabled(sc))) {
      sendError(res, "feature_disabled",
        "Telegraph message commands are not enabled on this deployment.");
      return;
    }

    // Membership, before any handler. A non-member must not be able to tell
    // which message ids exist by watching which refusal comes back.
    const { data: membership, error: membershipErr } = await sc
      .from("message_thread_members")
      .select("user_id, left_at")
      .eq("thread_id", conversationId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (membershipErr) {
      log.error({ err: membershipErr, conversationId }, "command route: membership unreadable");
      sendError(res, "degraded_unavailable", "We could not verify this conversation right now. Please try again shortly.");
      return;
    }
    if (!membership || (membership as any).left_at != null) {
      res.status(403).json({ error: "forbidden", reason: "TELEGRAPH_AUTH_NOT_MEMBER" });
      return;
    }

    /**
     * §13.1 `CREATE_COORDINATION_SESSION`, handled before the switch because
     * its failure vocabulary is not the switch's.
     *
     * The other three commands here answer 403 or 409 and nothing else — every
     * way they fail is "you may not" or "it already moved". This one can also
     * fail with "you did not send an idempotency key", which is a 400 and a
     * client bug, and collapsing that into a 409 would send an author looking
     * for a conflict that is not there.
     *
     * `body.idempotency_key` is accepted beside `params.idempotencyKey` because
     * the trip command endpoint takes it at the envelope's top level and a
     * caller who has written one client should not have to discover that the
     * other spells it differently. Snake at the envelope, camel in the params:
     * both are read, and the envelope wins when both are present because that
     * is where a generic retry wrapper would put it.
     */
    if (type === "CREATE_COORDINATION_SESSION") {
      const envelopeKey = typeof body["idempotency_key"] === "string" ? body["idempotency_key"] : "";
      const paramKey = typeof params["idempotencyKey"] === "string" ? (params["idempotencyKey"] as string) : "";
      const created = await createCoordinationSession(sc, {
        threadId: conversationId,
        actorUserId: user.id,
        title: String(params["title"] ?? ""),
        planObjectId: typeof params["planObjectId"] === "string" ? (params["planObjectId"] as string) : null,
        note: typeof params["note"] === "string" ? (params["note"] as string) : null,
        idempotencyKey: envelopeKey || paramKey,
        // §14.3's window is not applied here. This endpoint's membership check
        // above is the gate, and the idempotency lookup reads the caller's own
        // conversation; narrowing it by a window the caller has not been handed
        // would make a retry mint a duplicate for a member whose history is
        // bounded. The coordination route, which HAS the window, passes it.
        visibleFrom: null,
      });
      if (!created.ok) {
        if (created.code === "db_error") {
          log.error({ conversationId, detail: created.message }, "CREATE_COORDINATION_SESSION write failed");
          // 503 and not 400: the command may have been perfectly valid. The
          // same distinction `server/trips/commandRoute.ts` draws for
          // TRIP_KERNEL_UNAVAILABLE, and for the same reason — telling a caller
          // their input was wrong when the database was unreachable sends them
          // to fix the wrong thing.
          res.status(503).json({
            ok: false,
            error: "degraded_unavailable",
            command: type,
            reason: "TELEGRAPH_DEGRADED_THREAD_UNREADABLE",
          });
          return;
        }
        sendError(res, "invalid_payload", created.message);
        return;
      }
      res.status(200).json({
        ...success(type, {
          sessionId: created.session.sessionId,
          state: created.session.state,
          version: created.session.version,
          startedAt: created.session.startedAt,
        }),
        duplicate: created.duplicate,
      });
      return;
    }

    let result: TelegraphCommandResult;
    switch (type) {
      case "UNSEND_MESSAGE":   result = await unsendMessage(sc, user.id, conversationId, params); break;
      case "ADD_REACTION":     result = await addReaction(sc, user.id, conversationId, params); break;
      case "REMOVE_REACTION":  result = await removeReaction(sc, user.id, conversationId, params); break;
      default:                 result = refusal(type, "TELEGRAPH_AUTH_NOT_MEMBER"); break;
    }

    if (!result.ok) {
      const reason = result.reason ?? "TELEGRAPH_AUTH_NOT_MEMBER";
      const status = FORBIDDEN_REASONS.has(reason) ? 403 : 409;
      res.status(status).json({
        error: status === 403 ? "forbidden" : "conflict",
        command: result.command,
        reason: redactForWire(reason),
      });
      return;
    }

    res.status(200).json(result);
  }),
);

/* ───────────────────────────── UNSEND_MESSAGE ─────────────────────────────── */

/**
 * §7.4 / §13.1 `UNSEND_MESSAGE`.
 *
 * THE RULE THAT MAKES IT AN UNSEND AND NOT A DELETE
 * ================================================
 * §7.4 and §27.1 both say it: once an eligible recipient has SEEN the message,
 * an unsend is impossible. An unsend claims the message was never delivered to
 * a mind; after somebody has read it that claim is false, and offering it
 * anyway teaches people the product can retract things it cannot. Delete
 * remains available and means what it says — a tombstone, visible as one.
 *
 * "SEEN" is read from `message_thread_members.last_read_at`, which is the only
 * seen state this tree has. It is thread-level, so this is CONSERVATIVE: a
 * member whose last_read_at is after the message's created_at is treated as
 * having seen it even if they never looked at that particular message. Erring
 * that way refuses some unsends that would have been legitimate; erring the
 * other way would permit one that was not, and only one of those two mistakes
 * is recoverable.
 *
 * AN UNREADABLE ROSTER REFUSES. The same rule as everywhere else in this lane:
 * "we could not check whether anyone saw it" is not "nobody saw it".
 */
async function unsendMessage(
  sc: any,
  userId: string,
  conversationId: string,
  params: Record<string, unknown>,
): Promise<TelegraphCommandResult> {
  const messageId = String(params["messageId"] ?? "");
  if (!UUID_RE.test(messageId)) return refusal("UNSEND_MESSAGE", "TELEGRAPH_LIFECYCLE_NOT_EDITABLE");

  const { data: msg, error: msgErr } = await sc
    .from("messages")
    .select("id, thread_id, sender_id, created_at, deleted_at, unsent_at")
    .eq("id", messageId)
    .eq("thread_id", conversationId)
    .maybeSingle();
  if (msgErr) return refusal("UNSEND_MESSAGE", "TELEGRAPH_DEGRADED_THREAD_UNREADABLE");
  // A message in another conversation answers exactly as a message that does
  // not exist: not-sender. Distinguishing them would make this endpoint a
  // message-existence oracle.
  if (!msg) return refusal("UNSEND_MESSAGE", "TELEGRAPH_AUTH_NOT_SENDER");
  if ((msg as any).sender_id !== userId) return refusal("UNSEND_MESSAGE", "TELEGRAPH_AUTH_NOT_SENDER");
  if ((msg as any).deleted_at != null) return refusal("UNSEND_MESSAGE", "TELEGRAPH_LIFECYCLE_ALREADY_DELETED");
  if ((msg as any).unsent_at != null) return refusal("UNSEND_MESSAGE", "TELEGRAPH_LIFECYCLE_ALREADY_UNSENT");

  const createdAt = String((msg as any).created_at);

  const { data: others, error: othersErr } = await sc
    .from("message_thread_members")
    .select("user_id, last_read_at")
    .eq("thread_id", conversationId)
    .is("left_at", null)
    .neq("user_id", userId);
  if (othersErr) return refusal("UNSEND_MESSAGE", "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE");

  const createdMs = Date.parse(createdAt);
  const seenByAnyone = ((others as any[]) ?? []).some((m) => {
    const lr = m.last_read_at;
    if (!lr) return false;
    const lrMs = Date.parse(String(lr));
    return Number.isFinite(lrMs) && Number.isFinite(createdMs) && lrMs >= createdMs;
  });
  if (seenByAnyone) return refusal("UNSEND_MESSAGE", "TELEGRAPH_LIFECYCLE_SEEN_BY_RECIPIENT");

  const now = new Date().toISOString();
  // The row is RETAINED and redacted, not removed: §17.2 requires the tombstone
  // so the sequence stays continuous. `body: ''` rather than NULL because
  // messages.body is NOT NULL — the same constraint the delete path documents.
  const { error: updErr } = await sc
    .from("messages")
    .update({ unsent_at: now, lifecycle_state: "unsent", body: "" })
    .eq("id", messageId)
    .is("unsent_at", null);
  if (updErr) return refusal("UNSEND_MESSAGE", "TELEGRAPH_DEGRADED_THREAD_UNREADABLE");

  // §13.2 `message.unsent`, after the write. The outbox trigger has already
  // written the durable event inside the same transaction as the UPDATE; this
  // is the realtime nudge, and it carries no body because there is none.
  void publishToThread(sc, conversationId, {
    type: "message.unsent",
    payload: { messageId, unsentAt: now, senderId: userId },
  }, { excludeUserId: userId });

  return success("UNSEND_MESSAGE", { messageId, unsentAt: now });
}

/* ───────────────────────────── reactions ──────────────────────────────────── */

/** A conservative emoji guard: short, and not whitespace or ASCII punctuation. */
function validEmoji(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (s.length < 1 || s.length > 16) return null;
  // Deliberately not a Unicode-property emoji test. The point of the length cap
  // and this check is that the column cannot become a second message body; a
  // precise emoji regexp would reject new sequences as they are standardised
  // and would have to be maintained forever to keep working.
  if (/^[\x00-\x7F]*$/.test(s) && !/^[a-zA-Z0-9]{1,4}$/.test(s)) return null;
  return s;
}

async function addReaction(
  sc: any,
  userId: string,
  conversationId: string,
  params: Record<string, unknown>,
): Promise<TelegraphCommandResult> {
  const messageId = String(params["messageId"] ?? "");
  if (!UUID_RE.test(messageId)) return refusal("ADD_REACTION", "TELEGRAPH_LIFECYCLE_NOT_EDITABLE");
  const emoji = validEmoji(params["emoji"]);
  if (emoji === null) return refusal("ADD_REACTION", "TELEGRAPH_MEDIA_KIND_NOT_ALLOWED");

  const { data: msg, error: msgErr } = await sc
    .from("messages")
    .select("id, deleted_at, unsent_at")
    .eq("id", messageId)
    .eq("thread_id", conversationId)
    .maybeSingle();
  if (msgErr) return refusal("ADD_REACTION", "TELEGRAPH_DEGRADED_THREAD_UNREADABLE");
  if (!msg) return refusal("ADD_REACTION", "TELEGRAPH_AUTH_NOT_MEMBER");
  // Reacting to a retracted message would resurrect it in every UI that renders
  // a reaction row.
  if ((msg as any).deleted_at != null) return refusal("ADD_REACTION", "TELEGRAPH_LIFECYCLE_ALREADY_DELETED");
  if ((msg as any).unsent_at != null) return refusal("ADD_REACTION", "TELEGRAPH_LIFECYCLE_ALREADY_UNSENT");

  // The primary key (message, user, emoji) makes a repeat idempotent rather
  // than a duplicate row, so an upsert is the correct shape and a double-tap is
  // not an error.
  const { error: insErr } = await sc
    .from("message_reactions")
    .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: "message_id,user_id,emoji" });
  if (insErr) return refusal("ADD_REACTION", "TELEGRAPH_DEGRADED_SCHEMA_ABSENT");

  return success("ADD_REACTION", { messageId, emoji });
}

async function removeReaction(
  sc: any,
  userId: string,
  conversationId: string,
  params: Record<string, unknown>,
): Promise<TelegraphCommandResult> {
  const messageId = String(params["messageId"] ?? "");
  if (!UUID_RE.test(messageId)) return refusal("REMOVE_REACTION", "TELEGRAPH_LIFECYCLE_NOT_EDITABLE");
  const emoji = validEmoji(params["emoji"]);
  if (emoji === null) return refusal("REMOVE_REACTION", "TELEGRAPH_MEDIA_KIND_NOT_ALLOWED");

  // Scoped to the caller's OWN reaction. There is no path here that removes
  // somebody else's, and the delete names user_id rather than relying on a
  // policy to enforce it — the service role bypasses policies.
  const { error: delErr } = await sc
    .from("message_reactions")
    .delete()
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .eq("emoji", emoji);
  if (delErr) return refusal("REMOVE_REACTION", "TELEGRAPH_DEGRADED_SCHEMA_ABSENT");

  void conversationId;
  return success("REMOVE_REACTION", { messageId, emoji });
}

export default router;
