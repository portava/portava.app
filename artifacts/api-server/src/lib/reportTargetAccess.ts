/**
 * reportTargetAccess — a conversation report is filed only by someone who can
 * SEE what they are reporting.
 *
 * Three routes file reports against Telegraph content:
 *   POST /api/messages/:messageId/report   (routes/messaging.ts)
 *   POST /api/threads/:threadId/report     (routes/messaging.ts)
 *   POST /api/reports, target_type message | thread   (routes/reports.ts)
 *
 * None of them asked whether the reporter was in the conversation. The first
 * two then snapshot the reported content into restricted moderation storage
 * (services/telegraphReportEvidence.ts) when `telegraph_report_evidence_enabled`
 * is on, so any signed-in user holding an id could have another thread's
 * messages copied as "evidence" — and an upheld message report charges the
 * sender (`message_report_confirmed`, routes/admin.ts) for words the reporter
 * was never shown.
 *
 * THE RULE is the one the message read paths already apply (routes/messaging.ts
 * edit-history route): an ACTIVE membership row (`left_at IS NULL`) in the
 * thread, and — for a message — the message inside the reporter's §14.3 history
 * window while `telegraph_history_bound_enabled` is on, the reporter's own
 * messages always admitted (Q6). Nothing wider, nothing narrower.
 *
 * THE ANSWERS:
 *   - not visible  → 404 `not_found`, exactly what the thread read answers a
 *     non-member, so the refusal is not an oracle for whether the id exists.
 *   - unreadable   → 503 `degraded_unavailable` (retryable), logged at error. A
 *     failed read is never turned into "not found", and a report is never filed
 *     on an unchecked read.
 * Targets that are not a conversation pass through untouched.
 */
import { sendError } from "./http.js";
import { historyBoundEnabled, visibleFromOf, withinWindow } from "../services/groupChatHistoryBound.js";

export type ReportTargetAccess =
  | { ok: true }
  | { ok: false; reason: "not_visible" }
  | { ok: false; reason: "unreadable"; table: string; err: unknown };

/** Active-membership read, bound-aware. Two literal select lists: check:write-path-columns reads them statically. */
async function readMembership(sc: any, threadId: string, userId: string, boundOn: boolean) {
  const q = boundOn
    ? sc.from("message_thread_members").select("user_id, left_at, visible_from_at")
    : sc.from("message_thread_members").select("user_id, left_at");
  return q.eq("thread_id", threadId).eq("user_id", userId).maybeSingle();
}

/** Is `userId` an active member of `threadId`? */
export async function reporterCanSeeThread(sc: any, userId: string, threadId: string): Promise<ReportTargetAccess> {
  const { data, error } = await readMembership(sc, threadId, userId, false);
  if (error) return { ok: false, reason: "unreadable", table: "message_thread_members", err: error };
  if (!data || (data as any).left_at != null) return { ok: false, reason: "not_visible" };
  return { ok: true };
}

/** Can `userId` see message `messageId` in its thread right now? */
export async function reporterCanSeeMessage(sc: any, userId: string, messageId: string): Promise<ReportTargetAccess> {
  const { data: msg, error: msgErr } = await sc
    .from("messages")
    .select("id, thread_id, sender_id, created_at")
    .eq("id", messageId)
    .maybeSingle();
  if (msgErr) return { ok: false, reason: "unreadable", table: "messages", err: msgErr };
  if (!msg || !(msg as any).thread_id) return { ok: false, reason: "not_visible" };

  const boundOn = await historyBoundEnabled(sc);
  const { data: member, error: memberErr } = await readMembership(sc, (msg as any).thread_id, userId, boundOn);
  if (memberErr) return { ok: false, reason: "unreadable", table: "message_thread_members", err: memberErr };
  if (!member || (member as any).left_at != null) return { ok: false, reason: "not_visible" };

  const visibleFrom = visibleFromOf(member as any, boundOn);
  if (!withinWindow((msg as any).created_at, visibleFrom, { senderId: (msg as any).sender_id, viewerId: userId })) {
    return { ok: false, reason: "not_visible" };
  }
  return { ok: true };
}

/**
 * Route guard. Returns true when the report may be filed; otherwise it has
 * already answered (404 or 503) and the caller just returns.
 */
export async function refuseUnlessReporterSees(
  sc: any,
  req: any,
  res: any,
  target: { type: string; id: string; userId: string },
): Promise<boolean> {
  let access: ReportTargetAccess;
  if (target.type === "message") access = await reporterCanSeeMessage(sc, target.userId, target.id);
  else if (target.type === "thread") access = await reporterCanSeeThread(sc, target.userId, target.id);
  else return true;

  if (access.ok) return true;
  if (access.reason === "unreadable") {
    (req.log?.error ?? console.error).call(
      req.log ?? console,
      { err: access.err, table: access.table, targetType: target.type, targetId: target.id, userId: target.userId },
      `${access.table} read failed — refusing to file a report on an unchecked visibility read`,
    );
    sendError(res, "degraded_unavailable", "We could not check your access to this conversation right now. Please try again shortly.");
    return false;
  }
  sendError(res, "not_found", target.type === "message" ? "Message not found" : "Thread not found");
  return false;
}
