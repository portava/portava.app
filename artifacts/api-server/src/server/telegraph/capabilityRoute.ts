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
 * 200 FOR A REFUSAL, AND THE SAME BYTES (census-telegraph §99)
 * =============================================================
 * A viewer with no membership row gets 200 and EXACTLY the body a thread that
 * does not exist gets: type "unknown", nothing read, every capability false.
 * The viewer's own row is read FIRST (undisclosedAnswerFor, below); nothing about
 * the thread is read for a non-member (the policy told one the real type and
 * `inputsRead`: an existence oracle). A failed row read answers degraded, alike
 * for both. Members and former members (who have a row) are answered unchanged.
 */

import { Router } from "express";

import { requireUser, sendError } from "../../lib/http.js";
import { getServiceClient } from "../../lib/supabase.js";
import { asyncHandler } from "../../lib/asyncHandler.js";
import { logger as rootLogger } from "../../lib/logger.js";
import {
  CONVERSATION_CAPABILITY_NAMES,
  type ConversationCapabilityName, allDenied, // allDenied: the non-member answer (census-telegraph §99)
} from "../../domain/telegraph/contracts/conversationCapabilities.js";
import { redactForWire } from "../../domain/telegraph/contracts/telegraphReasonCodes.js";
import { resolveConversationCapabilities } from "../../domain/telegraph/policies/conversationCapabilityPolicy.js";
import { readConversationFacts } from "./conversationFacts.js"; import { assembleContextKernel } from "../../services/telegraph/contextKernel.js"; import { contextKernelForWire } from "../../services/telegraph/contextKernelPolicy.js"; import { checkRateLimit } from "../../lib/rateLimit.js"; import { quantiseNow } from "../../routes/nearbyReachable.js"; // census-telegraph T439: §30A.19 Context Kernel (route at file foot)
import { transportClassFor } from "../../domain/telegraph/policies/transportClass.js";

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
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; } const undisclosed = await undisclosedAnswerFor(sc, threadId, user.id); if (undisclosed) { res.status(200).json(undisclosed); return; } // census-telegraph §99: no membership row → the non-existent thread's answer, byte for byte

    const resolved = await resolveConversationCapabilities(sc, {
      viewerId: user.id,
      conversationId: threadId,
    }); if (resolved.reasons.canSendMessage === "TELEGRAPH_AUTH_BLOCKED") { res.status(200).json(undisclosedBody(threadId, false)); return; } // wave 5 under §99: a blocked member's answer IS a stranger's, and a stranger's is now the non-existent thread's, byte for byte

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

    // §24 / census T295: the member count and the E2EE flag the thread screen
    // used to read from raw tables. Members only — a non-member gets nulls, the
    // same answer as a thread that does not exist (see conversationFacts.ts).
    const facts = await readConversationFacts(sc, threadId, user.id, false); // wave 5 (block parity): a blocked member never reaches this read — the stranger's body was sent above, before any fact was read (census-telegraph §99)

    res.status(200).json({
      conversationId: resolved.conversationId,
      conversationType: resolved.conversationType,
      capabilities: resolved.capabilities,
      reasons,
      inputsRead: resolved.inputsRead,
      degraded: resolved.degraded,
      degradedReasons: resolved.degradedReasons.map(redactForWire),
      conversation: {
        memberCount: facts.memberCount,
        isE2ee: facts.isE2ee,
        // §30A.12 (census T415): the scale class, from the same table the fan-out
        // and receipt routes use. Null when the roster could not be counted.
        transportClass: facts.memberCount === null
          ? null
          : transportClassFor({ threadType: resolved.conversationType, activeMembers: facts.memberCount }),
        degraded: facts.degraded,
      },
    });
  }),
);

/**
 * census-telegraph §99 — the answer for a viewer with no membership row in this
 * thread, decided BEFORE anything about the thread is read, so it cannot depend
 * on whether the thread exists. `null` = the viewer has a row (a member, or a
 * former member, who already knows the thread): the policy answers, unchanged.
 *
 * The not-member body is the one this route has always sent for a thread that
 * does not exist (the policy's `refuse("TELEGRAPH_AUTH_NOT_MEMBER", "unknown")`
 * before any input is read, then conversationFacts' UNDISCLOSED). A failed read
 * of the row is not "not a member" — it answers degraded, and identically
 * whether or not the thread exists. Reasons go through redactForWire like every
 * other reason this route sends.
 */
async function undisclosedAnswerFor(sc: any, threadId: string, viewerId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await sc
    .from("message_thread_members")
    .select("user_id")
    .eq("thread_id", threadId)
    .eq("user_id", viewerId)
    .maybeSingle();
  if (!error && data) return null; const unreadable = Boolean(error);
  if (unreadable) log.warn({ threadId, viewerId }, "capabilities: the viewer's membership row could not be read — answering degraded, thread unread");
  return undisclosedBody(threadId, unreadable); } function undisclosedBody(threadId: string, unreadable: boolean): Record<string, unknown> { // the stranger's body — also a BLOCKED member's (wave 5 parity), so the two cannot drift
  const reason = redactForWire(unreadable ? "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE" : "TELEGRAPH_AUTH_NOT_MEMBER");
  const { capabilities, reasons } = allDenied(reason);
  return {
    conversationId: threadId,
    conversationType: "unknown",
    capabilities,
    reasons,
    inputsRead: [],
    degraded: unreadable,
    degradedReasons: unreadable ? [reason] : [],
    conversation: { memberCount: null, isE2ee: null, transportClass: null, degraded: unreadable },
  };
}

export default router;

// ── census-telegraph T439 — §30A.19's Context Kernel, on the capability router ──
//
// GET /api/threads/:threadId/context-kernel — the five inputs (Relationship,
// Time, Proximity, Intent, Shared Objects), what this viewer may be shown of
// each, and the actions on offer, each admitted by the §14.1 capability that
// governs it (services/telegraph/contextKernelPolicy.ts). Same refusal shape as
// the capabilities above: a non-member gets 200 with everything withheld, and
// a block reads as "not a member" on every field. Rate-limited, and read at the
// §4.5 poll quantum, because its proximity input is an observation.
router.get(
  "/threads/:threadId/context-kernel",
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

    const rl = checkRateLimit("telegraph_context_kernel", user.id, 20, 60_000);
    if (!rl.allowed) {
      res.setHeader("Retry-After", Math.ceil(rl.retryAfterMs / 1000).toString());
      sendError(res, "rate_limited", "Too many requests. Please wait.");
      return;
    }

    const result = await assembleContextKernel(sc, { viewerId: user.id, conversationId: threadId, nowMs: quantiseNow(Date.now()) });
    if (!result.ok) {
      // The membership the whole kernel rests on could not be read. "You share
      // nothing here" would be a fabrication, so this is a retryable refusal.
      log.warn({ threadId, viewerId: user.id, stage: result.stage }, "context kernel refused: a read it rests on failed");
      sendError(res, "degraded_unavailable", "The conversation context is temporarily unavailable.");
      return;
    }
    if (result.kernel.degraded) {
      log.warn({ threadId, viewerId: user.id, degradedInputs: result.kernel.degradedInputs }, "context kernel answered from a degraded read");
    }
    res.status(200).json(contextKernelForWire(result.kernel, redactForWire));
  }),
);
