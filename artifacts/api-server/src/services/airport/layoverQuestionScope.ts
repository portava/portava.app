/**
 * layoverQuestionScope — which Compass questions a traveller on a live layover
 * may get MODEL prose for, and the certified text everything else gets.
 *
 * LEAD RULING L3-FC (2026-10-07): on a layover session, EVERY question is a
 * leaving question — answered with the certified text only, no model prose —
 * unless an airside allowlist recognises it. The layover dashboard sends
 * travellers to the general Compass chat (`/ai`, `POST /compass/ask`) when its
 * own Telegraph fallback fires, and that door used to put the certified snapshot
 * into the PROMPT only: the model's prose was streamed to the traveller as
 * written, so "can I see the cathedral?" could be answered "it's a short cab
 * away" on a layover the certified check says not to leave.
 *
 * ONE MODULE, SHARED: the allowlist and the certified sentence live here so the
 * general chat (routes/compass.ts) and the layover service can read the same
 * rule. The certified text is a RENDERING of the one certified snapshot
 * (services/airport/LayoverSnapshot `certifiedLayoverSnapshot`) — no figure here
 * is computed, only read off it.
 *
 * THE ALLOWLIST IS DELIBERATELY NARROW, AND FAILS TOWARDS THE CERTIFIED TEXT.
 * A question is airside only when it names an airside facility (gate, lounge,
 * shower, duty free, …) or says "in the airport / terminal", AND it carries no
 * hint of leaving (a place, a mode of transport, "outside", "city", "visit",
 * "go to", …). "How do I get to my gate?" therefore gets the certified text —
 * the safe direction. The same leaving test is applied to the MODEL's answer to
 * an allowlisted question: an answer that drifts into leaving is replaced too.
 */
import type { LayoverSnapshot } from "./LayoverSnapshot.js";

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
 * L3-FC's allowlist: is this question recognisably about something INSIDE the
 * airport? Anything else, on a layover session, is a leaving question.
 */
export function isAirsideLayoverQuestion(question: string): boolean {
  const q = String(question ?? "").trim();
  if (q === "") return false;
  if (mentionsLeaving(q)) return false;
  return AIRSIDE_FACILITY.test(q) || INSIDE_PHRASE.test(q);
}

/** The certified snapshot fields the text is rendered from. */
export type CertifiedTextSnapshot = Pick<
  LayoverSnapshot,
  "verdict" | "usableMinutes" | "minutesToHardReturn" | "landsideOpen" | "landsideStatus" | "landsideCautions" | "landsideClosedReason"
>;

const STAY_INSIDE = "I'd recommend staying inside the airport: grab a meal, relax in a lounge, or browse the shops.";
const STAY_INSIDE_TAIL = "staying inside the airport is the safe choice: grab a meal, relax in a lounge, or browse the shops.";

/**
 * The certified answer to a leaving question, read off the snapshot. It says
 * "you can leave" ONLY when the certified gate is open (verdict yes on a
 * confirmed border, nothing closed it) and there are at least 30 usable minutes;
 * every other state — refused, closed, unconfirmed, too little time, a status
 * this build does not know — advises staying inside. Every figure is the
 * snapshot's.
 */
export function certifiedLayoverAnswerText(s: CertifiedTextSnapshot): string {
  const back = `be back at security within ${Math.max(0, Math.floor(s.minutesToHardReturn))} minutes`;
  if (s.verdict === "no" || s.landsideStatus === "closed") {
    return `Leaving the airport is not recommended on this layover — the certified check for it says no. ${STAY_INSIDE}`;
  }
  if (s.landsideStatus === "caution" || !s.landsideOpen) {
    const why = s.landsideCautions.length ? ` (${s.landsideCautions.join(", ")})` : "";
    return `Leaving the airport has not been confirmed as possible on this layover${why}. ${STAY_INSIDE}`;
  }
  if (s.usableMinutes < 30) {
    return `With only ${Math.max(0, Math.floor(s.usableMinutes))} minutes of usable time, ${STAY_INSIDE_TAIL}`;
  }
  return `You have about ${Math.floor(s.usableMinutes)} minutes of usable time, and the certified check allows leaving the airport — ${back} to catch your flight safely. Your layover screen lists only the options that fit.`;
}
