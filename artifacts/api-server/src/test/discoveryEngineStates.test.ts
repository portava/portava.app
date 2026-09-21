/**
 * DISCOVERY_ENGINE_MODE — `01` §8's FIVE REQUIRED STATES.
 *
 * THE REQUIREMENT, VERBATIM (docs/specs/discovery-architecture-v1/
 * discovery-v1-01-discovery-engine.md:179-185):
 *
 *   "Required states:
 *    - OFF: existing behavior byte-identical.
 *    - SHADOW: new engine computes but does not affect UI.
 *    - COMPARE: old and new rankings logged for analysis.
 *    - PARTIAL: small cohort/surface rollout.
 *    - ON: PDE controls selected surfaces."
 *
 * WHAT WAS MISSING, AND WHAT THESE TESTS PIN
 * ==========================================
 * census-discovery DV-08 measured 3 of 5: OFF (= legacy), SHADOW and ON
 * (= pde) were selectable values of `metadata.mode`; COMPARE and PARTIAL were
 * not states at all. PARTIAL was "reached by crossing a cohort gate with a
 * mode" — an emergent property of two independent settings, which nobody can
 * select, record or roll back as one thing. COMPARE was "a consequence of
 * SHADOW" — lib/discoveryDivergenceReport exists, but no configuration asks
 * for it.
 *
 * The fix separates the two things the old three-valued `mode` conflated:
 *
 *   STATE — what an operator selects; five values; `01` §8's vocabulary.
 *   PATH  — which of the three execution branches routes/discovery.ts runs;
 *           `legacy` (fall through), `shadow` (:1921), `pde` (:1816).
 *
 * The route is UNCHANGED and keeps branching on the path, so COMPARE runs the
 * shadow branch that already logs old-vs-new into `discovery_shadow_serves`
 * (lib/discoveryShadow.ts:398 `engine_mode` / `mode_reason`) and PARTIAL runs
 * the pde branch under its cohort. The state stays distinguishable in the data
 * because the resolver reports a DIFFERENT `reason` for it, and `reason` is
 * already written to both instruments the route uses
 * (routes/discovery.ts:1956 `modeReason`, :2271).
 *
 * THE REFUSAL THIS ADDS
 * =====================
 * PARTIAL is "small cohort/surface rollout". `cohort: { kind: "all" }` is
 * D6=C — everyone — and is ON wearing PARTIAL's label. That combination is
 * REFUSED to `legacy`, with its own reason, rather than served as a partial
 * rollout that is in fact total.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/test/discoveryEngineStates.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveDiscoveryEngineMode,
  invalidateDiscoveryEngineModeCache,
  parseEngineState,
  ENGINE_STATE_PATH,
  DISCOVERY_ENGINE_STATES,
  DISCOVERY_PDE_KILL_SWITCH,
} from "../lib/discoveryEngineMode.js";
import { isInDiscoveryCohort } from "../lib/discoveryCohort.js";
import {
  _resetStopConditionsForTest,
  recordServeLogOutcome,
  STOP_MIN_SAMPLE,
} from "../lib/discoveryStopConditions.js";

/**
 * Stub answering the two feature_flags reads the resolver makes. Same shape as
 * discoveryEngineMode.test.ts's — both reads go through
 * .from().select().eq().maybeSingle() and dispatch on the flag name.
 */
function makeClient(opts: {
  modeRow?: { enabled: boolean; metadata: unknown } | null;
  stopRow?: { enabled: boolean } | null;
}) {
  return {
    from(_table: string) {
      const q: any = {
        _flag: "",
        select() { return q; },
        eq(_col: string, val: string) { q._flag = val; return q; },
        maybeSingle() {
          if (q._flag === DISCOVERY_PDE_KILL_SWITCH) {
            return Promise.resolve({ data: opts.stopRow ?? null, error: null });
          }
          return Promise.resolve({ data: opts.modeRow ?? null, error: null });
        },
      };
      return q;
    },
  };
}

const row = (mode: unknown, cohort?: unknown) => ({
  enabled: true,
  metadata: cohort === undefined ? { mode } : { mode, cohort },
});

async function resolve(mode: unknown, cohort?: unknown, stopRow?: { enabled: boolean } | null) {
  invalidateDiscoveryEngineModeCache();
  return resolveDiscoveryEngineMode(makeClient({ modeRow: row(mode, cohort), stopRow }));
}

describe("`01` §8 — all five required states are selectable", () => {
  beforeEach(() => {
    invalidateDiscoveryEngineModeCache();
    _resetStopConditionsForTest();
  });

  it("names exactly the five states §8 requires", () => {
    assert.deepEqual(
      [...DISCOVERY_ENGINE_STATES].sort(),
      ["compare", "off", "on", "partial", "shadow"],
    );
  });

  it("every state dispatches one of the three paths the route branches on", () => {
    for (const s of DISCOVERY_ENGINE_STATES) {
      assert.ok(
        ["legacy", "shadow", "pde"].includes(ENGINE_STATE_PATH[s]),
        `${s} dispatches ${ENGINE_STATE_PATH[s]}, which routes/discovery.ts cannot branch on`,
      );
    }
  });

  // ── OFF ────────────────────────────────────────────────────────────────────
  it("OFF resolves to the legacy path with no cohort, under both spellings", async () => {
    for (const spelling of ["legacy", "off"]) {
      const r = await resolve(spelling, { kind: "all" });
      assert.equal(r.state, "off", spelling);
      assert.equal(r.mode, "legacy", spelling);
      assert.equal(r.reason, "resolved", spelling);
      // Legacy carries no cohort, ever — even when one is configured.
      assert.equal(r.cohort.kind, "none", spelling);
    }
  });

  // ── SHADOW ─────────────────────────────────────────────────────────────────
  it("SHADOW is unchanged: the shadow path, reason `resolved`", async () => {
    const r = await resolve("shadow", { kind: "percent", percent: 5 });
    assert.equal(r.state, "shadow");
    assert.equal(r.mode, "shadow");
    assert.equal(r.reason, "resolved");
    assert.equal(r.cohort.kind, "percent");
  });

  // ── COMPARE ────────────────────────────────────────────────────────────────
  it("COMPARE is a selectable state that runs the shadow path", async () => {
    const r = await resolve("compare", { kind: "percent", percent: 5 });
    assert.equal(r.state, "compare");
    assert.equal(r.mode, "shadow");
    assert.equal(r.cohort.kind, "percent");
  });

  it("COMPARE is distinguishable from SHADOW in what the route records", async () => {
    const shadow  = await resolve("shadow",  { kind: "percent", percent: 5 });
    const compare = await resolve("compare", { kind: "percent", percent: 5 });
    // routes/discovery.ts:1955-1956 writes BOTH of these into
    // discovery_shadow_serves. The path is the same on purpose — COMPARE is
    // shadow that has been asked for as a comparison — so the reason is the
    // only thing that can carry the distinction, and it must.
    assert.equal(compare.mode, shadow.mode);
    assert.notEqual(compare.reason, shadow.reason);
    assert.equal(compare.reason, "resolved_compare");
  });

  // ── PARTIAL ────────────────────────────────────────────────────────────────
  it("PARTIAL is a selectable state that runs the pde path, bounded to its cohort", async () => {
    const r = await resolve("partial", { kind: "percent", percent: 5 });
    assert.equal(r.state, "partial");
    assert.equal(r.mode, "pde");
    assert.equal(r.reason, "resolved_partial");
    assert.deepEqual(r.cohort, { kind: "percent", percent: 5 });
  });

  it("PARTIAL is distinguishable from ON in what the route records", async () => {
    const on      = await resolve("pde",     { kind: "percent", percent: 5 });
    const partial = await resolve("partial", { kind: "percent", percent: 5 });
    assert.equal(partial.mode, on.mode);
    assert.notEqual(partial.reason, on.reason);
    assert.equal(on.reason, "resolved");
  });

  it("PARTIAL with a users cohort admits only the listed users", async () => {
    const r = await resolve("partial", { kind: "users", userIds: ["u1"] });
    assert.equal(r.mode, "pde");
    assert.equal(isInDiscoveryCohort(r.cohort, "u1").included, true);
    assert.equal(isInDiscoveryCohort(r.cohort, "u2").included, false);
  });

  // ── PARTIAL's refusal — the load-bearing half ──────────────────────────────
  it("REFUSES PARTIAL over cohort kind=all: a total rollout is not a partial one", async () => {
    const r = await resolve("partial", { kind: "all" });
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "partial_cohort_unbounded");
    assert.equal(r.cohort.kind, "none");
  });

  it("does NOT refuse ON over cohort kind=all — that is D6=C, the owner's decision", async () => {
    const r = await resolve("pde", { kind: "all" });
    assert.equal(r.mode, "pde");
    assert.equal(r.state, "on");
    assert.equal(r.cohort.kind, "all");
  });

  // ── The stops apply to the new states too ──────────────────────────────────
  it("the manual stop halts PARTIAL, because PARTIAL runs pde", async () => {
    const r = await resolve("partial", { kind: "percent", percent: 5 }, { enabled: true });
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "kill_switch_engaged");
  });

  it("a tripped `12` stop condition halts COMPARE and PARTIAL", async () => {
    for (const spelling of ["compare", "partial"]) {
      _resetStopConditionsForTest();
      for (let i = 0; i < STOP_MIN_SAMPLE + 5; i++) {
        recordServeLogOutcome({ outcome: "rejected", servedItems: 1, landedRows: 0 });
      }
      const r = await resolve(spelling, { kind: "percent", percent: 5 });
      assert.equal(r.mode, "legacy", spelling);
      assert.equal(r.reason, "stop_condition", spelling);
    }
  });

  // ── Nothing else became selectable ─────────────────────────────────────────
  it("rejects every spelling that is not a state, including inherited keys", async () => {
    const bad = [
      "COMPARE", "Partial", "partial ", " compare", "",
      "constructor", "toString", "__proto__", "hasOwnProperty", "valueOf",
      3, true, null, {}, ["partial"],
    ];
    for (const v of bad) {
      assert.equal(parseEngineState(v), null, `parseEngineState(${JSON.stringify(v)})`);
      const r = await resolve(v);
      assert.equal(r.mode, "legacy", `resolve(${JSON.stringify(v)})`);
    }
  });

  it("an inherited Object.prototype key never resolves to a live path", async () => {
    // A plain-object alias table would return Object.prototype.constructor here
    // and the truthiness test would admit it. The lookup must be own-key only.
    const r = await resolve("constructor");
    assert.equal(r.mode, "legacy");
    assert.equal(r.reason, "mode_invalid");
  });
});
