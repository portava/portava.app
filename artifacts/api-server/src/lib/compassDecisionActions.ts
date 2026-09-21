/**
 * census-compass CCL-09 — "map the decision vocabulary to the existing action
 * model with compatibility handling; do not blindly add enum values".
 *
 * Two vocabularies meet here and NEITHER is changed:
 *
 *   - Sensing §10's seven decisions (lib/compassDecision.ts COMPASS_DECISIONS):
 *     GO NOW · GO SOON · WAIT · STAY · SWITCH · SKIP · RETURN.
 *   - Compass's conversational action model — the twelve quick-action types
 *     `/compass/ask` accepts from the model and the client renders. Until this
 *     module the list lived as a private Set inside routes/compass.ts; it is
 *     declared ONCE here so the route, the decision tool and the test that
 *     pins the mapping's range all read the same twelve.
 *
 * The compatibility rule is deliberately small. Four decisions are
 * OPPORTUNITIES (the same four lib/opportunityEngine.ts turns into
 * opportunity kinds) and each maps onto the one existing action that opens
 * the place — `viewPlace` — carrying the decision and its reasons as params
 * so a client that understands decisions can render "Go now" while a client
 * that does not still gets a working button. The other three are REFUSALS:
 * they map to NO action, never to an invented one, and the tool that calls
 * this hands the model the decision and its reasons to explain in prose.
 *
 * What this does NOT do, on purpose: add "goNow" / "wait" / "switch" to the
 * action model. That is the "blindly add enum values" the clause forbids, and
 * the test asserts the range of the mapping is a subset of the twelve.
 */
import type { CompassDecision, DecisionReason } from "./compassDecision.js";

/** The conversational action model, exactly as the client renders it. */
export const COMPASS_QUICK_ACTION_TYPES = [
  "addTrip", "buildItinerary", "askCommunity", "explore",
  "viewEvent", "viewPlace", "startPoll", "shareTip",
  "openMap", "viewPassport", "findBuddy", "viewTrips",
] as const;
export type CompassQuickActionType = (typeof COMPASS_QUICK_ACTION_TYPES)[number];

export function isCompassQuickActionType(v: unknown): v is CompassQuickActionType {
  return typeof v === "string" && (COMPASS_QUICK_ACTION_TYPES as readonly string[]).includes(v);
}

/**
 * Decision → existing action type, or null for a refusal. A key for EVERY
 * decision, so a new decision cannot silently fall through to "no action".
 */
export const DECISION_ACTION_COMPATIBILITY: Readonly<Record<CompassDecision, CompassQuickActionType | null>> =
  Object.freeze({
    GO_NOW: "viewPlace",
    GO_SOON: "viewPlace",
    SWITCH: "viewPlace",
    RETURN: "viewPlace",
    WAIT: null,
    STAY: null,
    SKIP: null,
  });

export interface CompatibleAction {
  readonly actionType: CompassQuickActionType;
  readonly label: string;
  readonly params: {
    readonly placeId: string;
    /** The decision this action carries, for a client that renders decisions. */
    readonly decision: CompassDecision;
    readonly reasons: readonly DecisionReason[];
    /** CCL-08: whether the person must confirm before the action is taken. */
    readonly confirmationRequired: boolean;
  };
}

const LABELS: Readonly<Record<CompassDecision, string | null>> = Object.freeze({
  GO_NOW: "Go now",
  GO_SOON: "Go soon",
  SWITCH: "Switch to",
  RETURN: "Head back to",
  WAIT: null,
  STAY: null,
  SKIP: null,
});

/**
 * The action a decision is compatible with, or null when the decision is a
 * refusal. Pure.
 */
export function compatibleActionFor(
  decision: CompassDecision,
  subject: { readonly id: string; readonly name: string | null },
  reasons: readonly DecisionReason[],
  confirmationRequired: boolean,
): CompatibleAction | null {
  const actionType = DECISION_ACTION_COMPATIBILITY[decision];
  if (actionType === null) return null;
  const verb = LABELS[decision] ?? "Open";
  const name = subject.name && subject.name.trim().length > 0 ? subject.name.trim() : "this place";
  return {
    actionType,
    label: `${verb} ${name}`,
    params: { placeId: subject.id, decision, reasons: [...reasons], confirmationRequired },
  };
}
