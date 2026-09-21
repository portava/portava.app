/**
 * Coverage STATE (migration 2958's `intel_coverage_snapshots.coverage_state`).
 *
 * 2958 is APPLIED to production and CI and the column has existed there with its
 * `'unknown'` DEFAULT since 2026-09-16 — and nothing in this repository has ever
 * written it. That is the same defect shape this band keeps producing: schema
 * that declares a fact, with no producer behind it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { coverageState } from "../lib/coverageScore.js";
import { runIntelCoveragePass } from "../lib/intelCoverageScheduler.js";

test("coverage is independent from activity", () => {
  assert.equal(coverageState({ claimMissing: true, freshestAgeRatio: 0 }), "no_coverage");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: 0.2 }), "covered");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: null }), "unknown");
});

test("invalid coverage evidence is never represented as a quiet covered cell", () => {
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: Number.NaN }), "unknown");
  assert.equal(coverageState({ claimMissing: false, freshestAgeRatio: 2 }), "no_coverage");
});

test("coverageState only ever answers with a value 2958's CHECK constraint accepts", () => {
  const allowed = new Set(["covered", "no_coverage", "unknown"]);
  for (const claimMissing of [true, false]) {
    for (const ratio of [0, 0.5, 1, 1.0001, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      assert.ok(
        allowed.has(coverageState({ claimMissing, freshestAgeRatio: ratio as number | null })),
        `coverage_state CHECK would reject the value for (${claimMissing}, ${String(ratio)})`,
      );
    }
  }
});

/**
 * A fake just wide enough for one pass: one claim, one observation, one place,
 * no saves. The cell that comes out scores 0 (no demand), which is exactly the
 * case the old code dropped on the floor.
 */
function coveragePassClient() {
  const inserted: any[] = [];
  const rows: Record<string, any[]> = {
    intel_claims: [{
      subject_id: "place-1", zone_id: null, claim_type: "crowd.level", status: "active",
      confidence: 0.9, observed_at: "2026-09-16T11:55:00Z", expires_at: "2026-09-16T13:00:00Z",
    }],
    intel_observations: [{
      subject_id: "place-1", zone_id: null, claim_type: "crowd.level",
      actor_id: "actor-1", group_key: null, observed_at: "2026-09-16T11:55:00Z",
    }],
    places: [{ id: "place-1", city: "Lisbon" }],
    discovery_places: [],
    saved_places: [],
    intel_missions: [],
  };
  const builder = (table: string) => {
    const q: any = {
      select: () => q, in: () => q, gte: () => q, lt: () => q, eq: () => q, limit: () => q,
      delete: () => ({ lt: async () => ({ error: null }) }),
      insert: async (r: any) => { inserted.push(...(Array.isArray(r) ? r : [r])); return { error: null }; },
      then: (resolve: (v: any) => unknown) => resolve({ data: rows[table] ?? [], error: null }),
    };
    return q;
  };
  return {
    inserted,
    from(table: string) {
      if (table === "feature_flags") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { enabled: true }, error: null }) }) }) };
      }
      return builder(table);
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

test("the coverage pass writes coverage_state on every snapshot row", async () => {
  const c = coveragePassClient();
  const result = await runIntelCoveragePass({ client: c, now: new Date("2026-09-16T12:00:00Z") });
  assert.equal(result.reason, null);
  assert.ok(c.inserted.length > 0, "a computed cell must reach intel_coverage_snapshots");
  for (const row of c.inserted) {
    assert.ok(
      ["covered", "no_coverage", "unknown"].includes(row.coverage_state),
      `snapshot row left coverage_state at the DEFAULT: ${JSON.stringify(row.coverage_state)}`,
    );
  }
});

test("a fully covered, zero-demand cell is still recorded — absence of a gap is a fact", async () => {
  // The pre-port scheduler persisted only `score > 0` rows, so a covered cell was
  // indistinguishable from a cell the producer never looked at.
  const c = coveragePassClient();
  const result = await runIntelCoveragePass({ client: c, now: new Date("2026-09-16T12:00:00Z") });
  assert.equal(result.snapshots, c.inserted.length);
  assert.ok(c.inserted.some((r) => r.score === 0), "zero-score cells must be persisted, not dropped");
  assert.ok(result.coverageStates, "the pass must report the coverage-state census it just wrote");
  const total = Object.values(result.coverageStates!).reduce((a, b) => a + b, 0);
  assert.equal(total, result.cells);
});
