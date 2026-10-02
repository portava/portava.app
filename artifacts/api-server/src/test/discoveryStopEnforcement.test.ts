/**
 * census-discovery §82 (lane W10-O) — DV-82 / DC-32: `12`'s seven stop
 * conditions get decided halt values, and those values are ARMED only by a flag
 * seeded FALSE (migration 3470).
 *
 * WHAT THIS FILE PINS
 * ===================
 *   G1  The decided values: every one of the seven has a ruling, each a NAMED
 *       config value, each labelled `delegated_decision` and citing its
 *       register entry (docs/architecture/discovery-decision-register.md).
 *   G2  Flag OFF is byte-identical to the tree before this lane: two goldens
 *       captured from the pre-change code at `debd5ad4f` (a tripping scenario
 *       and a quiet one) are reproduced exactly by `JSON.stringify`.
 *   G3  Armed, each of the five previously unruled conditions trips above its
 *       decided value, clears at or below it, and refuses a thin sample.
 *   G4  Armed, an UNREADABLE database measurement halts (D-W10-O-2); stale, no
 *       evidence and an absent input relation do not.
 *   G5  The arming read is fail-closed: TRUE arms; FALSE, absent, an error and a
 *       throw all disarm. The flag name is the one 3470 seeds, and 3470 seeds it
 *       FALSE and refuses to commit it ON.
 *   G6  The CALLER exists: the stop-measurement refresh the engine-mode resolver
 *       already runs reads the arming flag.
 *   G7  End to end through the resolver: armed, one cache bypass forces
 *       `legacy` with reason `stop_condition`; disarmed, the same evidence does
 *       not.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryStopEnforcement.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STOP_CONDITIONS,
  STOP_CONDITION_RULINGS,
  ARMED_STOP_CONDITION_RULINGS,
  STOP_ENFORCEMENT_FLAG,
  STOP_ENFORCEMENT_VALUES_VERSION,
  STOP_MIN_SAMPLE,
  EVENT_REJECTION_RATE_THRESHOLD,
  LOGGING_GAP_THRESHOLD,
  CREATOR_CONCENTRATION_HHI_THRESHOLD,
  CREATOR_CONCENTRATION_MIN_RESOLVED,
  REPORTS_HIDES_RATE_THRESHOLD,
  REPORTS_HIDES_MIN_EXPOSURES,
  CACHE_BYPASS_SHARE_THRESHOLD,
  CACHE_BYPASS_MIN_OBLIGATIONS,
  RLS_LEAK_DEVIATION_THRESHOLD,
  RLS_LEAK_MIN_SAMPLE,
  ATTRIBUTION_DOUBLE_COUNT_THRESHOLD,
  ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE,
  STOP_UNREADABLE_HALTS_WHEN_ARMED,
  STOP_WINDOW_MS,
  evaluateStopConditions,
  recordStopMeasurement,
  recordRankObligation,
  recordServeLogOutcome,
  refreshStopEnforcement,
  stopEnforcementArmed,
  _resetStopConditionsForTest,
  type DiscoveryStopCondition,
} from "../lib/discoveryStopConditions.js";
import { refreshDiscoveryStopMeasurements } from "../lib/discoveryStopMeasurements.js";
import {
  resolveDiscoveryEngineMode,
  invalidateDiscoveryEngineModeCache,
  DISCOVERY_PDE_KILL_SWITCH,
} from "../lib/discoveryEngineMode.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = 1_900_000_000_000;
const FIVE: DiscoveryStopCondition[] = ["creator_concentration", "reports_hides", "cache_bypass", "rls_leak", "attribution_double_count"];

/** A feature_flags-only client: `flags` maps a flag name to a row, an error, or a throw. */
type FlagRow = { enabled: boolean; metadata?: Record<string, unknown> } | "error" | "throw" | undefined;
interface FlagQuery { _flag: string; select(): FlagQuery; eq(c: string, v: string): FlagQuery; maybeSingle(): Promise<unknown> }
function flagClient(flags: Record<string, FlagRow>, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    from(table: string) {
      const q: FlagQuery = { _flag: "", select() { return q; }, eq(_c: string, v: string) { q._flag = v; return q; },
        maybeSingle() {
          if (table !== "feature_flags") return Promise.resolve({ data: null, error: null });
          const f = flags[q._flag];
          if (f === "throw") throw new Error("flag read threw");
          if (f === "error") return Promise.resolve({ data: null, error: { code: "XX000", message: "down" } });
          return Promise.resolve({ data: f ?? null, error: null });
        } };
      return q;
    },
  };
}

const ARMED_META = { values_version: STOP_ENFORCEMENT_VALUES_VERSION };
async function arm(on: boolean): Promise<void> {
  await refreshStopEnforcement(flagClient({ [STOP_ENFORCEMENT_FLAG]: { enabled: on, metadata: ARMED_META } }));
  assert.equal(stopEnforcementArmed(), on, "precondition: the arming read took effect");
}

function feed(c: DiscoveryStopCondition, value: number, sample: number, at = T0 - 1000): void {
  if (c === "cache_bypass") {
    const bypassed = Math.round(value * sample);
    for (let i = 0; i < sample; i++) recordRankObligation({ owed: true, ranked: i >= bypassed }, at);
    return;
  }
  recordStopMeasurement(c as "creator_concentration", { state: "measured", value, sample, at });
}

// ── The goldens, captured from lib/discoveryStopConditions.ts at debd5ad4f ──
// (scratchpad probe, before any edit). Flag OFF must reproduce them byte for byte.
const GOLDEN_TRIPPING = `{"tripped":["event_rejection_rate","recommendation_logging_gap"],"unenforced":["creator_concentration","reports_hides","cache_bypass","rls_leak","attribution_double_count"],"attempts":30,"eventRejectionRate":0.1,"loggingGapRate":0.19,"readings":{"event_rejection_rate":{"measured":0.1,"sample":30,"threshold":0.05,"ruling":"unratified_proposal","state":"tripped"},"recommendation_logging_gap":{"measured":0.19,"sample":30,"threshold":0.1,"ruling":"unratified_proposal","state":"tripped"},"creator_concentration":{"measured":0.9,"sample":400,"threshold":null,"ruling":null,"detail":{"resolved":400},"state":"unruled"},"reports_hides":{"measured":0.3,"sample":400,"threshold":null,"ruling":null,"state":"unruled"},"cache_bypass":{"measured":0.05,"sample":40,"threshold":null,"ruling":null,"detail":{"owed":40,"bypassed":2},"state":"unruled"},"rls_leak":{"measured":null,"sample":null,"threshold":null,"ruling":null,"state":"unreadable","detail":{"reason":"rpc_error"}},"attribution_double_count":{"measured":2,"sample":9,"threshold":null,"ruling":null,"state":"unruled"}}}`;
const GOLDEN_QUIET = `{"tripped":[],"unenforced":["creator_concentration","reports_hides","cache_bypass","rls_leak","attribution_double_count"],"attempts":25,"eventRejectionRate":0,"loggingGapRate":0,"readings":{"event_rejection_rate":{"measured":0,"sample":25,"threshold":0.05,"ruling":"unratified_proposal","state":"clear"},"recommendation_logging_gap":{"measured":0,"sample":25,"threshold":0.1,"ruling":"unratified_proposal","state":"clear"},"creator_concentration":{"measured":0.1,"sample":400,"threshold":null,"ruling":null,"state":"unruled"},"reports_hides":{"measured":0.01,"sample":400,"threshold":null,"ruling":null,"state":"unruled"},"cache_bypass":{"measured":0,"sample":5,"threshold":null,"ruling":null,"detail":{"owed":5,"bypassed":0},"state":"unruled"},"rls_leak":{"measured":0,"sample":1,"threshold":null,"ruling":null,"detail":{"deviations":[]},"state":"unruled"},"attribution_double_count":{"measured":null,"sample":null,"threshold":null,"ruling":null,"state":"input_absent","detail":{"reason":"creator_attributions_absent"}}}}`;

function trippingScenario(): void {
  for (let i = 0; i < 30; i++) recordServeLogOutcome({ outcome: i < 3 ? "rejected" : "landed", servedItems: 10, landedRows: i < 3 ? 0 : 9 }, T0 - 1000);
  for (let i = 0; i < 40; i++) recordRankObligation({ owed: true, ranked: i >= 2 }, T0 - 1000);
  recordStopMeasurement("creator_concentration", { state: "measured", value: 0.9, sample: 400, at: T0 - 1000, detail: { resolved: 400 } });
  recordStopMeasurement("reports_hides", { state: "measured", value: 0.3, sample: 400, at: T0 - 1000 });
  recordStopMeasurement("rls_leak", { state: "unreadable", value: null, sample: 0, at: T0 - 1000, detail: { reason: "rpc_error" } });
  recordStopMeasurement("attribution_double_count", { state: "measured", value: 2, sample: 9, at: T0 - 1000 });
}
function quietScenario(): void {
  for (let i = 0; i < 25; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10 }, T0 - 1000);
  for (let i = 0; i < 5; i++) recordRankObligation({ owed: true, ranked: true }, T0 - 1000);
  recordStopMeasurement("creator_concentration", { state: "measured", value: 0.1, sample: 400, at: T0 - 1000 });
  recordStopMeasurement("reports_hides", { state: "measured", value: 0.01, sample: 400, at: T0 - 1000 });
  recordStopMeasurement("rls_leak", { state: "measured", value: 0, sample: 1, at: T0 - 1000, detail: { deviations: [] } });
  recordStopMeasurement("attribution_double_count", { state: "input_absent", value: null, sample: 0, at: T0 - 1000, detail: { reason: "creator_attributions_absent" } });
}

describe("G1. the decided halt values (D-W10-O-1)", () => {
  it("G1a. every one of the seven has an armed ruling, and each value is a named config value", () => {
    const expected: Record<DiscoveryStopCondition, [number, number]> = {
      event_rejection_rate:       [EVENT_REJECTION_RATE_THRESHOLD, STOP_MIN_SAMPLE],
      recommendation_logging_gap: [LOGGING_GAP_THRESHOLD, STOP_MIN_SAMPLE],
      creator_concentration:      [CREATOR_CONCENTRATION_HHI_THRESHOLD, CREATOR_CONCENTRATION_MIN_RESOLVED],
      reports_hides:              [REPORTS_HIDES_RATE_THRESHOLD, REPORTS_HIDES_MIN_EXPOSURES],
      cache_bypass:               [CACHE_BYPASS_SHARE_THRESHOLD, CACHE_BYPASS_MIN_OBLIGATIONS],
      rls_leak:                   [RLS_LEAK_DEVIATION_THRESHOLD, RLS_LEAK_MIN_SAMPLE],
      attribution_double_count:   [ATTRIBUTION_DOUBLE_COUNT_THRESHOLD, ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE],
    };
    for (const c of STOP_CONDITIONS) {
      const r = ARMED_STOP_CONDITION_RULINGS[c];
      assert.ok(r, `${c} has no armed ruling`);
      assert.deepEqual([r.threshold, r.minSample], expected[c], `${c}'s armed ruling is not its named config value`);
      assert.equal(r.status, "delegated_decision");
      assert.match(r.source, /D-W10-O-1/, `${c}'s source must cite the register entry`);
    }
  });

  it("G1b. the values are the ones the register records", () => {
    assert.deepEqual(
      [EVENT_REJECTION_RATE_THRESHOLD, LOGGING_GAP_THRESHOLD, STOP_MIN_SAMPLE, STOP_WINDOW_MS,
        CREATOR_CONCENTRATION_HHI_THRESHOLD, CREATOR_CONCENTRATION_MIN_RESOLVED,
        REPORTS_HIDES_RATE_THRESHOLD, REPORTS_HIDES_MIN_EXPOSURES,
        CACHE_BYPASS_SHARE_THRESHOLD, CACHE_BYPASS_MIN_OBLIGATIONS,
        RLS_LEAK_DEVIATION_THRESHOLD, RLS_LEAK_MIN_SAMPLE,
        ATTRIBUTION_DOUBLE_COUNT_THRESHOLD, ATTRIBUTION_DOUBLE_COUNT_MIN_SAMPLE, STOP_UNREADABLE_HALTS_WHEN_ARMED],
      [0.05, 0.10, 20, 600_000, 0.25, 100, 0.05, 100, 0, 1, 0, 1, 0, 1, true]);
    const register = readFileSync(resolve(SRC, "../../../docs/architecture/discovery-decision-register.md"), "utf8");
    assert.match(register, /D-W10-O-1\b/);
    for (const needle of ["0.25", "100 resolved", "0.05", "100 exposures", "any bypass", "any deviation", "any live double count", "discovery_stop_enforcement_enabled"]) {
      assert.ok(register.includes(needle), `the register does not record "${needle}"`);
    }
  });

  it("G1c. the flag-off table is untouched: two unratified values, five unruled", () => {
    assert.equal(STOP_CONDITION_RULINGS.event_rejection_rate!.status, "unratified_proposal");
    assert.equal(STOP_CONDITION_RULINGS.recommendation_logging_gap!.status, "unratified_proposal");
    for (const c of FIVE) assert.equal(STOP_CONDITION_RULINGS[c], null);
  });
});

describe("G2. flag OFF is byte-identical to the tree before this lane", () => {
  beforeEach(() => _resetStopConditionsForTest());

  it("G2a. a fresh process is disarmed", () => {
    assert.equal(stopEnforcementArmed(), false);
  });
  it("G2b. the tripping scenario reproduces its golden", () => {
    trippingScenario();
    assert.equal(JSON.stringify(evaluateStopConditions(T0)), GOLDEN_TRIPPING);
  });
  it("G2c. the quiet scenario reproduces its golden", () => {
    quietScenario();
    assert.equal(JSON.stringify(evaluateStopConditions(T0)), GOLDEN_QUIET);
  });
  it("G2d. after an explicit FALSE read, still byte-identical", async () => {
    await arm(false);
    trippingScenario();
    assert.equal(JSON.stringify(evaluateStopConditions(T0)), GOLDEN_TRIPPING);
  });
  it("G2e. a reset disarms (so no test can leak an armed process into another)", async () => {
    await arm(true);
    _resetStopConditionsForTest();
    assert.equal(stopEnforcementArmed(), false);
  });
});

describe("G3. armed: each of the five trips, clears, and refuses a thin sample", () => {
  beforeEach(async () => { _resetStopConditionsForTest(); await arm(true); });

  const cases: Record<string, { at: number; above: number; floor: number }> = {
    creator_concentration:    { at: 0.25, above: 0.26, floor: 100 },
    reports_hides:            { at: 0.05, above: 0.06, floor: 100 },
    cache_bypass:             { at: 0,    above: 0.01, floor: 1 },
    rls_leak:                 { at: 0,    above: 1,    floor: 1 },
    attribution_double_count: { at: 0,    above: 1,    floor: 1 },
  };
  for (const c of FIVE) {
    const k = cases[c]!;
    it(`G3-${c}. trips above ${k.at}`, () => {
      feed(c, k.above, c === "cache_bypass" ? 100 : Math.max(k.floor, 1));
      const v = evaluateStopConditions(T0);
      assert.equal(v.readings[c].state, "tripped");
      assert.equal(v.readings[c].ruling, "delegated_decision");
      assert.ok(v.tripped.includes(c));
      assert.ok(!v.unenforced.includes(c), "an armed condition is enforced");
    });
    it(`G3-${c}. clears at ${k.at}`, () => {
      feed(c, k.at, c === "cache_bypass" ? 100 : Math.max(k.floor, 1));
      const v = evaluateStopConditions(T0);
      assert.equal(v.readings[c].state, "clear");
      assert.ok(!v.tripped.includes(c));
    });
    if (k.floor > 1) {
      it(`G3-${c}. a sample below ${k.floor} is not a verdict`, () => {
        feed(c, 1, k.floor - 1);
        assert.equal(evaluateStopConditions(T0).readings[c].state, "insufficient_evidence");
      });
    }
  }

  it("G3-cache_bypass. ONE bypass among many owed ranks is a halt: `12` says 'reappears'", () => {
    for (let i = 0; i < 500; i++) recordRankObligation({ owed: true, ranked: i !== 7 }, T0 - 1000);
    const v = evaluateStopConditions(T0);
    assert.deepEqual(v.readings.cache_bypass.detail, { owed: 500, bypassed: 1 });
    assert.ok(v.tripped.includes("cache_bypass"));
  });

  it("G3-all. armed, nothing is unenforced", () => {
    assert.deepEqual([...evaluateStopConditions(T0).unenforced], []);
  });
});

describe("G4. armed: an unreadable measurement halts (D-W10-O-2); other non-clear states do not", () => {
  beforeEach(async () => { _resetStopConditionsForTest(); await arm(true); });

  it("G4a. unreadable ⇒ tripped, and the reading still SAYS unreadable", () => {
    recordStopMeasurement("rls_leak", { state: "unreadable", value: null, sample: 0, at: T0 - 1000, detail: { reason: "function_absent" } });
    const v = evaluateStopConditions(T0);
    assert.equal(v.readings.rls_leak.state, "unreadable");
    assert.ok(v.tripped.includes("rls_leak"));
  });
  it("G4b. stale, never measured and an absent input relation do not halt", () => {
    recordStopMeasurement("rls_leak", { state: "measured", value: 5, sample: 1, at: T0 - STOP_WINDOW_MS - 1 });
    recordStopMeasurement("attribution_double_count", { state: "input_absent", value: null, sample: 0, at: T0 - 1000 });
    const v = evaluateStopConditions(T0);
    assert.equal(v.readings.rls_leak.state, "stale");
    assert.equal(v.readings.creator_concentration.state, "no_evidence");
    assert.equal(v.readings.attribution_double_count.state, "input_absent");
    assert.deepEqual(v.tripped, []);
  });
  it("G4c. disarmed, the same unreadable reading does not halt (as today)", async () => {
    await arm(false);
    recordStopMeasurement("rls_leak", { state: "unreadable", value: null, sample: 0, at: T0 - 1000 });
    assert.deepEqual(evaluateStopConditions(T0).tripped, []);
  });
});

describe("G5. the arming read is fail-closed, and 3470 seeds it FALSE", () => {
  beforeEach(() => _resetStopConditionsForTest());

  const cases: Array<[string, FlagRow]> = [["FALSE", { enabled: false, metadata: ARMED_META }], ["absent", undefined], ["an error", "error"], ["a throw", "throw"],
    ["TRUE naming no values version", { enabled: true }], ["TRUE naming another values version", { enabled: true, metadata: { values_version: "stop-values-1999-01-01.1" } }]];
  for (const [label, row] of cases) {
    it(`G5. ${label} disarms, even after an earlier TRUE`, async () => {
      await arm(true);
      await refreshStopEnforcement(flagClient({ [STOP_ENFORCEMENT_FLAG]: row }));
      assert.equal(stopEnforcementArmed(), false);
    });
  }
  it("G5. no client disarms", async () => {
    await arm(true);
    await refreshStopEnforcement(null);
    assert.equal(stopEnforcementArmed(), false);
  });
  it("G5-version. the values version is pinned to the decided values: change one, bump the version (and re-approve)", () => {
    assert.equal(STOP_ENFORCEMENT_VALUES_VERSION, "stop-values-2026-09-28.1");
    assert.deepEqual(STOP_CONDITIONS.map((c) => [c, ARMED_STOP_CONDITION_RULINGS[c].threshold, ARMED_STOP_CONDITION_RULINGS[c].minSample, ARMED_STOP_CONDITION_RULINGS[c].haltOnUnreadable === true]), [
      ["event_rejection_rate", 0.05, 20, false], ["recommendation_logging_gap", 0.10, 20, false],
      ["creator_concentration", 0.25, 100, true], ["reports_hides", 0.05, 100, true],
      ["cache_bypass", 0, 1, false], ["rls_leak", 0, 1, true], ["attribution_double_count", 0, 1, true],
    ], "a value changed: bump STOP_ENFORCEMENT_VALUES_VERSION, record it in the register, and re-approve (D-W10-O-3)");
  });
  it("G5-3470. the flag name is the one 3470 seeds, FALSE, with a postcondition refusing ON", () => {
    assert.equal(STOP_ENFORCEMENT_FLAG, "discovery_stop_enforcement_enabled");
    const sql = readFileSync(resolve(SRC, "migrations/3470_discovery_stop_enforcement_flag.sql"), "utf8");
    assert.match(sql, /'discovery_stop_enforcement_enabled',\s*\n\s*false,/);
    assert.match(sql, /ON CONFLICT \(flag\) DO NOTHING/);
    assert.match(sql, /enabled = TRUE;\s*\n\s*IF on_count <> 0 THEN/);
  });
});

describe("G6. the caller: the refresh the resolver already runs reads the arming flag", () => {
  beforeEach(() => _resetStopConditionsForTest());

  it("G6a. refreshDiscoveryStopMeasurements arms from the flag", async () => {
    const sc = flagClient({ [STOP_ENFORCEMENT_FLAG]: { enabled: true, metadata: ARMED_META } }, {
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "absent" } }),
    });
    await refreshDiscoveryStopMeasurements(sc, T0);
    assert.equal(stopEnforcementArmed(), true);
  });
  it("G6b. and disarms from it", async () => {
    await arm(true);
    const sc = flagClient({ [STOP_ENFORCEMENT_FLAG]: { enabled: false, metadata: ARMED_META } }, { rpc: async () => ({ data: null, error: { code: "XX000" } }) });
    await refreshDiscoveryStopMeasurements(sc, T0);
    assert.equal(stopEnforcementArmed(), false);
  });
  it("G6c. the refresh's source names the arming read (the hook cannot silently disappear)", () => {
    const src = readFileSync(resolve(SRC, "lib/discoveryStopMeasurements.ts"), "utf8");
    assert.match(src, /refreshStopEnforcement\(sc\)/);
  });
});

describe("G7. through the resolver", () => {
  beforeEach(() => { _resetStopConditionsForTest(); invalidateDiscoveryEngineModeCache(); });

  /** The resolver's client: pde for everyone, the manual stop off, and the arming flag as given. */
  function resolverClient(armed: boolean) {
    return {
      rpc: async () => ({ data: null, error: { code: "XX000" } }),
      from() {
        const q: { _f: string; select(): typeof q; eq(c: string, v: string): typeof q; maybeSingle(): Promise<unknown> } = { _f: "", select() { return q; }, eq(_c: string, v: string) { q._f = v; return q; },
          maybeSingle() {
            if (q._f === DISCOVERY_PDE_KILL_SWITCH) return Promise.resolve({ data: { enabled: false }, error: null });
            if (q._f === STOP_ENFORCEMENT_FLAG) return Promise.resolve({ data: { enabled: armed, metadata: ARMED_META }, error: null });
            return Promise.resolve({ data: { enabled: true, metadata: { mode: "pde", cohort: { kind: "all" } } }, error: null });
          } };
        return q;
      },
    };
  }

  it("G7a. armed: one cache bypass resolves legacy / stop_condition", async () => {
    await arm(true);
    recordRankObligation({ owed: true, ranked: false });
    const r = await resolveDiscoveryEngineMode(resolverClient(true));
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "stop_condition");
    invalidateDiscoveryEngineModeCache();
  });
  it("G7b. disarmed: the same evidence leaves pde resolved (today's behaviour)", async () => {
    recordRankObligation({ owed: true, ranked: false });
    const r = await resolveDiscoveryEngineMode(resolverClient(false));
    assert.equal(r.mode, "pde");
    assert.equal(r.reason, "resolved");
    invalidateDiscoveryEngineModeCache();
  });
});
