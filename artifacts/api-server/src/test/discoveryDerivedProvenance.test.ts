/**
 * discoveryDerivedProvenance — census-discovery §68 (lane P21), DC-17.
 *
 * THE CRITERION
 * =============
 * `docs/specs/discovery-v1/10_Database_Architecture.md` §5: "Derived features
 * must retain: source event window · feature version · model version ·
 * computation time".
 *
 * WHAT WAS FALSE BEFORE §68
 * =========================
 * The two windowed stores carried all four FIELDS (§30.3), but the version pair
 * in them was the Compass ranker's (`compass-discovery-2026-09` /
 * `compass-factors-v1`), stamped by `derivedStoreProvenance` for every store
 * (§54.2 (b)). So:
 *   - a trend reading computed in TypeScript said `compass-discovery-2026-09`,
 *     while the SAME computation in SQL said `discovery-trend-state-v1`;
 *   - a change to a momentum threshold, a trend factor or an event weight moved
 *     neither string. §61's dismiss exclusion changed what an event contributes
 *     and no version anywhere recorded it (§61.5).
 * And the persisted twin, `place_momentum`, had no feature version at all.
 *
 *   V1  the momentum store stamps its OWN model and feature version
 *   V2  the trend store stamps the model version the SQL store stores, and the
 *       feature version the SQL store now stores (3435)
 *   V3  one weighting, one feature version, in all three places
 *   V4  `derivedStoreProvenance` stamps exactly the pair it is handed, and has
 *       no default that could fall back to the ranker's
 *   V5  the degraded answers (no client, no candidates) carry the same pair
 *   V6  3435's function is 3417's body plus exactly the feature-version write
 *   V7  3435's rollback restores 3417's body verbatim
 *
 * The values these stores compute are held byte-identical by
 * src/test/discoveryDerivedProvenanceGolden.test.ts.
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/discoveryDerivedProvenance.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as momentumMod from "../lib/discoveryLocalMomentum.js";
import * as trendMod from "../lib/discoveryTrendState.js";
import * as provMod from "../lib/discoveryRankProvenance.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dir, "..", "migrations");
const ROLLBACK_3435 = resolve(__dir, "../../../../db/rollback/2026-09-28-3435-place-momentum-feature-version-rollback.sql");

const NOW  = Date.parse("2026-09-20T12:00:00Z");
const HOUR = 3_600_000;
const COMPASS_PAIR = ["compass-discovery-2026-09", "compass-factors-v1"];

/** Literals, not imports: at the tree before §68 these constants did not exist, and V1/V2 must fail on VALUES there. */
const MOMENTUM_MODEL = "discovery-place-velocity-v1";
const TREND_MODEL    = "discovery-trend-state-v1";
const ACTIVITY_FEATURE = "discovery-row-activity-v2";  // §84 (D-W10-R1-16): renamed from "discovery-weighted-activity-v2"; same definition

const rows: momentumMod.MomentumRow[] = [
  { item_id: "a", outcome: "save",       served_at: new Date(NOW - 2 * HOUR).toISOString(), outcome_at: new Date(NOW - HOUR).toISOString() },
  { item_id: "a", outcome: "impression", served_at: new Date(NOW - 3 * HOUR).toISOString() },
  { item_id: "b", outcome: "impression", served_at: new Date(NOW - 200 * HOUR).toISOString() },
];

/** The body of `rebuild_place_momentum` as the NEWEST migration defining it writes it. */
function latestRebuild(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
  let last: { file: string; body: string } | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    const b = rebuildBody(sql);
    if (b) last = { file: f, body: b };
  }
  assert.ok(last, "no migration defines rebuild_place_momentum");
  return last!;
}
function rebuildBody(sql: string): string | null {
  const a = sql.indexOf("CREATE OR REPLACE FUNCTION public.rebuild_place_momentum(");  // §84: `(` so 3477's rebuild_place_momentum_v2 is not mistaken for it
  if (a < 0) return null;
  const b = sql.indexOf("$fn$;", a);
  return b < 0 ? null : sql.slice(a, b + "$fn$;".length);
}
const sqlConst = (body: string, name: string) => body.match(new RegExp(`${name}\\s+CONSTANT text := '([^']+)'`))?.[1] ?? null;

describe("§68 DC-17 — each derived store names the model and feature that computed it", () => {
  it("V1. momentum: its own model and feature version, never the Compass ranker's", () => {
    const p = momentumMod.computeLocalMomentum(rows, NOW).provenance;
    assert.equal(p.modelVersion, MOMENTUM_MODEL);
    assert.equal(p.featureVersion, ACTIVITY_FEATURE);
    assert.ok(!COMPASS_PAIR.includes(p.modelVersion) && !COMPASS_PAIR.includes(p.featureVersion), "a momentum reading must not claim the Compass pipeline");
    // The other two of the four, unchanged: the window IS the filter's bounds, and the clock is the computation's.
    assert.deepEqual(p.window, { kind: "bounded", startMs: NOW - momentumMod.MOMENTUM_BASELINE_WINDOW_MS, endMs: NOW });
    assert.equal(p.computedAt, NOW);
  });

  it("V2. trend: the model version the SQL store stores, and the feature version 3435 stores", () => {
    const readings = trendMod.computeTrendStates(rows, NOW);
    const { file, body } = latestRebuild();
    assert.match(file, /^3477_/, `the newest rebuild_place_momentum should be 3477's dispatcher, whose flag-off branch is 3435's body (discoveryTrendNormalised Q5), found ${file}`);
    for (const [id, r] of Object.entries(readings)) {
      assert.equal(r.provenance.modelVersion, TREND_MODEL, `${id}: model version`);
      assert.equal(r.provenance.modelVersion, sqlConst(body, "c_model"), `${id}: the TypeScript and SQL trend stores must name one model`);
      assert.equal(r.provenance.featureVersion, sqlConst(body, "c_feature"), `${id}: the TypeScript and SQL trend stores must name one feature version`);
      assert.deepEqual(r.provenance.window, { kind: "bounded", startMs: NOW - trendMod.TREND_PRIOR_MS, endMs: NOW });
      assert.equal(r.provenance.computedAt, NOW);
    }
  });

  it("V3. one weighting, one feature version: momentum, trend and SQL agree, and so do their weights", () => {
    const m = momentumMod.computeLocalMomentum(rows, NOW).provenance.featureVersion;
    const t = Object.values(trendMod.computeTrendStates(rows, NOW))[0]!.provenance.featureVersion;
    assert.equal(m, t);
    assert.equal(sqlConst(latestRebuild().body, "c_feature"), m);
    assert.deepEqual({ ...momentumMod.MOMENTUM_EVENT_WEIGHTS }, { ...trendMod.TREND_EVENT_WEIGHTS },
      "the shared feature version is only true while the two kernels weigh an event identically");
    // And a dismiss weighs 0 in both — the change that made this `v2`.
    const dismissed = [{ item_id: "d", outcome: "dismiss", served_at: new Date(NOW - HOUR).toISOString(), outcome_at: new Date(NOW - HOUR / 2).toISOString() }];
    assert.equal(trendMod.computeTrendStates(dismissed, NOW)["d"]!.evidence.totalWeight, 1, "trend: impression 1 + dismiss 0");
  });

  it("V4. derivedStoreProvenance stamps exactly the pair it is handed, and the pair is required", () => {
    const fn = provMod.derivedStoreProvenance as unknown as (w: provMod.DerivedStoreWindow, t: number, v?: { modelVersion: string; featureVersion: string }) => provMod.DerivedStoreProvenance;
    const p = fn({ kind: "bounded", startMs: 1, endMs: 2 }, 2, { modelVersion: "m-x", featureVersion: "f-y" });
    assert.equal(p.modelVersion, "m-x");
    assert.equal(p.featureVersion, "f-y");
    assert.equal(fn.length, 3, "a two-argument form would let a store fall back to a pair it did not compute with");
  });

  it("V5. the degraded answers carry the store's pair too (no client; no candidates)", async () => {
    momentumMod._resetLocalMomentumCacheForTest();
    const noClient = await momentumMod.loadLocalMomentum(null, ["a"], { cacheKey: "v5:none", nowMs: NOW });
    const noIds    = await momentumMod.loadLocalMomentum({}, [], { cacheKey: "v5:ids", nowMs: NOW });
    for (const m of [noClient, noIds]) {
      assert.deepEqual(m.values, {});
      assert.equal(m.provenance.modelVersion, MOMENTUM_MODEL);
      assert.equal(m.provenance.featureVersion, ACTIVITY_FEATURE);
    }
  });
});

describe("§68 DC-17 — 3435 persists the feature version and changes nothing else", () => {
  const f3417 = readFileSync(join(MIGRATIONS, "3417_place_momentum_dismiss_excluded.sql"), "utf8");
  const path3435 = join(MIGRATIONS, "3435_place_momentum_feature_version.sql");

  it("V6. 3435's rebuild is 3417's body plus exactly: one constant, one written column, one ON CONFLICT line", () => {
    assert.ok(existsSync(path3435), "3435_place_momentum_feature_version.sql is missing");
    const sql = readFileSync(path3435, "utf8");
    assert.match(sql, /ALTER TABLE public\.place_momentum ADD COLUMN IF NOT EXISTS feature_version text;/);
    const after = rebuildBody(sql)!;
    const before = rebuildBody(f3417)!;
    // Undo exactly the three edits; what remains must be 3417's body byte for byte.
    const undone = after
      .replace(/\n  -- 3435 \(census-discovery §68, DC-17\)[\s\S]*?\n  c_feature    CONSTANT text := '[^']+';/, "")
      .replace("source_surface, feature_version\n  )", "source_surface\n  )")
      .replace("c_surface, c_feature\n    FROM classified c", "c_surface\n    FROM classified c")
      .replace("source_surface          = EXCLUDED.source_surface,\n    feature_version         = EXCLUDED.feature_version;", "source_surface          = EXCLUDED.source_surface;");
    assert.equal(undone, before, "3435 changed something in rebuild_place_momentum besides the feature-version write");
    assert.notEqual(after, before);
    // No backfill: a pre-3435 row stays NULL ("not recorded"), never a guessed version.
    assert.doesNotMatch(sql, /UPDATE public\.place_momentum/);
  });

  it("V7. 3435's rollback restores 3417's body verbatim and drops the column", () => {
    assert.ok(existsSync(ROLLBACK_3435), "the 3435 rollback is missing");
    const rb = readFileSync(ROLLBACK_3435, "utf8");
    assert.equal(rebuildBody(rb), rebuildBody(f3417));
    assert.match(rb, /ALTER TABLE public\.place_momentum DROP COLUMN IF EXISTS feature_version;/);
    assert.doesNotMatch(rb, /DELETE FROM public\.place_momentum/, "a rollback deletes no row");
  });
});
