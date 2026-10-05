/**
 * LayoverConstraints — the declared constraint set, the landside hard gate and
 * the lifecycle state they decide. Pure: no clock, no I/O.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §4    `layover_constraints` (baggage_mode, baggage_recheck_required,
 *         airport_change_required, entry_permission_state, critical_unknowns)
 *   §4.1  `BaggageMode`, `EntryPermissionState`, `LayoverState`
 *   §5    `EVALUATING → LANDSIDE_AVAILABLE`: entry allowed; critical unknowns
 *         empty; usable time ≥ floor; return contract satisfiable
 *   §6.1  the two hard invariants that forbid landside recommendations
 *   §12.1 value of information — ask only when the answer can change the verdict
 *   App B.2 "Unknown baggage blocks landside plan"
 *
 * WHAT WAS WRONG (census L22, L35, L48, L49, L77, L229, L230)
 * ==========================================================
 * The engine read `layover_sessions.checked_bags BOOLEAN`. A traveller who did
 * not know whether their bag was tagged through was recorded as having no
 * checked bags — the optimistic reading of the one fact §12.1 calls decisive.
 * The table that can hold the four-way answer (`layover_constraints`, migration
 * 2992) had no writer and no reader. Nothing forbade landside on a critical
 * unknown, and `entry_unverified` was deliberately left open because every
 * corridor is uncurated (census §45.3).
 *
 * WHAT THIS MODULE DECIDES, AND WHAT IT LEAVES TO THE OWNER
 * ========================================================
 * Decided here, because the spec states it and only a traveller's own explicit
 * "not sure" can trigger it:
 *   - a declared baggage mode replaces the boolean in the arithmetic;
 *   - UNKNOWN baggage is charged as the cautious case (collect and re-check);
 *   - when the answer could change the verdict, confidence is INSUFFICIENT,
 *     landside is closed, and exactly one question is asked;
 *   - an airport change closes landside exploration.
 *
 * NOT decided here: whether an UNCONFIRMED entry corridor forbids landside.
 * That is the other §6.1 invariant, and on this tree it would close landside
 * for every traveller, because `entry_requirements` has no curated row. The
 * mechanism is built and takes the answer as a named input
 * (`policy.entryForbidsLandside`), fed from the flag
 * `layover_entry_forbid_landside_enabled`, seeded FALSE by migration 3640.
 *
 * THE GATE CAN ONLY WITHHOLD
 * ==========================
 * `gateLandside` never returns a more permissive verdict than the one it was
 * handed: it either returns it untouched or replaces it with `no`. Swept in
 * `src/test/layoverConstraintGate.test.ts`.
 *
 * THE LEGACY ARM IS BYTE-IDENTICAL
 * ================================
 * A session with no declared set and no policy contributes NO key to
 * `FeasibilityInputs`, so its input hash, deadline, verdict, reasons and codes
 * are what they were before this module existed. `LAYOVER_FEASIBILITY_VERSION`
 * moved to 2026.10.04-1 because the record gained `landsideGate`; its history
 * entry lives here rather than in LayoverFeasibility.ts, whose lines are
 * citation-anchored:
 *   2026.10.04-1  §4/§6.1: `constraints` and `policy` become optional named
 *                 inputs; the record publishes `landsideGate`.
 */
import type { EntryEligibility } from "./layoverEntryGate.js";
import {
  adviseLeaving,
  computeWindow,
  type LayoverReasonCode,
  type LayoverReturnState,
  type LayoverWindow,
  type LeaveAdvice,
} from "./LayoverSafetyEngine.js";
import type { FeasibilityInputs } from "./LayoverFeasibility.js";

// ── vocabularies (the CHECKs in migration 2992, spelled once) ─────────────────

/** §4.1 `BaggageMode`. Matches `layover_constraints.baggage_mode`'s CHECK. */
export const BAGGAGE_MODES = ["CHECKED_THROUGH", "COLLECT_RECHECK", "CARRY_ON_ONLY", "UNKNOWN"] as const;
export type BaggageMode = (typeof BAGGAGE_MODES)[number];

export function isBaggageMode(v: unknown): v is BaggageMode {
  return typeof v === "string" && (BAGGAGE_MODES as readonly string[]).includes(v);
}

/** §4.1 `EntryPermissionState`. Matches `layover_constraints.entry_permission_state`. */
export const ENTRY_PERMISSION_STATES = ["CONFIRMED_ALLOWED", "CONFIRMED_NOT_ALLOWED", "UNKNOWN"] as const;
export type EntryPermissionState = (typeof ENTRY_PERMISSION_STATES)[number];

/**
 * The entry gate's answer in the spec's vocabulary. `null`/absent is UNKNOWN,
 * never allowed — the same reading `adviseLeaving` takes.
 */
export function entryPermissionStateOf(entry: EntryEligibility | null | undefined): EntryPermissionState {
  if (!entry) return "UNKNOWN";
  if (entry.state === "permitted") return "CONFIRMED_ALLOWED";
  if (entry.state === "refused") return "CONFIRMED_NOT_ALLOWED";
  return "UNKNOWN";
}

/**
 * Does this baggage mode cost bag time?
 *
 *   CARRY_ON_ONLY    nothing to claim, nothing to drop.
 *   CHECKED_THROUGH  the airline moves the bag; the traveller does neither.
 *   COLLECT_RECHECK  claim on arrival and re-drop before the next flight.
 *   UNKNOWN          charged as COLLECT_RECHECK. An unknown is never read in
 *                    the traveller's favour (§2.1, App C1).
 *
 * The engine has exactly two bag terms and both key on one boolean
 * (`estimateExitDelay`'s claim minutes, `computeBuffer`'s `bagsExtra`), so this
 * is the whole mapping.
 */
export function baggageChargesBags(mode: BaggageMode): boolean {
  return mode === "COLLECT_RECHECK" || mode === "UNKNOWN";
}

// ── the declared set, and how a session carries it ───────────────────────────

/** One version of what the traveller declared. Immutable once written. */
export interface LayoverConstraintSet {
  /** Monotonic per session, from 1. */
  version: number;
  baggageMode: BaggageMode;
  /**
   * Separate tickets / self-transfer: the traveller checks in again.
   * `null` = not stated.
   */
  recheckRequired: boolean | null;
  /** The next flight leaves from a different airport. `null` = not stated. */
  airportChangeRequired: boolean | null;
  /** When this version was declared (ISO), when the store says. */
  declaredAt?: string | null;
}

/**
 * How the declared set was read for a session.
 *
 *   declared     a row exists; `set` is it.
 *   undeclared   the store was read and holds nothing for this session.
 *   unreadable   the store could not be read. NOT "undeclared": the traveller
 *                may have said UNKNOWN and we cannot see it, so the engine
 *                takes the cautious case.
 *   storage_off  `layover_constraints_enabled` is off; nothing was read.
 */
export type ConstraintReadState = "declared" | "undeclared" | "unreadable" | "storage_off";

/**
 * What a loaded session carries. Attached by the session loaders
 * (`LayoverSessionService`), so every certification site receives it without
 * naming it — a call site cannot forget it the way one could forget `entry`.
 */
export interface SessionConstraintContext {
  read: ConstraintReadState;
  /** Non-null exactly when `read === "declared"`. */
  set: LayoverConstraintSet | null;
  /** The owner's answer to §6.1's entry invariant. FALSE unless the flag is on. */
  entryForbidsLandside: boolean;
}

// ── named inputs of the certified record ──────────────────────────────────────

/** The constraint facts the arithmetic reads. Part of `inputHash`. */
export interface ConstraintInput {
  read: "declared" | "unreadable";
  /** `null` when unreadable — there is no version to name. */
  version: number | null;
  baggageMode: BaggageMode;
  recheckRequired: boolean | null;
  airportChangeRequired: boolean | null;
}

/** Present in the inputs only when the policy is ON. */
export interface LandsidePolicyInput {
  entryForbidsLandside: true;
}

/**
 * Project a session's context onto the named inputs.
 *
 * Returns ONLY the keys that carry something. `undeclared`, `storage_off` and
 * an absent context contribute nothing, which is what keeps the legacy arm's
 * input hash unchanged.
 */
export function namedConstraintInputs(
  ctx: SessionConstraintContext | null | undefined,
): { constraints?: ConstraintInput; policy?: LandsidePolicyInput } {
  if (!ctx) return {};
  const out: { constraints?: ConstraintInput; policy?: LandsidePolicyInput } = {};
  if (ctx.read === "declared" && ctx.set) {
    out.constraints = {
      read: "declared",
      version: ctx.set.version,
      baggageMode: ctx.set.baggageMode,
      recheckRequired: ctx.set.recheckRequired,
      airportChangeRequired: ctx.set.airportChangeRequired,
    };
  } else if (ctx.read === "unreadable") {
    out.constraints = {
      read: "unreadable",
      version: null,
      baggageMode: "UNKNOWN",
      recheckRequired: null,
      airportChangeRequired: null,
    };
  }
  if (ctx.entryForbidsLandside === true) out.policy = { entryForbidsLandside: true };
  return out;
}

/**
 * The session the ENGINE computes with: the stored booleans, with the bag term
 * replaced by the declared mode when there is one.
 *
 * With no constraint input this is the session itself, untouched.
 */
export function engineSession<S extends { checkedBags: boolean }>(
  session: S,
  constraints: ConstraintInput | undefined,
): S {
  if (!constraints) return session;
  const checkedBags = baggageChargesBags(constraints.baggageMode);
  return session.checkedBags === checkedBags ? session : { ...session, checkedBags };
}

// ── the landside gate ────────────────────────────────────────────────────────

/**
 * Why landside is closed. Its own vocabulary: Appendix A reason codes are
 * published separately on the record, and two of these (`insufficient_time`,
 * `traveller_staying_airside`) are not Appendix A facts at all.
 */
export const LANDSIDE_CLOSURES = [
  "traveller_staying_airside",
  "insufficient_time",
  "entry_refused",
  "entry_unconfirmed",
  "baggage_unknown",
  "airport_change",
] as const;
export type LandsideClosure = (typeof LANDSIDE_CLOSURES)[number];

/** §5's guard, evaluated. Published on every certified record. */
export interface LandsideGate {
  /** May this traveller be offered anything outside the airport? */
  open: boolean;
  /** Every reason it is closed. Empty exactly when `open`. */
  closedBy: LandsideClosure[];
  /**
   * §12.1: the ONE field whose answer could change this verdict, or null. Null
   * when nothing is unknown, and null when the unknown cannot matter.
   */
  needsInfo: "baggageMode" | null;
  /** §4 `critical_unknowns`: the safety-critical facts that are unknown. */
  criticalUnknowns: string[];
  entryPermissionState: EntryPermissionState;
  /** How the constraint set reached this computation. `legacy` = none did. */
  constraintsRead: "declared" | "unreadable" | "legacy";
  constraintsVersion: number | null;
  /** The policy this gate was evaluated under. */
  entryForbidsLandside: boolean;
}

/** Said when a declared UNKNOWN (or an unreadable store) decides the verdict. */
export const BAGGAGE_DECISIVE_REASON =
  "Whether your checked bag is tagged through to your final destination changes this answer, so we won't say it's safe to leave until you tell us.";

/** The `unknowns` line when baggage is unknown, decisive or not. */
export const BAGGAGE_UNKNOWN_UNKNOWN =
  "Whether your checked bags are tagged through — we have counted the time to collect and re-check them";

/** The `unknowns` line when the declared set could not be read. */
export const CONSTRAINTS_UNREADABLE_UNKNOWN =
  "Your bag and connection details could not be read just now, so the cautious case is assumed";

/** Said when the store is unreadable AND the unread answer would decide the verdict. */
export const CONSTRAINTS_UNREADABLE_REASON =
  "We couldn't read your bag details just now, and they change this answer. Try again shortly before deciding to leave.";

export const AIRPORT_CHANGE_REASON =
  "Your next flight leaves from a different airport. Getting there comes first, so we won't suggest side trips for this layover.";

export const ENTRY_POLICY_REASON =
  "Until entry to this country is confirmed for your passport, we won't suggest leaving the airport.";

export const COLLECT_RECHECK_REASON =
  "You collect and re-check your bags, so claim and bag-drop time are counted.";

export const SELF_TRANSFER_REASON =
  "Separate tickets: you check in again, and the airline will not hold or rebook a missed connection.";

export const SELF_TRANSFER_UNKNOWN =
  "The check-in cutoff for your onward flight — we do not hold it";

/**
 * `adviseLeaving`'s sentence for the boolean ("Checked bags: confirm they're
 * tagged through to your next flight."). It asks a question a declared mode has
 * already answered, so it is dropped when the traveller said COLLECT_RECHECK.
 * Matched by prefix; a test pins the engine's sentence against this constant.
 */
export const LEGACY_CHECKED_BAGS_REASON_PREFIX = "Checked bags:";

function withCode(codes: LayoverReasonCode[], code: LayoverReasonCode): LayoverReasonCode[] {
  return codes.includes(code) ? codes : [...codes, code];
}

function withLine(lines: string[], line: string): string[] {
  return lines.includes(line) ? lines : [...lines, line];
}

/**
 * Apply the declared constraints and the entry policy to the clock's advice.
 *
 * `base` is `adviseLeaving`'s answer for the ENGINE session (so its minutes
 * already charge bags for COLLECT_RECHECK and UNKNOWN). This function never
 * recomputes a deadline; the one extra computation it makes is §12.1's
 * value-of-information probe — the verdict the traveller would get if the
 * unknown bag turned out not to need collecting.
 */
export function gateLandside(
  inputs: FeasibilityInputs,
  envelope: LayoverWindow,
  base: LeaveAdvice,
): { advice: LeaveAdvice; gate: LandsideGate; insufficient: boolean } {
  const c = inputs.constraints;
  const entryForbidsLandside = inputs.policy?.entryForbidsLandside === true;
  const entryState = entryPermissionStateOf(inputs.entry);

  const closedBy: LandsideClosure[] = [];
  let reasons = base.reasons;
  let unknowns = base.unknowns;
  let reasonCodes = base.reasonCodes;
  let needsInfo: LandsideGate["needsInfo"] = null;
  const criticalUnknowns: string[] = [];

  // ── what the clock and the border already said ────────────────────────────
  if (base.verdict === "stay_airside") closedBy.push("traveller_staying_airside");
  if (base.verdict === "no") {
    closedBy.push(inputs.entry?.state === "refused" ? "entry_refused" : "insufficient_time");
  }
  const staying = base.verdict === "stay_airside";

  // ── the declared set ───────────────────────────────────────────────────────
  if (c) {
    if (c.read === "unreadable") unknowns = withLine(unknowns, CONSTRAINTS_UNREADABLE_UNKNOWN);

    if (c.baggageMode === "COLLECT_RECHECK") {
      reasons = reasons.filter((r) => !r.startsWith(LEGACY_CHECKED_BAGS_REASON_PREFIX));
      reasons = withLine(reasons, COLLECT_RECHECK_REASON);
    }
    if (c.baggageMode === "COLLECT_RECHECK" || c.recheckRequired === true) {
      reasonCodes = withCode(reasonCodes, "SELF_TRANSFER_FRICTION");
    }
    if (c.recheckRequired === true) {
      reasons = withLine(reasons, SELF_TRANSFER_REASON);
      unknowns = withLine(unknowns, SELF_TRANSFER_UNKNOWN);
    }

    if (c.airportChangeRequired === true) {
      reasonCodes = withCode(reasonCodes, "AIRPORT_CHANGE_REQUIRED");
      if (!staying) {
        closedBy.push("airport_change");
        reasons = withLine(reasons, AIRPORT_CHANGE_REASON);
      }
    }
  }

  // ── §6.1 invariant 1, under the owner's policy ────────────────────────────
  if (entryForbidsLandside && entryState === "UNKNOWN" && !staying) {
    closedBy.push("entry_unconfirmed");
    reasons = withLine(reasons, ENTRY_POLICY_REASON);
  }

  // ── §6.1 invariant 2 / §12.1 / App B.2: an unknown that decides ───────────
  if (c && c.baggageMode === "UNKNOWN") {
    if (c.read === "declared") unknowns = withLine(unknowns, BAGGAGE_UNKNOWN_UNKNOWN);
    // The verdict if the bag needed nothing from the traveller. Same airport,
    // same instant, same live conditions, same border — one fact different.
    const best = { ...inputs.session, checkedBags: false };
    const bestWindow = computeWindow(inputs.airport, best, inputs.nowMs, inputs.liveConditions);
    const bestVerdict = adviseLeaving(inputs.airport, best, bestWindow, {
      travelTimeSource: inputs.landsideProbe?.travelTimeSource,
      liveConditions: inputs.liveConditions,
      entry: inputs.entry,
    }).verdict;
    if (bestVerdict !== base.verdict) {
      criticalUnknowns.push("baggage_mode");
      reasonCodes = withCode(reasonCodes, "BAGGAGE_STATUS_CRITICAL_UNKNOWN");
      closedBy.push("baggage_unknown");
      // A QUESTION ONLY WHEN THE TRAVELLER HAS NOT ANSWERED. An unreadable store
      // may be holding their answer already; asking again would be asking them
      // to repair our outage, and the honest instruction is to retry.
      const sentence = c.read === "declared" ? BAGGAGE_DECISIVE_REASON : CONSTRAINTS_UNREADABLE_REASON;
      if (c.read === "declared") needsInfo = "baggageMode";
      // LAST, deliberately: `certifyFeasibility` takes the final reason as the
      // sentence that explains a capped rating, and this is the one closure the
      // traveller can lift with a single answer.
      reasons = [...reasons.filter((r) => r !== sentence), sentence];
    }
  }

  const constraintClosed = closedBy.some(
    (x) => x === "airport_change" || x === "entry_unconfirmed" || x === "baggage_unknown",
  );
  const gate: LandsideGate = {
    open: closedBy.length === 0,
    closedBy,
    needsInfo,
    criticalUnknowns,
    entryPermissionState: entryState,
    constraintsRead: c ? c.read : "legacy",
    constraintsVersion: c ? c.version : null,
    entryForbidsLandside,
  };
  void envelope; // the window is the caller's; nothing here re-derives from it

  const untouched = reasons === base.reasons && unknowns === base.unknowns && reasonCodes === base.reasonCodes;
  if (!constraintClosed && untouched) return { advice: base, gate, insufficient: false };
  return {
    advice: {
      ...base,
      // ONLY EVER A WITHDRAWAL: `no` stays `no`, everything else becomes `no`.
      // `stay_airside` — the traveller's own answer — never reaches this arm:
      // each of the three constraint closures is pushed under `!staying` (or,
      // for the bag question, cannot be decisive when the answer is "staying"
      // either way), so there is no second `!staying` here to keep in step.
      verdict: constraintClosed ? "no" : base.verdict,
      reasons,
      unknowns,
      reasonCodes,
    },
    gate,
    insufficient: criticalUnknowns.length > 0,
  };
}

/** The question §12.1 allows, for the field the gate names. */
export function constraintQuestion(gate: LandsideGate): {
  field: "baggageMode";
  prompt: string;
  options: Array<{ value: BaggageMode; label: string }>;
} | null {
  if (gate.needsInfo !== "baggageMode") return null;
  return {
    field: "baggageMode",
    prompt: "Is your checked bag tagged through to your final destination?",
    options: [
      { value: "CHECKED_THROUGH", label: "Yes — tagged through" },
      { value: "COLLECT_RECHECK", label: "No — I collect and re-check it" },
      { value: "CARRY_ON_ONLY", label: "I only have carry-on" },
    ],
  };
}

// ── §4.1 / §5 LayoverState ────────────────────────────────────────────────────

export const LAYOVER_STATES = [
  "DETECTED", "NEEDS_INFO", "EVALUATING", "AIRPORT_ONLY",
  "LANDSIDE_AVAILABLE", "PLAN_SELECTED", "EXECUTING",
  "RETURN_SOON", "RETURN_NOW", "RETURNING",
  "AIRPORT_REENTERED", "BOARDING", "COMPLETED",
  "DISRUPTED", "CANCELLED", "ABANDONED", "EXPIRED",
] as const;
export type LayoverState = (typeof LAYOVER_STATES)[number];

/**
 * Which of the seventeen this tree can decide from facts it holds, and what
 * each of the others is waiting for. A state missing from `derivable` is never
 * returned by `deriveLayoverState` — it is not approximated.
 */
export const LAYOVER_STATE_SOURCES: Record<LayoverState, { derivable: boolean; from: string }> = {
  DETECTED:           { derivable: false, from: "no connection detector exists; sessions are created by the traveller" },
  NEEDS_INFO:         { derivable: true,  from: "landsideGate.needsInfo" },
  EVALUATING:         { derivable: false, from: "transient: it is the certification itself and is never observed at rest" },
  AIRPORT_ONLY:       { derivable: true,  from: "landsideGate closed" },
  LANDSIDE_AVAILABLE: { derivable: true,  from: "landsideGate open, no landside stop planned" },
  PLAN_SELECTED:      { derivable: true,  from: "landsideGate open and a landside stop is planned" },
  EXECUTING:          { derivable: false, from: "needs an airport-exit checkpoint (layover_checkpoints has no writer)" },
  RETURN_SOON:        { derivable: true,  from: "certified returnState" },
  RETURN_NOW:         { derivable: true,  from: "certified returnState (RETURN_NOW or CONNECTION_AT_RISK)" },
  RETURNING:          { derivable: true,  from: "layover_sessions.status = 'returning'" },
  AIRPORT_REENTERED:  { derivable: false, from: "needs a re-entry checkpoint" },
  BOARDING:           { derivable: false, from: "needs a boarding checkpoint or a flight feed" },
  COMPLETED:          { derivable: true,  from: "layover_sessions.status = 'completed'" },
  DISRUPTED:          { derivable: false, from: "published by POST /disruption's own state machine, not folded into this projection" },
  CANCELLED:          { derivable: true,  from: "layover_sessions.status = 'cancelled'" },
  ABANDONED:          { derivable: false, from: "no producer distinguishes abandonment from cancellation" },
  EXPIRED:            { derivable: true,  from: "layover_sessions.status = 'expired'" },
};

/**
 * Project the stored status and the certified record onto §4.1's state.
 *
 * A PROJECTION, NOT A STORE: nothing here records a transition. It exists so
 * the guard `EVALUATING → LANDSIDE_AVAILABLE` has one implementation that every
 * surface reads, and so NEEDS_INFO is a state rather than a sentence.
 */
export function deriveLayoverState(args: {
  status: "active" | "returning" | "completed" | "cancelled" | "expired";
  gate: LandsideGate;
  returnState: LayoverReturnState;
  /** A stop outside the airport is on the plan. */
  hasLandsidePlan: boolean;
  /**
   * The certified envelope has (or had) a landside window at all —
   * `record.envelope.freedomWindow !== null`. A layover that never had one
   * (§7.2's temporal conflict) cannot have a traveller out in the city.
   */
  hadLandsideWindow: boolean;
}): LayoverState {
  switch (args.status) {
    case "completed": return "COMPLETED";
    case "cancelled": return "CANCELLED";
    case "expired":   return "EXPIRED";
    case "returning": return "RETURNING";
    case "active":    break;
    default: {
      const _exhaustive: never = args.status;
      return "EXPIRED";
    }
  }

  // A traveller who may be OUT is escalated before anything else. Once the hard
  // return has passed the usable window is zero, so the gate is closed by
  // `insufficient_time` — and reading that as AIRPORT_ONLY would tell somebody
  // in a taxi that they are at the airport. Escalation is withheld only when
  // something other than the clock says they are not out: they said they are
  // staying, a constraint closed landside, or there was never a window to be
  // out in (a too-short layover is already past its "deadline" on arrival).
  const escalated = args.returnState !== "NORMAL";
  const clockOnly = args.gate.closedBy.every((x) => x === "insufficient_time");
  if (escalated && (args.hasLandsidePlan || (clockOnly && args.hadLandsideWindow))) {
    return args.returnState === "RETURN_SOON" ? "RETURN_SOON" : "RETURN_NOW";
  }
  if (args.gate.needsInfo) return "NEEDS_INFO";
  if (!args.gate.open) return "AIRPORT_ONLY";
  return args.hasLandsidePlan ? "PLAN_SELECTED" : "LANDSIDE_AVAILABLE";
}

/** `deriveLayoverState`, read off a certified record. The form every route uses. */
export function layoverStateOf(
  record: { landsideGate: LandsideGate; envelope: Pick<LayoverWindow, "returnState" | "freedomWindow"> },
  status: "active" | "returning" | "completed" | "cancelled" | "expired",
  hasLandsidePlan: boolean,
): LayoverState {
  return deriveLayoverState({
    status,
    gate: record.landsideGate,
    returnState: record.envelope.returnState,
    hasLandsidePlan,
    hadLandsideWindow: record.envelope.freedomWindow !== null,
  });
}

// ── the write boundary ────────────────────────────────────────────────────────

/** What a traveller may declare. Every member optional; at least one required. */
export interface ConstraintPatch {
  baggageMode?: BaggageMode;
  recheckRequired?: boolean | null;
  airportChangeRequired?: boolean | null;
}

export const DECLARABLE_FIELDS = ["baggageMode", "recheckRequired", "airportChangeRequired"] as const;
export type DeclarableField = (typeof DECLARABLE_FIELDS)[number];

/** Does the patch state anything at all? */
export function patchStatesAnything(patch: ConstraintPatch): boolean {
  return DECLARABLE_FIELDS.some((f) => patch[f] !== undefined);
}

/**
 * The next version: the latest declared set with the patch laid over it.
 *
 * A first declaration that does not name a baggage mode is UNKNOWN, not
 * carry-on: the traveller has not said, and the booleans on the session are
 * not a statement about through-checking.
 */
export function nextConstraintSet(
  latest: LayoverConstraintSet | null,
  patch: ConstraintPatch,
): LayoverConstraintSet {
  const from = latest ?? { version: 0, baggageMode: "UNKNOWN" as BaggageMode, recheckRequired: null, airportChangeRequired: null };
  return {
    version: from.version + 1,
    baggageMode: patch.baggageMode ?? from.baggageMode,
    recheckRequired: patch.recheckRequired !== undefined ? patch.recheckRequired : from.recheckRequired,
    airportChangeRequired:
      patch.airportChangeRequired !== undefined ? patch.airportChangeRequired : from.airportChangeRequired,
  };
}
