/**
 * SafeReturnNotificationService
 *
 * Sends push notifications for Safe Return events.
 * Privacy rules:
 *   - Trusted Circle contacts are only notified when trusted_circle_enabled = true.
 *   - Host/crew are only notified when notify_host_enabled/notify_trip_crew_enabled = true.
 *   - Notifications never include exact GPS coordinates.
 *   - Only approximate area (city/district) is included.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPushNotification } from "../../lib/push";
import { logger as rootLogger } from "../../lib/logger";
import type { SafeReturnSession, SafeReturnContact } from "./SafeReturnService";

const logger = rootLogger.child({ service: "SafeReturnNotificationService" });

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchPushToken(db: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await db
      .from("profiles")
      .select("expo_push_token")
      .eq("id", userId)
      .maybeSingle();
    return (data as any)?.expo_push_token ?? null;
  } catch {
    return null;
  }
}

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

/** Look up the user's last known city/country from user_location_state.
 *  Falls back to "an unknown area" if the table has no record.
 *  Never returns exact GPS. */
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

/** Fetch the location name of a trip plan item (for notification context). */
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

// ── Notification senders ──────────────────────────────────────────────────────

/** Remind the session owner that a check-in is due. */
export async function sendUserReminder(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  try {
    const token = await fetchPushToken(db, session.userId);
    await sendPushNotification([token], {
      title: "Safe Return check-in",
      body: "Are you back okay? Tap to confirm you're safe.",
      data: { type: "safe_return_reminder", sessionId: session.id },
    });
    logger.info({ sessionId: session.id }, "SafeReturnNotification: reminder sent to session owner");
  } catch (err) {
    logger.warn({ err }, "sendUserReminder: threw");
  }
}

/** Alert the session owner that their check-in was missed. */
export async function sendMissedCheckIn(
  db: SupabaseClient,
  session: SafeReturnSession,
): Promise<void> {
  try {
    const token = await fetchPushToken(db, session.userId);
    await sendPushNotification([token], {
      title: "We couldn't confirm you're safe",
      body: "Your Safe Return timer has expired. Tap to let us know you're okay or get help.",
      data: { type: "safe_return_missed", sessionId: session.id, escalationLevel: session.escalationLevel },
    });
    logger.info({ sessionId: session.id, level: session.escalationLevel }, "SafeReturnNotification: missed check-in sent");
  } catch (err) {
    logger.warn({ err }, "sendMissedCheckIn: threw");
  }
}

/**
 * Notify selected Trusted Circle contacts (only when trusted_circle_enabled = true).
 * Sends calm, non-alarming message with display name, approximate area, and
 * missed time.  Never includes exact GPS.
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
  const locationPhrase = planTitle
    ? `around ${planTitle} in ${area}`
    : `in ${area}`;

  const inAppContacts = contacts.filter(
    (c) => c.contactMethod === "in_app" && c.contactUserId,
  );

  await Promise.all(
    inAppContacts.map(async (c) => {
      try {
        const token = await fetchPushToken(db, c.contactUserId!);
        await sendPushNotification([token], {
          title: `${userName} missed their Safe Return check-in`,
          body: `They were last ${locationPhrase} and expected back by ${missedTime}. They may need support.`,
          data: {
            type: "safe_return_tc_alert",
            sessionId: session.id,
            contactId: c.id,
          },
        });
        logger.info({ sessionId: session.id, contactId: c.id }, "notifyTrustedCircle: alert sent");
      } catch (err) {
        logger.warn({ err, contactId: c.id }, "notifyTrustedCircle: per-contact send failed");
      }
    }),
  );
}

/**
 * Notify trip host (only when notify_host_enabled = true).
 * Fetches host from the trip and sends a push notification.
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
    const hostToken = await fetchPushToken(db, hostId);

    await sendPushNotification([hostToken], {
      title: `${userName} missed their Safe Return check-in`,
      body: `They were last in ${area}. As trip host, you may wish to check in.`,
      data: { type: "safe_return_host_alert", sessionId: session.id },
    });
    logger.info({ sessionId: session.id, hostId }, "notifyHost: sent");
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

    const tokens = await Promise.all(memberIds.map((id) => fetchPushToken(db, id)));

    await sendPushNotification(tokens, {
      title: `${userName} missed their Safe Return check-in`,
      body: `They were last in ${area}. Reach out if you can.`,
      data: { type: "safe_return_crew_alert", sessionId: session.id },
    });
    logger.info({ sessionId: session.id, crewCount: memberIds.length }, "notifyTripCrew: sent");
  } catch (err) {
    logger.warn({ err }, "notifyTripCrew: threw");
  }
}
