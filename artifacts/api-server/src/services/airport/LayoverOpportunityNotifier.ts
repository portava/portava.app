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
import type { ReplanPublication } from "./LayoverReplanService.js";

const logger = rootLogger.child({ service: "LayoverOpportunityNotifier" });

export const LAYOVER_OPPORTUNITY_EVENT_TYPE = "compass.layover.opportunity";

/** The replanner's priority, as the Attention Engine's urgency (0..1). */
export const URGENCY_OF_PRIORITY: Readonly<Record<string, number>> = Object.freeze({ important: 0.9, normal: 0.6 });

export type LayoverOpportunityOutcome =
  | { emitted: true; notificationId: string }
  | { emitted: false; reason: "no_opportunity" | "not_notify_worthy" | "create_failed" };

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
  if (!publication.opportunity) return { emitted: false, reason: "no_opportunity" };
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
