/**
 * census-discovery §93 (lane W11-X1) — H-W10T-1 (§86.9): a `suppressed`
 * trend integrity review on a PLACE takes effect in the trend classifier's
 * consumers, and an unreadable review fails closed (D-W10T-11, D-W11X1-5).
 *
 *   T1  the rule, on computed readings: suppressed → `unknown`, lifecycle
 *       `inactive`, no driver, no reason, not a retest pick; unread → the
 *       reading is removed; none → the same object; a reading that could
 *       publish nothing is not even asked about
 *   T2  the real reader (TrailService.readTrendReviewVerdict): the NEWEST
 *       review is in force (cleared lifts suppressed); a failed read is
 *       `unread`; 3486 absent is `none`
 *   T3  the served modifiers path: loadLocalMomentum's trend states and the
 *       rediscovery retest pool honour the review — a suppressed cooled place
 *       is never retested, an unread review drops it, and with no review the
 *       retest still picks it (control)
 *   T4  the trend API's stored rows (readLocatedRun, readTrendSnapshot): a
 *       suppressed place is `unknown` and no list names it; an unread review
 *       drops the row, never answering with the claim
 *
 * Controlled data; no production claim.
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryTrendReviewSuppression.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPlaceTrendReviews, applyPlaceTrendReviewsToRows, trendReasonFor,
  TREND_STATE_MODEL_VERSION_V2, TREND_FEATURE_VERSION_V2, TREND_PRIOR_MS, type TrendReading,
} from "../lib/discoveryTrendState.js";
import { isRetestCandidate, planRediscoveryRetest } from "../lib/discoveryTrendRediscovery.js";
import { loadLocalMomentum, readLocalTrendStates, _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import { readTrendReviewVerdict } from "../services/trails/TrailService.js";
import { readLocatedRun, readTrendSnapshot, orderLocated, TREND_DISCLOSURE_MIN_TRAVELERS } from "../lib/discoveryTrendExplanation.js";

type Row = Record<string, any>;
const NOW = Date.parse("2026-09-27T12:03:17Z");
const H = 3_600_000;

/** PostgREST-shaped fake: eq/neq/in/gte filters, order, range, limit; per-table faults. */
function makeDb(tables: Record<string, Row[]>, faults: { erroring?: string[]; missing?: string[]; throwing?: string[] } = {}) {
  const reads: string[] = [];
  function from(table: string) {
    if (faults.throwing?.includes(table)) throw new Error(`${table}: connection reset`);
    const filters: Array<(r: Row) => boolean> = [];
    let orders: Array<{ col: string; asc: boolean }> = [];
    let limitN: number | null = null; let range: [number, number] | null = null;
    const result = () => {
      reads.push(table);
      if (faults.missing?.includes(table)) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      if (faults.erroring?.includes(table)) return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
      let out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      for (const o of [...orders].reverse()) out = [...out].sort((a, b) => (String(a[o.col] ?? "") < String(b[o.col] ?? "") ? -1 : String(a[o.col] ?? "") > String(b[o.col] ?? "") ? 1 : 0) * (o.asc ? 1 : -1));
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: out.map((r) => ({ ...r })), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      order(c: string, o?: { ascending?: boolean }) { orders = [...orders, { col: c, asc: o?.ascending !== false }]; return b; },
      limit(n: number) { limitN = n; return b; },
      range(a: number, z: number) { range = [a, z]; return b; },
      maybeSingle() { const r = result(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      then(res: (r: any) => any, rej?: (e: any) => any) { return Promise.resolve(result()).then(res, rej); },
    };
    return b;
  }
  return { from, tables, reads };
}

const review = (id: string, verdict: string, hoursAgo: number, kind = "place"): Row => ({
  subject_kind: kind, subject_id: id, verdict, created_at: new Date(NOW - hoursAgo * H).toISOString(),
});

const reading = (state: string, lifecycle: string | undefined, driver: string | null = "saves", midGroups = 0): TrendReading => ({
  state: state as TrendReading["state"],
  evidence: { recentRate: 1, midRate: 1, priorRate: 0, totalWeight: 5, midGroups } as TrendReading["evidence"],
  provenance: { window: { kind: "bounded", startMs: 0, endMs: 1 }, modelVersion: "m", featureVersion: "f", computedAt: 1 },
  ...(lifecycle ? { lifecycle: lifecycle as NonNullable<TrendReading["lifecycle"]> } : {}),
  ...(lifecycle ? { driver: driver as TrendReading["driver"] } : {}),
});

describe("T1 — the rule, on computed readings", () => {
  it("T1a suppressed ⇒ no claim, no reason, no retest; unread ⇒ removed; none ⇒ unchanged", async () => {
    const readings: Record<string, TrendReading> = {
      "db/sup": reading("trending", "growing"), "db/unread": reading("emerging", "emerging"), "db/ok": reading("established", "evergreen"),
      "db/cool": reading("cooling", "cooling"),
    };
    const verdicts: Record<string, "suppressed" | "none" | "unread"> = { "db/sup": "suppressed", "db/unread": "unread", "db/ok": "none", "db/cool": "suppressed" };
    const asked: string[] = [];
    const out = await applyPlaceTrendReviews({}, readings, async (_sc, kind, id) => { assert.equal(kind, "place"); asked.push(id); return verdicts[id]!; });
    assert.deepEqual(asked.sort(), Object.keys(readings).sort(), "every reading that can publish is asked about, by its own key");
    assert.equal(out["db/sup"]!.state, "unknown");
    assert.equal(out["db/sup"]!.lifecycle, "inactive");
    assert.equal(out["db/sup"]!.driver, null);
    assert.equal(trendReasonFor(out["db/sup"]!.state), null, "no reason code and no sentence");
    assert.equal(isRetestCandidate(out["db/cool"]), false, "a suppressed cooled place is not a retest pick");
    assert.equal(isRetestCandidate(readings["db/cool"]), true, "precondition: it was one");
    assert.equal("db/unread" in out, false, "unread: the reading is removed — fail closed");
    assert.equal(out["db/ok"], readings["db/ok"], "none: the reading is untouched");
    assert.equal(readings["db/sup"]!.state, "trending", "the caller's readings are not mutated");
  });

  it("T1b every answer `none` ⇒ the SAME object; a reading that can publish nothing is not asked about", async () => {
    const readings: Record<string, TrendReading> = { "db/a": reading("trending", "growing"), "node/1": reading("unknown", undefined), "db/x": reading("unknown", "inactive") };
    const asked: string[] = [];
    const out = await applyPlaceTrendReviews({}, readings, async (_sc, _k, id) => { asked.push(id); return "none"; });
    assert.equal(out, readings);
    assert.deepEqual(asked, ["db/a"], "a v1 `unknown` and an `inactive` reading publish nothing, so no review is read for them");
  });

  it("T1c a reader that throws is `unread` for that place, never a claim", async () => {
    const out = await applyPlaceTrendReviews({}, { "db/a": reading("trending", "growing") }, async () => { throw new Error("boom"); });
    assert.deepEqual(out, {});
  });
});

describe("T2 — the real reader: TrailService.readTrendReviewVerdict", () => {
  it("T2a the newest review is in force; cleared lifts suppressed; another subject kind does not count", async () => {
    const sc = makeDb({ trend_integrity_reviews: [
      review("db/p1", "suppressed", 5), review("db/p2", "suppressed", 5), review("db/p2", "cleared", 1),
      review("db/p3", "suppressed", 1, "trail"),
    ] });
    const out = await applyPlaceTrendReviews(sc, { "db/p1": reading("trending", "growing"), "db/p2": reading("trending", "growing"), "db/p3": reading("trending", "growing") });
    assert.equal(out["db/p1"]!.state, "unknown");
    assert.equal(out["db/p2"]!.state, "trending", "a later `cleared` lifts it");
    assert.equal(out["db/p3"]!.state, "trending", "a Trail review of the same id is not a place review");
  });

  it("T2b a failed read is `unread` (the reading drops); 3486 absent is `none` (nothing changes)", async () => {
    const r = { "db/p1": reading("trending", "growing") };
    assert.equal(await readTrendReviewVerdict(makeDb({}, { erroring: ["trend_integrity_reviews"] }), "place", "db/p1"), "unread");
    assert.deepEqual(await applyPlaceTrendReviews(makeDb({}, { erroring: ["trend_integrity_reviews"] }), r), {});
    assert.deepEqual(await applyPlaceTrendReviews(makeDb({}, { throwing: ["trend_integrity_reviews"] }), r), {});
    assert.equal(await applyPlaceTrendReviews(makeDb({}, { missing: ["trend_integrity_reviews"] }), r), r);
  });
});

describe("T3 — the served modifiers path: momentum trend states and the retest pool", () => {
  const PAGE = ["db/a", "db/b", "db/c", "db/d", "db/e", "db/f"];
  /** discoveryTrendOps R4's cooled place: a confirmed middle window, a quieter recent one. */
  function events(): Row[] {
    const ev: Row[] = [];
    const t = (h: number) => new Date(NOW - h * H).toISOString();
    let n = 0;
    const row = (r: Row) => ev.push({ id: `e${++n}`, surface: "discovery", item_id: "db/f", ...r });
    for (let i = 0; i < 40; i++) row({ outcome: "impression", served_at: t(1 + i * 0.5), outcome_at: null, user_id: `v${i}` });
    for (let i = 0; i < 3; i++) row({ outcome: "tap", served_at: t(2 + i), outcome_at: t(1.9 + i), user_id: `r${i}` });
    for (let i = 0; i < 40; i++) row({ outcome: "impression", served_at: t(50 + i * 2), outcome_at: null, user_id: `w${i}` });
    for (let i = 0; i < 12; i++) row({ outcome: "save", served_at: t(60 + i * 4), outcome_at: t(59.9 + i * 4), user_id: `m${i}` });
    return ev;
  }
  const flags = [
    { flag: "discovery_trend_normalised_enabled", enabled: true }, { flag: "discovery_trend_rediscovery_retest_enabled", enabled: true },
  ];
  async function run(reviews: Row[] | "error", key: string) {
    _resetLocalMomentumCacheForTest();
    const sc = makeDb({ feature_flags: flags, rank_events: events(), trend_integrity_reviews: reviews === "error" ? [] : reviews },
      reviews === "error" ? { erroring: ["trend_integrity_reviews"] } : {});
    await loadLocalMomentum(sc, PAGE, { cacheKey: key, nowMs: NOW });
    return { states: readLocalTrendStates(key, NOW), plan: await planRediscoveryRetest(sc, key, PAGE, NOW) };
  }

  it("T3a CONTROL — no review: db/f is a v2 cooled reading and the retest picks it", async () => {
    const r = await run([], "t3-none");
    assert.equal(r.states["db/f"]?.state, "cooling");
    assert.equal(r.plan.retest?.id, "db/f");
  });

  it("T3b suppressed: the served state is `unknown`/`inactive` and the retest picks nothing", async () => {
    const r = await run([review("db/f", "suppressed", 2)], "t3-sup");
    assert.equal(r.states["db/f"]?.state, "unknown");
    assert.equal(r.states["db/f"]?.lifecycle, "inactive");
    assert.equal(r.plan.retest, null);
  });

  it("T3c unread: the reading is dropped from the served states and the pool (fail closed)", async () => {
    const r = await run("error", "t3-unread");
    assert.equal("db/f" in r.states, false);
    assert.equal(r.plan.retest, null);
  });
});

describe("T4 — the trend API's stored rows", () => {
  const RUN = new Date(NOW - 60_000).toISOString();
  const K = TREND_DISCLOSURE_MIN_TRAVELERS;
  const pm = (id: string, state: string, velocity: number | null): Row => ({
    place_id: id, computed_at: RUN, trend_state: state, recent_rate: 0.3, mid_rate: 0.1, prior_rate: 0, total_weight: 12,
    recent_unique_travelers: K + 3, window_unique_travelers: K + 9, model_version: TREND_STATE_MODEL_VERSION_V2, feature_version: TREND_FEATURE_VERSION_V2,
    window_ms: { recent_ms: 172_800_000, mid_ms: 604_800_000, prior_ms: TREND_PRIOR_MS }, source_surface: "discovery",
    velocity, lifecycle_state: state === "trending" ? "growing" : state, driver: "saves", cell_key: "n:lisbon:alfama", city: "lisbon",
  });
  const rows = () => [pm("db/p1", "trending", 3), pm("db/p2", "trending", 2), pm("db/p3", "emerging", null)];

  it("T4a readLocatedRun: a suppressed place reads `unknown` and no list order names it; the others are untouched", async () => {
    const sc = makeDb({ place_momentum: rows(), area_momentum: [], trend_integrity_reviews: [review("db/p1", "suppressed", 1)] });
    const read = await readLocatedRun(sc, "lisbon", ["trending", "emerging", "rediscovered"], NOW);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    const p1 = read.rows.find((r) => r.place_id === "db/p1")!;
    assert.equal(p1.trend_state, "unknown");
    assert.equal(p1.lifecycle_state, "inactive");
    assert.equal(p1.driver, null);
    const everyone = new Map(read.rows.map((r) => [r.place_id.replace(/^db\//, ""), {}]));
    assert.deepEqual(orderLocated(read.rows, everyone).map((r) => r.place_id), ["db/p2", "db/p3"]);
  });

  it("T4b readLocatedRun: an unread review drops the row — the list is served without the claim, never with it", async () => {
    const sc = makeDb({ place_momentum: rows(), area_momentum: [] }, { erroring: ["trend_integrity_reviews"] });
    const read = await readLocatedRun(sc, "lisbon", ["trending", "emerging", "rediscovered"], NOW);
    assert.equal(read.ok, true);
    if (read.ok) assert.deepEqual(read.rows, []);
  });

  it("T4c readTrendSnapshot (the explanations): suppressed reads `unknown`; with no review the rows are the stored rows", async () => {
    const sup = await readTrendSnapshot(makeDb({ place_momentum: rows(), area_momentum: [], trend_integrity_reviews: [review("db/p2", "suppressed", 1)] }), ["db/p1", "db/p2"]);
    assert.equal(sup.ok, true);
    if (sup.ok) assert.deepEqual(sup.rows.map((r) => [r.place_id, r.trend_state]).sort(), [["db/p1", "trending"], ["db/p2", "unknown"]]);
    const none = await readTrendSnapshot(makeDb({ place_momentum: rows(), area_momentum: [], trend_integrity_reviews: [] }), ["db/p1", "db/p2"]);
    if (none.ok) assert.deepEqual(none.rows.map((r) => [r.place_id, r.trend_state]).sort(), [["db/p1", "trending"], ["db/p2", "trending"]]);
  });

  it("T4d the stored-row rule on its own: `unknown` rows are not asked about", async () => {
    const asked: string[] = [];
    const out = await applyPlaceTrendReviewsToRows({}, [{ place_id: "a", trend_state: "unknown" }, { place_id: "b", trend_state: "trending" }],
      async (_sc, _k, id) => { asked.push(id); return "none"; });
    assert.deepEqual(asked, ["b"]);
    assert.equal(out.length, 2);
  });
});
