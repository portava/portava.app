/**
 * LAY-FIX — the landside gate FAILS CLOSED.
 *
 * PR #588 (LAY-01) merged with an independent verification of FAIL. Every case
 * below is one of that verification's scenarios, driven through the entry point
 * the routes call (`certifySessionFeasibility`) and then through the surfaces
 * that tell a traveller they can leave: the lifecycle state, the plan fit, the
 * Compass `simulatePlan` tool and the crew solver.
 *
 * THE RULE: an unknown, unreadable or undeclared input never produces an open
 * gate or a green affirmative. "Open" is the verdict `yes` and nothing else —
 * entry CONFIRMED_ALLOWED, the window not tight, no critical unknown.
 *
 * ── WHAT WOULD LET THIS PASS WITHOUT THE PROPERTY ───────────────────────────
 *  * A gate that closes everything. Each closing case has a sibling on the SAME
 *    window that must be open (`CONTROL:`), and the sweep counts both.
 *  * Fixtures that never reach a verdict. `everyVerdict()` refuses to return
 *    until the real engine has produced all five, and the exhaustiveness type
 *    below fails the build the day the union grows.
 *  * A plan-fit check on an airside-only plan. Every blocked case has a stop
 *    OUTSIDE the airport, and an airside-only plan on the same record must
 *    still fit.
 *
 * Run: node --import tsx/esm --test src/test/layoverGateFailClosed.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  certifySessionFeasibility,
  certifyFeasibilityWithReturnCorridor,
  feasibilityInputs,
  replayFeasibility,
  type FeasibilityAirport,
  type LayoverFeasibilityRecord,
} from "../services/airport/LayoverFeasibility.js";
import type { LeaveAdvice, ReturnCorridorRisk } from "../services/airport/LayoverSafetyEngine.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import {
  AIRPORT_CHANGE_UNKNOWN_REASON,
  CONSTRAINTS_UNREADABLE_REASON,
  LANDSIDE_CAUTIONS,
  LANDSIDE_CLOSURES,
  certifiedPlanFit,
  constraintQuestion,
  landsideStatusOf,
  layoverStateOf,
  type LandsideGate,
  type SessionConstraintContext,
} from "../services/airport/LayoverConstraints.js";
import { certifyCrewPlan, unsplitPlan, type CrewMember } from "../services/airport/LayoverCrewService.js";
import { runLayoverTool, type LayoverToolContext } from "../services/airport/LayoverCompassService.js";
import { decisionRecordFor, LEDGER_RULE_NAMESPACES } from "../services/airport/layoverLedger.js";
import { constraintsPayload } from "../services/layover/LayoverConstraintService.js";
// The CLIENT's own wording, imported rather than transcribed: the claim under
// test is that the two cards cannot contradict each other, and a transcription
// would be a third copy that could drift from both.
import {
  VERDICT_COPY,
  describeLandsideBadge,
  describeVerdict,
} from "../../../../travel-buddy-standalone/src/components/layover/layoverVerdictFacts.ts";

// ── fixtures ──────────────────────────────────────────────────────────────────

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

/** 08:00 in Taipei: clear of the night band, so the buffer is not ramped. */
const ARRIVAL = Date.parse("2030-06-15T00:00:00.000Z");
const NOW = ARRIVAL;
/** The verifier's window: twelve hours, far more time than any outing needs. */
const TWELVE_HOURS = 720;

function session(minutes: number, over: Record<string, unknown> = {}) {
  return {
    id: "session-fail-closed",
    userId: "user-1",
    status: "active" as const,
    arrivalTime: new Date(ARRIVAL).toISOString(),
    departureTime: new Date(ARRIVAL + minutes * 60_000).toISOString(),
    boardingTime: null,
    flightType: "international" as const,
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

const PERMITTED: EntryEligibility = {
  state: "permitted", status: "visa_free",
  corridor: { passportCountry: "GB", destinationCountry: "TW" },
};
const REFUSED: EntryEligibility = {
  state: "refused", status: "visa_required",
  corridor: { passportCountry: "GB", destinationCountry: "TW" },
};
const NO_DATA: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };
const UNREADABLE_CORRIDOR: EntryEligibility = { state: "unresolved", reason: "corridor_unreadable" };
/**
 * The borders, as arrays typed ONCE. Swept loops iterate these rather than an
 * inline `[PERMITTED, REFUSED, …]`: inside a loop whose body calls `assert.*`
 * (assertion signatures) the compiler narrows each union constant through the
 * loop's back edge and reports the loop variable as circular (TS7022) — the
 * trap layoverConstraintGate.test.ts documents at its own `BORDERS`.
 */
type Border = EntryEligibility | null;
/** Entry that could not be confirmed, three ways: no curated row, an unreadable table, nothing resolved at all. */
const UNCONFIRMED_BORDERS: Border[] = [NO_DATA, UNREADABLE_CORRIDOR, null];
const ALL_BORDERS: Border[] = [PERMITTED, REFUSED, NO_DATA, UNREADABLE_CORRIDOR, null];

type Declared = { baggageMode: "CHECKED_THROUGH" | "COLLECT_RECHECK" | "CARRY_ON_ONLY" | "UNKNOWN"; recheckRequired: boolean | null; airportChangeRequired: boolean | null };

/** A declared set with EVERYTHING answered, unless a case un-answers one field. */
function declared(set: Partial<Declared> = {}, over: Partial<SessionConstraintContext> = {}): SessionConstraintContext {
  return {
    read: "declared",
    set: { version: 1, baggageMode: "CARRY_ON_ONLY", recheckRequired: false, airportChangeRequired: false, ...set },
    entryForbidsLandside: false,
    ...over,
  };
}
const UNREADABLE: SessionConstraintContext = { read: "unreadable", set: null, entryForbidsLandside: false };
const UNDECLARED: SessionConstraintContext = { read: "undeclared", set: null, entryForbidsLandside: false };

function certify(
  minutes: number,
  constraints: SessionConstraintContext | undefined,
  opts: { entry?: EntryEligibility | null; over?: Record<string, unknown>; nowMs?: number } = {},
): LayoverFeasibilityRecord {
  const s = { ...session(minutes, opts.over), ...(constraints ? { constraints } : {}) };
  return certifySessionFeasibility(airport(), s as never, {
    nowMs: opts.nowMs ?? NOW,
    entry: opts.entry === undefined ? PERMITTED : opts.entry,
  });
}

const gateOf = (r: LayoverFeasibilityRecord): LandsideGate => r.landsideGate;
const stateOf = (r: LayoverFeasibilityRecord, hasLandsidePlan = false) => layoverStateOf(r, "active", hasLandsidePlan);

/** A window the clock calls `tight` (45–89 usable minutes) with a confirmed border. */
function findTight(): number {
  for (let m = 200; m < 700; m += 1) {
    if (certify(m, undefined).verdict === "tight") return m;
  }
  throw new Error("fixture: no window found whose verdict is `tight`");
}
const TIGHT = findTight();

const LANDSIDE_STOP = { title: "Night market", durationMin: 30, travelMin: 20, insideAirport: false };
const AIRSIDE_STOP = { title: "Lounge", durationMin: 30, travelMin: 0, insideAirport: true };

const AFFIRMATIVE_STATES = new Set(["LANDSIDE_AVAILABLE", "PLAN_SELECTED"]);

// ═══════════════════════════════════════════════════════════════════════════
describe("BLOCKER 1 — only the verdict `yes` is an open gate; everything else is cautionary or closed", () => {
  it("12 h, both flags OFF, entry unresolved / unreadable / null: NOT open, NOT LANDSIDE_AVAILABLE", () => {
    for (const entry of UNCONFIRMED_BORDERS) {
      const where: string = JSON.stringify(entry);
      const r = certify(TWELVE_HOURS, undefined, { entry });
      assert.equal(r.verdict, "entry_unverified", where);
      assert.equal("constraints" in r.inputs, false, `${where}: fixture is not the flags-off arm`);
      assert.equal(gateOf(r).open, false, `${where}: an unconfirmed border left the gate OPEN`);
      assert.equal(gateOf(r).status, "caution", where);
      assert.deepEqual(gateOf(r).cautions, ["entry_unconfirmed"], where);
      assert.deepEqual(gateOf(r).closedBy, [], `${where}: the owner's forbid policy is OFF, so nothing is CLOSED — it is withheld`);
      assert.equal(stateOf(r), null, `${where}: the lifecycle state affirmed landside on an unconfirmed border`);
      assert.equal(stateOf(r, true), null, `${where}: PLAN_SELECTED was affirmed on an unconfirmed border`);
      assert.equal(landsideStatusOf(r), "caution", where);
    }
  });

  it(`a tight window (${TIGHT} min) is not an open gate either, whatever the border says`, () => {
    const r = certify(TIGHT, undefined);
    assert.equal(r.verdict, "tight");
    assert.equal(gateOf(r).entryPermissionState, "CONFIRMED_ALLOWED");
    assert.equal(gateOf(r).open, false, "a tight window left the gate OPEN");
    assert.deepEqual(gateOf(r).cautions, ["tight_window"]);
    assert.equal(stateOf(r), null);
    // …and a tight window on an unconfirmed border carries BOTH cautions.
    const both = certify(TIGHT, undefined, { entry: NO_DATA });
    assert.equal(both.verdict, "tight");
    assert.deepEqual(gateOf(both).cautions, ["entry_unconfirmed", "tight_window"]);
    assert.equal(gateOf(both).open, false);
  });

  it("CONTROL: the same 12 h with a CONFIRMED border is `yes`, open, LANDSIDE_AVAILABLE / PLAN_SELECTED", () => {
    const r = certify(TWELVE_HOURS, undefined);
    assert.equal(r.verdict, "yes");
    assert.equal(gateOf(r).open, true);
    assert.equal(gateOf(r).status, "open");
    assert.deepEqual(gateOf(r).cautions, []);
    assert.deepEqual(gateOf(r).closedBy, []);
    assert.equal(stateOf(r), "LANDSIDE_AVAILABLE");
    assert.equal(stateOf(r, true), "PLAN_SELECTED");
  });

  it("SWEPT: open ⇔ verdict `yes`; an affirmative state ⇒ open, `yes`, entry CONFIRMED_ALLOWED", () => {
    const contexts: Array<SessionConstraintContext | undefined> = [
      undefined,
      UNDECLARED,
      UNREADABLE,
      { read: "storage_off", set: null, entryForbidsLandside: true },
      declared(),
      declared({ baggageMode: "UNKNOWN" }),
      declared({ recheckRequired: null }),
      declared({ recheckRequired: true }),
      declared({ airportChangeRequired: null }),
      declared({ airportChangeRequired: true }),
      declared({}, { entryForbidsLandside: true }),
    ];
    let cases = 0;
    const seen = { open: 0, caution: 0, closed: 0, affirmative: 0 };
    for (let minutes = 60; minutes <= 900; minutes += 7) {
      for (const ctx of contexts) {
        for (const entry of ALL_BORDERS) {
          for (const wantsToLeave of [true, false]) {
            cases += 1;
            const r = certify(minutes, ctx, { entry, over: { wantsToLeave } });
            const g = gateOf(r);
            const where: string = `${minutes}m ctx=${ctx ? ctx.read : "legacy"}/${JSON.stringify(ctx?.set ?? null)} entry=${entry?.state ?? "null"} leave=${wantsToLeave}`;
            assert.equal(g.open, r.verdict === "yes", `${where}: gate.open=${g.open} beside verdict ${r.verdict}`);
            assert.equal(g.open, g.status === "open", where);
            assert.equal(g.status === "closed", r.verdict === "no" || r.verdict === "stay_airside", `${where}: ${g.status} beside ${r.verdict}`);
            assert.equal(g.closedBy.length > 0, g.status === "closed", where);
            assert.equal(g.status === "caution", g.closedBy.length === 0 && g.cautions.length > 0, where);
            if (g.open) {
              assert.equal(g.entryPermissionState, "CONFIRMED_ALLOWED", `${where}: open on an unconfirmed border`);
              assert.deepEqual(g.criticalUnknowns, [], `${where}: open with a critical unknown`);
              assert.notEqual(g.constraintsRead, "unreadable", `${where}: open on an unreadable store`);
            }
            for (const hasPlan of [true, false]) {
              const state = stateOf(r, hasPlan);
              if (state !== null && AFFIRMATIVE_STATES.has(state)) {
                seen.affirmative += 1;
                assert.equal(r.verdict, "yes", `${where}: ${state} beside verdict ${r.verdict}`);
                assert.equal(g.open, true, where);
              }
              // The published overall rating can never out-affirm the gate.
              if (!g.open) assert.notEqual(r.windowOnly.rating, "safe", `${where}: rating "safe" with the gate ${g.status}`);
            }
            seen[g.status] += 1;
          }
        }
      }
    }
    assert.ok(cases > 10_000, `sweep ran only ${cases} cases`);
    for (const k of ["open", "caution", "closed", "affirmative"] as const) {
      assert.ok(seen[k] > 0, `NON-VACUITY: the sweep never produced "${k}"`);
    }
  });

  it("a return corridor that downgrades `yes` to `tight` takes the open gate with it", () => {
    const inputs = feasibilityInputs(airport(), session(TWELVE_HOURS) as never, { nowMs: NOW, entry: PERMITTED });
    const risk: ReturnCorridorRisk = {
      returnRouteUnreliable: true, fragileCorridor: true, contributingFactors: ["single_route"],
      facts: {
        independentReturnRoutes: 1, offeredReturnRoutes: 1, bestRouteInterruptibility: "committed",
        allRoutesInterruptibility: "committed", minTransferCount: 0, maxTransferCount: 0, stale: false, unmeasured: [],
      },
    };
    const adjusted = certifyFeasibilityWithReturnCorridor(inputs, risk);
    assert.equal(adjusted.verdict, "tight");
    assert.equal(adjusted.landsideGate.open, false, "the verdict was downgraded and the gate beside it stayed open");
    assert.deepEqual(adjusted.landsideGate.cautions, ["tight_window"]);
    assert.equal(layoverStateOf(adjusted, "active", false), null);
    // CONTROL: no corridor is the identity.
    assert.equal(certifyFeasibilityWithReturnCorridor(inputs, null).landsideGate.open, true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("BLOCKER 1 — the two cards are derived from ONE payload and cannot contradict each other", () => {
  const VERDICTS = ["yes", "tight", "no", "entry_unverified", "stay_airside"] as const;
  // Fails the BUILD when the server's union gains a verdict this list has not.
  type Missing = Exclude<LeaveAdvice["verdict"], (typeof VERDICTS)[number]>;
  const exhaustive: [Missing] extends [never] ? true : false = true;

  /** Every record the corpus below produces, keyed by the verdict it reached. */
  function everyVerdict(): Map<string, LayoverFeasibilityRecord[]> {
    const out = new Map<string, LayoverFeasibilityRecord[]>();
    const contexts: Array<SessionConstraintContext | undefined> = [
      undefined, UNREADABLE, UNDECLARED, declared(), declared({ airportChangeRequired: null }),
      declared({ airportChangeRequired: true }), declared({ baggageMode: "UNKNOWN" }),
      { read: "storage_off", set: null, entryForbidsLandside: true },
    ];
    for (const minutes of [60, TIGHT, 400, TWELVE_HOURS]) {
      for (const ctx of contexts) {
        for (const entry of ALL_BORDERS) {
          for (const wantsToLeave of [true, false]) {
            const r = certify(minutes, ctx, { entry, over: { wantsToLeave } });
            out.set(r.verdict, [...(out.get(r.verdict) ?? []), r]);
          }
        }
      }
    }
    for (const v of VERDICTS) {
      if (!out.get(v)?.length) throw new Error(`fixture: the engine never produced the verdict "${v}"`);
    }
    return out;
  }

  it("for every verdict value: the badge is green ONLY where CanILeaveCard is green, and says the same thing", () => {
    assert.equal(exhaustive, true);
    assert.deepEqual(Object.keys(VERDICT_COPY).sort(), [...VERDICTS].sort(), "the client's verdict table and the server's union differ");
    const corpus = everyVerdict();
    let compared = 0;
    for (const verdict of VERDICTS) {
      for (const record of corpus.get(verdict)!) {
        for (const hasLandsidePlan of [false, true]) {
          // THE SERVER PAYLOAD — the real projection both client reads are made from.
          const s = { ...session(TWELVE_HOURS), constraints: undefined };
          const payload = JSON.parse(JSON.stringify(constraintsPayload({
            session: s as never, record, plan: { ok: true, hasLandsidePlan },
          })));
          // CARD 1 — CanILeaveCard draws `advice.verdict`, which is this record's.
          const leave = describeVerdict(record.verdict);
          // CARD 2 — the constraints card's badge, from the same payload.
          const badge = describeLandsideBadge({ layoverState: payload.layoverState, verdict: payload.verdict, gate: payload.landsideGate });
          const where = `${verdict} plan=${hasLandsidePlan} state=${payload.layoverState} gate=${payload.landsideGate.status}`;
          compared += 1;

          assert.equal(payload.verdict, record.verdict, where);
          assert.equal(leave.label, VERDICT_COPY[verdict].label, where);
          if (badge?.tone === "open") {
            assert.equal(leave.tone, "affirm", `${where}: a green badge beneath a ${leave.tone} verdict ("${leave.label}")`);
            assert.equal(verdict, "yes", where);
          }
          if (verdict !== "yes") {
            assert.ok(badge, `${where}: no badge at all beside a non-affirmative verdict`);
            assert.notEqual(badge.tone, "open", where);
            assert.doesNotMatch(badge.label, /can go out|plan set/i, `${where}: "${badge.label}"`);
          }
          if (leave.tone === "caution") {
            assert.equal(badge?.tone, "caution", `${where}: the verdict is cautionary and the badge is ${badge?.tone}`);
            assert.equal(badge?.label, VERDICT_COPY[verdict].badge, `${where}: the badge does not use the verdict's own words`);
          }
          if (leave.tone === "refuse" || leave.tone === "staying") {
            // `return` is the escalation ladder (a too-short layover with a
            // landside stop on its plan is told to head back) — a refusal
            // stated more urgently, never an understatement of one.
            assert.ok(
              badge?.tone === "closed" || badge?.tone === "ask" || badge?.tone === "return",
              `${where}: a refusal beside a ${badge?.tone} badge`,
            );
          }
          if (verdict === "yes") {
            assert.equal(badge?.tone, "open", where);
            assert.equal(badge?.label, hasLandsidePlan ? "Plan set" : "You can go out", where);
          }
        }
      }
    }
    assert.ok(compared >= VERDICTS.length * 2, `only ${compared} payloads compared`);
  });

  it("the CLIENT does not trust an affirmative state from a server that predates this fix", () => {
    // What PR #588's server sends today for a 12 h layover on an unconfirmed border.
    const stale = { layoverState: "LANDSIDE_AVAILABLE", verdict: "entry_unverified", gate: { open: true, closedBy: [], needsInfo: null } };
    const badge = describeLandsideBadge(stale);
    assert.equal(badge?.tone, "caution");
    assert.equal(badge?.label, VERDICT_COPY.entry_unverified.badge);
    const staleTight = describeLandsideBadge({ ...stale, verdict: "tight" });
    assert.equal(staleTight?.tone, "caution");
    // …and a verdict this build has never been taught is never drawn green.
    const future = describeVerdict("some_future_verdict");
    assert.notEqual(future.tone, "affirm");
    assert.notEqual(describeLandsideBadge({ ...stale, verdict: "some_future_verdict" })?.tone, "open");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("BLOCKER 2 — an unreadable constraint store closes the gate, by name", () => {
  it("unreadable store on a LONG window, border confirmed: closed, `no`, nothing asked", () => {
    const r = certify(TWELVE_HOURS, UNREADABLE);
    const g = gateOf(r);
    assert.equal(g.constraintsRead, "unreadable");
    assert.equal(g.open, false, "an unreadable store left the gate OPEN on a long window");
    assert.equal(g.status, "closed");
    assert.ok(g.closedBy.includes("constraints_unreadable"), `closedBy = ${JSON.stringify(g.closedBy)}`);
    assert.equal(r.verdict, "no");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.equal(g.needsInfo, null, "an outage was presented to the traveller as a question");
    assert.equal(constraintQuestion(g), null);
    assert.equal(r.reasons[r.reasons.length - 1], CONSTRAINTS_UNREADABLE_REASON);
    assert.equal(r.windowOnly.rating, "not_recommended");
    assert.equal(stateOf(r), "AIRPORT_ONLY");
    assert.equal(stateOf(r, true), "AIRPORT_ONLY");
    assert.equal(landsideStatusOf(r), "closed");
    // The closure is recorded in the ledger under a declared namespace.
    const ledger = decisionRecordFor("session-fail-closed", r);
    assert.ok(ledger.rulesApplied.includes("gate.constraints_unreadable"));
    for (const rule of ledger.rulesApplied) {
      assert.ok(LEDGER_RULE_NAMESPACES.some((ns) => rule === ns || rule.startsWith(ns + ".")), `rule ${rule} is in no declared namespace`);
    }
    assert.deepEqual(replayFeasibility(r.inputs), r, "the record does not replay from its own inputs");
  });

  it("CONTROL: the same window with the store READ and fully answered is open", () => {
    const r = certify(TWELVE_HOURS, declared());
    assert.equal(r.verdict, "yes");
    assert.equal(gateOf(r).open, true);
    assert.deepEqual(gateOf(r).closedBy, []);
  });

  it("a traveller who said they are staying keeps their own answer, with the closure still named", () => {
    const r = certify(TWELVE_HOURS, UNREADABLE, { over: { wantsToLeave: false } });
    assert.equal(r.verdict, "stay_airside");
    assert.ok(gateOf(r).closedBy.includes("traveller_staying_airside"));
    assert.ok(gateOf(r).closedBy.includes("constraints_unreadable"));
  });

  it("an outage at the deadline does not tell a traveller who may be out that they are at the airport", () => {
    // 30 minutes before departure the hard return has passed: the clock closes
    // the gate, and an unreadable store must not turn RETURN_NOW into AIRPORT_ONLY.
    const late = certify(TWELVE_HOURS, UNREADABLE, { nowMs: ARRIVAL + (TWELVE_HOURS - 30) * 60_000 });
    assert.notEqual(late.envelope.returnState, "NORMAL");
    assert.ok(gateOf(late).closedBy.includes("constraints_unreadable"));
    assert.equal(layoverStateOf(late, "active", false), "RETURN_NOW");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("BLOCKER 4 — \"Not sure\" on the airport change is an unknown that closes the gate", () => {
  it("declared `airportChangeRequired: null` on 12 h: closed, and the traveller is asked to confirm", () => {
    const r = certify(TWELVE_HOURS, declared({ airportChangeRequired: null }));
    const g = gateOf(r);
    assert.equal(g.open, false, "\"Not sure\" about an airport change was read as \"no\"");
    assert.deepEqual(g.closedBy, ["airport_change_unknown"]);
    assert.equal(r.verdict, "no");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.deepEqual(g.criticalUnknowns, ["airport_change_required"]);
    assert.equal(g.needsInfo, "airportChangeRequired");
    assert.equal(r.reasons[r.reasons.length - 1], AIRPORT_CHANGE_UNKNOWN_REASON);
    assert.equal(r.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"), false, "the clock did not refuse; the unknown did");
    assert.equal(stateOf(r), "NEEDS_INFO");
    const q = constraintQuestion(g);
    assert.equal(q?.field, "airportChangeRequired");
    assert.match(q?.prompt ?? "", /different airport/i);
    assert.deepEqual(q?.options.map((o) => o.value), [false, true], "the question must offer exactly the two answers that resolve it");
  });

  it("answering it resolves it both ways: `false` opens, `true` closes for the stated reason", () => {
    const no = certify(TWELVE_HOURS, declared({ airportChangeRequired: false }));
    assert.equal(no.verdict, "yes");
    assert.equal(gateOf(no).open, true);
    assert.equal(gateOf(no).needsInfo, null);
    const yes = certify(TWELVE_HOURS, declared({ airportChangeRequired: true }));
    assert.equal(yes.verdict, "no");
    assert.deepEqual(gateOf(yes).closedBy, ["airport_change"]);
    assert.equal(gateOf(yes).needsInfo, null);
    assert.equal(stateOf(yes), "AIRPORT_ONLY");
  });

  it("UNDECLARED, where declarations are kept, is the same unknown — not a legacy pass", () => {
    const r = certify(TWELVE_HOURS, UNDECLARED);
    assert.equal(r.inputs.constraints?.read, "undeclared");
    assert.equal(gateOf(r).open, false, "a session that declared nothing was certified as if it had answered \"no\"");
    assert.ok(gateOf(r).closedBy.includes("airport_change_unknown"));
    assert.equal(gateOf(r).needsInfo, "airportChangeRequired");
    // The bag term is still the traveller's own boolean: nothing was declared to replace it.
    const withBags = certify(TWELVE_HOURS, UNDECLARED, { over: { checkedBags: true } });
    assert.equal(withBags.deadline.breakdown.bagsExtra, 15);
  });

  it("where the answer cannot change the verdict it is not asked (§12.1)", () => {
    const refused = certify(TWELVE_HOURS, declared({ airportChangeRequired: null }), { entry: REFUSED });
    assert.deepEqual(gateOf(refused).closedBy, ["entry_refused"]);
    assert.equal(gateOf(refused).needsInfo, null);
    const staying = certify(TWELVE_HOURS, declared({ airportChangeRequired: null }), { over: { wantsToLeave: false } });
    assert.equal(staying.verdict, "stay_airside");
    assert.equal(gateOf(staying).needsInfo, null);
    const tooShort = certify(60, declared({ airportChangeRequired: null }));
    assert.deepEqual(gateOf(tooShort).closedBy, ["insufficient_time"]);
    assert.equal(gateOf(tooShort).needsInfo, null);
  });

  it("the vocabularies are declared once and cover every closure and caution this file names", () => {
    for (const c of ["constraints_unreadable", "airport_change_unknown", "recheck_unknown"]) {
      assert.ok((LANDSIDE_CLOSURES as readonly string[]).includes(c), c);
    }
    assert.deepEqual([...LANDSIDE_CAUTIONS], ["entry_unconfirmed", "tight_window"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SHOULD-FIX 5 — a closed gate is consulted by every plan surface", () => {
  const closedCases: Array<{ name: string; record: LayoverFeasibilityRecord; closure: string }> = [
    { name: "entry refused (pre-existing)", record: certify(TWELVE_HOURS, undefined, { entry: REFUSED }), closure: "entry_refused" },
    { name: "airport change", record: certify(TWELVE_HOURS, declared({ airportChangeRequired: true })), closure: "airport_change" },
    { name: "airport change unknown", record: certify(TWELVE_HOURS, declared({ airportChangeRequired: null })), closure: "airport_change_unknown" },
    { name: "unreadable store", record: certify(TWELVE_HOURS, UNREADABLE), closure: "constraints_unreadable" },
    { name: "entry unconfirmed under the owner's policy", record: certify(TWELVE_HOURS, { read: "storage_off", set: null, entryForbidsLandside: true }, { entry: NO_DATA }), closure: "entry_unconfirmed" },
  ];
  const open = certify(TWELVE_HOURS, declared());
  const caution = certify(TWELVE_HOURS, undefined, { entry: NO_DATA });

  it("FIXTURE: the plan fits the clock on every one of these records — only the gate differs", () => {
    for (const c of [...closedCases.map((x) => x.record), open, caution]) {
      assert.ok(c.envelope.usableMinutes > 300, "fixture: the window is not long enough for the clock to be irrelevant");
    }
  });

  it("routes (`certifiedPlanFit`): a plan with a landside stop is `blocked`, never `fits`, and says why", () => {
    for (const c of closedCases) {
      const fit = certifiedPlanFit(c.record, [AIRSIDE_STOP, LANDSIDE_STOP]);
      assert.equal(fit.clockFit, "fits", `${c.name}: fixture — the clock alone would have said fits`);
      assert.equal(fit.fit, "blocked", `${c.name}: a plan with a landside stop "${fit.fit}" on a closed gate`);
      assert.equal(fit.fitsWindow, false, c.name);
      assert.equal(fit.landside.status, "closed", c.name);
      assert.ok(fit.landside.closedBy.includes(c.closure as never), `${c.name}: ${JSON.stringify(fit.landside.closedBy)}`);
      // An AIRSIDE-ONLY plan is not what the gate is about, and still fits.
      const airside = certifiedPlanFit(c.record, [AIRSIDE_STOP]);
      assert.equal(airside.fit, "fits", `${c.name}: an airside-only plan was blocked by the landside gate`);
      assert.equal(airside.fitsWindow, true, c.name);
    }
  });

  it("routes: a cautionary gate withholds the green `fits` and names the caution; an open gate fits", () => {
    const withheld = certifiedPlanFit(caution, [LANDSIDE_STOP]);
    assert.equal(withheld.fit, "unconfirmed");
    assert.equal(withheld.fitsWindow, false);
    assert.deepEqual(withheld.landside.cautions, ["entry_unconfirmed"]);
    const tight = certifiedPlanFit(certify(TIGHT, undefined), [{ ...LANDSIDE_STOP, durationMin: 10, travelMin: 5 }]);
    assert.equal(tight.clockFit, "fits", "fixture: the short plan does not fit the tight window");
    assert.equal(tight.fit, "unconfirmed");
    const ok = certifiedPlanFit(open, [AIRSIDE_STOP, LANDSIDE_STOP]);
    assert.equal(ok.fit, "fits");
    assert.equal(ok.fitsWindow, true);
    assert.equal(ok.landside.status, "open");
    // Arithmetic refusals keep their own, certain, answer.
    const over = certifiedPlanFit(open, [{ ...LANDSIDE_STOP, durationMin: 5000 }]);
    assert.equal(over.fit, "over");
    const unknown = certifiedPlanFit(open, [{ ...LANDSIDE_STOP, travelMin: 0 }]);
    assert.equal(unknown.fit, "unknown");
  });

  it("Compass `simulatePlan`: the stored plan AND a model-supplied candidate set go through the same gate", () => {
    const ctxFor = (record: LayoverFeasibilityRecord): LayoverToolContext => ({
      session: session(TWELVE_HOURS) as never,
      airport: { ...airport(), name: "Taoyuan", city: "Taipei", country: "Taiwan" } as never,
      record,
      stops: [LANDSIDE_STOP],
    });
    for (const c of closedCases) {
      for (const args of [{}, { candidateSet: [{ durationMin: 30, travelMin: 20 }] }]) {
        const res = runLayoverTool("simulatePlan", ctxFor(c.record), args);
        assert.equal(res.ok, true, c.name);
        if (!res.ok) continue;
        assert.equal(res.data.fitsWindow, false, `${c.name} ${JSON.stringify(args)}: simulatePlan said the plan fits on a closed gate`);
        assert.equal(res.data.fit, "blocked", c.name);
        assert.ok((res.data.landsideClosedBy as string[]).includes(c.closure), c.name);
      }
    }
    const ok = runLayoverTool("simulatePlan", ctxFor(open), {});
    assert.ok(ok.ok && ok.data.fitsWindow === true && ok.data.fit === "fits", "CONTROL: an open gate no longer fits");
    const held = runLayoverTool("simulatePlan", ctxFor(caution), {});
    assert.ok(held.ok && held.data.fitsWindow === false && held.data.fit === "unconfirmed");
  });

  it("crew solver: a branch with a landside stop is infeasible for a member whose gate is closed", () => {
    const member = (userId: string, record: LayoverFeasibilityRecord): CrewMember => ({ userId, sessionId: `s-${userId}`, record });
    for (const c of closedCases) {
      const members = [member("a", open), member("b", c.record)];
      const solved = certifyCrewPlan(unsplitPlan(members, [LANDSIDE_STOP]), members, { nowMs: NOW });
      assert.equal(solved.feasible, false, `${c.name}: a crew plan leaving the airport was feasible with a member who may not`);
      assert.ok(solved.reasons.includes("landside_closed_for_member"), `${c.name}: ${JSON.stringify(solved.reasons)}`);
      assert.equal(solved.branches[0].landside, "closed", c.name);
      // The same crew staying airside is not the gate's business.
      const airside = certifyCrewPlan(unsplitPlan(members, [AIRSIDE_STOP]), members, { nowMs: NOW });
      assert.equal(airside.reasons.includes("landside_closed_for_member"), false, c.name);
      assert.equal(airside.branches[0].landside, "not_applicable", c.name);
    }
    const allOpen = [member("a", open), member("b", open)];
    const good = certifyCrewPlan(unsplitPlan(allOpen, [LANDSIDE_STOP]), allOpen, { nowMs: NOW });
    assert.equal(good.feasible, true, `CONTROL: ${JSON.stringify(good.reasons)}`);
    assert.equal(good.branches[0].landside, "open");
    // A cautionary member does not make the plan infeasible, and is not hidden either.
    const mixed = [member("a", open), member("b", caution)];
    assert.equal(certifyCrewPlan(unsplitPlan(mixed, [LANDSIDE_STOP]), mixed, { nowMs: NOW }).branches[0].landside, "caution");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("SHOULD-FIX 7 — separate tickets cost time, and \"not sure\" about them is not free", () => {
  it("`recheckRequired: true` with carry-on only is charged the collect-and-re-check time", () => {
    const plain = certify(TWELVE_HOURS, declared({ recheckRequired: false }));
    const selfTransfer = certify(TWELVE_HOURS, declared({ recheckRequired: true }));
    const collect = certify(TWELVE_HOURS, declared({ baggageMode: "COLLECT_RECHECK", recheckRequired: false }));
    assert.ok(selfTransfer.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
    assert.equal(
      plain.envelope.usableMinutes - selfTransfer.envelope.usableMinutes, 35,
      "a self-transfer was charged nothing: SELF_TRANSFER_FRICTION was a label with no minutes behind it",
    );
    assert.equal(selfTransfer.deadline.breakdown.bagsExtra, 15, "the airport's re-check minutes are not in the return buffer");
    assert.equal(selfTransfer.envelope.exitDelayMin - plain.envelope.exitDelayMin, 20);
    assert.ok(selfTransfer.deadline.hardReturnTime.getTime() < plain.deadline.hardReturnTime.getTime(), "the deadline did not move earlier");
    // The SAME constant collect-and-re-check already uses — no new number was invented.
    assert.equal(selfTransfer.envelope.usableMinutes, collect.envelope.usableMinutes);
    assert.equal(selfTransfer.deadline.hardReturnTime.toISOString(), collect.deadline.hardReturnTime.toISOString());
    assert.ok(selfTransfer.unknowns.some((u) => u.includes("check-in cutoff")));
    assert.equal(plain.reasonCodes.includes("SELF_TRANSFER_FRICTION"), false);
  });

  it("`recheckRequired: null` is charged as the cautious case and closes the gate only where it decides", () => {
    const unknown = certify(TWELVE_HOURS, declared({ recheckRequired: null }));
    const charged = certify(TWELVE_HOURS, declared({ recheckRequired: true }));
    assert.equal(unknown.envelope.usableMinutes, charged.envelope.usableMinutes, "\"not sure\" about separate tickets was read as \"no\"");
    assert.ok(unknown.unknowns.some((u) => /separate tickets/i.test(u)), "the unknown is not disclosed");
    // On 12 h it cannot change the answer, so nothing is asked and nothing closes.
    assert.equal(unknown.verdict, "yes");
    assert.equal(gateOf(unknown).needsInfo, null);
    // On a window where 35 minutes decides the verdict, it is the one question.
    let decisive = 0;
    for (let m = 200; m < 700; m += 1) {
      const a = certify(m, declared({ recheckRequired: false })).verdict;
      const b = certify(m, declared({ recheckRequired: true })).verdict;
      if (a !== b && b !== "no") { decisive = m; break; }
    }
    assert.ok(decisive > 0, "fixture: no window found where the re-check minutes move the verdict");
    const r = certify(decisive, declared({ recheckRequired: null }));
    assert.equal(r.verdict, "no");
    assert.deepEqual(gateOf(r).closedBy, ["recheck_unknown"]);
    assert.deepEqual(gateOf(r).criticalUnknowns, ["recheck_required"]);
    assert.equal(gateOf(r).needsInfo, "recheckRequired");
    assert.equal(constraintQuestion(gateOf(r))?.field, "recheckRequired");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.equal(stateOf(r), "NEEDS_INFO");
    // Either answer lifts the closure.
    for (const v of [true, false]) {
      const answered = certify(decisive, declared({ recheckRequired: v }));
      assert.equal(gateOf(answered).closedBy.includes("recheck_unknown"), false, String(v));
      assert.equal(gateOf(answered).needsInfo, null, String(v));
    }
  });

  it("ONE question at a time, the one that decides most first: airport, then bags, then tickets", () => {
    const all = certify(TWELVE_HOURS, declared({ baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: null }));
    assert.equal(gateOf(all).needsInfo, "airportChangeRequired");
  });
});
