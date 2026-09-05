/**
 * IG §12 historical pattern learning — the pure aggregator + the scheduler pass.
 *
 * Proves: Table-19 minimums are a hard floor (a below-minimum bucket yields NO
 * pattern); the modal value is chosen deterministically; the rolling window
 * excludes stale observations; invalidation tombstones fire on retracted/superseded
 * source claims and are self-healing (skipped when a fresh pattern replaces the
 * scope this pass); the producer is flag-gated (intel_pattern_learning) and
 * fail-closed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  derivePatterns,
  deriveInvalidations,
  scopeKeysOf,
  PATTERN_MINIMUMS,
  type FinalizedObservation,
  type ExistingPattern,
} from "../lib/intelPatternLearning.js";
import { runPatternLearningPass } from "../lib/intelPatternScheduler.js";

const NOW = new Date("2026-09-04T20:00:00.000Z");
const NOW_MS = NOW.getTime();
const DAY = 24 * 60 * 60 * 1000;

/**
 * A crowd.level observation by `actor` `weeksAgo` weeks back, hour 20 UTC.
 * Stepping in WEEKS keeps every point in the SAME (weekday × hour) bucket — which
 * is exactly what "typical crowd by weekday/hour" aggregates — while giving each a
 * distinct calendar date.
 */
function obs(actor: string, weeksAgo: number, level: string, extra: Partial<FinalizedObservation> = {}): FinalizedObservation {
  const d = new Date(NOW_MS - weeksAgo * 7 * DAY);
  d.setUTCHours(20, 0, 0, 0);
  return { subjectId: "p1", zoneId: "z1", claimType: "crowd.level", value: { level }, observedAt: d.toISOString(), actorId: actor, ...extra };
}

// ── derivePatterns (pure) ─────────────────────────────────────────────────────
describe("derivePatterns — Table-19 minimum is a hard floor", () => {
  it("emits NOTHING below the independent-visit minimum (crowd → 8 visits / 4 dates)", () => {
    // 7 distinct actors on 7 distinct dates: below the 8-visit floor.
    const observations = Array.from({ length: 7 }, (_, i) => obs(`a${i}`, i + 1, "busy"));
    assert.equal(derivePatterns(observations, { now: NOW }).length, 0);
  });

  it("emits a pattern once the floor is cleared, with the modal value", () => {
    // 8 distinct actors across 8 distinct dates, mostly 'busy'.
    const observations = [
      ...Array.from({ length: 6 }, (_, i) => obs(`a${i}`, i + 1, "busy")),
      obs("a6", 7, "packed"),
      obs("a7", 8, "quiet"),
    ];
    const p = derivePatterns(observations, { now: NOW });
    assert.equal(p.length, 1);
    assert.equal(p[0].patternKind, "typical_crowd_by_weekday_hour");
    assert.deepEqual(p[0].valueJson, { level: "busy" });
    assert.equal(p[0].cohortSize, 8);
    assert.equal(p[0].distinctDates, 8);
    assert.equal(p[0].timeBand, "hour_20");
    assert.ok(p[0].confidence > 0 && p[0].confidence <= 1);
  });

  it("counts a single actor's repeated same-day reports as ONE independent visit", () => {
    // 8 reports but all by one actor on one date ⇒ 1 independent visit ⇒ no pattern.
    const d = new Date(NOW_MS - DAY); d.setUTCHours(20, 0, 0, 0);
    const observations = Array.from({ length: 8 }, () =>
      ({ subjectId: "p1", zoneId: "z1", claimType: "crowd.level", value: { level: "busy" }, observedAt: d.toISOString(), actorId: "solo" }) as FinalizedObservation);
    assert.equal(derivePatterns(observations, { now: NOW }).length, 0);
  });

  it("excludes observations outside the kind's rolling window (crowd = 120d)", () => {
    const win = PATTERN_MINIMUMS.typical_crowd_by_weekday_hour.windowDays;
    // 8 qualifying visits but all older than the window ⇒ excluded ⇒ no pattern.
    const observations = Array.from({ length: 8 }, (_, i) => obs(`a${i}`, win + 5 + i, "busy"));
    assert.equal(derivePatterns(observations, { now: NOW }).length, 0);
  });

  it("crowd.mix needs 15 reports AND >= 5 independent contributors", () => {
    const mix = (actor: string, i: number): FinalizedObservation => {
      const d = new Date(NOW_MS - (i + 1) * 7 * DAY); d.setUTCHours(20, 0, 0, 0); // same weekday × hour bucket
      return { subjectId: "p1", zoneId: "z1", claimType: "crowd.mix", value: { band: "mixed" }, observedAt: d.toISOString(), actorId: actor };
    };
    // 15 reports but only 4 contributors ⇒ below the contributor floor ⇒ nothing.
    const fourContributors = Array.from({ length: 15 }, (_, i) => mix(`a${i % 4}`, i));
    assert.equal(derivePatterns(fourContributors, { now: NOW }).length, 0);
    // 15 reports across 5 contributors ⇒ qualifies.
    const fiveContributors = Array.from({ length: 15 }, (_, i) => mix(`a${i % 5}`, i));
    const p = derivePatterns(fiveContributors, { now: NOW });
    assert.equal(p.length, 1);
    assert.equal(p[0].patternKind, "typical_crowd_mix");
  });

  it("ignores claim types with no observation-derived pattern kind", () => {
    const observations = Array.from({ length: 20 }, (_, i) =>
      ({ subjectId: "p1", zoneId: "z1", claimType: "music.current", value: { genre: "house" }, observedAt: new Date(NOW_MS - (i + 1) * DAY).toISOString(), actorId: `a${i}` }) as FinalizedObservation);
    assert.equal(derivePatterns(observations, { now: NOW }).length, 0);
  });
});

// ── deriveInvalidations (pure) ─────────────────────────────────────────────────
describe("deriveInvalidations — tombstones on invalidated provenance", () => {
  const current: ExistingPattern[] = [{
    id: "pat-1", subjectId: "p1", zoneId: "z1", claimFamily: "crowd.level",
    patternKind: "typical_crowd_by_weekday_hour", timeBand: "hour_20", dow: 5,
    computedAt: "2026-08-01T00:00:00.000Z",
  }];

  it("tombstones a current pattern whose source family was retracted", () => {
    const t = deriveInvalidations(
      [{ subjectId: "p1", zoneId: "z1", claimType: "crowd.level", status: "retracted" }],
      current,
    );
    assert.equal(t.length, 1);
    assert.equal(t[0].supersedesId, "pat-1");
    assert.equal(t[0].reason, "source_provenance_invalidated");
    // The tombstone carries the FULL read key — the reader matches on dow too.
    assert.equal(t[0].timeBand, "hour_20");
    assert.equal(t[0].dow, 5);
  });

  it("does NOT tombstone when the scope has a fresh pattern this pass (self-healing)", () => {
    const fresh = scopeKeysOf([{ subjectId: "p1", zoneId: "z1", claimFamily: "crowd.level" } as any]);
    const t = deriveInvalidations(
      [{ subjectId: "p1", zoneId: "z1", claimType: "crowd.level", status: "superseded" }],
      current,
      fresh,
    );
    assert.equal(t.length, 0);
  });

  it("ignores non-invalidating statuses", () => {
    const t = deriveInvalidations(
      [{ subjectId: "p1", zoneId: "z1", claimType: "crowd.level", status: "active" }],
      current,
    );
    assert.equal(t.length, 0);
  });
});

// ── scheduler pass (fake DB) ───────────────────────────────────────────────────
function makeDb(cfg: { flags: Record<string, boolean>; tables: Record<string, any[]> }) {
  const inserted: Record<string, any[]> = {};
  let seq = 0;
  function from(name: string) {
    const st: any = { op: "select", payload: null, filters: {} as Record<string, any>, single: false };
    const b: any = {
      select() { if (st.op === "insert") st.op = "insert_select"; return b; },
      insert(rows: any) { st.op = "insert"; st.payload = rows; return b; },
      eq(k: string, v: any) { st.filters[k] = v; return b; },
      in(k: string, v: any) { st.filters["in:" + k] = v; return b; },
      gte(k: string, v: any) { st.filters["gte:" + k] = v; return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { st.single = true; return Promise.resolve(run()); },
      single() { st.single = true; return Promise.resolve(run()); },
      then(res: (r: any) => any) { return Promise.resolve(run()).then(res); },
    };
    function run() {
      if (name === "feature_flags") {
        return { data: { enabled: Boolean(cfg.flags[st.filters["flag"]]) }, error: null };
      }
      if (st.op === "insert" || st.op === "insert_select") {
        const rows = (Array.isArray(st.payload) ? st.payload : [st.payload]).map((r: any) => ({ id: `row-${++seq}`, ...r }));
        (inserted[name] ??= []).push(...rows);
        return { data: null, error: null };
      }
      let rows = (cfg.tables[name] ?? []).slice();
      for (const [k, v] of Object.entries(st.filters)) {
        if (k.startsWith("in:")) { const c = k.slice(3); rows = rows.filter((r: any) => (v as any[]).includes(r[c])); }
        else if (k.startsWith("gte:")) { const c = k.slice(4); rows = rows.filter((r: any) => String(r[c]) >= String(v)); }
        else rows = rows.filter((r: any) => r[k] === v);
      }
      if (st.single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    return b;
  }
  return { from, _inserted: inserted };
}

const obsRow = (actor: string, weeksAgo: number, level: string) => {
  const d = new Date(NOW_MS - weeksAgo * 7 * DAY); d.setUTCHours(20, 0, 0, 0); // same weekday × hour bucket
  return { subject_id: "p1", zone_id: "z1", claim_type: "crowd.level", value: { level }, observed_at: d.toISOString(), actor_id: actor, group_key: null, moderation_state: "allowed" };
};

describe("intelPatternScheduler — flag gating (fail-closed)", () => {
  it("is an inert no-op when intel_pattern_learning is off", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => obsRow(`a${i}`, i + 1, "busy"));
    const db = makeDb({ flags: { intel_pattern_learning: false }, tables: { intel_observations: rows } });
    const r = await runPatternLearningPass({ client: db as any, now: NOW });
    assert.equal(r.skipped, true);
    assert.equal(r.reason, "disabled");
    assert.equal((db._inserted.intel_historical_patterns ?? []).length, 0);
  });

  it("writes qualifying patterns when enabled", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => obsRow(`a${i}`, i + 1, "busy"));
    const db = makeDb({ flags: { intel_pattern_learning: true }, tables: { intel_observations: rows } });
    const r = await runPatternLearningPass({ client: db as any, now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.patternsWritten, 1);
    const written = db._inserted.intel_historical_patterns ?? [];
    assert.equal(written.length, 1);
    assert.equal(written[0].pattern_kind, "typical_crowd_by_weekday_hour");
    assert.equal(written[0].source_label, "historical_pattern");
    assert.equal(written[0].is_invalidation, undefined); // fresh pattern row, not a tombstone
    assert.ok(written[0].cohort_size >= 8);
  });

  it("writes nothing (not skipped) when no bucket clears its minimum", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => obsRow(`a${i}`, i + 1, "busy"));
    const db = makeDb({ flags: { intel_pattern_learning: true }, tables: { intel_observations: rows } });
    const r = await runPatternLearningPass({ client: db as any, now: NOW });
    assert.equal(r.skipped, false);
    assert.equal(r.patternsWritten, 0);
    assert.equal((db._inserted.intel_historical_patterns ?? []).length, 0);
  });
});
