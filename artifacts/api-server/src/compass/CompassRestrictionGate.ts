/**
 * CompassRestrictionGate — Trust restrictions reach the Compass actions that
 * act FOR a person (census-trust TRV2-08; owner decision OD-TRUST-5).
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * OD-TRUST-5 (docs/ops/owner-decisions-20261004.md): "Enforce restrictions on
 * the server across all relevant APIs and surfaces; hiding controls in the
 * interface is not enough. Limit each restriction to the actions and duration
 * needed, and preserve access to appeals and permitted data exports."
 *
 * `getRestrictionState` had callers in messaging, calls, trip creation, trip
 * invitations and crew live-share — and none under `src/compass/` or the
 * Compass routes (census-trust TRV2-08, re-confirmed by grep). So an account
 * an admin had restricted from messaging could still have Compass deliver a
 * crew proposal, with its free-text rationale, to every other member's screen;
 * and an account restricted from hosting could still have Compass add plans to
 * a shared trip or rewrite them through Autopilot.
 *
 * ── THE MAPPING IS THIS LANE'S READING, NOT AN OWNER RULING ─────────────────
 * The four restriction types are lane B's (TrustRestrictionService); which of
 * them covers which Compass action was not decided by the owner. The reading
 * below follows the one precedent already in the tree for a conversational
 * surface — Telegraph's capability policy
 * (domain/telegraph/policies/conversationCapabilityPolicy.ts) maps
 * `canSendMessage ← messaging` and `canCreatePlan ← hosting` — and is listed in
 * lane-l/owner-decisions.md for the owner to confirm or change. Each entry is
 * the narrowest type that stops the harm the restriction exists for:
 *
 *   create_proposal            hosting + messaging — it organises a change the
 *                              whole crew must act on (Telegraph: creating a
 *                              plan is hosting) AND it puts model-written text
 *                              on other people's screens in this person's name
 *                              (that is messaging). Either restriction refuses.
 *   confirm_plan_proposal      hosting — adds a plan item every member sees
 *                              (Telegraph: canCreatePlan ← hosting).
 *   confirm_autopilot_proposal hosting — moves or cancels shared plan items.
 *   boost_visibility_on        messaging — raises how prominently this person
 *                              is shown to strangers as someone to meet; an
 *                              account restricted from contacting people is
 *                              not promoted for contact. Turning the boost OFF
 *                              is never gated.
 *
 * NOT gated, deliberately: declining a proposal, reading anything, reporting,
 * Compass's own memory controls and exports, and proposals that stay inside the
 * person's own conversation (`add_to_trip` before confirm,
 * `compile_plan_from_experience`, `replan_day`, `simulate_plan`) — OD-TRUST-5
 * says to limit a restriction to the actions it is needed for.
 *
 * ── AN UNREADABLE STATE REFUSES, AND NEVER SAYS "RESTRICTED" ────────────────
 * `getRestrictionState` returns `degraded: true` in two shapes. `fail_closed`
 * (a real read error) already sets the can-flags false; `fail_open` (the table
 * is not migrated) sets them all true. Both mean the same thing here: nobody
 * could read this person's restrictions. A Compass action that speaks or
 * organises for a person is not taken on a guess, so EITHER shape refuses with
 * the retryable 503 `degraded_unavailable` — and the words say the check could
 * not be done, never that the person is restricted. This is stricter than the
 * `fail_open` handling in routes/trips.ts on purpose, and the reason is the
 * same sentence of OD-TRUST-5: "could not read" is not "not restricted".
 *
 * PURE apart from the one injected read; the route/tool callers own the wire.
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
  | "confirm_autopilot_proposal"
  | "boost_visibility_on";

/** Lane L's reading (see header). Any listed type, if active, refuses the action. */
export const COMPASS_ACTION_RESTRICTIONS: Readonly<Record<CompassRestrictedAction, readonly RestrictionType[]>> =
  Object.freeze({
    create_proposal: Object.freeze(["hosting", "messaging"]) as readonly RestrictionType[],
    confirm_plan_proposal: Object.freeze(["hosting"]) as readonly RestrictionType[],
    confirm_autopilot_proposal: Object.freeze(["hosting"]) as readonly RestrictionType[],
    boost_visibility_on: Object.freeze(["messaging"]) as readonly RestrictionType[],
  });

/** What the person was trying to do, in the words a refusal uses. */
const ACTION_WORDS: Readonly<Record<CompassRestrictedAction, string>> = Object.freeze({
  create_proposal: "proposing changes to your trip crew",
  confirm_plan_proposal: "adding plans to a shared trip",
  confirm_autopilot_proposal: "changing a shared trip's plans",
  boost_visibility_on: "boosting your visibility to other travelers",
});

export const COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE =
  "We could not verify your permissions right now, so nothing was changed. This is temporary — please try again shortly.";

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
      /** Why the state could not be read: the service's own discriminator, or a throw. */
      reason: "fail_open" | "fail_closed" | "threw";
      message: string;
    };

/** The decision, from a state already read. Exported so the rule is tested without a client. */
export function decideCompassAction(
  action: CompassRestrictedAction,
  state: RestrictionState,
): CompassRestrictionVerdict {
  if (state.degraded) {
    return {
      allowed: false,
      kind: "unverifiable",
      reason: state.degradedReason ?? "fail_closed",
      message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE,
    };
  }
  const needed = COMPASS_ACTION_RESTRICTIONS[action];
  const active = new Set(state.activeRestrictions ?? []);
  const hit = needed.filter((t) => active.has(t));
  if (hit.length === 0) return { allowed: true };
  return {
    allowed: false,
    kind: "restricted",
    restrictionTypes: hit,
    // The same sentence shape every existing restriction refusal in this server
    // uses (routes/trips.ts, routes/tripCrewLocation.ts). It points at no screen:
    // the suspension experience OD-TRUST-4 describes (what, why, how long, how to
    // appeal) is lane B's (census-trust TV-4b), and naming a settings page that
    // does not list restrictions would be a false instruction.
    message: `Your account is currently restricted from ${ACTION_WORDS[action]}.`,
  };
}

/** Read this person's restriction state and decide. Never throws. */
export async function checkCompassActionRestriction(
  sc: SupabaseClient,
  userId: string,
  action: CompassRestrictedAction,
): Promise<CompassRestrictionVerdict> {
  let state: RestrictionState;
  try {
    state = await getRestrictionState(sc, userId);
  } catch {
    return { allowed: false, kind: "unverifiable", reason: "threw", message: COMPASS_RESTRICTION_UNVERIFIABLE_MESSAGE };
  }
  return decideCompassAction(action, state);
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
