/**
 * CompassClarification — census-compass CL-04, the CLARIFICATION clause.
 *
 * The Layover spec's Compass row asks for four things: tool access to certified
 * context, proactive OpportunityEvents, explanation, and CLARIFICATION.
 * §26.9 closed the first three and left this one open with a one-line reason:
 * nothing under `compass/` could tell an UNDER-DETERMINED layover request from
 * a complete one, so an unstated fact was answered by guessing.
 *
 * THIS IS A COMPUTATION, NOT A PROMPT INSTRUCTION. "Ask if you are unsure" in a
 * system prompt is a hope; a model that has already decided it is sure will not
 * read it. What is written here is a function with an answer: given the ONE
 * certified layover snapshot (`services/airport/LayoverSnapshot`) and the facts
 * the caller says were actually STATED, it returns the ONE question worth
 * asking and the fact that question resolves — or "no clarification needed".
 *
 * THREE RULES IT KEEPS.
 *
 *   1. IT NEVER INVENTS THE FACT IT IS MISSING. A missing fact produces a
 *      QUESTION, never a value and never a default. An "ambiguous" fact is only
 *      ambiguous when the caller supplies two or more readings OF THE USER'S
 *      OWN WORDS; one reading is not an ambiguity, it is simply an unstated
 *      fact, and echoing that lone reading back would be this module asserting
 *      something nobody said. A fact the caller did not mention is `missing` —
 *      never `known`.
 *
 *   2. WHEN EVERYTHING REQUIRED IS KNOWN IT SAYS SO. `{ needed: false }` with a
 *      reason, and no question text at all. Manufacturing a question to look
 *      diligent is the same defect as guessing, one politeness away.
 *
 *   3. IT DOES NOT ASK WHAT CANNOT MATTER. §12.3's rule, and the Layover
 *      spec's: "ask only for unknown facts capable of materially changing
 *      feasibility, authorization, cost, or recommendation quality". The
 *      materiality of each fact is read OFF THE CERTIFIED SNAPSHOT — landside
 *      closed means leaving is not on the table, so whether they wanted to
 *      leave changes nothing and is not asked. An unknown below the threshold
 *      stays represented as uncertainty and is reported as such.
 *
 * ONE SCORER, NOT A SECOND ONE. The ranking is
 * `domain/trips/services/TripValueOfInformation.valueOfInformation` — the §12.3
 * value-of-information `CompassTools#questionsWorthAsking` already calls. This
 * module supplies the `Unknown`s and lets that function do the arithmetic and
 * the thresholding; it deliberately contains no `probability * stakes` of its
 * own, because a second scorer is how two surfaces start disagreeing about what
 * is worth a traveller's attention.
 *
 * PURE. No IO, no clock, no database. The caller reads the certified snapshot
 * (through the one door) and hands it in.
 */
import {
  valueOfInformation,
  type Unknown,
  type VoiDimension,
} from "../domain/trips/services/TripValueOfInformation.js";
import { TRAVEL_TIME_UNMEASURED_UNKNOWN } from "../services/airport/LayoverSafetyEngine.js";

/**
 * The facts a layover request needs before Compass can answer it without
 * guessing. Each one is an INPUT the certified engine actually consumes or a
 * fact the certified record says it could not establish — nothing is listed
 * here that the traveller's answer could not move. (Favourite cuisine is the
 * spec's own example of the other side, and is deliberately absent.)
 */
export const CLARIFIABLE_FACTS = [
  "leave_or_stay",
  "checked_bags",
  "entry_permission",
  "landside_destination",
] as const;
export type ClarifiableFact = (typeof CLARIFIABLE_FACTS)[number];

export function isClarifiableFact(v: unknown): v is ClarifiableFact {
  return typeof v === "string" && (CLARIFIABLE_FACTS as readonly string[]).includes(v);
}

/**
 * What the caller knows about one fact. Three states, because there are three
 * answers — and `missing` is the DEFAULT for anything the caller did not
 * mention, so silence can never be read as "known".
 */
export type FactState =
  | { state: "known" }
  | { state: "missing" }
  | { state: "ambiguous"; readings: readonly string[] };

/**
 * The part of a `LayoverSnapshot` this module reads. Structural on purpose: a
 * real snapshot (minus its `certifiedRecord`) satisfies it, and the test can
 * build one without certifying a session.
 */
export interface ClarificationSnapshot {
  verdict: string;
  returnState: string;
  landsideOpen: boolean;
  landsideClosedReason: string | null;
  usableMinutes: number;
  minutesToHardReturn: number;
  reasonCodes: readonly string[];
  unknowns: readonly string[];
}

export interface ClarificationInput {
  /** The certified snapshot, or null when the traveller has no live layover. */
  snapshot: ClarificationSnapshot | null;
  /**
   * Set ONLY when the layover store could not be READ. Distinct from
   * `snapshot: null`, for the reason CL-03 already pinned: an outage must never
   * be reported as "this person is not in a layover".
   */
  contextUnreadableReason?: string | null;
  /** What the caller says was actually stated. Absent ⇒ nothing was stated. */
  facts?: Partial<Record<ClarifiableFact, FactState>>;
}

export type NoQuestionReason =
  /** The certified context could not be read — asking would rest on nothing. */
  | "context_unreadable"
  /** There is no live layover, so none of these facts is required. */
  | "no_live_layover"
  /** Every required fact was stated. */
  | "everything_required_is_known"
  /** Facts are still unknown, but no answer would move the advice (§12.3). */
  | "no_answer_would_change_the_advice";

export type ClarificationVerdict =
  | {
      needed: true;
      fact: ClarifiableFact;
      /** The one question, already phrased. */
      question: string;
      /** What answering it settles — the clause's "which fact it resolves". */
      resolves: string;
      dimension: VoiDimension;
      /** The §12.3 value of information, so a caller can see why this one. */
      value: number;
      /** Still unknown, not worth a question: these stay uncertainty. */
      representedAsUncertainty: ClarifiableFact[];
    }
  | {
      needed: false;
      reason: NoQuestionReason;
      representedAsUncertainty: ClarifiableFact[];
    };

// ── The four facts, as they are asked and what they settle ───────────────────

const QUESTION: Record<ClarifiableFact, string> = {
  leave_or_stay:
    "Are you hoping to leave the airport during this layover, or stay inside the terminal?",
  checked_bags:
    "Do you have checked bags to collect before you could leave the terminal?",
  entry_permission:
    "Do you know whether your passport and ticket let you enter the country here — a visa or transit permit?",
  landside_destination:
    "Where outside the airport were you thinking of going?",
};

const RESOLVES: Record<ClarifiableFact, string> = {
  leave_or_stay: "whether the traveller intends to go landside at all",
  checked_bags: "whether checked bags must be collected before leaving",
  entry_permission: "whether the traveller may enter the country at this airport",
  landside_destination: "which landside place the advice should be measured against",
};

const DIMENSION: Record<ClarifiableFact, VoiDimension> = {
  leave_or_stay: "recommendation_quality",
  checked_bags: "feasibility",
  entry_permission: "authorization",
  landside_destination: "feasibility",
};

/**
 * How likely the traveller's answer is to change the advice, read off the
 * CERTIFIED snapshot rather than assumed.
 *
 * `IMMATERIAL` is not zero: `valueOfInformation` multiplies by stakes and
 * compares to a threshold, and a fact that cannot move the answer must fall
 * below that threshold from any stakes — which 0.05 does (0.05 * 1 = 0.05, and
 * the threshold is 0.25). It is not zero because "cannot move the answer" is a
 * statement about THIS snapshot, not about the fact forever.
 */
const IMMATERIAL = 0.05;

function materiality(fact: ClarifiableFact, s: ClarificationSnapshot): number {
  switch (fact) {
    // Nothing landside is on the table when landside is closed, so the answer
    // changes nothing — the certified `landsideOpen` is the whole test.
    case "leave_or_stay":
      return s.landsideOpen ? 0.9 : IMMATERIAL;
    // Bags eat the usable window, but only for a traveller who could leave.
    case "checked_bags":
      return s.landsideOpen ? 0.6 : IMMATERIAL;
    // Asked only when the record itself says entry is not confirmed. The code
    // comes from the engine (`ENTRY_NOT_CONFIRMED`); this module does not decide
    // that entry is in doubt, it reads that the record said so.
    case "entry_permission":
      return s.landsideOpen && s.reasonCodes.includes("ENTRY_NOT_CONFIRMED") ? 0.5 : IMMATERIAL;
    // Asked only when the record says no routed travel time exists — the exact
    // sentence the safety engine publishes, compared by identity rather than
    // pattern-matched, so a reword cannot silently switch this off.
    case "landside_destination":
      return s.landsideOpen && s.unknowns.includes(TRAVEL_TIME_UNMEASURED_UNKNOWN)
        ? 0.4
        : IMMATERIAL;
  }
}

/**
 * How much the decision matters, from the certified pressure the traveller is
 * under. A traveller who must already be heading back is the one for whom a
 * wrong guess costs a flight.
 */
function stakes(s: ClarificationSnapshot): number {
  if (s.returnState === "RETURN_NOW" || s.returnState === "CONNECTION_AT_RISK") return 1;
  if (s.verdict === "tight") return 0.9;
  return 0.7;
}

/**
 * The question for a fact, given its state.
 *
 * An ambiguity is presented as the readings the CALLER supplied and nothing
 * else: no reading is chosen, no reading is added, and none is announced as an
 * assumption.
 *
 * "Fewer than two readings is not an ambiguity" is NOT re-checked here. It was,
 * and the duplication was found by mutation M4: with the rule written in two
 * places, breaking either one alone changed nothing, so neither site was
 * actually load-bearing and no test could hold the rule. `unknownsFor` demotes
 * a lone reading to `missing` before this function sees it, and that is the one
 * place the rule lives.
 */
function questionFor(fact: ClarifiableFact, state: FactState): string {
  if (state.state === "ambiguous") {
    const readings = state.readings.map((r) => `"${r}"`).join(", or ");
    return `${QUESTION[fact]} I could read what you said as ${readings} — which do you mean?`;
  }
  return QUESTION[fact];
}

/** Every fact that is not `known`, as an `Unknown` the §12.3 scorer can rank. */
function unknownsFor(
  s: ClarificationSnapshot,
  facts: Partial<Record<ClarifiableFact, FactState>>,
): Unknown[] {
  const out: Unknown[] = [];
  for (const fact of CLARIFIABLE_FACTS) {
    const raw = facts[fact] ?? { state: "missing" as const };
    if (raw.state === "known") continue;
    // A lone reading is not an ambiguity. Demoted here, once, so every consumer
    // below (question text included) sees the same honest state.
    const state: FactState =
      raw.state === "ambiguous" && raw.readings.length < 2 ? { state: "missing" } : raw;
    out.push({
      key: fact,
      dimension: DIMENSION[fact],
      probabilityChangesDecision: materiality(fact, s),
      stakes: stakes(s),
      question: questionFor(fact, state),
    });
  }
  return out;
}

/**
 * The ONE question worth asking, or none.
 *
 * Order of refusals matters and is the order below: an unreadable context is
 * answered BEFORE "no live layover", because collapsing the two is exactly the
 * defect CL-03 fixed one layer up.
 */
export function decideClarification(input: ClarificationInput): ClarificationVerdict {
  if (input.contextUnreadableReason) {
    return { needed: false, reason: "context_unreadable", representedAsUncertainty: [] };
  }
  if (!input.snapshot) {
    return { needed: false, reason: "no_live_layover", representedAsUncertainty: [] };
  }
  const facts = input.facts ?? {};
  const unknowns = unknownsFor(input.snapshot, facts);
  if (unknowns.length === 0) {
    return { needed: false, reason: "everything_required_is_known", representedAsUncertainty: [] };
  }
  // ONE question: §12.3's "smallest number of questions required", and the
  // Layover spec's "exactly one, the highest-value one, or none at all".
  const { ask, uncertainty } = valueOfInformation(unknowns, { maxQuestions: 1 });
  const stillUncertain = uncertainty.map((u) => u.key as ClarifiableFact);
  const top = ask[0];
  if (!top) {
    return {
      needed: false,
      reason: "no_answer_would_change_the_advice",
      representedAsUncertainty: stillUncertain,
    };
  }
  const fact = top.key as ClarifiableFact;
  return {
    needed: true,
    fact,
    question: top.question ?? QUESTION[fact],
    resolves: RESOLVES[fact],
    dimension: top.dimension,
    value: top.value,
    representedAsUncertainty: stillUncertain,
  };
}

/**
 * The model's tool arguments, turned into fact STATES.
 *
 * Deliberately narrow: the model may say which facts the user STATED and which
 * of the user's own words carry more than one reading. It may not state a
 * VALUE, because a value passed here would be a fact this module then reasoned
 * from without anyone having established it. A key that is not a clarifiable
 * fact is dropped rather than believed, and absent arguments mean "nothing was
 * stated" — never "everything is known".
 */
export function clarificationFactsFromToolArgs(
  args: Record<string, unknown>,
): Partial<Record<ClarifiableFact, FactState>> {
  const out: Partial<Record<ClarifiableFact, FactState>> = {};
  const stated = Array.isArray(args["stated"]) ? (args["stated"] as unknown[]) : [];
  for (const f of stated) if (isClarifiableFact(f)) out[f] = { state: "known" };
  const ambiguous = Array.isArray(args["ambiguous"]) ? (args["ambiguous"] as unknown[]) : [];
  for (const entry of ambiguous) {
    if (!entry || typeof entry !== "object") continue;
    const fact = (entry as Record<string, unknown>)["fact"];
    if (!isClarifiableFact(fact)) continue;
    const rawReadings = (entry as Record<string, unknown>)["readings"];
    const readings = Array.isArray(rawReadings)
      ? rawReadings.map((r) => String(r).trim()).filter(Boolean)
      : [];
    // Still recorded as ambiguous with fewer than two readings; the demotion to
    // `missing` happens in ONE place (`unknownsFor`) so the rule cannot drift
    // between the two entry points.
    out[fact] = { state: "ambiguous", readings };
  }
  return out;
}
