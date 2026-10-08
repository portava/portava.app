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
    assert.deepEqual(diversityOptionsFrom(m), { placePenalty: 0.35, geoPenalty: 0.15, trailPenalty: 0.25, historyPenalty: 0.15, historyMaxServes: 4 });
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
