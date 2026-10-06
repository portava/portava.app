/**
 * CompassRestrictionGate — a Trust restriction reaches the Compass actions it
 * covers, and no others (census-trust TRV2-08; owner decision OD-TRUST-5).
 *
 * OD-TRUST-5 (docs/ops/owner-decisions-20261004.md): "Enforce restrictions on
 * the server across all relevant APIs and surfaces; hiding controls in the
 * interface is not enough. Limit each restriction to the actions and duration
 * needed, and preserve access to appeals and permitted data exports."
 *
 * ── A RESTRICTION MEANS WHAT THE PERSON IS TOLD IT MEANS ─────────────────────
 * The person's own restriction summary (services/trust/TrustPrivacyGuard.ts —
 * lane B's) says, per type:
 *   hosting              "You cannot host group trips at this time."
 *   messaging            "You cannot initiate new conversations at this time."
 *   private_plan_access  "You cannot join private plans at this time."
 *   location_plan_join   "You cannot join location-based plans at this time."
 * A Compass refusal may not go further than those sentences: a restriction the
 * person cannot read about is not one this file enforces. So the mapping is:
 *
 *   hosting → Compass may not change a GROUP trip's shared plans for the
 *             person who HOSTS it (owns it, with at least one other accepted
 *             member): create_proposal, confirming a Compass plan proposal,
 *             confirming an Autopilot change. A member who does not host the
 *             trip, and a host of a solo trip, are unaffected — that is not
 *             hosting a group trip.
 *   messaging, private_plan_access, location_plan_join → no Compass action.
 *             None of these Compass actions starts a conversation or joins a
 *             plan.
 *
 * NARROWED 2026-10-06 after independent verification. The first version also
 * refused create_proposal under a messaging restriction, refused the confirms
 * for any member under hosting, and refused turning the visibility boost ON
 * under messaging — beyond what the person is told. The boost door is gone for
 * a second reason too: `boost_visibility_enabled` defaults TRUE and the feed
 * applies it without reading this gate, so refusing only the re-enable
 * restricted nothing (and the boost lifts the person's own feed posts; it is
 * not "promotion as someone to meet", as the first header said). Whether a
 * restricted person's posts should lose the boost is listed for the owner.
 *
 * This is lane L's READING of the four types, listed for owner confirmation
 * (lane-l/owner-decisions.md); it is not an owner ruling.
 *
 * ── AN UNREADABLE STATE REFUSES, AND NEVER SAYS "RESTRICTED" ────────────────
 * Whether the person hosts the trip is read first; a read that fails refuses
 * retryably. If they do host a group trip, their restriction state is read; in
 * either degraded shape (`fail_closed`, or `fail_open` whose can-flags all read
 * true) nobody could read their restrictions, so the action is refused with the
 * retryable 503 `degraded_unavailable`, worded as "could not verify", never as
 * a restriction. Declining, reading, reporting, memory controls and exports are
 * never gated.
 *
 * ── WHAT THIS FILE DOES NOT CLOSE ───────────────────────────────────────────
 * Sibling doors outside Compass reach the same writes with no restriction read
 * (POST /trips/:id/commands CREATE_PROPOSAL, POST /trips/:id/replan with
 * createProposals, the trip plan-item routes, POST /places/:id/add-to-trip-plan).
 * Those are Trips files (lane C); census-compass §38 lists them and TRV2-08
 * stays W until they read the same rule.
 */
import type { Response } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getRestrictionState,
  type RestrictionState,
  type RestrictionType,
} from "../services/trust/TrustRestrictionService.js";
import { sendError } from "../lib/http.js";

export type CompassRestrictedAction =
  | "create_proposal"
  | "confirm_plan_proposal"
  | "confirm_autopilot_proposal";

/**
 * Lane L's reading (see header). Every mapped action is a change to a group
 * trip's shared plans, so every one maps to `hosting` — and only applies when
 * the person hosts that group trip.
 */
export const COMPASS_ACTION_RESTRICTIONS: Readonly<Record<CompassRestrictedAction, readonly RestrictionType[]>> =
  Object.freeze({
    create_proposal: Object.freeze(["hosting"]) as readonly RestrictionType[],
    confirm_plan_proposal: Object.freeze(["hosting"]) as readonly RestrictionType[],
    confirm_autopilot_proposal: Object.freeze(["hosting"]) as readonly RestrictionType[],
  });

export const COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE =
  "We could not verify your permissions right now, so nothing was changed. This is temporary — please try again shortly.";

/** The person's own summary says "You cannot host group trips"; this says the same thing about this action. */
export const COMPASS_HOSTING_RESTRICTED_MESSAGE =
  "Your account is currently restricted from hosting group trips, so Compass can't change this trip's shared plans for you.";

/** Roles that make a trip_members row an accepted member (lib/http.ts requireTripMember). */
const ACCEPTED_ROLES = new Set(["owner", "co_host", "member", "viewer"]);

export interface TripHosting {
  /** The person owns the trip AND at least one other accepted member is on it. */
  hostsGroupTrip: boolean;
}

export type CompassRestrictionVerdict =
  | { allowed: true }
  | {
      allowed: false;
      kind: "restricted";
      /** The active restriction types that refuse THIS action (never the person's whole record). */
      restrictionTypes: RestrictionType[];
      message: string;
    }
  | {
      allowed: false;
      kind: "unverifiable";
      /** Why the check could not be completed: the service's own discriminator, or a read that failed or threw. */
      reason: "fail_open" | "fail_closed" | "threw" | "trip_unreadable";
      message: string;
    };

/** The decision, from facts already read. Exported so the rule is tested without a client. */
export function decideCompassAction(
  action: CompassRestrictedAction,
  hosting: TripHosting,
  state: RestrictionState | null,
): CompassRestrictionVerdict {
  // Not hosting a group trip: no restriction this file enforces can apply, and
  // the restriction state is not even needed.
  if (!hosting.hostsGroupTrip) return { allowed: true };
  if (!state || state.degraded) {
    return {
      allowed: false,
      kind: "unverifiable",
      reason: state?.degradedReason ?? "fail_closed",
      message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE,
    };
  }
  const needed = COMPASS_ACTION_RESTRICTIONS[action];
  const active = new Set(state.activeRestrictions ?? []);
  const hit = needed.filter((t) => active.has(t));
  if (hit.length === 0) return { allowed: true };
  return { allowed: false, kind: "restricted", restrictionTypes: hit, message: COMPASS_HOSTING_RESTRICTED_MESSAGE };
}

/** Does this person host this trip as a GROUP trip? null = could not be read. */
export async function readTripHosting(sc: SupabaseClient, userId: string, tripId: string): Promise<TripHosting | null> {
  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id").eq("id", tripId).maybeSingle();
  if (tripErr) return null;
  if (!trip || (trip as { owner_id?: unknown }).owner_id !== userId) return { hostsGroupTrip: false };
  const { data: members, error: memErr } = await sc
    .from("trip_members")
    .select("user_id, role, status")
    .eq("trip_id", tripId);
  if (memErr) return null;
  const others = ((members ?? []) as Array<{ user_id?: unknown; role?: unknown; status?: unknown }>).filter(
    (m) => m.user_id !== userId
      && ACCEPTED_ROLES.has(String(m.role))
      && (m.status === null || m.status === undefined || m.status === "accepted"),
  );
  return { hostsGroupTrip: others.length > 0 };
}

/** Read what is needed and decide. Never throws. */
export async function checkCompassActionRestriction(
  sc: SupabaseClient,
  userId: string,
  tripId: string,
  action: CompassRestrictedAction,
): Promise<CompassRestrictionVerdict> {
  let hosting: TripHosting | null;
  try {
    hosting = await readTripHosting(sc, userId, tripId);
  } catch {
    return { allowed: false, kind: "unverifiable", reason: "threw", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE };
  }
  if (!hosting) {
    return { allowed: false, kind: "unverifiable", reason: "trip_unreadable", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE };
  }
  if (!hosting.hostsGroupTrip) return { allowed: true };
  // getRestrictionState never throws (it answers a degraded state instead).
  return decideCompassAction(action, hosting, await getRestrictionState(sc, userId));
}

/**
 * The wire form for a ROUTE. Unverifiable → 503 `degraded_unavailable`
 * (retryable); restricted → 403 `trust_restriction`, the body every existing
 * restriction refusal in this server sends (routes/trips.ts,
 * routes/tripCrewLocation.ts), plus the restricted types for this action.
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
    `${verdict.message} Nothing was proposed or changed. Tell them this plainly and do not try ` +
    "another way to do the same thing for them."
  );
}
