/**
 * Trust restrictions at the Trips doors that do what Compass now refuses
 * (census-trips §84; census-trust TRV2-08; OD-TRUST-5: "Enforce restrictions on
 * the server across all relevant APIs and surfaces"). Found by the independent
 * check of lane L's Compass gate: an account restricted from hosting could
 * still add, rewrite or remove a shared trip's plans through the plain Trips
 * routes, and one restricted from hosting or messaging could still put a
 * proposal in front of the whole crew through /commands or /replan.
 *
 * THE MAPPING — LANE C'S READING, FOR THE OWNER TO CONFIRM, by what each type
 * says it restricts (services/trust/TrustPrivacyGuard.ts: hosting "You cannot
 * host group trips at this time.", messaging "You cannot initiate new
 * conversations at this time."):
 *
 *   change_shared_plan  hosting — adding, editing, removing or reordering a
 *                       plan item of a GROUP trip is organising that group
 *                       trip. Doors: POST/PATCH/DELETE /trips/:id/plan/items…,
 *                       /remove, /reorder (routes/trips.ts); POST
 *                       /places/:id/add-to-trip-plan and
 *                       /meetups/:id/add-to-trip-plan (routes/plan.ts); POST
 *                       /hidden-gems/:id/plan (routes/hiddenGems.ts).
 *   create_proposal     hosting OR messaging — it organises a change every
 *                       member must act on, and it puts its rationale text on
 *                       every member's screen in this person's name. Doors:
 *                       POST /trips/:id/commands type CREATE_PROPOSAL
 *                       (server/trips/commandRoute.ts); POST /trips/:id/replan
 *                       with createProposals (readRoutes/tripProjections.ts).
 *                       The same reading as lane L's Compass gate, so the two
 *                       doors to the same act cannot disagree.
 *
 * A SOLO TRIP IS NOT A GROUP TRIP. Each gate applies only when someone other
 * than the actor is an accepted member: a restricted person keeps planning a
 * trip that is theirs alone, because "cannot host group trips" says nothing
 * about it (do not refuse more than the person is told). Lane L's Compass gate
 * does not make this distinction; the lead should pick one.
 *
 * NOT GATED, deliberately (OD-TRUST-5: limit a restriction to the actions it is
 * needed for): reading anything; voting on, accepting or rejecting a
 * proposal; attendance (JOIN_PLAN / LEAVE_PLAN); presence; and every safety
 * path — DECLARE_DISRUPTION / RESOLVE_DISRUPTION, meeting checkpoints and
 * arrivals, rescue, Safe Return, stopping a location share.
 *
 * Unreadable membership, or an unreadable restriction state, refuses with the
 * retryable 503 and no "restricted" wording (lib/discoveryTrustGate.ts).
 */
import type { Response } from "express";

import { readAcceptedTripMembers } from "../server/trips/privateAnchorShares.js";
import { refuseIfTrustRestricted, RESTRICTION_UNVERIFIABLE_MESSAGE, type GatedRestriction } from "./discoveryTrustGate.js";
import { sendError } from "./http.js";

export type TripRestrictedAction = "change_shared_plan" | "create_proposal";

export const TRIP_ACTION_RESTRICTIONS: Readonly<Record<TripRestrictedAction, readonly GatedRestriction[]>> = Object.freeze({
  change_shared_plan: Object.freeze(["hosting"]) as readonly GatedRestriction[],
  create_proposal: Object.freeze(["hosting", "messaging"]) as readonly GatedRestriction[],
});

/** True when it has refused (the caller returns). */
export async function refuseTripActionIfRestricted(
  res: Response,
  sc: any,
  tripId: string,
  userId: string,
  action: TripRestrictedAction,
): Promise<boolean> {
  if (!sc) { sendError(res, "server_not_configured", "Service client not ready"); return true; }
  const members = await readAcceptedTripMembers(sc, tripId).catch(() => null);
  if (!members) { sendError(res, "degraded_unavailable", RESTRICTION_UNVERIFIABLE_MESSAGE); return true; }
  const others = [...members].filter((m) => m !== userId);
  if (others.length === 0) return false; // a trip that is this person's alone is not a group trip
  return refuseIfTrustRestricted(res, sc, userId, TRIP_ACTION_RESTRICTIONS[action]);
}
