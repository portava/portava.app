/**
 * census-telegraph T320 / T411 — an action offered on a Portava object is a CURRENT capability.
 *
 * Spec §30A.10: "Action buttons are derived from current capabilities. An old rendered card must
 * not authorize a stale action." §26: "Buddy booking cancelled → Booking-only actions disabled
 * immediately."
 *
 * The §5 loaders decide whether a viewer may SEE an object, and a party may still see a cancelled
 * booking (its current status is the news). What a family may DO was a static list per family
 * (`shareActionsFor`, the rail's `availableActionsFor`), handed out with any visible object — so a
 * cancelled booking's card and rail item still "offered" Meet here, Share location and Check in
 * safe, and a cancelled event's host card still offered Join. This narrows that list by the
 * object's own status, on every read, at the two places actions are produced:
 *
 *   - anything CANCELLED offers nothing;
 *   - a BOOKING offers its booking-only actions only while it is OPERATIONAL — exactly the statuses
 *     the booking domain itself admits an operational change in (routes/rentABuddy.ts add-time
 *     allow-list `addTimeAllowedStatuses`; pinned equal by telegraphSharedCardTruth.test.ts).
 *
 * Execution is still re-authorized by the owning domain (T410); this is what the server OFFERS.
 */
import type { TelegraphAction } from "./vocabulary.js";

/** The booking domain's operational statuses (routes/rentABuddy.ts `addTimeAllowedStatuses`). */
export const BOOKING_OPERATIONAL_STATUSES = ["confirmed", "scheduled", "in_progress"] as const;

export function actionsWhileLive(
  objectType: string,
  status: string | null | undefined,
  actions: readonly TelegraphAction[],
): TelegraphAction[] {
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (s === "cancelled") return [];
  if (objectType === "BOOKING" && !(BOOKING_OPERATIONAL_STATUSES as readonly string[]).includes(s)) return [];
  return [...actions];
}
