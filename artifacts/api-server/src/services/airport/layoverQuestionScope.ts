/**
 * layoverQuestionScope — what the general Compass chat may say to a traveller on
 * a live layover, and the certified text it says instead of model prose.
 *
 * LEAD RULING L3-FC-3 (2026-10-07, supersedes the allowlist approach of L3-FC
 * on a live layover): on a live layover whose certified verdict is not an
 * EXPLICIT yes (`certifiedLeavingAllowed` below — caution, tight,
 * entry_unverified, stay_airside, closed, too little time, a value this build
 * does not know), EVERY question — airside or not — gets the certified text and
 * the deterministic airport facts only (`certifiedLayoverAnswerWithFacts`), and
 * no model is called, the intent classifier included. A live layover whose
 * verdict could not be computed (the airport profile unreadable) gets
 * `LAYOVER_VERDICT_UNREADABLE_MESSAGE`, again with no model. Only on an explicit
 * yes does the model answer, and then the certified text leads its answer.
 *
 * WHY THE ALLOWLIST WENT. L3-FC let a question naming an airside facility reach
 * the model and replaced the answer only if a leaving vocabulary matched it. The
 * wave-6 verifier (V-L6c F1) took that with a facility word and a paraphrase:
 * "Which gate is mine, and can I pop out for dinner first?" was admitted by
 * `gate`, and "the riverside quarter is a 15-minute ride by car" matched nothing.
 * A vocabulary cannot carry a safety boundary in every language; the verdict can.
 *
 * WHERE THE ALLOWLIST STAYS. LEAD RULING L3-FC-2: when the layover session store
 * itself cannot be read, nobody knows whether this is a layover at all, so
 * refusing every question would refuse every traveller during a store outage. A
 * question outside the airside allowlist gets the retryable
 * `LAYOVER_STATE_UNREADABLE_MESSAGE` (no model); an airside one proceeds. That
 * door alone still reads `isAirsideLayoverQuestion`, which since V-L6c F1 also
 * refuses a question with a second clause (a comma, a conjunction, a second
 * sentence) — still a vocabulary, failing towards the refusal.
 *
 * ONE MODULE, SHARED: the predicate, the certified sentence and the facts live
 * here so the general chat (routes/compass.ts) and the layover service can read
 * the same rule. Everything is a RENDERING of the one certified snapshot
 * (services/airport/LayoverSnapshot `certifiedLayoverSnapshot`) — no figure here
 * is computed, only read off it.
 */
import type { LayoverSnapshot } from "./LayoverSnapshot.js";
import { formatLocalTime, isValidTimezone } from "./AirportTime.js";

/** Facilities and phrases that only exist airside. */
const AIRSIDE_FACILITY =
  /\b(?:lounges?|gates?|boarding(?: pass(?:es)?)?|showers?|restrooms?|toilets?|bathrooms?|wi-?fi|charg(?:e|er|ers|ing)(?: points?| stations?)?|duty[- ]free|transfer (?:desk|counter)s?|transit (?:desk|counter|area|hotel)s?|prayer rooms?|sleep(?:ing)? (?:pods?|areas?)|lost and found|security (?:line|queue|check|wait)s?|airside)\b/i;
const INSIDE_PHRASE = /\b(?:in|inside|within) (?:the |this )?(?:airport|terminal|concourse)\b/i;

/** Anything that suggests leaving the airport. Matched on the question AND on an allowlisted answer. */
const LEAVING_HINT =
  /\b(?:leav(?:e|ing)|outside|exit(?:ing)?|landside|out of (?:the|this) airport|city|downtown|town|centre|center|visa|immigration|customs|taxis?|cabs?|uber|grab|trains?|metro|subway|bus(?:es)?|ferry|tours?|explor\w*|visit\w*|sightsee\w*|museums?|cathedrals?|churches|church|temples?|shrines?|beach(?:es)?|markets?|parks?|old town|walk\w*|hotels?|nearby|near (?:the|this) airport|around (?:the|this) airport|go(?:ing)? (?:to|out|into|see)|get(?:ting)? (?:to|out|into)|head(?:ing)? (?:to|out|into)|venture\w*|beyond (?:the|this) (?:airport|terminal))\b/i;

/** Does this text suggest leaving the airport? (A transit hotel is airside.) */
export function mentionsLeaving(text: string): boolean {
  return LEAVING_HINT.test(String(text ?? "").replace(/\btransit hotels?\b/gi, " "));
}

/**
 * A second clause: a comma, semicolon or colon, a conjunction (English and the
 * commonest European ones), or a second sentence. V-L6c F1: "Which gate is mine,
 * and can I pop out for dinner first?" was admitted by `gate`; the clause after
 * the facility word is where the leaving question hides.
 */
const SECOND_CLAUSE = /[,;:]|[?.!]\s*\S|\b(?:and|also|then|plus|or|but|after|before|afterwards|later|und|oder|dann|et|ou|puis|luego|poi)\b/i;
/**
 * The single-letter conjunctions (Spanish y/o, Italian/Portuguese e). A gate or
 * lounge NAMED by a letter — "Where is gate E?", "Is the Y lounge open?",
 * "lounge O" — is not a second clause (V-L6d F6), so in a question that has
 * lower-case letters only a LOWER-case y/o/e counts, and in an all-caps question
 * (where case says nothing) an upper-case one does. Either way it counts before
 * ANY following letter or digit — "y a qué hora", "e a che ora", "y 20 minutos"
 * (V-L6e N2: requiring a following word of two or more letters, and lower case
 * only, let "y a …" and "DÓNDE ESTÁ EL LOUNGE Y PUEDO IR AL CENTRO" through).
 * What still passes: a lone upper-case Y/O/E inside a mixed-case question
 * ("Where is the lounge Y can I …"), which is exactly how a letter-named gate is
 * written. This door is a vocabulary (L3-FC-2) and fails towards the refusal.
 */
const SINGLE_LETTER_CONJUNCTION = /(?:^|\s)[yoe](?=\s+[\p{L}\p{N}])/u;
const SINGLE_LETTER_CONJUNCTION_CAPS = /(?:^|\s)[YOE](?=\s+[\p{L}\p{N}])/u;
const HAS_LOWER_CASE = /\p{Ll}/u;

/**
 * L3-FC-2's allowlist (an unreadable session store only — L3-FC-3 put a live
 * layover on the verdict instead): is this question recognisably about ONE thing
 * INSIDE the airport? A question with a second clause, or any hint of leaving,
 * is not.
 */
export function isAirsideLayoverQuestion(question: string): boolean {
  const q = String(question ?? "").trim();
  if (q === "") return false;
  if (mentionsLeaving(q)) return false;
  if (SECOND_CLAUSE.test(q) || SINGLE_LETTER_CONJUNCTION.test(q)) return false;
  if (!HAS_LOWER_CASE.test(q) && SINGLE_LETTER_CONJUNCTION_CAPS.test(q)) return false; // all caps: case cannot tell a gate's letter from the conjunction
  return AIRSIDE_FACILITY.test(q) || INSIDE_PHRASE.test(q);
}

/**
 * Lead ruling L3-FC-2 (2026-10-07): the layover session store could not be read.
 * A question outside the airside allowlist is not answered at all (no model
 * call) — it gets this retryable sentence; an airside question proceeds as normal.
 */
export const LAYOVER_STATE_UNREADABLE_MESSAGE = "We can't check your layover right now. Please try again in a moment.";

/**
 * Lead ruling L3-FC-3 (2026-10-07): a LIVE layover whose certified verdict could
 * not be computed (the airport profile is unreadable, so no snapshot exists).
 * Every question gets this — retryable, no model — and, because the traveller is
 * known to be on a layover, the safe advice with it.
 */
export const LAYOVER_VERDICT_UNREADABLE_MESSAGE = `${LAYOVER_STATE_UNREADABLE_MESSAGE} Until it can be checked, I'd recommend staying inside the airport.`;

/** The certified snapshot fields the text is rendered from. */
export type CertifiedTextSnapshot = Pick<
  LayoverSnapshot,
  "verdict" | "usableMinutes" | "minutesToHardReturn" | "landsideStatus" | "landsideCautions" | "landsideClosedReason"
>;

const STAY_INSIDE = "I'd recommend staying inside the airport: grab a meal, relax in a lounge, or browse the shops.";
const STAY_INSIDE_TAIL = "staying inside the airport is the safe choice: grab a meal, relax in a lounge, or browse the shops.";

/**
 * THE ONE PREDICATE for "the certified check positively allows leaving": verdict
 * `yes`, the three-valued landside gate `open`, and at least 30 usable minutes,
 * every figure a finite number. Everything else — refused, closed, cautionary,
 * `tight`, `entry_unverified`, `stay_airside`, a verdict or status this build
 * does not know, too little time, a NaN envelope — is NOT a yes. It reads
 * `landsideStatus`, never the `landsideOpen` boolean (the layover suite's
 * ratchet: a reader that knows only the boolean cannot tell a caution from an
 * open gate). V-L6c F6: the sentence below used to say "allows leaving" for any
 * verdict on an open gate, because it never read the verdict.
 */
export function certifiedLeavingAllowed(s: CertifiedTextSnapshot): boolean {
  return s.verdict === "yes" && s.landsideStatus === "open"
    && Number.isFinite(s.usableMinutes) && s.usableMinutes >= 30
    && Number.isFinite(s.minutesToHardReturn);
}

/**
 * The certified answer to a leaving question, read off the snapshot. It says
 * "you can leave" ONLY when `certifiedLeavingAllowed` holds; every other state —
 * refused, closed, unconfirmed, too little time, a status or verdict this build
 * does not know, an unreadable figure — advises staying inside. Every figure is
 * the snapshot's.
 */
export function certifiedLayoverAnswerText(s: CertifiedTextSnapshot): string {
  if (s.verdict === "no" || s.landsideStatus === "closed") {
    return `Leaving the airport is not recommended on this layover — the certified check for it says no. ${STAY_INSIDE}`;
  }
  if (certifiedLeavingAllowed(s)) {
    return `You have about ${Math.floor(s.usableMinutes)} minutes of usable time, and the certified check allows leaving the airport — be back at security within ${Math.max(0, Math.floor(s.minutesToHardReturn))} minutes to catch your flight safely. Your layover screen lists only the options that fit.`;
  }
  if (s.verdict === "yes" && s.landsideStatus === "open" && Number.isFinite(s.usableMinutes) && s.usableMinutes < 30) {
    return `With only ${Math.max(0, Math.floor(s.usableMinutes))} minutes of usable time, ${STAY_INSIDE_TAIL}`;
  }
  const why = s.landsideStatus === "caution" && s.landsideCautions.length ? ` (${s.landsideCautions.join(", ")})` : "";
  return `Leaving the airport has not been confirmed as possible on this layover${why}. ${STAY_INSIDE}`;
}

/** The snapshot fields the airport facts are read from. */
export type AirportFactsSnapshot = Pick<LayoverSnapshot, "hardReturnBy" | "minutesToHardReturn" | "returnState" | "certifiedRecord">;

const RETURN_STATE_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  RETURN_SOON: "It is nearly time to head back.",
  RETURN_NOW: "It is time to head back now.",
  CONNECTION_AT_RISK: "Your connection is at risk: head back now, and contact your airline if you need help.",
});

/**
 * L3-FC-3's deterministic airport facts, every one read off the certified
 * snapshot: the airport, boarding and departure in the airport's own time, the
 * latest time to be back at security (the certified hard return-by) and how far
 * away it is, and the Safe Return state when it is past NORMAL. A figure that
 * cannot be read is left out, never rendered as NaN or a guess; a timezone that
 * is not a real zone is stated as UTC rather than as "airport time".
 */
export function layoverAirportFacts(s: AirportFactsSnapshot): string {
  const inputs: any = (s as any)?.certifiedRecord?.inputs ?? {};
  const tz: string | null = typeof inputs.airport?.timezone === "string" && isValidTimezone(inputs.airport.timezone) ? inputs.airport.timezone : null;
  const at = (iso: unknown): string | null => {
    if (typeof iso !== "string" || iso === "") return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return tz ? `${formatLocalTime(tz, d)} airport time` : `${d.toISOString().slice(11, 16)} UTC`;
  };
  const code = typeof inputs.airport?.iataCode === "string" && /^[A-Z]{3}$/.test(inputs.airport.iataCode) && inputs.airport.iataCode !== "UNK" ? inputs.airport.iataCode : null;
  const parts: string[] = [];
  const boarding = at(inputs.session?.boardingTime);
  const departs = at(inputs.session?.departureTime);
  const flight = [boarding ? `boarding is at ${boarding}` : null, departs ? `your flight departs at ${departs}` : null].filter(Boolean).join(" and ");
  if (flight) parts.push(code ? `At ${code}, ${flight}.` : `${flight.charAt(0).toUpperCase()}${flight.slice(1)}.`);
  const back = at(s.hardReturnBy);
  if (back) {
    const mins = Number.isFinite(s.minutesToHardReturn) ? ` (about ${Math.max(0, Math.floor(s.minutesToHardReturn))} minutes from now)` : "";
    parts.push(`The latest time to be back at security is ${back}${mins}.`);
  }
  const state = RETURN_STATE_SENTENCE[String(s.returnState)];
  if (state) parts.push(state);
  return parts.join(" ");
}

/**
 * L3-FC-3: the whole answer on a live layover that is not an explicit yes — the
 * certified text, then the airport facts. No model prose, ever.
 */
export function certifiedLayoverAnswerWithFacts(s: CertifiedTextSnapshot & AirportFactsSnapshot): string {
  const facts = layoverAirportFacts(s);
  return facts ? `${certifiedLayoverAnswerText(s)}\n\n${facts}` : certifiedLayoverAnswerText(s);
}
