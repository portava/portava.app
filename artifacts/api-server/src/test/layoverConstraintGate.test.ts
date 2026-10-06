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
 * ── REVISED 2026-10-06 (LAY-FIX) ─────────────────────────────────────────────
 * PR #588's verification returned FAIL, and several cases here had pinned the
 * defects it found: an unconfirmed border asserted `gate.open === true`, "not
 * sure" on an airport change was asserted OPEN under the name "CONTROL", a
 * self-transfer was asserted to "invent no minutes", and the legacy arm was
 * described as "byte-identical" when its hash had moved. Each of those is
 * replaced below by the stricter assertion, with the reason beside it; none is
 * deleted. The fixture `declared()` now ANSWERS the two connection questions by
 * default, because an unanswered one is no longer a neutral value — it closes
 * the gate — and a case about baggage must not be decided by it.
 * `src/test/layoverGateFailClosed.test.ts` holds the verifier's own scenarios.
 *
 * Run: node --import tsx/esm --test src/test/layoverConstraintGate.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LAYOVER_FEASIBILITY_VERSION,
  certifySessionFeasibility,
  feasibilityInputHash,
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
  constraintsChargeBags,
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
/**
 * The three borders, as one array typed ONCE. Swept loops iterate this rather
 * than an inline `[PERMITTED, REFUSED, UNRESOLVED]`: inside a loop whose body
 * calls `assert.*` (assertion signatures), the compiler narrows each union
 * constant through the loop's back edge and reports the loop variable as
 * circular (TS7022).
 */
const BORDERS: EntryEligibility[] = [PERMITTED, REFUSED, UNRESOLVED];

/**
 * A declared set. The two connection questions are ANSWERED ("no") unless a
 * case un-answers one: `null` is "not stated", which now closes the gate (the
 * airport change) or is charged as the cautious case (separate tickets), and a
 * case about baggage must not be decided by either.
 */
function declared(
  set: Partial<{ baggageMode: BaggageMode; recheckRequired: boolean | null; airportChangeRequired: boolean | null }> = {},
  over: Partial<SessionConstraintContext> = {},
): SessionConstraintContext {
  return {
    read: "declared",
    set: { version: 1, baggageMode: "UNKNOWN", recheckRequired: false, airportChangeRequired: false, ...set },
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
  // CORRECTED. This case was titled "…so the hash is the engine's own" and the
  // module header called the legacy arm "byte-identical to before". Neither was
  // true of the HASH: `feasibilityVersion` is a member of the hashed inputs and
  // #588 bumped it (it has moved again since), so every legacy `inputHash`
  // changed. What IS true, and is what the assertions below always tested, is
  // that a context which declares nothing is the SAME computation as no context.
  it("a `storage_off` context with no policy is the SAME computation as no context at all", () => {
    const plain = legacy(SETTLED, false);
    assert.equal("constraints" in plain.inputs, false);
    assert.equal("policy" in plain.inputs, false);
    const r = certify(SETTLED, { read: "storage_off", set: null, entryForbidsLandside: false });
    assert.equal(r.inputHash, plain.inputHash, "storage_off: a context that declares nothing changed the input hash");
    assert.deepEqual(r.reasons, plain.reasons);
    assert.deepEqual(r.reasonCodes, plain.reasonCodes);
    assert.equal(r.verdict, plain.verdict);
    assert.deepEqual(r.landsideGate, plain.landsideGate);
  });

  it("the legacy hash is NOT what it was before the record shape moved: `feasibilityVersion` is hashed", () => {
    const plain = legacy(SETTLED, false);
    assert.equal(plain.inputs.feasibilityVersion, LAYOVER_FEASIBILITY_VERSION);
    assert.equal(plain.inputHash, feasibilityInputHash(plain.inputs));
    for (const earlier of ["2026.09.14-1", "2026.10.04-1"]) {
      assert.notEqual(earlier, LAYOVER_FEASIBILITY_VERSION, "fixture: this is the current version, not an earlier one");
      assert.notEqual(
        feasibilityInputHash({ ...plain.inputs, feasibilityVersion: earlier }), plain.inputHash,
        `${earlier}: the same legacy inputs hash identically under a different record version — the version is not in the hash`,
      );
    }
  });

  it("UNDECLARED is no longer the legacy arm: the store is on, nothing was declared, and that is an unknown", () => {
    // Was asserted hash-equal to the legacy record. A traveller who has declared
    // nothing has not said whether they change airports, which is the same
    // unknown as a declared "not sure" — and it was certified as a "no".
    const plain = legacy(SETTLED, false);
    const r = certify(SETTLED, { read: "undeclared", set: null, entryForbidsLandside: false });
    assert.deepEqual(r.inputs.constraints, { read: "undeclared", version: null, baggageMode: null, recheckRequired: null, airportChangeRequired: null });
    assert.notEqual(r.inputHash, plain.inputHash);
    assert.equal(gateOf(r).constraintsRead, "undeclared");
    assert.equal(gateOf(r).open, false);
    assert.ok(gateOf(r).closedBy.includes("airport_change_unknown"));
    assert.deepEqual(replayFeasibility(r.inputs), r);
  });

  it("still publishes the gate, read off the verdict the engine reached", () => {
    assert.deepEqual(gateOf(legacy(SETTLED, false)).closedBy, []);
    assert.equal(gateOf(legacy(SETTLED, false)).open, true);
    assert.equal(gateOf(legacy(SETTLED, false)).status, "open");
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

    // The OWNER has not decided that an unconfirmed corridor FORBIDS landside,
    // so without the policy nothing closes: `closedBy` is empty and the verdict
    // is unchanged. What changed (LAY-FIX): this used to assert `open === true`,
    // and an open gate was drawn as a green "You can go out". Not forbidden is
    // not confirmed — the gate is `caution`, and says which.
    const unverified = legacy(SETTLED, false, UNRESOLVED);
    assert.equal(unverified.verdict, "entry_unverified");
    assert.equal(gateOf(unverified).open, false);
    assert.equal(gateOf(unverified).status, "caution");
    assert.deepEqual(gateOf(unverified).closedBy, []);
    assert.deepEqual(gateOf(unverified).cautions, ["entry_unconfirmed"]);
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

  it("answering the one question lifts the closure, either way the answer goes", () => {
    for (const mode of ["CHECKED_THROUGH", "CARRY_ON_ONLY", "COLLECT_RECHECK"] as const) {
      const r = certify(DECISIVE, declared({ baggageMode: mode }));
      assert.notEqual(r.verdict, "no", mode);
      // "Re-opens" used to be asserted as `open === true` for all three. On a
      // DECISIVE window one of the answers lands on `tight`, and a tight window
      // is not an open gate: what answering does is remove the CLOSURE.
      assert.deepEqual(gateOf(r).closedBy, [], mode);
      assert.equal(gateOf(r).open, r.verdict === "yes", mode);
      assert.equal(gateOf(r).status, r.verdict === "yes" ? "open" : "caution", mode);
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
    assert.ok(gateOf(r).closedBy.includes("constraints_unreadable"), "the outage itself is not named among the closures");
    assert.equal(gateOf(r).needsInfo, null, "an outage was presented to the traveller as a question");
    assert.equal(r.confidence, "INSUFFICIENT");
    assert.ok(r.unknowns.some((u) => u.includes("could not be read")));
  });

  it("an UNREADABLE store closes on a window where the bags could NOT have mattered — it used to stay open there", () => {
    // The case above only ever covered the DECISIVE window. On a long one the
    // old gate reasoned "bags cannot change this" and left landside open with
    // the airport change, which the unread set may hold, read as `null` = no.
    const r = certify(SETTLED, { read: "unreadable", set: null, entryForbidsLandside: false });
    assert.equal(r.verdict, "no");
    assert.equal(gateOf(r).open, false);
    assert.deepEqual(gateOf(r).closedBy, ["constraints_unreadable"]);
    assert.equal(gateOf(r).needsInfo, null);
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

  // REPLACED. This case was "…emit the code and the cutoff unknown, and invent
  // no minutes", and asserted the deadline did NOT move: SELF_TRANSFER_FRICTION
  // ("separate-ticket/recheck behavior reduces freedom", Appendix A) was a
  // label with no reduction behind it, which is census L222's requirement
  // ("recheck friction INCLUDED") asserted absent. No number is invented now
  // either: a self-transfer is charged the two bag terms the engine already
  // has, the ones collect-and-re-check uses.
  it("separate tickets with carry-on only are charged the collect-and-re-check terms, and no new number", () => {
    const plain = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", recheckRequired: false }));
    const selfTransfer = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", recheckRequired: true }));
    const collect = certify(SETTLED, declared({ baggageMode: "COLLECT_RECHECK", recheckRequired: false }));
    assert.ok(selfTransfer.reasonCodes.includes("SELF_TRANSFER_FRICTION"));
    assert.ok(selfTransfer.unknowns.some((u) => u.includes("check-in cutoff")));
    assert.equal(selfTransfer.deadline.breakdown.bagsExtra, 15, "the airport's re-check minutes are not in the return buffer");
    assert.equal(selfTransfer.envelope.exitDelayMin - plain.envelope.exitDelayMin, 20);
    assert.equal(plain.envelope.usableMinutes - selfTransfer.envelope.usableMinutes, 35, "a self-transfer was charged nothing");
    assert.equal(
      selfTransfer.deadline.hardReturnTime.toISOString(), collect.deadline.hardReturnTime.toISOString(),
      "a self-transfer was charged something OTHER than the existing collect-and-re-check constants",
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

  it("CONTROL: `false` leaves the same window open", () => {
    const r = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: false }));
    assert.equal(r.verdict, "yes");
    assert.equal(gateOf(r).open, true);
  });

  // SPLIT OUT OF THE CONTROL ABOVE, which asserted `null` open alongside
  // `false`. `null` is the card's "Not sure". Reading it as "no" is PR #588's
  // blocker 4: the traveller who does not know which airport they fly out of
  // is the one who must not be told they can go into the city.
  it("`null` (\"Not sure\") is NOT `false`: it closes the same window and asks", () => {
    const r = certify(SETTLED, declared({ baggageMode: "CARRY_ON_ONLY", airportChangeRequired: null }));
    assert.equal(r.verdict, "no");
    assert.equal(gateOf(r).open, false);
    assert.deepEqual(gateOf(r).closedBy, ["airport_change_unknown"]);
    assert.equal(gateOf(r).needsInfo, "airportChangeRequired");
    assert.equal(r.reasonCodes.includes("AIRPORT_CHANGE_REQUIRED"), false, "an unknown was published as a declared airport change");
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

  it("policy OFF: an unresolved corridor is `entry_unverified` — not FORBIDDEN, and not open either", () => {
    // Was "…and open — production behaviour does not move". The verdict, the
    // reasons and the recommendations do not move; the gate's `open` does,
    // because it is what a client drew as "You can go out".
    const off: SessionConstraintContext = { read: "storage_off", set: null, entryForbidsLandside: false };
    const r = certify(SETTLED, off, { entry: UNRESOLVED });
    assert.equal(r.verdict, "entry_unverified");
    assert.equal(gateOf(r).open, false);
    assert.equal(gateOf(r).status, "caution");
    assert.deepEqual(gateOf(r).closedBy, []);
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
    // A verdict the gate did not close. NOT the same set as "open": `tight` and
    // `entry_unverified` are cautionary, and only `yes` is open.
    const notClosed = new Set(["yes", "tight", "entry_unverified"]);
    let cases = 0;
    let closedByGate = 0;
    let opened = 0;
    for (let minutes = 60; minutes <= 900; minutes += 21) {
      for (const mode of BAGGAGE_MODES) {
        for (const recheckRequired of [null, true, false]) {
          for (const airportChangeRequired of [null, true, false]) {
            for (const entry of BORDERS) {
              for (const entryForbidsLandside of [false, true]) {
                for (const wantsToLeave of [true, false]) {
                  cases += 1;
                  const ctx = declared({ baggageMode: mode, recheckRequired, airportChangeRequired }, { entryForbidsLandside });
                  const gated = certify(minutes, ctx, { entry, over: { wantsToLeave } });
                  // The engine's own answer for the SAME effective bag term —
                  // which separate tickets (stated, or not stated) now charge too.
                  const charged = constraintsChargeBags({ read: "declared", version: 1, baggageMode: mode, recheckRequired, airportChangeRequired }, false);
                  assert.equal(charged, baggageChargesBags(mode) || recheckRequired !== false);
                  const ungated = legacy(minutes, charged, entry, { wantsToLeave });
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
                  assert.equal(gate.status === "closed", gate.closedBy.length > 0, where);
                  assert.equal(gate.status !== "closed", notClosed.has(gated.verdict), where);
                  assert.equal(gate.open, gated.verdict === "yes", `${where}: open=${gate.open} beside ${gated.verdict}`);
                  assert.equal(gate.open, gate.status === "open", where);
                  if (gate.open) {
                    assert.equal(ungated.verdict, "yes", where);
                    assert.equal(airportChangeRequired, false, `${where}: open with the airport change unanswered or declared`);
                    assert.deepEqual(gate.cautions, [], where);
                    opened += 1;
                  }
                  if (airportChangeRequired !== false && wantsToLeave) assert.equal(gated.verdict, "no", where);
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
    assert.ok(opened > 0, "NON-VACUITY: no case in the sweep was ever open — a gate that closes everything passes every line above");
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
        for (const r of corpus) {
          const state = layoverStateOf(r, status, hasLandsidePlan);
          // `null` is the cautionary gate: §5 has no state for it, and it is
          // withheld rather than approximated. It is produced by NOTHING else.
          if (state === null) assert.equal(gateOf(r).status, "caution", "the state was withheld for a gate that is not cautionary");
          else seen.add(state);
        }
      }
    }
    // …and a cautionary gate IS withheld, not reported as LANDSIDE_AVAILABLE.
    const cautionary = legacy(SETTLED, false, UNRESOLVED);
    assert.equal(gateOf(cautionary).status, "caution");
    assert.equal(layoverStateOf(cautionary, "active", false), null);
    assert.equal(layoverStateOf(cautionary, "active", true), null);
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
    // `recheckRequired: false` and not `true` as this fixture had it: separate
    // tickets charge the bag terms as a stated FACT, so with them the bag mode
    // can no longer change the verdict and `gate.baggage_unknown` (asserted
    // below) correctly does not fire. The stated-`true` fact has its own line.
    const d = ledger(certify(DECISIVE, declared({ baggageMode: "UNKNOWN", recheckRequired: false })));
    const fact = (key: string) => d.inputFacts.find((f) => f.key === key);
    assert.deepEqual(fact("constraints.baggageMode"), { key: "constraints.baggageMode", value: "UNKNOWN", source: "SESSION", observedAt: null });
    assert.equal(fact("constraints.recheckRequired")?.value, false);
    assert.equal(fact("constraints.airportChangeRequired")?.value, false);
    assert.equal(fact("constraints.version")?.value, 1);
    const stated = ledger(certify(SETTLED, declared({ baggageMode: "UNKNOWN", recheckRequired: true, airportChangeRequired: null })));
    assert.equal(stated.inputFacts.find((f) => f.key === "constraints.recheckRequired")?.value, true);
    assert.equal(stated.inputFacts.find((f) => f.key === "constraints.airportChangeRequired")?.value, null);
    assert.ok(stated.rulesApplied.includes("gate.airport_change_unknown"), "the closure an unanswered airport change adds is not in the ledger");
    assert.equal(stated.rulesApplied.includes("gate.baggage_unknown"), false);
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
