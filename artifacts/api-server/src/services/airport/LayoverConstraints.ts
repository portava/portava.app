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
 * THE GATE FAILS CLOSED (2026-10-06, after PR #588's verification returned FAIL)
 * ============================================================================
 * `open` used to mean "nothing closed it", which made every state the engine
 * could not vouch for an open gate: an unconfirmed border, a tight window, a
 * constraint store that could not be read, a traveller who answered "not
 * sure". It now means ONE thing — the verdict is `yes` (entry CONFIRMED_ALLOWED,
 * the window not tight, no critical unknown) — and the gate is three-valued:
 *
 *   open     verdict `yes`. The only status a surface may draw as an affirmative.
 *   caution  nothing FORBIDS landside, and nothing confirms it either
 *            (`cautions`: an unconfirmed border under the owner's policy OFF, a
 *            tight window). Never LANDSIDE_AVAILABLE, never a green "fits".
 *   closed   `closedBy` is non-empty and the verdict is `no` / `stay_airside`.
 *
 * Unknown, unreadable and undeclared inputs are closures, each with its own
 * name: `constraints_unreadable`, `airport_change_unknown`, `recheck_unknown`,
 * `baggage_unknown`. `src/test/layoverGateFailClosed.test.ts` holds the sweep.
 *
 * THE LEGACY ARM KEEPS ITS VERDICT, DEADLINE, REASONS AND CODES
 * =============================================================
 * A session with no constraint context (both flags off) contributes NO key to
 * `FeasibilityInputs`, so its deadline, verdict, reasons and codes are what
 * they were before this module existed. Its `inputHash` is NOT what it was:
 * `feasibilityVersion` is a member of the hashed inputs and has moved twice.
 * History, kept here rather than in LayoverFeasibility.ts, whose lines are
 * citation-anchored:
 *   2026.10.04-1  §4/§6.1: `constraints` and `policy` become optional named
 *                 inputs; the record publishes `landsideGate`.
 *   2026.10.06-1  the gate gains `status` / `cautions` and `open` narrows to
 *                 the verdict `yes`; `constraints.read` may be `undeclared`;
 *                 separate tickets (`recheckRequired` true or not stated) are
 *                 charged the collect-and-re-check bag terms.
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
import { planFitTotals, planFitVerdict, type PlanFitStop, type PlanFitVerdict } from "./LayoverPlanFit.js";

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
 *   undeclared   the store was read and holds nothing for this session. NOT a
 *                legacy pass: declarations are being kept, this traveller has
 *                made none, so whether they change airports is UNKNOWN.
 *   unreadable   the store — or either flag that governs it — could not be
 *                read. NOT "undeclared": the traveller may have said UNKNOWN,
 *                or "yes, a different airport", and we cannot see it. The gate
 *                closes (`constraints_unreadable`).
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
  read: "declared" | "undeclared" | "unreadable";
  /** `null` when undeclared or unreadable — there is no version to name. */
  version: number | null;
  /**
   * `null` ONLY when `read === "undeclared"`: nothing four-way was declared, so
   * the session's own `checkedBags` boolean stands. An unreadable store is
   * UNKNOWN, never null — an answer may exist that we cannot see.
   */
  baggageMode: BaggageMode | null;
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
 * Returns ONLY the keys that carry something. `storage_off` and an absent
 * context contribute nothing: with storage off there is nowhere a declaration
 * could have been kept, so the session's booleans are all there is.
 *
 * `undeclared` DOES contribute (it did not before 2026-10-06). The store is on
 * and was read, and this traveller has declared nothing — which is the same
 * unknown as a declared "not sure", and was being certified as a declared
 * "no". It carries no baggage mode, so the bag term stays the session's own.
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
  } else if (ctx.read === "undeclared") {
    out.constraints = {
      read: "undeclared",
      version: null,
      baggageMode: null,
      recheckRequired: null,
      airportChangeRequired: null,
    };
  }
  if (ctx.entryForbidsLandside === true) out.policy = { entryForbidsLandside: true };
  return out;
}

/**
 * Does the ticketing answer cost the re-check time?
 *
 *   true   separate tickets: the traveller checks in again.
 *   false  one ticket. Nothing extra.
 *   null   not stated. Charged, like UNKNOWN baggage: an unknown is never read
 *          in the traveller's favour (§2.1, App C1).
 */
export function recheckChargesBags(recheckRequired: boolean | null): boolean {
  return recheckRequired !== false;
}

/**
 * Are the engine's two bag terms charged for this constraint input?
 *
 * §21.1 "5h self-transfer → recheck friction included" names no number, and the
 * engine has exactly two bag terms keyed on one boolean — the claim minutes in
 * `estimateExitDelay` and the airport's `checkedBagsExtraMin` in the return
 * buffer. A self-transfer is charged THOSE: the same constants collect-and-
 * re-check already uses, and no new figure. (Whether a dedicated check-in-
 * cutoff term should replace them is an owner question; this is the
 * conservative reading until there is one.)
 *
 * `baggageMode === null` (undeclared) leaves the bag half to `sessionBoolean`.
 */
export function constraintsChargeBags(c: ConstraintInput, sessionBoolean: boolean): boolean {
  const bags = c.baggageMode === null ? sessionBoolean : baggageChargesBags(c.baggageMode);
  return bags || recheckChargesBags(c.recheckRequired);
}

/**
 * The session the ENGINE computes with: the stored booleans, with the bag term
 * replaced by what the constraint input charges when there is one.
 *
 * With no constraint input this is the session itself, untouched.
 */
export function engineSession<S extends { checkedBags: boolean }>(
  session: S,
  constraints: ConstraintInput | undefined,
): S {
  if (!constraints) return session;
  const checkedBags = constraintsChargeBags(constraints, session.checkedBags);
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
  // 2026-10-06 — the three ways an input can be UNKNOWN rather than refused.
  /** The declared set, or a flag that governs it, could not be read. */
  "constraints_unreadable",
  /** Whether the next flight leaves from another airport is not stated. */
  "airport_change_unknown",
  /** Whether the flights are on separate tickets is not stated, and it decides. */
  "recheck_unknown",
] as const;
export type LandsideClosure = (typeof LANDSIDE_CLOSURES)[number];

/**
 * Why a gate that nothing CLOSED is still not open.
 *
 *   entry_unconfirmed  the border could not be confirmed and the owner's
 *                      forbid-landside policy is OFF. (With it ON this is a
 *                      closure of the same name.)
 *   tight_window       45–89 usable minutes: `adviseLeaving`'s `tight`.
 */
export const LANDSIDE_CAUTIONS = ["entry_unconfirmed", "tight_window"] as const;
export type LandsideCaution = (typeof LANDSIDE_CAUTIONS)[number];

/** The gate, as the one word every surface branches on. */
export type LandsideStatus = "open" | "caution" | "closed";

/** The declarable field a question may be asked about. */
export type ConstraintQuestionField = "airportChangeRequired" | "baggageMode" | "recheckRequired";

/** §5's guard, evaluated. Published on every certified record. */
export interface LandsideGate {
  /**
   * May this traveller be TOLD they can leave the airport? TRUE exactly when
   * the verdict is `yes` — `status === "open"`. It is NOT "nothing closed it":
   * a gate with an empty `closedBy` and a caution is not open.
   */
  open: boolean;
  /** `open` | `caution` | `closed`. The field to branch on. */
  status: LandsideStatus;
  /** Every reason it is closed. Non-empty exactly when `status === "closed"`. */
  closedBy: LandsideClosure[];
  /** Why it is not open although nothing closed it. Empty unless `caution`. */
  cautions: LandsideCaution[];
  /**
   * §12.1: the ONE field whose answer could change this verdict, or null. Null
   * when nothing is unknown, and null when the unknown cannot matter.
   */
  needsInfo: ConstraintQuestionField | null;
  /** §4 `critical_unknowns`: the safety-critical facts that are unknown. */
  criticalUnknowns: string[];
  entryPermissionState: EntryPermissionState;
  /** How the constraint set reached this computation. `legacy` = none did. */
  constraintsRead: "declared" | "undeclared" | "unreadable" | "legacy";
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

/** Said when the store is unreadable and leaving was otherwise on the table. */
export const CONSTRAINTS_UNREADABLE_REASON =
  "We couldn't read your bag and connection details just now, and they change this answer. Try again shortly before deciding to leave.";

/** The `unknowns` line when the airport change is not stated. */
export const AIRPORT_CHANGE_UNKNOWN_UNKNOWN =
  "Whether your next flight leaves from this airport or a different one";

/** Said when "not sure" about an airport change is what closes landside. */
export const AIRPORT_CHANGE_UNKNOWN_REASON =
  "If your next flight leaves from a different airport, getting there comes first — so we won't say it's safe to leave until you confirm which airport you fly out of.";

/** The `unknowns` line when separate tickets are not stated. */
export const RECHECK_UNKNOWN_UNKNOWN =
  "Whether your flights are on separate tickets — we have counted the time to check in again";

/** Said when "not sure" about separate tickets decides the verdict. */
export const RECHECK_DECISIVE_REASON =
  "Whether your flights are on separate tickets changes this answer — you would have to check in again — so we won't say it's safe to leave until you tell us.";

export const AIRPORT_CHANGE_REASON =
  "Your next flight leaves from a different airport. Getting there comes first, so we won't suggest side trips for this layover.";

export const ENTRY_POLICY_REASON =
  "Until entry to this country is confirmed for your passport, we won't suggest leaving the airport.";

export const COLLECT_RECHECK_REASON =
  "You collect and re-check your bags, so claim and bag-drop time are counted.";

export const SELF_TRANSFER_REASON =
  "Separate tickets: you check in again, so that time is counted — and the airline will not hold or rebook a missed connection.";

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
 * already charge bags for COLLECT_RECHECK, UNKNOWN and separate tickets). This
 * function never recomputes a deadline; the one extra computation it makes is
 * §12.1's value-of-information probe — the verdict the traveller would get if
 * every unknown that was charged turned out to cost nothing.
 *
 * ── WHAT CLOSES, AND WHEN ────────────────────────────────────────────────────
 *   constraints_unreadable   ALWAYS, when the store or a flag could not be
 *                            read. Named even beside the clock's own refusal.
 *   airport_change           the traveller said yes.
 *   airport_change_unknown   not stated, and the verdict was otherwise not a
 *                            refusal — the answer "yes" would close landside,
 *                            so the unknown decides. ASKED.
 *   baggage_unknown /        not stated, charged as the cautious case, and the
 *   recheck_unknown          probe shows the charge flips the verdict. ASKED.
 *   entry_unconfirmed        the owner's policy is ON and the border is unknown.
 *
 * An unknown that CANNOT change the verdict (the traveller is staying, the
 * border refused, the clock already refused) is disclosed in `unknowns` and
 * asked about by nobody — §12.1.
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
  const criticalUnknowns: string[] = [];
  /** Every field whose answer would lift a closure, in no particular order. */
  const askable = new Set<ConstraintQuestionField>();
  /** The sentence that explains the closure the traveller can lift — placed LAST. */
  let decisiveReason: string | null = null;

  // ── what the clock and the border already said ────────────────────────────
  if (base.verdict === "stay_airside") closedBy.push("traveller_staying_airside");
  if (base.verdict === "no") {
    closedBy.push(inputs.entry?.state === "refused" ? "entry_refused" : "insufficient_time");
  }
  const staying = base.verdict === "stay_airside";
  /**
   * Could an answer still change this verdict? Not when the traveller is
   * staying (their own answer) and not when the clock or the border has
   * already refused: "yes, a different airport" on top of a `no` is still `no`.
   */
  const answerable = base.verdict !== "stay_airside" && base.verdict !== "no";

  // ── the declared set ───────────────────────────────────────────────────────
  if (c) {
    const unreadable = c.read === "unreadable";
    if (unreadable) {
      unknowns = withLine(unknowns, CONSTRAINTS_UNREADABLE_UNKNOWN);
      // NAMED WHENEVER IT IS TRUE. The unread set may hold "yes, a different
      // airport", so on any verdict that was not already a refusal it decides.
      closedBy.push("constraints_unreadable");
      if (answerable) {
        criticalUnknowns.push("constraints");
        decisiveReason = CONSTRAINTS_UNREADABLE_REASON;
      }
    }

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
    } else if (c.airportChangeRequired === null && !unreadable) {
      // "NOT SURE" IS NOT "NO". It used to be: this branch did not exist, and
      // the `=== true` test above read every unknown as the favourable answer.
      unknowns = withLine(unknowns, AIRPORT_CHANGE_UNKNOWN_UNKNOWN);
      if (answerable) {
        closedBy.push("airport_change_unknown");
        criticalUnknowns.push("airport_change_required");
        askable.add("airportChangeRequired");
      }
    }
  }

  // ── §6.1 invariant 1, under the owner's policy ────────────────────────────
  if (entryForbidsLandside && entryState === "UNKNOWN" && !staying) {
    closedBy.push("entry_unconfirmed");
    reasons = withLine(reasons, ENTRY_POLICY_REASON);
  }

  // ── §6.1 invariant 2 / §12.1 / App B.2: an unknown that decides ───────────
  if (c) {
    const unreadable = c.read === "unreadable";
    const bagsUnknown = c.baggageMode === "UNKNOWN";
    const recheckUnknown = c.recheckRequired === null;
    if (bagsUnknown && c.read === "declared") unknowns = withLine(unknowns, BAGGAGE_UNKNOWN_UNKNOWN);
    if (recheckUnknown && !unreadable) unknowns = withLine(unknowns, RECHECK_UNKNOWN_UNKNOWN);
    // Charged by a FACT the traveller stated? Then no unknown is behind the
    // bag terms and there is nothing to probe.
    const chargedByFact =
      c.baggageMode === "COLLECT_RECHECK" ||
      c.recheckRequired === true ||
      (c.baggageMode === null && inputs.session.checkedBags === true);
    if (!chargedByFact && (bagsUnknown || recheckUnknown)) {
      // The verdict if every charged unknown cost nothing. Same airport, same
      // instant, same live conditions, same border — one fact different.
      const best = { ...inputs.session, checkedBags: false };
      const bestWindow = computeWindow(inputs.airport, best, inputs.nowMs, inputs.liveConditions);
      const bestVerdict = adviseLeaving(inputs.airport, best, bestWindow, {
        travelTimeSource: inputs.landsideProbe?.travelTimeSource,
        liveConditions: inputs.liveConditions,
        entry: inputs.entry,
      }).verdict;
      if (bestVerdict !== base.verdict) {
        if (bagsUnknown) {
          criticalUnknowns.push("baggage_mode");
          reasonCodes = withCode(reasonCodes, "BAGGAGE_STATUS_CRITICAL_UNKNOWN");
          closedBy.push("baggage_unknown");
          // A QUESTION ONLY WHEN THE TRAVELLER HAS NOT ANSWERED. An unreadable
          // store may be holding their answer already; asking again would be
          // asking them to repair our outage, and the honest instruction is to
          // retry.
          if (!unreadable) askable.add("baggageMode");
        }
        if (recheckUnknown && !unreadable) {
          criticalUnknowns.push("recheck_required");
          closedBy.push("recheck_unknown");
          askable.add("recheckRequired");
        }
        if (unreadable) decisiveReason = CONSTRAINTS_UNREADABLE_REASON;
      }
    }
  }

  // ── §12.1: ONE question — the one whose answer decides the most ───────────
  // An airport change closes landside outright whatever the bags do, so it is
  // asked first; the bag mode moves both bag terms; the ticketing answer last.
  const needsInfo: LandsideGate["needsInfo"] =
    askable.has("airportChangeRequired") ? "airportChangeRequired"
    : askable.has("baggageMode") ? "baggageMode"
    : askable.has("recheckRequired") ? "recheckRequired"
    : null;
  if (needsInfo === "airportChangeRequired") decisiveReason = AIRPORT_CHANGE_UNKNOWN_REASON;
  else if (needsInfo === "baggageMode") decisiveReason = BAGGAGE_DECISIVE_REASON;
  else if (needsInfo === "recheckRequired") decisiveReason = RECHECK_DECISIVE_REASON;
  if (decisiveReason !== null) {
    // LAST, deliberately: `certifyFeasibility` takes the final reason as the
    // sentence that explains a capped rating, and this is the closure the
    // traveller (or a retry) can lift.
    const sentence = decisiveReason;
    reasons = [...reasons.filter((r) => r !== sentence), sentence];
  }

  const constraintClosed = closedBy.some((x) => CONSTRAINT_CLOSURES.has(x));
  // ONLY EVER A WITHDRAWAL: `no` stays `no`, everything else becomes `no`.
  // `stay_airside` is the traveller's own answer and is never rewritten, even
  // when a closure (an unreadable store) is named beside it.
  const verdict: LeaveAdvice["verdict"] = staying ? base.verdict : constraintClosed ? "no" : base.verdict;

  const gate = gateFor({
    verdict,
    closedBy,
    needsInfo,
    criticalUnknowns,
    entryPermissionState: entryState,
    constraintsRead: c ? c.read : "legacy",
    constraintsVersion: c ? c.version : null,
    entryForbidsLandside,
  });
  void envelope; // the window is the caller's; nothing here re-derives from it

  const untouched = reasons === base.reasons && unknowns === base.unknowns && reasonCodes === base.reasonCodes;
  if (verdict === base.verdict && untouched) return { advice: base, gate, insufficient: criticalUnknowns.length > 0 };
  return {
    advice: { ...base, verdict, reasons, unknowns, reasonCodes },
    gate,
    insufficient: criticalUnknowns.length > 0,
  };
}

/** The closures THIS module adds; the other three are the clock's, the border's and the traveller's. */
const CONSTRAINT_CLOSURES: ReadonlySet<LandsideClosure> = new Set<LandsideClosure>([
  "entry_unconfirmed", "baggage_unknown", "airport_change",
  "constraints_unreadable", "airport_change_unknown", "recheck_unknown",
]);

/**
 * Assemble the gate from the verdict and the closures. THE ONE PLACE `open`,
 * `status` and `cautions` are decided, so the three cannot disagree.
 *
 * `open` is the verdict `yes` with nothing closed and nothing cautioned. It is
 * computed from all three on purpose: a `yes` beside an unconfirmed border
 * cannot be produced by `adviseLeaving` today, and if it ever is, this reads it
 * as a caution rather than as permission.
 */
function gateFor(args: Omit<LandsideGate, "open" | "status" | "cautions"> & { verdict: LeaveAdvice["verdict"] }): LandsideGate {
  const { verdict, ...rest } = args;
  const refused = verdict === "no" || verdict === "stay_airside";
  const cautions: LandsideCaution[] = [];
  if (!refused && rest.closedBy.length === 0) {
    if (rest.entryPermissionState !== "CONFIRMED_ALLOWED") cautions.push("entry_unconfirmed");
    if (verdict === "tight") cautions.push("tight_window");
  }
  const status: LandsideStatus =
    refused || rest.closedBy.length > 0 ? "closed"
    : cautions.length > 0 || verdict !== "yes" ? "caution"
    : "open";
  return { open: status === "open", status, ...rest, cautions };
}

/**
 * Re-read a gate after something DOWNSTREAM of it withdrew the verdict.
 *
 * `certifyFeasibilityWithReturnCorridor` may take `yes` to `tight` after this
 * gate was evaluated. A record whose verdict says "tight" beside a gate that
 * still says "open" is two answers in one payload, so the gate follows. It can
 * only ever lose its `open`: a verdict that became more permissive is ignored.
 */
export function gateForVerdict(gate: LandsideGate, verdict: LeaveAdvice["verdict"]): LandsideGate {
  if (verdict === "yes" || gate.status !== "open") return gate;
  if (verdict === "tight") return { ...gate, open: false, status: "caution", cautions: [...gate.cautions, "tight_window"] };
  if (verdict === "entry_unverified") return { ...gate, open: false, status: "caution", cautions: [...gate.cautions, "entry_unconfirmed"] };
  return { ...gate, open: false, status: "closed", closedBy: [...gate.closedBy, verdict === "stay_airside" ? "traveller_staying_airside" : "insufficient_time"] };
}

/**
 * THE ONE GATE READ. Every surface that tells a traveller they can leave the
 * airport — the lifecycle state, the plan fit, Compass `simulatePlan`, the crew
 * solver, the recommendation generator — asks THIS, of the certified record it
 * already holds, and nothing else.
 *
 * Derived defensively rather than read off `gate.status` alone: a record
 * certified by a build that predates `status` (a stored snapshot replayed
 * later) has none, and must not read as open.
 */
export function landsideStatusOf(record: { landsideGate: LandsideGate; verdict?: LeaveAdvice["verdict"] }): LandsideStatus {
  const g = record.landsideGate;
  if (g.closedBy.length > 0 || g.status === "closed") return "closed";
  if (record.verdict === "no" || record.verdict === "stay_airside") return "closed";
  if (g.open === true && g.status === "open" && (record.verdict === undefined || record.verdict === "yes")) return "open";
  return "caution";
}

/**
 * The landside gate of a GROUP plan — §14.1 "Crew plan must be certified
 * against every member branch", for the half the clock cannot see.
 *
 *   not_applicable  no stop is outside the airport; or nobody's gate closed it
 *                   and a member is uncertified (`null`), whose gate was never
 *                   read — the branch is infeasible for that reason already,
 *                   and "open" would be a claim about nobody.
 *   closed          ANY member's gate is closed. One traveller who may not
 *                   leave the terminal closes the trip for the branch.
 *   caution         nobody is forbidden and somebody is not confirmed.
 *   open            every member's gate is open.
 *
 * A stop with no `insideAirport: true` is a landside stop.
 */
export function groupLandsideStatus(
  stops: readonly PlanFitStop[],
  records: ReadonlyArray<{ landsideGate: LandsideGate; verdict?: LeaveAdvice["verdict"] } | null>,
): LandsideStatus | "not_applicable" {
  if (!stops.some((s) => s.insideAirport !== true)) return "not_applicable";
  let worst: LandsideStatus = "open";
  let unread = records.length === 0;
  for (const r of records) {
    if (!r) { unread = true; continue; }
    const s = landsideStatusOf(r);
    if (s === "closed") return "closed";
    if (s === "caution") worst = "caution";
  }
  return unread ? "not_applicable" : worst;
}

/** `closed` beats `caution` beats `open`; `not_applicable` when nothing applies. */
export function weakestLandsideStatus(
  statuses: ReadonlyArray<LandsideStatus | "not_applicable">,
): LandsideStatus | "not_applicable" {
  if (statuses.includes("closed")) return "closed";
  if (statuses.includes("caution")) return "caution";
  return statuses.includes("open") ? "open" : "not_applicable";
}

/** `fits` | `over` | `unknown` from the clock, plus the two answers only the gate can give. */
export type GatedPlanFitVerdict = PlanFitVerdict | "blocked" | "unconfirmed";

/** A plan's fit, as every plan surface publishes it. */
export interface CertifiedPlanFit {
  totalPlannedMin: number;
  returnTravelMin: number;
  neededMin: number;
  usableMinutes: number;
  /** TRUE only when `fit === "fits"`. */
  fitsWindow: boolean;
  /**
   *   fits         every leg is stated, the total is inside the window, and —
   *                if any stop is outside the airport — the gate is OPEN.
   *   over         the lower bound already exceeds the window. Certain.
   *   unknown      a leg is unstated; nobody has measured the plan.
   *   blocked      the plan leaves the airport and the gate is CLOSED.
   *   unconfirmed  the plan leaves the airport, the clock says it fits, and the
   *                gate is not open (an unconfirmed border, a tight window).
   */
  fit: GatedPlanFitVerdict;
  /** What the clock alone says — `planFitVerdict`, before the gate. */
  clockFit: PlanFitVerdict;
  /** A stop outside the airport is on the plan. */
  hasLandsideStop: boolean;
  /** The gate this fit was read under, so a surface can say WHY. */
  landside: { status: LandsideStatus; closedBy: LandsideClosure[]; cautions: LandsideCaution[] };
  unstatedTravelStops: number;
  unstatedDurationStops: number;
  neededMinIsLowerBound: boolean;
  overflowMin: number;
  backByTime: string;
}

/**
 * Does the plan fit — the clock AND the gate.
 *
 * `planFitVerdict` reads `usableMinutes` and nothing else, and the usable
 * window is the same number whether or not the traveller may leave the
 * airport: a refused border, an airport change and an unreadable store all
 * certify with hours of "usable" time. So a plan with a stop in the city came
 * back `fits` under a closed gate, on the routes, in Compass and in the crew
 * solver alike. This is the one function those three now call.
 *
 * The gate only ever WITHDRAWS a `fits` (or, when closed, an `unknown`). `over`
 * is arithmetic, certain, and already a refusal; an airside-only plan is not
 * the landside gate's business at all.
 */
export function certifiedPlanFit(
  record: {
    landsideGate: LandsideGate;
    verdict?: LeaveAdvice["verdict"];
    envelope: Pick<LayoverWindow, "usableMinutes" | "hardReturnTime">;
  },
  stops: readonly PlanFitStop[],
): CertifiedPlanFit {
  const usableMinutes = record.envelope.usableMinutes;
  const totals = planFitTotals(stops);
  const clockFit = planFitVerdict(totals, usableMinutes);
  const hasLandsideStop = stops.some((s) => s.insideAirport !== true);
  const status = landsideStatusOf(record);
  const fit: GatedPlanFitVerdict =
    clockFit === "over" || !hasLandsideStop ? clockFit
    : status === "closed" ? "blocked"
    : status === "caution" && clockFit === "fits" ? "unconfirmed"
    : clockFit;
  return {
    totalPlannedMin: totals.totalPlannedMin,
    returnTravelMin: totals.returnTravelMin,
    neededMin: totals.neededMin,
    usableMinutes,
    fitsWindow: fit === "fits",
    fit,
    clockFit,
    hasLandsideStop,
    landside: { status, closedBy: [...record.landsideGate.closedBy], cautions: [...(record.landsideGate.cautions ?? [])] },
    unstatedTravelStops: totals.unstatedTravelStops,
    unstatedDurationStops: totals.unstatedDurationStops,
    neededMinIsLowerBound: totals.neededMinIsLowerBound,
    overflowMin: Math.max(0, totals.neededMin - usableMinutes),
    backByTime: record.envelope.hardReturnTime.toISOString(),
  };
}

/** A question §12.1 allows: one field, the answers that resolve it, nothing else. */
export type ConstraintQuestion =
  | { field: "baggageMode"; prompt: string; options: Array<{ value: BaggageMode; label: string }> }
  | { field: "airportChangeRequired" | "recheckRequired"; prompt: string; options: Array<{ value: boolean; label: string }> };

/**
 * The question §12.1 allows, for the field the gate names.
 *
 * "Not sure" is never offered as an answer here: it is the state the traveller
 * is already in, and it is the reason the question is being asked.
 */
export function constraintQuestion(gate: LandsideGate): ConstraintQuestion | null {
  switch (gate.needsInfo) {
    case "baggageMode":
      return {
        field: "baggageMode",
        prompt: "Is your checked bag tagged through to your final destination?",
        options: [
          { value: "CHECKED_THROUGH", label: "Yes — tagged through" },
          { value: "COLLECT_RECHECK", label: "No — I collect and re-check it" },
          { value: "CARRY_ON_ONLY", label: "I only have carry-on" },
        ],
      };
    case "airportChangeRequired":
      return {
        field: "airportChangeRequired",
        prompt: "Does your next flight leave from this airport, or a different airport?",
        options: [
          { value: false, label: "This airport" },
          { value: true, label: "A different airport" },
        ],
      };
    case "recheckRequired":
      return {
        field: "recheckRequired",
        prompt: "Are your flights on one ticket, or booked separately?",
        options: [
          { value: false, label: "One ticket" },
          { value: true, label: "Separate tickets — I check in again" },
        ],
      };
    case null:
      return null;
    default: {
      // A field added to the union and not taught here is not asked about
      // rather than asked about wrongly.
      const _exhaustive: never = gate.needsInfo;
      return null;
    }
  }
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
  LANDSIDE_AVAILABLE: { derivable: true,  from: "landsideGate OPEN (the verdict is `yes`), no landside stop planned" },
  PLAN_SELECTED:      { derivable: true,  from: "landsideGate OPEN (the verdict is `yes`) and a landside stop is planned" },
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
 * Closures that are NOT evidence the traveller stayed in the terminal: the
 * clock, and an outage. Everything else in `closedBy` is either the traveller's
 * own answer or a closure they were shown before they could have left.
 */
const CLOSURES_THAT_DO_NOT_PLACE_THE_TRAVELLER: ReadonlySet<LandsideClosure> = new Set<LandsideClosure>([
  "insufficient_time", "constraints_unreadable",
]);

/**
 * Project the stored status and the certified record onto §4.1's state, or
 * `null` when §5 has no state for it.
 *
 * A PROJECTION, NOT A STORE: nothing here records a transition. It exists so
 * the guard `EVALUATING → LANDSIDE_AVAILABLE` has one implementation that every
 * surface reads, and so NEEDS_INFO is a state rather than a sentence.
 *
 * ── `null` IS THE CAUTIONARY GATE, AND IT IS DELIBERATE ─────────────────────
 * §5 gives EVALUATING two exits: AIRPORT_ONLY ("landside forbidden /
 * insufficient time") and LANDSIDE_AVAILABLE, whose guard is "entry allowed;
 * critical unknowns empty; usable time ≥ configured floor". A cautionary gate
 * satisfies NEITHER — nothing forbids landside, and the guard is unmet — so
 * there is no state to report and none is approximated. This used to return
 * LANDSIDE_AVAILABLE for it, which a client drew as a green "You can go out"
 * beneath a verdict that said entry was unconfirmed. The caller publishes the
 * reason (`landside_unconfirmed`) and the gate's own `cautions` say which.
 */
export function deriveLayoverState(args: {
  status: "active" | "returning" | "completed" | "cancelled" | "expired";
  gate: LandsideGate;
  /** The certified verdict the gate was evaluated beside. */
  verdict?: LeaveAdvice["verdict"];
  returnState: LayoverReturnState;
  /** A stop outside the airport is on the plan. */
  hasLandsidePlan: boolean;
  /**
   * The certified envelope has (or had) a landside window at all —
   * `record.envelope.freedomWindow !== null`. A layover that never had one
   * (§7.2's temporal conflict) cannot have a traveller out in the city.
   */
  hadLandsideWindow: boolean;
}): LayoverState | null {
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
  // An UNREADABLE store says nothing about where the traveller is — they may
  // have been told "yes" while it was readable — so it does not withhold it.
  const escalated = args.returnState !== "NORMAL";
  const clockOnly = args.gate.closedBy.every((x) => CLOSURES_THAT_DO_NOT_PLACE_THE_TRAVELLER.has(x));
  if (escalated && (args.hasLandsidePlan || (clockOnly && args.hadLandsideWindow))) {
    return args.returnState === "RETURN_SOON" ? "RETURN_SOON" : "RETURN_NOW";
  }
  if (args.gate.needsInfo) return "NEEDS_INFO";
  const status = landsideStatusOf({ landsideGate: args.gate, verdict: args.verdict });
  if (status === "closed") return "AIRPORT_ONLY";
  if (status !== "open") return null;
  return args.hasLandsidePlan ? "PLAN_SELECTED" : "LANDSIDE_AVAILABLE";
}

/** `deriveLayoverState`, read off a certified record. The form every route uses. */
export function layoverStateOf(
  record: {
    landsideGate: LandsideGate;
    verdict?: LeaveAdvice["verdict"];
    envelope: Pick<LayoverWindow, "returnState" | "freedomWindow">;
  },
  status: "active" | "returning" | "completed" | "cancelled" | "expired",
  hasLandsidePlan: boolean,
): LayoverState | null {
  return deriveLayoverState({
    status,
    gate: record.landsideGate,
    verdict: record.verdict,
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
