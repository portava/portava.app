/**
 * discoveryTrendSnapshotParity — census-discovery §58 (DC-07, DC-21, DV-33),
 * against PostgreSQL 16 with migration 3410 applied.
 *
 * `rebuild_place_momentum` is a SECOND implementation of the trend reading.
 * placeMomentumSqlParity.test.ts pins the classifier by parsing it; this suite
 * EXECUTES the rebuild and asserts that every stored row equals what
 * lib/discoveryTrendState.computeTrendStates computes over the rows
 * lib/discoveryLocalMomentum.loadLocalMomentum would read — same corpus, same
 * windows, same rates, same state, same sentence. 2892 failed this on the
 * surface (every surface counted) and on the sentence; the cases below are the
 * ones that told them apart.
 *
 * Then the trend API's snapshot read (lib/discoveryTrendExplanation) runs
 * through the REAL supabase-js client over the PostgREST bridge against the
 * stored rows: the newest product-corpus run, a 2892-written row ignored, and
 * the disclosure floor over the travellers 3410 records.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryTrendSnapshotParity.db.test.ts
 * Rows are timed in June 2031 so no other suite's rows can enter a window.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, rows, seedUser, deleteUser } from "./localDb.js";
import { makeTrailBridge } from "./trailPostgrestBridge.js";
import { computeTrendStates, explainTrendState, TREND_PRIOR_MS } from "../../lib/discoveryTrendState.js";
import type { MomentumRow } from "../../lib/discoveryLocalMomentum.js";
import {
  readTrendSnapshot, explainExposures, TREND_DISCLOSURE_MIN_TRAVELERS,
} from "../../lib/discoveryTrendExplanation.js";

const P_NOW = "2031-06-01T00:00:00.000Z";
const NOW_MS = Date.parse(P_NOW);
const at = (hours: number) => `'${new Date(NOW_MS - hours * 3_600_000).toISOString()}'::timestamptz`;
const PFX = "p8par:";

const users: string[] = [];
let U0 = "";

type Ev = [user: string, place: string, surface: string, outcome: string, servedHoursAgo: number, outcomeHoursAgo: number | null];

function insert(evs: Ev[]): void {
  exec(`INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${evs.map(([u, p, s, o, sh, oh]) =>
    `('${u}', '${PFX}${p}', '${s}', '${o}', ${at(sh)}, ${oh === null ? "NULL" : at(oh)})`).join(",\n")};`);
}

const rebuild = () => exec(`SELECT public.rebuild_place_momentum('${P_NOW}'::timestamptz);`);
const stored = () => rows<Record<string, any>>(
  `SELECT place_id, trend_state, recent_rate, mid_rate, prior_rate, total_weight, reason,
          recent_unique_travelers, window_unique_travelers, source_surface
     FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND place_id LIKE '${PFX}%' ORDER BY place_id`);

/** Exactly the loader's read: lib/discoveryLocalMomentum.loadLocalMomentum's filters. */
const loaderRows = () => rows<MomentumRow>(
  `SELECT item_id, outcome, served_at, outcome_at FROM public.rank_events
    WHERE surface = 'discovery' AND outcome <> 'analytics' AND item_id LIKE '${PFX}%'
      AND served_at >= '${new Date(NOW_MS - TREND_PRIOR_MS).toISOString()}'::timestamptz`);

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("census-discovery §58 — the stored trend snapshot IS the product's reading", { skip: !HAVE_DB }, () => {
  before(() => {
    for (let i = 0; i < TREND_DISCLOSURE_MIN_TRAVELERS + 1; i++) users.push(seedUser(`p8par${i}`));
    U0 = users[0]!;
    const ev: Ev[] = [];
    const n = (k: number, f: (i: number) => Ev) => { for (let i = 0; i < k; i++) ev.push(f(i)); };
    // A emerging: activity now, no history.
    n(5, (i) => [U0, "A", "discovery", "impression", 1 + i, null]);
    // B trending: 10 recent against 10 in the middle window (rate 4).
    n(10, (i) => [U0, "B", "discovery", "impression", 1 + i, null]);
    n(10, (i) => [U0, "B", "discovery", "impression", 60 + i, null]);
    // C cooling: 3 recent against 25 in the middle (rate 10).
    n(3, (i) => [U0, "C", "discovery", "impression", 1 + i, null]);
    n(25, (i) => [U0, "C", "discovery", "impression", 60 + i, null]);
    // D established: 5 recent against 12 in the middle (rate 4.8).
    n(5, (i) => [U0, "D", "discovery", "impression", 1 + i, null]);
    n(12, (i) => [U0, "D", "discovery", "impression", 60 + i, null]);
    // E rediscovered: active now, silent middle, busy before.
    n(4, (i) => [U0, "E", "discovery", "impression", 1 + i, null]);
    n(40, (i) => [U0, "E", "discovery", "impression", 200 + i, null]);
    // F unknown: history only.
    n(10, (i) => [U0, "F", "discovery", "impression", 300 + i, null]);
    // G: activity on OTHER surfaces only. The product reads none of it.
    n(10, (i) => [U0, "G", "pulse", "impression", 1 + i, null]);
    n(10, (i) => [U0, "G", "living_page", "impression", 1 + i, null]);
    // H: one Discovery impression buried in other surfaces' traffic. 2892 read
    // 21 recent (emerging); the product reads 1 (below the floor: unknown).
    ev.push([U0, "H", "discovery", "impression", 1, null]);
    n(20, (i) => [U0, "H", "pulse", "impression", 1 + i, null]);
    // I: a save made now on an impression served 31 days ago. The loader never
    // reads that row (served before the window), so the product counts 3
    // recent impressions — and 2892 counted the save too.
    n(3, (i) => [U0, "I", "discovery", "impression", 1 + i, null]);
    ev.push([U0, "I", "discovery", "save", 31 * 24, 2]);
    // J: a save inside the window counts at served_at (1) AND at outcome_at (3).
    ev.push([U0, "J", "discovery", "save", 70, 1], [U0, "J", "discovery", "impression", 2, null]);
    // K: analytics only — bookkeeping, never activity.
    n(10, (i) => [U0, "K", "discovery", "analytics", 1 + i, null]);
    // T: one recent impression from each of k distinct travellers — disclosable.
    users.slice(0, TREND_DISCLOSURE_MIN_TRAVELERS).forEach((u, i) => ev.push([u, "T", "discovery", "impression", 1 + i, null]));
    // V: travellers counted per window: 3 recent, 2 more in the middle.
    users.slice(0, 3).forEach((u, i) => ev.push([u, "V", "discovery", "impression", 1 + i, null], [u, "V", "discovery", "impression", 2 + i, null]));
    users.slice(3, 5).forEach((u, i) => ev.push([u, "V", "discovery", "impression", 60 + i, null]));
    insert(ev);
    rebuild();
  });

  after(() => {
    exec(`DELETE FROM public.place_momentum WHERE place_id LIKE '${PFX}%';`);
    for (const u of users) deleteUser(u);   // cascades their rank_events
  });

  it("S1. every stored row equals computeTrendStates over the loader's rows: state, four rates, sentence", () => {
    const ts = computeTrendStates(loaderRows(), NOW_MS);
    const sql = stored();
    assert.deepEqual(sql.map((r) => r.place_id).sort(), Object.keys(ts).sort(),
      "the two implementations must read the same places — no more (other surfaces, analytics), no fewer");
    for (const r of sql) {
      const t = ts[r.place_id]!;
      assert.equal(r.trend_state, t.state, `${r.place_id} state`);
      for (const [col, key] of [["recent_rate", "recentRate"], ["mid_rate", "midRate"], ["prior_rate", "priorRate"], ["total_weight", "totalWeight"]] as const) {
        assert.ok(close(Number(r[col]), t.evidence[key]), `${r.place_id} ${col}: SQL ${r[col]} vs TS ${t.evidence[key]}`);
      }
      assert.equal(r.reason, explainTrendState(t.state), `${r.place_id} sentence`);
      assert.equal(r.source_surface, "discovery");
    }
  });

  it("S2. the cases that separated 2892 from the product classify as the product does", () => {
    const s = Object.fromEntries(stored().map((r) => [r.place_id.slice(PFX.length), r]));
    assert.deepEqual(
      Object.fromEntries(["A", "B", "C", "D", "E", "F", "H", "I", "J", "T"].map((k) => [k, s[k]?.trend_state])),
      { A: "emerging", B: "trending", C: "cooling", D: "established", E: "rediscovered", F: "unknown",
        H: "unknown", I: "emerging", J: "emerging", T: "emerging" });
    assert.equal(s["G"], undefined, "a place active only on other surfaces has no product reading");
    assert.equal(s["K"], undefined, "analytics rows are not activity");
    assert.equal(Number(s["I"].recent_rate), 3, "the save on an impression served before the window is not read, as the loader does not read it");
    assert.equal(Number(s["J"].recent_rate), 4, "a save in the window counts at outcome_at (3), beside the recent impression (1)");
    assert.equal(Number(s["J"].mid_rate), 1 / 2.5, "and its own impression counts at served_at, in the middle window");
    assert.equal(s["F"].reason, null, "unknown stores no sentence");
  });

  it("S3. unique travellers are counted per window, and nothing reads them to classify", () => {
    const s = Object.fromEntries(stored().map((r) => [r.place_id.slice(PFX.length), r]));
    assert.equal(s["V"].recent_unique_travelers, 3);
    assert.equal(s["V"].window_unique_travelers, 5);
    assert.equal(s["T"].recent_unique_travelers, TREND_DISCLOSURE_MIN_TRAVELERS);
    assert.equal(s["A"].window_unique_travelers, 1);
  });

  it("S4. the API's snapshot read, through supabase-js: the newest product run, a newer 2892 row ignored, the floor applied", async () => {
    // A row as 2892's function wrote it: newer, no source_surface, a claim.
    exec(`INSERT INTO public.place_momentum (place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight, trend_state, reason,
            model_version, event_weights, window_ms, thresholds)
          VALUES ('${PFX}A', '${new Date(NOW_MS + 60_000).toISOString()}'::timestamptz, 99, 0, 0, 99, 'trending', 'x',
            'discovery-trend-state-v1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb);`);
    const { client } = makeTrailBridge();
    const ids = [`${PFX}A`, `${PFX}T`, `${PFX}F`, `${PFX}G`];
    const read = await readTrendSnapshot(client, ids);
    assert.equal(read.ok, true, JSON.stringify(read));
    if (!read.ok) return;
    assert.equal(read.run?.computedAt, P_NOW, "the newest run over the product's corpus, not the newer 2892 row");
    assert.equal(read.run?.priorMs, TREND_PRIOR_MS);
    const out = explainExposures(ids.map((_, i) => `rid${i}`.padEnd(22, "x")),
      ids.map((itemId, i) => ({ recommendationId: `rid${i}`.padEnd(22, "x"), itemId })), read.run, read.rows, NOW_MS + 1_000);
    assert.deepEqual(out.explanations.map((e) => e.trend?.state ?? e.unavailable), [
      "insufficient_evidence",   // A: emerging, but one traveller
      "emerging",                // T: k travellers
      "insufficient_evidence",   // F: unknown
      "insufficient_evidence",   // G: no product reading
    ]);
  });
});
