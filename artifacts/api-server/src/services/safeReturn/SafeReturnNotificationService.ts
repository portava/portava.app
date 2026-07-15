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

// ── Safe Return event audit (separate from notification pipeline) ─────────────
// Advisory-only — never throws; event write failure doesn't block alert flow.

async function logNotificationEvent(
  db: SupabaseClient,
  session: SafeReturnSession,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db
      .from("safe_return_events")
      .insert({
        session_id: session.id,
        user_id: session.userId,
        event_type: eventType,
        metadata,
      });
  } catch (err) {
    logger.warn({ err, sessionId: session.id, eventType }, "SafeReturnNotification: event write failed");
  }
}

// ── Context helpers ───────────────────────────────────────────────────────────

async function fetchDisplayName(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data } = await db
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .maybeSingle();
    return (data as any)?.display_name ?? "A traveler";
  } catch {
    return "A traveler";
  }
}

/** Returns city/country from user_location_state. Never returns exact GPS. */
async function fetchAreaLabel(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data } = await db
      .from("user_location_state")
      .select("city, country")
      .eq("user_id", userId)
      .maybeSingle();
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
    const { data } = await db
      .from("trip_plan_items")
      .select("location_name")
      .eq("id", planItemId)
      .maybeSingle();
    return (data as any)?.location_name ?? null;
  } catch {
    return null;
  }
}

// ── Pipeline helper ───────────────────────────────────────────────────────────

/**
 * Create a notification through the unified pipeline then route it.
 * Never throws — advisory-only so caller's main flow is never blocked.
 */
async function createAndRoute(
  db: SupabaseClient,
  userId: string,
  eventType: string,
  params: Record<string, string>,
  sessionId: string,
): Promise<void> {
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
    if (notification) {
      void router.route(notification).catch((err) =>
        logger.warn({ err, notificationId: notification.id }, "SafeReturn: router dispatch failed"),
      );
    }
  } catch (err) {
    logger.warn({ err, userId, eventType }, "SafeReturn: createAndRoute failed");
  }
}

// ── Notification senders ──────────────────────────────────────────────────────

/** Remind the session owner that a check-in is due. */
export async function sendUserReminder(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  await createAndRoute(db, session.userId, "safe_return.reminder", {}, session.id);
  logger.info({ sessionId: session.id }, "SafeReturnNotification: reminder queued");
}

/** Alert the session owner that their check-in was missed. */
export async function sendMissedCheckIn(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  await createAndRoute(db, session.userId, "safe_return.missed", {}, session.id);
  logger.info({ sessionId: session.id, level: session.escalationLevel }, "SafeReturnNotification: missed check-in queued");
}

/**
 * Notify selected Trusted Circle contacts (only when trusted_circle_enabled = true).
 * Uses approximate area — never exact GPS.
 */
export async function notifyTrustedCircle(
  db: SupabaseClient,
  session: SafeReturnSession,
  contacts: SafeReturnContact[],
): Promise<void> {
  if (!session.trustedCircleEnabled) {
    logger.info({ sessionId: session.id }, "notifyTrustedCircle: skipped (trusted_circle_enabled=false)");
    return;
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

  await Promise.all(
    inAppContacts.map((c) =>
      createAndRoute(db, c.contactUserId!, "safe_return.trusted_circle_alert", {
        travelerName: userName,
        area: locationPhrase,
        missedTime,
      }, session.id),
    ),
  );

  await logNotificationEvent(db, session, "trusted_circle_notified", {
    contactCount: inAppContacts.length,
  });
  logger.info({ sessionId: session.id, contactCount: inAppContacts.length }, "notifyTrustedCircle: queued");
}

/**
 * Notify trip host (only when notify_host_enabled = true).
 */
export async function notifyHost(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  if (!session.notifyHostEnabled || !session.tripId) {
    logger.info({ sessionId: session.id }, "notifyHost: skipped");
    return;
  }

  try {
    const { data: trip } = await db
      .from("trips")
      .select("owner_id")
      .eq("id", session.tripId)
      .maybeSingle();

    if (!trip || !(trip as any).owner_id) return;
    const hostId: string = (trip as any).owner_id;
    if (hostId === session.userId) return; // don't notify yourself

    const [userName, area] = await Promise.all([
      fetchDisplayName(db, session.userId),
      fetchAreaLabel(db, session.userId),
    ]);

    await createAndRoute(db, hostId, "safe_return.trusted_circle_alert", {
      travelerName: userName,
      area,
      missedTime: session.timerEndAt
        ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "a scheduled time",
    }, session.id);

    await logNotificationEvent(db, session, "host_notified", { hostId });
    logger.info({ sessionId: session.id, hostId }, "notifyHost: queued");
  } catch (err) {
    logger.warn({ err }, "notifyHost: threw");
  }
}

/**
 * Notify accepted trip crew members (only when notify_trip_crew_enabled = true).
 */
export async function notifyTripCrew(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  if (!session.notifyTripCrewEnabled || !session.tripId) {
    logger.info({ sessionId: session.id }, "notifyTripCrew: skipped");
    return;
  }

  try {
    const { data: members } = await db
      .from("trip_members")
      .select("user_id")
      .eq("trip_id", session.tripId)
      .in("role", ["owner", "member"])
      .neq("user_id", session.userId);

    if (!members || (members as any[]).length === 0) return;

    const [userName, area] = await Promise.all([
      fetchDisplayName(db, session.userId),
      fetchAreaLabel(db, session.userId),
    ]);
    const memberIds = (members as any[]).map((m) => m.user_id as string);

    const missedTime = session.timerEndAt
      ? new Date(session.timerEndAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "a scheduled time";

    await Promise.all(
      memberIds.map((id) =>
        createAndRoute(db, id, "safe_return.trusted_circle_alert", {
          travelerName: userName,
          area,
          missedTime,
        }, session.id),
      ),
    );

    await logNotificationEvent(db, session, "crew_notified", { crewCount: memberIds.length });
    logger.info({ sessionId: session.id, crewCount: memberIds.length }, "notifyTripCrew: queued");
  } catch (err) {
    logger.warn({ err }, "notifyTripCrew: threw");
  }
}
