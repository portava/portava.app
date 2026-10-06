/**
 * Telegraph §30A.6 — a member's notification policy for one thread.
 *
 *   GET /api/threads/:threadId/notification-policy
 *       The caller's level, any temporary mute in force, and which choices this
 *       deployment can store (MENTIONS / IMPORTANT / temporary mute need
 *       migration 3760 and telegraph_thread_notification_policy_enabled).
 *   PUT /api/threads/:threadId/notification-policy   { level, muteForMinutes? }
 *       Set it. The answer is READ BACK from the database.
 *
 * The decision every thread-scoped notification takes against this choice is
 * `domain/telegraph/policies/threadNotificationPolicy.ts`; SAFETY is never
 * suppressed by it.
 *
 * ACTIVE MEMBERS ONLY. A non-member, or a member who left, is refused before
 * anything is read or written; an unreadable membership is a 503, never "not a
 * member" and never a write.
 */
import { Router } from "express";
import { z } from "zod";

import { requireUser, sendError } from "../lib/http.js";
import { getServiceClient } from "../lib/supabase.js";
import { asyncHandler } from "../lib/asyncHandler.js";
import { logger as rootLogger } from "../lib/logger.js";
import {
  TEMPORARY_MUTE_MINUTES,
  THREAD_NOTIFICATION_LEVELS,
  type ThreadNotificationState,
} from "../domain/telegraph/policies/threadNotificationPolicy.js";
import {
  readThreadNotificationStates,
  threadNotificationLevelsEnabled,
  writeThreadNotificationChoice,
} from "../services/telegraph/threadNotificationState.js";

const router = Router();
const log = rootLogger.child({ route: "telegraphNotificationPolicy" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ChoiceSchema = z.object({
  level: z.enum(THREAD_NOTIFICATION_LEVELS),
  muteForMinutes: z
    .union([z.literal(15), z.literal(60), z.literal(480), z.literal(1440)])
    .nullish(),
});

/** What the wire says about a state. The level is MUTED whenever muted_at is set. */
function view(state: ThreadNotificationState, levelsOn: boolean, nowMs: number) {
  const until = state.mutedUntil ? Date.parse(state.mutedUntil) : NaN;
  return {
    level: state.mutedAt !== null ? "MUTED" : state.level ?? "ALL",
    mutedUntil: state.mutedUntil,
    temporaryMuteActive: state.mutedUntil !== null && (Number.isNaN(until) || until > nowMs),
    levelsAvailable: levelsOn ? [...THREAD_NOTIFICATION_LEVELS] : ["ALL", "MUTED"],
    temporaryMuteAvailable: levelsOn,
    temporaryMuteMinutes: levelsOn ? [...TEMPORARY_MUTE_MINUTES] : [],
    safetyAlwaysDelivers: true,
  };
}

router.get(
  "/threads/:threadId/notification-policy",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const threadId = String(req.params.threadId ?? "");
    if (!UUID.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    const read = await readThreadNotificationStates(sc, threadId, [user.id]);
    if (!read.ok) {
      sendError(res, "degraded_unavailable", "We could not read this conversation's notification setting. Please try again.");
      return;
    }
    const state = read.states.get(user.id);
    if (!state) { sendError(res, "forbidden", "Not an active member of this thread"); return; }
    res.status(200).json({ threadId, ...view(state, read.levelsOn, Date.now()) });
  }),
);

router.put(
  "/threads/:threadId/notification-policy",
  asyncHandler(async (req: any, res: any) => {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const { user } = auth;
    const threadId = String(req.params.threadId ?? "");
    if (!UUID.test(threadId)) { sendError(res, "invalid_payload", "Invalid thread id"); return; }
    const parsed = ChoiceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      sendError(res, "invalid_payload", parsed.error.issues[0]?.message ?? "Invalid notification choice");
      return;
    }
    const sc = getServiceClient();
    if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return; }

    // Membership first, and an unreadable roster is not "not a member".
    const member = await readThreadNotificationStates(sc, threadId, [user.id]);
    if (!member.ok) {
      sendError(res, "degraded_unavailable", "We could not check this conversation right now. Please try again.");
      return;
    }
    if (!member.states.has(user.id)) { sendError(res, "forbidden", "Not an active member of this thread"); return; }

    const nowMs = Date.now();
    const written = await writeThreadNotificationChoice(
      sc,
      threadId,
      user.id,
      { level: parsed.data.level, muteForMinutes: parsed.data.muteForMinutes ?? null },
      nowMs,
    );
    if (!written.ok) {
      if (written.code === "feature_disabled") {
        const levelsOn = await threadNotificationLevelsEnabled(sc);
        res.status(409).json({
          error: "feature_disabled",
          message: "Only All and Muted are available for this conversation right now.",
          levelsAvailable: levelsOn ? [...THREAD_NOTIFICATION_LEVELS] : ["ALL", "MUTED"],
        });
        return;
      }
      log.error({ threadId, code: written.code }, "notification choice not written");
      sendError(res, "db_error", "Your notification setting was not saved. Please try again.");
      return;
    }
    res.status(200).json({ threadId, ...view(written.state, written.levelsOn, nowMs) });
  }),
);

export default router;
