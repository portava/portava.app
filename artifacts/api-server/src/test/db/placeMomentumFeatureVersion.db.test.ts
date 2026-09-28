/**
 * placeMomentumFeatureVersion.db.test.ts — census-discovery DC-17 (§68, lane P21).
 *
 * `10` §5: a derived feature must retain its feature version. 3435 adds
 * `place_momentum.feature_version` and replaces `rebuild_place_momentum` with
 * 3417's body plus the write of it. This suite runs on the harness chain, which
 * applies 3435 in order.
 *
 *   F1  PROVENANCE ONLY. In one transaction that is rolled back: 3435's rollback
 *       (3417's body, no column), a rebuild; 3435 re-applied, a rebuild at the
 *       same instant. Every column 3417 wrote is identical; the only difference
 *       is `feature_version`. Rows written before 3435 are NOT backfilled.
 *   F2  the stored row equals lib/discoveryTrendState over the same rows, and
 *       its model and feature versions are the TypeScript store's own.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, seedUser } from "./localDb.js";
import { computeTrendStates, TREND_STATE_MODEL_VERSION, TREND_FEATURE_VERSION, TREND_PRIOR_MS } from "../../lib/discoveryTrendState.js";
import type { MomentumRow } from "../../lib/discoveryLocalMomentum.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(__dir, "../../migrations/3435_place_momentum_feature_version.sql");
const ROLLBACK = resolve(__dir, "../../../../../db/rollback/2026-09-28-3435-place-momentum-feature-version-rollback.sql");

const TAG = `pfv${randomUUID().slice(0, 8)}`;
const HOUR = 3_600_000;
const NOW_MS = Math.floor(Date.now() / 1000) * 1000 - 60_000;
const P_NOW = new Date(NOW_MS).toISOString();
const iso = (hoursAgo: number) => new Date(NOW_MS - hoursAgo * HOUR).toISOString();
let viewer = "";

/** Places chosen so several states occur, with a dismiss and a save among them. */
const SEED: Array<{ place: string; outcome: string; served: number; at: number | null }> = [];
const place = (label: string) => `${TAG}-${label}`;
for (const h of [1, 2, 4, 6]) SEED.push({ place: place("new"), outcome: "impression", served: h, at: null });               // emerging
for (let h = 1; h <= 15; h++) SEED.push({ place: place("hot"), outcome: "impression", served: h, at: null });               // trending: 15 now
for (const h of [50, 60, 70, 80, 90, 100, 110, 120]) SEED.push({ place: place("hot"), outcome: "impression", served: h, at: null }); // against 3.2 per 48 h
for (const h of [1, 2, 3, 4]) SEED.push({ place: place("steady"), outcome: "impression", served: h, at: null });           // established
for (const h of [50, 60, 70, 80, 90, 100, 110, 120]) SEED.push({ place: place("steady"), outcome: "impression", served: h, at: null });
for (const h of [1, 2, 3]) SEED.push({ place: place("back"), outcome: "impression", served: h, at: null });                 // rediscovered
for (const h of [200, 210, 220, 230, 240, 250, 260, 270, 280]) SEED.push({ place: place("back"), outcome: "save", served: h, at: h - 1 });
SEED.push({ place: place("back"), outcome: "save", served: 2, at: 1 });
SEED.push({ place: place("new"), outcome: "dismiss", served: 3, at: 2 });

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

const MINE = `place_id LIKE '${TAG}-%' AND computed_at = '${P_NOW}'`;
/** Every column of this suite's rows, as one JSON line, keyed and ordered by place. */
const SNAPSHOT = `SELECT 'SNAP' || COALESCE(json_agg(to_jsonb(p) ORDER BY p.place_id), '[]'::json)::text FROM public.place_momentum p WHERE ${MINE};`;

before(() => {
  if (!HAVE_DB) return;
  assert.equal(scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'place_momentum' AND column_name = 'feature_version';"), "1",
    "3435 must be in the harness chain");
  viewer = seedUser(`${TAG}v`);
  const values = SEED.map((r) =>
    `('${viewer}', '${r.place}', 'place', 0, '{}'::jsonb, '${r.outcome}', '${iso(r.served)}', ${r.at === null ? "NULL" : `'${iso(r.at)}'`}, 'discovery', 1, 'raw_behavioral_event')`);
  exec(`INSERT INTO public.rank_events (user_id, item_id, item_kind, position, features, outcome, served_at, outcome_at, surface, schema_version, privacy_class)
        VALUES ${values.join(",\n")};`);
});

after(() => {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.place_momentum WHERE place_id LIKE '${TAG}-%' OR computed_at = '${P_NOW}';`);
  exec(`DELETE FROM public.rank_events WHERE item_id LIKE '${TAG}-%';`);
  exec(`DELETE FROM public.profiles WHERE id = '${viewer}';\nDELETE FROM auth.users WHERE id = '${viewer}';`);
});

describe("F — DC-17: place_momentum records its feature version, and nothing else moves (3435)", { skip: !HAVE_DB }, () => {
  test("F1. 3417's body and 3435's write identical rows except feature_version; rows written before 3435 stay NULL", () => {
    const out = exec(`BEGIN;
${unwrapped(ROLLBACK)}
SELECT public.rebuild_place_momentum('${P_NOW}');
${SNAPSHOT}
${unwrapped(MIGRATION)}
${SNAPSHOT}
SELECT public.rebuild_place_momentum('${P_NOW}');
${SNAPSHOT}
ROLLBACK;`).filter((l) => l.startsWith("SNAP")).map((l) => JSON.parse(l.slice(4)) as Array<Record<string, unknown>>);
    assert.equal(out.length, 3);
    const [by3417, reapplied, by3435] = out as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
    assert.equal(by3417.length, 4, "one row per seeded place");
    assert.ok(by3417.every((r) => !("feature_version" in r)), "3435's rollback drops the column");
    assert.ok(reapplied.every((r) => r["feature_version"] === null), "a row written before 3435 is not backfilled: NULL is 'not recorded'");
    assert.ok(by3435.every((r) => r["feature_version"] === TREND_FEATURE_VERSION), "3435 writes the TypeScript store's feature version");
    const strip = (r: Record<string, unknown>) => { const { feature_version: _f, ...rest } = r; return rest; };
    assert.deepEqual(by3435.map(strip), by3417, "3435 moved a value 3417 wrote");
    assert.equal(new Set(by3417.map((r) => r["trend_state"])).size, 4, "not vacuous: the rows differ in state");
  });

  test("F2. the stored row equals lib/discoveryTrendState, and names the same model and feature version", () => {
    exec(`SET LOCAL ROLE service_role;\nSELECT public.rebuild_place_momentum('${P_NOW}');`, { single: true });
    const got = rows<{ place_id: string; trend_state: string; recent_rate: number; mid_rate: number; prior_rate: number; total_weight: number; model_version: string; feature_version: string; computed_at: string; window_ms: { prior_ms: number } }>(
      `SELECT place_id, trend_state, recent_rate, mid_rate, prior_rate, total_weight, model_version, feature_version, computed_at, window_ms FROM public.place_momentum WHERE ${MINE}`);
    const ts = computeTrendStates(SEED.map((r): MomentumRow => ({ item_id: r.place, outcome: r.outcome, served_at: iso(r.served), outcome_at: r.at === null ? null : iso(r.at) })), NOW_MS);
    assert.equal(got.length, 4);
    assert.deepEqual(new Set(got.map((g) => g.trend_state)), new Set(["emerging", "trending", "established", "rediscovered"]), "not vacuous: four states");
    for (const g of got) {
      const r = ts[g.place_id]!;
      assert.deepEqual(
        { state: g.trend_state, recent: g.recent_rate, mid: g.mid_rate, prior: g.prior_rate, total: g.total_weight },
        { state: r.state, recent: r.evidence.recentRate, mid: r.evidence.midRate, prior: r.evidence.priorRate, total: r.evidence.totalWeight }, g.place_id);
      // The four of `10` §5, stored and equal to what the TypeScript store stamps.
      assert.equal(g.model_version, r.provenance.modelVersion);
      assert.equal(g.model_version, TREND_STATE_MODEL_VERSION);
      assert.equal(g.feature_version, r.provenance.featureVersion);
      assert.equal(Date.parse(g.computed_at), r.provenance.computedAt);
      assert.equal(Date.parse(g.computed_at) - g.window_ms.prior_ms, r.provenance.window.startMs);
      assert.equal(g.window_ms.prior_ms, TREND_PRIOR_MS);
    }
  });
});
