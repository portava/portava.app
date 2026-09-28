/**
 * discoveryTrendPostConvergence.test.ts — census-discovery DV-34 (§95, lane
 * W11-X3; register D-W11X3-2; work item W11A-B9): "visitors post afterward",
 * one of `03` §6's five convergence signals, read only from PUBLISHED, PUBLIC
 * Memories, aggregated, k-floored at 2 distinct authors, and fed into the v2
 * classifier's convergence input (the window's independent-group count) behind
 * `discovery_trend_post_convergence_enabled` (3496, seeded FALSE).
 *
 *   P0  byte-identity: no option ⇒ §84's reading; the loader with the flag OFF
 *       reads no Memory and returns the same trends as a world with no flag row
 *   P1  two NEW authors who posted publicly after their own positive outcome
 *       lift a place from `unknown` (2 groups) to a reading (4 groups)
 *   P2  a private, draft or removed Memory changes nothing
 *   P3  authors already among the window's activity actors add nothing
 *   P4  one new author is below the k-floor; one author posting twice is one author
 *   P5  a post BEFORE the author's own positive outcome is not "afterward"
 *   P6  two new authors posting in lockstep are one independent group (Sensing's clustering)
 *   P7  an unreadable Memory set adds nothing and says `unread`
 *   P8  the loader reads `memories` only with state = published AND visibility = public
 *   P9  no author id leaves the computation: the reading carries counts only
 *   P10 the circles/crews/visits legs (AR-W11A-2) are not read by this leg
 *
 * Controlled data only. Nothing here claims real-world effectiveness.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTrendStatesV2, TREND_V2_RECENT_MS, TREND_V2_MID_MS, TREND_V2_PRIOR_MS, TREND_V2_MIN_GROUPS,
  type TrendRowV2,
} from "../lib/discoveryTrendNormalised.js";
import {
  postAfterVisitAuthors, loadPublicMemoriesAtPlaces, POST_CONVERGENCE_MIN_AUTHORS, type PublicMemoryRow,
} from "../lib/discoveryTrendPostConvergence.js";
import { loadLocalMomentum, readLocalTrendStates } from "../lib/discoveryLocalMomentum.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const H = 3_600_000;
const PLACE = "7a7a7a7a-0000-4000-8000-000000000001";
const ITEM = `db/${PLACE}`;
const WINDOWS = { recentMs: TREND_V2_RECENT_MS, midMs: TREND_V2_MID_MS, priorMs: TREND_V2_PRIOR_MS };
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * 40 recent impressions (a reading's exposure floor is 30), two recent savers
 * (2 groups: below TREND_V2_MIN_GROUPS = 3, so `unknown`), and two travellers
 * b1, b2 whose positive outcome was in the MID window (so they are not recent
 * activity actors), plus a few mid impressions.
 */
function world(): TrendRowV2[] {
  const rows: TrendRowV2[] = [];
  for (let i = 0; i < 40; i++) rows.push({ item_id: ITEM, outcome: "impression", served_at: iso(NOW - 2 * H - i * 60_000), user_id: `u${i}` });
  rows.push({ item_id: ITEM, outcome: "save", served_at: iso(NOW - 30 * H), outcome_at: iso(NOW - 29 * H), user_id: "a1" });
  rows.push({ item_id: ITEM, outcome: "save", served_at: iso(NOW - 20 * H), outcome_at: iso(NOW - 19 * H), user_id: "a2" });
  rows.push({ item_id: ITEM, outcome: "click", served_at: iso(NOW - 100 * H), outcome_at: iso(NOW - 99 * H), user_id: "b1" });
  rows.push({ item_id: ITEM, outcome: "trip_add", served_at: iso(NOW - 90 * H), outcome_at: iso(NOW - 89 * H), user_id: "b2" });
  return rows;
}

const mem = (owner: string, atMs: number, over: Partial<PublicMemoryRow> = {}): PublicMemoryRow =>
  ({ owner_id: owner, place_id: PLACE, created_at: iso(atMs), state: "published", visibility: "public", ...over });

function read(rows: TrendRowV2[], memories: PublicMemoryRow[] | null) {
  const post = memories === null ? { status: "unread" as const } : postAfterVisitAuthors(rows, memories, NOW, WINDOWS);
  return computeTrendStatesV2(rows, NOW, { postAfterVisit: post })[ITEM]!;
}

describe("P — visitors post afterward", () => {
  it("P0 byte-identity: with no option the reading is §84's (the controlled world is `unknown`, 2 groups)", () => {
    const rows = world();
    const base = computeTrendStatesV2(rows, NOW, {});
    assert.equal(JSON.stringify(computeTrendStatesV2(rows, NOW, { postAfterVisit: undefined })), JSON.stringify(base));
    assert.equal(base[ITEM]!.state, "unknown");
    assert.equal(base[ITEM]!.evidence.recentGroups, 2);
    assert.ok(!("postConvergence" in base[ITEM]!.evidence), "no key, not even undefined");
  });

  it("P1 two new authors who posted publicly after their own outcome lift `unknown` to a reading", () => {
    const got = read(world(), [mem("b1", NOW - 10 * H), mem("b2", NOW - 5 * H)]);
    assert.equal(got.evidence.recentGroups, 4);
    assert.ok(got.evidence.recentGroups >= TREND_V2_MIN_GROUPS);
    assert.equal(got.state, "emerging");
    assert.deepEqual(got.evidence.postConvergence, { status: "ok", recentGroups: 2, midGroups: 0, priorGroups: 0 });
    // Activity, exposure and the rate are untouched: only convergence moved.
    const base = computeTrendStatesV2(world(), NOW, {})[ITEM]!;
    assert.equal(got.evidence.recentRate, base.evidence.recentRate);
    assert.equal(got.evidence.recentExposures, base.evidence.recentExposures);
    assert.equal(got.evidence.totalWeight, base.evidence.totalWeight);
  });

  it("P2 a private, draft or removed Memory changes nothing", () => {
    const base = computeTrendStatesV2(world(), NOW, {})[ITEM]!;
    for (const over of [
      { visibility: "friends_only" }, { visibility: "trip_crew" }, { visibility: "circle_only" }, { visibility: "only_me" }, { visibility: "custom" },
      { state: "draft" }, { state: "archived" }, { state: "removed" },
    ] as Array<Partial<PublicMemoryRow>>) {
      const got = read(world(), [mem("b1", NOW - 10 * H, over), mem("b2", NOW - 5 * H, over)]);
      assert.equal(got.state, base.state, JSON.stringify(over));
      assert.equal(got.evidence.recentGroups, 2, JSON.stringify(over));
      assert.deepEqual(got.evidence.postConvergence, { status: "ok", recentGroups: 0, midGroups: 0, priorGroups: 0 });
    }
  });

  it("P3 authors already among the window's activity actors add nothing", () => {
    const got = read(world(), [mem("a1", NOW - 10 * H), mem("a2", NOW - 5 * H)]);
    assert.equal(got.evidence.recentGroups, 2);
    assert.equal(got.state, "unknown");
  });

  it("P4 one new author is below the k-floor; one author posting twice is one author", () => {
    assert.equal(POST_CONVERGENCE_MIN_AUTHORS, 2);
    assert.equal(read(world(), [mem("b1", NOW - 10 * H)]).evidence.recentGroups, 2);
    assert.equal(read(world(), [mem("b1", NOW - 10 * H), mem("b1", NOW - 3 * H)]).evidence.recentGroups, 2);
    // The floor holds in the input itself, before any window meets the classifier: one author yields no entry.
    const single = postAfterVisitAuthors(world(), [mem("b1", NOW - 10 * H), mem("b1", NOW - 3 * H)], NOW, WINDOWS);
    assert.equal(single.status === "ok" ? single.byKey.size : -1, 0);
    // A new author plus an existing actor: only one NEW author — still below the floor.
    assert.equal(read(world(), [mem("b1", NOW - 10 * H), mem("a1", NOW - 3 * H)]).evidence.recentGroups, 2);
  });

  it("P5 a post before the author's own positive outcome is not 'afterward'", () => {
    // b1 visited in the PRIOR window and posted in MID; b2 posted in MID but its
    // own outcome came later (RECENT). Neither is a mid activity actor, so only
    // the "afterward" rule keeps b2 out — and b1 alone is below the floor.
    const rows = world().map((r) => (r.user_id === "b1" ? { ...r, served_at: iso(NOW - 201 * H), outcome_at: iso(NOW - 200 * H) }
      : r.user_id === "b2" ? { ...r, served_at: iso(NOW - 6 * H), outcome_at: iso(NOW - 4 * H) } : r));
    const got = read(rows, [mem("b1", NOW - 60 * H), mem("b2", NOW - 55 * H)]);
    assert.deepEqual(got.evidence.postConvergence, { status: "ok", recentGroups: 0, midGroups: 0, priorGroups: 0 });
    // Control: with b2's outcome BEFORE its post (still outside mid), b2 qualifies and mid gains a group.
    const control = world().map((r) => (r.user_id === "b1" ? { ...r, served_at: iso(NOW - 201 * H), outcome_at: iso(NOW - 200 * H) }
      : r.user_id === "b2" ? { ...r, served_at: iso(NOW - 191 * H), outcome_at: iso(NOW - 190 * H) } : r));
    assert.equal((read(control, [mem("b1", NOW - 60 * H), mem("b2", NOW - 55 * H)]).evidence.postConvergence as { midGroups: number }).midGroups, 2);
  });

  it("P6 two new authors posting in lockstep are ONE independent group", () => {
    const got = read(world(), [mem("b1", NOW - 5 * H), mem("b2", NOW - 5 * H + 10_000)]);
    assert.deepEqual(got.evidence.postConvergence, { status: "ok", recentGroups: 1, midGroups: 0, priorGroups: 0 });
    assert.equal(got.evidence.recentGroups, 3);
  });

  it("P7 an unreadable Memory set adds nothing and says `unread`", () => {
    const got = read(world(), null);
    assert.equal(got.evidence.recentGroups, 2);
    assert.equal(got.state, "unknown");
    assert.deepEqual(got.evidence.postConvergence, { status: "unread" });
  });

  it("P8 the loader reads memories with state = published AND visibility = public; a failed or full read is null", async () => {
    const seen: Array<[string, unknown]> = [];
    const client = (data: unknown, error: unknown = null) => ({
      from(table: string) {
        seen.push(["from", table]);
        const q: any = {
          select(c: string) { seen.push(["select", c]); return q; },
          in(c: string, v: unknown) { seen.push([`in:${c}`, v]); return q; },
          eq(c: string, v: unknown) { seen.push([`eq:${c}`, v]); return q; },
          gte(c: string, v: unknown) { seen.push([`gte:${c}`, v]); return q; },
          order() { return q; },
          limit(n: number) { seen.push(["limit", n]); return Promise.resolve({ data, error }); },
        };
        return q;
      },
    });
    const rows = [mem("b1", NOW - H)];
    assert.deepEqual(await loadPublicMemoriesAtPlaces(client(rows), [ITEM, `db/${PLACE.toUpperCase()}`], iso(NOW - TREND_V2_PRIOR_MS)), rows);
    assert.deepEqual(seen.filter(([k]) => k.startsWith("eq:")), [["eq:state", "published"], ["eq:visibility", "public"]]);
    assert.deepEqual(seen.find(([k]) => k === "in:place_id"), ["in:place_id", [PLACE]]);
    assert.equal(await loadPublicMemoriesAtPlaces(client(null, { code: "42P01" }), [ITEM], iso(NOW)), null);
    assert.equal(await loadPublicMemoriesAtPlaces(client(new Array(1000).fill(rows[0])), [ITEM], iso(NOW)), null);
  });

  it("P9 no author id leaves the computation: the reading carries counts only", () => {
    const got = read(world(), [mem("b1", NOW - 10 * H), mem("b2", NOW - 5 * H)]);
    const text = JSON.stringify(got);
    for (const who of ["b1", "b2", "a1", "a2"]) assert.ok(!text.includes(`"${who}"`), who);
  });

  it("P10 this leg reads no circle, crew, check-in or stamp (AR-W11A-2's legs)", () => {
    const src = readFileSync(resolve(__dir, "../lib/discoveryTrendPostConvergence.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    for (const t of ["circle", "crew", "trip_members", "checkin", "passport_stamps", "plan_checkins"]) assert.ok(!src.includes(t), t);
    const froms = [...src.matchAll(/\.from\("([a-z_]+)"\)/g)].map((m) => m[1]);
    assert.deepEqual(froms, ["memories"]);
  });
});

describe("L — the loader: OFF is §84 byte for byte", () => {
  function fakeSc(flags: Record<string, boolean>, rows: TrendRowV2[], memories: PublicMemoryRow[]) {
    const tables: string[] = [];
    const sc = {
      from(table: string) {
        tables.push(table);
        const filt: Array<[string, string, unknown]> = [];
        const q: any = {
          select() { return q; }, neq() { return q; }, in(c: string, v: unknown) { filt.push(["in", c, v]); return q; },
          gte() { return q; }, order() { return q; }, is() { return q; },
          eq(c: string, v: unknown) { filt.push(["eq", c, v]); return q; },
          maybeSingle() {
            const flag = filt.find(([, c]) => c === "flag")?.[2] as string;
            return Promise.resolve({ data: flag in flags ? { enabled: flags[flag] } : null, error: null });
          },
          range() { return Promise.resolve({ data: table === "rank_events" ? rows : [], error: null }); },
          limit() { return Promise.resolve({ data: table === "memories" ? memories : [], error: null }); },
          then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
            const data = table === "discovery_places" ? [{ id: PLACE }] : [];
            return Promise.resolve({ data, error: null }).then(res, rej);
          },
        };
        return q;
      },
    };
    return { sc, tables };
  }

  it("L1 flag OFF (and absent): no Memory is read, and the trends equal a world without the flag row", async () => {
    const memories = [mem("b1", NOW - 10 * H), mem("b2", NOW - 5 * H)];
    const absent = fakeSc({ discovery_trend_normalised_enabled: true }, world(), memories);
    await loadLocalMomentum(absent.sc, [ITEM], { cacheKey: "w11x3-L1-absent", nowMs: NOW });
    const off = fakeSc({ discovery_trend_normalised_enabled: true, discovery_trend_post_convergence_enabled: false }, world(), memories);
    await loadLocalMomentum(off.sc, [ITEM], { cacheKey: "w11x3-L1-off", nowMs: NOW });
    assert.ok(!absent.tables.includes("memories") && !off.tables.includes("memories"));
    const a = readLocalTrendStates("w11x3-L1-absent", NOW), o = readLocalTrendStates("w11x3-L1-off", NOW);
    assert.ok(a[ITEM], "the controlled world produced a reading");
    assert.equal(JSON.stringify(o), JSON.stringify(a));
    assert.ok(!("postConvergence" in (a[ITEM]!.evidence as object)));
  });

  it("L2 flag ON with v2: the Memory read happens and the classifier's convergence moves", async () => {
    const on = fakeSc({ discovery_trend_normalised_enabled: true, discovery_trend_post_convergence_enabled: true }, world(), [mem("b1", NOW - 10 * H), mem("b2", NOW - 5 * H)]);
    await loadLocalMomentum(on.sc, [ITEM], { cacheKey: "w11x3-L2", nowMs: NOW });
    assert.ok(on.tables.includes("memories"));
    const t = readLocalTrendStates("w11x3-L2", NOW)[ITEM]!;
    assert.equal(t.state, "emerging");
    assert.deepEqual((t.evidence as { postConvergence?: unknown }).postConvergence, { status: "ok", recentGroups: 2, midGroups: 0, priorGroups: 0 });
  });

  it("L3 v2 OFF: the post flag is not even read", async () => {
    const f = fakeSc({ discovery_trend_normalised_enabled: false, discovery_trend_post_convergence_enabled: true }, world(), [mem("b1", NOW - 10 * H), mem("b2", NOW - 5 * H)]);
    await loadLocalMomentum(f.sc, [ITEM], { cacheKey: "w11x3-L3", nowMs: NOW });
    assert.ok(!f.tables.includes("memories"));
  });
});
