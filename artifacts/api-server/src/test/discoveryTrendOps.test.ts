/**
 * discoveryTrendOps — census-discovery §84 (lane W10-R1): the rebuild scheduler
 * (DC-07), the rediscovery retest (DV-31), and the Ecosystem Governor's two
 * defined monitors and proposal-only adjust half (DV-80).
 *
 *   S  the scheduler: off by default, the five-minute boundary, the retention
 *      arm inert until the owner sets both its flag and keep_days
 *   R  the retest: which places, which period, which slot; off by default
 *   G  new-creator success and stale content measured; bound proposals only
 *
 * Controlled data; no production claim.
 * Run: node --import tsx/esm --test src/test/discoveryTrendOps.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runTrendRebuildTick, rebuildInstant, keepDaysOf, _setTestClient, TREND_REBUILD_INTERVAL_MS,
} from "../lib/discoveryTrendRebuildScheduler.js";
import { TREND_SNAPSHOT_MAX_AGE_MS } from "../lib/discoveryTrendExplanation.js";
import {
  isRetestCandidate, pickRetest, applyRediscoveryRetest, planRediscoveryRetest, RETEST_PERIOD_MS, RETEST_MIN_PAGE,
} from "../lib/discoveryTrendRediscovery.js";
import { loadLocalMomentum, _resetLocalMomentumCacheForTest } from "../lib/discoveryLocalMomentum.js";
import type { TrendReading } from "../lib/discoveryTrendState.js";
import {
  buildEcosystemReport, readNewCreatorSuccess, readStaleContent, ECOSYSTEM_NEW_CREATORS_SQL, ECOSYSTEM_STALE_SQL, ECOSYSTEM_READS_84,
  ECOSYSTEM_MONITORS, type EcosystemInputs, type EcosystemReport, type ReadOutcome,
} from "../lib/discoveryEcosystemGovernor.js";
import { proposePolicyBounds, POLICY_BOUND_RULES, MONITORS_WITHOUT_BOUND, SEEN_WINDOW_MS_NOW } from "../lib/discoveryEcosystemBounds.js";
import { WRITE_KEYWORDS } from "../lib/discoveryTraceRead.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dir, "..");
const NOW = Date.parse("2026-09-27T12:03:17Z");
const H = 3_600_000;

// ── S: the scheduler ────────────────────────────────────────────────────────
function schedDb(flags: Record<string, { enabled: boolean; metadata?: unknown } | "error">, rpc: { data?: unknown; error?: unknown } = { data: 7 }) {
  const calls: string[] = [];
  return {
    calls,
    rpc(name: string, args: Record<string, unknown>) { calls.push(`rpc:${name}:${String(args["p_now"])}`); return Promise.resolve({ data: rpc.data ?? null, error: rpc.error ?? null }); },
    from(table: string) {
      let flag = ""; let op = "select";
      const b: any = {
        select() { return b; },
        eq(_c: string, v: string) { flag = v; return b; },
        delete() { op = "delete"; return b; },
        lt(c: string, v: string) { calls.push(`delete:${table}:${c}<${v}`); return Promise.resolve({ error: null }); },
        maybeSingle() {
          const f = flags[flag];
          if (f === "error") return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: f ? { enabled: f.enabled, metadata: f.metadata ?? null } : null, error: null });
        },
      };
      void op;
      return b;
    },
  };
}
afterEach(() => _setTestClient(null));

describe("S — DC-07: the rebuild scheduler", () => {
  it("S1. flag absent, OFF or unreadable: the tick reads one flag and calls nothing", async () => {
    for (const f of [{}, { discovery_trend_rebuild_scheduler_enabled: { enabled: false } }, { discovery_trend_rebuild_scheduler_enabled: "error" as const }]) {
      const db = schedDb(f as never);
      _setTestClient(db);
      assert.deepEqual(await runTrendRebuildTick(NOW), { status: "skipped", reason: "disabled" });
      assert.deepEqual(db.calls, []);
    }
  });

  it("S2. ON: one rebuild at the five-minute boundary; two ticks in one window name one run", async () => {
    const db = schedDb({ discovery_trend_rebuild_scheduler_enabled: { enabled: true } });
    _setTestClient(db);
    const a = await runTrendRebuildTick(NOW);
    const b = await runTrendRebuildTick(NOW + 60_000);
    assert.deepEqual(a, { status: "ran", pNow: "2026-09-27T12:00:00.000Z", written: 7, pruned: "retention_off" });
    assert.equal((b as { pNow: string }).pNow, "2026-09-27T12:00:00.000Z");
    assert.deepEqual(db.calls, ["rpc:rebuild_place_momentum:2026-09-27T12:00:00.000Z", "rpc:rebuild_place_momentum:2026-09-27T12:00:00.000Z"]);
    assert.equal(rebuildInstant(NOW + 5 * 60_000), "2026-09-27T12:05:00.000Z");
  });

  it("S3. the cadence is half the freshness bound the API serves a run for", () => {
    assert.equal(TREND_REBUILD_INTERVAL_MS, 5 * 60_000);
    assert.equal(TREND_REBUILD_INTERVAL_MS * 2, TREND_SNAPSHOT_MAX_AGE_MS);
  });

  it("S4. retention: nothing is deleted unless its flag is ON and keep_days is a positive whole number", async () => {
    const on = { discovery_trend_rebuild_scheduler_enabled: { enabled: true } };
    for (const [meta, want] of [[{ keep_days: null }, "keep_days_unset"], [{ keep_days: 0 }, "keep_days_unset"], [{ keep_days: 2.5 }, "keep_days_unset"], [null, "keep_days_unset"]] as const) {
      const db = schedDb({ ...on, discovery_trend_snapshot_retention_enabled: { enabled: true, metadata: meta } });
      _setTestClient(db);
      assert.equal(((await runTrendRebuildTick(NOW)) as { pruned: string }).pruned, want);
      assert.ok(!db.calls.some((c) => c.startsWith("delete:")), JSON.stringify(meta));
    }
    const off = schedDb({ ...on, discovery_trend_snapshot_retention_enabled: { enabled: false, metadata: { keep_days: 30 } } });
    _setTestClient(off);
    assert.equal(((await runTrendRebuildTick(NOW)) as { pruned: string }).pruned, "retention_off");
    const db = schedDb({ ...on, discovery_trend_snapshot_retention_enabled: { enabled: true, metadata: { keep_days: 30 } } });
    _setTestClient(db);
    assert.equal(((await runTrendRebuildTick(NOW)) as { pruned: string }).pruned, "pruned");
    assert.deepEqual(db.calls.slice(1), ["delete:place_momentum:computed_at<2026-08-28T12:00:00.000Z", "delete:area_momentum:computed_at<2026-08-28T12:00:00.000Z"]);
    assert.equal(keepDaysOf({ keep_days: 7 }), 7);
  });

  it("S5. a failed rebuild is reported, and nothing is pruned after it", async () => {
    const db = schedDb({ discovery_trend_rebuild_scheduler_enabled: { enabled: true }, discovery_trend_snapshot_retention_enabled: { enabled: true, metadata: { keep_days: 30 } } },
      { error: { code: "42883", message: "function does not exist" } });
    _setTestClient(db);
    assert.deepEqual(await runTrendRebuildTick(NOW), { status: "failed", reason: "42883", pNow: "2026-09-27T12:00:00.000Z" });
    assert.ok(!db.calls.some((c) => c.startsWith("delete:")));
  });

  it("S6. the API server starts it (one call site)", () => {
    const idx = readFileSync(join(SRC, "index.ts"), "utf8");
    assert.equal(idx.match(/startDiscoveryTrendRebuildScheduler\(\)/g)?.length, 1);
  });
});

// ── R: the retest ───────────────────────────────────────────────────────────
const reading = (state: string, lifecycle: string | undefined, midGroups = 0, priorGroups = 0): TrendReading => ({
  state: state as TrendReading["state"],
  evidence: { recentRate: 0, midRate: 0, priorRate: 0, totalWeight: 0, midGroups, priorGroups } as TrendReading["evidence"],
  provenance: { window: { kind: "bounded", startMs: 0, endMs: 1 }, modelVersion: "m", featureVersion: "f", computedAt: 1 },
  ...(lifecycle ? { lifecycle: lifecycle as NonNullable<TrendReading["lifecycle"]> } : {}),
});

describe("R — DV-31: cooled places are retested, periodically, in a bounded slot", () => {
  it("R1. who is a candidate", () => {
    assert.equal(isRetestCandidate(reading("cooling", "cooling")), true);
    assert.equal(isRetestCandidate(reading("unknown", "unknown", 3)), true, "confirmed before, quiet now");
    assert.equal(isRetestCandidate(reading("unknown", "unknown", 2, 2)), false, "never broadly confirmed");
    assert.equal(isRetestCandidate(reading("cooling", "inactive")), false, "past its content-type horizon");
    assert.equal(isRetestCandidate(reading("cooling", undefined)), false, "a v1 reading is not a pool");
    for (const s of ["emerging", "trending", "established", "rediscovered"]) assert.equal(isRetestCandidate(reading(s, "growing", 5, 5)), false, s);
  });

  it("R2. one pick per period, the same on every request, rotating so every candidate comes round", () => {
    const page = ["a", "b", "c", "d", "e", "f"];
    const pool = { b: reading("cooling", "cooling"), d: reading("unknown", "unknown", 4), f: reading("cooling", "cooling"), a: reading("trending", "growing") };
    const p0 = pickRetest(page, pool, NOW);
    assert.equal(pickRetest(page, pool, NOW + 1_000), p0, "deterministic within a period");
    const seen = new Set<string | null>();
    for (let d = 0; d < 60; d++) seen.add(pickRetest(page, pool, NOW + d * RETEST_PERIOD_MS));
    assert.deepEqual([...seen].sort(), ["b", "d", "f"], "only candidates, and each of them in time");
    assert.equal(pickRetest(["a", "c"], pool, NOW), null, "nothing outside the page");
  });

  it("R3. the slot: the middle, never the top, a permutation, and never a demotion", () => {
    const page = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const plan = applyRediscoveryRetest(page, "h");
    assert.deepEqual(plan.order, ["a", "b", "c", "d", "h", "e", "f", "g"]);
    assert.deepEqual(plan.retest, { id: "h", slot: 4, fromIndex: 7 });
    assert.deepEqual([...plan.order].sort(), [...page].sort());
    assert.deepEqual(applyRediscoveryRetest(page, "b"), { order: page, retest: null }, "already above the middle: not moved down");
    assert.deepEqual(applyRediscoveryRetest(page.slice(0, RETEST_MIN_PAGE - 1), "c").retest, null);
    assert.deepEqual(applyRediscoveryRetest(page, null).retest, null);
  });

  it("R4. the serve-path entry: OFF (or unreadable) returns the page unchanged; ON with a v2 pool moves the pick", async () => {
    const page = ["db/a", "db/b", "db/c", "db/d", "db/e", "db/f"];
    const fake = (flags: Record<string, boolean>, events: unknown[] = []) => ({
      from(table: string) {
        let flag = "";
        const b: any = {
          select() { return b; }, eq(_c: string, v: string) { flag = v; return b; }, neq() { return b; }, in() { return b; },
          gte() { return b; }, order() { return b; }, range() { return b; },
          maybeSingle() { return Promise.resolve({ data: flag in flags ? { enabled: flags[flag] } : null, error: null }); },
          then(res: (v: unknown) => unknown) { return Promise.resolve({ data: table === "rank_events" ? events : [], error: null }).then(res); },
        };
        return b;
      },
    });
    assert.deepEqual(await planRediscoveryRetest(fake({}), "k", page, NOW), { order: page, retest: null });
    // A cooling place: 40 exposures now with 3 unrelated taps, against 40 with 12 in the middle window.
    const ev: unknown[] = [];
    const t = (h: number) => new Date(NOW - h * H).toISOString();
    for (let i = 0; i < 40; i++) ev.push({ item_id: "db/f", outcome: "impression", served_at: t(1 + i * 0.5), outcome_at: null, user_id: `v${i}` });
    for (let i = 0; i < 3; i++) ev.push({ item_id: "db/f", outcome: "tap", served_at: t(2 + i), outcome_at: t(1.9 + i), user_id: `r${i}` });
    for (let i = 0; i < 40; i++) ev.push({ item_id: "db/f", outcome: "impression", served_at: t(50 + i * 2), outcome_at: null, user_id: `w${i}` });
    for (let i = 0; i < 12; i++) ev.push({ item_id: "db/f", outcome: "save", served_at: t(60 + i * 4), outcome_at: t(59.9 + i * 4), user_id: `m${i}` });
    _resetLocalMomentumCacheForTest();
    const sc = fake({ discovery_trend_normalised_enabled: true, discovery_trend_rediscovery_retest_enabled: true }, ev);
    await loadLocalMomentum(sc, page, { cacheKey: "retest", nowMs: NOW });
    const plan = await planRediscoveryRetest(sc, "retest", page, NOW);
    assert.deepEqual(plan.retest, { id: "db/f", slot: 3, fromIndex: 5 });
    _resetLocalMomentumCacheForTest();
    const v1 = fake({ discovery_trend_rediscovery_retest_enabled: true }, ev);
    await loadLocalMomentum(v1, page, { cacheKey: "retest-v1", nowMs: NOW });
    assert.equal((await planRediscoveryRetest(v1, "retest-v1", page, NOW)).retest, null, "no v2 model, no pool");
  });

  it("R5. nothing on a serve path calls it yet (H-W10R1-1 is the integrator's hunk)", () => {
    const callers = ["lib", "routes"].flatMap((d) => readdirSync(join(SRC, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`))
      .filter((f) => f !== "lib/discoveryTrendRediscovery.ts" && /discoveryTrendRediscovery\.js/.test(readFileSync(join(SRC, f), "utf8")));
    assert.deepEqual(callers, []);
  });
});

// ── G: the governor ─────────────────────────────────────────────────────────
const ok = (v: unknown): ReadOutcome => ({ ok: true, value: JSON.stringify(v) });
const report = (over: Partial<EcosystemInputs> = {}): EcosystemReport => buildEcosystemReport({
  window: { since: "2031-04-01T00:00:00.000Z", until: "2031-04-08T00:00:00.000Z" },
  stop: { ok: false, error: "x" }, corpus: { ok: false, error: "x" }, repeats: { ok: false, error: "x" }, spam: { ok: false, error: "x" },
  trails: { ok: false, error: "x" }, pages: { ok: false, error: "x" }, ...over,
});
const reading84 = (r: EcosystemReport, id: string) => r.monitors.find((m) => m.id === id)!.reading;

describe("G — DV-80: the two monitors defined and measured; bounds only proposed", () => {
  it("G1. new-creator success and stale content are measured with their denominators; no monitor is 'unmeasured' now", () => {
    const r = report({ newCreators: ok({ new_creators: 10, served_new_creators: 4, successful_new_creators: 1 }), stale: ok({ exposures: 200, stale_exposures: 50, served_items: 40, stale_items: 5 }) });
    assert.deepEqual(reading84(r, "new_creator_success"), { state: "measured", value: 0.25, sample: 4, detail: (reading84(r, "new_creator_success") as { detail: Record<string, unknown> }).detail });
    const nc = reading84(r, "new_creator_success");
    assert.equal(nc.state === "measured" ? nc.detail["opportunity"] : null, 0.4);
    assert.equal((reading84(r, "stale_content") as { value: number }).value, 0.25);
    assert.ok(r.monitors.every((m) => m.reading.state !== "unmeasured"));
    assert.ok(ECOSYSTEM_MONITORS.every((m) => m.missingInput === undefined));
    assert.ok(ECOSYSTEM_MONITORS.filter((m) => m.definition).map((m) => m.id).sort().join() === "new_creator_success,stale_content");
  });

  it("G2. failure is a reading: unread, failed, malformed, empty — never a zero", () => {
    assert.equal(readNewCreatorSuccess(undefined).state, "input_absent");
    assert.equal(readStaleContent({ ok: false, error: "psql" }).state, "unreadable");
    assert.equal(readNewCreatorSuccess(ok({ new_creators: 1, served_new_creators: 2, successful_new_creators: 0 })).state, "unreadable");
    assert.equal(readStaleContent(ok({ exposures: 0, stale_exposures: 0, served_items: 0, stale_items: 0 })).state, "insufficient_sample");
  });

  it("G3. the two reads write nothing and return no user id", () => {
    for (const sql of ECOSYSTEM_READS_84) assert.equal(WRITE_KEYWORDS.test(sql), false);
    for (const sql of [ECOSYSTEM_NEW_CREATORS_SQL, ECOSYSTEM_STALE_SQL]) {
      const out = /json_build_object\(([\s\S]*)\)::text/.exec(sql)![1]!;
      assert.ok(!/'user|'creator'|user_id'/.test(out), "an id is a key of the output");
    }
  });

  it("G4. a proposal only outside its band, over ≥ 30, inside the bound's range; never per user; never applied", () => {
    const hi = report({ stop: ok({ creator_concentration: { state: "measured", exposures: 400, resolved: 300, creators: 3, hhi: 0.6, top_creator_share: 0.7 } }),
      repeats: ok({ exposures: 100, viewer_item_pairs: 30, repeated_pairs: 20, viewers: 9, max_per_pair: 5 }) });
    const p = proposePolicyBounds(hi);
    assert.deepEqual(p.map((x) => [x.bound, x.current, x.proposed]), [["MAX_PER_CONTRIBUTOR_PER_PAGE", 2, 1], ["SEEN_WINDOW_MS", 24 * H, 48 * H]]);
    assert.ok(p.every((x) => x.kind === "proposal" && x.proposed >= x.range[0] && x.proposed <= x.range[1]));
    const small = report({ repeats: ok({ exposures: 20, viewer_item_pairs: 2, repeated_pairs: 2, viewers: 1, max_per_pair: 10 }) });
    assert.deepEqual(proposePolicyBounds(small), [], "a sample under 30 proposes nothing");
    const inBand = report({ repeats: ok({ exposures: 100, viewer_item_pairs: 90, repeated_pairs: 5, viewers: 9, max_per_pair: 2 }) });
    assert.deepEqual(proposePolicyBounds(inBand), []);
    const nc = report({ newCreators: ok({ new_creators: 80, served_new_creators: 40, successful_new_creators: 4 }) });
    assert.deepEqual(proposePolicyBounds(nc).map((x) => [x.bound, x.proposed]), [["GOVERNOR_BUDGET_MIN_PCT", 20]]);
  });

  it("G5. every monitor is either bound by one rule or named as moving none, and the seen window is lib/discoveryPde's", () => {
    const bound = POLICY_BOUND_RULES.map((r) => r.monitor);
    assert.deepEqual([...bound, ...Object.keys(MONITORS_WITHOUT_BOUND)].sort(), ECOSYSTEM_MONITORS.filter((m) => m.id !== "concentration" || true).map((m) => m.id).sort());
    const pde = readFileSync(join(SRC, "lib", "discoveryPde.ts"), "utf8");
    assert.match(pde, /const SEEN_WINDOW_MS = 24 \* 60 \* 60 \* 1_000;/);
    assert.equal(SEEN_WINDOW_MS_NOW, 24 * 60 * 60 * 1_000);
  });

  it("G6. no serve or ranking path imports the proposal module", () => {
    const scan = ["lib", "routes", "services/ranking", "services/trails"].flatMap((d) => readdirSync(join(SRC, d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`));
    assert.deepEqual(scan.filter((f) => f !== "lib/discoveryEcosystemBounds.ts" && /discoveryEcosystemBounds\.js/.test(readFileSync(join(SRC, f), "utf8"))), []);
  });
});
