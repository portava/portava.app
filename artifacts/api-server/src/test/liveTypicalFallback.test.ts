/**
 * IG-05 'typical' fallback (spec §5 degradation order) — the rung below live.
 *
 * Proves: readTypicalPatterns emits a 'typical' envelope (sourceClass
 * historical_pattern, NEVER a Live one) for the current weekday/hour; a superseding
 * invalidation tombstone that is the latest row suppresses the pattern; and
 * resolvePlaceIntelState honours the order live → typical → unknown.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readTypicalPatterns,
  resolvePlaceIntelState,
} from "../lib/liveClaimRead.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";

const NOW = new Date("2026-09-04T20:00:00.000Z"); // Friday (dow 5), hour 20 UTC
const DOW = NOW.getUTCDay();
const BAND = "hour_20";

function patternRow(over: Record<string, unknown> = {}) {
  return {
    id: "pat-1", zone_id: null, claim_family: "crowd.level", pattern_kind: "typical_crowd_by_weekday_hour",
    time_band: BAND, dow: DOW, value_json: { level: "busy" }, confidence: 0.6, cohort_size: 30,
    // The typical rung enforces the same k-anonymity floor as the live rung, so a
    // fixture that is meant to SERVE must declare a cohort at or above it. (The
    // floor itself is proven in intelCoreProjectionHardening.test.ts.)
    distinct_contributors: PRIVACY_THRESHOLD_V1.minUniqueActors,
    window_days: 120, is_invalidation: false, computed_at: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/** A minimal client: historical_patterns returns `patterns`, live flag off ⇒ no live. */
function client(opts: { patterns?: any[]; patternError?: boolean; liveFlag?: boolean }) {
  return {
    from(table: string) {
      if (table === "feature_flags") {
        const fq: any = { select: () => fq, eq: () => fq, maybeSingle: async () => ({ data: { enabled: opts.liveFlag ?? false }, error: null }) };
        return fq;
      }
      if (table === "intel_live_promoted_scopes") {
        const pq: any = { select: () => pq, then: (res: any) => res({ data: [], error: null }) };
        return pq;
      }
      if (table === "intel_historical_patterns") {
        const q: any = { select: () => q, eq: () => q, order: () => q,
          then: (res: any) => res(opts.patternError ? { data: null, error: { message: "boom" } } : { data: opts.patterns ?? [], error: null }) };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as any;
}

describe("readTypicalPatterns", () => {
  it("emits a 'typical' envelope for the current weekday/hour, never live", async () => {
    const out = await readTypicalPatterns(client({ patterns: [patternRow()] }), "p1", { now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0].state, "typical");
    assert.equal(out[0].sourceClass, "historical_pattern");
    assert.deepEqual(out[0].value, { level: "busy" });
    assert.equal(out[0].sourceCountBucket, "several"); // 30 → 'several' (bucket: <25 few, <100 several)
  });

  it("skips a scope whose LATEST row is an invalidation tombstone", async () => {
    const rows = [
      patternRow({ id: "tomb", is_invalidation: true, value_json: {}, computed_at: "2026-09-03T00:00:00.000Z" }), // newest
      patternRow({ id: "old", computed_at: "2026-09-01T00:00:00.000Z" }),
    ];
    const out = await readTypicalPatterns(client({ patterns: rows }), "p1", { now: NOW });
    assert.equal(out.length, 0);
  });

  it("fails closed to [] on a read error", async () => {
    assert.deepEqual(await readTypicalPatterns(client({ patternError: true }), "p1", { now: NOW }), []);
  });

  it("returns [] without a subject", async () => {
    assert.deepEqual(await readTypicalPatterns(client({ patterns: [patternRow()] }), null, { now: NOW }), []);
  });
});

describe("resolvePlaceIntelState — degradation order live → typical → unknown", () => {
  it("falls to 'typical' when no live claim exists but a pattern does", async () => {
    const r = await resolvePlaceIntelState(client({ liveFlag: false, patterns: [patternRow()] }), "p1", { now: NOW });
    assert.equal(r.state, "typical");
    assert.equal(r.claims.length, 1);
    assert.equal(r.claims[0].sourceClass, "historical_pattern");
  });

  it("is 'unknown' with neither a live claim nor a pattern", async () => {
    const r = await resolvePlaceIntelState(client({ liveFlag: false, patterns: [] }), "p1", { now: NOW });
    assert.equal(r.state, "unknown");
    assert.equal(r.claims.length, 0);
  });
});
