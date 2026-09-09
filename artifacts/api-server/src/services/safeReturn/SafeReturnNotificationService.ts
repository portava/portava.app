/**
 * SafeReturnNotificationService
 *
 * Sends notifications for Safe Return events through the unified notification
 * pipeline (NotificationService → privacy guard → preference check → persist,
 * then NotificationRouter for push dispatch).
 *
 * Privacy rules:
 *   - Trusted Circle contacts are only notified when trusted_circle_enabled = true.
 *   - Host/crew are only notified when notify_host_enabled/notify_trip_crew_enabled = true.
 *   - Notifications never include exact GPS coordinates.
 *   - Only approximate area (city/district) is shared.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger";
import { NotificationService } from "../notifications/NotificationService.js";
import { NotificationRouter } from "../notifications/NotificationRouter.js";
import type { SafeReturnSession, SafeReturnContact } from "./SafeReturnService";

const logger = rootLogger.child({ service: "SafeReturnNotificationService" });

// ── What an alert attempt actually achieved ───────────────────────────────────

/**
 * The result of trying to alert people.
 *
 * ── WHY THESE FUNCTIONS NO LONGER RETURN `void` ─────────────────────────────
 * Every sender here returned `void` and swallowed every failure, so the
 * escalation route could do nothing but answer `{ ok: true }` — "your contacts
 * have been alerted" — whether three notifications were created or none. On a
 * missed check-in that is the single most consequential sentence this API says,
 * and it was unconditional.
 *
 *   attempted   recipients we resolved and tried to reach
 *   delivered   notification rows the pipeline actually created
 *   failed      attempted − delivered
 *   incomplete  a SUPPORTING READ failed, so `attempted` may be short of the
 *               real recipient list — we do not even know who we did not reach
 *
 * `incomplete` is separate from `failed` on purpose: "we tried 3 and 1 bounced"
 * and "we could not find out who to try" are different facts for whoever has to
 * decide whether a person is being looked for.
 */
export interface AlertOutcome {
  attempted: number;
  delivered: number;
  failed: number;
  incomplete: boolean;
  reason?: string;
}

function alertOutcome(attempted: number, delivered: number, incomplete = false, reason?: string): AlertOutcome {
  return {
    attempted,
    delivered,
    failed: Math.max(0, attempted - delivered),
    incomplete,
    ...(reason ? { reason } : {}),
  };
}

/** True when this outcome means somebody who should have been told was not. */
export function alertFellShort(o: AlertOutcome): boolean {
  return o.incomplete || o.failed > 0;
}

// ── Safe Return event audit (separate from notification pipeline) ─────────────
//
// Advisory-only — an audit write must not block an alert — but NOT silent. The
// row is the record an operator reads to answer "was this person's circle
// told?", so writing it must not be able to fail invisibly, and the row itself
// now records what HAPPENED (delivered/attempted) rather than the size of the
// list we intended to use.

async function logNotificationEvent(
  db: SupabaseClient,
  session: SafeReturnSession,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await db
      .from("safe_return_events")
      .insert({
        session_id: session.id,
        user_id: session.userId,
        event_type: eventType,
        metadata,
      });
    if (error) {
      logger.error(
        { err: error, sessionId: session.id, eventType },
        "SafeReturnNotification: event write failed — the audit trail does not record this alert",
      );
    }
  } catch (err) {
    logger.error({ err, sessionId: session.id, eventType }, "SafeReturnNotification: event write threw");
  }
}

// ── Context helpers ───────────────────────────────────────────────────────────

async function fetchDisplayName(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await db
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, userId }, "fetchDisplayName: profiles read failed — alert will name 'A traveler'");
    }
    return (data as any)?.display_name ?? "A traveler";
  } catch {
    return "A traveler";
  }
}

/**
 * Returns city/country from user_location_state. Never returns exact GPS.
 *
 * "an unknown area" is the honest string for BOTH "we hold no location for this
 * person" and "we could not read it" — the recipient of a missed-check-in alert
 * is told the truth either way, and there is no reassuring reading of it. What
 * was missing is the operator half: an unreadable `user_location_state` looked
 * exactly like a user with location sharing off, so a whole outage's worth of
 * area-less alerts had no visible cause. The fallback text is deliberately
 * unchanged; only the log is new.
 */
async function fetchAreaLabel(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await db
      .from("user_location_state")
      .select("city, country")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      logger.error(
        { err: error, userId },
        "fetchAreaLabel: user_location_state unreadable — alert will say 'an unknown area'",
      );
      return "an unknown area";
    }
    const parts: string[] = [];
    if ((data as any)?.city)    parts.push((data as any).city);
    if ((data as any)?.country) parts.push((data as any).country);
    return parts.length > 0 ? parts.join(", ") : "an unknown area";
  } catch {
    return "an unknown area";
  }
}

async function fetchPlanItemTitle(
  db: SupabaseClient,
  planItemId: string | null,
): Promise<string | null> {
  if (!planItemId) return null;
  try {
    const { data, error } = await db
      .from("trip_plan_items")
      .select("location_name")
      .eq("id", planItemId)
      .maybeSingle();
    if (error) {
      logger.warn({ err: error, planItemId }, "fetchPlanItemTitle: read failed — alert will omit the plan location");
    }
    return (data as any)?.location_name ?? null;
  } catch {
    return null;
  }
}

// ── Pipeline helper ───────────────────────────────────────────────────────────

/**
 * Create a notification through the unified pipeline then route it.
 *
 * Never throws — advisory-only so the caller's main flow is never blocked — but
 * REPORTS whether a notification row was created. `false` is the difference
 * between "this person was told" and "we ran the code that tells people".
 */
async function createAndRoute(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  params: Record<string, string>,
  sessionId: string,
): Promise<boolean> {
  try {
    const svc    = new NotificationService(db);
    const router = new NotificationRouter(db);
    const notification = await svc.create({
      userId,
      eventType,
      params,
      sourceType: "safe_return_session",
      sourceId:   sessionId,
    });
    if (!notification) {
      logger.error({ userId, eventType, sessionId }, "SafeReturn: notification NOT created — this recipient was not alerted");
      return false;
    }
    void router.route(notification).catch((err) =>
      logger.warn({ err, notificationId: notification.id }, "SafeReturn: router dispatch failed"),
    );
    return true;
  } catch (err) {
    logger.error({ err, userId, eventType }, "SafeReturn: createAndRoute failed — this recipient was not alerted");
    return false;
  }
}

// ── Notification senders ──────────────────────────────────────────────────────

/** Remind the session owner that a check-in is due. */
export async function sendUserReminder(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<AlertOutcome> {
  const ok = await createAndRoute(db, session.userId, "safe_return.reminder", {}, session.id);
  logger.info({ sessionId: session.id, delivered: ok }, "SafeReturnNotification: reminder queued");
  return alertOutcome(1, ok ? 1 : 0);
}

/** Alert the session owner that their check-in was missed. */
export async function sendMissedCheckIn(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<AlertOutcome> {
  const ok = await createAndRoute(db, session.userId, "safe_return.missed", {}, session.id);
  if (!ok) {
    logger.error({ sessionId: session.id }, "SafeReturnNotification: missed check-in alert to the traveller was NOT created");
  }
  logger.info({ sessionId: session.id, level: session.escalationLevel, delivered: ok }, "SafeReturnNotification: missed check-in queued");
  return alertOutcome(1, ok ? 1 : 0);
}

/**
 * Notify selected Trusted Circle contacts (only when trusted_circle_enabled = true).
 * Uses approximate area — never exact GPS.
 */
export async function notifyTrustedCircle(
  db: SupabaseClient,
  session: SafeReturnSession,
  contacts: SafeReturnContact[],
  /**
   * Pass `true` when the caller's `listContacts` read FAILED and `contacts` is
   * therefore a fallback rather than the list. The outcome is then marked
   * `incomplete`, and the audit row says the circle was not (fully) reached —
   * instead of recording a tidy `trusted_circle_notified, contactCount: 0`,
   * which is what an unreadable contacts table used to leave behind.
   */
  contactsIncomplete = false,
): Promise<AlertOutcome> {
  if (!session.trustedCircleEnabled) {
    logger.info({ sessionId: session.id }, "notifyTrustedCircle: skipped (trusted_circle_enabled=false)");
    return alertOutcome(0, 0);
  }

  const [userName, area, planTitle] = await Promise.all([
    fetchDisplayName(db, session.userId),
    fetchAreaLabel(db, session.userId),
    fetchPlanItemTitle(db, session.planItemId),
  ]);

  const missedTime = session.timerEndAt
    ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "a scheduled time";
  const locationPhrase = planTitle ? `around ${planTitle} in ${area}` : area;

  const inAppContacts = contacts.filter(
    (c) => c.contactMethod === "in_app" && c.contactUserId,
  );

  const results = await Promise.all(
    inAppContacts.map((c) =>
      createAndRoute(db, c.contactUserId!, "safe_return.trusted_circle_alert", {
        travelerName: userName,
        area: locationPhrase,
        missedTime,
      }, session.id),
    ),
  );

  const delivered = results.filter(Boolean).length;
  const outcome = alertOutcome(inAppContacts.length, delivered, contactsIncomplete);

  // THE AUDIT ROW DESCRIBES WHAT HAPPENED. `trusted_circle_notified` is the
  // event the history endpoint counts as "alerts sent", so it is written only
  // when at least one alert was actually created; anything short of a clean
  // full delivery also leaves a `trusted_circle_alert_incomplete` row naming
  // the shortfall, so a run of unreached circles is visible rather than
  // indistinguishable from a run of empty ones.
  if (delivered > 0) {
    await logNotificationEvent(db, session, "trusted_circle_notified", {
      contactCount: delivered,
      attempted: outcome.attempted,
    });
  }
  if (alertFellShort(outcome)) {
    logger.error(
      { sessionId: session.id, ...outcome },
      "notifyTrustedCircle: trusted circle NOT fully alerted for a missed check-in",
    );
    await logNotificationEvent(db, session, "trusted_circle_alert_incomplete", {
      attempted: outcome.attempted,
      delivered: outcome.delivered,
      failed: outcome.failed,
      contactsIncomplete,
    });
  }
  logger.info({ sessionId: session.id, ...outcome }, "notifyTrustedCircle: queued");
  return outcome;
}

/**
 * Notify trip host (only when notify_host_enabled = true).
 */
export async function notifyHost(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<AlertOutcome> {
  if (!session.notifyHostEnabled || !session.tripId) {
    logger.info({ sessionId: session.id }, "notifyHost: skipped");
    return alertOutcome(0, 0);
  }

  try {
    // `error` bound and checked. `const { data: trip } = await …; if (!trip)
    // return;` treated an unreadable `trips` as "this trip has no host", and a
    // level-3 escalation then silently skipped the one person at the
    // destination who could go and look.
    const { data: trip, error: tripErr } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", session.tripId)
      .maybeSingle();

    if (tripErr) {
      logger.error({ err: tripErr, sessionId: session.id, tripId: session.tripId }, "notifyHost: trip read failed — host NOT alerted");
      await logNotificationEvent(db, session, "host_alert_incomplete", { reason: "trip_unreadable" });
      return alertOutcome(0, 0, true, "trips unreadable");
    }

    if (!trip || !(trip as any).owner_id) return alertOutcome(0, 0);
    const hostId: string = (trip as any).owner_id;
    if (hostId === session.userId) return alertOutcome(0, 0); // don't notify yourself

    const [userName, area] = await Promise.all([
      fetchDisplayName(db, session.userId),
      fetchAreaLabel(db, session.userId),
    ]);

    const ok = await createAndRoute(db, hostId, "safe_return.trusted_circle_alert", {
      travelerName: userName,
      area,
      missedTime: session.timerEndAt
        ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "a scheduled time",
    }, session.id);

    if (ok) {
      await logNotificationEvent(db, session, "host_notified", { hostId });
    } else {
      logger.error({ sessionId: session.id, hostId }, "notifyHost: host alert NOT created");
      await logNotificationEvent(db, session, "host_alert_incomplete", { hostId, reason: "notification_not_created" });
    }
    logger.info({ sessionId: session.id, hostId, delivered: ok }, "notifyHost: queued");
    return alertOutcome(1, ok ? 1 : 0);
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "notifyHost: threw — host NOT alerted");
    return alertOutcome(0, 0, true, String((err as any)?.message ?? err));
  }
}

/**
 * Notify accepted trip crew members (only when notify_trip_crew_enabled = true).
 */
export async function notifyTripCrew(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<AlertOutcome> {
  if (!session.notifyTripCrewEnabled || !session.tripId) {
    logger.info({ sessionId: session.id }, "notifyTripCrew: skipped");
    return alertOutcome(0, 0);
  }

  try {
    // `error` bound and checked, for the same reason as notifyHost: `!members`
    // was true both for "this trip has no other crew" and for "trip_members
    // could not be read", and only the first is a reason to alert nobody.
    const { data: members, error: membersErr } = await db
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", session.tripId)
      .in("role", ["owner", "member"])
      .neq("user_id", session.userId);

    if (membersErr) {
      logger.error(
        { err: membersErr, sessionId: session.id, tripId: session.tripId },
        "notifyTripCrew: trip_members read failed — crew NOT alerted and we cannot say who was missed",
      );
      await logNotificationEvent(db, session, "crew_alert_incomplete", { reason: "trip_members_unreadable" });
      return alertOutcome(0, 0, true, "trip_members unreadable");
    }

    if (!members || (members as any[]).length === 0) return alertOutcome(0, 0);

    const [userName, area] = await Promise.all([
      fetchDisplayName(db, session.userId),
      fetchAreaLabel(db, session.userId),
    ]);
    const memberIds = (members as any[]).map((m) => m.user_id as string);

    const missedTime = session.timerEndAt
      ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "a scheduled time";

    const results = await Promise.all(
      memberIds.map((id) =>
        createAndRoute(db, id, "safe_return.trusted_circle_alert", {
          travelerName: userName,
          area,
          missedTime,
        }, session.id),
      ),
    );

    const delivered = results.filter(Boolean).length;
    const outcome = alertOutcome(memberIds.length, delivered);
    if (delivered > 0) {
      await logNotificationEvent(db, session, "crew_notified", { crewCount: delivered, attempted: outcome.attempted });
    }
    if (alertFellShort(outcome)) {
      logger.error({ sessionId: session.id, ...outcome }, "notifyTripCrew: crew NOT fully alerted");
      await logNotificationEvent(db, session, "crew_alert_incomplete", {
        attempted: outcome.attempted,
        delivered: outcome.delivered,
        failed: outcome.failed,
      });
    }
    logger.info({ sessionId: session.id, ...outcome }, "notifyTripCrew: queued");
    return outcome;
  } catch (err) {
    logger.error({ err, sessionId: session.id }, "notifyTripCrew: threw — crew NOT alerted");
    return alertOutcome(0, 0, true, String((err as any)?.message ?? err));
  }
}
