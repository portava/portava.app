/**
 * census-discovery DV-82 / §54 — `12`'s seven stop conditions, all produced,
 * two ruled, five measured-and-unruled.
 *
 * WHAT THIS FILE PINS
 * ===================
 *   A. "Seven" is CHECKABLE. Every condition has a producer or a named reason;
 *      every producer names a function its module really exports; and the file
 *      that must CALL the producer does so exactly when the registry says the
 *      hook has landed. A condition with neither, a producer naming a function
 *      that does not exist, or a registry that claims (or denies) a call the
 *      code does not (or does) make — each is red here.
 *   B. No threshold is invented. The five new conditions report their measured
 *      value and state `unruled`, and do not trip however extreme the value;
 *      the resolver does not fall back to legacy on them.
 *   C. Given a ruling (injected by the test — the owner has ruled none), each of
 *      the five trips above it, clears at or below it, and refuses a thin sample.
 *   D. Evidence states that are not "clear": never measured, stale, unreadable,
 *      input absent — none of them trips even under a ruling.
 *   E/F. The database reader: parsing, failure as `unreadable`, single-flight.
 *
 * The database half of these measurements is exercised against PostgreSQL 16 in
 * src/test/db/discoveryStopMeasurements.db.test.ts.
 *
 * Run: node --import tsx/esm --test src/test/discoveryStopSevenConditions.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  STOP_CONDITIONS,
  STOP_CONDITION_PRODUCERS,
  STOP_CONDITIONS_WITHOUT_PRODUCER,
  STOP_CONDITION_RULINGS,
  STOP_WINDOW_MS,
  STOP_MIN_SAMPLE,
  EVENT_REJECTION_RATE_THRESHOLD,
  LOGGING_GAP_THRESHOLD,
  DATABASE_MEASURED,
  evaluateStopConditions,
  recordStopMeasurement,
  recordRankObligation,
  recordServeLogOutcome,
  stopMeasurementsSnapshot,
  _resetStopConditionsForTest,
  type DiscoveryStopCondition,
  type StopRuling,
  type StopMeasurement,
} from "../lib/discoveryStopConditions.js";
import {
  parseStopMeasurements,
  measureDiscoveryStopInputs,
  refreshDiscoveryStopMeasurements,
} from "../lib/discoveryStopMeasurements.js";
import {
  resolveDiscoveryEngineMode,
  invalidateDiscoveryEngineModeCache,
  DISCOVERY_PDE_KILL_SWITCH,
} from "../lib/discoveryEngineMode.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = 1_900_000_000_000;
const UNRULED: DiscoveryStopCondition[] = ["creator_concentration", "reports_hides", "cache_bypass", "rls_leak", "attribution_double_count"];

const ruling = (threshold: number, minSample = 1): StopRuling => ({
  threshold, minSample, status: "owner_ruled", source: "test-injected; the owner has ruled none",
});

function measured(value: number | null, sample: number, at = T0): StopMeasurement {
  return { state: "measured", value, sample, at };
}

/** Put a value of `value` on `c`'s producer, over `sample` units of evidence. */
function feed(c: DiscoveryStopCondition, value: number, sample: number, at = T0): void {
  if (c === "cache_bypass") {
    const bypassed = Math.round(value * sample);
    for (let i = 0; i < sample; i++) recordRankObligation({ owed: true, ranked: i >= bypassed }, at);
    return;
  }
  recordStopMeasurement(c as (typeof DATABASE_MEASURED)[number], measured(value, sample, at));
}

describe("A. `12`'s seven are checkable", () => {
  it("A1. every condition has a producer or a named reason, and nothing else is registered", () => {
    assert.deepEqual(Object.keys(STOP_CONDITION_PRODUCERS).sort(), [...STOP_CONDITIONS].sort());
    for (const c of STOP_CONDITIONS) {
      const e: any = STOP_CONDITION_PRODUCERS[c];
      const hasProducer = e && typeof e === "object" && "producer" in e
        && typeof e.producer?.fn === "string" && e.producer.fn.length > 0
        && typeof e.feeds?.file === "string" && typeof e.feeds?.call === "string";
      const hasReason = e && typeof e === "object" && "reason" in e && typeof e.reason === "string" && e.reason.trim().length > 0;
      assert.ok(hasProducer !== hasReason, `${c} must have EXACTLY one of a producer or a named reason; it has ${hasProducer ? "both" : "neither"}`);
    }
  });

  it("A2. every producer names a function its module really exports", async () => {
    for (const c of STOP_CONDITIONS) {
      const e: any = STOP_CONDITION_PRODUCERS[c];
      if (!("producer" in e)) continue;
      const mod = await import(`../${e.producer.module.replace(/\.ts$/, ".js")}`);
      assert.equal(typeof mod[e.producer.fn], "function", `${c}: ${e.producer.module} does not export ${e.producer.fn}`);
    }
  });

  it("A3. the file that must call each producer does so exactly when the registry says the hook has landed", () => {
    for (const c of STOP_CONDITIONS) {
      const e: any = STOP_CONDITION_PRODUCERS[c];
      if (!("producer" in e)) continue;
      const text = readFileSync(resolve(SRC, e.feeds.file), "utf8");
      const calls = text.includes(e.feeds.call);
      assert.equal(
        calls, !e.feeds.hookPending,
        `${c}: ${e.feeds.file} ${calls ? "CALLS" : "does not call"} ${e.feeds.call} but the registry says hookPending=${e.feeds.hookPending}. ` +
        "Flip hookPending in lib/discoveryStopConditions.ts when the §54 hunk lands (or restore the call).",
      );
    }
  });

  it("A4. the producerless list is derived from the registry, not typed twice", () => {
    const derived = STOP_CONDITIONS.filter((c) => !("producer" in STOP_CONDITION_PRODUCERS[c]));
    assert.deepEqual([...STOP_CONDITIONS_WITHOUT_PRODUCER], derived);
  });

  it("A5. the two existing thresholds keep their values and are labelled UNRATIFIED; the five have no ruling", () => {
    const rej = STOP_CONDITION_RULINGS.event_rejection_rate!;
    const gap = STOP_CONDITION_RULINGS.recommendation_logging_gap!;
    assert.equal(rej.threshold, 0.05); assert.equal(rej.threshold, EVENT_REJECTION_RATE_THRESHOLD);
    assert.equal(gap.threshold, 0.10); assert.equal(gap.threshold, LOGGING_GAP_THRESHOLD);
    assert.equal(rej.minSample, STOP_MIN_SAMPLE); assert.equal(gap.minSample, STOP_MIN_SAMPLE);
    assert.equal(rej.status, "unratified_proposal"); assert.equal(gap.status, "unratified_proposal");
    for (const c of UNRULED) assert.equal(STOP_CONDITION_RULINGS[c], null, `${c} must carry no ruling until the owner makes one`);
  });
});

describe("B. no threshold is invented: the five report and refuse to trip", () => {
  beforeEach(() => _resetStopConditionsForTest());

  for (const c of UNRULED) {
    it(`B-${c}. an extreme measured value is reported as \`unruled\` and does not trip`, () => {
      feed(c, c === "rls_leak" || c === "attribution_double_count" ? 50 : 1, 500);
      const v = evaluateStopConditions(T0 + 1);
      const r = v.readings[c];
      assert.equal(r.state, "unruled");
      assert.ok(r.measured !== null && r.measured > 0, `the measured value must be REPORTED, got ${r.measured}`);
      assert.equal(r.threshold, null);
      assert.equal(r.ruling, null);
      assert.ok(!v.tripped.includes(c));
      assert.ok(v.unenforced.includes(c), "an unruled condition is named in `unenforced`");
    });
  }

  it("B-resolver. five extreme unruled readings do not force legacy: no silent default", async () => {
    invalidateDiscoveryEngineModeCache();
    for (const c of UNRULED) feed(c, c === "rls_leak" || c === "attribution_double_count" ? 50 : 1, 500, Date.now());
    const client = {
      from() {
        const q: any = { _f: "", select() { return q; }, eq(_c: string, v: string) { q._f = v; return q; },
          maybeSingle() {
            return Promise.resolve(q._f === DISCOVERY_PDE_KILL_SWITCH
              ? { data: { enabled: false }, error: null }
              : { data: { enabled: true, metadata: { mode: "pde", cohort: { kind: "all" } } }, error: null });
          } };
        return q;
      },
    };
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "pde");
    assert.equal(r.reason, "resolved");
    invalidateDiscoveryEngineModeCache();
  });
});

describe("C. once a ruling exists, each of the five trips, clears, and refuses a thin sample", () => {
  beforeEach(() => _resetStopConditionsForTest());

  const CASES: Record<string, { over: number; under: number; threshold: number }> = {
    creator_concentration:    { over: 0.8, under: 0.2, threshold: 0.5 },
    reports_hides:            { over: 0.3, under: 0.01, threshold: 0.1 },
    cache_bypass:             { over: 0.6, under: 0, threshold: 0.5 },
    rls_leak:                 { over: 2,   under: 0, threshold: 0 },
    attribution_double_count: { over: 1,   under: 0, threshold: 0 },
  };

  for (const c of UNRULED) {
    const k = CASES[c]!;
    it(`C-${c}. trips above the ruled threshold`, () => {
      feed(c, k.over, 20);
      const v = evaluateStopConditions(T0 + 1, { rulings: { [c]: ruling(k.threshold, 10) } });
      assert.equal(v.readings[c].state, "tripped");
      assert.deepEqual(v.tripped, [c], "only the ruled condition can trip");
      assert.ok(!v.unenforced.includes(c));
    });
    it(`C-${c}. clears at or below it`, () => {
      feed(c, k.under, 20);
      const v = evaluateStopConditions(T0 + 1, { rulings: { [c]: ruling(k.threshold, 10) } });
      assert.equal(v.readings[c].state, "clear");
      assert.deepEqual(v.tripped, []);
    });
    it(`C-${c}. a sample below the ruling's floor is not a verdict`, () => {
      feed(c, k.over, 5);
      const v = evaluateStopConditions(T0 + 1, { rulings: { [c]: ruling(k.threshold, 10) } });
      assert.equal(v.readings[c].state, "insufficient_evidence");
      assert.deepEqual(v.tripped, []);
    });
  }

  it("C-cache_bypass. a serve that owed no rank is not evidence of a bypass", () => {
    for (let i = 0; i < 50; i++) recordRankObligation({ owed: false, ranked: false }, T0);
    const v = evaluateStopConditions(T0 + 1, { rulings: { cache_bypass: ruling(0, 1) } });
    assert.equal(v.readings.cache_bypass.state, "no_evidence", "an out-of-cohort legacy serve is the cohort working");
  });

  it("C-window. obligation evidence ages out with the window", () => {
    feed("cache_bypass", 1, 20);
    const v = evaluateStopConditions(T0 + STOP_WINDOW_MS + 1, { rulings: { cache_bypass: ruling(0.5, 10) } });
    assert.equal(v.readings.cache_bypass.state, "no_evidence");
  });

  it("C-existing. the two existing conditions still trip under their unratified values, and say so", () => {
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 10 }, T0);
    const v = evaluateStopConditions(T0 + 1);
    assert.ok(v.tripped.includes("event_rejection_rate"));
    assert.equal(v.readings.event_rejection_rate.state, "tripped");
    assert.equal(v.readings.event_rejection_rate.ruling, "unratified_proposal");
    assert.equal(v.readings.event_rejection_rate.threshold, 0.05);
  });
});

describe("D. evidence that is not 'clear' never trips, even under a ruling", () => {
  beforeEach(() => _resetStopConditionsForTest());
  const all = Object.fromEntries(UNRULED.map((c) => [c, ruling(0, 1)]));

  it("D1. never measured ⇒ no_evidence", () => {
    const v = evaluateStopConditions(T0, { rulings: all });
    for (const c of UNRULED) assert.equal(v.readings[c].state, "no_evidence", c);
    assert.deepEqual(v.tripped, []);
  });

  it("D2. a measurement older than the window ⇒ stale, with its last value kept", () => {
    recordStopMeasurement("rls_leak", measured(3, 1, T0));
    const v = evaluateStopConditions(T0 + STOP_WINDOW_MS + 1, { rulings: all });
    assert.equal(v.readings.rls_leak.state, "stale");
    assert.equal(v.readings.rls_leak.measured, 3);
    assert.deepEqual(v.tripped, []);
  });

  it("D3. unreadable is reported, never cleared and never tripped", () => {
    recordStopMeasurement("reports_hides", { state: "unreadable", value: null, sample: 0, at: T0, detail: { reason: "rpc_error" } });
    const v = evaluateStopConditions(T0 + 1, { rulings: all });
    assert.equal(v.readings.reports_hides.state, "unreadable");
    assert.deepEqual(v.readings.reports_hides.detail, { reason: "rpc_error" });
  });

  it("D4. an absent input relation is `input_absent`, not zero double counts", () => {
    recordStopMeasurement("attribution_double_count", { state: "input_absent", value: null, sample: 0, at: T0 });
    const v = evaluateStopConditions(T0 + 1, { rulings: all });
    assert.equal(v.readings.attribution_double_count.state, "input_absent");
    assert.equal(v.readings.attribution_double_count.measured, null);
  });

  it("D5. a condition name outside the four database conditions is ignored, not stored", () => {
    recordStopMeasurement("event_rejection_rate" as never, measured(1, 100));
    assert.equal(stopMeasurementsSnapshot().size, 0);
  });
});

describe("E. parsing 3391's body", () => {
  const good = {
    reports_hides: { state: "measured", exposures: 200, hides: 10, place_reports: 2, trail_reports: null },
    creator_concentration: { state: "measured", exposures: 200, resolved: 40, creators: 2, hhi: 0.68, top_creator_share: 0.8 },
    attribution_double_count: { state: "measured", duplicate_groups: 1, extra_rows: 1, attributions_in_window: 7 },
    rls_leak: { state: "measured", deviations: 1, detail: ["discovery_place_photos SELECT anon: privilege_beyond_posture"] },
  };

  it("E1. a well-formed body becomes four measurements with their evidence", () => {
    const m = parseStopMeasurements(good, T0);
    assert.equal(m.reports_hides.value, 12 / 200);
    assert.equal(m.reports_hides.sample, 200);
    assert.equal((m.reports_hides.detail as any).hideRate, 10 / 200);
    assert.equal(m.creator_concentration.value, 0.68);
    assert.equal(m.creator_concentration.sample, 40);
    assert.equal((m.creator_concentration.detail as any).coverage, 40 / 200);
    assert.equal(m.attribution_double_count.value, 1);
    assert.equal(m.rls_leak.value, 1);
    for (const c of DATABASE_MEASURED) assert.equal(m[c].state, "measured", c);
  });

  it("E2. nothing resolved is NOT concentration 0", () => {
    const m = parseStopMeasurements({ ...good, creator_concentration: { state: "measured", exposures: 50, resolved: 0, creators: 0, hhi: null, top_creator_share: null } }, T0);
    assert.equal(m.creator_concentration.state, "measured");
    assert.equal(m.creator_concentration.value, null);
  });

  it("E3. one malformed part is unreadable ON ITS OWN", () => {
    const m = parseStopMeasurements({ ...good, rls_leak: { state: "measured", deviations: -1, detail: [] } }, T0);
    assert.equal(m.rls_leak.state, "unreadable");
    assert.equal(m.reports_hides.state, "measured");
  });

  it("E4. an absent attribution table is input_absent", () => {
    const m = parseStopMeasurements({ ...good, attribution_double_count: { state: "input_absent" } }, T0);
    assert.equal(m.attribution_double_count.state, "input_absent");
  });

  it("E5. a non-object body is four unreadables", () => {
    for (const c of DATABASE_MEASURED) assert.equal(parseStopMeasurements(null, T0)[c].state, "unreadable");
  });
});

describe("F. reading and refreshing", () => {
  beforeEach(() => _resetStopConditionsForTest());

  it("F1. a missing function (3391 unapplied) is `function_absent`, and unreadable", async () => {
    const sc = { rpc: async () => ({ data: null, error: { code: "PGRST202", message: "not found" } }) };
    const m = await measureDiscoveryStopInputs(sc, T0 - 1000, T0);
    for (const c of DATABASE_MEASURED) {
      assert.equal(m[c].state, "unreadable");
      assert.equal((m[c].detail as any).reason, "function_absent");
    }
  });

  it("F2. a throwing client and no client are unreadable, and nothing throws", async () => {
    const boom = await measureDiscoveryStopInputs({ rpc: async () => { throw new Error("down"); } }, T0 - 1000, T0);
    assert.equal(boom.rls_leak.state, "unreadable");
    const none = await measureDiscoveryStopInputs(null, T0 - 1000, T0);
    assert.equal((none.rls_leak.detail as any).reason, "no_client");
  });

  it("F3. a refresh asks for exactly the stop window and records all four", async () => {
    const calls: any[] = [];
    const sc = { rpc: async (name: string, args: any) => { calls.push({ name, args }); return { data: {
      reports_hides: { state: "measured", exposures: 10, hides: 1, place_reports: 0, trail_reports: 0 },
      creator_concentration: { state: "measured", exposures: 10, resolved: 4, creators: 1, hhi: 1, top_creator_share: 1 },
      attribution_double_count: { state: "input_absent" },
      rls_leak: { state: "measured", deviations: 0, detail: [] },
    }, error: null }; } };
    await refreshDiscoveryStopMeasurements(sc, T0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "discovery_stop_measurements");
    assert.equal(Date.parse(calls[0].args.p_until) - Date.parse(calls[0].args.p_since), STOP_WINDOW_MS);
    const snap = stopMeasurementsSnapshot();
    assert.equal(snap.size, 4);
    assert.equal(snap.get("creator_concentration")!.value, 1);
    const v = evaluateStopConditions(T0 + 1);
    assert.equal(v.readings.creator_concentration.state, "unruled");
    assert.equal(v.readings.attribution_double_count.state, "input_absent");
  });

  it("F4. refreshes are single-flight", async () => {
    let n = 0; let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sc = { rpc: async () => { n += 1; await gate; return { data: null, error: { code: "XX000" } }; } };
    const a = refreshDiscoveryStopMeasurements(sc, T0);
    const b = refreshDiscoveryStopMeasurements(sc, T0);
    release();
    await Promise.all([a, b]);
    assert.equal(n, 1);
    assert.equal(stopMeasurementsSnapshot().get("rls_leak")!.state, "unreadable");
  });
});
