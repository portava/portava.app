/**
 * LAYOVER 165, lane B2-CURATE — the maturity threshold and the entry policy on
 * the CERTIFIED RECORD, the recalibrated band in the ENGINE, and the
 * no-alternative-route sweep. Pure / fake-client; the real-schema proof is
 * src/test/db/airportCurationWorkflow.db.test.ts.
 *
 *   G1  L243/L249  a curated L1 profile certifies landside not-closed-by-maturity; any one fact missing or EXPIRED closes it
 *   G2  L243  the closure is part of the record: verdict no, AIRPORT_MATURITY_LIMITED, replay reproduces it, the hash moves with topology_version
 *   G3  L243  staying airside is the traveller's own answer — no maturity closure is added to it; a hand-built profile is the legacy arm
 *   E1  L48/L77  the loader's entry policy is ON whatever the flag says (absent / FALSE / TRUE); unreadable still closes
 *   E2  L48   with the policy on, an unresolved corridor closes landside (`entry_unconfirmed`), a confirmed one does not
 *   C1  L83/L247  recalibrateBand: minimum-sample rule, bounded step up/down, outcome coverage, evidence labels, arithmetic
 *   C2  L83   the historical screen keeps past readings and still refuses implausible, future, duplicate and flooding ones
 *   C3  L83   the engine reads the band: only ever earlier deadlines, and the deadline stays monotone in the cutoff
 *   A1  L48   restrictToCertifiedLandside keeps airside cards only under a closed record
 *   N1  L48/L77  no production file builds a FeasibilityAirport/AirportProfile by hand without carrying the curation projection
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { certifyFeasibility, certifySessionFeasibility, type FeasibilityAirport } from "../services/airport/LayoverFeasibility.js";
import type { EntryEligibility } from "../services/airport/layoverEntryGate.js";
import type { AirportCurationProjection } from "../services/airport/airportCurationPolicy.js";
import { attachConstraintContext, readConstraintFlags } from "../services/layover/LayoverConstraintStore.js";
import {
  CALIBRATED_FACT_TYPE,
  MIN_CALIBRATION_OBSERVATIONS,
  MIN_OUTCOME_RETURNS,
  STEP_DOWN_MINUTES,
  STEP_UP_MINUTES,
  engineCheckpointBudget,
  recalibrateBand,
  screenHistoricalObservations,
} from "../services/airport/layoverCalibration.js";
import { computeReturnDeadline } from "../services/airport/LayoverSafetyEngine.js";
import { restrictToCertifiedLandside } from "../services/airport/layoverLandsideAdmission.js";

const NOW = Date.parse("2030-06-15T02:00:00.000Z"); // 10:00 Singapore
const DAY = 86_400_000;
const live = (id: string) => ({ factId: id, expiresAt: new Date(NOW + 10 * DAY).toISOString() });
const dead = (id: string) => ({ factId: id, expiresAt: new Date(NOW - 1).toISOString() });
const L1: AirportCurationProjection = { timing: live("t"), topology: live("g"), transport: live("r"), topologyVersion: 3, calibration: null };

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-zzt", iataCode: "ZZT", timezone: "Asia/Singapore", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    curation: L1, ...over,
  };
}
const session = (hours: number, over: Record<string, unknown> = {}) => ({
  id: "s-1", arrivalTime: new Date(NOW).toISOString(), departureTime: new Date(NOW + hours * 3_600_000).toISOString(), boardingTime: null,
  flightType: "international" as const, immigrationRequired: true, checkedBags: false, wantsToLeave: true, ...over,
});
const PERMITTED: EntryEligibility = { state: "permitted", status: "visa_free", corridor: { passportCountry: "US", destinationCountry: "SG" } };
const UNRESOLVED: EntryEligibility = { state: "unresolved", reason: "no_data_for_corridor" };
const certify = (a: FeasibilityAirport, hours = 9, entry: EntryEligibility | null = PERMITTED, over: Record<string, unknown> = {}) =>
  certifySessionFeasibility(a, session(hours, over) as never, { nowMs: NOW, entry });

describe("§22 maturity threshold on the certified record", () => {
  it("G1 L1 from three published, unexpired facts; any one missing or expired closes landside", () => {
    const open = certify(airport());
    assert.equal(open.inputs.maturity?.rung, "L1_MAPPED");
    assert.ok(!open.landsideGate.closedBy.includes("airport_maturity_limited"), JSON.stringify(open.landsideGate));
    assert.equal(open.verdict, "yes");
    for (const [name, c] of [
      ["timing missing", { ...L1, timing: null }], ["topology missing", { ...L1, topology: null }], ["transport missing", { ...L1, transport: null }],
      ["timing expired", { ...L1, timing: dead("t") }], ["topology expired", { ...L1, topology: dead("g") }], ["transport expired", { ...L1, transport: dead("r") }],
    ] as const) {
      const r = certify(airport({ curation: c as AirportCurationProjection }));
      assert.ok(r.landsideGate.closedBy.includes("airport_maturity_limited"), name);
      assert.equal(r.inputs.maturity?.landsideAllowed, false, name);
      assert.equal(r.verdict, "no", name);
      assert.equal(r.inputs.airport.verified, false, `${name}: an expired curation is not verified at the record's instant`);
    }
    // No airport row at all (the static dataset / the manual fallback): L0.
    assert.ok(certify(airport({ id: null })).landsideGate.closedBy.includes("airport_maturity_limited"));
  });

  it("G2 the closure is IN the record: reason code, reason sentence, replay, and an input hash that moves with topology_version", () => {
    const r = certify(airport({ curation: { ...L1, topology: null } }));
    assert.ok(r.reasonCodes.includes("AIRPORT_MATURITY_LIMITED"));
    assert.ok(r.reasons.some((s) => /checked information about this airport/.test(s)));
    const replayed = certifyFeasibility(r.inputs);
    assert.deepEqual(replayed.landsideGate, r.landsideGate);
    assert.equal(replayed.inputHash, r.inputHash);
    const v3 = certify(airport());
    const v4 = certify(airport({ curation: { ...L1, topologyVersion: 4 } }));
    assert.notEqual(v3.inputHash, v4.inputHash, "an authoritative change is a different computation");
  });

  it("G3 staying airside adds no maturity closure; a hand-built profile without the projection is the legacy arm", () => {
    const stay = certify(airport({ curation: { ...L1, timing: null } }), 9, PERMITTED, { wantsToLeave: false });
    assert.ok(!stay.landsideGate.closedBy.includes("airport_maturity_limited"));
    const legacy = certify(airport({ curation: undefined, verified: false }));
    assert.equal("maturity" in legacy.inputs, false, "no projection, no key: the legacy hash is unchanged");
  });
});

// ── §6.1 entry: the loader's policy ──────────────────────────────────────────

function flagsDb(rows: Record<string, boolean | "absent" | "error">) {
  return {
    from(table: string) {
      assert.equal(table, "feature_flags");
      let flag = "";
      const q: any = {
        select: () => q,
        eq: (_c: string, v: string) => { flag = v; return q; },
        maybeSingle: async () => {
          const st = rows[flag] ?? "absent";
          if (st === "error") return { data: null, error: { message: "boom" } };
          return { data: st === "absent" ? null : { enabled: st }, error: null };
        },
      };
      return q;
    },
  } as never;
}

describe("§6.1 entry policy — fail closed in every flag state", () => {
  it("E1 the loader's policy is ON whatever layover_entry_forbid_landside_enabled says; unreadable is not off", async () => {
    for (const state of ["absent", false, true] as const) {
      const f = await readConstraintFlags(flagsDb({ layover_entry_forbid_landside_enabled: state }));
      assert.deepEqual(f, { readable: true, storage: false, entryForbidsLandside: true }, String(state));
      const s = await attachConstraintContext(flagsDb({ layover_entry_forbid_landside_enabled: state }), { id: "s" });
      assert.deepEqual((s as any).constraints, { read: "storage_off", set: null, entryForbidsLandside: true }, String(state));
    }
    assert.deepEqual(await readConstraintFlags(flagsDb({ layover_entry_forbid_landside_enabled: "error" })), { readable: false });
  });

  it("E2 with the loader's context, an unresolved corridor closes landside and a confirmed one does not", () => {
    const ctx = { read: "storage_off" as const, set: null, entryForbidsLandside: true };
    const closed = certify(airport(), 9, UNRESOLVED, { constraints: ctx });
    assert.ok(closed.landsideGate.closedBy.includes("entry_unconfirmed"));
    assert.equal(closed.verdict, "no");
    const missing = certify(airport(), 9, null, { constraints: ctx });
    assert.ok(missing.landsideGate.closedBy.includes("entry_unconfirmed"), "no corridor resolved at all is unknown, not allowed");
    const open = certify(airport(), 9, PERMITTED, { constraints: ctx });
    assert.ok(!open.landsideGate.closedBy.includes("entry_unconfirmed"));
    assert.equal(open.verdict, "yes");
  });
});

// ── §10 recalibration ────────────────────────────────────────────────────────

const WIN = { startMs: NOW - 90 * DAY, endMs: NOW };
const obs = (samples: number, observers: number, p90: number) => ({ samples, distinctObservers: observers, p90 });
const none = { compliantReturns: 0, missed: 0 };

describe("§10 historical model — recalibrated", () => {
  it("C1 minimum-sample rule, bounded steps, coverage, evidence and the stored arithmetic", () => {
    const h = 13;
    const budget = engineCheckpointBudget(h);
    assert.equal(recalibrateBand(null, { hour: h, observation: obs(MIN_CALIBRATION_OBSERVATIONS - 1, 5, 90), outcomes: none }, WIN, NOW), null, "too few readings");
    assert.equal(recalibrateBand(null, { hour: h, observation: obs(50, 2, 90), outcomes: none }, WIN, NOW), null, "too few distinct observers");
    assert.equal(recalibrateBand(null, { hour: h, observation: null, outcomes: { compliantReturns: MIN_OUTCOME_RETURNS - 1, missed: 4 } }, WIN, NOW), null, "too few outcomes");
    const up = recalibrateBand(null, { hour: h, observation: obs(20, 4, budget + 40), outcomes: none }, WIN, NOW)!;
    assert.equal(up.priorP90, budget);
    assert.equal(up.stepApplied, STEP_UP_MINUTES, "bounded up");
    assert.equal(up.calibratedP90, budget + STEP_UP_MINUTES);
    assert.equal(up.extraMinutes, STEP_UP_MINUTES);
    assert.equal(up.meanSignedError, -40, "prior − observed: negative = the model under-predicted");
    assert.equal(up.evidence, "observations");
    const down = recalibrateBand(budget + 30, { hour: h, observation: obs(20, 4, budget), outcomes: none }, WIN, NOW)!;
    assert.equal(down.stepApplied, -STEP_DOWN_MINUTES, "bounded down, and slower than up");
    const small = recalibrateBand(null, { hour: h, observation: obs(20, 4, budget + 3), outcomes: none }, WIN, NOW)!;
    assert.equal(small.stepApplied, 3, "a step inside the bound is the whole correction");
    const below = recalibrateBand(null, { hour: h, observation: obs(20, 4, 1), outcomes: none }, WIN, NOW)!;
    assert.equal(below.extraMinutes, 0, "a band below the engine's own budget adds nothing — the engine never relaxes");
    const missed = recalibrateBand(null, { hour: h, observation: null, outcomes: { compliantReturns: 10, missed: 2 } }, WIN, NOW)!;
    assert.equal(missed.outcomeCoverageRate, 0.8);
    assert.equal(missed.stepApplied, STEP_UP_MINUTES, "compliant returns that missed: the model under-predicts, raise by the bound");
    assert.equal(missed.evidence, "outcomes");
    const fine = recalibrateBand(null, { hour: h, observation: null, outcomes: { compliantReturns: 10, missed: 0 } }, WIN, NOW)!;
    assert.equal(fine.stepApplied, 0, "covered outcomes confirm the prior");
    const both = recalibrateBand(null, { hour: h, observation: obs(20, 4, budget + 2), outcomes: { compliantReturns: 10, missed: 3 } }, WIN, NOW)!;
    assert.equal(both.evidence, "observations_and_outcomes");
    assert.equal(both.stepApplied, STEP_UP_MINUTES, "the conservative target wins");
    for (const s of [up, down, small, below, missed, fine, both]) {
      assert.equal(s.calibratedP90, s.priorP90 + s.stepApplied);
      assert.equal(s.extraMinutes, Math.max(0, s.calibratedP90 - s.engineBudget));
      assert.ok(s.stepApplied <= s.stepBoundUp && s.stepApplied >= -s.stepBoundDown);
      assert.equal(s.factType, CALIBRATED_FACT_TYPE);
    }
  });

  it("C2 the historical screen keeps past readings and refuses implausible, future, duplicate and flooding ones", () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    const base = { airportRef: "ZZT", factType: CALIBRATED_FACT_TYPE, observerKind: "community" as const, sourceRef: "s" };
    const kept = screenHistoricalObservations([
      { ...base, observationId: "a", value: 30, observerId: "o1", observedAt: at(10 * 1440) }, // ten days old: kept (TTL is a LIVE rule)
      { ...base, observationId: "b", value: 999, observerId: "o2", observedAt: at(60) }, // implausible
      { ...base, observationId: "c", value: 30, observerId: "o3", observedAt: new Date(NOW + 60_000).toISOString() }, // future
      { ...base, observationId: "a", value: 31, observerId: "o1", observedAt: at(20) }, // duplicate id
      ...[1, 2, 3, 4].map((i) => ({ ...base, observationId: `f${i}`, value: 20, observerId: "flood", observedAt: at(i) })), // 4 in 15 min
    ], WIN);
    assert.deepEqual(kept.map((o) => o.observationId).sort(), ["a", "f2", "f3", "f4"], "the three OLDEST of the flood are kept in time order; the fourth inside 15 min is refused");
  });

  it("C3 the engine reads the band: an earlier deadline at the calibrated hour only, and still monotone in the cutoff", () => {
    const tz = "Asia/Singapore";
    const cal = new Array<number>(24).fill(0);
    cal[14] = 15; // 14:00-15:00 local
    const base = { timezone: tz, verified: true, domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20 };
    const sess = (cutoffMs: number) => ({ flightType: "international" as const, immigrationRequired: true, checkedBags: false, departureTime: new Date(cutoffMs).toISOString(), boardingTime: null });
    const at1430 = Date.parse("2030-06-15T06:30:00Z");
    const plain = computeReturnDeadline(base, sess(at1430)).hardReturnTime.getTime();
    const tuned = computeReturnDeadline({ ...base, calibratedCheckpointExtra: cal }, sess(at1430)).hardReturnTime.getTime();
    assert.equal(plain - tuned, 15 * 60_000, "15 calibrated minutes at 14:30 local");
    assert.equal(computeReturnDeadline({ ...base, calibratedCheckpointExtra: cal }, sess(at1430)).breakdown.timeOfDayExtra
      - computeReturnDeadline(base, sess(at1430)).breakdown.timeOfDayExtra, 15, "and they are the TIME-OF-DAY term's, where the breakdown says they are");
    const at1030 = Date.parse("2030-06-15T02:30:00Z");
    assert.equal(computeReturnDeadline({ ...base, calibratedCheckpointExtra: cal }, sess(at1030)).hardReturnTime.getTime(),
      computeReturnDeadline(base, sess(at1030)).hardReturnTime.getTime(), "another hour is untouched");
    let prev = -Infinity;
    for (let m = 0; m <= 36 * 60; m += 1) {
      const c = Date.parse("2030-06-15T00:00:00Z") + m * 60_000;
      const d = computeReturnDeadline({ ...base, calibratedCheckpointExtra: cal }, sess(c)).hardReturnTime.getTime();
      assert.ok(d >= prev, `deadline moved backwards at +${m} min`);
      assert.ok(d <= computeReturnDeadline(base, sess(c)).hardReturnTime.getTime(), `calibration relaxed a deadline at +${m} min`);
      prev = d;
    }
  });
});

describe("no alternative route around the certified landside gate", () => {
  it("A1 restrictToCertifiedLandside keeps airside cards only under a closed record", () => {
    const cards = [{ id: "a", insideAirport: true }, { id: "b", insideAirport: false }, { id: "c" }];
    const closed = certify(airport({ curation: { ...L1, transport: null } }));
    const open = certify(airport());
    assert.deepEqual(restrictToCertifiedLandside(cards, closed).map((c) => c.id), ["a"]);
    assert.deepEqual(restrictToCertifiedLandside(cards, open).map((c) => c.id), ["a", "b", "c"]);
    assert.deepEqual(restrictToCertifiedLandside(cards, null).map((c) => c.id), ["a"], "no record admits nothing landside");
  });

  it("N1 no production file builds a FeasibilityAirport or AirportProfile by hand without the curation projection", () => {
    const SRC = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) { if (!["test", "__tests__", "node_modules"].includes(e)) walk(p); continue; }
        if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(SRC);
    // A function returning, or a const typed as, one of the two shapes and built from an object literal.
    const builder = /(?:\)\s*:\s*(?:FeasibilityAirport|AirportProfile)\s*\{[\s\S]{0,400}?return\s*\{|:\s*(?:FeasibilityAirport|AirportProfile)\s*=\s*\{)/g;
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      if (rel === "services/airport/AirportProfileService.ts") continue; // the three mappers: they SET the projection
      if (rel === "services/layover/replay/layoverScenarioCorpus.ts") continue; // the replay corpus: fixed historical inputs, never served
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(builder)) {
        const body = text.slice(m.index!, m.index! + 1200);
        if (!/curation/.test(body)) offenders.push(`${rel}:${text.slice(0, m.index!).split("\n").length}`);
      }
    }
    assert.deepEqual(offenders, [], "a hand-built airport object drops the curation projection and certifies on the legacy arm");
  });
});
