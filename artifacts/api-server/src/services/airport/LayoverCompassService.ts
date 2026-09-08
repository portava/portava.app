/**
 * LayoverCompassService — §12 Compass / AI contract, §12.1 value-of-information.
 *
 * Spec: docs/specs/Portava_Layover_Development_Architecture_Spec_v3.txt
 *   §12   "Compass is an orchestrator and explainer. It can ask the minimum
 *          useful clarifying question, compare certified plans, personalize
 *          wording and invoke deterministic tools. It CANNOT invent or widen
 *          the certified safe envelope, return deadline, visa/entry status,
 *          operational state, or risk band."      (census L100, L101)
 *          The twelve named tools.                (census L102-L113)
 *   §12.1 "Before asking the user a question, determine whether the answer
 *          could materially change eligibility, safety, risk band, or the top
 *          plan. Ask the smallest number of questions required."  (census L114)
 *
 * ── THREE THINGS CHANGED HERE, AND WHY EACH IS NOT COSMETIC ─────────────────
 *
 * 1. THE SECOND DERIVATION IS GONE. This file used to call
 *    `computeReturnDeadline` itself, making it a fifth independent place where
 *    feasibility was derived (census L1/L2: "no duplicate time-budget logic").
 *    It now consumes `certifySessionFeasibility` — the same single certified
 *    record `/safety`, `/overview`, `/return-deadline` and `/stops` consume.
 *    The arithmetic is IDENTICAL (that function's `deadline` is the very same
 *    `computeReturnDeadline` call), so no number a traveller sees moves; what
 *    changes is that it can no longer drift.
 *
 * 2. THE §12 BOUNDARY IS ENFORCED AFTER THE MODEL SPEAKS, NOT ONLY BEFORE.
 *    Census L101 scored the boundary W with the reason spelled out: "the only
 *    enforcement is prompt text plus a coordinate regex". Prompt text is a
 *    request, not a boundary. `enforceCompassEnvelope` reads the answer the
 *    model actually produced and refuses to publish one that states a LATER
 *    return deadline, or MORE usable time, than the certified record — the two
 *    concrete ways a language model widens a safe envelope. A violation falls
 *    back to the deterministic answer this file has always had, and is reported
 *    in `boundaryViolations` rather than swallowed.
 *
 * 3. §12.1 IS IMPLEMENTED AS A COMPUTATION, NOT A PROMPT INSTRUCTION. Whether
 *    to ask a clarifying question is decided by RE-CERTIFYING the session with
 *    the candidate answer flipped and comparing verdict, risk band and usable
 *    minutes. A question is asked only when the flip would materially move one
 *    of them — the spec's own test — and only the single highest-value one is
 *    asked, which is its "smallest number of questions".
 *
 * Privacy: still never exposes exact GPS; the coordinate scrub runs on every
 * answer including the deterministic fallbacks.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { openai } from "../../lib/openai.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js";
import {
  safetyLabel,
  type LayoverReturnState,
  type SafetyRating,
} from "./LayoverSafetyEngine.js";
import {
  certifySessionFeasibility,
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import { formatLocalTime } from "./AirportTime.js";
import { sanitizeCompassAnswer } from "./LayoverPrivacyGuard.js";

export interface CompassLayoverInput {
  question: string;
  session: LayoverSession;
  airport: AirportProfile;
  /** Max chars for the AI answer */
  maxLength?: number;
}

export interface CompassLayoverAnswer {
  answer: string;
  safetyNote: string | null;
  hardReturnTime: string | null;
  bufferMinutes: number;
  /** Whether the question involves leaving the airport */
  involvesLeaving: boolean;
  /** §12.1 — the single highest-value clarifying question, or null. */
  clarifyingQuestion: ClarifyingQuestion | null;
  /** §12 — envelope-widening the model attempted, if any. Empty is the norm. */
  boundaryViolations: CompassBoundaryViolation[];
  /** §20 — which rules and which inputs produced the figures above. */
  certification: ReturnType<typeof certificationHeader>;
}

const LEAVING_PATTERNS = [
  /leave\s+the\s+airport/i, /go\s+outside/i, /exit\s+the\s+terminal/i,
  /get\s+out/i, /city\s+(tour|trip|visit)/i, /explore\s+(the\s+city|outside)/i,
  /can\s+i\s+(leave|go|exit)/i,
];

function detectLeavingIntent(question: string): boolean {
  return LEAVING_PATTERNS.some((p) => p.test(question));
}

export async function answerLayoverQuestion(
  _db: SupabaseClient,
  input: CompassLayoverInput,
): Promise<CompassLayoverAnswer> {
  const { question, session, airport, maxLength = 400 } = input;

  const now = new Date();
  // ONE certified record. `computeReturnDeadline` is no longer called here:
  // the deadline, the buffer breakdown and the envelope all come out of the
  // same record every other layover surface consumes, so Compass cannot be
  // answering from a different derivation than the screen behind it.
  const record = certifySessionFeasibility(airport, session, { nowMs: now.getTime() });
  const { cutoffMs, breakdown, hardReturnTime } = record.deadline;
  const availMin  = Math.max(0, Math.round((cutoffMs - now.getTime()) / 60000));
  const bufferMin = breakdown.totalBuffer;
  const usableMin = Math.max(0, availMin - bufferMin);

  const involvesLeaving = detectLeavingIntent(question);
  // ONE airport-local rendering of the deadline, used by both fallback paths
  // and by the boundary comparison. It was two, and only one of them was fixed
  // first — which is why the hand-revert of the other stayed green.
  const hardReturnLocal = formatLocalTime(airport.timezone ?? "UTC", hardReturnTime);

  // Build context for AI — city-level only, no exact coords
  const contextLines = [
    `Airport: ${airport.name} (${airport.iataCode}), ${airport.city}, ${airport.country}`,
    `Flight type: ${session.flightType}`,
    `Time available: ${availMin} minutes (usable after buffer: ${usableMin} minutes)`,
    `Required return buffer: ${bufferMin} min (base ${breakdown.baseBuffer}${breakdown.immigrationExtra ? ` + immigration ${breakdown.immigrationExtra}` : ""}${breakdown.bagsExtra ? ` + bags ${breakdown.bagsExtra}` : ""} + traffic ${breakdown.trafficExtra})`,
    `Hard return deadline: ${hardReturnTime.toISOString()} (NEVER reveal exact coordinates — city-level only)`,
    `Immigration required: ${session.immigrationRequired ? "Yes" : "No"}`,
    `Checked bags: ${session.checkedBags ? "Yes" : "No"}`,
    `Comfort level: ${session.comfortLevel}`,
    `Wants to leave airport: ${session.wantsToLeave ? "Yes" : "No"}`,
  ];

  const systemPrompt = `You are Compass, the safety-aware layover advisor inside Portava.
Rules you MUST follow:
- NEVER suggest risky plans if the user has less than ${bufferMin} minutes of usable time.
- NEVER expose exact GPS coordinates, precise addresses, or real-time traffic data.
- Always recommend buffer time (at least ${bufferMin} minutes before departure).
- For leaving-the-airport questions: only recommend it if usable time (${usableMin} min) is enough for round-trip + activity.
- Keep answers concise, practical, and reassuring.
- If the question involves leaving and usable time is under 30 minutes, advise staying in the airport.
- Return ONLY your answer text — no JSON, no markdown headers.`;

  const userPrompt = `Layover context:
${contextLines.join("\n")}

Traveler's question: "${question}"

Answer (max ${maxLength} characters):`;

  let answer: string;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
    });
    answer = (completion.choices[0]?.message?.content ?? "").trim().slice(0, maxLength);
  } catch {
    // Graceful fallback — the same deterministic text the boundary check falls
    // back to, so a refused model answer and an unreachable model produce the
    // identical, certified reply rather than two different ones.
    answer = deterministicAnswer({ involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal });
  }

  // §12 boundary, enforced on the text the model actually produced. A model
  // answer that states a later return deadline or more usable time than the
  // certified record does not get published: it is replaced by the
  // deterministic answer, and the violation travels on the response.
  const bounded = enforceCompassEnvelope(answer, {
    airport,
    hardReturnTime,
    usableMinutes: usableMin,
  });
  const boundaryViolations = bounded.violations;
  const boundedText = bounded.ok
    ? bounded.text
    : deterministicAnswer({ involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal });

  // Strip any coordinates that might have slipped through
  const safeAnswer = sanitizeCompassAnswer(boundedText);

  let safetyNote: string | null = null;
  if (involvesLeaving) {
    if (usableMin < 30) {
      safetyNote = safetyLabel("not_recommended");
    } else if (usableMin < 60) {
      safetyNote = safetyLabel("possible_but_risky");
    } else {
      safetyNote = safetyLabel("safe");
    }
  }

  return {
    answer:         safeAnswer,
    safetyNote,
    hardReturnTime: hardReturnTime.toISOString(),
    bufferMinutes:  bufferMin,
    involvesLeaving,
    // §12.1: at most ONE question, asked only when the answer could move the
    // verdict, the risk band or the usable window. Null when nothing would.
    clarifyingQuestion: nextClarifyingQuestion(airport, session, now.getTime()),
    boundaryViolations,
    certification: certificationHeader(record),
  };
}

/**
 * The certified reply. Used by BOTH the model-unavailable path and the
 * boundary-refusal path, so a traveller cannot tell which failure they hit by
 * the shape of the answer — and neither answer can widen anything, because
 * every figure in it comes from the record.
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
function deterministicAnswer(input: {
  involvesLeaving: boolean;
  usableMin: number;
  availMin: number;
  bufferMin: number;
  /** Pre-formatted in the AIRPORT's timezone. Never a server-locale string. */
  hardReturnLocal: string;
}): string {
  const { involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal } = input;
  if (involvesLeaving && usableMin < 30) {
    return `With only ${usableMin} minutes of usable time after your ${bufferMin}-minute return buffer, I'd recommend staying inside the airport for this one. Grab a meal, relax in a lounge, or browse the shops.`;
  }
  if (involvesLeaving) {
    return `You have about ${usableMin} minutes of usable time. You can leave the airport — but make sure you're back at security by ${hardReturnLocal} to catch your flight safely.`;
  }
  return `You have about ${availMin} minutes until boarding. Your required return buffer is ${bufferMin} minutes, giving you ${usableMin} usable minutes.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 — the boundary, enforced on the model's own words
// ─────────────────────────────────────────────────────────────────────────────

export type CompassBoundaryViolationKind =
  | "return_deadline_widened"
  | "usable_time_widened";

export interface CompassBoundaryViolation {
  kind: CompassBoundaryViolationKind;
  /** The exact substring that violated the certified envelope. */
  stated: string;
  /** The certified value it exceeded. */
  certified: string;
}

/**
 * A clock time in the answer, as minutes past midnight. `null` for anything
 * that does not parse as a wall time.
 */
function clockToMinutes(raw: string): number | null {
  const m = /^(\d{1,2}):(\d{2})\s*(?:([AaPp])\.?[Mm]\.?)?$/.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (min > 59) return null;
  const mer = m[3]?.toLowerCase();
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "a") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  return h * 60 + min;
}

/**
 * §12: Compass "cannot invent or widen the certified safe envelope [or] return
 * deadline".
 *
 * TWO checks, and both are deliberately NARROW, because a guard that fires on
 * innocent sentences gets turned off:
 *
 *   return_deadline_widened — a clock time that the sentence presents as the
 *     time to be BACK or to RETURN by, later than the certified hard return in
 *     the AIRPORT's timezone. The departure time is legitimately later than the
 *     hard return and is mentioned in ordinary answers, so an unqualified
 *     "every clock time" check would refuse correct answers on every layover.
 *     The trigger is the return language, not the digits.
 *
 *   usable_time_widened — a minutes figure the sentence calls USABLE, larger
 *     than the certified usable window. "About 480 minutes until boarding" is
 *     the available window, not the usable one, and is not flagged.
 *
 * Same-day comparison. A hard return that falls after local midnight is not
 * compared at all (`crossesMidnight`), because minute-of-day ordering is
 * meaningless across the wrap and a guard that guesses would refuse honest
 * answers on overnight layovers — the case where refusing costs the most.
 */
export function enforceCompassEnvelope(
  answer: string,
  ctx: { airport: Pick<AirportProfile, "timezone">; hardReturnTime: Date; usableMinutes: number },
): { ok: boolean; text: string; violations: CompassBoundaryViolation[] } {
  const violations: CompassBoundaryViolation[] = [];
  const tz = ctx.airport.timezone ?? "UTC";
  const certifiedLocal = formatLocalTime(tz, ctx.hardReturnTime);
  const certifiedMinutes = clockToMinutes(certifiedLocal);

  // A hard return whose local day differs from "now"'s local day would need
  // date-aware comparison; the answer text carries no date, so it is not
  // compared. Detected by the deadline landing before 04:00 local, the only
  // band in which a same-day reading is more likely wrong than right.
  const crossesMidnight = certifiedMinutes !== null && certifiedMinutes < 4 * 60;

  if (certifiedMinutes !== null && !crossesMidnight) {
    const returnClock = /\b(?:back|return(?:ing)?)\b[^.!?]{0,60}?\b(\d{1,2}:\d{2}\s*(?:[AaPp]\.?[Mm]\.?)?)/g;
    for (const m of answer.matchAll(returnClock)) {
      const stated = clockToMinutes(m[1]);
      if (stated === null) continue;
      if (stated > certifiedMinutes) {
        violations.push({
          kind: "return_deadline_widened",
          stated: m[1].trim(),
          certified: certifiedLocal,
        });
      }
    }
  }

  // Three phrasings, because the deterministic fallback this file has always
  // shipped uses the third one ("giving you 660 usable minutes") and the first
  // draft of this guard missed it — a boundary that cannot police the server's
  // OWN wording is not a boundary.
  //   1. "660 minutes of usable time"
  //   2. "usable time: 660 minutes"
  //   3. "660 usable minutes"
  const usableClaim =
    /(\d{1,4})\s*(?:minutes?|mins?)\b[^.!?]{0,30}?\busable\b|\busable\b[^.!?]{0,30}?(\d{1,4})\s*(?:minutes?|mins?)\b|(\d{1,4})\s*usable\s+(?:minutes?|mins?)\b/gi;
  for (const m of answer.matchAll(usableClaim)) {
    const n = Number(m[1] ?? m[2] ?? m[3]);
    if (!Number.isFinite(n)) continue;
    if (n > ctx.usableMinutes) {
      violations.push({
        kind: "usable_time_widened",
        stated: `${n} minutes usable`,
        certified: `${ctx.usableMinutes} minutes usable`,
      });
    }
  }

  return { ok: violations.length === 0, text: answer, violations };
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
  nowMs: number,
): ClarifyingQuestion[] {
  const base = certifySessionFeasibility(airport, session, { nowMs });
  const out: ClarifyingQuestion[] = [];
  for (const field of CLARIFIABLE_FIELDS) {
    const alt = certifySessionFeasibility(airport, flip(session, field), { nowMs });
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
  nowMs: number,
): ClarifyingQuestion | null {
  return valueOfInformation(airport, session, nowMs)[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 — the twelve deterministic tools
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything a layover tool may read. Assembled by the caller from the same
 * objects the route already has; NOTHING here reads a database, so a tool
 * cannot reach past what the caller was willing to hand it.
 */
export interface LayoverToolContext {
  session: LayoverSession;
  airport: AirportProfile;
  record: LayoverFeasibilityRecord;
  /** Persisted recommendation cards, already privacy-sanitised by the caller. */
  recommendations?: Array<Record<string, unknown>>;
  /** Plan stops, in order. */
  stops?: Array<{ title: string; durationMin: number; travelMin: number; insideAirport: boolean }>;
}

export type LayoverToolName =
  | "getLayoverContext"
  | "getConnectionState"
  | "getTimeWallet"
  | "getSafeEnvelope"
  | "getReachableExperiences"
  | "simulatePlan"
  | "getReturnContract"
  | "getAirportState"
  | "getCrewCandidates"
  | "requestConstraintClarification"
  | "replan"
  | "explainDecision";

/** The §12 tool list, in the spec's order. */
export const LAYOVER_TOOL_NAMES: readonly LayoverToolName[] = [
  "getLayoverContext",
  "getConnectionState",
  "getTimeWallet",
  "getSafeEnvelope",
  "getReachableExperiences",
  "simulatePlan",
  "getReturnContract",
  "getAirportState",
  "getCrewCandidates",
  "requestConstraintClarification",
  "replan",
  "explainDecision",
] as const;

export type LayoverToolResult =
  | { ok: true; tool: LayoverToolName; data: Record<string, unknown> }
  | { ok: false; tool: LayoverToolName; unavailable: true; reason: string };

/**
 * Run one §12 tool.
 *
 * ── THE PROPERTY THAT MAKES THIS A BOUNDARY AND NOT A CONVENIENCE ───────────
 * Every value any tool returns is read out of `ctx.record`, `ctx.session`,
 * `ctx.airport` or the caller-supplied lists. No tool computes a deadline, a
 * buffer, an envelope or a rating; none of them calls the safety engine. So
 * there is no argument a model can pass that makes a tool return a wider
 * envelope than the certified record — the widening the §12 boundary forbids is
 * not merely disallowed, it is unexpressible. `layoverPrivacyCompassContract.test.ts`
 * sweeps every tool against a record and asserts exactly that.
 *
 * Two tools are UNAVAILABLE on this tree and say so instead of inventing an
 * answer: `getCrewCandidates` (no crew storage, census L28) and `replan` (no
 * event-driven replanner, census §11). An unavailable tool is a first-class
 * result, not an error and not an empty success.
 */
export function runLayoverTool(
  tool: LayoverToolName,
  ctx: LayoverToolContext,
  args: Record<string, unknown> = {},
): LayoverToolResult {
  const r = ctx.record;
  const ok = (data: Record<string, unknown>): LayoverToolResult => ({ ok: true, tool, data });
  const no = (reason: string): LayoverToolResult => ({ ok: false, tool, unavailable: true, reason });

  switch (tool) {
    case "getLayoverContext":
      return ok({
        sessionId: ctx.session.id,
        airport: {
          iataCode: ctx.airport.iataCode,
          name: ctx.airport.name,
          city: ctx.airport.city,
          country: ctx.airport.country,
          timezone: ctx.airport.timezone,
          verified: ctx.airport.verified,
        },
        flightType: ctx.session.flightType,
        arrivalTime: ctx.session.arrivalTime,
        departureTime: ctx.session.departureTime,
        boardingTime: ctx.session.boardingTime,
        comfortLevel: ctx.session.comfortLevel,
        wantsToLeave: ctx.session.wantsToLeave,
        certification: certificationHeader(r),
      });

    case "getConnectionState":
      return ok({
        status: ctx.session.status,
        returnState: r.envelope.returnState,
        tier: r.envelope.tier,
        tierLabel: r.envelope.tierLabel,
        // The disruption ladder has no input on this tree; saying "CONNECTION"
        // would assert an operational fact nothing measured.
        disruptionState: null,
        disruptionUnavailableReason: "no_flight_feed",
      });

    case "getTimeWallet":
      return ok({
        totalMinutes: r.envelope.totalMinutes,
        exitDelayMin: r.envelope.exitDelayMin,
        returnBufferMin: r.envelope.returnBufferMin,
        usableMinutes: r.envelope.usableMinutes,
        bufferMinutesAtPercentile: r.bufferMinutesAtPercentile,
        confidence: r.confidence,
      });

    case "getSafeEnvelope":
      return ok({
        hardReturnTime: r.deadline.hardReturnTime.toISOString(),
        earliestOutTime: r.envelope.earliestOutTime.toISOString(),
        usableMinutes: r.envelope.usableMinutes,
        breakdown: r.deadline.breakdown,
        // §8 geometry does not exist on this tree (census L66/L67).
        geometry: null,
        geometryUnavailableReason: "no_envelope_geometry",
        certification: certificationHeader(r),
      });

    case "getReachableExperiences":
      return ok({
        recommendations: ctx.recommendations ?? [],
        // The list is what the recommendation service persisted; this tool does
        // not re-rank it, because ranking is not Compass's to do (§12).
        reranked: false,
      });

    case "simulatePlan": {
      const candidate = Array.isArray(args.candidateSet)
        ? (args.candidateSet as Array<{ durationMin?: number; travelMin?: number; insideAirport?: boolean }>)
        : (ctx.stops ?? []);
      const planned = candidate.reduce(
        (sum, s) => sum + (Number(s.durationMin) || 0) + (Number(s.travelMin) || 0), 0,
      );
      const lastOutside = [...candidate].reverse().find((s) => !s.insideAirport);
      const neededMin = planned + (lastOutside ? (Number(lastOutside.travelMin) || 0) : 0);
      return ok({
        neededMin,
        usableMinutes: r.envelope.usableMinutes,
        fitsWindow: neededMin <= r.envelope.usableMinutes,
        overflowMin: Math.max(0, neededMin - r.envelope.usableMinutes),
        backByTime: r.deadline.hardReturnTime.toISOString(),
      });
    }

    case "getReturnContract":
      return ok({
        hardReturnTime: r.deadline.hardReturnTime.toISOString(),
        hardReturnLocal: formatLocalTime(ctx.airport.timezone ?? "UTC", r.deadline.hardReturnTime),
        returnState: r.envelope.returnState,
        bufferMinutes: r.deadline.breakdown.totalBuffer,
        returnReminderAt: ctx.session.returnReminderAt,
        route: null,
        routeUnavailableReason: "no_routing_provider",
        certification: certificationHeader(r),
      });

    case "getAirportState":
      return ok({
        iataCode: ctx.airport.iataCode,
        verified: ctx.airport.verified,
        // §22 maturity: an unverified profile is L0 airport-side guidance only.
        maturity: ctx.airport.verified ? "curated" : "L0_generic_defaults",
        terminalInfo: ctx.airport.terminalInfo ?? null,
        buffers: {
          domesticBufferMin: ctx.airport.domesticBufferMin,
          internationalBufferMin: ctx.airport.internationalBufferMin,
          immigrationExtraMin: ctx.airport.immigrationExtraMin,
          checkedBagsExtraMin: ctx.airport.checkedBagsExtraMin,
          trafficExtraMin: ctx.airport.trafficExtraMin,
        },
        liveOperationalState: null,
        liveUnavailableReason: "no_airport_intelligence_feed",
      });

    case "getCrewCandidates":
      return no("no_crew_storage");

    case "requestConstraintClarification": {
      const field = String(args.field ?? "");
      const all = valueOfInformation(ctx.airport, ctx.session, r.inputs.nowMs);
      if (!field) {
        return ok({ questions: all, asked: all[0] ?? null });
      }
      const hit = all.find((q) => q.field === field);
      return ok({
        field,
        // §12.1: a field whose answer would not move the outcome is NOT asked.
        worthAsking: Boolean(hit),
        question: hit ?? null,
        unrepresentable: UNREPRESENTABLE_CLARIFICATIONS.find((u) => u.field === field) ?? null,
      });
    }

    case "replan":
      return no("no_event_driven_replanner");

    case "explainDecision":
      return ok({
        inputHash: r.inputHash,
        engineVersion: r.engineVersion,
        feasibilityVersion: r.feasibilityVersion,
        computedAt: r.computedAt,
        verdict: r.verdict,
        confidence: r.confidence,
        reasons: r.reasons,
        unknowns: r.unknowns,
        reasonCodes: r.reasonCodes,
        disclaimer: r.disclaimer,
        estimates: r.estimates,
        inputs: r.inputs,
        // The ids the spec's signature accepts. Nothing persists a snapshot on
        // this tree, so the record's own hash is the only identity there is.
        requestedId: args.snapshotId ?? args.recommendationId ?? null,
      });
  }
}

/**
 * Tool declarations in OpenAI's function-calling shape.
 *
 * DECLARED, NOT YET PASSED TO THE MODEL. Handing these to
 * `openai.chat.completions.create` changes what the model does and therefore
 * what a traveller reads, which on this surface is a change made behind a flag,
 * not as a side effect of adding a schema. `runLayoverTool` is callable today;
 * wiring the model to choose among these is the next step and is named in this
 * lane's report.
 */
export const LAYOVER_TOOL_SCHEMAS = LAYOVER_TOOL_NAMES.map((name) => ({
  type: "function" as const,
  function: {
    name,
    description: `Layover deterministic tool ${name} (spec §12). Reads the certified feasibility record; cannot widen it.`,
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        ...(name === "simulatePlan" ? { candidateSet: { type: "array", items: { type: "object" } } } : {}),
        ...(name === "requestConstraintClarification" ? { field: { type: "string" } } : {}),
        ...(name === "explainDecision"
          ? { snapshotId: { type: "string" }, recommendationId: { type: "string" } }
          : {}),
      },
      required: ["sessionId"],
    },
  },
}));
