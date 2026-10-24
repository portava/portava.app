/**
 * census-discovery §78 (lane W10-R2) — DV-54: diversity on all six `06` §6
 * axes. Extends census §42's E/P series (src/test/discoveryDiversityAxes.test.ts)
 * to the two axes that had no key and the two that had no magnitude.
 *
 *   D1  magnitudes come from the flag metadata; absent / null / out of range ⇒ 0
 *   D2  each axis bites ONLY when its magnitude is set: place, geography,
 *       Trail, history — and each flips a controlled order
 *   D3  the history axis never demotes a place the viewer has not been served,
 *       and stops counting at historyMaxServes
 *   D4  a Trail key is membership: `primary` / `supporting` of a non-archived
 *       Trail; `signal` rows, archived Trails and OSM ids give no key
 *   D5  serve history counts non-analytics discovery rows of THIS viewer only
 *   D6  the seeded magnitudes (3454's metadata) turn all four axes on
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/discoveryRankDiversity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDiversityMagnitudes, diversityOptionsFrom, loadTrailKeys, loadServeHistory,
} from "../lib/discoveryRankDiversity.js";
import { rankCandidates, type RankCandidate } from "../lib/portavaRank.js";
import { newWorld, worldClient } from "./helpers/fakeDiscoveryWorld.js";

const NOW = Date.UTC(2026, 8, 28, 12);
const H = 3_600_000;
const V = "ffff0000-0000-4000-8000-00000000000f";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";

/** a1 and a2 share the axis key under test; b is otherwise identical and a little older. */
function trio(key: (c: RankCandidate, i: number) => RankCandidate): RankCandidate[] {
  const base: RankCandidate[] = [
    { id: "a1", kind: "place", createdAt: new Date(NOW - 1 * H).toISOString() },
    { id: "a2", kind: "place", createdAt: new Date(NOW - 1.2 * H).toISOString() },
    { id: "b", kind: "place", createdAt: new Date(NOW - 6 * H).toISOString() },
  ];
  return base.map(key);
}
const order = (cands: RankCandidate[], diversity: Record<string, number>) =>
  rankCandidates(cands, { userId: "v", nowMs: NOW }, { exploration: false, diversity }).map((s) => s.candidate.id);

describe("DV-54 — the six axes", () => {
  it("D1 magnitudes from metadata; absent, null or out of range ⇒ 0", () => {
    assert.deepEqual(parseDiversityMagnitudes(null), { placePenalty: 0, geoPenalty: 0, trailPenalty: 0, historyPenalty: 0, historyMaxServes: 3, historyWindowDays: 7 });
    assert.deepEqual(parseDiversityMagnitudes({ placePenalty: null, geoPenalty: 1.5, trailPenalty: -1, historyPenalty: "0.2" }).placePenalty, 0);
    const m = parseDiversityMagnitudes({ placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 4, historyWindowDays: 14 });
    assert.deepEqual(diversityOptionsFrom(m), { placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 4, recordAxisEvidence: true });   // §132: the 3454 path asks for the per-row record
    assert.equal(m.historyWindowDays, 14);
  });

  it("D2 each axis bites only when set, and flips the controlled order", () => {
    const cases: Array<[string, (c: RankCandidate, i: number) => RankCandidate, Record<string, number>]> = [
      ["place", (c, i) => ({ ...c, placeId: i < 2 ? "P" : "Q" }), { placePenalty: 0.5 }],
      ["geography", (c, i) => ({ ...c, neighborhood: i < 2 ? "Alfama" : "Baixa" }), { geoPenalty: 0.5 }],
      ["Trail", (c, i) => ({ ...c, trailIds: i < 2 ? ["T"] : ["S"] }), { trailPenalty: 0.5 }],
    ];
    for (const [axis, key, on] of cases) {
      const off = order(trio(key), { kindPenalty: 0 });
      assert.deepEqual(off, ["a1", "a2", "b"], `${axis}: magnitude 0 changes nothing`);
      assert.deepEqual(order(trio(key), { kindPenalty: 0, ...on }), ["a1", "b", "a2"], `${axis}: the repeat is pushed down`);
    }
    // history: a2 was served before
    const hist = trio((c) => (c.id === "a1" ? { ...c, servedCount: 2 } : c));
    assert.deepEqual(order(hist, { kindPenalty: 0 }), ["a1", "a2", "b"]);
    assert.deepEqual(order(hist, { kindPenalty: 0, historyPenalty: 0.2 }), ["a2", "b", "a1"], "the twice-served place (0.981 − 2 × 0.2) falls below both unserved ones");
  });

  it("D3 history never touches an unserved place, and stops at historyMaxServes", () => {
    const fresh = rankCandidates([{ id: "u", kind: "place" }], { userId: "v", nowMs: NOW }, { exploration: false, diversity: { historyPenalty: 1 } });
    assert.equal(fresh[0].score, 0);
    const mk = (n: number) => ({ id: `s${n}`, kind: "place" as const, servedCount: n, createdAt: new Date(NOW - H).toISOString() });
    const ranked = rankCandidates([mk(3), mk(9), { id: "zero", kind: "place" as const, servedCount: 0, createdAt: new Date(NOW - 1.5 * H).toISOString() }],
      { userId: "v", nowMs: NOW }, { exploration: false, diversity: { historyPenalty: 0.1, historyMaxServes: 3, kindPenalty: 0 } });
    assert.equal(ranked[0].candidate.id, "zero");
    assert.deepEqual(ranked.slice(1).map((s) => s.candidate.id), ["s3", "s9"], "3 and 9 prior serves pay the same, capped at 3; input order breaks the tie");
  });

  it("D4 Trail keys: membership of a non-archived Trail only", async () => {
    const world = newWorld({ tables: {
      content_trails: [
        { trail_id: "t-live", source_type: "place", source_id: U1, relationship: "primary" },
        { trail_id: "t-live", source_type: "place", source_id: U2, relationship: "supporting" },
        { trail_id: "t-live", source_type: "place", source_id: U3, relationship: "signal" },
        { trail_id: "t-old", source_type: "place", source_id: U3, relationship: "primary" },
        { trail_id: "t-post", source_type: "post", source_id: U3, relationship: "primary" },
        { trail_id: "t-two", source_type: "place", source_id: U1, relationship: "primary" },
      ],
      trails: [
        { id: "t-live", review_state: "approved", lifecycle_status: "active" }, { id: "t-old", review_state: "approved", lifecycle_status: "archived" },
        { id: "t-post", review_state: "approved", lifecycle_status: "active" }, { id: "t-two", review_state: "approved", lifecycle_status: "stale" },
      ],
    } });
    const r = await loadTrailKeys(worldClient(world), [`db/${U1}`, U2, `db/${U3}`, "node/5"]);
    assert.equal(r.degraded, false);
    assert.deepEqual(Object.fromEntries(r.trailIds), { [`db/${U1}`]: ["t-live", "t-two"], [U2]: ["t-live"] });
    const broken = newWorld({ tables: {} }); broken.errorTables.add("content_trails");
    assert.deepEqual(await loadTrailKeys(worldClient(broken), [`db/${U1}`]), { trailIds: new Map(), degraded: true });
    const osmOnly = newWorld({ tables: {} });
    assert.deepEqual(await loadTrailKeys(worldClient(osmOnly), ["node/5"]), { trailIds: new Map(), degraded: false });
    assert.deepEqual(osmOnly.reads, [], "OSM ids name no Trail member: nothing is read");
  });

  it("D5 serve history: this viewer, discovery, non-analytics", async () => {
    const at = (h: number) => new Date(NOW - h * H).toISOString();
    const world = newWorld({ tables: { rank_events: [
      { user_id: V, surface: "discovery", outcome: "impression", item_id: "p1", served_at: at(1) },
      { user_id: V, surface: "discovery", outcome: "save", item_id: "p1", served_at: at(30) },
      { user_id: V, surface: "discovery", outcome: "analytics", item_id: "p1", served_at: at(2) },
      { user_id: V, surface: "pulse", outcome: "impression", item_id: "p2", served_at: at(2) },
      { user_id: "other", surface: "discovery", outcome: "impression", item_id: "p2", served_at: at(2) },
      { user_id: V, surface: "discovery", outcome: "impression", item_id: "p3", served_at: at(24 * 8) },
    ] } });
    const r = await loadServeHistory(worldClient(world), V, 7, NOW);
    assert.deepEqual(Object.fromEntries(r.servedCount), { p1: 2 }, "p3 is outside the 7-day window");
    const broken = newWorld({ tables: {} }); broken.errorTables.add("rank_events");
    assert.equal((await loadServeHistory(worldClient(broken), V, 7, NOW)).degraded, true);
  });

  it("D6 migration 3454 seeds all four magnitudes, so the flag turns all four axes on", () => {
    const sql = readFileSync(new URL("../migrations/3454_discovery_diversity_axes_flag.sql", import.meta.url), "utf8");
    const m = /'(\{"placePenalty"[^']*\})'::jsonb/.exec(sql);
    assert.ok(m, "3454 seeds its metadata as a jsonb literal");
    const mags = parseDiversityMagnitudes(JSON.parse(m![1]));
    for (const k of ["placePenalty", "geoPenalty", "trailPenalty", "historyPenalty"] as const) assert.ok(mags[k] > 0, `${k} seeded`);
  });
});

// ── census-discovery §132 (DV-54): a served row can show what each axis charged it ──
//
// D7  the order is byte-identical whether or not the record is asked for, and
//     nothing is recorded unless it is
// D8  each axis, set alone on a controlled repeat, shows up under its own name
//     on the demoted row and nowhere else
// D9  the five window axes sum to `repetitionPenalty` over the same window,
//     and `total` is the six summed, on a seeded random world
// D10 scoreRank / diversifiedRank say when the re-rank moved a row
// D11 the 3454 path (diversityOptionsFrom) asks for the record
// D12 through rankForViewer with 3454 ON, every scored row carries the record
//     the serve log writes (pdeFeatureProvenanceFeatures → `diversityAxes`);
//     OFF, no row does
import { diversityAxisEvidence, diversityAxisPenalties, repetitionPenalty, type ScoredCandidate } from "../lib/portavaRank.js";
import { pdeFeatureProvenanceFeatures } from "../lib/discoveryRankProvenance.js";
import { DISCOVERY_FEATURE_KEY_CLASSES } from "../lib/discoveryRecommendationRecord.js";
import { rankForViewer, type PdePlace } from "../lib/discoveryPde.js";
import { invalidateRankDesignFlagCache } from "../lib/discoveryRankFlags.js";
import { invalidateDiscoveryModifiersFlagCache } from "../lib/discoveryModifiers.js";
import { makeFakeCandidateDb, flagRow } from "./helpers/fakeCandidateDb.js";

const rank = (cands: RankCandidate[], diversity: Record<string, unknown>) =>
  rankCandidates(cands, { userId: "v", nowMs: NOW }, { exploration: false, diversity: diversity as any });

describe("§132 — DV-54: the served row records what each of the six axes charged it", () => {
  it("D7 the record changes no order, and is written only when asked", () => {
    const cands = trio((c, i) => ({ ...c, placeId: i < 2 ? "P" : "Q", authorId: i === 2 ? "u2" : "u1", neighborhood: "Alfama" }));
    const on = { kindPenalty: 0.15, placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15 };
    const plain = rank(cands, on), recorded = rank(cands, { ...on, recordAxisEvidence: true });
    assert.deepEqual(recorded.map((s) => [s.candidate.id, s.score, s.features]), plain.map((s) => [s.candidate.id, s.score, s.features]));
    for (const s of plain) assert.equal(diversityAxisEvidence(s), undefined, "not asked: nothing recorded");
    for (const s of recorded) assert.ok(diversityAxisEvidence(s), `${s.candidate.id}: asked: recorded`);
  });

  it("D8 each axis is charged under its own name, exactly as often as its key repeats in the window", () => {
    type Axis = "creator" | "contentType" | "place" | "geography" | "trail";
    const cases: Array<[Axis, (c: RankCandidate, i: number) => RankCandidate, Record<string, number>, (c: RankCandidate) => unknown, boolean]> = [
      ["creator", (c, i) => ({ ...c, authorId: i < 2 ? "A" : "B" }), { authorPenalty: 0.5 }, (c) => c.authorId, true],
      ["contentType", (c, i) => ({ ...c, kind: i < 2 ? "place" : "event" } as RankCandidate), { kindPenalty: 0.5 }, (c) => c.kind, false],
      ["place", (c, i) => ({ ...c, placeId: i < 2 ? "P" : "Q" }), { placePenalty: 0.5 }, (c) => c.placeId, true],
      ["geography", (c, i) => ({ ...c, neighborhood: i < 2 ? "Alfama" : "Baixa" }), { geoPenalty: 0.5 }, (c) => c.neighborhood, true],
      ["trail", (c, i) => ({ ...c, trailIds: i < 2 ? ["T"] : ["S"] }), { trailPenalty: 0.5 }, (c) => c.trailIds?.[0], true],
    ];
    const zero = { authorPenalty: 0, kindPenalty: 0 };
    for (const [axis, key, mag, keyOf, flips] of cases) {
      const ranked = rank(trio(key), { ...zero, ...mag, recordAxisEvidence: true });
      if (flips) assert.deepEqual(ranked.map((s) => s.candidate.id), ["a1", "b", "a2"], `${axis}: the repeat is pushed down`);
      let charged = 0;
      ranked.forEach((s, i) => {
        const e = diversityAxisEvidence(s)!;
        const repeats = ranked.slice(Math.max(0, i - 3), i).filter((r) => keyOf(r.candidate) === keyOf(s.candidate)).length;
        assert.equal(e[axis], 0.5 * repeats, `${axis}: ${s.candidate.id} is charged once per repeat`);
        assert.equal(e.total, e[axis], `${axis}: ${s.candidate.id} is charged on no other axis`);
        charged += e[axis];
      });
      assert.equal(charged, 0.5, `${axis}: exactly one repeat in the trio`);
    }
    const hist = rank(trio((c) => (c.id === "a1" ? { ...c, servedCount: 2 } : c)), { kindPenalty: 0, historyPenalty: 0.2, recordAxisEvidence: true });
    const a1 = diversityAxisEvidence(hist.find((s) => s.candidate.id === "a1")!)!;
    assert.ok(Math.abs(a1.history - 0.4) < 1e-12 && Math.abs(a1.total - 0.4) < 1e-12, "history: twice served at 0.2");
    assert.equal(hist.at(-1)!.candidate.id, "a1");
  });

  it("D9 the window axes sum to repetitionPenalty, and total to all six, on a random world", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const cands: RankCandidate[] = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, kind: pick(["place", "event", "post"]) as RankCandidate["kind"], createdAt: new Date(NOW - rnd() * 48 * H).toISOString(),
      authorId: pick(["a", "b", "c", undefined]), placeId: pick(["p1", "p2", undefined]), neighborhood: pick(["Alfama", "Baixa", undefined]),
      trailIds: pick([["T1"], ["T2"], ["T1", "T2"], undefined]), servedCount: pick([0, 1, 4, undefined]),
    }));
    const opts = { authorPenalty: 0.35, kindPenalty: 0.15, placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 3, window: 3 };
    const ranked = rank(cands, { ...opts, recordAxisEvidence: true });
    const pen = { author: 0.35, kind: 0.15, place: 0.35, geo: 0.15, trail: 0.25, history: 0.15, historyMaxServes: 3 } as any;
    let fired = new Set<string>();
    ranked.forEach((s, i) => {
      const e = diversityAxisEvidence(s)!;
      const recent = ranked.slice(Math.max(0, i - 3), i).map((r) => r.candidate);
      const window = recent.reduce((n, r) => n + repetitionPenalty(s.candidate, r, pen), 0);
      assert.ok(Math.abs(e.creator + e.contentType + e.place + e.geography + e.trail - window) < 1e-12, `${s.candidate.id}: window axes`);
      assert.ok(Math.abs(e.total - (window + e.history)) < 1e-12, `${s.candidate.id}: total`);
      assert.equal(e.diversifiedRank, i);
      for (const k of ["creator", "contentType", "place", "geography", "trail", "history"] as const) if (e[k] > 0) fired.add(k);
    });
    assert.deepEqual([...fired].sort(), ["contentType", "creator", "geography", "history", "place", "trail"], "the world exercises all six");
  });

  it("D10 scoreRank and diversifiedRank say when the re-rank moved a row", () => {
    const ranked = rank(trio((c, i) => ({ ...c, placeId: i < 2 ? "P" : "Q" })), { kindPenalty: 0, placePenalty: 0.5, recordAxisEvidence: true });
    const at = (id: string) => diversityAxisEvidence(ranked.find((s) => s.candidate.id === id)!)!;
    assert.deepEqual([at("a1").scoreRank, at("a1").diversifiedRank], [0, 0]);
    assert.deepEqual([at("a2").scoreRank, at("a2").diversifiedRank], [1, 2], "a2 scored second and was served third");
    assert.deepEqual([at("b").scoreRank, at("b").diversifiedRank], [2, 1]);
  });

  it("D11 the 3454 path asks for the record, and the record's key is classified record_metadata", () => {
    assert.equal(diversityOptionsFrom(parseDiversityMagnitudes(null)).recordAxisEvidence, true);
    assert.equal(DISCOVERY_FEATURE_KEY_CLASSES["diversityAxes"], "record_metadata");
  });

  it("D12 through rankForViewer: 3454 ON ⇒ every scored row's logged record carries diversityAxes; OFF ⇒ none", async () => {
    const places: PdePlace[] = [
      { id: "node/1", category: "food", neighborhood: "Alfama", savedCount: 9, distanceKm: 1 },
      { id: "node/2", category: "food", neighborhood: "Alfama", savedCount: 8, distanceKm: 1 },
      { id: "node/3", category: "food", neighborhood: "Baixa", savedCount: 1, distanceKm: 1 },
    ] as any;
    const viewer = { userId: V, city: "lisbon", followedIds: new Set(), interestTags: new Set(), seenIds: new Set(), placeAffinities: {}, degraded: [], neighborhood: null } as any;
    async function run(on: boolean | null) {
      invalidateRankDesignFlagCache(); invalidateDiscoveryModifiersFlagCache();
      const flags = on === null ? [] : [{ ...flagRow("discovery_diversity_axes_enabled", on), metadata: { placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 3, historyWindowDays: 7 } }];   // 3454's seeded metadata
      const db = makeFakeCandidateDb({ feature_flags: flags, rank_events: [], content_trails: [] });
      return rankForViewer(places, viewer, { sc: db, served: false });
    }
    const on = await run(true);
    const rows = [...on.scoredById.values()] as ScoredCandidate[];
    assert.equal(rows.length, 3, "precondition: three rows ranked");
    for (const s of rows) {
      const f = pdeFeatureProvenanceFeatures(s) as Record<string, any>;
      assert.ok(f.diversityAxes, `${s.candidate.id}: ${JSON.stringify(f)}`);
      for (const k of ["creator", "contentType", "place", "geography", "trail", "history", "total", "scoreRank", "diversifiedRank", "window"]) assert.equal(typeof f.diversityAxes[k], "number", `${s.candidate.id}.${k}`);
    }
    assert.ok(rows.some((s) => (pdeFeatureProvenanceFeatures(s) as any).diversityAxes.geography > 0), "the two Alfama rows: the geography axis charged the second");
    for (const off of [false, null]) {
      const o = await run(off);
      for (const s of o.scoredById.values()) assert.ok(!("diversityAxes" in pdeFeatureProvenanceFeatures(s)), `flag ${off}: ${s.candidate.id}`);
    }
  });
});
