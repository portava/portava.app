/**
 * LayoverLifecycle — spec §5's state graph as a PURE state machine: seventeen
 * states, the edges between them, a guard on every edge that has one, and the
 * side effects each transition REQUIRES, returned as intents. No clock, no I/O.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §4.1  `LayoverState` (the seventeen, spelled once in LayoverConstraints.ts)
 *   §5    the graph and its guard/side-effect table
 *   §15.1 RETURN TO AIRPORT — "marks the session RETURNING" from any active plan
 *   §18   `close(sessionId, outcome)` — the traveller's own close
 *
 * Census-layover L39 (the graph), L40 (EVALUATING → LANDSIDE_AVAILABLE and its
 * four-part guard), L43 (RETURNING → AIRPORT_REENTERED on a re-entry checkpoint).
 *
 * ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
 * `deriveLayoverState` (LayoverConstraints.ts) is a PROJECTION: it reads the
 * stored status and a certified record and names the state they describe. It
 * records no transition and has no edges. This module is the graph: given a
 * state and an event it answers whether §5 has that edge, whether the edge's
 * guard holds, and what the transition must cause. The two meet in
 * `lifecycleStateFrom`, which refines the projection with the traveller's own
 * checkpoints (the only observer this tree has).
 *
 * ── NOTHING CURRENTLY ALLOWED BECOMES DISALLOWED ────────────────────────────
 * The machine is ADVISORY. It never refuses a write the routes make today, and
 * that is a property, not a hope: `STORED_OPERATION_EVENTS` maps every stored
 * status write onto an event, and a test sweeps every state × operation and
 * asserts each one that the database accepts today has an edge here. Two edges
 * exist BECAUSE of that sweep and are labelled with their source rather than
 * passed off as §5's: the traveller's close (§18) and the one-tap abort
 * (§15.1), both reachable from every active state. A safety control that a
 * state graph could veto is worse than no state graph.
 *
 * Under `layover_lifecycle_machine_enabled` (seeded FALSE by migration 3632):
 *   OFF  SHADOW. The routes run the machine beside the write and LOG where the
 *        graph and the write disagree (`layover_lifecycle_shadow`). Nothing on
 *        the wire changes.
 *   ON   the overview publishes `lifecycle` — the machine's state, the
 *        evaluation guard and its failures, and the intents — and the
 *        transition routes publish the transition they made. Still advisory:
 *        no write is refused.
 * The flag is a capability (ON adds disclosure, withholds nothing), so it is
 * read through `isFlagEnabled` and is not a RESTRICTIVE_WHEN_ON flag.
 *
 * ── UNKNOWN FAILS CLOSED ────────────────────────────────────────────────────
 * The EVALUATING guard is four named conditions and each must be POSITIVELY
 * met: entry `CONFIRMED_ALLOWED` (UNKNOWN fails — the owner's entry decision is
 * not taken here, and an unknown is never read as allowed); `criticalUnknowns`
 * an array and empty; `usableMinutes` a finite number at or above the floor;
 * `returnContractSatisfiable === true`. A missing or malformed input is a
 * failure with its own name, never a pass.
 *
 * ── STATES WITH NO PRODUCER ON THIS TREE ────────────────────────────────────
 * DETECTED (no connection detector — census L169), BOARDING (no boarding
 * checkpoint, no flight feed) and ABANDONED (nothing distinguishes it from a
 * cancellation) have edges and no event source. They are in the graph because
 * §4.1 declares them; `LIFECYCLE_EVENT_PRODUCERS` names, per event, what
 * produces it or that nothing does.
 */
import type { LayoverState, EntryPermissionState, LandsideGate } from "./LayoverConstraints.js";
import { LAYOVER_STATES, landsideStatusOf } from "./LayoverConstraints.js";
import type { LayoverReturnState, LeaveAdvice } from "./LayoverSafetyEngine.js";

/** Seeded FALSE by 3632_layover_lifecycle_machine_flag.sql. */
export const LAYOVER_LIFECYCLE_FLAG = "layover_lifecycle_machine_enabled";

/**
 * The usable-minutes floor of the EVALUATING guard. NOT A NEW NUMBER: it is the
 * rung at which `adviseLeaving` first answers `yes` (`usableMinutes >= 90`), and
 * `src/test/layoverLifecycle.test.ts` pins the two together so they cannot drift.
 */
export const LANDSIDE_AVAILABLE_FLOOR_MIN = 90;

export const TERMINAL_STATES = ["COMPLETED", "CANCELLED", "EXPIRED", "ABANDONED"] as const satisfies readonly LayoverState[];
export type TerminalState = (typeof TERMINAL_STATES)[number];

export function isTerminalState(s: LayoverState): s is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}

/** Every non-terminal state. "Any active state" in §5 means exactly these. */
export const ACTIVE_STATES: readonly LayoverState[] = LAYOVER_STATES.filter((s) => !isTerminalState(s));

/**
 * The states a stored `active` row can be in: every active state but
 * RETURNING, which has its own stored status. `from === null` ranges over these.
 */
export const STORED_ACTIVE_STATES: readonly LayoverState[] = ACTIVE_STATES.filter((s) => s !== "RETURNING");

export const LIFECYCLE_EVENTS = [
  "FACTS_MISSING",
  "FACTS_SUFFICIENT",
  "EVALUATED",
  "PLAN_CHOSEN",
  "AIRPORT_EXITED",
  "RETURN_THRESHOLD",
  "HARD_THRESHOLD",
  "RETURN_BEGINS",
  "AIRPORT_REENTERED",
  "BOARDING_STARTED",
  "DEPARTURE_CONFIRMED",
  "MATERIAL_DISRUPTION",
  "DISRUPTION_RECOMPUTED",
  "DEPARTURE_CANCELLED",
  "TIMEOUT",
  "TRAVELLER_CLOSED",
  "ABANDONED",
] as const;
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** What produces each event on this tree, or that nothing does. */
export const LIFECYCLE_EVENT_PRODUCERS: Record<LifecycleEvent, string | null> = {
  FACTS_MISSING: "landsideGate.needsInfo (certified record)",
  FACTS_SUFFICIENT: "landsideGate.needsInfo cleared by a declaration (certified record)",
  EVALUATED: "every certification (certifySessionFeasibility / consumerLayoverRecord)",
  PLAN_CHOSEN: "a landside stop on the plan (POST /airport/sessions/:id/stops)",
  AIRPORT_EXITED: "traveller checkpoint LANDSIDE_EXIT (POST /airport/sessions/:id/checkpoints)",
  RETURN_THRESHOLD: "certified returnState RETURN_SOON",
  HARD_THRESHOLD: "certified returnState RETURN_NOW / CONNECTION_AT_RISK",
  RETURN_BEGINS: "POST /airport/sessions/:id/return-now (abortToAirport)",
  AIRPORT_REENTERED: "traveller checkpoint AIRPORT_REENTRY (POST /airport/sessions/:id/checkpoints)",
  BOARDING_STARTED: null,
  DEPARTURE_CONFIRMED: null,
  MATERIAL_DISRUPTION: "POST /airport/sessions/:id/disruption",
  DISRUPTION_RECOMPUTED: "the recertification after a disruption",
  DEPARTURE_CANCELLED: null,
  TIMEOUT: "expireOldSessions (departure in the past)",
  TRAVELLER_CLOSED: "DELETE /airport/sessions/:id (endSessionWrite, completed | cancelled)",
  ABANDONED: null,
};

/** The side effects §5 / §15.1 require of a transition, as named intents. */
export const LIFECYCLE_INTENTS = [
  "CREATE_SNAPSHOT",
  "CREATE_SAFE_ENVELOPE",
  "CREATE_CANDIDATE_SET",
  "ASK_ONE_QUESTION",
  "SUPPRESS_LANDSIDE_RECOMMENDATIONS",
  "HIGH_PRIORITY_NOTIFICATION",
  "DEEMPHASIZE_DISCOVERY",
  "SWITCH_PRIMARY_CTA_TO_RETURN",
  "CANCEL_OPTIONAL_ITINERARY",
  "SURFACE_FASTEST_RETURN_ROUTE",
  "NOTIFY_CREW_IF_ALLOWED",
  "PRESERVE_OFFLINE_DEADLINE",
  "RECORD_IN_DECISION_LEDGER",
  "STOP_LANDSIDE_DISCOVERY",
  "REFRESH_GATE_AND_SECURITY",
  "INVALIDATE_STALE_RECOMMENDATIONS",
  "REPLAN",
  "PRESERVE_AUDIT_TRAIL",
  "RECORD_OUTCOME",
] as const;
export type LifecycleIntent = (typeof LIFECYCLE_INTENTS)[number];

// ── guard context ────────────────────────────────────────────────────────────

/** Everything an edge's guard may read. Every member optional; absent fails closed. */
export interface LifecycleGuardContext {
  entryPermissionState?: EntryPermissionState | null;
  criticalUnknowns?: readonly string[] | null;
  usableMinutes?: number | null;
  returnContractSatisfiable?: boolean | null;
  /** §12.1 — the record names one field whose answer could change the verdict. */
  needsInfo?: boolean | null;
  /** A stop outside the airport is on the plan. */
  hasLandsidePlan?: boolean | null;
  /** The certified §15 ladder state. */
  returnState?: LayoverReturnState | null;
  /** A traveller checkpoint of the named type is the latest report. */
  checkpoint?: "LANDSIDE_EXIT" | "AIRPORT_REENTRY" | null;
  /** The departure instant has passed (TIMEOUT's guard). */
  departurePassed?: boolean | null;
  /** The disruption changed the action universe (POST /disruption's own judgement). */
  materialChange?: boolean | null;
  /** §18 close outcome. */
  closeOutcome?: "completed" | "cancelled" | null;
}

export const EVALUATION_GUARD_FAILURES = [
  "entry_not_confirmed_allowed",
  "critical_unknowns_present",
  "critical_unknowns_unread",
  "usable_time_below_floor",
  "usable_time_unknown",
  "return_contract_not_satisfiable",
  "return_contract_unknown",
] as const;
export type EvaluationGuardFailure = (typeof EVALUATION_GUARD_FAILURES)[number];

/**
 * §5's guard for EVALUATING → LANDSIDE_AVAILABLE, evaluated: "entry allowed;
 * critical unknowns empty; usable time ≥ configured floor; return contract
 * satisfiable". Empty result = the guard holds.
 */
export function landsideAvailableGuard(ctx: LifecycleGuardContext): EvaluationGuardFailure[] {
  const out: EvaluationGuardFailure[] = [];
  if (ctx.entryPermissionState !== "CONFIRMED_ALLOWED") out.push("entry_not_confirmed_allowed");
  if (!Array.isArray(ctx.criticalUnknowns)) out.push("critical_unknowns_unread");
  else if (ctx.criticalUnknowns.length > 0) out.push("critical_unknowns_present");
  if (typeof ctx.usableMinutes !== "number" || !Number.isFinite(ctx.usableMinutes)) out.push("usable_time_unknown");
  else if (ctx.usableMinutes < LANDSIDE_AVAILABLE_FLOOR_MIN) out.push("usable_time_below_floor");
  if (ctx.returnContractSatisfiable === false) out.push("return_contract_not_satisfiable");
  else if (ctx.returnContractSatisfiable !== true) out.push("return_contract_unknown");
  return out;
}

// ── the graph ────────────────────────────────────────────────────────────────

/** Where an edge comes from. §5 unless labelled otherwise. */
export type EdgeSource = "§5" | "§15.1 one-tap abort" | "§18 close" | "§5 escalation, rung skipped" | "checkpoint before abort" | "§15.2 recompute";

export interface LifecycleEdge {
  from: readonly LayoverState[];
  event: LifecycleEvent;
  /** The target, or a function of the guard context for a branching edge. */
  to: LayoverState | ((ctx: LifecycleGuardContext) => { to: LayoverState; failures: string[] });
  /** Guard failures. Empty = the edge may be taken. Absent = unguarded. */
  guard?: (ctx: LifecycleGuardContext) => string[];
  intents: (ctx: LifecycleGuardContext) => LifecycleIntent[];
  source: EdgeSource;
}

const RETURN_ABORT_INTENTS: LifecycleIntent[] = [
  "CANCEL_OPTIONAL_ITINERARY",
  "SURFACE_FASTEST_RETURN_ROUTE",
  "NOTIFY_CREW_IF_ALLOWED",
  "PRESERVE_OFFLINE_DEADLINE",
  "RECORD_IN_DECISION_LEDGER",
];

const ESCALATED: ReadonlySet<LayoverReturnState> = new Set(["RETURN_NOW", "CONNECTION_AT_RISK"]);

export const LIFECYCLE_EDGES: readonly LifecycleEdge[] = [
  { from: ["DETECTED"], event: "FACTS_MISSING", to: "NEEDS_INFO",
    guard: (c) => (c.needsInfo === true ? [] : ["no_field_needs_info"]),
    intents: () => ["ASK_ONE_QUESTION", "SUPPRESS_LANDSIDE_RECOMMENDATIONS"], source: "§5" },
  { from: ["DETECTED", "NEEDS_INFO"], event: "FACTS_SUFFICIENT", to: "EVALUATING",
    guard: (c) => (c.needsInfo === false ? [] : ["a_field_still_needs_info"]),
    intents: () => [], source: "§5" },
  { from: ["EVALUATING"], event: "EVALUATED",
    to: (c) => {
      const failures = landsideAvailableGuard(c);
      return { to: failures.length === 0 ? "LANDSIDE_AVAILABLE" : "AIRPORT_ONLY", failures };
    },
    intents: (c) => (landsideAvailableGuard(c).length === 0
      ? ["CREATE_SNAPSHOT", "CREATE_SAFE_ENVELOPE", "CREATE_CANDIDATE_SET"]
      : ["CREATE_SNAPSHOT", "SUPPRESS_LANDSIDE_RECOMMENDATIONS"]),
    source: "§5" },
  { from: ["LANDSIDE_AVAILABLE"], event: "PLAN_CHOSEN", to: "PLAN_SELECTED",
    guard: (c) => [...(c.hasLandsidePlan === true ? [] : ["no_landside_stop_planned"]), ...landsideAvailableGuard(c)],
    intents: () => [], source: "§5" },
  { from: ["PLAN_SELECTED"], event: "AIRPORT_EXITED", to: "EXECUTING",
    guard: (c) => (c.checkpoint === "LANDSIDE_EXIT" ? [] : ["no_landside_exit_checkpoint"]),
    intents: () => [], source: "§5" },
  { from: ["EXECUTING"], event: "RETURN_THRESHOLD", to: "RETURN_SOON",
    guard: (c) => (c.returnState === "RETURN_SOON" ? [] : ["return_threshold_not_reached"]),
    intents: () => ["HIGH_PRIORITY_NOTIFICATION", "DEEMPHASIZE_DISCOVERY"], source: "§5" },
  { from: ["RETURN_SOON"], event: "HARD_THRESHOLD", to: "RETURN_NOW",
    guard: (c) => (c.returnState && ESCALATED.has(c.returnState) ? [] : ["hard_threshold_not_reached"]),
    intents: () => ["SWITCH_PRIMARY_CTA_TO_RETURN"], source: "§5" },
  // A clock that jumps (an app reopened late) must not leave a traveller in the
  // city un-escalated because the RETURN_SOON rung was never observed.
  { from: ["EXECUTING"], event: "HARD_THRESHOLD", to: "RETURN_NOW",
    guard: (c) => (c.returnState && ESCALATED.has(c.returnState) ? [] : ["hard_threshold_not_reached"]),
    intents: () => ["HIGH_PRIORITY_NOTIFICATION", "DEEMPHASIZE_DISCOVERY", "SWITCH_PRIMARY_CTA_TO_RETURN"],
    source: "§5 escalation, rung skipped" },
  { from: ["RETURN_SOON", "RETURN_NOW"], event: "RETURN_BEGINS", to: "RETURNING",
    intents: () => RETURN_ABORT_INTENTS, source: "§5" },
  // §15.1: "Every active landside plan must expose RETURN TO AIRPORT … marks the
  // session RETURNING." The route accepts it from any active session today and
  // a state graph must never be the reason a return is refused.
  { from: ACTIVE_STATES.filter((s) => s !== "RETURNING" && s !== "RETURN_SOON" && s !== "RETURN_NOW"),
    event: "RETURN_BEGINS", to: "RETURNING", intents: () => RETURN_ABORT_INTENTS, source: "§15.1 one-tap abort" },
  { from: ["RETURNING"], event: "AIRPORT_REENTERED", to: "AIRPORT_REENTERED",
    guard: (c) => (c.checkpoint === "AIRPORT_REENTRY" ? [] : ["no_reentry_checkpoint"]),
    intents: () => ["STOP_LANDSIDE_DISCOVERY", "REFRESH_GATE_AND_SECURITY"], source: "§5" },
  // A traveller who walks back in without tapping Return. The checkpoint is the
  // evidence the return happened; re-entry is never the less safe reading.
  { from: ["EXECUTING", "RETURN_SOON", "RETURN_NOW"], event: "AIRPORT_REENTERED", to: "AIRPORT_REENTERED",
    guard: (c) => (c.checkpoint === "AIRPORT_REENTRY" ? [] : ["no_reentry_checkpoint"]),
    intents: () => ["STOP_LANDSIDE_DISCOVERY", "REFRESH_GATE_AND_SECURITY"], source: "checkpoint before abort" },
  { from: ["AIRPORT_REENTERED"], event: "BOARDING_STARTED", to: "BOARDING", intents: () => [], source: "§5" },
  { from: ["BOARDING"], event: "DEPARTURE_CONFIRMED", to: "COMPLETED", intents: () => ["RECORD_OUTCOME"], source: "§5" },
  { from: ACTIVE_STATES.filter((s) => s !== "DISRUPTED"), event: "MATERIAL_DISRUPTION", to: "DISRUPTED",
    guard: (c) => (c.materialChange === true ? [] : ["disruption_not_material"]),
    intents: () => ["INVALIDATE_STALE_RECOMMENDATIONS", "REPLAN", "PRESERVE_AUDIT_TRAIL"], source: "§5" },
  { from: ["DISRUPTED"], event: "DISRUPTION_RECOMPUTED", to: "EVALUATING", intents: () => ["CREATE_SNAPSHOT"], source: "§15.2 recompute" },
  { from: ACTIVE_STATES, event: "DEPARTURE_CANCELLED", to: "CANCELLED",
    intents: () => ["INVALIDATE_STALE_RECOMMENDATIONS", "PRESERVE_AUDIT_TRAIL"], source: "§5" },
  { from: ACTIVE_STATES, event: "TIMEOUT", to: "EXPIRED",
    guard: (c) => (c.departurePassed === true ? [] : ["departure_not_passed"]),
    intents: () => ["RECORD_OUTCOME"], source: "§5" },
  { from: ACTIVE_STATES, event: "TRAVELLER_CLOSED",
    to: (c) => (c.closeOutcome === "completed" ? { to: "COMPLETED", failures: [] }
      : c.closeOutcome === "cancelled" ? { to: "CANCELLED", failures: [] }
      : { to: "CANCELLED", failures: ["close_outcome_unstated"] }),
    intents: () => ["RECORD_OUTCOME", "PRESERVE_AUDIT_TRAIL"], source: "§18 close" },
  { from: ACTIVE_STATES, event: "ABANDONED", to: "ABANDONED", intents: () => ["RECORD_OUTCOME"], source: "§5" },
];

// ── the transition function ─────────────────────────────────────────────────

export type TransitionRefusal = "terminal_state" | "no_edge" | "guard_failed" | "from_state_unresolved";

export type LifecycleTransition =
  | {
      ok: true;
      /** `null` when the caller did not resolve which active state (see `transition`). */
      from: LayoverState | null;
      event: LifecycleEvent;
      to: LayoverState;
      /** Why a BRANCHING edge took its less permissive branch (EVALUATED → AIRPORT_ONLY). */
      branchFailures: string[];
      intents: LifecycleIntent[];
      source: EdgeSource;
    }
  | { ok: false; from: LayoverState | null; event: LifecycleEvent; refusal: TransitionRefusal; guardFailures: string[] };

/**
 * Take `event` from `from`.
 *
 * `from === null` means "a stored `active` row whose state the caller did not
 * resolve" — any of `STORED_ACTIVE_STATES`. The event is taken only when EVERY
 * one of those states takes it to the SAME target; otherwise the answer is
 * `from_state_unresolved`. Never guessed.
 */
export function transition(
  from: LayoverState | null,
  event: LifecycleEvent,
  ctx: LifecycleGuardContext = {},
): LifecycleTransition {
  if (from === null) {
    const each = STORED_ACTIVE_STATES.map((s) => transition(s, event, ctx));
    const first = each[0];
    if (first && first.ok && each.every((t) => t.ok && t.to === first.to)) {
      return { ...first, from: null };
    }
    const anyEdge = LIFECYCLE_EDGES.some((e) => e.event === event);
    return { ok: false, from, event, refusal: anyEdge ? "from_state_unresolved" : "no_edge", guardFailures: [] };
  }
  if (isTerminalState(from)) {
    return { ok: false, from, event, refusal: "terminal_state", guardFailures: [] };
  }
  const candidates = LIFECYCLE_EDGES.filter((e) => e.event === event && e.from.includes(from));
  if (candidates.length === 0) {
    return { ok: false, from, event, refusal: "no_edge", guardFailures: [] };
  }
  let lastFailures: string[] = [];
  for (const edge of candidates) {
    const failures = edge.guard ? edge.guard(ctx) : [];
    if (failures.length > 0) { lastFailures = failures; continue; }
    const target = typeof edge.to === "function" ? edge.to(ctx) : { to: edge.to, failures: [] };
    return {
      ok: true,
      from,
      event,
      to: target.to,
      branchFailures: target.failures,
      intents: edge.intents(ctx),
      source: edge.source,
    };
  }
  return { ok: false, from, event, refusal: "guard_failed", guardFailures: lastFailures };
}

/** Every event that has an edge out of `from` whose guard holds under `ctx`. */
export function availableEvents(from: LayoverState, ctx: LifecycleGuardContext = {}): LifecycleEvent[] {
  return LIFECYCLE_EVENTS.filter((ev) => transition(from, ev, ctx).ok);
}

// ── the stored writes, mapped onto events ───────────────────────────────────

/**
 * Every write that changes `layover_sessions.status` today, or records a
 * checkpoint the graph reads, and the event it is. A write not listed here has
 * no lifecycle meaning.
 */
export const STORED_OPERATION_EVENTS = {
  end_completed: "TRAVELLER_CLOSED",
  end_cancelled: "TRAVELLER_CLOSED",
  expire_sweep: "TIMEOUT",
  return_now: "RETURN_BEGINS",
  checkpoint_landside_exit: "AIRPORT_EXITED",
  checkpoint_airport_reentry: "AIRPORT_REENTERED",
} as const satisfies Record<string, LifecycleEvent>;
export type StoredOperation = keyof typeof STORED_OPERATION_EVENTS;

/** The guard context a stored operation carries by its own nature. */
export function operationContext(op: StoredOperation): LifecycleGuardContext {
  switch (op) {
    case "end_completed": return { closeOutcome: "completed" };
    case "end_cancelled": return { closeOutcome: "cancelled" };
    case "expire_sweep": return { departurePassed: true }; // the sweep's own WHERE: departure_time < now
    case "return_now": return {};
    case "checkpoint_landside_exit": return { checkpoint: "LANDSIDE_EXIT" };
    case "checkpoint_airport_reentry": return { checkpoint: "AIRPORT_REENTRY" };
  }
}

/** The lifecycle state a STORED status names on its own, or null for `active` (unresolved). */
export function storedStatusState(status: string): LayoverState | null {
  switch (status) {
    case "returning": return "RETURNING";
    case "completed": return "COMPLETED";
    case "cancelled": return "CANCELLED";
    case "expired": return "EXPIRED";
    default: return null; // `active`, or a status this build does not know: live, unresolved
  }
}

export interface ShadowVerdict {
  operation: StoredOperation;
  event: LifecycleEvent;
  transition: LifecycleTransition;
  /**
   * TRUE when the graph would not take this edge although the write is made.
   * In shadow mode this is LOGGED; in neither mode is the write refused.
   */
  divergent: boolean;
}

/** Run the machine beside a stored write. Pure; the caller logs or publishes. */
export function shadowStoredOperation(
  op: StoredOperation,
  from: LayoverState | null,
  extra: LifecycleGuardContext = {},
): ShadowVerdict {
  const event = STORED_OPERATION_EVENTS[op];
  const t = transition(from, event, { ...extra, ...operationContext(op) });
  return { operation: op, event, transition: t, divergent: !t.ok };
}

// ── the record, read as a lifecycle state ───────────────────────────────────

/** The certified record fields the lifecycle reads. */
export interface LifecycleRecordView {
  landsideGate: LandsideGate;
  verdict?: LeaveAdvice["verdict"];
  envelope: { usableMinutes: number; returnState: LayoverReturnState; freedomWindow: unknown | null; hardReturnTime: Date };
  inputs: { nowMs: number };
}

/** The guard context a certified record supplies. */
export function guardContextFromRecord(record: LifecycleRecordView, hasLandsidePlan: boolean): LifecycleGuardContext {
  const g = record.landsideGate;
  const hard = record.envelope.hardReturnTime instanceof Date ? record.envelope.hardReturnTime.getTime() : Number.NaN;
  return {
    entryPermissionState: g?.entryPermissionState ?? null,
    criticalUnknowns: Array.isArray(g?.criticalUnknowns) ? g.criticalUnknowns : null,
    usableMinutes: record.envelope.usableMinutes,
    // The return contract is satisfiable when there IS a landside window and its
    // hard return is still ahead of the instant the record was certified for.
    returnContractSatisfiable: Number.isFinite(hard) && Number.isFinite(record.inputs.nowMs)
      ? record.envelope.freedomWindow !== null && hard > record.inputs.nowMs
      : null,
    needsInfo: g ? g.needsInfo !== null : null,
    hasLandsidePlan,
    returnState: record.envelope.returnState,
  };
}

export interface LifecycleEvaluation {
  /** The state the graph places this session in. */
  state: LayoverState;
  /** The EVALUATING guard, evaluated on this record. Empty = LANDSIDE_AVAILABLE's guard holds. */
  guardFailures: EvaluationGuardFailure[];
  /** Intents the current state requires, from the edge that leads into it. */
  intents: LifecycleIntent[];
  /** Events the graph would accept from here. */
  availableEvents: LifecycleEvent[];
  /**
   * The projection `deriveLayoverState` gave, beside the graph's state, so a
   * disagreement is visible rather than resolved silently in either direction.
   */
  projectedState: LayoverState | null;
  /**
   * Where the graph and what happened disagree. Empty when they agree.
   *   guard_vs_gate        the EVALUATING guard and the projection's landside
   *                        gate give different answers on one record.
   *   left_without_guard   the traveller reported leaving the airport while
   *                        LANDSIDE_AVAILABLE's guard did not hold.
   */
  divergence: Array<"guard_vs_gate" | "left_without_guard">;
}

const INTENTS_ON_ENTRY: Partial<Record<LayoverState, LifecycleIntent[]>> = {
  NEEDS_INFO: ["ASK_ONE_QUESTION", "SUPPRESS_LANDSIDE_RECOMMENDATIONS"],
  AIRPORT_ONLY: ["CREATE_SNAPSHOT", "SUPPRESS_LANDSIDE_RECOMMENDATIONS"],
  LANDSIDE_AVAILABLE: ["CREATE_SNAPSHOT", "CREATE_SAFE_ENVELOPE", "CREATE_CANDIDATE_SET"],
  RETURN_SOON: ["HIGH_PRIORITY_NOTIFICATION", "DEEMPHASIZE_DISCOVERY"],
  RETURN_NOW: ["HIGH_PRIORITY_NOTIFICATION", "DEEMPHASIZE_DISCOVERY", "SWITCH_PRIMARY_CTA_TO_RETURN"],
  RETURNING: RETURN_ABORT_INTENTS,
  AIRPORT_REENTERED: ["STOP_LANDSIDE_DISCOVERY", "REFRESH_GATE_AND_SECURITY"],
};

/** Projected states in which the traveller is, as far as the record knows, at the airport and not escalated. */
const AT_AIRPORT_UNESCALATED: ReadonlySet<LayoverState | null> = new Set<LayoverState | null>([
  null, "NEEDS_INFO", "AIRPORT_ONLY", "LANDSIDE_AVAILABLE", "PLAN_SELECTED",
]);

/**
 * Place a session in the graph from its stored status (via the projection), its
 * certified record and the traveller's latest checkpoint.
 *
 * The projection is the starting point and is refined only by a fact the
 * traveller entered:
 *   - LANDSIDE_EXIT is the latest report and the projection has them at the
 *     airport, unescalated → EXECUTING. They said they left. If the guard did
 *     not hold, that is `left_without_guard` — reported, never hidden by
 *     keeping them in AIRPORT_ONLY, which would tell somebody in the city that
 *     they are at the airport.
 *   - AIRPORT_REENTRY is the latest report and the session is live → AIRPORT_
 *     REENTERED. They said they are back.
 *   - a cautionary gate (projection `null`) is EVALUATING with its guard unmet:
 *     never LANDSIDE_AVAILABLE, never AIRPORT_ONLY.
 * Escalation is never undone by a LANDSIDE_EXIT: RETURN_SOON / RETURN_NOW stay.
 */
export function lifecycleStateFrom(args: {
  projectedState: LayoverState | null;
  record: LifecycleRecordView;
  hasLandsidePlan: boolean;
  latestCheckpoint: "LANDSIDE_EXIT" | "AIRPORT_REENTRY" | null;
}): LifecycleEvaluation {
  const ctx = guardContextFromRecord(args.record, args.hasLandsidePlan);
  const guardFailures = landsideAvailableGuard(ctx);
  const p = args.projectedState;
  const divergence: LifecycleEvaluation["divergence"] = [];
  let state: LayoverState = p ?? "EVALUATING";
  if (args.latestCheckpoint === "LANDSIDE_EXIT" && AT_AIRPORT_UNESCALATED.has(p)) {
    state = "EXECUTING";
    if (guardFailures.length > 0) divergence.push("left_without_guard");
  }
  if (args.latestCheckpoint === "AIRPORT_REENTRY" && (p === null || !isTerminalState(p))) state = "AIRPORT_REENTERED";
  // The graph's guard and the projection's gate are two readings of one rule,
  // compared only where the projection took a landside branch: escalation and
  // terminal states are not a landside answer.
  const projectedOpen = p === "LANDSIDE_AVAILABLE" || p === "PLAN_SELECTED";
  const gateOpen = landsideStatusOf({ landsideGate: args.record.landsideGate, verdict: args.record.verdict }) === "open";
  if (AT_AIRPORT_UNESCALATED.has(p) && (guardFailures.length === 0) !== (projectedOpen && gateOpen)) {
    divergence.push("guard_vs_gate");
  }
  return {
    state,
    guardFailures,
    intents: INTENTS_ON_ENTRY[state] ?? [],
    availableEvents: isTerminalState(state) ? [] : availableEvents(state, ctx),
    projectedState: p,
    divergence,
  };
}
