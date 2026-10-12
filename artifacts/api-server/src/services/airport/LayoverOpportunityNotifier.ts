/**
 * LayoverOpportunityNotifier — Layover §25's "proactive OpportunityEvents"
 * reaching Compass (census-layover L98 / L268; census-compass CL-04).
 *
 * `LayoverEventReplanner.opportunityEventFor` has produced an OpportunityEvent
 * for every material change since §11.1 step 7, and `shouldNotify` has decided
 * whether it deserves the traveller's attention — and NOTHING consumed either:
 * the replan route recorded the DecisionRecord and returned. This is the
 * consumer. A notify-worthy opportunity becomes ONE notification row through
 * NotificationService (category `compass`, so it is a WORLD CHANGE to
 * CompassNotificationEngine) and is routed through NotificationRouter, where
 * the Attention Engine (Sensing §15) decides NOTIFY / WALL / SILENT / IGNORE.
 * The producer declares what it knows: the change is about the traveller's
 * own layover (`trip_stop`), its urgency is the replanner's priority, and the
 * subject is the session, so a second material change to the same session
 * within a window is not a second interruption.
 *
 * It sends nothing itself and never throws: delivery is best-effort, the
 * DecisionRecord is the durable fact.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { NotificationRouter } from "../notifications/NotificationRouter.js";
import type { ReplanPublication } from "./LayoverReplanService.js"; import { returnEscalationRung, returnRequiredAction, returnActionIsEssential, returnWarningEventType, returnWarningSourceId, RETURN_ESCALATION_LADDER, type ReturnActionChange, type ReturnRequiredAction } from "./LayoverReturnEscalation.js"; import type { NotificationPriority } from "../notifications/NotificationTemplateService.js";

const logger = rootLogger.child({ service: "LayoverOpportunityNotifier" });

export const LAYOVER_OPPORTUNITY_EVENT_TYPE = "compass.layover.opportunity";

/** The replanner's priority, as the Attention Engine's urgency (0..1). */
export const URGENCY_OF_PRIORITY: Readonly<Record<string, number>> = Object.freeze({ important: 0.9, normal: 0.6 });

export type LayoverOpportunityOutcome =
  | { emitted: true; notificationId: string; /** OD-1012-LAY-1: set when what went out is a return WARNING, not an opportunity. */ returnWarning?: ReturnRequiredAction }
  | { emitted: false; reason: "no_opportunity" | "not_notify_worthy" | "create_failed" | "duplicate_or_refused" };

export function layoverOpportunityPayload(sessionId: string, publication: ReplanPublication): {
  title: string; body: string; priority: "important" | "normal"; attention: Record<string, unknown>;
} | null {
  if (!publication.opportunity || !publication.notify.notify) return null;
  // The replanner says `high`; the notification vocabulary's word for it is `important`.
  const priority = publication.notify.priority === "high" ? "important" : "normal";
  const why = publication.opportunity.why.slice(0, 3).join("; ");
  return {
    title: priority === "important" ? "Your layover options changed" : "Your layover window moved",
    body: why.length > 0 ? why : publication.notify.reason,
    priority,
    attention: {
      relevance: "trip_stop",
      urgency: URGENCY_OF_PRIORITY[priority],
      subjectId: `layover:${sessionId}`,
    },
  };
}

export async function notifyLayoverOpportunity(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  publication: ReplanPublication,
): Promise<LayoverOpportunityOutcome> {
  const warning = layoverReturnWarningPayload(sessionId, publication) ?? await unsentEssentialWarning(db, userId, sessionId, publication); if (warning) return emitReturnWarning(db, userId, sessionId, publication, warning); /* OD-1012-LAY-1: the actionable warning REPLACES the opportunity notice for this event — one interruption, the one that says what to do */ if (!publication.opportunity) return { emitted: false, reason: "no_opportunity" };
  const payload = layoverOpportunityPayload(sessionId, publication);
  if (!payload) return { emitted: false, reason: "not_notify_worthy" };
  try {
    const row = await new NotificationService(db).create({
      userId,
      eventType: LAYOVER_OPPORTUNITY_EVENT_TYPE,
      title: payload.title,
      body: payload.body,
      category: "compass",
      priority: payload.priority,
      actionUrl: `/airport/sessions/${sessionId}`,
      sourceType: "layover_replan",
      sourceId: publication.event.dedupKey,
      metadata: {
        attention: payload.attention,
        opportunity: publication.opportunity,
        notifyReason: publication.notify.reason,
        eventType: publication.event.eventType,
      },
    });
    if (!row) return { emitted: false, reason: "create_failed" };
    void new NotificationRouter(db).route(row).catch((err) => {
      logger.warn({ err, sessionId }, "layover opportunity: routing failed (the row exists)");
    });
    return { emitted: true, notificationId: row.id };
  } catch (err) {
    logger.warn({ err, sessionId }, "layover opportunity: notification create threw");
    return { emitted: false, reason: "create_failed" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OD-1012-LAY-1 / LAY-4 — the actionable return WARNING
// ─────────────────────────────────────────────────────────────────────────────

/** What the traveller reads, per required action. No time and no place: those come from the certified screen. */
const RETURN_WARNING_TITLE: Readonly<Record<ReturnRequiredAction, string>> = Object.freeze({
  explore: "You have more time on your layover",
  start_heading_back: "Start heading back to the airport",
  leave_now: "Head back to the airport now",
  get_help: "Your connection is at risk",
});

export interface LayoverReturnWarningPayload {
  eventType: string;
  action: ReturnRequiredAction;
  from: ReturnRequiredAction;
  title: string;
  body: string;
  /** The ladder's priority for the new rung: `important` to start back, `urgent` to leave now / get help. */
  priority: NotificationPriority;
  /** `urgent` rung: an unreadable ledger does not suppress it — it is ATTEMPTED, within a bound (essentialAttemptBudget.ts); an exact duplicate on record does. */
  essential: boolean;
  sourceType: "layover_return";
  /** Session + action: the identity two duplicates share, whatever the deadline did. */
  sourceId: string;
}

/**
 * The return warning a replan owes the traveller, or null.
 *
 * Only when step 8 says the REQUIRED ACTION escalated to one that asks the
 * traveller to move (`returnAction.escalated && actionable`). An eased action
 * and every other notify reason keep the opportunity path above: they are
 * worth knowing, and none of them is "go now".
 */
export function layoverReturnWarningPayload(sessionId: string, publication: ReplanPublication): LayoverReturnWarningPayload | null {
  const notify = publication.notify as ReplanPublication["notify"] & { returnAction?: ReturnActionChange };
  if (!notify.notify || !notify.returnAction) return null;
  const change = notify.returnAction;
  if (!change.escalated || !change.actionable) return null;
  const rung = RETURN_ESCALATION_LADDER.find((r) => r.requiredAction === change.to) ?? returnEscalationRung("CONNECTION_AT_RISK");
  return {
    eventType: returnWarningEventType(change.to),
    action: change.to,
    from: change.from,
    title: RETURN_WARNING_TITLE[change.to],
    body: rung.label,
    priority: rung.priority,
    essential: rung.priority === "urgent",
    sourceType: "layover_return",
    sourceId: returnWarningSourceId(sessionId, change.to),
  };
}

/**
 * Persist the warning (the in-app Activity Center entry exists from here on,
 * whatever the push does) and hand it to the router.
 *
 * NEVER "DELIVERED". `emitted` means the row exists and routing started; the
 * router records the push as `sent` to Expo at best, and nothing here or there
 * reads that as the traveller having seen it. The phone's own local alerts at
 * the certified RETURN_SOON / RETURN_NOW instants are scheduled independently
 * (travel-buddy-standalone layoverReturnAlerts.ts) and are not cancelled by a
 * push — they are the fallback when a push never arrives.
 */
async function emitReturnWarning(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  publication: ReplanPublication,
  w: LayoverReturnWarningPayload,
): Promise<LayoverOpportunityOutcome> {
  try {
    const row = await new NotificationService(db).create({
      userId,
      eventType: w.eventType,
      title: w.title,
      body: w.body,
      category: "airport",
      priority: w.priority,
      actionUrl: `/airport/sessions/${sessionId}`,
      sourceType: w.sourceType,
      sourceId: w.sourceId,
      essential: w.essential,
      metadata: {
        returnWarning: { action: w.action, from: w.from, essential: w.essential },
        notifyReason: publication.notify.reason,
        eventType: publication.event.eventType,
        causedByDedupKey: publication.event.dedupKey,
      },
    });
    // null = deduplicated (this session already has this action's warning) or
    // refused by the privacy guard. Either way nothing new was persisted.
    if (!row) return { emitted: false, reason: "duplicate_or_refused" };
    void new NotificationRouter(db).route(row).catch((err) => {
      logger.warn({ err, sessionId }, "layover return warning: routing failed (the row exists)");
    });
    return { emitted: true, notificationId: row.id, returnWarning: w.action };
  } catch (err) {
    logger.warn({ err, sessionId }, "layover return warning: notification create threw");
    return { emitted: false, reason: "create_failed" };
  }
}

/**
 * OD-1012-LAY-1 (second sentence) / LAY-4a — "Do not suppress an essential
 * return warning merely because its scheduled time is unchanged."
 *
 * A replan whose required action did NOT change (so step 8 raises no warning:
 * a time-only move is not a reason to interrupt) still owes the traveller the
 * essential warning when the server holds no record of ever having issued it
 * — e.g. the earlier attempt failed to persist, or the session reached
 * `leave_now` / `get_help` without a replan that saw the change.
 *
 * "Not received" can only mean what the server can know: NO in-app warning
 * row exists for this session + action (any age). Nothing here reads a push
 * outcome as receipt. When that row exists, nothing is re-sent. When the
 * ledger cannot be read, the warning is ATTEMPTED and the attempts are bounded
 * (NotificationDeduplicationService rule 4 + essentialAttemptBudget.ts).
 *
 * Only for an essential (`urgent`) action; `start_heading_back` is never re-raised here.
 */
async function unsentEssentialWarning(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  publication: ReplanPublication,
): Promise<LayoverReturnWarningPayload | null> {
  const before = publication.diff?.returnStateBefore;
  const after = publication.diff?.returnStateAfter;
  if (before === undefined || after === undefined) return null;
  const action = returnRequiredAction(after);
  if (returnRequiredAction(before) !== action || !returnActionIsEssential(action)) return null;
  const sourceId = returnWarningSourceId(sessionId, action);
  const prior = await priorReturnWarning(db, userId, sourceId);
  if (prior === "found") return null;
  const rung = RETURN_ESCALATION_LADDER.find((r) => r.requiredAction === action) ?? returnEscalationRung("CONNECTION_AT_RISK");
  return {
    eventType: returnWarningEventType(action),
    action,
    from: action,
    title: RETURN_WARNING_TITLE[action],
    body: rung.label,
    priority: rung.priority,
    essential: true,
    sourceType: "layover_return",
    sourceId,
  };
}

/** Has this session's warning for this action EVER been written? `unreadable` is not "no". */
async function priorReturnWarning(db: SupabaseClient, userId: string, sourceId: string): Promise<"found" | "none" | "unreadable"> {
  try {
    const { data, error } = await db
      .from("notifications")
      .select("id")
      .eq("user_id", userId)
      .eq("source_type", "layover_return")
      .eq("source_id", sourceId)
      .limit(1);
    if (error) {
      logger.warn({ err: error, sourceId }, "layover return warning: ledger unreadable — the essential warning is attempted (bounded)");
      return "unreadable";
    }
    return Array.isArray(data) && data.length > 0 ? "found" : "none";
  } catch (err) {
    logger.warn({ err, sourceId }, "layover return warning: ledger read threw — the essential warning is attempted (bounded)");
    return "unreadable";
  }
}
