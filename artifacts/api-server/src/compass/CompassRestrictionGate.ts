/**
 * CompassRestrictionGate — a Trust restriction reaches the Compass actions it
 * covers, and no others (census-trust TRV2-08; owner decision OD-TRUST-5; lead
 * rulings D-24 and D-24a, 2026-10-06).
 *
 * OD-TRUST-5 (docs/ops/owner-decisions-20261004.md): "Enforce restrictions on
 * the server across all relevant APIs and surfaces; hiding controls in the
 * interface is not enough. Limit each restriction to the actions and duration
 * needed, and preserve access to appeals and permitted data exports."
 *
 * ── ONE RULE FOR EVERY DOOR TO THE SAME ACT ──────────────────────────────────
 * Compass does not decide this itself any more. Every Compass door asks lane
 * C's `decideTripActionRestriction` (lib/tripTrustGate.ts) — the SAME function
 * the Trips doors (`/trips/:id/commands`, `/replan`, the plan-item routes,
 * add-to-trip-plan) call — so the verifier's finding that Compass and Trips
 * answered the same act differently (Compass gated solo trips; Trips did not)
 * cannot recur. Lead ruling D-24a: "Every Compass and Trips door applies the
 * same solo/group test."
 *
 * ── WHAT IS STOPPED (lead ruling D-24, the confirmed mapping) ───────────────
 *   create_proposal            → the helper's `create_proposal`: hosting OR
 *                                messaging. A proposal organises a change every
 *                                member must act on and puts its rationale on
 *                                every member's screen ("a trip proposal made
 *                                through commands or re-plan counts as hosting
 *                                or messaging", D-24 table).
 *   add_to_trip (tool)         → `change_shared_plan`: hosting. It prepares an
 *                                add to a group trip's shared plan.
 *   confirm_plan_proposal      → `change_shared_plan`: hosting.
 *   confirm_autopilot_proposal → `change_shared_plan`: hosting.
 * And only on a GROUP trip — one where someone other than the actor is an
 * accepted member. A SOLO trip is never refused, and its restriction state is
 * not even read (D-24a: "a hosting restriction does NOT stop changes to a solo
 * trip. A solo trip affects nobody else.").
 *
 * NOT stopped by any restriction: reading anything, declining a proposal,
 * replanning as a computation (replan_day writes nothing — its reply only stops
 * pointing at create_proposal when that would be refused), memory controls,
 * reports, exports, and every safety path.
 *
 * ── AN UNREADABLE STATE REFUSES, AND NEVER SAYS "RESTRICTED" ────────────────
 * If whether the trip is solo cannot be read, it is treated as a group trip and
 * refused with "try again" (D-24a). On a group trip, a restriction state that
 * cannot be read — either degraded shape, or a throw — refuses the same way: a
 * retryable 503 `degraded_unavailable`, worded as a check that could not be
 * done, never as a restriction.
 *
 * ── THE WORDS ───────────────────────────────────────────────────────────────
 * A refusal says the restriction's own sentence (the helper's message,
 * `RESTRICTION_SENTENCES` in lib/discoveryTrustGate.ts), so nobody is refused
 * in words they were not shown. The sentences themselves are Trust's
 * (services/trust/TrustPrivacyGuard.ts); D-24 rewrote them, and lane B owns
 * that change.
 */
import type { Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  decideTripActionRestriction,
  type TripRestrictedAction,
} from "../lib/tripTrustGate.js";
import { RESTRICTION_UNVERIFIABLE_MESSAGE, type GatedRestriction } from "../lib/discoveryTrustGate.js";
import { sendError } from "../lib/http.js";

export type CompassRestrictedAction =
  | "create_proposal"
  | "add_to_trip"
  | "confirm_plan_proposal"
  | "confirm_autopilot_proposal";

/** Which shared Trips decision each Compass door is (lead ruling D-24's table). */
export const COMPASS_TRIP_ACTION: Readonly<Record<CompassRestrictedAction, TripRestrictedAction>> = Object.freeze({
  create_proposal: "create_proposal",
  add_to_trip: "change_shared_plan",
  confirm_plan_proposal: "change_shared_plan",
  confirm_autopilot_proposal: "change_shared_plan",
});

/** Re-exported so Compass's callers and tests name the one message every door uses. */
export const COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE = RESTRICTION_UNVERIFIABLE_MESSAGE;

export type CompassRestrictionVerdict =
  | { allowed: true; shape: "solo" | "group" }
  | {
      allowed: false;
      kind: "restricted";
      /** The active restriction types that refuse THIS action (never the person's whole record). */
      restrictionTypes: GatedRestriction[];
      /** The restrictions' own sentences. */
      message: string;
    }
  | {
      allowed: false;
      kind: "unverifiable";
      /** Why the check could not be completed, as the shared helper reports it. */
      reason: string;
      message: string;
    };

/**
 * Read what is needed and decide, through the shared Trips decision. Never
 * throws: the helper catches its own reads (a throw in either read is
 * `unreadable` → unverifiable), so this file adds no catch of its own — the
 * earlier gate's catch was unreachable (verifier finding 10), and an
 * unreachable branch reads like a guarantee nobody tests.
 */
export async function checkCompassActionRestriction(
  sc: SupabaseClient,
  userId: string,
  tripId: string,
  action: CompassRestrictedAction,
): Promise<CompassRestrictionVerdict> {
  const v = await decideTripActionRestriction(sc, tripId, userId, COMPASS_TRIP_ACTION[action]);
  if (v.allowed) return { allowed: true, shape: v.shape };
  if (v.kind === "unverifiable") return { allowed: false, kind: "unverifiable", reason: v.reason, message: v.message };
  return { allowed: false, kind: "restricted", restrictionTypes: v.restrictionTypes, message: v.message };
}

/**
 * The wire form for a ROUTE — the body the Trips doors send
 * (lib/tripTrustGate.ts refuseTripActionIfRestricted). Unverifiable → 503
 * `degraded_unavailable` (retryable); restricted → 403 `trust_restriction`.
 */
export function sendCompassRestrictionRefusal(
  res: Response,
  verdict: Exclude<CompassRestrictionVerdict, { allowed: true }>,
): void {
  if (verdict.kind === "unverifiable") {
    sendError(res, "degraded_unavailable", verdict.message);
    return;
  }
  res.status(403).json({
    error: "trust_restriction",
    message: verdict.message,
    restrictionTypes: verdict.restrictionTypes,
  });
}

/**
 * The form for a Compass TOOL result: an `info` sentence the model can repeat
 * honestly. Tools return refusal objects rather than throwing, because a throw
 * becomes "Tool execution failed" and the model can say nothing true about it.
 */
export function compassRestrictionToolInfo(
  verdict: Exclude<CompassRestrictionVerdict, { allowed: true }>,
): string {
  if (verdict.kind === "unverifiable") {
    return (
      "This person's permissions could not be verified right now — that is temporary and is NOT a " +
      "restriction on them. Nothing was proposed or changed; tell them to try again shortly."
    );
  }
  return (
    `${verdict.message} Because of that, Compass cannot do this on a group trip for them; nothing was ` +
    "proposed or changed. Tell them this plainly and do not try another way to do the same thing for them."
  );
}
