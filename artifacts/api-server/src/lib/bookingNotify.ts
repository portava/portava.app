/**
 * bookingNotify — fire-and-forget notification for one party to a booking.
 *
 * Moved out of routes/rentABuddy.ts so background jobs can reuse it. A lib
 * importing from routes/ would create an import cycle (the route file imports
 * the sweeper, the sweeper would import the route), so the shared helper lives
 * here and both sides import it.
 *
 * Behaviour is unchanged from the original: the work runs inside a detached
 * async IIFE and every error is swallowed, so a notification failure can never
 * fail the caller's request or abort a sweep pass. Callers deliberately do not
 * await it.
 */

import { getServiceClient } from "./supabase.js";

export async function notifyBookingParty(
  client: ReturnType<typeof getServiceClient>,
  userId: string,
  eventType: string,
  bookingId: string,
  params: Record<string, string> = {},
): Promise<void> {
  if (!client || !userId) return;
  void (async () => {
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
    } catch { /* non-critical */ }
  })();
}
