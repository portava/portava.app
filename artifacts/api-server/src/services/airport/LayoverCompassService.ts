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
// `getOpenAI()`, not the bare `openai` export. The bare export is the real
// client always, so this file could not be driven with a model answer in a
// test — which meant the §12 boundary below could only ever be exercised
// against strings handed to it directly, and nothing proved the PRODUCTION
// path passed the certified verdict to it. It does now, and
// `__tests__/layoverCompassEntryBoundary.test.ts` drives a widening answer
// through this function to prove it.
import { getOpenAI } from "../../lib/openai.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { LayoverSession } from "./LayoverSessionService.js"; import type { EntryEligibility } from "./layoverEntryGate.js"; import type { LayoverSnapshot } from "./LayoverSnapshot.js";
import {
  safetyLabel,
  type LayoverReturnState,
  type LeaveAdvice,
  type SafetyRating,
} from "./LayoverSafetyEngine.js";
import {
  certifySessionFeasibility,
  certificationHeader,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LayoverFeasibilityRecord,
} from "./LayoverFeasibility.js";
import { type PlanFitStop } from "./LayoverPlanFit.js"; import { certifiedPlanFit } from "./LayoverConstraints.js";
import { formatLocalTime } from "./AirportTime.js";
import { sanitizeCompassAnswer } from "./LayoverPrivacyGuard.js";

export interface CompassLayoverInput {
  question: string;
  session: LayoverSession;
  airport: AirportProfile;
  /** Max chars for the AI answer */
  maxLength?: number;
  /**
   * The two caller-owned halves of the §12 tool context. Nothing in this file
   * reads a database, so a tool can only ever see what the route handed it —
   * which is the property that makes `runLayoverTool` a boundary rather than a
   * convenience, and the reason these are parameters and not a fetch.
   *
   * EACH CARRIES ITS READ OUTCOME, NOT JUST ITS ROWS. `recommendations: []`
   * from a failed read and `recommendations: []` from a layover with nothing
   * worth doing are the same value and opposite claims (census L294), so the
   * absent case is spelled as a reason rather than as an empty array.
   */
  recommendations?: Array<Record<string, unknown>>;
  recommendationsUnavailableReason?: string | null;
  stops?: LayoverToolContext["stops"];
  stopsUnavailableReason?: string | null; /** The session owner's corridor, resolved by the route (`resolveLayoverEntry`) as the snapshot resolves it — census-discovery §65. Omitted = unresolved. */ entry?: EntryEligibility | null; /** census-discovery §81: the certified snapshot, when the route read one — its record and its usable minutes are then the answer's, and nothing is re-derived here. */ snapshot?: LayoverSnapshot | null; /** census-layover §48 L110: the route's block-cleared crew read, with its OUTCOME — a failed read travels as a reason, never as []. Omitted = not read. */ crew?: import("../layover/LayoverCrewVisibility.js").CompassCrewCandidates;
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
  /**
   * §12 — the deterministic tools the model actually invoked, in order, for
   * THIS answer. Empty when the model answered from the context alone, which
   * is the common case. A name only appears here if `runLayoverTool` ran it and
   * answered `ok`; a refusal (unknown name, unreadable table, unavailable tool)
   * is deliberately NOT listed, because the point of the list is to say what
   * the sentence above rests on.
   */
  toolsConsulted: LayoverToolName[];
  /**
   * What became of the model's prose (lead ruling 2026-10-06, census L3/L101):
   *   "certified_only"    — the session's certified verdict is not `yes`, OR the
   *                         question is about leaving (lead ruling on the wave-2
   *                         verification, F2): no model text is shown; the
   *                         answer is the server's;
   *   "confined"          — a non-leaving question whose model answer named a
   *                         safety topic: the certified text leads, and only
   *                         the model sentences that name none follow it;
   *   "model_non_safety"  — the question was not about leaving and the model's
   *                         answer named no safety topic: shown as written.
   * `droppedSentences` counts model sentences withheld for naming a topic.
   */
  modelProse: { mode: "certified_only" | "confined" | "model_non_safety"; droppedSentences: number };
}

/**
 * THE FIVE SAFETY TOPICS — lead ruling 2026-10-06 on census-layover L3/L101:
 * "for the five safety topics, Compass layover answers use deterministic,
 * certified server text. Model text that touches those topics is replaced by
 * that text, never shown. AI is not a safety dependency."
 *
 * The topics are L101's nouns — the envelope / time, the return deadline,
 * visa / entry status, operational state, and the risk band (leaving, safety).
 * A sentence is withheld when it NAMES any of them at all, which is §50.1's own
 * test for `C`; it is not asked whether the sentence is cautious, hedged or
 * correct. That is the difference from the deny-list in
 * `enforceCompassEnvelope`, which stays and still reports what the model
 * attempted, but no longer decides what is shown.
 *
 * Over-withholding is the designed failure: "the food hall past security" is
 * withheld because "security" is an operational noun, and the traveller reads
 * the certified sentence instead.
 */
const SAFETY_TOPIC_PATTERNS: readonly RegExp[] = [
  // envelope / time / return deadline
  /\b(?:time|minutes?|mins?|hours?|hrs?|window|plenty|loads|lots|rush|rushing|hurry|quick(?:ly)?|late|later|earlier|early|longer|soon|deadline|return(?:ing)?|back|in\s+time|make\s+it|countdown|buffer)\b/i,
  // visa / entry
  /\b(?:visas?|visa-free|entry|enter|permits?|passports?|immigration|customs|border|transit)\b/i,
  // operational state
  /\b(?:queues?|lines?|wait(?:s|ing)?|security|delay(?:s|ed)?|on\s+time|gates?|boarding|board|flights?|planes?|depart(?:s|ure|ing)?|takeoff|traffic|crowd(?:s|ed)?|busy|closed|open)\b/i,
  // risk band / leaving
  /\b(?:safe(?:ly)?|unsafe|risk(?:y)?|danger(?:ous)?|recommend(?:ed)?|leave|leaving|landside|outside|city|town|downtown|explore|exploring|head\s+(?:out|into)|go\s+out)\b/i,
];

export function namesSafetyTopic(sentence: string): boolean {
  return SAFETY_TOPIC_PATTERNS.some((p) => p.test(sentence));
}

/** Sentences, kept with their own punctuation. A fragment with no terminator is one sentence. */
export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/g) ?? []).map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * Compose what the traveller reads. `certified` is the server's deterministic
 * answer; nothing in it came from the model.
 */
export function confineModelProse(input: {
  modelText: string;
  certified: string;
  verdict: string;
  involvesLeaving: boolean;
}): { answer: string; modelProse: CompassLayoverAnswer["modelProse"] } {
  const sentences = splitSentences(input.modelText);
  if (input.verdict !== "yes") {
    // A refused, tight or unconfirmed session: any landside suggestion the
    // model wrote — named or implied — would widen the band. None is shown.
    return { answer: input.certified, modelProse: { mode: "certified_only", droppedSentences: sentences.length } };
  }
  if (input.involvesLeaving) {
    // A question about LEAVING (lead ruling on the wave-2 verification, F2):
    // every sentence the model writes in answer is a safety sentence, whatever
    // words it uses. The topic list below is a vocabulary, and "ample margin to
    // venture beyond the terminal" names none of it. So on a leaving question
    // the certified text is the whole answer — decided by the question, never
    // by the model's phrasing.
    return { answer: input.certified, modelProse: { mode: "certified_only", droppedSentences: sentences.length } };
  }
  const kept = sentences.filter((x) => !namesSafetyTopic(x));
  const dropped = sentences.length - kept.length;
  if (dropped === 0 && !input.involvesLeaving && kept.length > 0) {
    return { answer: kept.join(" "), modelProse: { mode: "model_non_safety", droppedSentences: 0 } };
  }
  const answer = kept.length > 0 ? `${input.certified} ${kept.join(" ")}` : input.certified;
  return { answer, modelProse: { mode: "confined", droppedSentences: dropped } };
}

const LEAVING_PATTERNS = [
  /leave\s+the\s+airport/i, /go\s+outside/i, /exit\s+the\s+terminal/i,
  /get\s+out/i, /city\s+(tour|trip|visit)/i, /explore\s+(the\s+city|outside)/i,
  /can\s+i\s+(leave|go|exit)/i,
  // Widened with the lead's ruling L3-FC (2026-10-07). A question that names
  // leaving in ANY of these words is a leaving question even when it also
  // names something airside ("eat downtown before my flight").
  /\bleav(e|es|ing)\b/i, /\blandside\b/i, /\bdown\s*town\b/i, /\btown\b/i, /\bcity\b/i,
  /\boutside\b/i, /\bpop\s+out\b/i, /\bhead\s+(out|into)\b/i, /\breachable\b/i,
  /\bmake\s+it\s+to\b/i, /\bexplor(e|ing)\b/i, /\bvisit(ing)?\b/i, /\bsightsee/i,
];

/**
 * LEAD RULING L3-FC (2026-10-07, on the second verification of wave 2): on a
 * layover session EVERY question is a leaving question — certified server text
 * only — unless this AIRSIDE allowlist positively recognises it. The leaving
 * detector alone failed OPEN: 14 of the verifier's 16 leaving phrasings ("Is it
 * safe to leave?", "Can we leave?", "Should I head downtown?") were not leaving
 * questions to it, and each published the model's prose with no certified text.
 * An allowlist fails CLOSED: a phrasing nobody listed gets the certified answer.
 * The list names things that exist inside a terminal; a pharmacy only when the
 * question puts it in the terminal.
 */
const AIRSIDE_PATTERNS = [
  /\b(eat|eating|food|foods|meal|meals|breakfast|lunch|dinner|snacks?|restaurants?|food\s*court|dining)\b/i,
  /\b(drinks?|drinking|coffee|tea|bars?|water)\b/i,
  /\blounges?\b/i,
  /\bwi-?fi\b|\binternet\b/i,
  /\bshowers?\b/i,
  /\bcharg(e|er|ers|ing)\b|\b(power\s+)?(outlets?|sockets?)\b/i,
  /\b(shop|shops|shopping|duty[-\s]?free|souvenirs?)\b/i,
  /\bgates?\b/i,
  /\b(restrooms?|toilets?|bathrooms?|washrooms?)\b/i,
  /\b(sleep|sleeping|nap|naps|sleep\s*pods?|quiet\s+(area|zone|room))\b/i,
  /\bpharmac(y|ies)\b[^?]*\b(terminal|airside)\b|\b(terminal|airside)\b[^?]*\bpharmac(y|ies)\b/i,
  /\b(pray|prayer\s+rooms?|chapel)\b/i,
  /\bsmok(e|ing)\b/i,
];

function detectLeavingIntent(question: string): boolean {
  return LEAVING_PATTERNS.some((p) => p.test(question));
}

/** Positively an airside question: an allowlisted subject, and no leaving word. */
export function isAirsideQuestion(question: string): boolean {
  return !detectLeavingIntent(question) && AIRSIDE_PATTERNS.some((p) => p.test(question));
}

/** L3-FC: everything that is not positively airside is treated as a leaving question. */
export function treatAsLeavingQuestion(question: string): boolean {
  return !isAirsideQuestion(question);
}

export async function answerLayoverQuestion(
  _db: SupabaseClient,
  input: CompassLayoverInput,
): Promise<CompassLayoverAnswer> {
  const { question, session, airport, maxLength = 400 } = input;

  const now = new Date(input.snapshot ? input.snapshot.certifiedRecord.inputs.nowMs : Date.now()); // §81: the snapshot's instant, not a second clock
  // ONE certified record. `computeReturnDeadline` is no longer called here:
  // the deadline, the buffer breakdown and the envelope all come out of the
  // same record every other layover surface consumes, so Compass cannot be
  // answering from a different derivation than the screen behind it.
  const record = input.snapshot?.certifiedRecord ?? certifySessionFeasibility(airport, session, { nowMs: now.getTime(), entry: input.entry ?? null });
  const { cutoffMs, breakdown, hardReturnTime } = record.deadline;
  const availMin  = input.snapshot ? Math.max(0, input.snapshot.minutesToHardReturn + breakdown.totalBuffer) : Math.max(0, Math.round((cutoffMs - now.getTime()) / 60000)); // §81: ON, the clock too is read off the snapshot
  const bufferMin = breakdown.totalBuffer;
  const usableMin = input.snapshot ? input.snapshot.usableMinutes : Math.max(0, availMin - bufferMin);

  const involvesLeaving = treatAsLeavingQuestion(question); // lead ruling L3-FC: fail closed — only a positively airside question escapes certified-only
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
    `Wants to leave airport: ${session.wantsToLeave ? "Yes" : "No"}`, `Certified landside verdict: ${record.verdict}${record.verdict === "no" ? " (do NOT suggest leaving the airport)" : ""}`,
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

  // ── §12 — THE TOOLS ARE OFFERED, CHOSEN AND RUN ───────────────────────────
  //
  // This is the line every recount of census L102–L113 has turned on. The
  // twelve tools were declared and callable for four passes and the model was
  // never given them, so twelve requirements read `W` on the distinction
  // between a function and a tool. `LAYOVER_TOOL_SCHEMAS` now travels on the
  // request and `runLayoverTool` executes whatever comes back.
  //
  // NOTHING ABOUT THE SAFETY BOUNDARY CHANGES, and that is why this needed no
  // flag. Every tool reads out of `record`, `session`, `airport` or the
  // caller-supplied lists; none of them computes a deadline, a buffer or an
  // envelope. So the widest thing a tool can hand the model is the certified
  // record itself, and the answer the model writes from it still goes through
  // `enforceCompassEnvelope` below exactly as before.
  const toolCtx: LayoverToolContext = {
    session, airport, record,
    recommendations: input.recommendations,
    recommendationsUnavailableReason: input.recommendationsUnavailableReason ?? null,
    stops: input.stops,
    stopsUnavailableReason: input.stopsUnavailableReason ?? null, crew: input.crew,
  };
  const toolsConsulted: LayoverToolName[] = [];
  let answer: string;
  try {
    answer = await runModelWithTools({
      systemPrompt, userPrompt, maxLength, ctx: toolCtx, consulted: toolsConsulted,
    });
  } catch {
    // Graceful fallback — the same deterministic text the boundary check falls
    // back to, so a refused model answer and an unreachable model produce the
    // identical, certified reply rather than two different ones.
    answer = "";
  }
  if (!answer) {
    // An empty completion is a model failure that does not throw, and it used
    // to be published as an empty `answer` string. A model that spends every
    // round calling tools and never writes a sentence lands here too.
    answer = deterministicAnswer({ involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal, refused: record.verdict === "no" });
  }

  // §12 boundary, enforced on the text the model actually produced. A model
  // answer that states a later return deadline or more usable time than the
  // certified record does not get published: it is replaced by the
  // deterministic answer, and the violation travels on the response.
  const bounded = enforceCompassEnvelope(answer, {
    airport,
    hardReturnTime,
    usableMinutes: usableMin,
    // The CERTIFIED verdict, from the same record the deadline came from. The
    // risk-band check is inert without it, so this argument is what makes
    // census L101's third noun enforced rather than declared.
    verdict: record.verdict,
  });
  const boundaryViolations = bounded.violations;
  // The deny-list above still REPORTS what the model attempted; what is SHOWN
  // is decided here, by topic, not by phrasing (lead ruling, census L3/L101).
  const certifiedText = deterministicAnswer({ involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal, refused: record.verdict === "no" });
  const confined = confineModelProse({
    modelText: bounded.ok ? bounded.text : "",
    certified: certifiedText,
    verdict: record.verdict,
    involvesLeaving,
  });

  // Strip any coordinates that might have slipped through
  const safeAnswer = sanitizeCompassAnswer(confined.answer);

  let safetyNote: string | null = null;
  if (involvesLeaving) {
    if (usableMin < 30 || record.verdict === "no") {
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
    clarifyingQuestion: nextClarifyingQuestion(airport, session, now.getTime(), record.inputs.entry),
    boundaryViolations,
    certification: certificationHeader(record),
    toolsConsulted,
    modelProse: confined.modelProse,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// §12 — the tool loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many times the model may come back asking for another tool.
 *
 * A model that answers a tool result with another tool call is normal; a model
 * that does it forever is a request that never returns, on a route a traveller
 * is holding a phone in front of. Four rounds is enough for "what is my
 * deadline, does my plan fit, what is reachable" and is bounded, and the
 * traveller gets the certified deterministic answer if the budget runs out —
 * never an empty string, and never a hang.
 */
const MAX_TOOL_ROUNDS = 4;

/**
 * One chat turn, plus up to `MAX_TOOL_ROUNDS` tool rounds, returning the text
 * the model finally wrote (possibly empty — the caller decides what an empty
 * answer means).
 *
 * THE FAILURE PATHS ARE THE POINT, so they are listed rather than inferred:
 *
 *  - a tool name the model invented        → `unknown_tool:<name>`, fed back
 *  - `arguments` that are not JSON         → `malformed_tool_arguments`, fed back
 *  - a tool that is unavailable on this tree → its own reason, fed back
 *
 * None of them throws and none of them ends the conversation. A hallucinated
 * function name must cost the traveller a sentence, not their answer: the
 * refusal goes back to the model as a tool result and it gets another round to
 * say something true. Only a throw from the model client itself reaches the
 * caller's catch.
 */
async function runModelWithTools(args: {
  systemPrompt: string;
  userPrompt: string;
  maxLength: number;
  ctx: LayoverToolContext;
  consulted: LayoverToolName[];
}): Promise<string> {
  const { systemPrompt, userPrompt, maxLength, ctx, consulted } = args;
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    const completion = await getOpenAI().chat.completions.create({
      model: "gpt-5-mini",
      max_completion_tokens: 300,
      messages,
      tools: LAYOVER_TOOL_SCHEMAS,
      tool_choice: "auto",
    } as any);

    const message: any = completion.choices[0]?.message ?? {};
    const calls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (calls.length === 0 || round === MAX_TOOL_ROUNDS) {
      return String(message.content ?? "").trim().slice(0, maxLength);
    }

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
    for (const c of calls) {
      const result = runNamedLayoverTool(c?.function?.name, ctx, c?.function?.arguments);
      if (result.ok) consulted.push(result.tool);
      messages.push({
        role: "tool",
        tool_call_id: String(c?.id ?? ""),
        content: JSON.stringify(result),
      });
    }
  }
  return "";
}

/**
 * `runLayoverTool` behind the two checks a model-chosen call needs and a
 * caller-chosen one does not: is this a tool at all, and are the arguments
 * parseable?
 *
 * Kept separate from `runLayoverTool` so that the twelve-tool sweep in
 * `layoverPrivacyCompassContract.test.ts` still exercises the boundary itself,
 * and so that "the model made this name up" is a distinguishable outcome rather
 * than a `TypeError` in a switch.
 */
export function runNamedLayoverTool(
  name: unknown,
  ctx: LayoverToolContext,
  rawArgs: unknown,
): LayoverToolResult | { ok: false; tool: string; unavailable: true; reason: string } {
  const candidate = String(name ?? "");
  if (!(LAYOVER_TOOL_NAMES as readonly string[]).includes(candidate)) {
    return { ok: false, tool: candidate, unavailable: true, reason: `unknown_tool:${candidate || "(unnamed)"}` };
  }
  const tool = candidate as LayoverToolName;

  let parsed: Record<string, unknown> = {};
  if (typeof rawArgs === "string" && rawArgs.trim() !== "") {
    try {
      const j = JSON.parse(rawArgs);
      if (j && typeof j === "object" && !Array.isArray(j)) parsed = j as Record<string, unknown>;
      else return { ok: false, tool, unavailable: true, reason: "malformed_tool_arguments" };
    } catch {
      return { ok: false, tool, unavailable: true, reason: "malformed_tool_arguments" };
    }
  } else if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    parsed = rawArgs as Record<string, unknown>;
  }

  return runLayoverTool(tool, ctx, parsed);
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
  hardReturnLocal: string; /** The CERTIFIED verdict is `no` — a refused border or no time (census-discovery §65). */ refused?: boolean;
}): string {
  const { involvesLeaving, usableMin, availMin, bufferMin, hardReturnLocal, refused } = input; if (involvesLeaving && refused) return "Leaving the airport is not recommended on this layover — the certified check for it says no. I'd recommend staying inside the airport: grab a meal, relax in a lounge, or browse the shops.";
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

/**
 * The whole violation vocabulary, declared once so a new check cannot invent a
 * spelling and so a test can count them. Two were built by §18, two by §19.5;
 * the fifth, `operational_state_asserted`, is L101's last noun (end of file).
 */
export const COMPASS_BOUNDARY_KINDS = [
  "return_deadline_widened",
  "usable_time_widened",
  "entry_status_asserted",
  "risk_band_widened", "operational_state_asserted",
] as const;

export type CompassBoundaryViolationKind = (typeof COMPASS_BOUNDARY_KINDS)[number];

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
  ctx: {
    airport: Pick<AirportProfile, "timezone">;
    hardReturnTime: Date;
    usableMinutes: number;
    /**
     * The CERTIFIED §9 verdict for this session. Optional only so that a caller
     * which genuinely holds no verdict (there is none today) is not forced to
     * invent one — when it is absent the risk-band check does not run, which is
     * the direction a missing input must fail for a guard that REFUSES.
     */
    verdict?: LeaveAdvice["verdict"];
  },
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

  // ── census L101: VISA / ENTRY STATUS ───────────────────────────────────────
  //
  // "Visa/entry is not a field at all on main, so a model assertion about it is
  // unconstrained by anything." When this guard was written nothing on this
  // tree read entry permission at all; `resolveLayoverEntry` now does, and
  // `adviseLeaving` emits `ENTRY_NOT_CONFIRMED` where its condition applies
  // rather than on every session.
  //
  // THIS GUARD DID NOT RELAX WITH IT, on purpose. Entry permission is not part
  // of what this envelope certifies, and the corridor table it would come from
  // ships a standing disclaimer of its own (`lib/entryRequirements.ts`
  // HONESTY CONTRACT). A model sentence asserting the permission is therefore
  // still unconstrained by anything the envelope holds, whatever the corridor
  // says — and this is the one question whose wrong answer ends with a
  // traveller refused at a border.
  //
  // NEGATION-AWARE, and that is the whole difficulty. "You won't need a visa"
  // is an assertion; "we can't confirm whether you need a visa" is the truth
  // the server itself publishes, and a guard that refuses the second would be
  // switched off inside a week. The rule is therefore: an entry/visa sentence
  // trips ONLY when it is not hedged by an uncertainty marker or a
  // check-it-yourself instruction.
  for (const m of answer.matchAll(ENTRY_ASSERTION)) {
    const sentence = m[0];
    if (ENTRY_HEDGE.test(sentence)) continue;
    violations.push({
      kind: "entry_status_asserted",
      stated: sentence.trim().slice(0, 140),
      certified: "ENTRY_NOT_CONFIRMED — entry permission is not certified by this envelope",
    });
  }

  // ── census L101 / L3: THE RISK BAND ────────────────────────────────────────
  //
  // ONE-DIRECTIONAL BY CONSTRUCTION. Talking the band DOWN ("it is not safe to
  // leave") is always allowed — a model may be more cautious than the record,
  // never less. Only an upgrade is a widening, so the trigger is an explicit
  // permission phrase on a session the record did not certify as `yes`.
  if (ctx.verdict !== undefined && ctx.verdict !== "yes") {
    for (const m of answer.matchAll(SAFE_TO_LEAVE)) {
      const sentence = m[0];
      if (NEGATED_SAFETY.test(sentence)) continue;
      violations.push({
        kind: "risk_band_widened",
        stated: sentence.trim().slice(0, 140),
        certified: `certified verdict: ${ctx.verdict}`,
      });
    }
  }

  violations.push(...operationalStateViolations(answer)); return { ok: violations.length === 0, text: answer, violations }; // L101/L3 fifth noun, defined at the end of this file
}

/**
 * A sentence that mentions entry, a visa or a transit permit. Sentence-scoped
 * (`[^.!?]*`) so the hedge test below reads the SAME sentence rather than the
 * whole answer — an answer that hedges once and asserts twice must still trip.
 */
const ENTRY_ASSERTION =
  /[^.!?]*\b(?:visas?|visa-free|permits?|entry\s+requirements?|immigration\s+clearance|enter\s+the\s+country)\b[^.!?]*[.!?]?/gi;

/**
 * The hedges that make an entry sentence honest rather than an assertion: an
 * admission of not knowing, or an instruction to verify.
 *
 * `may`, `might` and `could` are DELIBERATELY ABSENT. They read as hedges in
 * English generally and as PERMISSION in exactly this context — "you may enter
 * without a visa" is the assertion this guard exists to catch, not a hedge of
 * it. Leaving them out makes the guard refuse a few honest sentences and never
 * pass a permission claim, which is the direction a refusal must fail.
 */
const ENTRY_HEDGE =
  /\b(?:can(?:'|’)?t|cannot|can\s+not|don(?:'|’)?t|do\s+not|unable\s+to|not\s+able\s+to|unknown|unsure|uncertain|we\s+have\s+not|haven(?:'|’)?t|check|verify|confirm\s+with|depends?)\b/i;

/** An explicit permission to go landside. */
const SAFE_TO_LEAVE =
  /[^.!?]*\b(?:safe\s+to\s+(?:leave|go|head\s+out)|you\s+can\s+safely\s+(?:leave|go)|plenty\s+of\s+time|go\s+ahead\s+and\s+leave|you(?:'|’)?ll\s+easily\s+make\s+it)\b[^.!?]*[.!?]?/gi;

/** …unless the sentence is a refusal wearing the same words. */
const NEGATED_SAFETY =
  /\b(?:not|isn(?:'|’)?t|is\s+not|don(?:'|’)?t|do\s+not|won(?:'|’)?t|rather\s+than|instead\s+of|avoid)\b/i;

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
  /**
   * Why the card list is absent, when it is. `null`/absent means the caller
   * READ the table and this is what was in it; a string means the read failed
   * and the tool must refuse rather than report an empty shortlist.
   */
  recommendationsUnavailableReason?: string | null;
  /** Plan stops, in order. */
  stops?: Array<{ title: string; durationMin: number; travelMin: number; insideAirport: boolean }>;
  /** Same distinction for the plan. Zero stops fit every window (census L47). */
  stopsUnavailableReason?: string | null; /** §48 L110: crew candidates as the route read them (block-cleared, no user ids); `ok: false` = the read failed. Absent = not read. */ crew?: import("../layover/LayoverCrewVisibility.js").CompassCrewCandidates;
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
 * One tool is UNAVAILABLE on this tree and says so instead of inventing an
 * answer: `replan` (no event-driven replanner, census §11); `getCrewCandidates`
 * refuses only when its crew read failed or was not handed over (§48). An
 * unavailable tool is a first-class result, not an error and not an empty success.
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
      // An unreadable `layover_recommendations` is not an empty shortlist.
      // Answering `[]` here would tell a traveller sitting in a terminal that
      // there is nothing worth their four hours, on the strength of a failed
      // SELECT — the exact substitution census L294 forbids, and the one the
      // route's own reader already refuses to make.
      if (ctx.recommendationsUnavailableReason) return no(ctx.recommendationsUnavailableReason);
      return ok({
        recommendations: ctx.recommendations ?? [],
        // The list is what the recommendation service persisted; this tool does
        // not re-rank it, because ranking is not Compass's to do (§12).
        reranked: false,
      });

    case "simulatePlan": {
      const modelSuppliedSet = Array.isArray(args.candidateSet);
      // Zero stops fit every window, so "your plan fits" computed from a failed
      // read of `layover_plan_stops` is a certification made out of nothing
      // (census L47; `loadStops`' own doc comment says the same in the route).
      // A candidate set the MODEL supplied is still answerable — it does not
      // come from the table — so only the stored-plan branch refuses.
      if (!modelSuppliedSet && ctx.stopsUnavailableReason) return no(ctx.stopsUnavailableReason);
      const candidate: PlanFitStop[] = modelSuppliedSet
        ? (args.candidateSet as PlanFitStop[])
        : (ctx.stops ?? []);
      // The same arithmetic, the same refusal AND THE SAME GATE as the plan
      // routes — `certifiedPlanFit`, the one function all three plan surfaces
      // call (census L47; the gate half is LAY-FIX). The clock half used to be
      // the whole answer, so a plan through the city "fit" under a refused
      // border. A stop with no `insideAirport: true` is a landside stop: a
      // model-supplied candidate that omits the field is not read as airside.
      const f = certifiedPlanFit(r, candidate);
      return ok({
        neededMin: f.neededMin, usableMinutes: f.usableMinutes,
        fitsWindow: f.fitsWindow,
        fit: f.fit, clockFit: f.clockFit,
        landsideStatus: f.landside.status, landsideClosedBy: f.landside.closedBy, landsideCautions: f.landside.cautions,
        unstatedTravelStops: f.unstatedTravelStops,
        neededMinIsLowerBound: f.neededMinIsLowerBound,
        overflowMin: f.overflowMin,
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
      return !ctx.crew ? no("crew_candidates_not_read") : ctx.crew.ok ? ok({ ...ctx.crew.value }) : no(ctx.crew.reason); // §48 L110 — was a false no("no_crew_storage")

    case "requestConstraintClarification": {
      const field = String(args.field ?? "");
      const all = valueOfInformation(ctx.airport, ctx.session, r.inputs.nowMs, r.inputs.entry);
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
 * PASSED TO THE MODEL, on every `POST /api/airport/sessions/:id/compass`.
 * `runModelWithTools` above puts this array on the request and executes what
 * comes back through `runNamedLayoverTool`.
 *
 * ── WHY THIS IS NOT BEHIND A FLAG ───────────────────────────────────────────
 * An earlier version of this comment said handing these to the model "is a
 * change made behind a flag", and twelve census requirements (L102–L113) sat
 * `W` behind that sentence for four passes. The sentence was cautious about the
 * wrong thing. A flag seeded FALSE would have left the tools exactly as dark as
 * they were while reading as if the work were done.
 *
 * What makes the wiring safe is structural rather than operational: no tool
 * computes anything. Every value any of them returns is read out of the
 * certified record, the session, the airport profile or a caller-supplied list,
 * so the widest answer the model can obtain from a tool IS the certified
 * record — and the sentence it then writes still passes through
 * `enforceCompassEnvelope`, which refuses a later deadline, more usable time,
 * an entry-permission claim or a widened risk band whatever the model read.
 * The blast radius of the tools is therefore bounded by the same guard that
 * already bounded the toolless answer.
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

// ─────────────────────────────────────────────────────────────────────────────
// §12 — census L101 / L3: OPERATIONAL STATE, the fifth noun
// ─────────────────────────────────────────────────────────────────────────────
//
// Appended here rather than written inline in `enforceCompassEnvelope` so that
// no line above moves: census-compass and census-layover cite this file by line
// number (`:812`, `:848`, `:986`, `:1053`), and a guard that shifted them would
// have made four correct citations false to add one check.

/**
 * §19.5 left exactly one of L101's five nouns open: *"a model that asserts the
 * security queue is short, or that a terminal transfer is running, is still
 * unconstrained, and there is no certified operational state to compare it
 * against."*
 *
 * There is NO certified operational state on this tree: `getAirportState`
 * publishes `liveOperationalState: null` with `liveUnavailableReason:
 * "no_airport_intelligence_feed"`, there is no flight-status feed
 * (`flightStatus: unavailable("no_flight_feed")`), and `terminal_info` is null on
 * every production airport. So a sentence stating the CURRENT state of a queue,
 * a flight, a gate or a transfer train is invented by construction.
 *
 * It is also the most dangerous kind of invention this surface can make: "your
 * flight is delayed an hour" or "security is quick right now" tells the
 * traveller they have MORE time than the certified window, in words the
 * deadline check cannot see because no clock time is named.
 *
 * NARROW, like the other four checks: the trigger is a present-state predicate
 * on a dynamic subject ("the queue is short", "the train is running", "your
 * gate is B12"), not a mention of security or a train. "Be back at security by
 * 18:00", "there is a transit hotel in Terminal 2" and "allow time for the
 * queue" all pass. A hedged or general sentence ("security can be slow at peak
 * times", "we have no live queue data", "check the departures board") is advice
 * rather than a claim of state, and passes.
 *
 * When a certified live feed exists one day, a sentence restating it will be
 * refused until this check is taught to compare against it. That is the
 * direction a refusal must fail: the deterministic answer is published
 * instead, never an uncertified claim.
 */
export function operationalStateViolations(answer: string): CompassBoundaryViolation[] {
  const out: CompassBoundaryViolation[] = [];
  for (const m of answer.matchAll(OPERATIONAL_STATE_ASSERTION)) {
    const sentence = m[0];
    if (OPERATIONAL_HEDGE.test(sentence)) continue;
    out.push({
      kind: "operational_state_asserted",
      stated: sentence.trim().slice(0, 140),
      certified: "no certified operational state — liveOperationalState is null (no_airport_intelligence_feed, no_flight_feed)",
    });
  }
  return out;
}

/**
 * Up to forty characters of the same sentence between a subject and its verb —
 * "the SkyTrain between terminals is running", "the queue at Terminal 1 is
 * short" — never crossing a sentence end, so a subject in one sentence cannot
 * pair with a predicate in the next.
 */
const SUBJECT_GAP = String.raw`[^.!?]{0,40}?\s`;

/** Present-state claims about something dynamic at an airport. */
const OPERATIONAL_STATE_CLAIMS: readonly string[] = [
  // queue / wait state
  String.raw`\b(?:no|short|small|quick|fast|light|minimal|zero)\s+(?:queues?|lines?|waits?|wait\s+times?)\b`,
  String.raw`\b(?:queues?|lines?|waits?|wait\s+times?)\b${SUBJECT_GAP}(?:is|are|looks?|seems?|(?:'|’)s)\s+(?:currently\s+|now\s+|pretty\s+|really\s+|very\s+)?(?:short|quick|fast|light|minimal|empty|moving\s+(?:quickly|fast)|not\s+(?:bad|long|busy))\b`,
  // a checkpoint's present state or duration
  String.raw`\b(?:security|immigration|passport\s+control|customs|check-?in)\b${SUBJECT_GAP}(?:is|are|looks?|seems?|(?:'|’)s)\s+(?:currently\s+|now\s+|pretty\s+|really\s+|very\s+)?(?:quick|fast|empty|quiet|clear|not\s+busy|moving\s+(?:quickly|fast)|a\s+breeze)\b`,
  String.raw`\b(?:security|immigration|passport\s+control|customs)\s+(?:only|just)\s+takes?\b`,
  String.raw`\b(?:security|immigration|passport\s+control|customs)\s+takes?\s+(?:only|just)\b`,
  // flight status — "delayed" WIDENS the window, the most dangerous claim here
  String.raw`\b(?:flight|connection|departure)\b${SUBJECT_GAP}(?:is|has\s+been|was|(?:'|’)s|isn(?:'|’)t|is\s+not|hasn(?:'|’)t\s+been)\s+(?:currently\s+|now\s+)?(?:on\s+time|delayed|cancell?ed|on\s+schedule|running\s+late|boarding)\b`,
  String.raw`\bgate\s+(?:is|has\s+(?:changed|moved)\s+to|will\s+be|(?:'|’)s)\s+(?:now\s+)?[a-z]?\d{1,3}[a-z]?\b`,
  String.raw`\bboarding\s+(?:has\s+(?:started|begun)|is\s+(?:open|underway)|(?:starts|begins)\s+(?:late|later))\b`,
  // transport running status
  String.raw`\b(?:trains?|shuttles?|sky\s*train|people\s+mover|monorail|airport\s+express|express\s+train|metro|mrt|subway|tram|bus(?:es)?)\b${SUBJECT_GAP}(?:is|are|(?:'|’)s)\s+(?:currently\s+|still\s+|now\s+)?(?:running|operating|on\s+(?:time|schedule)|in\s+service)\b`,
  // crowding
  String.raw`\b(?:airport|terminal|security|immigration)\b${SUBJECT_GAP}(?:is|(?:'|’)s)\s+(?:currently\s+|pretty\s+|really\s+|very\s+)?(?:quiet|empty|dead|not\s+(?:busy|crowded))\b`,
  String.raw`\b(?:airport|terminal|security|immigration)\b${SUBJECT_GAP}(?:isn(?:'|’)t|is\s+not)\s+(?:currently\s+|very\s+)?(?:busy|crowded|packed)\b`,
];

/**
 * The SENTENCE carrying a claim. Sentence-scoped for the same reason as
 * `ENTRY_ASSERTION`: the hedge test reads the same sentence, so an answer that
 * hedges once and asserts twice still trips.
 */
const OPERATIONAL_STATE_ASSERTION = new RegExp(
  String.raw`[^.!?]*(?:` + OPERATIONAL_STATE_CLAIMS.join("|") + String.raw`)[^.!?]*[.!?]?`,
  "gi",
);

/**
 * What makes an operational sentence advice rather than a claim: not knowing,
 * an instruction to check, a modal, a generality, or a condition. `may`,
 * `might` and `could` are hedges HERE (contrast `ENTRY_HEDGE`, where "you may
 * enter" is the permission being caught). `normally` is deliberately NOT one:
 * "the SkyTrain is operating normally" is a status claim. Bare `don't`/`can't`
 * are not either — "security is quick, so don't rush" is a claim with a
 * negation in it — only the not-knowing forms are.
 */
const OPERATIONAL_HEDGE =
  /\b(?:can(?:'|’)?t\s+(?:see|confirm|know|tell|check|verify|guarantee)|cannot\s+(?:see|confirm|know|tell|check|verify|guarantee)|don(?:'|’)?t\s+(?:know|have|see)|do\s+not\s+(?:know|have|see)|unable\s+to|not\s+able\s+to|unknown|unsure|uncertain|no\s+live|not\s+live|check|verify|confirm|ask|may|might|could|usually|typically|generally|often|sometimes|tends?\s+to|varies|vary|depends?|information|data|feed|reports?|if)\b/i;
