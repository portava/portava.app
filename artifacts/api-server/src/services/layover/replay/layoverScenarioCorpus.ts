/**
 * The synthetic scenario corpus behind `check:layover-decision-diff` —
 * census-layover L241, Layover spec §21.2: "Decision-diff CI comparing old/new
 * engine behavior over historical/synthetic corpora."
 *
 * ── WHAT WAS ALREADY BUILT, AND WHAT WAS MISSING ────────────────────────────
 * The DIFF existed: `services/airport/layoverReplay.ts` `decisionDiffCorpus`
 * compares two decision corpora and reports verdict flips and deadline moves in
 * each direction, and `test/layoverReplayDeterminism.test.ts` proves it can go
 * red. What did not exist was anything for it to run over in CI: no corpus, no
 * recorded baseline and no check. So an engine change that moved a traveller's
 * deadline later reached `main` with nothing printing that it had.
 *
 * This file is the corpus. Every scenario is a row of §21.1's "minimum
 * deterministic scenario matrix" that the engine on this tree can REPRESENT,
 * plus the airport-model and clock variations the census asked for (L219,
 * L220, L227, L228). The rows it cannot represent are named in
 * `UNREPRESENTED_SCENARIOS` rather than approximated — a scenario faked out of
 * the nearest representable inputs would make the golden record a claim about
 * a case the engine never saw.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 * Every instant is a constant derived from `CORPUS_EPOCH_MS`; the engine reads
 * no clock (`LayoverFeasibility.ts`). Running the corpus twice on any machine
 * produces byte-identical decisions — asserted by the suite, because a corpus
 * that drifts on its own is a diff that is always red and therefore ignored.
 *
 * WHAT A DECISION IS HERE: the §20 `DecisionRecord` (`layoverLedger.ts`
 * `decisionRecordFor`) — verdict, confidence, tier, return state, window
 * rating, hard return, total buffer, usable minutes, shortfall, reason codes,
 * rules applied, input facts and source refs. A landside probe's own rating is
 * not a §20 result field; its RULES are (`probe.unmeasured`,
 * `probe.requiredIsLowerBound`, `probe.traveller_stated`), so a change to how a
 * probe is assessed is caught as a rule change.
 *
 * HISTORICAL corpora are the other half of §21.2's sentence and are NOT built:
 * they need stored decisions (`layover_certified_computations`, migration 2700,
 * unapplied). When that table has rows, `decisionDiffCorpus` runs over them
 * unchanged.
 */
import {
  certifyFeasibility,
  feasibilityInputs,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LandsideProbe,
} from "../../airport/LayoverFeasibility.js";
import type { LiveConditions } from "../../airport/LayoverSafetyEngine.js";
import type { EntryEligibility } from "../../airport/layoverEntryGate.js";
import type { SessionConstraintContext } from "../../airport/LayoverConstraints.js";
import { decisionRecordFor, type DecisionRecord } from "../../airport/layoverLedger.js";

/** 2026-10-01T02:00:00Z — 10:00 in Taipei, nowhere near a local midnight. */
export const CORPUS_EPOCH_MS = Date.UTC(2026, 9, 1, 2, 0, 0);

const MIN = 60_000;
const at = (offsetMin: number) => new Date(CORPUS_EPOCH_MS + offsetMin * MIN).toISOString();

/** The repository's generic constants — what every production airport runs on today (census L243). */
const GENERIC_TPE: FeasibilityAirport = {
  id: null, iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
  checkedBagsExtraMin: 15, trafficExtraMin: 20,
};

/** A curated profile for the same airport — the L220 airport-model variation. */
const CURATED_TPE: FeasibilityAirport = {
  id: "corpus-airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
  domesticBufferMin: 45, internationalBufferMin: 90, immigrationExtraMin: 20,
  checkedBagsExtraMin: 10, trafficExtraMin: 15,
};

const GENERIC_HND: FeasibilityAirport = {
  id: null, iataCode: "HND", timezone: "Asia/Tokyo", verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30,
  checkedBagsExtraMin: 15, trafficExtraMin: 20,
};

const PERMITTED: EntryEligibility = {
  state: "permitted", corridor: { passportCountry: "US", destinationCountry: "TW" }, status: "visa_free",
};
const REFUSED: EntryEligibility = {
  state: "refused", corridor: { passportCountry: "XX", destinationCountry: "TW" }, status: "visa_required",
};
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

const LIVE_BASE: Omit<LiveConditions, "securityWaitExtraMin" | "immigrationWaitExtraMin" | "groundTransportExtraMin"> = {
  reasonCodes: [], observedAt: at(0), expiresAt: at(20),
};

export interface LayoverScenario {
  /** Stable id — the diff matches scenarios on it. Never renamed; retire and add instead. */
  id: string;
  /** The §21.1 row, census row or variation this scenario stands for. */
  source: string;
  airport: FeasibilityAirport;
  session: Omit<FeasibilitySession, "id">;
  nowMs: number;
  entry: EntryEligibility | null;
  liveConditions?: LiveConditions | null;
  landsideProbe?: LandsideProbe | null;
  /** §4 / §6.1 (PR #588): the declared constraint set and the entry policy. Absent = legacy (nothing declared, policy off). */
  constraints?: SessionConstraintContext | null;
}

function session(arriveMin: number, departMin: number, over: Partial<FeasibilitySession> = {}): Omit<FeasibilitySession, "id"> {
  return {
    arrivalTime: at(arriveMin), departureTime: at(departMin), boardingTime: null,
    flightType: "international", immigrationRequired: true, checkedBags: false, wantsToLeave: true,
    ...over,
  };
}

const NOW = CORPUS_EPOCH_MS + 20 * MIN;

/** A DECLARED §4 constraint set, version 1, with the owner's entry policy OFF unless stated. */
function declared(over: { baggageMode: "CHECKED_THROUGH" | "COLLECT_RECHECK" | "CARRY_ON_ONLY" | "UNKNOWN"; recheckRequired?: boolean | null; airportChangeRequired?: boolean | null }, entryForbidsLandside = false): SessionConstraintContext {
  return {
    read: "declared",
    set: { version: 1, baggageMode: over.baggageMode, recheckRequired: over.recheckRequired ?? null, airportChangeRequired: over.airportChangeRequired ?? null, declaredAt: at(0) },
    entryForbidsLandside,
  };
}

export const LAYOVER_SCENARIOS: readonly LayoverScenario[] = [
  { id: "s01-2h-domestic", source: "§21.1 2h domestic → airport-only (census L219)",
    airport: GENERIC_TPE, session: session(0, 120, { flightType: "domestic", immigrationRequired: false }), nowMs: NOW, entry: PERMITTED },
  { id: "s02-4h-international-permitted-generic", source: "§21.1 4h international, visa allowed (census L220)",
    airport: GENERIC_TPE, session: session(0, 240), nowMs: NOW, entry: PERMITTED },
  { id: "s03-4h-international-permitted-curated", source: "§21.1 4h international, curated airport model (census L220)",
    airport: CURATED_TPE, session: session(0, 240), nowMs: NOW, entry: PERMITTED },
  { id: "s04-5h-international-generic", source: "census L220 — same session, generic airport",
    airport: GENERIC_TPE, session: session(0, 300), nowMs: NOW, entry: PERMITTED },
  { id: "s05-5h-international-curated", source: "census L220 — same session, curated airport",
    airport: CURATED_TPE, session: session(0, 300), nowMs: NOW, entry: PERMITTED },
  { id: "s06-6h-visa-free", source: "§21.1 6h visa-free → landside + return contract (census L221)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED },
  { id: "s07-5h-checked-bags-recheck", source: "§21.1 5h self-transfer — recheck charged as checked bags (baggage mode is #588's)",
    airport: GENERIC_TPE, session: session(0, 300, { checkedBags: true }), nowMs: NOW, entry: PERMITTED },
  { id: "s08-overnight", source: "§21.1 overnight (census L223)",
    airport: GENERIC_TPE, session: session(13 * 60, 23 * 60), nowMs: CORPUS_EPOCH_MS + (13 * 60 + 20) * MIN, entry: PERMITTED },
  { id: "s09-arrival-delay", source: "§21.1 arrival delay → freedom shrinks (pair with s06)",
    airport: GENERIC_TPE, session: session(90, 360), nowMs: CORPUS_EPOCH_MS + 110 * MIN, entry: PERMITTED },
  { id: "s10-departure-delay", source: "§21.1 departure delay → freedom may expand (pair with s06)",
    airport: GENERIC_TPE, session: session(0, 450), nowMs: NOW, entry: PERMITTED },
  { id: "s11-security-spike", source: "§21.1 security spike → envelope contracts (census L227, pair with s06)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    liveConditions: { ...LIVE_BASE, securityWaitExtraMin: 40, immigrationWaitExtraMin: 0, groundTransportExtraMin: 0 } },
  { id: "s12-traffic-spike", source: "§21.1 traffic spike → return deadline earlier (census L228, pair with s06)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    liveConditions: { ...LIVE_BASE, securityWaitExtraMin: 0, immigrationWaitExtraMin: 0, groundTransportExtraMin: 30 } },
  { id: "s13-entry-unresolved", source: "§21.1 unknown entry permission (census L48/L230)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: UNRESOLVED },
  { id: "s14-entry-refused", source: "§6.1 entry refused overrides the clock (census L48)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: REFUSED },
  { id: "s15-entry-not-resolved-by-caller", source: "an absent entry fact is unresolved, never permitted (census §45)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: null },
  { id: "s16-stay-airside", source: "traveller does not want to leave",
    airport: GENERIC_TPE, session: session(0, 360, { wantsToLeave: false }), nowMs: NOW, entry: PERMITTED },
  // 25 minutes before s06's hard return (+178): inside a 30-minute RETURN_SOON
  // lead and outside a 20-minute one, so the corpus pins RETURN_SOON_LEAD_MIN.
  { id: "s17-return-soon", source: "§15 RETURN_SOON rung — clock 25 min before s06's hard return",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: CORPUS_EPOCH_MS + 153 * MIN, entry: PERMITTED },
  { id: "s23-return-now", source: "§15 RETURN_NOW rung — clock 4 min past s06's hard return",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: CORPUS_EPOCH_MS + 182 * MIN, entry: PERMITTED },
  { id: "s18-past-hard-return", source: "§15 RETURN_NOW / CONNECTION_AT_RISK — clock past the hard return",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: CORPUS_EPOCH_MS + 250 * MIN, entry: PERMITTED },
  { id: "s19-boarding-time-wins", source: "boarding time earlier than departure is the cutoff",
    airport: GENERIC_TPE, session: session(0, 360, { boardingTime: at(320) }), nowMs: NOW, entry: PERMITTED },
  { id: "s20-landside-probe-unmeasured-leg", source: "a landside journey nobody measured fails closed (census L9/L65)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    landsideProbe: { title: "corpus probe", travelTimeMin: null, activityTimeMin: 60, travelTimeSource: "unmeasured" } },
  { id: "s21-landside-probe-stated-leg", source: "a traveller-stated leg is certified as a stated figure, never as routed",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    landsideProbe: { title: "corpus probe", travelTimeMin: 30, activityTimeMin: 60, travelTimeSource: "traveller_stated" } },
  // The clock AT touchdown, so the whole exit delay is still ahead and is
  // charged. With the clock 20 minutes in, a domestic exit delay shorter than
  // 20 minutes is already spent and no change to it can move a decision.
  { id: "s24-3h-domestic-at-touchdown", source: "exit delay charged in full — domestic, clock at arrival",
    airport: GENERIC_TPE, session: session(0, 180, { flightType: "domestic", immigrationRequired: false }), nowMs: CORPUS_EPOCH_MS, entry: PERMITTED },
  // ── §4 / §6.1 rows that became representable with PR #588 (LAY-01) ──
  { id: "s25-unknown-baggage", source: "§21.1 Unknown baggage → fail closed if critical (Appendix B.2: 4h45m, baggage mode UNKNOWN — one ticket, same airport, so the bag is B.2's ONE unknown)",
    airport: GENERIC_TPE, session: session(0, 285), nowMs: NOW, entry: PERMITTED,
    constraints: declared({ baggageMode: "UNKNOWN", recheckRequired: false, airportChangeRequired: false }) },
  { id: "s26-checked-through", source: "Appendix B.2 step 5 — the same session once the bag is confirmed CHECKED_THROUGH",
    airport: GENERIC_TPE, session: session(0, 285), nowMs: NOW, entry: PERMITTED,
    constraints: declared({ baggageMode: "CHECKED_THROUGH", recheckRequired: false, airportChangeRequired: false }) },
  { id: "s27-airport-change", source: "§21.1 Airport change → exploration subordinate to transfer (census L224)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    constraints: declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: true }) },
  { id: "s28-self-transfer-recheck-declared", source: "§21.1 5h self-transfer → recheck friction included, DECLARED (census L222)",
    airport: GENERIC_TPE, session: session(0, 300, { checkedBags: true }), nowMs: NOW, entry: PERMITTED,
    constraints: declared({ baggageMode: "COLLECT_RECHECK", recheckRequired: true }) },
  { id: "s29-entry-unresolved-policy-on", source: "§21.1 Unknown entry permission → no landside recommendation, with the owner's entry policy ON (census L230)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: UNRESOLVED,
    constraints: { read: "undeclared", set: null, entryForbidsLandside: true } },
  { id: "s30-constraints-unreadable", source: "an unreadable constraint store charges the bag as UNKNOWN, never 'no bags' (census L35)",
    airport: GENERIC_TPE, session: session(0, 360), nowMs: NOW, entry: PERMITTED,
    constraints: { read: "unreadable", set: null, entryForbidsLandside: false } },
  // #624: "not sure" is not "no". s26's bag answer with the ticketing and the airport change left UNSTATED.
  { id: "s31-checked-through-tickets-unstated", source: "§21.1 5h self-transfer → recheck friction included, separate tickets NOT stated: charged, and decisive (App C1; #624)",
    airport: GENERIC_TPE, session: session(0, 285), nowMs: NOW, entry: PERMITTED,
    constraints: declared({ baggageMode: "CHECKED_THROUGH" }) },
  { id: "s22-hnd-6h", source: "Appendix B.1 — normal 6-hour international layover at HND",
    airport: GENERIC_HND, session: session(0, 360), nowMs: NOW, entry: { ...PERMITTED, corridor: { passportCountry: "US", destinationCountry: "JP" } } },
];

/**
 * §21.1 rows this engine cannot represent, and why. Recorded so the corpus's
 * coverage is a stated fact rather than an inference from what is missing.
 */
export const UNREPRESENTED_SCENARIOS: readonly { row: string; why: string }[] = [
  { row: "Flight cancellation", why: "the disruption chain is LayoverSafeReturnService's, not the feasibility record's (census L148)" },
  { row: "Crew mixed departures", why: "the crew solver is LayoverCrewService's, not the feasibility record's (census L133/L232)" },
  { row: "Offline after leaving", why: "a client cache, not an engine decision (census L233)" },
];

/** Run one scenario through the engine and project it onto the §20 decision record. */
export function decideScenario(s: LayoverScenario): DecisionRecord {
  const sessionId = `corpus:${s.id}`;
  const record = certifyFeasibility(feasibilityInputs(s.airport, { id: sessionId, ...s.session }, {
    nowMs: s.nowMs,
    entry: s.entry,
    liveConditions: s.liveConditions ?? null,
    landsideProbe: s.landsideProbe ?? null,
    ...(s.constraints !== undefined ? { constraints: s.constraints } : {}),
  }));
  return decisionRecordFor(sessionId, record);
}

export function runLayoverScenarioCorpus(scenarios: readonly LayoverScenario[] = LAYOVER_SCENARIOS): DecisionRecord[] {
  return scenarios.map(decideScenario);
}
