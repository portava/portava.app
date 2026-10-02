/**
 * discoveryTrendPostConvergenceStored.db.test.ts — census-discovery DV-34
 * (§95.9, lane W11-X3; register D-W11X3-2, D-W11X3-5), against PostgreSQL 16
 * with 3475–3477 and 3495–3497 applied.
 *
 * 3497 re-creates `rebuild_place_momentum_v2` so the STORED trend rows carry
 * "visitors post afterward", the leg lib/discoveryTrendPostConvergence gives the
 * in-process classifier. This suite executes the rebuild over a controlled
 * corpus and holds every stored place row equal to the TypeScript over the
 * loader's own rank_events rows and the loader's own Memory rows:
 *
 *   S0  flag OFF: the rows equal what 3477's own function writes at the same
 *       instant (3497's rollback restores it inside a rolled-back
 *       transaction), and equal a run with no Memory at all — the leg is inert
 *   S1  flag OFF: the helper is never executed (a raising helper, swapped in
 *       inside a rolled-back transaction, is not reached); ON, it is
 *   S2  flag ON: every stored place row equals computeTrendStates(…, { model:
 *       "v2", context, postAfterVisit }): state, lifecycle, driver, rates,
 *       exposures, the augmented groups, velocity, factors, travellers, the
 *       sentence, and the post feature version
 *   S3  the designed cases: two new public authors lift `unknown`; private,
 *       draft and removed Memories, existing actors, one author, a post before
 *       the visit add nothing; lockstep authors are one cluster; a mid-window
 *       leg gives a place its history
 *   S4  only counts are stored: no author id in any stored row or in the helper's output
 *   S5  3497's rollback refuses while the flag is ON, restores 3477 while OFF,
 *       and 3497 re-applies to the same rows
 *
 * Controlled data on the harness only: no production claim.
 * Rows are timed in March 2032 so no other suite's rows enter a window.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HAVE_DB, exec, rows, scalar, psql, seedUser, deleteUser } from "./localDb.js";
import {
  computeTrendStates, explainTrendReading, TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2,
  TREND_FEATURE_VERSION_V2_POST, TREND_PRIOR_MS,
} from "../../lib/discoveryTrendState.js";
import type { MomentumRow } from "../../lib/discoveryLocalMomentum.js";
import {
  buildPlaceTrendContext, TREND_V2_RECENT_MS, TREND_V2_MID_MS, TREND_V2_PRIOR_MS,
  type ContextPlaceRow, type ContextMembershipRow, type TrendRowV2,
} from "../../lib/discoveryTrendNormalised.js";
import { postAfterVisitAuthors, type PublicMemoryRow } from "../../lib/discoveryTrendPostConvergence.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIG_3497 = resolve(__dir, "../../migrations/3497_discovery_trend_post_convergence_stored.sql");
const RB_3497 = resolve(__dir, "../../../../../db/rollback/2026-09-28-3497-discovery-trend-post-convergence-stored-rollback.sql");

const P_NOW = "2032-03-15T00:00:00.000Z";
const NOW_MS = Date.parse(P_NOW);
const HOUR = 3_600_000;
const TAG = `w11x3${randomUUID().slice(0, 6)}`;
const CITY = `${TAG}city`;
const WINDOWS = { recentMs: TREND_V2_RECENT_MS, midMs: TREND_V2_MID_MS, priorMs: TREND_V2_PRIOR_MS };
const ts = (msAgo: number) => `'${new Date(NOW_MS - msAgo).toISOString()}'::timestamptz`;

const users: Record<string, string> = {};   // label → uuid
const places: Record<string, string> = {};  // label → discovery_places uuid
const item = (p: string) => `db/${places[p]}`;
type Ev = { u: string; p: string; o: string; sH: number; oH?: number | null };
const EV: Ev[] = [];
type Mem = { u: string; p: string; aH: number; state?: string; vis?: string; upper?: boolean };
const MEM: Mem[] = [];

/** n impressions served over [fromH, fromH + n·0.5) hours ago, each by an impression-only user. */
const imps = (p: string, n: number, fromH: number) => { for (let i = 0; i < n; i++) EV.push({ u: `i${i % 20}`, p, o: "impression", sH: fromH + i * 0.5 }); };
const act = (u: string, p: string, o: string, atH: number) => EV.push({ u, p, o, sH: atH + 0.1, oH: atH });
const mem = (u: string, p: string, aH: number, over: Partial<Mem> = {}) => MEM.push({ u, p, aH, ...over });

const flags = (normalised: boolean, post: boolean) => exec(
  `UPDATE public.feature_flags SET enabled = ${normalised} WHERE flag = 'discovery_trend_normalised_enabled';
   UPDATE public.feature_flags SET enabled = ${post} WHERE flag = 'discovery_trend_post_convergence_enabled';`);
const rebuildAt = (iso: string) => `SELECT public.rebuild_place_momentum('${iso}'::timestamptz);`;
const rebuild = () => exec(`SET LOCAL ROLE service_role;\n${rebuildAt(P_NOW)}`, { single: true });

function unwrapped(path: string): string {
  const sql = readFileSync(path, "utf8");
  const begin = sql.search(/^BEGIN;\s*$/m);
  const commit = sql.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, `${path}: no BEGIN … COMMIT wrapper`);
  return sql.slice(sql.indexOf("\n", begin) + 1, commit) + "\n" + sql.slice(commit + "\nCOMMIT;".length);
}

const inList = (xs: string[]) => xs.map((x) => `'${x}'`).join(",");
const MINE = () => Object.keys(places).map(item);
const storedAt = (iso: string) => rows<Record<string, any>>(
  `SELECT * FROM public.place_momentum WHERE computed_at = '${iso}'::timestamptz AND place_id IN (${inList(MINE())}) ORDER BY place_id`);
const snapAt = (iso: string) =>
  `SELECT 'SNAP' || COALESCE(json_agg(to_jsonb(p) - 'id' - 'created_at' ORDER BY p.place_id), '[]'::json)::text FROM public.place_momentum p
    WHERE computed_at = '${iso}'::timestamptz AND place_id IN (${inList(MINE())});`;
const loaderRows = () => rows<MomentumRow>(
  `SELECT item_id, outcome, served_at, outcome_at, user_id FROM public.rank_events
    WHERE surface = 'discovery' AND outcome <> 'analytics' AND item_id IN (${inList(MINE())})
      AND served_at >= '${new Date(NOW_MS - TREND_PRIOR_MS).toISOString()}'::timestamptz`);
/** lib/discoveryTrendPostConvergence.loadPublicMemoriesAtPlaces' read, in SQL. */
const loaderMemories = () => rows<PublicMemoryRow>(
  `SELECT owner_id::text, place_id, created_at, state, visibility FROM public.memories
    WHERE place_id IN (${inList(Object.values(places))}) AND state = 'published' AND visibility = 'public'
      AND created_at >= '${new Date(NOW_MS - TREND_PRIOR_MS).toISOString()}'::timestamptz`);
const contextRows = () => ({
  places: rows<ContextPlaceRow>(`SELECT id::text, submitted_by::text, city, neighborhood, lat, lng, created_at, category, place_type FROM public.discovery_places WHERE city = '${CITY}'`),
  members: [] as ContextMembershipRow[],
});
const close = (a: unknown, b: number | null) =>
  b === null ? a === null : typeof a === "number" && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b));

describe("census-discovery §95.9 — the stored rebuild carries the post-after-visit leg exactly as the TS does", { skip: !HAVE_DB }, () => {
  before(() => {
    assert.equal(scalar("SELECT to_regprocedure('public.discovery_trend_post_groups_v2(timestamptz)') IS NOT NULL;"), "t", "3497 must be applied");
    for (const l of ["i", "a1", "a2", "a3", "b1", "b2", "b3", "b4", "c1", "c2", "d1", "d2"]) {
      if (l === "i") { for (let k = 0; k < 20; k++) users[`i${k}`] = seedUser(`${TAG}i${k}`); continue; }
      users[l] = seedUser(`${TAG}${l}`);
    }
    for (const [k, lat] of [["PA", 1], ["PB", 2], ["PC", 3], ["PD", 4], ["PE", 5], ["PF", 6], ["PG", 7], ["PH", 8], ["PI", 9]] as const) {
      places[k] = randomUUID();
      exec(`INSERT INTO public.discovery_places (id, city, name, place_type, category, lat, lng, created_at)
            VALUES ('${places[k]}', '${CITY}', '${TAG} ${k}', 'venue', 'cafe', ${-70 - lat / 10}, ${160 + lat / 10}, ${ts(2000 * HOUR)});`);
    }
    // Every place: 40 recent impressions and two recent savers a1, a2 → 2 groups: `unknown` on its own.
    for (const p of ["PA", "PB", "PC", "PD", "PE", "PF", "PH", "PI"]) { imps(p, 40, 1); act("a1", p, "save", 3); act("a2", p, "save", 6); }
    // b1, b2 (and c1, c2) visited in the MID window, so they are not recent activity actors.
    for (const p of ["PA", "PB", "PC", "PD", "PE", "PF", "PH", "PI"]) { act("b1", p, "tap", 100); act("b2", p, "trip_add", 90); }
    // PA: two new public authors → +2 → 4 groups: emerging.
    mem("b1", "PA", 10); mem("b2", "PA", 5);
    // PB: the same two, published but private (friends_only, circle_only, only_me) → nothing.
    mem("b1", "PB", 10, { vis: "friends_only" }); mem("b2", "PB", 5, { vis: "circle_only" }); mem("b1", "PB", 3, { vis: "only_me" });
    // PI: the same two, public but not published (draft, removed, archived) → nothing.
    mem("b1", "PI", 10, { state: "draft" }); mem("b2", "PI", 5, { state: "removed" }); mem("b2", "PI", 4, { state: "archived" });
    // PC: two new public authors posting 10 s apart → one cluster → 3 groups: emerging.
    mem("b1", "PC", 5); MEM.push({ u: "b2", p: "PC", aH: 5 - 10 / 3600 });
    // PD: the posters are the recent savers themselves → nothing.
    mem("a1", "PD", 2); mem("a2", "PD", 1);
    // PE: one author, twice → below the floor.
    mem("b1", "PE", 10); mem("b1", "PE", 2);
    // …and b2 at PE under an UPPER-CASE place id: the loader's `.in("place_id", keys)` does not match it, so neither does 3497.
    mem("b2", "PE", 4, { upper: true });
    // PF: b2 and b3 posted in the PRIOR window, BEFORE their mid-window visits, and are not prior actors:
    // only "afterward" keeps them out of the prior window. b1 alone in recent → nothing.
    act("b3", "PF", "tap", 100); mem("b1", "PF", 10); mem("b2", "PF", 200); mem("b3", "PF", 210);
    // PH: an existing actor and one new author → one NEW author, below the second floor.
    mem("a1", "PH", 2); mem("b1", "PH", 10);
    // PG: history made by the leg. Recent: 40 imp + 3 taps (a1..a3). Mid: 40 imp + 2 taps (c1, c2) and two
    // travellers who visited in the PRIOR window posting publicly in MID → mid 4 groups → a reading.
    imps("PG", 40, 1); act("a1", "PG", "tap", 3); act("a2", "PG", "tap", 6); act("a3", "PG", "tap", 9);
    imps("PG", 40, 60); act("c1", "PG", "tap", 70); act("c2", "PG", "tap", 80);
    act("d1", "PG", "tap", 300); act("d2", "PG", "save", 320);
    mem("d1", "PG", 100); mem("d2", "PG", 110);

    const values = EV.map((e) =>
      `('${users[e.u]}', '${item(e.p)}', 'discovery', '${e.o}', ${ts(e.sH * HOUR)}, ${e.oH == null ? "NULL" : ts(e.oH * HOUR)})`);
    for (let i = 0; i < values.length; i += 500) {
      exec(`INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${values.slice(i, i + 500).join(",\n")};`);
    }
    exec(`INSERT INTO public.memories (owner_id, place_id, state, visibility, created_at) VALUES ${MEM.map((m) =>
      `('${users[m.u]}', '${m.upper ? places[m.p]!.toUpperCase() : places[m.p]}', '${m.state ?? "published"}', '${m.vis ?? "public"}', ${ts(m.aH * HOUR)})`).join(",\n")};`);
    flags(true, true);
    rebuild();
  });

  after(() => {
    flags(false, false);
    exec(`DELETE FROM public.place_momentum WHERE computed_at >= '${P_NOW}'::timestamptz AND place_id IN (${inList(MINE())});
          DELETE FROM public.discovery_places WHERE city = '${CITY}';`);
    for (const u of Object.values(users)) deleteUser(u);   // cascades rank_events and memories
  });

  it("S0. flag OFF: the rows are 3477's own, and a run with every Memory removed is the same", () => {
    const at = new Date(NOW_MS + 1_000).toISOString();
    flags(true, false);
    try {
      const out = exec(`BEGIN;
${rebuildAt(at)}
${snapAt(at)}
DELETE FROM public.place_momentum WHERE computed_at = '${at}'::timestamptz;
DELETE FROM public.memories WHERE owner_id IN (${inList(Object.values(users))});
${rebuildAt(at)}
${snapAt(at)}
DELETE FROM public.place_momentum WHERE computed_at = '${at}'::timestamptz;
${unwrapped(RB_3497)}
${rebuildAt(at)}
${snapAt(at)}
ROLLBACK;`).filter((l) => l.startsWith("SNAP")).map((l) => JSON.parse(l.slice(4)) as Array<Record<string, unknown>>);
      assert.equal(out.length, 3);
      const [off, noMemories, by3477] = out as [Array<Record<string, unknown>>, Array<Record<string, unknown>>, Array<Record<string, unknown>>];
      assert.equal(off.length, Object.keys(places).length, "not vacuous");
      assert.deepEqual(off, by3477, "flag OFF, 3497 moved a value 3477 writes");
      assert.deepEqual(off, noMemories, "flag OFF, a Memory changed a stored row");
      for (const r of off) assert.equal(r["feature_version"], TREND_FEATURE_VERSION_V2);
    } finally { flags(true, true); }
  });

  it("S1. flag OFF the helper never runs; ON it does", () => {
    const raising = `CREATE OR REPLACE FUNCTION public.discovery_trend_post_groups_v2(p_now timestamptz)
RETURNS TABLE (o_key text, o_win text, o_added integer) LANGUAGE plpgsql AS $x$ BEGIN RAISE EXCEPTION 'W11X3_HELPER_RAN'; END $x$;`;
    const at = `'${new Date(NOW_MS + 2_000).toISOString()}'::timestamptz`;
    const run = (post: boolean) => psql(`BEGIN;
UPDATE public.feature_flags SET enabled = ${post} WHERE flag = 'discovery_trend_post_convergence_enabled';
${raising}
SELECT public.rebuild_place_momentum(${at});
ROLLBACK;`);
    const off = run(false);
    assert.equal(off.status, 0, off.stderr);
    const on = run(true);
    assert.notEqual(on.status, 0);
    assert.match(on.stderr, /W11X3_HELPER_RAN/);
  });

  it("S2. flag ON: every stored place row equals computeTrendStates(…, { model: 'v2', postAfterVisit })", () => {
    const lr = loaderRows();
    const { places: pr, members } = contextRows();
    const post = postAfterVisitAuthors(lr as readonly TrendRowV2[], loaderMemories(), NOW_MS, WINDOWS);
    const t = computeTrendStates(lr, NOW_MS, { model: "v2", context: buildPlaceTrendContext(pr, members), postAfterVisit: post });
    const sql = storedAt(P_NOW);
    assert.deepEqual(sql.map((r) => r.place_id).sort(), Object.keys(t).sort(), "the same places, no more, no fewer");
    for (const r of sql) {
      const x = t[r.place_id]!;
      const e = x.evidence as unknown as Record<string, number | null>;
      const where = `${r.place_id}`;
      assert.equal(r.trend_state, x.state, `${where} state`);
      assert.equal(r.lifecycle_state, x.lifecycle, `${where} lifecycle`);
      assert.equal(r.driver, x.driver, `${where} driver`);
      for (const [col, key] of [["recent_rate", "recentRate"], ["mid_rate", "midRate"], ["prior_rate", "priorRate"], ["total_weight", "totalWeight"],
        ["time_of_day_factor", "timeOfDayFactor"], ["peer_factor", "peerFactor"], ["velocity", "velocity"]] as const) {
        assert.ok(close(r[col], e[key] ?? null), `${where} ${col}: SQL ${r[col]} vs TS ${e[key]}`);
      }
      for (const [col, key] of [["recent_exposures", "recentExposures"], ["mid_exposures", "midExposures"], ["prior_exposures", "priorExposures"],
        ["recent_groups", "recentGroups"], ["mid_groups", "midGroups"], ["prior_groups", "priorGroups"],
        ["recent_unique_travelers", "recentTravelers"], ["window_unique_travelers", "windowTravelers"]] as const) {
        assert.equal(r[col], e[key], `${where} ${col}`);
      }
      assert.equal(r.reason, explainTrendReading(x.state, x.driver ?? null), `${where} sentence`);
      assert.equal(r.model_version, TREND_STATE_MODEL_VERSION_V2);
      assert.equal(r.feature_version, TREND_FEATURE_VERSION_V2_POST);
      assert.equal(r.feature_version, x.provenance.featureVersion);
      assert.equal(r.thresholds.post_min_authors, 2);
    }
  });

  it("S3. the designed cases", () => {
    const s = Object.fromEntries(storedAt(P_NOW).map((r) => [r.place_id, r]));
    const st = (p: string) => s[item(p)];
    assert.deepEqual([st("PA").recent_groups, st("PA").trend_state], [4, "emerging"], "two new public authors lift `unknown`");
    for (const p of ["PB", "PD", "PE", "PF", "PH", "PI"]) assert.deepEqual([p, st(p).recent_groups, st(p).trend_state], [p, 2, "unknown"]);
    assert.equal(st("PF").prior_groups, 0, "a post before the author's own visit is not 'afterward'");
    assert.deepEqual([st("PC").recent_groups, st("PC").trend_state], [3, "emerging"], "lockstep authors are one cluster");
    assert.equal(st("PG").mid_groups, 4, "the mid window gained the prior visitors' public posts");
    assert.ok(["trending", "established", "cooling"].includes(st("PG").trend_state), `PG has history now: ${st("PG").trend_state}`);
    // The same corpus with the flag OFF: PA and PG are not what the leg made them.
    const at = new Date(NOW_MS + 3_000).toISOString();
    const off = exec(`BEGIN;
UPDATE public.feature_flags SET enabled = false WHERE flag = 'discovery_trend_post_convergence_enabled';
${rebuildAt(at)}
${snapAt(at)}
ROLLBACK;`).filter((l) => l.startsWith("SNAP")).map((l) => JSON.parse(l.slice(4)) as Array<Record<string, any>>)[0]!;
    const o = Object.fromEntries(off.map((r) => [r["place_id"], r]));
    assert.equal(o[item("PA")]["trend_state"], "unknown");
    assert.equal(o[item("PG")]["trend_state"], "emerging", "without the leg PG has no mid reading");
  });

  it("S4. only counts are stored: no author id in any stored row or in the helper's output", () => {
    const text = JSON.stringify(storedAt(P_NOW)) + JSON.stringify(rows(`SELECT * FROM public.discovery_trend_post_groups_v2('${P_NOW}'::timestamptz)`));
    for (const [l, id] of Object.entries(users)) assert.ok(!text.includes(id), l);
    const cols = rows<{ c: string }>(`SELECT unnest(proargnames) AS c FROM pg_proc WHERE oid = 'public.discovery_trend_post_groups_v2(timestamptz)'::regprocedure`).map((r) => r.c);
    assert.deepEqual(cols, ["p_now", "o_key", "o_win", "o_added"]);
  });

  it("S5. 3497's rollback refuses while ON, restores 3477 while OFF, and 3497 re-applies to the same rows", () => {
    const values = () => JSON.stringify(storedAt(P_NOW).map(({ id: _i, created_at: _c, ...r }) => r));
    const before = values();
    const refused = psql(readFileSync(RB_3497, "utf8"));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ROLLBACK REFUSED \(3497\)/);
    flags(true, false);
    try {
      const rb = psql(readFileSync(RB_3497, "utf8"));
      assert.equal(rb.status, 0, rb.stderr);
      assert.equal(scalar("SELECT to_regprocedure('public.discovery_trend_post_groups_v2(timestamptz)') IS NULL;"), "t");
      const re = psql(readFileSync(MIG_3497, "utf8"));
      assert.equal(re.status, 0, re.stderr);
    } finally { flags(true, true); }
    exec(`DELETE FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND place_id IN (${inList(MINE())});`);
    rebuild();
    assert.equal(values(), before);
  });
});
