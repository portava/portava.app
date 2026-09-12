/**
 * Telegraph §14.1 — `GET /api/threads/:threadId/capabilities`.
 *
 * The one place a client can ask "what may I do in this conversation" and get
 * an answer derived from the eight inputs §14.1 names, instead of discovering
 * it by attempting each operation and reading eight differently-shaped
 * failures.
 *
 * WHAT THIS ENDPOINT IS NOT
 * =========================
 * It is not an authorization gate and nothing may treat it as one. Every
 * mutating route still derives its own answer: the send path re-reads
 * membership and the block state, the command route re-verifies trip membership
 * at execution, the call routes authorize exclusively through the call
 * permission engine. If this endpoint went away, not one refusal would change.
 * That is the §14.1 contract — "UI renders capabilities; it does not invent
 * authorization" — and it cuts both ways: the UI may not invent a permission,
 * and the server may not delegate one to a projection.
 *
 * THE BLOCK IS NOT TOLD
 * =====================
 * `TELEGRAPH_AUTH_BLOCKED` is a true reason that must not reach the wire, so
 * every reason is passed through `redactForWire` before it is serialised. A
 * blocked viewer and a viewer who was simply removed from the thread get the
 * same `TELEGRAPH_AUTH_NOT_MEMBER`, and neither learns which they are. The
 * redaction is applied here rather than in the policy because the POLICY's
 * callers include the census and the tests, which must see the honest answer.
 *
 * 200 FOR A REFUSAL, ON PURPOSE
 * =============================
 * A viewer who is not a member gets 200 with every capability false. A 403
 * would make the endpoint itself a membership oracle: `GET .../capabilities`
 * returning 403 for thread X and 200 for thread Y tells an unauthenticated
 * scanner which thread ids exist and which they are in. Every capability false
 * is the same answer for "this thread does not exist", "you were removed" and
 * "you were blocked".
 */

import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  CONVERSATION_CAPABILITY_NAMES,
  type ConversationCapabilityName,
} from "../../domain/telegraph/contracts/conversationCapabilities.js";
import { redactForWire } from "../../domain/telegraph/contracts/telegraphReasonCodes.js";
import { resolveConversationCapabilities } from "../../domain/telegraph/policies/conversationCapabilityPolicy.js";

const router = Router();
const log = rootLogger.child({ route: "telegraphCapabilities" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/threads/:threadId/capabilities",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;

    const threadId = String(req.params["threadId"] ?? "");
    if (!UUID_RE.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid thread id");
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const resolved = await resolveConversationCapabilities(sc, {
      viewerId: user.id,
      conversationId: threadId,
    });

    const reasons: Record<string, string | null> = {};
    for (const name of CONVERSATION_CAPABILITY_NAMES) {
      const raw = resolved.reasons[name as ConversationCapabilityName];
      reasons[name] = raw === null ? null : redactForWire(raw);
    }

    if (resolved.degraded) {
      log.warn(
        { threadId, viewerId: user.id, degradedReasons: resolved.degradedReasons },
        "capabilities answered from a degraded read — the client is told, not guessed for",
      );
    }

    res.status(200).json({
      conversationId: resolved.conversationId,
      conversationType: resolved.conversationType,
      capabilities: resolved.capabilities,
      reasons,
      inputsRead: resolved.inputsRead,
      degraded: resolved.degraded,
      degradedReasons: resolved.degradedReasons.map(redactForWire),
    });
  }),
);

export default router;
