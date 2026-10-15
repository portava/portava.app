/**
 * Telegraph §30A.19 — `GET /api/threads/:threadId/context`: the Context Kernel's
 * five inputs for the calling member (census-telegraph T439).
 *
 * Flag `telegraph_context_kernel_enabled` (3826, seeded FALSE), read
 * three-valued: OFF answers `feature_disabled` and reads nothing else; an
 * unreadable flag answers `degraded_unavailable` (503, retryable) — "could not
 * check" is never served as either answer.
 *
 * ── VIEWER-SCOPED, AND THE SAME REFUSAL AS THE CAPABILITY ROUTE ────────────
 * Everything here is the caller's own view: their relationship with the other
 * member of a direct conversation, their own history window, the plan, intents
 * and shared objects as their own surfaces already show them, and the other
 * member's proximity only as Nearby would serve it to them. A viewer who is not
 * an active member — never one, or one who left — gets 200 with every input
 * withheld and the type "unknown": byte for byte the body a conversation that does
 * not exist gets, so the endpoint is not a membership oracle (capabilityRoute.ts's
 * rule). A block either way in a direct conversation withholds all five, and the
 * reason is redacted to the non-member's (`contextForWire` → `redactForWire`),
 * so it is not a block oracle either.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 * Not an authorization gate: no route may read a capability or an input from
 * here instead of deciding for itself. The capabilities §30A.19 says the inputs
 * feed are GET /threads/:id/capabilities, whose policy takes the kernel's
 * relationship term (domain/telegraph/policies/conversationCapabilityPolicy.ts).
 */
import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { readFlagState } from "../../lib/featureFlags.js";
import { logger as rootLogger } from "../../lib/logger.js";
import { contextForWire } from "../../domain/telegraph/contracts/telegraphContextKernel.js";
import { readConversationContext } from "./telegraphContextKernel.js";

const router = Router();
const log = rootLogger.child({ route: "telegraphContext" });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get(
  "/threads/:threadId/context",
  asyncHandler(async (req, res) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { client, user } = auth;

    const threadId = String(req.params["threadId"] ?? "");
    if (!UUID_RE.test(threadId)) {
      sendError(res, "invalid_payload", "Invalid thread id");
      return;
    }

    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const flag = await readFlagState(sc, "telegraph_context_kernel_enabled"); // CONTEXT_KERNEL_FLAG (3826), as a literal for check:flag-polarity
    if (flag === "unknown") {
      sendError(res, "degraded_unavailable", "We could not check this right now. Please try again shortly.");
      return;
    }
    if (flag !== "on") {
      sendError(res, "feature_disabled", "Conversation context is not available yet");
      return;
    }

    const nowMs = Date.now();
    const context = await readConversationContext({ sc, client, viewerId: user.id, conversationId: threadId, nowMs });
    if (context.degraded) {
      // Reasons only: no person id, no input value. A degraded input carries no value to log.
      log.warn({ threadId, degradedReasons: context.degradedReasons }, "context answered with unreadable inputs — the client is told which");
    }
    res.status(200).json({ ...contextForWire(context), generatedAt: new Date(nowMs).toISOString() });
  }),
);

export default router;
