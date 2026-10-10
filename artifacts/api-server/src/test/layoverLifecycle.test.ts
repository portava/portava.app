/**
 * layoverLifecycle — spec §5's state graph (census-layover L39, L40, L43).
 *
 * Pure: the graph is exercised directly, and the EVALUATING guard is exercised
 * on records the production certifier (`certifySessionFeasibility`) produces,
 * so the guard is checked against the gate it must agree with rather than
 * against a hand-built record.
 *
 * Run: node --import tsx/esm --test src/test/layoverLifecycle.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility, type FeasibilityAirport } from "../services/airport/LayoverFeasibility.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import { LAYOVER_STATES, layoverStateOf, type LayoverState } from "../services/airport/LayoverConstraints.js";
import {
  ACTIVE_STATES,
  LANDSIDE_AVAILABLE_FLOOR_MIN,
  LIFECYCLE_EDGES,
  LIFECYCLE_EVENTS,
  LIFECYCLE_EVENT_PRODUCERS,
  STORED_ACTIVE_STATES,
  STORED_OPERATION_EVENTS,
  TERMINAL_STATES,
  landsideAvailableGuard,
  lifecycleStateFrom,
  shadowStoredOperation,
  storedStatusState,
  transition,
  type LifecycleGuardContext,
  type StoredOperation,
} from "../services/airport/LayoverLifecycle.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

function airport(): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
  };
}
const ARRIVAL = Date.parse("2030-06-15T00:00:00.000Z");
function session(minutes: number) {
  return {
    id: "session-lifecycle",
    arrivalTime: new Date(ARRIVAL).toISOString(),
    departureTime: new Date(ARRIVAL + minutes * 60_000).toISOString(),
    boardingTime: null,
    flightType: "international" as const,
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
  };
}
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const REFUSED: EntryEligibility = { state: "refused", status: "visa_required", corridor: { passportCountry: "GB", destinationCountry: "TW" } };
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };
const BORDERS: EntryEligibility[] = [PERMITTED, REFUSED, UNRESOLVED];

function certify(minutes: number, entry: EntryEligibility = PERMITTED, nowMs = ARRIVAL) {
  return certifySessionFeasibility(airport(), session(minutes) as never, { nowMs, entry });
}

const PASSING: LifecycleGuardContext = {
  entryPermissionState: "CONFIRMED_ALLOWED",
  criticalUnknowns: [],
  usableMinutes: 200,
  returnContractSatisfiable: true,
};

// ── L39: the graph ───────────────────────────────────────────────────────────

describe("L39 — the declared state graph", () => {
  it("has all seventeen §4.1 states, and every one is an edge endpoint", () => {
    assert.equal(LAYOVER_STATES.length, 17);
    const touched = new Set<LayoverState>();
    for (const e of LIFECYCLE_EDGES) {
      e.from.forEach((s) => touched.add(s));
      if (typeof e.to === "string") touched.add(e.to);
    }
    // The branching EVALUATED edge's two targets.
    touched.add("LANDSIDE_AVAILABLE"); touched.add("AIRPORT_ONLY");
    touched.add("COMPLETED"); touched.add("CANCELLED");
    assert.deepEqual([...touched].sort(), [...LAYOVER_STATES].sort());
  });

  it("every state is reachable from DETECTED along §5's edges (guards satisfied)", () => {
    const ctxs: LifecycleGuardContext[] = [
      { ...PASSING, needsInfo: true }, { ...PASSING, needsInfo: false, hasLandsidePlan: true },
      { entryPermissionState: "UNKNOWN", criticalUnknowns: [], usableMinutes: 10, returnContractSatisfiable: false, needsInfo: false },
      { checkpoint: "LANDSIDE_EXIT" }, { returnState: "RETURN_SOON" }, { returnState: "RETURN_NOW" },
      { checkpoint: "AIRPORT_REENTRY" }, { materialChange: true }, { departurePassed: true },
      { closeOutcome: "completed" }, { closeOutcome: "cancelled" },
    ];
    const seen = new Set<LayoverState>(["DETECTED"]);
    let frontier: LayoverState[] = ["DETECTED"];
    while (frontier.length) {
      const next: LayoverState[] = [];
      for (const s of frontier) for (const ev of LIFECYCLE_EVENTS) for (const c of ctxs) {
        const t = transition(s, ev, c);
        if (t.ok && !seen.has(t.to)) { seen.add(t.to); next.push(t.to); }
      }
      frontier = next;
    }
    assert.deepEqual([...seen].sort(), [...LAYOVER_STATES].sort());
  });

  it("terminal states take no event", () => {
    for (const s of TERMINAL_STATES) for (const ev of LIFECYCLE_EVENTS) {
      const t = transition(s, ev, { ...PASSING, closeOutcome: "completed", departurePassed: true, materialChange: true });
      assert.equal(t.ok, false, `${s} --${ev}--> must be refused`);
      if (!t.ok) assert.equal(t.refusal, "terminal_state");
    }
  });

  it("§5's own chain: DETECTED → … → COMPLETED, each with its guard", () => {
    const steps: Array<[LayoverState, (typeof LIFECYCLE_EVENTS)[number], LifecycleGuardContext, LayoverState]> = [
      ["DETECTED", "FACTS_MISSING", { needsInfo: true }, "NEEDS_INFO"],
      ["NEEDS_INFO", "FACTS_SUFFICIENT", { needsInfo: false }, "EVALUATING"],
      ["EVALUATING", "EVALUATED", PASSING, "LANDSIDE_AVAILABLE"],
      ["LANDSIDE_AVAILABLE", "PLAN_CHOSEN", { ...PASSING, hasLandsidePlan: true }, "PLAN_SELECTED"],
      ["PLAN_SELECTED", "AIRPORT_EXITED", { checkpoint: "LANDSIDE_EXIT" }, "EXECUTING"],
      ["EXECUTING", "RETURN_THRESHOLD", { returnState: "RETURN_SOON" }, "RETURN_SOON"],
      ["RETURN_SOON", "HARD_THRESHOLD", { returnState: "RETURN_NOW" }, "RETURN_NOW"],
      ["RETURN_NOW", "RETURN_BEGINS", {}, "RETURNING"],
      ["RETURNING", "AIRPORT_REENTERED", { checkpoint: "AIRPORT_REENTRY" }, "AIRPORT_REENTERED"],
      ["AIRPORT_REENTERED", "BOARDING_STARTED", {}, "BOARDING"],
      ["BOARDING", "DEPARTURE_CONFIRMED", {}, "COMPLETED"],
    ];
    for (const [from, ev, ctx, to] of steps) {
      const t = transition(from, ev, ctx);
      assert.ok(t.ok, `${from} --${ev}--> refused: ${JSON.stringify(t)}`);
      if (t.ok) assert.equal(t.to, to);
    }
  });

  it("each guarded step is refused when its guard does not hold", () => {
    const refusals: Array<[LayoverState, (typeof LIFECYCLE_EVENTS)[number], LifecycleGuardContext]> = [
      ["DETECTED", "FACTS_MISSING", {}],
      ["NEEDS_INFO", "FACTS_SUFFICIENT", { needsInfo: true }],
      ["LANDSIDE_AVAILABLE", "PLAN_CHOSEN", { ...PASSING, hasLandsidePlan: false }],
      ["PLAN_SELECTED", "AIRPORT_EXITED", {}],
      ["EXECUTING", "RETURN_THRESHOLD", { returnState: "NORMAL" }],
      ["RETURN_SOON", "HARD_THRESHOLD", { returnState: "RETURN_SOON" }],
      ["RETURNING", "AIRPORT_REENTERED", { checkpoint: "LANDSIDE_EXIT" }],
      ["EXECUTING", "MATERIAL_DISRUPTION", { materialChange: false }],
      ["EXECUTING", "TIMEOUT", { departurePassed: false }],
    ];
    for (const [from, ev, ctx] of refusals) {
      const t = transition(from, ev, ctx);
      assert.equal(t.ok, false, `${from} --${ev}--> must be refused under ${JSON.stringify(ctx)}`);
      if (!t.ok) assert.equal(t.refusal, "guard_failed");
    }
  });

  it("names a producer — or the absence of one — for every event", () => {
    assert.deepEqual(Object.keys(LIFECYCLE_EVENT_PRODUCERS).sort(), [...LIFECYCLE_EVENTS].sort());
    // The three states with no producer on this tree are declared as such, not approximated.
    for (const ev of ["BOARDING_STARTED", "DEPARTURE_CONFIRMED", "ABANDONED"] as const) {
      assert.equal(LIFECYCLE_EVENT_PRODUCERS[ev], null);
    }
  });
});

// ── L40: EVALUATING → LANDSIDE_AVAILABLE ─────────────────────────────────────

describe("L40 — EVALUATING → LANDSIDE_AVAILABLE, its four-part guard and its side effects", () => {
  it("all four conditions met → LANDSIDE_AVAILABLE with snapshot + envelope + candidate set", () => {
    const t = transition("EVALUATING", "EVALUATED", PASSING);
    assert.ok(t.ok);
    if (!t.ok) return;
    assert.equal(t.to, "LANDSIDE_AVAILABLE");
    assert.deepEqual(t.intents, ["CREATE_SNAPSHOT", "CREATE_SAFE_ENVELOPE", "CREATE_CANDIDATE_SET"]);
    assert.deepEqual(t.branchFailures, []);
  });

  const cases: Array<[string, LifecycleGuardContext, string]> = [
    ["entry UNKNOWN", { ...PASSING, entryPermissionState: "UNKNOWN" }, "entry_not_confirmed_allowed"],
    ["entry refused", { ...PASSING, entryPermissionState: "CONFIRMED_NOT_ALLOWED" }, "entry_not_confirmed_allowed"],
    ["entry absent", { ...PASSING, entryPermissionState: undefined }, "entry_not_confirmed_allowed"],
    ["a critical unknown", { ...PASSING, criticalUnknowns: ["baggage_mode"] }, "critical_unknowns_present"],
    ["critical unknowns unread", { ...PASSING, criticalUnknowns: null }, "critical_unknowns_unread"],
    ["usable below the floor", { ...PASSING, usableMinutes: LANDSIDE_AVAILABLE_FLOOR_MIN - 1 }, "usable_time_below_floor"],
    ["usable NaN", { ...PASSING, usableMinutes: Number.NaN }, "usable_time_unknown"],
    ["usable absent", { ...PASSING, usableMinutes: undefined }, "usable_time_unknown"],
    ["return contract unsatisfiable", { ...PASSING, returnContractSatisfiable: false }, "return_contract_not_satisfiable"],
    ["return contract unknown", { ...PASSING, returnContractSatisfiable: null }, "return_contract_unknown"],
  ];
  for (const [name, ctx, failure] of cases) {
    it(`${name} → AIRPORT_ONLY, named ${failure}, no candidate set`, () => {
      const t = transition("EVALUATING", "EVALUATED", ctx);
      assert.ok(t.ok);
      if (!t.ok) return;
      assert.equal(t.to, "AIRPORT_ONLY");
      assert.deepEqual(t.branchFailures, [failure]);
      assert.ok(!t.intents.includes("CREATE_CANDIDATE_SET"));
      assert.ok(t.intents.includes("SUPPRESS_LANDSIDE_RECOMMENDATIONS"));
    });
  }

  it("the floor IS adviseLeaving's `yes` rung, not a second number", () => {
    let below = 0, atOrAbove = 0;
    for (let m = 150; m <= 420; m += 1) {
      const r = certify(m);
      const u = r.envelope.usableMinutes;
      if (u < LANDSIDE_AVAILABLE_FLOOR_MIN && u >= 45) { below++; assert.notEqual(r.verdict, "yes", `usable ${u} must not be yes`); }
      if (u >= LANDSIDE_AVAILABLE_FLOOR_MIN && r.verdict !== "no") { atOrAbove++; assert.equal(r.verdict, "yes", `usable ${u} must be yes`); }
    }
    assert.ok(below > 0 && atOrAbove > 0, "the sweep must straddle the floor");
  });

  it("on every certified record, the graph's guard and the landside gate agree (no guard_vs_gate divergence)", () => {
    let compared = 0;
    for (const entry of BORDERS) for (let m = 120; m <= 900; m += 7) {
      const r = certify(m, entry);
      for (const plan of [false, true]) {
        const projected = layoverStateOf(r, "active", plan);
        const ev = lifecycleStateFrom({ projectedState: projected, record: r, hasLandsidePlan: plan, latestCheckpoint: null });
        assert.ok(!ev.divergence.includes("guard_vs_gate"), `m=${m} entry=${entry.state} plan=${plan}: ${JSON.stringify(ev)}`);
        compared++;
      }
    }
    assert.ok(compared > 100);
  });

  it("a permitted roomy layover is LANDSIDE_AVAILABLE; an unconfirmed border is EVALUATING with the entry failure named", () => {
    const yes = certify(480, PERMITTED);
    const a = lifecycleStateFrom({ projectedState: layoverStateOf(yes, "active", false), record: yes, hasLandsidePlan: false, latestCheckpoint: null });
    assert.equal(a.state, "LANDSIDE_AVAILABLE");
    assert.deepEqual(a.guardFailures, []);
    assert.deepEqual(a.intents, ["CREATE_SNAPSHOT", "CREATE_SAFE_ENVELOPE", "CREATE_CANDIDATE_SET"]);

    const unk = certify(480, UNRESOLVED);
    const b = lifecycleStateFrom({ projectedState: layoverStateOf(unk, "active", false), record: unk, hasLandsidePlan: false, latestCheckpoint: null });
    assert.equal(b.state, "EVALUATING");
    assert.ok(b.guardFailures.includes("entry_not_confirmed_allowed"));
    assert.ok(!b.availableEvents.includes("PLAN_CHOSEN"));
  });
});

// ── L43: RETURNING → AIRPORT_REENTERED ───────────────────────────────────────

describe("L43 — RETURNING → AIRPORT_REENTERED on a re-entry checkpoint", () => {
  it("the checkpoint is the guard, and the side effects are stop-landside + refresh gate/security", () => {
    const t = transition("RETURNING", "AIRPORT_REENTERED", { checkpoint: "AIRPORT_REENTRY" });
    assert.ok(t.ok);
    if (!t.ok) return;
    assert.equal(t.to, "AIRPORT_REENTERED");
    assert.deepEqual(t.intents, ["STOP_LANDSIDE_DISCOVERY", "REFRESH_GATE_AND_SECURITY"]);
    assert.equal(transition("RETURNING", "AIRPORT_REENTERED", {}).ok, false);
  });

  it("a traveller's latest AIRPORT_REENTRY places a live session in AIRPORT_REENTERED", () => {
    const r = certify(480);
    for (const projected of ["RETURNING", "RETURN_NOW", "PLAN_SELECTED"] as const) {
      const ev = lifecycleStateFrom({ projectedState: projected, record: r, hasLandsidePlan: true, latestCheckpoint: "AIRPORT_REENTRY" });
      assert.equal(ev.state, "AIRPORT_REENTERED");
      assert.ok(ev.intents.includes("STOP_LANDSIDE_DISCOVERY"));
    }
    const ended = lifecycleStateFrom({ projectedState: "COMPLETED", record: r, hasLandsidePlan: true, latestCheckpoint: "AIRPORT_REENTRY" });
    assert.equal(ended.state, "COMPLETED");
  });

  it("LANDSIDE_EXIT moves an unescalated traveller to EXECUTING, and leaving without the guard is REPORTED", () => {
    const ok = certify(480, PERMITTED);
    const e1 = lifecycleStateFrom({ projectedState: layoverStateOf(ok, "active", true), record: ok, hasLandsidePlan: true, latestCheckpoint: "LANDSIDE_EXIT" });
    assert.equal(e1.state, "EXECUTING");
    assert.deepEqual(e1.divergence, []);

    const closed = certify(480, REFUSED);
    const e2 = lifecycleStateFrom({ projectedState: layoverStateOf(closed, "active", false), record: closed, hasLandsidePlan: false, latestCheckpoint: "LANDSIDE_EXIT" });
    assert.equal(e2.state, "EXECUTING", "a traveller who said they left is not told they are at the airport");
    assert.ok(e2.divergence.includes("left_without_guard"));

    const escalated = lifecycleStateFrom({ projectedState: "RETURN_NOW", record: ok, hasLandsidePlan: true, latestCheckpoint: "LANDSIDE_EXIT" });
    assert.equal(escalated.state, "RETURN_NOW", "a checkpoint never undoes escalation");
  });
});

// ── RETURN_SOON / RETURN_NOW side effects (L41 / L42's intents) ─────────────

describe("the return rungs' required side effects", () => {
  it("RETURN_SOON: high-priority notification + de-emphasise discovery; RETURN_NOW: the CTA switch", () => {
    const soon = transition("EXECUTING", "RETURN_THRESHOLD", { returnState: "RETURN_SOON" });
    assert.ok(soon.ok && soon.intents.includes("HIGH_PRIORITY_NOTIFICATION") && soon.intents.includes("DEEMPHASIZE_DISCOVERY"));
    for (const rs of ["RETURN_NOW", "CONNECTION_AT_RISK"] as const) {
      const now = transition("RETURN_SOON", "HARD_THRESHOLD", { returnState: rs });
      assert.ok(now.ok && now.to === "RETURN_NOW" && now.intents.includes("SWITCH_PRIMARY_CTA_TO_RETURN"));
    }
    const skipped = transition("EXECUTING", "HARD_THRESHOLD", { returnState: "RETURN_NOW" });
    assert.ok(skipped.ok && skipped.to === "RETURN_NOW");
    if (skipped.ok) assert.equal(skipped.source, "§5 escalation, rung skipped");
  });

  it("a material disruption invalidates, replans and preserves the audit trail", () => {
    const t = transition("PLAN_SELECTED", "MATERIAL_DISRUPTION", { materialChange: true });
    assert.ok(t.ok);
    if (t.ok) assert.deepEqual(t.intents, ["INVALIDATE_STALE_RECOMMENDATIONS", "REPLAN", "PRESERVE_AUDIT_TRAIL"]);
  });
});

// ── nothing currently allowed becomes disallowed ─────────────────────────────

describe("every status write the database accepts today has an edge", () => {
  /** The stored statuses each write's own WHERE clause accepts (LayoverSessionService / LayoverSafeReturnService). */
  const ACCEPTED_FROM: Record<"end_completed" | "end_cancelled" | "expire_sweep" | "return_now", string[]> = {
    end_completed: ["active", "returning"],
    end_cancelled: ["active", "returning"],
    expire_sweep: ["active", "returning"],
    return_now: ["active"],
  };
  for (const [op, statuses] of Object.entries(ACCEPTED_FROM) as Array<[keyof typeof ACCEPTED_FROM, string[]]>) {
    it(`${op}: accepted from every state a stored ${statuses.join("/")} row can be in, resolved or not`, () => {
      for (const status of statuses) {
        const states: Array<LayoverState | null> = status === "active" ? [null, ...STORED_ACTIVE_STATES] : [storedStatusState(status)];
        for (const s of states) {
          const v = shadowStoredOperation(op, s);
          assert.equal(v.divergent, false, `${op} from ${s ?? "(active, unresolved)"}: ${JSON.stringify(v.transition)}`);
        }
      }
    });
  }

  it("a write on an ended session is refused by the graph exactly as the database refuses it", () => {
    for (const status of ["completed", "cancelled", "expired"]) {
      for (const op of ["end_completed", "end_cancelled", "expire_sweep", "return_now"] as StoredOperation[]) {
        assert.equal(shadowStoredOperation(op, storedStatusState(status)).divergent, true);
      }
    }
  });

  it("the traveller's close names its outcome", () => {
    const c = shadowStoredOperation("end_completed", null);
    const x = shadowStoredOperation("end_cancelled", "RETURNING");
    assert.ok(c.transition.ok && c.transition.to === "COMPLETED");
    assert.ok(x.transition.ok && x.transition.to === "CANCELLED");
  });

  it("checkpoints are observations: one the graph cannot place is flagged, never refused by it", () => {
    assert.equal(shadowStoredOperation("checkpoint_landside_exit", "PLAN_SELECTED").divergent, false);
    assert.equal(shadowStoredOperation("checkpoint_landside_exit", "AIRPORT_ONLY").divergent, true);
    assert.equal(shadowStoredOperation("checkpoint_airport_reentry", "RETURNING").divergent, false);
    const unresolved = shadowStoredOperation("checkpoint_airport_reentry", null);
    assert.equal(unresolved.divergent, true);
    if (!unresolved.transition.ok) assert.equal(unresolved.transition.refusal, "from_state_unresolved");
  });

  it("an unresolved `active` row takes an event only when EVERY state it could be in takes it to the same place", () => {
    // DETECTED alone would take FACTS_MISSING; the other active states would not.
    const t = transition(null, "FACTS_MISSING", { needsInfo: true });
    assert.equal(t.ok, false);
    if (!t.ok) assert.equal(t.refusal, "from_state_unresolved");
    const close = transition(null, "TRAVELLER_CLOSED", { closeOutcome: "cancelled" });
    assert.ok(close.ok && close.from === null && close.to === "CANCELLED");
  });

  it("the stored-operation map covers every write that changes a status", () => {
    assert.deepEqual(Object.keys(STORED_OPERATION_EVENTS).sort(), [
      "checkpoint_airport_reentry", "checkpoint_landside_exit", "end_cancelled", "end_completed", "expire_sweep", "return_now",
    ]);
    assert.equal(ACTIVE_STATES.length + TERMINAL_STATES.length, 17);
  });

  it("the guard reads only positive answers (sanity of the exported guard)", () => {
    assert.deepEqual(landsideAvailableGuard(PASSING), []);
    assert.equal(landsideAvailableGuard({}).length, 4);
  });
});
