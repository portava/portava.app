/**
 * bookingNotify — fire-and-forget notification for one party to a booking.
 *
 * Moved out of routes/rentABuddy.ts so background jobs can reuse it. A lib
 * importing from routes/ would create an import cycle (the route file imports
 * the sweeper, the sweeper would import the route), so the shared helper lives
 * here and both sides import it.
 *
 * Every error is swallowed, so a notification failure can never fail the
 * caller's request or abort a sweep pass. That part is unchanged.
 *
 * WHAT CHANGED, AND WHY AWAITING THE CALL SITES ALONE WOULD NOT HAVE WORKED.
 * This used to run its body inside a detached `void (async () => {...})()`
 * IIFE. Because the outer function returned as soon as that IIFE was STARTED,
 * `await notifyBookingParty(...)` awaited the prologue and nothing else — the
 * notification insert was still in flight. So the returned promise was a lie:
 * it did not represent the work. Adding `await` at the call sites without
 * removing the IIFE would have looked like a fix and changed nothing.
 *
 * The body now runs inline, so the returned promise settles when the
 * notification has actually landed. Callers that want the old fire-and-forget
 * behaviour must say so explicitly with `void`.
 */

import { getServiceClient } from "./supabase.js";
import { logger as rootLogger } from "./logger.js";

const logger = rootLogger.child({ lib: "bookingNotify" });

export async function notifyBookingParty(
  client: ReturnType<typeof getServiceClient>,
  userId: string,
  eventType: string,
  bookingId: string,
  params: Record<string, string> = {},
): Promise<void> {
  if (!client || !userId) return;
  try {
    const { NotificationService } = await import("../services/notifications/NotificationService.js");
    const { NotificationRouter }  = await import("../services/notifications/NotificationRouter.js");
    const ns = new NotificationService(client);
    const nr = new NotificationRouter(client);
    const row = await ns.create({
      userId,
      eventType,
      sourceType: "booking",
      sourceId: bookingId,
      params,
    });
    if (row) await nr.route(row);
  } catch (err) {
    // Still non-fatal — a notification failure must never fail a booking. But
    // a bare `catch {}` also left no trace anywhere, so a booking-notification
    // outage was invisible: nothing in the logs, nothing in the response, and
    // the delivery-attempt ledger has no row either because the throw happened
    // before the router ran. Swallowing is a decision; swallowing silently is
    // not one anybody can audit.
    logger.warn({ err, userId, eventType, bookingId }, "notifyBookingParty: notification failed (booking unaffected)");
  }
}
