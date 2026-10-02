/**
 * discoveryTrendNormalised — census-discovery §84 (lane W10-R1): the `03` §7
 * exposure-normalised trend model, pure, plus the parse-level parity of its SQL
 * twin (3476, 3477) and the loader's flag gate. The execution-level parity is
 * src/test/db/discoveryTrendNormalisedParity.db.test.ts.
 *
 *   V   DV-30 / DC-06: an impression is exposure, not activity; the floor
 *   D   DV-32 / DV-34: one account, one synchronised burst, independence
 *   E   DV-28: emerging needs broad independent confirmation; `03` §4 lifecycle
 *   Z   the five other normalisers: time of day, content age, creator, Trail, location
 *   P   DV-29: Local Pulse over a cell
 *   R   DV-33: the driver, and the sentence
 *   M   the momentum scalar under v2
 *   F   the flag: v1 by default, v2 only when asked; the loader reads the flag
 *   Q   the SQL twin says the same constants, sentences and order (parsed)
 *
 * Controlled data only; no claim about real-world effectiveness.
 * Run: node --import tsx/esm --test src/test/discoveryTrendNormalised.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTrendStatesV2, computeLocalMomentumV2, computeAreaTrendStates, buildPlaceTrendContext, classifyTrendStateV2,
  lifecycleOf, driverOf, contentClassOf, cellKeyOf, median, peerFactors,
  TREND_V2_MIN_EXPOSURES, TREND_V2_MIN_GROUPS, TREND_V2_GROUP_CAP, TREND_V2_SYNC_MS, TREND_V2_LAUNCH_MS, TREND_V2_MIN_PEERS,
  TREND_V2_RECENT_MS, TREND_V2_MID_MS, TREND_V2_PRIOR_MS, TREND_V2_WEIGHTS, TREND_V2_GROWTH_FACTOR, TREND_V2_DECLINE_FACTOR,
  TREND_V2_SATURATION, TREND_V2_BAND_HOURS, TREND_V2_CELL_DEG, CONTENT_HORIZON_MS, EPHEMERAL_TYPES, ENDURING_TYPES,
  TREND_DRIVERS, TREND_LIFECYCLE_STATES,
  type TrendRowV2, type PlaceTrendContext, type TrendStateV2,
} from "../lib/discoveryTrendNormalised.js";
import {
  computeTrendStates, explainTrendReading, TREND_STATES, TREND_RECENT_MS, TREND_MID_MS, TREND_PRIOR_MS,
  TREND_GROWTH_FACTOR, TREND_DECLINE_FACTOR, TREND_EVENT_WEIGHTS, TREND_STATE_MODEL_VERSION, TREND_FEATURE_VERSION,
  TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, trendDriverCode, TREND_DRIVER_CODES,
} from "../lib/discoveryTrendState.js";
import {
  computeLocalMomentum, loadLocalMomentum, readRetestReadings, _resetLocalMomentumCacheForTest, MOMENTUM_SATURATION,
  LOCAL_MOMENTUM_FEATURE_VERSION, LOCAL_MOMENTUM_FEATURE_VERSION_V2, LOCAL_MOMENTUM_MODEL_VERSION_V2, LOCAL_MOMENTUM_MODEL_VERSION,
} from "../lib/discoveryLocalMomentum.js";
import { SYNC_WINDOW_SECONDS } from "../lib/intelIndependence.js";
import { AREA_GRID_DEG } from "../lib/mapTravelers.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG = (f: string) => readFileSync(join(__dir, "..", "migrations", f), "utf8");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const H = 3_600_000;
const at = (h: number) => new Date(NOW - h * H).toISOString();

/** n impressions by rotating users, served from `fromH` hours ago, `stepH` apart. */
function imps(item: string, n: number, fromH: number, stepH = 0.5): TrendRowV2[] {
  return Array.from({ length: n }, (_, i) => ({ item_id: item, outcome: "impression", served_at: at(fromH + i * stepH), outcome_at: null, user_id: `viewer-${i % 50}` }));
}
/** One converted row per actor, `gapMs` apart starting `atH` hours ago. */
function acts(item: string, outcome: string, actors: string[], atH: number, gapMs = 15 * 60_000): TrendRowV2[] {
  return actors.map((u, k) => {
    const t = NOW - atH * H - k * gapMs;
    return { item_id: item, outcome, served_at: new Date(t - 60_000).toISOString(), outcome_at: new Date(t).toISOString(), user_id: u };
  });
}
const people = (n: number, p = "p") => Array.from({ length: n }, (_, i) => `${p}${i}`);
const v2 = (rows: TrendRowV2[], opts = {}) => computeTrendStatesV2(rows, NOW, opts);

// ── V: exposure ──────────────────────────────────────────────────────────────
describe("V — DV-30 / DC-06: a served impression is exposure, not activity", () => {
  it("V1. (T1 under v2) impressions alone are no trend and no momentum, however many", () => {
    const rows = imps("db/only-served", 200, 1, 0.2);
    const r = v2(rows)["db/only-served"]!;
    assert.equal(r.state, "unknown");
    assert.equal(r.evidence.recentRate, 0);
    assert.equal(r.evidence.recentExposures, 200);
    assert.equal(computeLocalMomentumV2(rows, NOW)["db/only-served"] ?? 0, 0);
  });

  it("V2. (T2 under v2) at the same engagement, the place served ten times as often converts ten times less", () => {
    const rows = [...imps("db/wide", 300, 1, 0.1), ...acts("db/wide", "tap", people(4), 2), ...imps("db/narrow", 30, 1, 1), ...acts("db/narrow", "tap", people(4), 2)];
    const s = v2(rows);
    assert.ok(s["db/wide"]!.evidence.recentRate < s["db/narrow"]!.evidence.recentRate / 5,
      `exposure-normalised: ${s["db/wide"]!.evidence.recentRate} vs ${s["db/narrow"]!.evidence.recentRate}`);
  });

  it("V3. below TREND_V2_MIN_EXPOSURES a window is no reading; at it, it is", () => {
    const four = acts("db/x", "tap", people(4), 2);
    const below = v2([...imps("db/x", TREND_V2_MIN_EXPOSURES - 5, 1), ...four])["db/x"]!;
    assert.equal(below.evidence.recentExposures, TREND_V2_MIN_EXPOSURES - 1);
    assert.equal(below.state, "unknown");
    const atFloor = v2([...imps("db/x", TREND_V2_MIN_EXPOSURES - 4, 1), ...four])["db/x"]!;
    assert.equal(atFloor.evidence.recentExposures, TREND_V2_MIN_EXPOSURES);
    assert.equal(atFloor.state, "emerging");
  });

  it("V4. dismisses and analytics are never activity; a dismiss is still an exposure", () => {
    const rows = [...imps("db/d", 40, 1), ...acts("db/d", "dismiss", people(10), 2), { item_id: "db/d", outcome: "analytics", served_at: at(1), user_id: "q" }];
    const r = v2(rows)["db/d"]!;
    assert.equal(r.evidence.recentExposures, 50);
    assert.equal(r.evidence.totalWeight, 0);
    assert.equal(r.state, "unknown");
  });
});

// ── D: diversity of evidence and independence ───────────────────────────────
describe("D — DV-32 / DV-34: diversity of evidence, counted in independence clusters", () => {
  it("D1. one account acting a hundred times is ONE group, capped at one save's weight: no claim", () => {
    const rows = [...imps("db/one", 40, 1), ...acts("db/one", "save", Array(100).fill("same-user"), 2, 60_000)];
    const r = v2(rows)["db/one"]!;
    assert.equal(r.evidence.recentGroups, 1);
    assert.equal(r.evidence.totalWeight, TREND_V2_GROUP_CAP);
    assert.equal(r.state, "unknown");
    assert.equal(computeLocalMomentumV2(rows, NOW)["db/one"] ?? 0, 0);
  });

  it("D2. four accounts acting within 30 s of each other are one synchronised cluster (Sensing's rule, reused)", () => {
    const burst = v2([...imps("db/s", 40, 1), ...acts("db/s", "save", people(4), 2, 10_000)])["db/s"]!;
    assert.equal(burst.evidence.recentGroups, 1);
    assert.equal(burst.state, "unknown");
    const apart = v2([...imps("db/s", 40, 1), ...acts("db/s", "save", people(4), 2, TREND_V2_SYNC_MS + 1)])["db/s"]!;
    assert.equal(apart.evidence.recentGroups, 4, "31 s apart: four independent clusters");
    assert.equal(apart.state, "emerging");
    assert.equal(TREND_V2_SYNC_MS, SYNC_WINDOW_SECONDS * 1_000);
  });

  it("D3. the synchronised rule is per item and action: the same instant on another place, or another action, is not coordination", () => {
    const rows = [...imps("db/a", 40, 1), ...acts("db/a", "save", ["u1"], 2), ...acts("db/a", "tap", ["u2"], 2), ...acts("db/a", "save", ["u3"], 3)];
    assert.equal(v2(rows)["db/a"]!.evidence.recentGroups, 3);
  });

  it("D4. TREND_V2_MIN_GROUPS is the smallest count at which no single capped group can hold a majority", () => {
    const share = (n: number) => TREND_V2_GROUP_CAP / (TREND_V2_GROUP_CAP + TREND_V2_WEIGHTS.outcome * (n - 1));
    assert.ok(share(TREND_V2_MIN_GROUPS - 1) > 0.5 && share(TREND_V2_MIN_GROUPS) < 0.5);
    const two = v2([...imps("db/2", 40, 1), ...acts("db/2", "tap", people(2), 2)])["db/2"]!;
    assert.equal(two.state, "unknown", "two independent groups are not broad confirmation");
  });
});

// ── E: emerging and the lifecycle ───────────────────────────────────────────
describe("E — DV-28: emerging needs broad confirmation; `03` §4's lifecycle depends on content type", () => {
  it("E1. the v1 defect: one person's save makes a quiet place emerging; under v2 it does not", () => {
    const rows: TrendRowV2[] = [{ item_id: "db/q", outcome: "save", served_at: at(1), outcome_at: at(1), user_id: "solo" }];
    assert.equal(computeTrendStates(rows, NOW)["db/q"]!.state, "emerging", "v1: 1 impression + 1 save = 4 ≥ 3");
    assert.equal(computeTrendStates(rows, NOW, { model: "v2" })["db/q"]!.state, "unknown");
  });

  it("E2. the same evidence reads differently by content type: an event is inactive after 12 h, a temple is not", () => {
    const rows = [...imps("db/e", 40, 1), ...imps("db/e", 40, 50, 1), ...acts("db/e", "tap", people(5), 60)];
    const ctx = (cat: string): Record<string, PlaceTrendContext> => ({ e: { creatorId: null, cellKey: null, cellLabel: null, city: null, createdAtMs: null, contentClass: contentClassOf(cat, null), trailIds: [] } });
    assert.equal(v2(rows, { context: ctx("festival") })["db/e"]!.lifecycle, "inactive");
    assert.equal(v2(rows, { context: ctx("temple") })["db/e"]!.lifecycle, "unknown");
    assert.equal(v2(rows, { context: ctx("cafe") })["db/e"]!.lifecycle, "unknown");
  });

  it("E3. lifecycle mapping, every state and class", () => {
    const last = NOW - 13 * H;
    const cases: Array<[TrendStateV2, "ephemeral" | "standard" | "enduring", boolean, string]> = [
      ["emerging", "standard", false, "emerging"], ["trending", "ephemeral", false, "growing"],
      ["established", "enduring", true, "evergreen"], ["established", "standard", true, "evergreen"],
      ["established", "ephemeral", true, "peak"], ["established", "standard", false, "peak"],
      ["rediscovered", "standard", true, "rediscovered"], ["cooling", "ephemeral", false, "inactive"],
      ["cooling", "standard", false, "cooling"], ["unknown", "ephemeral", false, "inactive"], ["unknown", "enduring", false, "unknown"],
    ];
    for (const [s, c, hp, want] of cases) assert.equal(lifecycleOf(s, c, hp, last, NOW), want, `${s}/${c}/${hp}`);
    assert.equal(lifecycleOf("unknown", "ephemeral", false, null, NOW), "unknown", "no activity at all is no claim, not inactive");
    assert.deepEqual([...TREND_LIFECYCLE_STATES].slice(1).sort(), ["cooling", "emerging", "evergreen", "growing", "inactive", "peak", "rediscovered"],
      "03 §4's seven, plus unknown");
    assert.ok(CONTENT_HORIZON_MS.ephemeral < CONTENT_HORIZON_MS.standard && CONTENT_HORIZON_MS.standard < CONTENT_HORIZON_MS.enduring);
  });

  it("E4. content classes are matched exactly on category, then place_type", () => {
    assert.equal(contentClassOf(" Festival ", null), "ephemeral");
    assert.equal(contentClassOf("cafe", "temple"), "enduring");
    assert.equal(contentClassOf("museum", "event"), "enduring", "category first");
    assert.equal(contentClassOf("nightclub", null), "standard", "a nightclub PLACE is not an event");
    assert.equal(contentClassOf(null, null), "standard");
  });
});

// ── Z: the other normalisers ────────────────────────────────────────────────
describe("Z — DC-06: time of day, content age, creator, Trail, location", () => {
  it("Z1. time of day: a recent surge of exposure in a band that always converts well is expected, not velocity", () => {
    // Mid: the 00–06 UTC band converts at 1 per 5 exposures, the 12–18 band at 1 in 40.
    const bandAt = (hoursAgo: number, bandStartUtc: number) => {
      const t = new Date(NOW - hoursAgo * H); t.setUTCHours(bandStartUtc + 1, 0, 0, 0); return (NOW - t.getTime()) / H;
    };
    const rows: TrendRowV2[] = [];
    for (let d = 3; d < 7; d++) {
      rows.push(...imps("db/t", 10, bandAt(d * 24, 0), 0.01), ...acts("db/t", "tap", [`m${d}a`, `m${d}b`], bandAt(d * 24, 0) - 0.5));
      rows.push(...imps("db/t", 40, bandAt(d * 24, 12), 0.01), ...acts("db/t", "tap", [`n${d}`], bandAt(d * 24, 12) - 0.5));
    }
    // Recent: every exposure in the good band.
    rows.push(...imps("db/t", 40, bandAt(24, 0), 0.01), ...acts("db/t", "tap", people(6), bandAt(24, 0) - 0.5));
    const r = v2(rows)["db/t"]!;
    assert.ok(r.evidence.timeOfDayFactor > 1.5, `the recent mix is expected to convert better: ${r.evidence.timeOfDayFactor}`);
    const raw = r.evidence.recentRate / r.evidence.midRate;
    assert.ok(raw > TREND_V2_GROWTH_FACTOR && r.state !== "trending", `raw ratio ${raw} would be trending; normalised ${r.evidence.velocity} is not`);
    assert.equal(TREND_V2_BAND_HOURS * 4, 24);
  });

  it("Z2. content age: a launch burst inside the first 48 h is not history, so a young place can still emerge", () => {
    const rows = [...imps("db/new", 40, 1), ...acts("db/new", "tap", people(4), 3), ...imps("db/new", 40, 50, 0.5), ...acts("db/new", "save", people(10, "l"), 60)];
    const ctx = (createdHoursAgo: number | null): Record<string, PlaceTrendContext> => ({
      new: { creatorId: null, cellKey: null, cellLabel: null, city: null, createdAtMs: createdHoursAgo === null ? null : NOW - createdHoursAgo * H, contentClass: "standard", trailIds: [] },
    });
    assert.equal(v2(rows, { context: ctx(null) })["db/new"]!.state, "cooling", "no age known: the burst is history");
    assert.equal(v2(rows, { context: ctx(80) })["db/new"]!.state, "emerging", "created 80 h ago: the burst is its launch");
    assert.equal(v2(rows, { context: ctx(80 + 48) })["db/new"]!.state, "cooling", "created 128 h ago: the burst was after its launch");
    assert.equal(TREND_V2_LAUNCH_MS, TREND_V2_RECENT_MS);
  });

  const peerCorpus = (key: "creatorId" | "cellKey" | "trailIds") => {
    const rows: TrendRowV2[] = [];
    const ctx: Record<string, PlaceTrendContext> = {};
    for (const [i, extra] of [[1, 0], [2, 0], [3, 0], [4, 0], [5, 6]] as const) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      rows.push(...imps(`db/${id}`, 40, 1), ...acts(`db/${id}`, "tap", people(6 + extra, `r${i}`), 2), ...imps(`db/${id}`, 40, 50, 2), ...acts(`db/${id}`, "tap", people(3, `m${i}`), 55, 2 * H));
      ctx[id] = { creatorId: key === "creatorId" ? "creator-1" : null, cellKey: key === "cellKey" ? "n:x:old town" : null, cellLabel: null, city: null,
        createdAtMs: null, contentClass: "standard", trailIds: key === "trailIds" ? ["trail-1"] : [] };
    }
    return { rows, ctx };
  };
  for (const key of ["creatorId", "cellKey", "trailIds"] as const) {
    it(`Z3-${key}. a surge shared by every peer is divided out; the one that rose more still trends`, () => {
      const { rows, ctx } = peerCorpus(key);
      const bare = v2(rows);
      const s = v2(rows, { context: ctx });
      assert.equal(bare["db/00000000-0000-4000-8000-000000000001"]!.state, "trending", "without the baseline every one reads trending");
      assert.equal(s["db/00000000-0000-4000-8000-000000000001"]!.state, "established");
      assert.ok(s["db/00000000-0000-4000-8000-000000000001"]!.evidence.peerFactor > TREND_V2_GROWTH_FACTOR);
      assert.equal(s["db/00000000-0000-4000-8000-000000000005"]!.state, "trending");
    });
  }

  it("Z4. a peer baseline needs TREND_V2_MIN_PEERS others; M is the LARGEST median; the median is percentile_cont's", () => {
    assert.equal(median([1, 3]), 2);
    assert.equal(median([5, 1, 3]), 3);
    const c = (creator: string | null, cell: string | null): PlaceTrendContext => ({ creatorId: creator, cellKey: cell, cellLabel: null, city: null, createdAtMs: null, contentClass: "standard", trailIds: [] });
    const own = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 10]]);
    const ctx: Record<string, PlaceTrendContext> = { a: c("x", "k"), b: c("x", "k"), c: c("x", null), d: c(null, "k"), e: c("x", "k") };
    const m = peerFactors(own, (k) => ctx[k] ?? null);
    assert.equal(m.get("a"), Math.max(median([2, 3, 10]), median([2, 4, 10])), "creator median 3, cell median 4: the larger");
    assert.equal(m.get("d"), median([1, 2, 10]), "only the cell group qualifies");
    const two = peerFactors(new Map([["a", 1], ["b", 2], ["c", 3]]), () => c("x", null));
    assert.equal(two.get("a"), 1, `two peers are fewer than ${TREND_V2_MIN_PEERS}: no baseline`);
  });
});

// ── P: Local Pulse ──────────────────────────────────────────────────────────
describe("P — DV-29: Local Pulse is the same model over a cell", () => {
  it("P1. places in one neighbourhood fold into one cell reading; a place with no cell into none", () => {
    const ctx = buildPlaceTrendContext([
      { id: "11111111-1111-4111-8111-111111111111", city: "Bangkok", neighborhood: "Sukhumvit" },
      { id: "22222222-2222-4222-8222-222222222222", city: " bangkok ", neighborhood: "sukhumvit " },
      { id: "33333333-3333-4333-8333-333333333333", city: "Bangkok", lat: 13.7, lng: 100.5 },
      { id: "44444444-4444-4444-8444-444444444444", city: "Bangkok" },
    ]);
    const rows = [
      ...imps("db/11111111-1111-4111-8111-111111111111", 20, 1), ...acts("db/11111111-1111-4111-8111-111111111111", "tap", people(2), 2),
      ...imps("22222222-2222-4222-8222-222222222222", 20, 1), ...acts("22222222-2222-4222-8222-222222222222", "tap", people(2, "z"), 2),
      ...imps("db/44444444-4444-4444-8444-444444444444", 40, 1),
    ];
    const area = computeAreaTrendStates(rows, NOW, ctx);
    assert.deepEqual(Object.keys(area), ["n:bangkok:sukhumvit"]);
    assert.equal(area["n:bangkok:sukhumvit"]!.state, "emerging", "neither place alone has 30 exposures or 3 groups; the neighbourhood does");
    assert.equal(ctx["11111111-1111-4111-8111-111111111111"]!.cellLabel, "Sukhumvit");
    assert.equal(ctx["33333333-3333-4333-8333-333333333333"]!.cellKey, `g:${Math.floor(13.7 / AREA_GRID_DEG)}:${Math.floor(100.5 / AREA_GRID_DEG)}`);
    assert.equal(TREND_V2_CELL_DEG, AREA_GRID_DEG, "the grid is the map's finest cell");
    assert.equal(cellKeyOf(null, "Sukhumvit", null, null), null, "a neighbourhood without a city is not a cell");
  });
});

// ── R: reasons ──────────────────────────────────────────────────────────────
describe("R — DV-33: a reason names what drove it", () => {
  it("R1. the driver is what a strict majority of the recent groups did", () => {
    const e = (g: number, s: number, t: number) => ({ exposures: 40, activity: 9, groups: g, saveGroups: s, tripAddGroups: t, rate: 0.2 });
    assert.equal(driverOf("trending", e(4, 0, 3)), "trip_adds");
    assert.equal(driverOf("trending", e(4, 3, 2)), "saves");
    assert.equal(driverOf("trending", e(4, 2, 2)), "independent_groups", "a tie is no majority");
    assert.equal(driverOf("cooling", e(4, 4, 4)), null, "a decline has no driver");
    assert.equal(driverOf("unknown", e(4, 4, 4)), null);
    assert.deepEqual([...TREND_DRIVERS], ["trip_adds", "saves", "independent_groups"]);
  });

  it("R2. the sentence names the driver, and a neighbourhood only when handed one", () => {
    assert.equal(explainTrendReading("trending", "trip_adds"), "Frequently added to trips in the last couple of days.");
    assert.equal(explainTrendReading("trending", "trip_adds", "Sukhumvit"), "Frequently added to trips in Sukhumvit in the last couple of days.");
    assert.equal(explainTrendReading("emerging", "independent_groups"), "Emerging across several independent groups of people.");
    assert.equal(explainTrendReading("unknown", null), null);
    for (const s of TREND_STATES.slice(1)) for (const d of [...TREND_DRIVERS, null]) {
      const t = explainTrendReading(s, d)!;
      assert.ok(t.length > 0 && !/\d/.test(t), `${s}/${d}: a sentence, and no number`);
      for (const w of ["momentum", "score", "travel", "weight", "rate", "total"]) assert.ok(!t.toLowerCase().includes(w), `${s}/${d}: "${w}" is a word the trend API's closed shape forbids`);
    }
    assert.equal(trendDriverCode("saves"), "trend_driver_saves");
    assert.equal(TREND_DRIVER_CODES.length, 3);
  });
});

// ── M: the momentum scalar ──────────────────────────────────────────────────
describe("M — the momentum scalar under v2", () => {
  it("M1. rises with conversion per exposure over the base window, saturates, and is 0 without a base", () => {
    const base = [...imps("db/m", 60, 60, 2), ...acts("db/m", "tap", people(3, "b"), 100, 3 * H)];
    const recent = (n: number) => [...imps("db/m", 40, 1), ...acts("db/m", "tap", people(n), 2)];
    const m3 = computeLocalMomentumV2([...base, ...recent(3)], NOW)["db/m"] ?? 0;
    const m9 = computeLocalMomentumV2([...base, ...recent(9)], NOW)["db/m"] ?? 0;
    assert.ok(m9 > m3, `${m9} > ${m3}`);
    assert.ok(m9 <= 1);
    assert.equal(computeLocalMomentumV2(recent(9), NOW)["db/m"] ?? 0, 0, "no base reading: no velocity");
    assert.equal(TREND_V2_SATURATION, MOMENTUM_SATURATION);
    const r = computeLocalMomentum([...base, ...recent(9)], NOW, { model: "v2" });
    assert.equal(r.provenance.modelVersion, LOCAL_MOMENTUM_MODEL_VERSION_V2);
    assert.equal(r.provenance.featureVersion, LOCAL_MOMENTUM_FEATURE_VERSION_V2);
  });
});

// ── F: the flag ─────────────────────────────────────────────────────────────
describe("F — v1 unless v2 is asked for; the loader asks only when the flag is on", () => {
  const corpus: TrendRowV2[] = [...imps("db/f", 12, 1), ...acts("db/f", "save", people(2), 2), ...imps("db/g", 3, 60)];
  it("F1. no option, {} and { model: 'v1' } are the v1 arithmetic, byte for byte, with v1's versions", () => {
    const a = JSON.stringify(computeTrendStates(corpus, NOW));
    assert.equal(JSON.stringify(computeTrendStates(corpus, NOW, {})), a);
    assert.equal(JSON.stringify(computeTrendStates(corpus, NOW, { model: "v1" })), a);
    assert.equal(JSON.stringify(computeLocalMomentum(corpus, NOW, {})), JSON.stringify(computeLocalMomentum(corpus, NOW)));
    const r = computeTrendStates(corpus, NOW)["db/f"]!;
    assert.equal(r.provenance.modelVersion, TREND_STATE_MODEL_VERSION);
    assert.equal(r.lifecycle, undefined, "a v1 reading carries no v2 field");
    assert.ok(!("driver" in r));
  });

  it("F2. v2 readings carry v2's versions, a lifecycle and a driver", () => {
    const r = computeTrendStates(corpus, NOW, { model: "v2" })["db/f"]!;
    assert.equal(r.provenance.modelVersion, TREND_STATE_MODEL_VERSION_V2);
    assert.equal(r.provenance.featureVersion, TREND_FEATURE_VERSION_V2);
    assert.ok(TREND_LIFECYCLE_STATES.includes(r.lifecycle!));
    assert.equal(LOCAL_MOMENTUM_FEATURE_VERSION_V2, TREND_FEATURE_VERSION_V2);
  });

  it("F3. no version NAME carries a word the trend API's closed shape forbids", () => {
    for (const v of [TREND_STATE_MODEL_VERSION, TREND_FEATURE_VERSION, TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2,
      LOCAL_MOMENTUM_MODEL_VERSION, LOCAL_MOMENTUM_FEATURE_VERSION, LOCAL_MOMENTUM_MODEL_VERSION_V2, LOCAL_MOMENTUM_FEATURE_VERSION_V2]) {
      for (const w of ["momentum", "score", "travel", "weight", "_rate", "Rate", "total"]) assert.ok(!v.includes(w), `${v} contains ${w}`);
    }
    assert.equal(TREND_FEATURE_VERSION, LOCAL_MOMENTUM_FEATURE_VERSION);
    assert.notEqual(TREND_FEATURE_VERSION_V2, TREND_FEATURE_VERSION, "the per-row contribution changed: a new feature version");
    assert.notEqual(TREND_STATE_MODEL_VERSION_V2, TREND_STATE_MODEL_VERSION);
    assert.notEqual(LOCAL_MOMENTUM_MODEL_VERSION_V2, LOCAL_MOMENTUM_MODEL_VERSION);
  });

  /** A fake client: records every select, answers the flag and the reads. */
  function fakeSc(flagOn: boolean | "error", data: { places?: unknown[]; events?: unknown[]; failPlaces?: boolean } = {}) {
    const log: string[] = [];
    return {
      log,
      from(table: string) {
        let selected = "";
        const b: any = {
          select(s: string) { selected = s; log.push(`${table}:${s}`); return b; },
          eq() { return b; }, neq() { return b; }, in() { return b; }, gte() { return b; }, order() { return b; }, range() { return b; }, limit() { return b; },  // limit: §93 (H-W10T-1) reads trend_integrity_reviews — none recorded here
          maybeSingle() {
            if (flagOn === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
            return Promise.resolve({ data: { enabled: flagOn }, error: null });
          },
          then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
            if (table === "rank_events") return Promise.resolve({ data: data.events ?? [], error: null }).then(res, rej);
            if (table === "discovery_places") return Promise.resolve(data.failPlaces ? { data: null, error: { code: "57014", message: "timeout" } } : { data: data.places ?? [], error: null }).then(res, rej);
            if (table === "content_trails") return Promise.resolve({ data: [], error: null }).then(res, rej);
            return Promise.resolve({ data: [], error: null }).then(res, rej);
          },
        };
        void selected;
        return b;
      },
    };
  }

  it("F4. the loader, flag OFF (or unreadable): v1's select, v1's values, no context read, no retest pool", async () => {
    const events = corpus.map(({ user_id: _u, ...r }) => r);
    for (const flag of [false, "error"] as const) {
      _resetLocalMomentumCacheForTest();
      const sc = fakeSc(flag, { events });
      const m = await loadLocalMomentum(sc, ["db/f", "db/g"], { cacheKey: `k-${String(flag)}`, nowMs: NOW });
      assert.deepEqual(m, computeLocalMomentum(events, NOW));
      assert.ok(sc.log.includes("rank_events:item_id, outcome, served_at, outcome_at"), sc.log.join("|"));
      assert.ok(!sc.log.some((l) => l.startsWith("discovery_places")), "no context read with the flag off");
      assert.deepEqual(readRetestReadings(`k-${String(flag)}`, NOW), {});
    }
  });

  it("F5. the loader, flag ON: user_id selected, the context read, v2 values and versions; a failed context read is 'no surge'", async () => {
    _resetLocalMomentumCacheForTest();
    const sc = fakeSc(true, { events: corpus, places: [] });
    const m = await loadLocalMomentum(sc, ["db/f", "db/00000000-0000-4000-8000-000000000001"], { cacheKey: "on", nowMs: NOW });
    assert.ok(sc.log.includes("rank_events:item_id, outcome, served_at, outcome_at, user_id"));
    assert.ok(sc.log.some((l) => l.startsWith("discovery_places:")), "the community id's context is read");
    assert.deepEqual(m.values, computeLocalMomentumV2(corpus, NOW));
    assert.equal(m.provenance.modelVersion, LOCAL_MOMENTUM_MODEL_VERSION_V2);
    assert.ok(Object.keys(readRetestReadings("on", NOW)).length > 0, "the v2 readings are kept for the retest pool");
    _resetLocalMomentumCacheForTest();
    const bad = await loadLocalMomentum(fakeSc(true, { events: corpus, failPlaces: true }), ["db/00000000-0000-4000-8000-000000000001"], { cacheKey: "bad", nowMs: NOW });
    assert.deepEqual(bad.values, {});
    assert.equal(bad.provenance.modelVersion, LOCAL_MOMENTUM_MODEL_VERSION_V2, "degraded, and says which model it would have run");
  });
});

// ── Q: the SQL twin, parsed ─────────────────────────────────────────────────
describe("Q — 3476/3477 state the same constants, sentences and order as the TypeScript", () => {
  const S77 = MIG("3477_discovery_trend_v2_rebuild.sql");
  const S76 = MIG("3476_discovery_trend_v2_store.sql");
  const num = (src: string, name: string) => Number(new RegExp(`${name}\\s+CONSTANT[^:]*:=\\s*([0-9.]+)`).exec(src)?.[1]);
  const hours = (src: string, name: string) => Number(new RegExp(`${name}\\s+CONSTANT bigint := (\\d+)::bigint\\s*\\*\\s*3600000`).exec(src)?.[1]) * H;

  it("Q1. every mirrored constant", () => {
    assert.equal(hours(S77, "c_recent_ms"), TREND_V2_RECENT_MS);
    assert.equal(hours(S77, "c_mid_ms"), TREND_V2_MID_MS);
    assert.equal(hours(S77, "c_prior_ms"), TREND_V2_PRIOR_MS);
    assert.equal(hours(S77, "c_launch_ms"), TREND_V2_LAUNCH_MS);
    assert.equal(num(S77, "c_w_save"), TREND_V2_WEIGHTS.save);
    assert.equal(num(S77, "c_w_outcome"), TREND_V2_WEIGHTS.outcome);
    assert.equal(num(S77, "c_group_cap"), TREND_V2_GROUP_CAP);
    assert.equal(num(S77, "c_sync_ms"), TREND_V2_SYNC_MS);
    assert.equal(num(S77, "c_band_hours"), TREND_V2_BAND_HOURS);
    assert.equal(num(S77, "c_min_exposures"), TREND_V2_MIN_EXPOSURES);
    assert.equal(num(S77, "c_min_groups"), TREND_V2_MIN_GROUPS);
    assert.equal(num(S77, "c_min_peers"), TREND_V2_MIN_PEERS);
    assert.equal(num(S77, "c_growth_factor"), TREND_V2_GROWTH_FACTOR);
    assert.equal(num(S77, "c_decline_factor"), TREND_V2_DECLINE_FACTOR);
    assert.equal(hours(S77, "c_h_ephemeral_ms"), CONTENT_HORIZON_MS.ephemeral);
    assert.equal(hours(S77, "c_h_standard_ms"), CONTENT_HORIZON_MS.standard);
    assert.equal(hours(S77, "c_h_enduring_ms"), CONTENT_HORIZON_MS.enduring);
    assert.match(S77, new RegExp(`c_model\\s+CONSTANT text := '${TREND_STATE_MODEL_VERSION_V2}'`));
    assert.match(S77, new RegExp(`c_feature\\s+CONSTANT text := '${TREND_FEATURE_VERSION_V2}'`));
    // v2's windows, factors and weights are v1's, restated because of the import cycle.
    assert.deepEqual([TREND_V2_RECENT_MS, TREND_V2_MID_MS, TREND_V2_PRIOR_MS], [TREND_RECENT_MS, TREND_MID_MS, TREND_PRIOR_MS]);
    assert.deepEqual([TREND_V2_GROWTH_FACTOR, TREND_V2_DECLINE_FACTOR], [TREND_GROWTH_FACTOR, TREND_DECLINE_FACTOR]);
    assert.deepEqual([TREND_V2_WEIGHTS.save, TREND_V2_WEIGHTS.outcome], [TREND_EVENT_WEIGHTS.save, TREND_EVENT_WEIGHTS.outcome]);
  });

  it("Q2. the content-class lists and the grid are 3476's", () => {
    const list = (name: "ephemeral" | "enduring") => {
      const m = [...S76.matchAll(/ARRAY\[([^\]]*)\]\) THEN '(ephemeral|enduring)'/g)].filter((x) => x[2] === name)
        .map((x) => [...x[1]!.matchAll(/'([^']*)'/g)].map((q) => q[1]!));
      assert.ok(m.length === 2 && JSON.stringify(m[0]) === JSON.stringify(m[1]), `3476 names the ${name} list twice, identically`);
      return m[0]!;
    };
    assert.deepEqual(list("ephemeral"), [...EPHEMERAL_TYPES]);
    assert.deepEqual(list("enduring"), [...ENDURING_TYPES]);
    assert.match(S76, /floor\(p\.lat \/ 0\.02::double precision\)/);
    assert.equal(TREND_V2_CELL_DEG, 0.02);
  });

  it("Q3. every stored sentence is explainTrendReading's, for every state and driver", () => {
    const fn = S77.slice(S77.indexOf("FUNCTION public.place_momentum_reason_v2"), S77.indexOf("$fn$;", S77.indexOf("FUNCTION public.place_momentum_reason_v2")));
    for (const s of TREND_STATES.slice(1)) for (const d of TREND_DRIVERS) {
      const t = explainTrendReading(s, d)!;
      assert.ok(fn.includes(`'${t.replace(/'/g, "''")}'`), `3477 lacks ${s}/${d}: ${t}`);
    }
    assert.match(fn, /ELSE NULL\s+END/, "unknown stores no sentence");
  });

  it("Q4. the classifier's order and strictness", () => {
    const fn = S77.slice(S77.indexOf("FUNCTION public.place_momentum_classify_v2"), S77.indexOf("$fn$;", S77.indexOf("FUNCTION public.place_momentum_classify_v2")));
    const order = ["'unknown'", "'emerging'", "'rediscovered'", "'trending'", "'cooling'", "'established'"].map((x) => fn.indexOf(`RETURN ${x}`));
    assert.ok(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1]!)), `order ${order.join(",")}`);
    assert.match(fn, /p_velocity > c_growth_factor/);
    assert.match(fn, /p_velocity < c_decline_factor/);
    const cases: Array<[Parameters<typeof classifyTrendStateV2>[0], TrendStateV2]> = [
      [{ recentReading: false, hadMid: true, hadPrior: true, velocity: 9 }, "unknown"],
      [{ recentReading: true, hadMid: false, hadPrior: false, velocity: null }, "emerging"],
      [{ recentReading: true, hadMid: false, hadPrior: true, velocity: null }, "rediscovered"],
      [{ recentReading: true, hadMid: true, hadPrior: false, velocity: 1.5 }, "established"],
      [{ recentReading: true, hadMid: true, hadPrior: false, velocity: 1.51 }, "trending"],
      [{ recentReading: true, hadMid: true, hadPrior: false, velocity: 0.6 }, "established"],
      [{ recentReading: true, hadMid: true, hadPrior: false, velocity: 0.59 }, "cooling"],
    ];
    for (const [i, want] of cases) assert.equal(classifyTrendStateV2(i), want, JSON.stringify(i));
  });

  it("Q5. the dispatcher is 3435's body behind one line, and the rollback restores 3435 verbatim", () => {
    const S35 = MIG("3435_place_momentum_feature_version.sql");
    const RB = readFileSync(join(__dir, "..", "..", "..", "..", "db", "rollback", "2026-09-28-3477-discovery-trend-v2-rebuild-rollback.sql"), "utf8");
    const fnOf = (s: string) => { const a = s.indexOf("CREATE OR REPLACE FUNCTION public.rebuild_place_momentum(p_now timestamptz DEFAULT now())"); return s.slice(a, s.indexOf("$fn$;", a)); };
    const dispatch = fnOf(S77).split("\n").filter((l) => !l.includes("rebuild_place_momentum_v2(p_now); END IF;") && !l.includes("3477 (census-discovery §84): the v2 model"));
    assert.deepEqual(dispatch, fnOf(S35).split("\n"), "flag OFF runs 3435's body, byte for byte");
    assert.equal(fnOf(RB), fnOf(S35), "the rollback restores 3435 verbatim");
    assert.match(S77, /f\.flag = 'discovery_trend_normalised_enabled'\), false\) THEN RETURN public\.rebuild_place_momentum_v2\(p_now\)/,
      "absent or unreadable reads OFF");
  });
});
