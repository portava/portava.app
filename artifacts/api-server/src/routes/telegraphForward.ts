/**
 * Telegraph §30A.9 forwarding and §30A.16 schema discovery (census-telegraph
 * T406, T407, T353, T429, T431).
 *
 *   POST /api/threads/:threadId/forward
 *        Forward one message the caller can see into :threadId. The derivative
 *        is FORWARDED (a person's words) or RESHARED_FROM_SOURCE (a Portava
 *        object, re-resolved per recipient). COPIED_ATTACHMENT is refused — see
 *        services/telegraph/forwarding.ts.
 *
 *   PUT  /api/threads/:threadId/messages/:messageId/content-capability
 *        The author states ALLOW / NO_FORWARD / SOURCE_POLICY /
 *        EXPIRES_WITH_SOURCE on their own message.
 *
 *   GET  /api/telegraph/structured-schemas
 *        The schema registry and the negotiation headers, for a client.
 *
 * All three are behind flags seeded FALSE (3665) and answer feature_disabled
 * while off; no existing path changes.
 *
 * ── THE SOURCE IS NEVER CONFIRMED TO A STRANGER ─────────────────────────────
 * A caller who is not an active member of the source thread, or who is outside
 * their §14.3 window, gets EXACTLY the response a non-existent message id gets.
 * A forward endpoint that answered "forbidden" for a real message and
 * "not_found" for a fake one would be an oracle for message ids in threads the
 * caller has never seen.
 */
import { Router } from "express";
import { z } from "zod";
import { requireUser, sendError } from "../lib/http.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { getServiceClient } from "../lib/supabase.js";
import { isFlagEnabled } from "../lib/featureFlags.js";
import { guardTelegraphThreadWrite, sendThreadWriteRefusal } from "../lib/telegraphThreadWrite.js";
import { publishToThread } from "../lib/telegraphEvents.js";
import { logger as rootLogger } from "../lib/logger.js";
import { historyBoundEnabled, visibleFromOf, withinWindow } from "../services/groupChatHistoryBound.js";
import { parsePortavaObjectBody, shareableFor } from "../services/telegraph/shareables.js";
import type { TelegraphObjectType } from "../services/telegraph/vocabulary.js";
import {
  CONTENT_CAPABILITIES,
  decideForward,
  FORWARD_REFUSAL_MESSAGES,
  FORWARDING_FLAG,
  forwardShapeOf,
  setCapabilityDecision,
  type ForwardSource,
} from "../services/telegraph/forwarding.js";
import {
  ACTION_MIN_VERSIONS,
  BASELINE_CLIENT_SCHEMAS,
  CLIENT_ACTIONS_HEADER,
  CLIENT_SCHEMAS_HEADER,
  registryForClients,
  STRUCTURED_SCHEMAS_FLAG,
} from "../services/telegraph/structuredSchemas.js";

const log = rootLogger.child({ route: "telegraphForward" });
const router = Router();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ForwardSchema = z.object({ sourceMessageId: z.string().regex(UUID) });
const CapabilitySchema = z.object({ capability: z.enum(CONTENT_CAPABILITIES) });

const SOURCE_COLUMNS = "id, thread_id, sender_id, body, msg_type, subtype, media_url, deleted_at, created_at";

const GONE = FORWARD_REFUSAL_MESSAGES.source_unavailable;

/**
 * Can `userId` see message `source` right now? Active membership of its thread
 * and inside their §14.3 window. `null` = could not tell (refuse, retryable).
 */
async function canSeeMessage(
  sc: any,
  source: { thread_id: string; sender_id: string; created_at: string },
  userId: string,
): Promise<boolean | null> {
  const boundOn = await historyBoundEnabled(sc);
  // Two literal column lists rather than `membershipSelect(...)`: check:write-path-columns resolves
  // literals only, and `visible_from_at` must not be named on a database without 2400 (flag OFF).
  const members = boundOn
    ? sc.from("message_thread_members").select("user_id, left_at, visible_from_at")
    : sc.from("message_thread_members").select("user_id, left_at");
  const { data, error } = await members
    .eq("thread_id", source.thread_id)
    .eq("user_id", userId)
    .is("left_at", null)
    .maybeSingle();
  if (error) return null;
  if (!data) return false;
  return withinWindow(source.created_at, visibleFromOf(data as any, boundOn), {
    senderId: source.sender_id,
    viewerId: userId,
  });
}

// ── POST /api/threads/:threadId/forward ──────────────────────────────────────

router.post(
  "/threads/:threadId/forward",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;
    const { threadId } = req.params;
    if (!UUID.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid threadId");
      return;
    }
    const parsed = ForwardSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", "sourceMessageId must be a message id");
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client not ready");
      return;
    }
    if (!(await isFlagEnabled(sc, FORWARDING_FLAG))) {
      sendError(res, "feature_disabled", "Forwarding is not available");
      return;
    }

    const { data: src, error: srcErr } = await sc
      .from("messages")
      .select(SOURCE_COLUMNS)
      .eq("id", parsed.data.sourceMessageId)
      .maybeSingle();
    if (srcErr) {
      sendError(res, "degraded_unavailable", "We could not read that message right now. Please try again shortly.");
      return;
    }
    if (!src) {
      sendError(res, "not_found", GONE);
      return;
    }
    const source = src as ForwardSource & { created_at: string };

    const visible = await canSeeMessage(sc, source, user.id);
    if (visible === null) {
      sendError(res, "degraded_unavailable", "We could not verify that message right now. Please try again shortly.");
      return;
    }
    if (!visible) {
      sendError(res, "not_found", GONE); // the same answer a fake id gets — see the header
      return;
    }

    const { data: srcThread, error: thErr } = await sc
      .from("message_threads")
      .select("is_e2ee")
      .eq("id", source.thread_id)
      .maybeSingle();
    const { data: capRow, error: capErr } = await sc
      .from("message_content_capabilities")
      .select("capability")
      .eq("message_id", source.id)
      .maybeSingle();
    const { data: inhRow, error: inhErr } = await sc
      .from("message_forwards")
      .select("capability")
      .eq("target_message_id", source.id)
      .maybeSingle();
    if (thErr || capErr || inhErr) {
      // An unreadable capability is never read as "no capability" — that would be the default, and
      // a NO_FORWARD the author stated must not be lost to a failed read.
      log.warn({ err: thErr ?? capErr ?? inhErr, threadId }, "forward: source facts unreadable — refused");
      sendError(res, "degraded_unavailable", "We could not check whether that message can be forwarded. Please try again shortly.");
      return;
    }

    let objectAvailableToForwarder: boolean | undefined;
    if (forwardShapeOf(source) === "object") {
      const ref = parsePortavaObjectBody(source.body)!;
      const shareable = shareableFor(client, ref.objectType as TelegraphObjectType, ref.objectId, undefined, {
        log: req.log,
        conversationId: threadId,
      });
      objectAvailableToForwarder = shareable ? (await shareable.getCurrentState(user.id)).available : false;
    }

    const decision = decideForward({
      source,
      forwarderId: user.id,
      sourceIsE2ee: (srcThread as any)?.is_e2ee === true,
      explicitCapability: (capRow as any)?.capability ?? null,
      inheritedCapability: (inhRow as any)?.capability ?? null,
      objectAvailableToForwarder,
    });
    if (!decision.ok) {
      sendError(res, decision.code === "source_unavailable" ? "not_found" : "forbidden", decision.message, {
        reason: decision.code,
      });
      return;
    }

    const guard = await guardTelegraphThreadWrite(client, threadId, user.id);
    if (!guard.ok) {
      sendThreadWriteRefusal(res, guard);
      return;
    }

    // ONE transaction: the derivative, its provenance row, and a re-check of the source and its
    // capability under a row lock (3665). Two PostgREST writes could leave a copy with no
    // provenance row — a copy that would never expire with its source.
    const { data: rec, error: recErr } = await sc.rpc("telegraph_record_forward", {
      p_source_message_id: source.id,
      p_target_thread_id: threadId,
      p_forwarder_id: user.id,
      p_body: decision.body,
      p_msg_type: decision.msgType,
      p_subtype: decision.subtype,
      p_provenance: decision.provenance,
      p_capability: decision.capability,
    });
    if (recErr || !rec) {
      log.error({ err: recErr, threadId }, "forward: telegraph_record_forward failed");
      sendError(res, "degraded_unavailable", "We could not forward that message right now. Please try again shortly.");
      return;
    }
    const outcome = (rec as any).outcome as string;
    if (outcome !== "forwarded") {
      if (outcome === "source_gone") sendError(res, "not_found", GONE, { reason: "source_unavailable" });
      else sendError(res, "forbidden", FORWARD_REFUSAL_MESSAGES.forward_restricted, { reason: "forward_restricted" });
      return;
    }

    const messageId = String((rec as any).messageId);
    const createdAt = String((rec as any).createdAt);
    res.status(201).json({
      id: messageId,
      threadId,
      senderId: user.id,
      createdAt,
      msgType: decision.msgType,
      subtype: decision.subtype,
      forwarded: { provenance: decision.provenance },
      contentCapability: decision.capability,
    });

    // The realtime payload is the target thread's own facts — nothing about the source.
    void publishToThread(sc, threadId, {
      type: "message.created",
      payload: { messageId, senderId: user.id, msgType: decision.msgType, subtype: decision.subtype, createdAt },
    });
  }),
);

// ── PUT /api/threads/:threadId/messages/:messageId/content-capability ────────

router.put(
  "/threads/:threadId/messages/:messageId/content-capability",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const { threadId, messageId } = req.params;
    if (!UUID.test(threadId) || !UUID.test(messageId)) {
      sendError(res, "invalid_payload", "Invalid id");
      return;
    }
    const parsed = CapabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "invalid_payload", `capability must be one of: ${CONTENT_CAPABILITIES.join(", ")}`);
      return;
    }
    const sc = getServiceClient();
    if (!sc) {
      sendError(res, "server_not_configured", "Service client not ready");
      return;
    }
    if (!(await isFlagEnabled(sc, FORWARDING_FLAG))) {
      sendError(res, "feature_disabled", "Forwarding is not available");
      return;
    }

    const { data: msg, error: mErr } = await sc
      .from("messages")
      .select("id, thread_id, sender_id, deleted_at, created_at")
      .eq("id", messageId)
      .eq("thread_id", threadId)
      .maybeSingle();
    if (mErr) {
      sendError(res, "degraded_unavailable", "We could not read that message right now. Please try again shortly.");
      return;
    }
    if (msg) {
      const visible = await canSeeMessage(sc, msg as any, user.id);
      if (visible === null) {
        sendError(res, "degraded_unavailable", "We could not verify that message right now. Please try again shortly.");
        return;
      }
      if (!visible) {
        sendError(res, "not_found", GONE);
        return;
      }
    }
    const { data: deriv, error: dErr } = await sc
      .from("message_forwards")
      .select("target_message_id")
      .eq("target_message_id", messageId)
      .maybeSingle();
    if (dErr) {
      sendError(res, "degraded_unavailable", "We could not check that message right now. Please try again shortly.");
      return;
    }
    const verdict = setCapabilityDecision({ message: (msg as any) ?? null, callerId: user.id, isDerivative: !!deriv });
    if (!verdict.ok) {
      sendError(res, verdict.code, verdict.message);
      return;
    }
    const { error: wErr } = await sc
      .from("message_content_capabilities")
      .upsert(
        { message_id: messageId, capability: parsed.data.capability, set_by: user.id, updated_at: new Date().toISOString() },
        { onConflict: "message_id" },
      );
    if (wErr) {
      log.error({ err: wErr, messageId }, "content capability write failed");
      sendError(res, "db_error", "Could not save that setting");
      return;
    }
    res.status(200).json({ messageId, capability: parsed.data.capability });
  }),
);

// ── GET /api/telegraph/structured-schemas ────────────────────────────────────

router.get(
  "/telegraph/structured-schemas",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const sc = getServiceClient() ?? auth.client;
    if (!(await isFlagEnabled(sc, STRUCTURED_SCHEMAS_FLAG))) {
      sendError(res, "feature_disabled", "Structured schema negotiation is not available");
      return;
    }
    res.status(200).json({
      schemas: registryForClients(),
      baseline: BASELINE_CLIENT_SCHEMAS,
      actionMinVersions: ACTION_MIN_VERSIONS,
      headers: { schemas: CLIENT_SCHEMAS_HEADER, actions: CLIENT_ACTIONS_HEADER },
    });
  }),
);

export default router;
