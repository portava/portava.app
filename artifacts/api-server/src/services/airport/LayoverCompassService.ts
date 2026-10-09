/**
 * LayoverCompassService — §12 Compass on the layover door, §12.1 value-of-information.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §12   "Compass is an orchestrator and explainer. ... It CANNOT invent or
 *          widen the certified safe envelope, return deadline, visa/entry
 *          status, operational state, or risk band."   (census L100, L101)
 *   §12.1 "Before asking the user a question, determine whether the answer
 *          could materially change eligibility, safety, risk band, or the top
 *          plan. Ask the smallest number of questions required."  (census L114)
 *
 * ── LEAD RULING L-CL02d (2026-10-09): CERTIFIED-ONLY BY CONSTRUCTION ────────
 *
 * `POST /airport/sessions/:id/compass` answers EVERY question with the
 * server's certified text plus deterministic airport facts, read off the ONE
 * certified record (`certifySessionFeasibility`, or the route's snapshot).
 * There is no language model, no tool round and no classifier on this door.
 *
 * Why the model branch was deleted rather than gated: L-CL02a made every
 * question on a LIVE layover certified-only, and L-CL02c defines live to
 * include any session whose departure is still ahead. A certified explicit
 * `yes` needs usable time before that departure, so every session that could
 * have reached the model was live — the branch was unreachable. L-CL02d
 * removes it, its twelve §12 tools and the prose filters that guarded it, so
 * the door is certified-only by construction rather than by a gate that a
 * later change could reopen. The model-facing rows (census-layover L100,
 * L102–L113) are W with that reason; §56.3.
 *
 * What stays, unchanged: the certified text and its "explicit yes" predicate,
 * the deterministic airport facts, the `involvesLeaving` label, §12.1's
 * clarifying question (computed by re-certifying with the candidate answer
 * flipped — census L114, still computed and returned on every answer), and
 * the coordinate scrub on every answer.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js"; import type { EntryEligibility } from "./layoverEntryGate.js"; import type { LayoverSnapshot } from "./LayoverSnapshot.js";
import {
  safetyLabel,
  type SafetyRating,
} from "./LayoverSafetyEngine.js";
import {
  certifySessionFeasibility,
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import { landsideStatusOf, type LandsideCaution } from "./LayoverConstraints.js";
import { formatLocalTime } from "./AirportTime.js";
import { sanitizeCompassAnswer } from "./LayoverPrivacyGuard.js";

export interface CompassLayoverInput {
  question: string;
  session: LayoverSession;
  airport: AirportProfile;
  /** The session owner's corridor, resolved by the route (`resolveLayoverEntry`) as the snapshot resolves it — census-discovery §65. Omitted = unresolved. */
  entry?: EntryEligibility | null;
  /** census-discovery §81: the certified snapshot, when the route read one — its record and its usable minutes are then the answer's, and nothing is re-derived here. */
  snapshot?: LayoverSnapshot | null;
}

export interface CompassLayoverAnswer {
  answer: string;
  safetyNote: string | null;
  hardReturnTime: string | null;
  bufferMinutes: number;
  /** Whether the question involves leaving the airport — a LABEL; it decides nothing shown. */
  involvesLeaving: boolean;
  /** §12.1 — the single highest-value clarifying question, or null. */
  clarifyingQuestion: ClarifyingQuestion | null;
  /** Kept on the wire for clients that read it: always empty — no model text exists to violate the envelope (L-CL02d). */
  boundaryViolations: never[];
  /** §20 — which rules and which inputs produced the figures above. */
  certification: ReturnType<typeof certificationHeader>;
  /** Kept on the wire: always empty — this door runs no tool (L-CL02d). */
  toolsConsulted: never[];
  /** Kept on the wire: always certified-only — the answer is the server's alone (L-CL02d). */
  modelProse: { mode: "certified_only"; droppedSentences: 0 };
  /** Kept on the wire: always false — no language model is consulted on this door (L-CL02d). */
  modelConsulted: false;
}

/**
 * Words that mark a question as about leaving the airport. A LABEL since lead
 * ruling L3-FC-3: it fills `involvesLeaving` on the response and the
 * `compass_question_asked` event, and decides nothing the traveller is shown —
 * what is shown is decided by the certified verdict alone, so a phrasing this
 * list misses can no longer reach model prose that a phrasing it catches cannot.
 */
const LEAVING_PATTERNS = [
  /leave\s+the\s+airport/i, /go\s+outside/i, /exit\s+the\s+terminal/i,
  /get\s+out/i, /city\s+(tour|trip|visit)/i, /explore\s+(the\s+city|outside)/i,
  /can\s+i\s+(leave|go|exit)/i,
  /\bleav(e|es|ing)\b/i, /\blandside\b/i, /\bdown\s*town\b/i, /\btown\b/i, /\bcity\b/i,
  /\boutside\b/i, /\bpop\s+out\b/i, /\bhead\s+(out|into)\b/i, /\breachable\b/i,
  /\bmake\s+it\s+to\b/i, /\bexplor(e|ing)\b/i, /\bvisit(ing)?\b/i, /\bsightsee/i,
];

/** The `involvesLeaving` label (see LEAVING_PATTERNS). Never a safety decision. */
export function questionMentionsLeaving(question: string): boolean {
  return LEAVING_PATTERNS.some((p) => p.test(question));
}

/** The certified record's fields the "explicit yes" predicate and the certified text read. */
export type CertifiedLayoverState = Pick<LayoverFeasibilityRecord, "verdict" | "landsideGate">;

/**
 The certified "explicit yes": the ONLY state in which the certified text says
 * "you can leave the airport" and the safety note can read "Safe". (The name is
 * historical: under L3-FC-3 it also gated the model, which L-CL02d removed from
 * this door; it is kept because tests and lane L's door name it.)
 *
 * "Explicit yes" is read as narrowly as the certified text itself says "you can
 * leave the airport": the verdict is `yes`, the ONE landside gate reads `open`
 * (`landsideStatusOf`, which also refuses a gate certified by a build that
 * predates `status`), and the usable window is at least the 30 minutes below
 * which the certified text advises staying inside. Any other verdict —
 * `no`, `tight`, `entry_unverified`, `stay_airside`, or one this build does not
 * know — is not a yes. The question is not read.
 */
export function layoverModelMayAnswer(record: CertifiedLayoverState, usableMinutes: number): boolean {
  return record.verdict === "yes" && landsideStatusOf(record) === "open" && Number.isFinite(usableMinutes) && usableMinutes >= 30; // finite: Infinity and 1e308 are not a window (verifier F-W2)
}

/** Plain words for the cautions a traveller may be shown; a code not listed here is not spelled out. */
const CAUTION_WORDS: Readonly<Record<LandsideCaution, string>> = {
  tight_window: "your time window is tight",
  entry_unconfirmed: "entry to the country could not be confirmed",
};

const STAY_INSIDE = "I'd recommend staying inside the airport: grab a meal, relax in a lounge, or browse the shops.";

/**
 * The certified answer — the same sentence whatever the question was (L3-FC-3:
 * the question is not classified). Read off the ONE certified record: its
 * verdict, its landside gate, and the figures `answerLayoverQuestion` took from
 * it. It says "you can leave the airport" ONLY on an explicit yes
 * (`layoverModelMayAnswer`), so it can never widen what the record certified —
 * `tight`, `entry_unverified` and `stay_airside` used to read "You can leave the
 * airport" here whenever 30+ usable minutes remained, because only `no` was
 * treated as a refusal.
 *
 * Compatible with lane L's `certifiedLayoverAnswerText` (services/airport/
 * layoverQuestionScope.ts on claude/mission-l-wave6-20261006, not on main when
 * this was written): the same four branches — closed, caution, under 30 usable
 * minutes, open — in the same order. This door keeps its airport-local
 * deadline sentence. The two should become one function once both are on main.
 *
 * ── THE CLOCK IS THE AIRPORT'S, AND IT DID NOT USED TO BE ───────────────────
 * This text previously read `hardReturnTime.toLocaleTimeString()`, which is the
 * SERVER PROCESS's timezone — UTC in every deployment of this service. A
 * traveller in Taipei was told to be back at security at a time eight hours
 * off, and in Los Angeles seven hours the other way. Every other layover
 * response already formats this instant with `formatLocalTime(airport.timezone,
 * …)` (`/return-deadline`'s `hardReturnLocal`, `/overview`'s `localTimes`), so
 * this was the one place that disagreed with the rest of the API.
 *
 * The §12 boundary check is what surfaced it: that check compares stated clock
 * times against the certified deadline IN THE AIRPORT'S TIMEZONE, so on any
 * westward airport the server's own fallback sentence tripped its own guard.
 * A guard the server cannot itself satisfy is not a guard.
 */
export function certifiedLayoverText(input: {
  record: CertifiedLayoverState;
  usableMin: number;
  bufferMin: number;
  /** Pre-formatted in the AIRPORT's timezone. Never a server-locale string. */
  hardReturnLocal: string;
}): string {
  const { record, usableMin, bufferMin, hardReturnLocal } = input;
  if (record.verdict === "stay_airside") {
    return "You chose to stay at the airport for this layover, so leaving it is not part of the plan. Grab a meal, relax in a lounge, or browse the shops.";
  }
  const status = landsideStatusOf(record);
  if (record.verdict === "no" || status === "closed") {
    return `Leaving the airport is not recommended on this layover — the certified check for it says no. ${STAY_INSIDE}`;
  }
  if (record.verdict !== "yes" || status !== "open") {
    const why = (record.landsideGate.cautions ?? []).map((c) => (CAUTION_WORDS as Readonly<Record<string, string>>)[c]).filter((w): w is string => typeof w === "string");
    return `Leaving the airport has not been confirmed as possible on this layover${why.length ? ` (${why.join("; ")})` : ""}. ${STAY_INSIDE}`;
  }
  // The "you can leave" sentence is reached ONLY through the gate itself
  // (verifier F2 on 517e2f3e98..ab67f861bb): one predicate, so a usable window
  // that is NaN or undefined — for which `< 30` is also false — can never say it.
  if (!layoverModelMayAnswer(record, usableMin)) {
    return Number.isFinite(usableMin)
      ? `With only ${usableMin} minutes of usable time after your ${bufferMin}-minute return buffer, I'd recommend staying inside the airport for this one. Grab a meal, relax in a lounge, or browse the shops.`
      : `Your usable time on this layover could not be confirmed. ${STAY_INSIDE}`;
  }
  return `You have about ${usableMin} minutes of usable time. You can leave the airport — but make sure you're back at security by ${hardReturnLocal} to catch your flight safely.`;
}

/**
 * L3-FC-3's "deterministic airport facts": where the traveller is and how long
 * they have until boarding, every figure the certified record's. No list the
 * model could have shaped, no recommendation row (a persisted shortlist can
 * outlive the verdict it was generated under), nothing about the city.
 */
export function deterministicAirportFacts(input: {
  airport: Pick<AirportProfile, "name" | "iataCode">;
  availMin: number;
  bufferMin: number;
}): string {
  const { airport, availMin, bufferMin } = input;
  if (!Number.isFinite(availMin) || !Number.isFinite(bufferMin)) return `You're at ${airport.name} (${airport.iataCode}).`; // never "about NaN minutes"
  return `You're at ${airport.name} (${airport.iataCode}), with about ${availMin} minutes until boarding; your required return buffer is ${bufferMin} minutes.`;
}

/**
 * The note beside the answer, from the same certified state as the text: the
 * landside gate's band, never better than the usable window allows. It is set
 * on EVERY answer — since L3-FC-3 every answer leads with the certified
 * landside sentence, so the note travels with it rather than with a guess about
 * the question.
 */
function certifiedSafetyNote(record: CertifiedLayoverState, usableMin: number): string {
  if (record.verdict === "stay_airside") return safetyLabel("airport_only");
  const status = landsideStatusOf(record);
  // `!(usableMin >= 30)` and the gate below, not `< 30`: an unknown window (NaN,
  // undefined) is the refused band, and "Safe" is reachable only through
  // layoverModelMayAnswer — the same predicate as the text (verifier F2).
  if (record.verdict === "no" || status === "closed" || !(Number.isFinite(usableMin) && usableMin >= 30)) return safetyLabel("not_recommended");
  if (!layoverModelMayAnswer(record, usableMin) || usableMin < 60) return safetyLabel("possible_but_risky");
  return safetyLabel("safe");
}

// Liveness (lead ruling L-CL02c) is decided by `layoverSessionIsLiveAt` in
// LayoverSessionService — the one rule both Compass doors read. On this door it
// decides nothing the traveller is shown: L-CL02d answers every session
// certified-only (a certified explicit `yes` needs usable time before the
// departure, so every `yes` session is live — why the model branch was deleted).
// The route records liveness on the `compass_question_asked` event.

export async function answerLayoverQuestion(
  _db: SupabaseClient,
  input: CompassLayoverInput,
): Promise<CompassLayoverAnswer> {
  const { question, session, airport } = input;

  const now = new Date(input.snapshot ? input.snapshot.certifiedRecord.inputs.nowMs : Date.now()); // §81: the snapshot's instant, not a second clock
  // ONE certified record — the same one every other layover surface consumes,
  // so Compass cannot answer from a different derivation than the screen.
  const record = input.snapshot?.certifiedRecord ?? certifySessionFeasibility(airport, session, { nowMs: now.getTime(), entry: input.entry ?? null });
  const { cutoffMs, breakdown, hardReturnTime } = record.deadline;
  const availMin  = input.snapshot ? Math.max(0, input.snapshot.minutesToHardReturn + breakdown.totalBuffer) : Math.max(0, Math.round((cutoffMs - now.getTime()) / 60000)); // §81: ON, the clock too is read off the snapshot
  const bufferMin = breakdown.totalBuffer;
  const usableMin = input.snapshot ? input.snapshot.usableMinutes : Math.max(0, availMin - bufferMin);
  const hardReturnLocal = formatLocalTime(airport.timezone ?? "UTC", hardReturnTime);

  // L-CL02d: the ONLY answer this door gives — certified text + deterministic
  // airport facts. What the question says cannot change it; `involvesLeaving`
  // is a label for the response and the event.
  return {
    answer: sanitizeCompassAnswer(`${certifiedLayoverText({ record, usableMin, bufferMin, hardReturnLocal })} ${deterministicAirportFacts({ airport, availMin, bufferMin })}`),
    safetyNote: certifiedSafetyNote(record, usableMin),
    hardReturnTime: hardReturnTime.toISOString(),
    bufferMinutes: bufferMin,
    involvesLeaving: questionMentionsLeaving(question),
    // §12.1 / census L114: at most ONE question, asked only when the answer could move the verdict, the risk band or the usable window.
    clarifyingQuestion: nextClarifyingQuestion(airport, session, now.getTime(), record.inputs.entry),
    boundaryViolations: [],
    certification: certificationHeader(record),
    toolsConsulted: [],
    modelProse: { mode: "certified_only", droppedSentences: 0 },
    modelConsulted: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §12.1 value-of-information
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The session fields whose answer is BOTH unknown-in-effect and capable of
 * moving the certified outcome.
 *
 * `checkedBags` and `immigrationRequired` are the only two on this tree: they
 * are booleans the traveller set at session creation, and each adds a real term
 * to the return buffer (`checked_bags_extra_min`, `immigration_extra_min`), so
 * flipping one changes the deadline and can change the verdict. `wantsToLeave`
 * is included because it decides whether the landside question is asked at all.
 *
 * The spec's own worked example — baggage-THROUGH status — is a third value
 * the schema cannot hold: `checked_bags` is a boolean, so "checked, but
 * through-tagged to the final destination" is unrepresentable (census L35).
 * That is named in `UNREPRESENTABLE_CLARIFICATIONS` rather than silently
 * omitted, because a value-of-information rule that cannot see the spec's
 * headline example should say so.
 */
export const CLARIFIABLE_FIELDS = ["checkedBags", "immigrationRequired", "wantsToLeave"] as const;
export type ClarifiableField = (typeof CLARIFIABLE_FIELDS)[number];

export const UNREPRESENTABLE_CLARIFICATIONS = [
  {
    field: "baggageThrough",
    question: "Are your bags checked through to your final destination?",
    reason:
      "`layover_sessions.checked_bags` is a boolean (0127); there is no column for through-tagged. " +
      "The spec's own decisive example cannot be recorded, so it is not asked.",
  },
] as const;

const CLARIFYING_QUESTION_TEXT: Record<ClarifiableField, string> = {
  checkedBags: "Do you have checked bags to collect before you can leave the terminal?",
  immigrationRequired: "Will you need to clear immigration to go landside here?",
  wantsToLeave: "Are you hoping to leave the airport, or stay inside the terminal?",
};

export interface ClarifyingQuestion {
  field: ClarifiableField;
  question: string;
  /** What flipping the answer would do. All three are the §12.1 test. */
  impact: {
    verdictChanges: boolean;
    riskBandChanges: boolean;
    returnStateChanges: boolean;
    usableMinutesDelta: number;
  };
  /** Ranking score; higher is more worth asking. */
  valueOfInformation: number;
}

function flip(session: FeasibilitySession, field: ClarifiableField): FeasibilitySession {
  switch (field) {
    case "checkedBags": return { ...session, checkedBags: !session.checkedBags };
    case "immigrationRequired": return { ...session, immigrationRequired: !session.immigrationRequired };
    case "wantsToLeave": return { ...session, wantsToLeave: !session.wantsToLeave };
  }
}

/**
 * Coarse risk band of a verdict, so "materially changes risk band" is
 * comparable. The engine's four verdicts collapse onto the three
 * `SafetyRating` bands a traveller is ever shown: `tight` is the risky band,
 * and `stay_airside` — "do not go landside at all" — is the same band as `no`,
 * because both mean the landside plan is refused.
 */
function riskBand(record: LayoverFeasibilityRecord): SafetyRating {
  switch (record.verdict) {
    case "yes":   return "safe";
    case "tight": return "possible_but_risky";
    // `entry_unverified` is the risky band, not the refused one. The clock said
    // there is time; what is missing is a confirmation nobody has curated. The
    // refused band is for verdicts that actually refuse.
    case "entry_unverified": return "possible_but_risky";
    default:      return "not_recommended";
  }
}

/**
 * §12.1 "determine whether the answer could materially change eligibility,
 * safety, risk band, or the top plan."
 *
 * This is a MEASUREMENT, not a heuristic: for each candidate field the session
 * is re-certified with that field flipped, through the same
 * `certifySessionFeasibility` every surface uses, and the two records are
 * compared. A field whose flip changes nothing scores zero and is never asked.
 * The example the spec gives for the other side — favourite cuisine — is not in
 * `CLARIFIABLE_FIELDS` at all, because it is not an input to the record and
 * therefore cannot move it by construction.
 *
 * Weights make "would flip the verdict" dominate a large-but-immaterial minute
 * change, so the question that is asked is the DECISIVE one, not the loudest.
 */
export function valueOfInformation(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  nowMs: number, /** The corridor the base record was certified with; each flip is certified with the SAME one (census-discovery §65). */ entry?: EntryEligibility | null,
): ClarifyingQuestion[] {
  const base = certifySessionFeasibility(airport, session, { nowMs, entry });
  const out: ClarifyingQuestion[] = [];
  for (const field of CLARIFIABLE_FIELDS) {
    const alt = certifySessionFeasibility(airport, flip(session, field), { nowMs, entry });
    const verdictChanges = alt.verdict !== base.verdict;
    const riskBandChanges = riskBand(alt) !== riskBand(base);
    const returnStateChanges = alt.envelope.returnState !== base.envelope.returnState;
    const usableMinutesDelta = alt.envelope.usableMinutes - base.envelope.usableMinutes;
    const score =
      (verdictChanges ? 100 : 0) +
      (riskBandChanges ? 100 : 0) +
      (returnStateChanges ? 50 : 0) +
      Math.min(40, Math.abs(usableMinutesDelta));
    if (score === 0) continue;
    out.push({
      field,
      question: CLARIFYING_QUESTION_TEXT[field],
      impact: { verdictChanges, riskBandChanges, returnStateChanges, usableMinutesDelta },
      valueOfInformation: score,
    });
  }
  return out.sort((a, b) => b.valueOfInformation - a.valueOfInformation);
}

/**
 * §12.1 "ask the smallest number of questions required": exactly one, the
 * highest-value one, or none at all when no answer would move anything.
 */
export function nextClarifyingQuestion(
  airport: FeasibilityAirport,
  session: FeasibilitySession,
  nowMs: number, entry?: EntryEligibility | null,
): ClarifyingQuestion | null {
  return valueOfInformation(airport, session, nowMs, entry)[0] ?? null;
}
