/**
 * census-discovery §47 (DV-18) — `season_match` gets its producer, and NOTHING
 * about the order moves.
 *
 * THE DEFECT. Compass's CPH-15 season addend (`seasonBoostForItem`) already
 * ranks `for_you`: `worldModelBoostForItem` folds it into `wm.boost`, which
 * `CompassPipeline` adds to `finalScore`. But the pipeline built
 * `rankingFactors` from `wm.factor` (the city_rhythm factor) alone and dropped
 * `wm.seasonFactor` on the floor. So a place could be ranked up BECAUSE of the
 * season and no explanation would ever say so — the reason set was not the set
 * of reasons.
 *
 * THE REPAIR is reporting, not ranking: the factor that already contributed is
 * appended to `rankingFactors`, and `city_season` maps to `01` §11's
 * `season_match`. S1 pins that the order and every finalScore are exactly the
 * boost arithmetic that existed before (under the mutation that removes the
 * hunk, S1 stays green and only S2/S4 go red — that is the "with and without").
 *
 * BLAST RADIUS, stated rather than hidden: `rankingFactors` is the SHARED Compass
 * pipeline's, so the `city_season` factor also appears in (a) Compass feed items
 * (`FeedItem extends PipelineResult`; the client reads no `rankingFactors`),
 * (b) the stored `ranking_factors.factors` snapshot, which keeps the FIRST 8
 * (routes/compass.ts `rankingSnapshot`), and (c) `buildWhyThisText`, which keeps
 * the TOP 3 BY WEIGHT — S6 pins that a heavier season factor DOES displace the
 * third reason there. That is user-visible text on the Compass tool surface, and
 * it is the correct text: the displaced reason contributed less.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoverySeasonReason.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPipeline } from "../compass/CompassPipeline.js";
import { localMonthKey, timeSliceKey, worldModelBoostForItem, type CityWorldModel } from "../compass/CompassGraphEngine.js";
import { buildWhyThisText } from "../compass/CompassRecommendationEngine.js";
import type { CompassItem, CompassProfile, CompassContext } from "../compass/types.js";
import { reasonsFromPipelineResult } from "../lib/discoveryRankProvenance.js";
import {
  reasonCodesFromSignals, explainReasonCode, REASON_CODES_WITHOUT_PRODUCER,
} from "../lib/discoveryReasonCodes.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

const CITY = "Cebu";
const USER = "cccc0000-0000-4000-8000-00000000000c";

const profile = {
  userId: USER, currentCity: CITY, preferredCities: [], preferredLanguages: [],
  travelStyles: [], socialStyle: null, safetyPreference: "standard", budgetStyle: null,
  visibilityPreference: "public", categoryWeights: null, ignoredItemIds: [],
  blockedUserIds: [], blockerUserIds: [], mutedUserIds: [],
} as unknown as CompassProfile;

const items = (): CompassItem[] => [
  { id: "museum", type: "event", interestTags: ["museum"], city: CITY } as CompassItem,
  { id: "beach",  type: "event", interestTags: ["beach"],  city: CITY } as CompassItem,
];

function cityModelRow(now: Date, opts: { slice?: boolean } = {}) {
  return {
    city: "cebu",
    time_slices: opts.slice ? { [timeSliceKey(now, CITY)]: { count: 10, categories: { beach: 4 } } } : {},
    monthly: { [localMonthKey(now, CITY)]: { count: 10, categories: { beach: 8 } } },
    top_categories: ["beach"], sample_size: 10, built_at: now.toISOString(),
  };
}

async function run(rows: any[]) {
  const w = newWorld({ tables: { compass_city_models: rows } });
  const now = new Date();
  const context = { contextState: "normal", signals: { hourUtc: 12 }, computedAt: now.toISOString() } as unknown as CompassContext;
  return runPipeline(items(), profile, context, worldClient(w) as any, {
    safetyFilter:     () => ({ allowed: true }),
    eligibilityCheck: () => ({ eligible: true }),
    scoreItem:        () => ({ finalScore: 50, components: {} as any }),
  } as any);
}

const asModel = (row: any): CityWorldModel => ({
  city: row.city, timeSlices: row.time_slices, monthly: row.monthly,
  topCategories: row.top_categories, sampleSize: row.sample_size, builtAt: row.built_at,
});

describe("season_match — reported, never re-scored", () => {
  it("S1 the order and every finalScore are the boost arithmetic that already existed", async () => {
    const now = new Date();
    const row = cityModelRow(now);
    const summary = await run([row]);
    const byId = new Map(summary.results.map((r) => [r.item.id, r]));
    const boost = (id: string) => worldModelBoostForItem(items().find((i) => i.id === id)!, asModel(row), now).boost;
    assert.ok(boost("beach") > 0, "precondition: the month profile matches the beach, so the season addend is non-zero");
    assert.equal(byId.get("beach")!.finalScore, 50 + boost("beach"), "the beach's score is the pre-existing season addend, nothing more");
    assert.equal(byId.get("museum")!.finalScore, 50, "an unmatched item's score is untouched");
    assert.deepEqual(summary.results.map((r) => r.item.id), ["beach", "museum"], "the order the season addend always produced");
  });

  it("S2 the matched item gains EXACTLY city_season → season_match; the unmatched item gains nothing", async () => {
    const summary = await run([cityModelRow(new Date())]);
    const beach  = summary.results.find((r) => r.item.id === "beach")!;
    const museum = summary.results.find((r) => r.item.id === "museum")!;
    assert.deepEqual(beach.rankingFactors.filter((f) => f.key === "city_season").length, 1,
      "the factor that earned the season addend must be reported, once");
    assert.ok(reasonsFromPipelineResult(beach as any).includes("city_season"));
    assert.ok(reasonCodesFromSignals(reasonsFromPipelineResult(beach as any)).includes("season_match"));
    assert.ok(!museum.rankingFactors.some((f) => f.key === "city_season"), "no season factor where no season addend was earned");
    assert.ok(!reasonCodesFromSignals(reasonsFromPipelineResult(museum as any)).includes("season_match"));
  });

  it("S3 no model, or a model whose month does not match: nothing gained, nothing thrown", async () => {
    const none = await run([]);
    for (const r of none.results) assert.ok(!r.rankingFactors.some((f) => f.key === "city_season"));
    const now = new Date();
    const other = { ...cityModelRow(now), monthly: { [localMonthKey(now, CITY)]: { count: 10, categories: { opera: 8 } } } };
    const miss = await run([other]);
    for (const r of miss.results) assert.ok(!r.rankingFactors.some((f) => f.key === "city_season"));
  });

  it("S4 with a matching time slice too, both factors are reported — rhythm first, season beside it", async () => {
    const summary = await run([cityModelRow(new Date(), { slice: true })]);
    const keys = summary.results.find((r) => r.item.id === "beach")!.rankingFactors.map((f) => f.key);
    assert.ok(keys.includes("city_rhythm") && keys.includes("city_season"), `got ${JSON.stringify(keys)}`);
    assert.equal(keys.indexOf("city_season"), keys.indexOf("city_rhythm") + 1);
  });

  it("S5 the code is emittable, has fixed plain language, and no code is left without a producer (trip_match left in census-discovery §78)", () => {
    assert.deepEqual([...REASON_CODES_WITHOUT_PRODUCER], []);  // restated by census-discovery §78 (D-W10-R2-6): portavaRank `tripMatch` grounds trip_match — pinned in discoveryRankTrip.test.ts T5
    const text = explainReasonCode("season_match")!;
    assert.match(text, /^[A-Z].*[.!]$/);
    assert.ok(!/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|beach|month \d)/i.test(text), "fixed text — names no month or category");
  });

  it("S6 BLAST RADIUS: buildWhyThisText keeps the top 3 by weight, so a heavier season factor displaces the third reason", () => {
    const f = (key: string, weight: number) => ({ key, label: key.toUpperCase(), weight });
    const base = [f("interest_match", 0.9), f("distance", 0.8), f("open_now", 0.7)];
    assert.equal(buildWhyThisText([...base, f("city_season", 0.5)]), buildWhyThisText(base),
      "a lighter season factor changes nothing the user reads");
    const heavier = buildWhyThisText([...base, f("city_season", 0.95)])!;
    assert.ok(heavier.includes("city_season") && !heavier.includes("open_now"),
      "stated, not hidden: a heavier season factor is shown and the weakest of the three is not");
  });
});
