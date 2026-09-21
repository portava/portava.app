/**
 * DISCOVERY_ENGINE_MODE resolution
 *
 * Stage 1's exit criterion is that the dispatch is a genuine no-op: every state
 * the flag can be in resolves to `legacy`, which is current production
 * behaviour. These tests are that criterion, written so it can be re-checked
 * rather than asserted once.
 *
 * The rulings under test:
 *   D1=B  read through lib/featureFlags.ts (exact match, reads metadata) and
 *         NOT through compass/flags.ts, whose LIKE 'COMPASS_%' loader would
 *         return false for this flag with no error and no log line
 *   D2=A  one row; enabled is the master switch, metadata.mode selects the path
 *   D3=B  every failure state -> legacy, AND pde additionally requires that
 *         disable_discovery_pde is not engaged
 *
 * Tests:
 *  A. No row                      -> legacy / flag_absent
 *  B. enabled = false             -> legacy / flag_disabled     (even with mode: pde)
 *  C. metadata absent or no mode  -> legacy / mode_missing
 *  D. metadata.mode invalid       -> legacy / mode_invalid
 *  E. mode = legacy               -> legacy / resolved
 *  F. mode = shadow               -> shadow / resolved
 *  G. mode = pde, no stop         -> pde    / resolved
 *  H. mode = pde, stop engaged    -> legacy / kill_switch_engaged
 *  I. mode = pde, stop UNREADABLE -> legacy / kill_switch_engaged  (inverted polarity)
 *  J. mode = shadow, stop errors  -> shadow / resolved  (stop is read ONLY for pde)
 *  K. null client                 -> legacy / no_client
 *  L. a throwing client           -> legacy, never propagates
 *  M. the resolution is cached inside the TTL
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryEngineMode.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDiscoveryEngineMode,
  invalidateDiscoveryEngineModeCache,
  DISCOVERY_ENGINE_MODE_FLAG,
  DISCOVERY_PDE_KILL_SWITCH,
} from "../lib/discoveryEngineMode.js";
import { isInDiscoveryCohort } from "../lib/discoveryCohort.js";

/**
 * Stub answering the two feature_flags reads the resolver makes: getFlagRow for
 * the mode, isKillSwitchEngaged for the stop. Both go through
 * .from().select().eq().maybeSingle(), so the stub dispatches on the flag name.
 */
function makeClient(opts: {
  modeRow?:   { enabled: boolean; metadata: unknown } | null;
  modeError?: unknown;
  stopRow?:   { enabled: boolean } | null;
  stopError?: unknown;
  throws?:    boolean;
}) {
  let stopReads = 0;
  const client = {
    from(_table: string) {
      const q: any = {
        _flag: "",
        select() { return q; },
        eq(_col: string, val: string) { q._flag = val; return q; },
        maybeSingle() {
          if (opts.throws) throw new Error("client exploded");
          if (q._flag === DISCOVERY_PDE_KILL_SWITCH) {
            stopReads += 1;
            return Promise.resolve({ data: opts.stopRow ?? null, error: opts.stopError ?? null });
          }
          return Promise.resolve({ data: opts.modeRow ?? null, error: opts.modeError ?? null });
        },
      };
      return q;
    },
  };
  return { client, stopReads: () => stopReads };
}

const meta = (mode: unknown) => ({ enabled: true, metadata: { mode } });

/**
 * Compare only the mode and the reason.
 *
 * ResolvedMode also carries the D6 cohort (added with the cohort gate). These
 * tests are about MODE resolution; asserting the whole object would make every
 * one of them fail the next time a diagnostic field is added, which trains
 * people to update assertions rather than read them. Cohort resolution has its
 * own tests below and in discoveryCohort.test.ts.
 */
function modeOf(r: { mode: string; reason: string }) {
  return { mode: r.mode, reason: r.reason };
}

describe("DISCOVERY_ENGINE_MODE — every failure state resolves to legacy", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("A. a missing row resolves to legacy", async () => {
    const { client } = makeClient({ modeRow: null });
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), {
      mode: "legacy", reason: "flag_absent",
    });
  });

  it("B. enabled=false resolves to legacy even when metadata says pde", async () => {
    const { client } = makeClient({ modeRow: { enabled: false, metadata: { mode: "pde" } } });
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), {
      mode: "legacy", reason: "flag_disabled",
    });
  });

  it("C. an enabled row with no mode resolves to legacy", async () => {
    for (const metadata of [null, {}, { other: "x" }]) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: { enabled: true, metadata } });
      const r = await resolveDiscoveryEngineMode(client);
      assert.deepEqual(modeOf(r), { mode: "legacy", reason: "mode_missing" });
    }
  });

  it("D. an unrecognised mode resolves to legacy", async () => {
    for (const bad of ["PDE", "shadow ", "new", "", 3, true, null]) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: meta(bad) });
      const r = await resolveDiscoveryEngineMode(client);
      assert.equal(r.mode, "legacy", `${JSON.stringify(bad)} must not resolve to a live mode`);
    }
  });

  it("K. a null client resolves to legacy", async () => {
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(null)), {
      mode: "legacy", reason: "no_client",
    });
  });

  it("L. a throwing client resolves to legacy and never propagates", async () => {
    const { client } = makeClient({ throws: true });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "legacy");
  });
});

describe("DISCOVERY_ENGINE_MODE — configured modes", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("E/F. legacy and shadow resolve as configured", async () => {
    for (const mode of ["legacy", "shadow"] as const) {
      invalidateDiscoveryEngineModeCache();
      const { client } = makeClient({ modeRow: meta(mode) });
      assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), { mode, reason: "resolved" });
    }
  });

  it("G. pde resolves when no stop is configured", async () => {
    // A MISSING stop row means "no stop has been configured" and is NOT
    // engaged — isKillSwitchEngaged inverts the FAILURE, not the flag.
    const { client } = makeClient({ modeRow: meta("pde"), stopRow: null });
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), {
      mode: "pde", reason: "resolved",
    });
  });
});

describe("DISCOVERY_ENGINE_MODE — the PDE stop (D3=B)", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("H. an engaged stop forces legacy", async () => {
    const { client } = makeClient({ modeRow: meta("pde"), stopRow: { enabled: true } });
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), {
      mode: "legacy", reason: "kill_switch_engaged",
    });
  });

  it("I. an UNREADABLE stop forces legacy — the whole point of the polarity", async () => {
    // This is the case a plain capability flag gets wrong: false-on-error would
    // disengage the stop exactly when the database is unhealthy, which is when
    // it is most likely to be needed.
    const { client } = makeClient({ modeRow: meta("pde"), stopError: { message: "db down" } });
    assert.deepEqual(modeOf(await resolveDiscoveryEngineMode(client)), {
      mode: "legacy", reason: "kill_switch_engaged",
    });
  });

  it("J. the stop is read ONLY for pde", async () => {
    for (const mode of ["legacy", "shadow"] as const) {
      invalidateDiscoveryEngineModeCache();
      const { client, stopReads } = makeClient({
        modeRow: meta(mode), stopError: { message: "db down" },
      });
      const r = await resolveDiscoveryEngineMode(client);
      assert.deepEqual(modeOf(r), { mode, reason: "resolved" },
        "a stop error must not drag a non-pde mode to legacy");
      assert.equal(stopReads(), 0, `${mode} must not read the stop at all`);
    }
  });
});

describe("DISCOVERY_ENGINE_MODE — caching (mechanic M5)", () => {
  beforeEach(() => invalidateDiscoveryEngineModeCache());

  it("M. resolves once inside the TTL", async () => {
    let reads = 0;
    const client = {
      from() {
        const q: any = {
          select() { return q; },
          eq() { return q; },
          maybeSingle() {
            reads += 1;
            return Promise.resolve({ data: { enabled: true, metadata: { mode: "shadow" } }, error: null });
          },
        };
        return q;
      },
    };
    for (let i = 0; i < 5; i++) {
      assert.equal((await resolveDiscoveryEngineMode(client)).mode, "shadow");
    }
    assert.equal(reads, 1, "the mode is read once per TTL window, not per request");
  });

  it("M2. the flag names are the ones the migration and docs use", () => {
    assert.equal(DISCOVERY_ENGINE_MODE_FLAG, "DISCOVERY_ENGINE_MODE");
    assert.equal(DISCOVERY_PDE_KILL_SWITCH, "disable_discovery_pde");
    // D1=B: the name carries no COMPASS_ prefix, so it MUST NOT be read through
    // compass/flags.ts, whose loader filters .like("flag", "COMPASS_%").
    assert.ok(!DISCOVERY_ENGINE_MODE_FLAG.startsWith("COMPASS_"));
  });

  // ── D6 cohort resolution ────────────────────────────────────────────────────
  //
  // The resolver parses metadata.cohort alongside metadata.mode so it rides the
  // same 30-second cache. What it must never do is let an unreadable cohort
  // mean "everyone" — the mode fails closed toward legacy, and the cohort fails
  // closed toward nobody, which are opposite directions for good reason.

  it("N2. mode shadow, cohort absent -> shadow, but nobody is in it", async () => {
    invalidateDiscoveryEngineModeCache();
    const { client } = makeClient({ modeRow: { enabled: true, metadata: { mode: "shadow" } } });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "shadow", "the mode itself still resolves");
    assert.equal(r.cohort.kind, "none", "but it applies to nobody");
    assert.equal(r.cohortReason, "absent");
  });

  it("N3. a malformed cohort is NOT narrowed to a guess", async () => {
    invalidateDiscoveryEngineModeCache();
    const { client } = makeClient({
      modeRow: { enabled: true, metadata: { mode: "shadow", cohort: "all" } },
    });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.cohort.kind, "none");
    assert.equal(r.cohortReason, "not_an_object");
  });

  it("N4. D6=A — an explicit user list survives the round trip", async () => {
    invalidateDiscoveryEngineModeCache();
    const { client } = makeClient({
      modeRow: {
        enabled: true,
        metadata: { mode: "shadow", cohort: { kind: "users", userIds: ["u-1", "u-2"] } },
      },
    });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "shadow");
    assert.equal(r.cohort.kind, "users");
    assert.equal(r.cohortReason, "parsed");
    assert.equal(isInDiscoveryCohort(r.cohort, "u-1").included, true);
    assert.equal(isInDiscoveryCohort(r.cohort, "u-3").included, false);
  });

  it("N5. legacy always carries a cohort of nobody", async () => {
    invalidateDiscoveryEngineModeCache();
    const { client } = makeClient({
      modeRow: { enabled: true, metadata: { mode: "legacy", cohort: { kind: "all" } } },
    });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "legacy");
    // Legacy is what everyone already receives, so there is no cohort question.
    // Reading "all" here would invite the idea that legacy applies to some
    // users and not others.
    // Even with cohort:{kind:"all"} written in metadata. Legacy is what
    // everyone already receives, so a populated cohort here could only be
    // misread as "legacy applies to some users and not others".
    assert.equal(r.cohort.kind, "none");
    assert.equal(isInDiscoveryCohort(r.cohort, "u-1").included, false);
  });

  it("N6. every failure path yields a cohort of nobody", async () => {
    const cases = [
      makeClient({ modeRow: null }).client,
      makeClient({ modeRow: { enabled: false, metadata: { mode: "shadow", cohort: { kind: "all" } } } }).client,
      makeClient({ modeError: new Error("db down") }).client,
      null,
    ];
    for (const c of cases) {
      invalidateDiscoveryEngineModeCache();
      const r = await resolveDiscoveryEngineMode(c);
      assert.equal(r.mode, "legacy");
      assert.equal(r.cohort.kind, "none", "a failed resolution must never carry a populated cohort");
    }
  });
});

// ── `12` Stop conditions (census DV-82) ───────────────────────────────────────
//
// REQUIREMENT
// ===========
// docs/specs/discovery-v1/12_Claude_Code_Implementation.md `:206` — "Stop
// rollout if: event rejection rises, recommendation logging gaps appear,
// creator concentration spikes, reports/hides increase materially, cache bypass
// reappears, RLS leaks occur, attribution double-counts."
//
// THE GAP
// =======
// census DV-82 measured 0 of 7 ENFORCED: "Rejections are logged (C25) but
// nothing thresholds them… and nothing halts a rollout." The manual stop
// (`disable_discovery_pde`) is a human pulling a lever; a stop CONDITION is the
// system pulling it.
//
// WHAT IS DELIBERATELY NOT ENFORCED
// =================================
// Five of the seven have no producer inside Discovery's own instruments today,
// and are NAMED rather than silently missing. Trying to enforce a condition
// whose input does not exist would produce a stop that can never trip — which
// looks exactly like a stop that is working.
import {
  recordServeLogOutcome,
  evaluateStopConditions,
  _resetStopConditionsForTest,
  STOP_CONDITIONS,
  STOP_CONDITIONS_WITHOUT_PRODUCER,
  STOP_MIN_SAMPLE,
  EVENT_REJECTION_RATE_THRESHOLD,
  LOGGING_GAP_THRESHOLD,
  STOP_WINDOW_MS,
} from "../lib/discoveryStopConditions.js";

describe("N. 12 stop conditions — the evaluator", () => {
  beforeEach(() => _resetStopConditionsForTest());

  it("N1. names all seven conditions in the specification's own order", () => {
    assert.deepEqual([...STOP_CONDITIONS], [
      "event_rejection_rate", "recommendation_logging_gap", "creator_concentration",
      "reports_hides", "cache_bypass", "rls_leak", "attribution_double_count",
    ]);
    assert.deepEqual([...STOP_CONDITIONS_WITHOUT_PRODUCER], [
      "creator_concentration", "reports_hides", "cache_bypass", "rls_leak", "attribution_double_count",
    ], "the five with no producer must be named, so 'never trips' is distinguishable from 'working'");
  });

  it("N2. nothing trips on an empty window — absence of evidence is not evidence", () => {
    const v = evaluateStopConditions();
    assert.deepEqual(v.tripped, []);
    assert.equal(v.attempts, 0);
  });

  it("N3. a small sample cannot trip it, however bad the ratio", () => {
    for (let i = 0; i < STOP_MIN_SAMPLE - 1; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 1 });
    const v = evaluateStopConditions();
    assert.deepEqual(
      v.tripped, [],
      "a 100% rejection rate over too few attempts is one bad minute, not a rollout signal — halting on it would make the stop fire on noise",
    );
  });

  it("N4. DEFECT: a rejection rate above the threshold trips the stop", () => {
    const n = STOP_MIN_SAMPLE * 2;
    const bad = Math.ceil(n * (EVENT_REJECTION_RATE_THRESHOLD + 0.1));
    for (let i = 0; i < bad; i++)     recordServeLogOutcome({ outcome: "rejected", servedItems: 10 });
    for (let i = 0; i < n - bad; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10, landedRows: 10 });
    const v = evaluateStopConditions();
    assert.ok(
      v.tripped.includes("event_rejection_rate"),
      `12's first stop condition is 'event rejection rises'; rate was ${v.eventRejectionRate}`,
    );
  });

  it("N5. a healthy window trips nothing", () => {
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10, landedRows: 10 });
    assert.deepEqual(evaluateStopConditions().tripped, []);
    assert.equal(evaluateStopConditions().eventRejectionRate, 0);
    assert.equal(evaluateStopConditions().loggingGapRate, 0);
  });

  it("N6. DEFECT: served items that never became rows are a LOGGING GAP, distinct from a rejection", () => {
    // Every attempt is accepted by the database; half the served items still
    // never become an event row. A rejection-only monitor cannot see this.
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10, landedRows: 4 });
    const v = evaluateStopConditions();
    assert.equal(v.eventRejectionRate, 0, "nothing was rejected");
    assert.ok(v.loggingGapRate > LOGGING_GAP_THRESHOLD, `gap rate was ${v.loggingGapRate}`);
    assert.deepEqual(
      v.tripped, ["recommendation_logging_gap"],
      "the two conditions must be separately reportable — collapsing them would hide a writer that drops items silently",
    );
  });

  it("N7. the window rolls: old evidence ages out and the stop recovers", () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) {
      recordServeLogOutcome({ outcome: "rejected", servedItems: 10 }, t0);
    }
    assert.ok(evaluateStopConditions(t0).tripped.length > 0, "precondition: tripped");
    assert.deepEqual(
      evaluateStopConditions(t0 + STOP_WINDOW_MS + 1).tripped, [],
      "a stop that never recovers is an outage, not a guardrail — the window must age evidence out",
    );
  });

  it("N8. a condition with no producer can never appear in `tripped`", () => {
    for (let i = 0; i < STOP_MIN_SAMPLE * 5; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 10 });
    const v = evaluateStopConditions();
    for (const c of STOP_CONDITIONS_WITHOUT_PRODUCER) {
      assert.ok(!v.tripped.includes(c), `${c} has no input; it must never claim to have fired`);
    }
    assert.deepEqual(
      [...v.unenforced], [...STOP_CONDITIONS_WITHOUT_PRODUCER],
      "every evaluation must carry the list of conditions it did NOT check, so a clean result cannot be read as 'all seven are fine'",
    );
  });
});

describe("O. 12 stop conditions — the resolver honours them", () => {
  beforeEach(() => {
    invalidateDiscoveryEngineModeCache();
    _resetStopConditionsForTest();
  });

  it("O1. DEFECT: a tripped stop condition forces `legacy`, whatever the flag says", async () => {
    const { client } = makeClient({ modeRow: { enabled: true, metadata: { mode: "pde", cohort: { kind: "all" } } }, stopRow: { enabled: false } });
    const before = await resolveDiscoveryEngineMode(client);
    assert.equal(before.mode, "pde", "precondition: the flag selects pde and the manual stop is not engaged");

    invalidateDiscoveryEngineModeCache();
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 10 });

    const after = await resolveDiscoveryEngineMode(client);
    assert.equal(after.mode, "legacy", "12's stop conditions say HALT ROLLOUT; a rollout that continues has not halted");
    assert.equal(after.reason, "stop_condition", "the reason must name the stop, or an operator cannot tell it from a flag being off");
    assert.equal(after.cohort.kind, "none", "legacy carries no cohort, ever");
  });

  it("O2. a tripped stop also halts SHADOW — shadow costs real reads off a failing instrument", async () => {
    const { client } = makeClient({ modeRow: { enabled: true, metadata: { mode: "shadow", cohort: { kind: "all" } } } });
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "rejected", servedItems: 10 });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "stop_condition");
  });

  it("O3. the stop can only ever move TOWARD legacy — it never promotes a mode", async () => {
    const { client } = makeClient({ modeRow: { enabled: false, metadata: { mode: "pde" } } });
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10, landedRows: 10 });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "flag_disabled", "a healthy window must not rewrite why a disabled flag resolved to legacy");
  });

  it("O4. a healthy window leaves the configured mode exactly as it was", async () => {
    const { client } = makeClient({ modeRow: { enabled: true, metadata: { mode: "shadow", cohort: { kind: "all" } } } });
    for (let i = 0; i < STOP_MIN_SAMPLE * 2; i++) recordServeLogOutcome({ outcome: "landed", servedItems: 10, landedRows: 10 });
    const r = await resolveDiscoveryEngineMode(client);
    assert.equal(r.mode, "shadow");
    assert.equal(r.reason, "resolved");
  });
});
