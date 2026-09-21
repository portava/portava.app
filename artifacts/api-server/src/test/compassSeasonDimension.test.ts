/**
 * census-compass CPH-15 — "destination behaviour varies by time/season/event".
 *
 * Time varied (weekday × daypart slices), and the ranking read them; season was
 * a prose line ("has recorded activity this month") derived by slicing UTC
 * timestamps out of first/last-seen, never a ranking input. Now:
 *   - every time-slice edge is written beside a MONTH edge keyed on the city's
 *     LOCAL month (`active_during_month:<category>`), from the same
 *     observations — passport stamps, events, experiences;
 *   - `buildCityWorldModels` folds those into a per-month profile with the
 *     same category breakdown a slice carries;
 *   - `seasonBoostForItem` is a second bounded addend in
 *     `worldModelBoostForItem`, so the SAME item scores differently in
 *     different months; and
 *   - the destination line names the month's leading categories.
 * Events already feed both dimensions (the `events` read folds into the same
 * edges), which is the "event" of the clause as this census reads it.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 the season addend dropped from the combined boost              → red
 *   M2 the month fold reads UTC first_seen slicing again (no categories) → red
 *   M3 the month edge not written at the events site                   → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/compassSeasonDimension.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SEASON_BOOST_MAX,
  WORLD_MODEL_BOOST_MAX,
  MIN_SLICE_SAMPLE,
  buildCityWorldModels,
  localMonthKey,
  monthProfile,
  seasonBoostForItem,
  timeSliceKey,
  worldModelBoostForItem,
  type CityWorldModel,
} from "../compass/CompassGraphEngine.js";
import type { CompassItem } from "../compass/types.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CITY = "Cebu";
const item = (category: string): CompassItem => ({ id: "i1", type: "place", category, interestTags: [category] } as unknown as CompassItem);

function model(over: Partial<CityWorldModel> = {}): CityWorldModel {
  return { city: CITY, timeSlices: {}, monthly: {}, topCategories: [], sampleSize: 0, builtAt: new Date().toISOString(), ...over };
}

describe("A. the month profile", () => {
  it("reads the new per-month shape and the legacy bare count alike", () => {
    const m = model({ monthly: { "07": { count: 12, categories: { beach: 9, food: 3 } }, "01": 4, "02": 0 } });
    assert.deepEqual(monthProfile(m, "07"), { count: 12, categories: { beach: 9, food: 3 } });
    assert.deepEqual(monthProfile(m, "01"), { count: 4, categories: {} });
    assert.equal(monthProfile(m, "02"), null);
    assert.equal(monthProfile(m, "12"), null);
  });
});

describe("B. season is a ranking input — the same item scores differently by month", () => {
  const july = new Date("2026-07-15T12:00:00Z");
  const january = new Date("2026-01-15T12:00:00Z");
  const jul = localMonthKey(july, CITY);
  const jan = localMonthKey(january, CITY);
  const m = model({ monthly: { [jul]: { count: 20, categories: { beach: 16, food: 4 } }, [jan]: { count: 20, categories: { food: 18, beach: 2 } } } });

  it("beach is boosted in the beach month and barely in the food month; food the reverse", () => {
    const beachJul = seasonBoostForItem(item("beach"), m, july);
    const beachJan = seasonBoostForItem(item("beach"), m, january);
    assert.ok(beachJul.boost > beachJan.boost, `${beachJul.boost} > ${beachJan.boost}`);
    assert.equal(beachJul.factor?.key, "city_season");
    const foodJan = seasonBoostForItem(item("food"), m, january);
    assert.ok(foodJan.boost > seasonBoostForItem(item("food"), m, july).boost);
    assert.ok(beachJul.boost <= SEASON_BOOST_MAX);
  });

  it("an under-sampled month and an unmatched category contribute nothing", () => {
    const thin = model({ monthly: { [jul]: { count: MIN_SLICE_SAMPLE - 1, categories: { beach: 2 } } } });
    assert.equal(seasonBoostForItem(item("beach"), thin, july).boost, 0);
    assert.equal(seasonBoostForItem(item("museum"), m, july).boost, 0);
    assert.equal(seasonBoostForItem(item("beach"), null, july).boost, 0);
  });

  it("the combined world-model boost carries the season addend, reported separately, and stays bounded", () => {
    const slice = timeSliceKey(july, CITY);
    const both = model({
      timeSlices: { [slice]: { count: 10, categories: { beach: 10 } } },
      monthly: { [jul]: { count: 20, categories: { beach: 20 } } },
    });
    const a = worldModelBoostForItem(item("beach"), both, july);
    assert.equal(a.seasonBoost, SEASON_BOOST_MAX);
    assert.equal(a.seasonFactor?.key, "city_season");
    assert.equal(a.boost, WORLD_MODEL_BOOST_MAX + SEASON_BOOST_MAX);
    // No slice for the hour, season alone: the boost is the season addend.
    const seasonOnly = worldModelBoostForItem(item("beach"), model({ monthly: both.monthly }), july);
    assert.equal(seasonOnly.boost, SEASON_BOOST_MAX);
    assert.equal(seasonOnly.factor, null);
  });
});

describe("C. the fold — month profiles come from the month edges, city-local and per category", () => {
  it("buildCityWorldModels folds active_during_month edges into monthly profiles with categories", async () => {
    const edges = [
      { src_key: CITY, dst_key: `${CITY}|fri:evening`, edge_type: "active_during:food", observed_count: 5, attrs: null, first_seen: "2026-07-01", last_seen: "2026-07-20" },
      { src_key: CITY, dst_key: `${CITY}|m:07`, edge_type: "active_during_month:food", observed_count: 5 },
      { src_key: CITY, dst_key: `${CITY}|m:07`, edge_type: "active_during_month:beach", observed_count: 9 },
      { src_key: CITY, dst_key: `${CITY}|m:01`, edge_type: "active_during_month:food", observed_count: 2 },
    ];
    const upserts: any[] = [];
    const db: any = {
      from(table: string) {
        let rows: any[] = table === "compass_graph_edges" ? edges : [];
        const b: any = {
          select() { return b; },
          like(_c: string, pat: string) { const re = new RegExp("^" + pat.replace(/%/g, ".*") + "$"); rows = rows.filter((r) => re.test(String(r.edge_type))); return b; },
          eq(c: string, v: any) { rows = rows.filter((r) => r[c] === v); return b; },
          limit() { return b; },
          then(res: any) { res({ data: rows, error: null }); },
          upsert(row: any) { upserts.push(row); return Promise.resolve({ error: null }); },
        };
        return b;
      },
    };
    const n = await buildCityWorldModels(db);
    assert.equal(n, 1);
    const monthly = upserts[0].monthly;
    assert.deepEqual(monthly["07"], { count: 14, categories: { food: 5, beach: 9 } });
    assert.deepEqual(monthly["01"], { count: 2, categories: { food: 2 } });
    // The time slices are untouched by the month edges.
    assert.equal(upserts[0].time_slices["fri:evening"].count, 5);
  });

  it("every time-slice write site also writes the month edge, and the month key is the city's local month", () => {
    const src = strip(readFileSync(join(SRC, "compass", "CompassGraphEngine.ts"), "utf8"));
    const sliceWrites = (src.match(/edge_type: (?:"active_during:exploring"|`active_during:\$\{category\.toLowerCase\(\)\}`|"active_during:experience")/g) ?? []).length;
    const monthWrites = (src.match(/monthEdge\(batch, city, new Date\(at\)/g) ?? []).length;
    assert.equal(sliceWrites, 3);
    assert.equal(monthWrites, 3, "a slice write without its month edge");
    assert.match(src, /const month = localMonthKey\(at, city, coords\);/);
    assert.doesNotMatch(src, /String\(ts\)\.slice\(5, 7\)/, "the UTC first/last-seen month slicing survives");
  });
});
