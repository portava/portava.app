/**
 * LAY-01 — the declared constraint set and the landside hard gate, over the
 * certified record.
 *
 * census-layover rows this pins, each against the entry point every route
 * already calls (`certifySessionFeasibility`), not against a helper:
 *
 *   L35  BaggageMode: four states, UNKNOWN representable and never optimistic
 *   L49  critical unknown ⇒ confidence INSUFFICIENT and landside forbidden
 *   L229 unknown baggage → fail closed if critical (and ONLY if critical, §12.1)
 *   L222 5h self-transfer → recheck friction included
 *   L224 airport change → exploration subordinate to transfer
 *   L48 / L230 entry != CONFIRMED_ALLOWED ⇒ no landside, under the owner's policy
 *   L40 / L77  the one guard: entry + critical unknowns + time
 *   L279 / L283 / L284 the three Appendix A codes that had no emitter
 *
 * ── WHAT WOULD LET THIS PASS WITHOUT THE PROPERTY ───────────────────────────
 *  * A fixture where bags never matter. `DECISIVE` is FOUND by search and the
 *    suite refuses to run without it, and `SETTLED` is its negative control.
 *  * A gate that closes everything. Every closing case has a sibling that must
 *    stay open on the same window.
 *  * A gate that moves numbers. The sweep asserts the deadline is the engine's
 *    own for the same effective bag term, and that the verdict is either the
 *    ungated one or `no` — never anything more permissive.
 *
 * Run: node --import tsx/esm --test src/test/layoverConstraintGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  certifySessionFeasibility,
  replayFeasibility,
  type FeasibilityAirport,
} from "../services/airport/LayoverFeasibility.js";
import { adviseLeaving, computeWindow } from "../services/airport/LayoverSafetyEngine.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import { decisionRecordFor, LEDGER_RULE_NAMESPACES } from "../services/airport/layoverLedger.js";
import {
  BAGGAGE_MODES,
  BAGGAGE_DECISIVE_REASON,
  LEGACY_CHECKED_BAGS_REASON_PREFIX,
  baggageChargesBags,
  constraintQuestion,
  layoverStateOf,
  nextConstraintSet,
  LAYOVER_STATES,
  LAYOVER_STATE_SOURCES,
  type BaggageMode,
  type LandsideGate,
  type SessionConstraintContext,
} from "../services/airport/LayoverConstraints.js";

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

function session(minutes: number, over: Record<string, unknown> = {}) {
  return {
    id: "session-constraints",
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
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };

function declared(
  set: Partial<{ baggageMode: BaggageMode; recheckRequired: boolean | null; airportChangeRequired: boolean | null }> = {},
  over: Partial<SessionConstraintContext> = {},
): SessionConstraintContext {
  return {
    read: "declared",
    set: { version: 1, baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: null, ...set },
    entryForbidsLandside: false,
    ...over,
  };
}

function certify(
  minutes: number,
  constraints: SessionConstraintContext | undefined,
  opts: { entry?: EntryEligibility | null; over?: Record<string, unknown> } = {},
) {
  const s = { ...session(minutes, opts.over), ...(constraints ? { constraints } : {}) };
  return certifySessionFeasibility(airport(), s as never, {
    nowMs: NOW,
    entry: opts.entry === undefined ? PERMITTED : opts.entry,
  });
}

/** The engine's own answer for a boolean, with no constraint set anywhere. */
function legacy(minutes: number, checkedBags: boolean, entry: EntryEligibility | null = PERMITTED, over: Record<string, unknown> = {}) {
  return certifySessionFeasibility(airport(), session(minutes, { checkedBags, ...over }) as never, { nowMs: NOW, entry });
}

function gateOf(r: unknown): LandsideGate {
  const gate = (r as { landsideGate?: LandsideGate }).landsideGate;
  assert.ok(gate, "the certified record publishes no landsideGate");
  return gate;
}

/** A window on which one bag flips the verdict, neither side being `no`. */
function findDecisive(): number {
  for (let m = 200; m < 900; m += 1) {
    const a = legacy(m, false).verdict;
    const b = legacy(m, true).verdict;
    if (a !== b && a !== "no" && b !== "no") return m;
  }
  throw new Error("fixture: no window found where checked bags move the verdict between two non-refusals");
}
/** A window on which bags cannot matter: `yes` either way. */
function findSettled(): number {
  for (let m = 900; m > 300; m -= 5) {
    if (legacy(m, false).verdict === "yes" && legacy(m, true).verdict === "yes") return m;
  }
  throw new Error("fixture: no window found where the verdict is `yes` with and without bags");
}
const DECISIVE = findDecisive();
const SETTLED = findSettled();

// ═══════════════════════════════════════════════════════════════════════════
describe("the legacy arm is untouched: no declared set, no policy", () => {
  it("contributes NO key to the named inputs, so the hash is the engine's own", () => {
    const plain = legacy(SETTLED, false);
    assert.equal("constraints" in plain.inputs, false);
    assert.equal("policy" in plain.inputs, false);
    for (const read of ["undeclared", "storage_off"] as const) {
      const r = certify(SETTLED, { read, set: null, entryForbidsLandside: false });
      assert.equal(r.inputHash, plain.inputHash, `${read}: a context that declares nothing changed the input hash`);
      assert.deepEqual(r.reasons, plain.reasons, read);
      assert.deepEqual(r.reasonCodes, plain.reasonCodes, read);
      assert.equal(r.verdict, plain.verdict, read);
    }
  });

  it("still publishes the gate, read off the verdict the engine reached", () => {
    assert.deepEqual(gateOf(legacy(SETTLED, false)).closedBy, []);
    assert.equal(gateOf(legacy(SETTLED, false)).open, true);
    assert.equal(gateOf(legacy(SETTLED, false)).constraintsRead, "legacy");

    const tooShort = legacy(60, false);
    assert.equal(tooShort.verdict, "no");
    assert.deepEqual(gateOf(tooShort).closedBy, ["insufficient_time"]);

    const staying = legacy(SETTLED, false, PERMITTED, { wantsToLeave: false });
    assert.equal(staying.verdict, "stay_airside");
    assert.deepEqual(gateOf(staying).closedBy, ["traveller_staying_airside"]);

    const refused = legacy(SETTLED, false, REFUSED);
    assert.equal(refused.verdict, "no");
    assert.deepEqual(gateOf(refused).closedBy, ["entry_refused"]);
    assert.equal(gateOf(refused).entryPermissionState, "CONFIRMED_NOT_ALLOWED");

    // The OWNER has not decided that an unconfirmed corridor forbids landside,
    // so without the policy it does not: unchanged behaviour, stated as a test.
    const unverified = legacy(SETTLED, false, UNRESOLVED);
    assert.equal(unverified.verdict, "entry_unverified");
    assert.equal(gateOf(unverified).open, true);
    assert.equal(gateOf(unverified).entryPermissionState, "UNKNOWN");
    assert.equal(gateOf(unverified).entryForbidsLandside, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L35 — a declared baggage mode replaces the boolean in the arithmetic", () => {
  it("each mode charges exactly what `baggageChargesBags` says, whatever the boolean on the row", () => {
    for (const mode of BAGGAGE_MODES) {
      for (const rowBoolean of [true, false]) {
        const r = certify(SETTLED, declared({ baggageMode: mode }), { over: { checkedBags: rowBoolean } });
        const want = legacy(SETTLED, baggageChargesBags(mode));
        assert.equal(
          r.deadline.hardReturnTime.toISOString(), want.deadline.hardReturnTime.toISOString(),
          `${mode} (row boolean ${rowBoolean}): the deadline did not follow the declared mode`,
        );
        assert.equal(r.envelope.usableMinutes, want.envelope.usableMinutes, `${mode}/${rowBoolean}`);
        assert.equal(r.deadline.breakdown.bagsExtra, baggageChargesBags(mode) ? 15 : 0, `${mode}/${rowBoolean}`);
        assert.equal(r.inputs.constraints?.baggageMode, mode);
      }
    }
  });

  it("UNKNOWN is never the optimistic reading: it costs what collect-and-recheck costs", () => {
    const unknown = certify(SETTLED, declared({ baggageMode: "UNKNOWN" }));
    const collect = certify(SETTLED, declared({ baggageMode: "COLLECT_RECHECK" }));
    const carryOn = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY" }));
    assert.equal(unknown.envelope.usableMinutes, collect.envelope.usableMinutes);
    assert.ok(
      unknown.envelope.usableMinutes < carryOn.envelope.usableMinutes,
      "UNKNOWN baggage was given as much usable time as carry-on only",
    );
  });

  it("two modes are two computations: the input hash differs and each replays to itself", () => {
    const hashes = new Set<string>();
    for (const mode of BAGGAGE_MODES) {
      const r = certify(DECISIVE, declared({ baggageMode: mode }));
      hashes.add(r.inputHash);
      assert.deepEqual(replayFeasibility(r.inputs), r, `${mode}: the record does not replay from its own inputs`);
    }
    assert.equal(hashes.size, BAGGAGE_MODES.length);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L49 / L229 / App B.2 — unknown baggage fails closed when, and only when, it decides", () => {
  it(`on a window where one bag flips the verdict (${DECISIVE} min) UNKNOWN closes landside`, () => {
    const r = certify(DECISIVE, declared({ baggageMode: "UNKNOWN" }));
    const gate = gateOf(r);
    assert.equal(r.verdict, "no");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.ok(r.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"));
    assert.equal(r.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"), false, "the clock did not refuse; the unknown did");
    assert.equal(gate.open, false);
    assert.ok(gate.closedBy.includes("baggage_unknown"));
    assert.equal(gate.needsInfo, "baggageMode");
    assert.deepEqual(gate.criticalUnknowns, ["baggage_mode"]);
    assert.equal(r.reasons[r.reasons.length - 1], BAGGAGE_DECISIVE_REASON);
    // The published overall rating is capped by the verdict, with the sentence.
    assert.equal(r.windowOnly.rating, "not_recommended");
    assert.equal(r.windowOnly.warningReason, BAGGAGE_DECISIVE_REASON);
    assert.equal(constraintQuestion(gate)?.field, "baggageMode");
  });

  it("answering the one question re-opens it, either way the answer goes", () => {
    for (const mode of ["CHECKED_THROUGH", "CARRY_ON_ONLY", "COLLECT_RECHECK"] as const) {
      const r = certify(DECISIVE, declared({ baggageMode: mode }));
      assert.notEqual(r.verdict, "no", mode);
      assert.equal(gateOf(r).open, true, mode);
      assert.equal(gateOf(r).needsInfo, null, mode);
      assert.notEqual(r.confidence, "INSUFFICIENT", mode);
      assert.equal(r.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"), false, mode);
      assert.equal(constraintQuestion(gateOf(r)), null, mode);
    }
  });

  it(`NEGATIVE CONTROL: on a window where bags cannot matter (${SETTLED} min) UNKNOWN asks nothing and closes nothing`, () => {
    const r = certify(SETTLED, declared({ baggageMode: "UNKNOWN" }));
    assert.equal(r.verdict, "yes");
    assert.equal(gateOf(r).open, true);
    assert.equal(gateOf(r).needsInfo, null);
    assert.deepEqual(gateOf(r).criticalUnknowns, []);
    assert.notEqual(r.confidence, "INSUFFICIENT");
    assert.equal(r.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"), false);
    // …and it is still DISCLOSED: an unknown that does not decide is still unknown.
    assert.ok(r.unknowns.some((u) => u.includes("tagged through")), "the unknown is not disclosed");
  });

  it("an UNREADABLE store is the cautious case, and is not turned into a question", () => {
    const ctx: SessionConstraintContext = { read: "unreadable", set: null, entryForbidsLandside: false };
    const r = certify(DECISIVE, ctx);
    assert.equal(r.inputs.constraints?.read, "unreadable");
    assert.equal(r.deadline.breakdown.bagsExtra, 15, "an unreadable declaration was read as 'no bags'");
    assert.equal(r.verdict, "no");
    assert.ok(gateOf(r).closedBy.includes("baggage_unknown"));
    assert.equal(gateOf(r).needsInfo, null, "an outage was presented to the traveller as a question");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.ok(r.unknowns.some((u) => u.includes("could not be read")));
  });

  it("under a refused border no bag answer can matter, so nothing is asked", () => {
    const r = certify(DECISIVE, declared({ baggageMode: "UNKNOWN" }), { entry: REFUSED });
    assert.equal(r.verdict, "no");
    assert.equal(gateOf(r).needsInfo, null);
    assert.deepEqual(gateOf(r).closedBy, ["entry_refused"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L222 / L284 — a self-transfer includes its recheck friction", () => {
  it("collect-and-recheck costs claim time AND bag-drop time against carry-on only", () => {
    const carryOn = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY" }));
    const collect = certify(SETTLED, declared({ baggageMode: "COLLECT_RECHECK", recheckRequired: true }));
    const exitDelta = collect.envelope.exitDelayMin - carryOn.envelope.exitDelayMin;
    const bufferDelta = collect.deadline.breakdown.totalBuffer - carryOn.deadline.breakdown.totalBuffer;
    assert.equal(exitDelta, 20, "the claim minutes are not in the exit delay");
    assert.equal(bufferDelta, 15, "the airport's bag-drop minutes are not in the return buffer");
    assert.equal(carryOn.envelope.usableMinutes - collect.envelope.usableMinutes, 35);
    assert.ok(collect.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
    assert.equal(carryOn.reasonCodes.includes("SELF_TRANSFER_FRICTION"), false);
  });

  it("separate tickets with carry-on only emit the code and the cutoff unknown, and invent no minutes", () => {
    const plain = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", recheckRequired: false }));
    const selfTransfer = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", recheckRequired: true }));
    assert.ok(selfTransfer.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
    assert.ok(selfTransfer.unknowns.some((u) => u.includes("check-in cutoff")));
    assert.equal(
      selfTransfer.deadline.hardReturnTime.toISOString(), plain.deadline.hardReturnTime.toISOString(),
      "a check-in term nobody configured moved the deadline",
    );
  });

  it("the engine's boolean sentence is dropped once the traveller has answered it", () => {
    const base = adviseLeaving(airport(), session(SETTLED, { checkedBags: true }), computeWindow(airport(), session(SETTLED, { checkedBags: true }), NOW), { entry: PERMITTED });
    assert.ok(
      base.reasons.some((r) => r.startsWith(LEGACY_CHECKED_BAGS_REASON_PREFIX)),
      "the engine's checked-bags sentence no longer starts with the prefix the gate filters on",
    );
    const collect = certify(SETTLED, declared({ baggageMode: "COLLECT_RECHECK" }));
    assert.equal(collect.reasons.some((r) => r.startsWith(LEGACY_CHECKED_BAGS_REASON_PREFIX)), false);
    const unknown = certify(SETTLED, declared({ baggageMode: "UNKNOWN" }));
    assert.ok(unknown.reasons.some((r) => r.startsWith(LEGACY_CHECKED_BAGS_REASON_PREFIX)), "UNKNOWN still needs the prompt to confirm");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L224 / L283 — an airport change subordinates exploration to the transfer", () => {
  it("closes landside at any amount of spare time, and says why", () => {
    const r = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: true }));
    assert.equal(r.verdict, "no");
    assert.ok(r.reasonCodes.includes("AIRPORT_CHANGE_REQUIRED"));
    assert.deepEqual(gateOf(r).closedBy, ["airport_change"]);
    assert.equal(gateOf(r).needsInfo, null);
    assert.equal(r.reasonCodes.includes("INSUFFICIENT_USABLE_TIME"), false);
    assert.ok(r.reasons.some((x) => x.includes("different airport")));
  });

  it("CONTROL: `false` and `null` leave the same window open", () => {
    for (const v of [false, null]) {
      const r = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: v }));
      assert.equal(r.verdict, "yes", String(v));
      assert.equal(gateOf(r).open, true, String(v));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L48 / L230 — entry != CONFIRMED_ALLOWED forbids landside under the owner's policy", () => {
  const policyOn: SessionConstraintContext = { read: "storage_off", set: null, entryForbidsLandside: true };

  it("policy ON + unresolved corridor: verdict `no`, gate closed by entry_unconfirmed", () => {
    for (const entry of [UNRESOLVED, null]) {
      const r = certify(SETTLED, policyOn, { entry });
      assert.equal(r.verdict, "no", JSON.stringify(entry));
      assert.deepEqual(gateOf(r).closedBy, ["entry_unconfirmed"]);
      assert.ok(r.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
      assert.deepEqual(r.inputs.policy, { entryForbidsLandside: true });
      assert.equal(r.windowOnly.rating, "not_recommended");
    }
  });

  it("policy ON + confirmed corridor: the same window stays `yes`", () => {
    const r = certify(SETTLED, policyOn, { entry: PERMITTED });
    assert.equal(r.verdict, "yes");
    assert.equal(gateOf(r).open, true);
    assert.equal(gateOf(r).entryPermissionState, "CONFIRMED_ALLOWED");
  });

  it("policy OFF: an unresolved corridor is `entry_unverified` and open — production behaviour does not move", () => {
    const off: SessionConstraintContext = { read: "storage_off", set: null, entryForbidsLandside: false };
    const r = certify(SETTLED, off, { entry: UNRESOLVED });
    assert.equal(r.verdict, "entry_unverified");
    assert.equal(gateOf(r).open, true);
    assert.equal("policy" in r.inputs, false);
    assert.equal(r.inputHash, legacy(SETTLED, false, UNRESOLVED).inputHash);
  });

  it("the policy is inside the hash: ON and OFF are different computations", () => {
    const off = certify(SETTLED, { read: "storage_off", set: null, entryForbidsLandside: false }, { entry: UNRESOLVED });
    const on = certify(SETTLED, policyOn, { entry: UNRESOLVED });
    assert.notEqual(on.inputHash, off.inputHash);
    assert.deepEqual(replayFeasibility(on.inputs), on);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the gate can only WITHHOLD — swept, not sampled", () => {
  it("for every window × mode × recheck × airport change × border × policy × intent", () => {
    const open = new Set(["yes", "tight", "entry_unverified"]);
    let cases = 0;
    let closedByGate = 0;
    for (let minutes = 60; minutes <= 900; minutes += 21) {
      for (const mode of BAGGAGE_MODES) {
        for (const recheckRequired of [null, true, false]) {
          for (const airportChangeRequired of [null, true]) {
            for (const entry of [PERMITTED, REFUSED, UNRESOLVED]) {
              for (const entryForbidsLandside of [false, true]) {
                for (const wantsToLeave of [true, false]) {
                  cases += 1;
                  const ctx = declared({ baggageMode: mode, recheckRequired, airportChangeRequired }, { entryForbidsLandside });
                  const gated = certify(minutes, ctx, { entry, over: { wantsToLeave } });
                  const ungated = legacy(minutes, baggageChargesBags(mode), entry, { wantsToLeave });
                  const where = `${minutes}m ${mode} recheck=${recheckRequired} change=${airportChangeRequired} entry=${entry.state} policy=${entryForbidsLandside} leave=${wantsToLeave}`;

                  // The gate never moves a number.
                  assert.equal(gated.deadline.hardReturnTime.toISOString(), ungated.deadline.hardReturnTime.toISOString(), where);
                  assert.equal(gated.envelope.usableMinutes, ungated.envelope.usableMinutes, where);
                  // It returns the engine's verdict, or withdraws it.
                  assert.ok(gated.verdict === ungated.verdict || gated.verdict === "no", `${where}: ${ungated.verdict} became ${gated.verdict}`);
                  // The traveller's own "I am staying" is never overwritten.
                  if (ungated.verdict === "stay_airside") assert.equal(gated.verdict, "stay_airside", where);
                  // The gate and the verdict are one statement.
                  const gate = gateOf(gated);
                  assert.equal(gate.open, gate.closedBy.length === 0, where);
                  assert.equal(gate.open, open.has(gated.verdict), where);
                  if (gate.open) assert.equal(open.has(ungated.verdict), true, where);
                  if (gated.verdict !== ungated.verdict) closedByGate += 1;
                }
              }
            }
          }
        }
      }
    }
    assert.ok(cases > 5000, `sweep ran only ${cases} cases`);
    assert.ok(closedByGate > 0, "NON-VACUITY: the gate never withdrew a verdict anywhere in the sweep");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("§4.1 / §5 — the state the guard decides", () => {
  type Status = "active" | "returning" | "completed" | "cancelled" | "expired";
  const at = (minutesBeforeDeparture: number, over: Record<string, unknown> = {}) =>
    certifySessionFeasibility(airport(), session(SETTLED, over) as never, {
      nowMs: ARRIVAL + (SETTLED - minutesBeforeDeparture) * 60_000, entry: PERMITTED,
    });

  it("NEEDS_INFO, AIRPORT_ONLY, LANDSIDE_AVAILABLE and PLAN_SELECTED come from the gate", () => {
    const needs = certify(DECISIVE, declared({ baggageMode: "UNKNOWN" }));
    const ok = certify(DECISIVE, declared({ baggageMode: "CARRY_ON_ONLY" }));
    const change = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: true }));
    const state = (r: typeof needs, hasLandsidePlan = false, status: Status = "active") => layoverStateOf(r, status, hasLandsidePlan);
    assert.equal(state(needs), "NEEDS_INFO");
    assert.equal(state(ok), "LANDSIDE_AVAILABLE");
    assert.equal(state(ok, true), "PLAN_SELECTED");
    assert.equal(state(change), "AIRPORT_ONLY");
    assert.equal(state(ok, false, "returning"), "RETURNING");
    assert.equal(state(ok, false, "completed"), "COMPLETED");
    assert.equal(state(ok, false, "cancelled"), "CANCELLED");
    assert.equal(state(ok, false, "expired"), "EXPIRED");
  });

  it("a traveller who may be out is escalated, not told they are at the airport", () => {
    // Past the hard return the usable window is zero, so the gate is closed by
    // the clock alone. That must read RETURN_NOW, never AIRPORT_ONLY.
    const late = at(30);
    assert.notEqual(late.envelope.returnState, "NORMAL");
    assert.deepEqual(gateOf(late).closedBy, ["insufficient_time"]);
    assert.equal(layoverStateOf(late, "active", false), "RETURN_NOW");
    // …but a traveller who SAID they are staying is not escalated out of it,
    assert.equal(layoverStateOf(at(30, { wantsToLeave: false }), "active", false), "AIRPORT_ONLY");
    // …and neither is one whose layover never had a landside window at all: a
    // 60-minute connection is "past its deadline" the moment it lands.
    const tooShort = legacy(60, false);
    assert.notEqual(tooShort.envelope.returnState, "NORMAL", "fixture: the too-short layover is not escalated by the clock");
    assert.equal(tooShort.envelope.freedomWindow, null);
    assert.equal(layoverStateOf(tooShort, "active", false), "AIRPORT_ONLY");
  });

  it("declares all seventeen members and never returns one it cannot decide", () => {
    assert.equal(LAYOVER_STATES.length, 17);
    assert.deepEqual(Object.keys(LAYOVER_STATE_SOURCES).sort(), [...LAYOVER_STATES].sort());
    const seen = new Set<string>();
    const corpus = [
      certify(DECISIVE, declared({ baggageMode: "UNKNOWN" })),
      certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY" })),
      legacy(60, false),
      at(200),
      at(30),
    ];
    // RETURN_SOON needs an instant inside the lead before the hard return.
    const soon = [...Array(240).keys()].map((m) => at(m + 1)).find((r) => r.envelope.returnState === "RETURN_SOON");
    assert.ok(soon, "fixture: no instant found at which the certified return state is RETURN_SOON");
    corpus.push(soon);
    for (const status of ["active", "returning", "completed", "cancelled", "expired"] as const) {
      for (const hasLandsidePlan of [true, false]) {
        for (const r of corpus) seen.add(layoverStateOf(r, status, hasLandsidePlan));
      }
    }
    for (const s of seen) assert.equal(LAYOVER_STATE_SOURCES[s as keyof typeof LAYOVER_STATE_SOURCES].derivable, true, `${s} was returned but is declared underivable`);
    const derivable = LAYOVER_STATES.filter((s) => LAYOVER_STATE_SOURCES[s].derivable);
    assert.deepEqual([...seen].sort(), [...derivable].sort(), "a derivable state was never produced by any input in this corpus");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("§20 / App C11 — the ledger records what was declared and what closed the gate", () => {
  const ledger = (r: ReturnType<typeof certify>) => decisionRecordFor("session-constraints", r);

  it("a legacy record gains no fact and no rule", () => {
    const d = ledger(legacy(SETTLED, true));
    assert.equal(d.inputFacts.some((f) => f.key.startsWith("constraints.") || f.key.startsWith("policy.")), false);
    assert.equal(d.rulesApplied.some((x) => x.startsWith("constraints.") || x.startsWith("gate.")), false);
  });

  it("a declared set is in the input facts, attributed to the traveller, and its mode is a rule", () => {
    const d = ledger(certify(DECISIVE, declared({ baggageMode: "UNKNOWN", recheckRequired: true })));
    const fact = (key: string) => d.inputFacts.find((f) => f.key === key);
    assert.deepEqual(fact("constraints.baggageMode"), { key: "constraints.baggageMode", value: "UNKNOWN", source: "SESSION", observedAt: null });
    assert.equal(fact("constraints.recheckRequired")?.value, true);
    assert.equal(fact("constraints.airportChangeRequired")?.value, null);
    assert.equal(fact("constraints.version")?.value, 1);
    assert.ok(d.rulesApplied.includes("constraints.baggage.UNKNOWN"));
    assert.ok(d.rulesApplied.includes("gate.baggage_unknown"));
    assert.ok(d.reasonCodes.includes("BAGGAGE_STATUS_CRITICAL_UNKNOWN"));
    for (const rule of d.rulesApplied) {
      assert.ok(LEDGER_RULE_NAMESPACES.some((ns) => rule === ns || rule.startsWith(ns + ".")), `rule ${rule} is in no declared namespace`);
    }
  });

  it("the entry policy is recorded as POLICY, and only its own closure becomes a gate rule", () => {
    const on = ledger(certify(SETTLED, { read: "storage_off", set: null, entryForbidsLandside: true }, { entry: UNRESOLVED }));
    assert.deepEqual(on.inputFacts.find((f) => f.key === "policy.entryForbidsLandside"), {
      key: "policy.entryForbidsLandside", value: true, source: "POLICY", observedAt: null,
    });
    assert.ok(on.rulesApplied.includes("gate.entry_unconfirmed"));
    // `insufficient_time` is already said by `verdict.no`; it is not repeated.
    const short = ledger(certify(60, declared({ baggageMode: "CARRY_ON_ONLY" })));
    assert.equal(short.rulesApplied.some((x) => x.startsWith("gate.")), false);
    assert.ok(short.rulesApplied.includes("verdict.no"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("L172 — the next version of a declared set", () => {
  it("a first declaration that names no baggage mode is UNKNOWN, never carry-on", () => {
    assert.deepEqual(nextConstraintSet(null, { airportChangeRequired: true }), {
      version: 1, baggageMode: "UNKNOWN", recheckRequired: null, airportChangeRequired: true,
    });
  });
  it("lays the patch over the latest version and leaves unnamed fields alone", () => {
    const v1 = nextConstraintSet(null, { baggageMode: "COLLECT_RECHECK", recheckRequired: true });
    const v2 = nextConstraintSet(v1, { baggageMode: "CHECKED_THROUGH" });
    assert.deepEqual(v2, { version: 2, baggageMode: "CHECKED_THROUGH", recheckRequired: true, airportChangeRequired: null });
    const v3 = nextConstraintSet(v2, { recheckRequired: null });
    assert.equal(v3.recheckRequired, null, "an explicit null (back to 'not stated') was ignored");
    assert.equal(v3.version, 3);
  });
});
