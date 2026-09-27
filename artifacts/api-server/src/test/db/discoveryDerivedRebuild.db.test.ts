/**
 * discoveryDerivedRebuild — census-discovery DV-72 / DC-17 / §54: `10` §10
 * "derived tables are rebuildable", proved against PostgreSQL 16 for the two
 * derived Discovery stores that exist.
 *
 * Run: LOCAL_DB_URL=postgresql://… node --import tsx/esm --test src/test/db/discoveryDerivedRebuild.db.test.ts
 *      (or pnpm run test:db-local). Skips without a database.
 *
 * THE PROOF, PER STORE: build it from its sources, keep what was built, DROP
 * the derived rows, rebuild, and compare — then rebuild a second time over the
 * rebuilt rows and compare again (idempotence). Every row this suite writes is
 * timed in April 2031 so no other suite's rows can enter a window.
 *
 *   place_momentum (2892)          rebuilt by public.rebuild_place_momentum(p_now),
 *                                  the SQL function the migration ships, from
 *                                  rank_events alone.
 *   trail_health_snapshots (2910)  there is NO rebuild routine. A snapshot is
 *                                  written by TrailService.recordTrailHealthSnapshot
 *                                  as computeTrailHealth(members, open reports, now).
 *                                  This suite recomputes it from the same two
 *                                  source reads the service makes (newest 500
 *                                  content_trails members; open trail_reports)
 *                                  and writes the same five columns — so what is
 *                                  proved is that a snapshot is a pure function
 *                                  of rows that are still in the database. And
 *                                  its limit is pinned rather than hidden: once a
 *                                  member's content_state or a report's
 *                                  resolution changes IN PLACE, a past snapshot
 *                                  can no longer be rebuilt (T3).
 *
 * place_momentum's lineage (`10` §9 — source window, versions, computation
 * time) is asserted on the rebuilt rows too (P3). trail_health_snapshots
 * stores no source window and no feature version: census-discovery §54, DC-17.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { HAVE_DB, exec, rows, seedUser, deleteUser } from "./localDb.js";
import { computeTrailHealth, TRAIL_HEALTH_MODEL_VERSION } from "../../lib/discoveryTrailHealth.js";

const P_NOW = "2031-04-01T00:00:00.000Z";
const NOW_MS = Date.parse(P_NOW);
const ago = (hours: number) => `'${new Date(NOW_MS - hours * 3_600_000).toISOString()}'::timestamptz`;

const MOMENTUM_COLS = "place_id, computed_at, recent_rate, mid_rate, prior_rate, total_weight, trend_state, reason, model_version, event_weights, window_ms, thresholds, source_table";
const momentumRows = () => rows<Record<string, unknown>>(
  `SELECT ${MOMENTUM_COLS} FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND place_id LIKE 'p9reb:%' ORDER BY place_id`);
const rebuild = () => Number(rows<{ n: number }>(`SELECT public.rebuild_place_momentum('${P_NOW}'::timestamptz) AS n`)[0]!.n);

let V = "";
let C1 = "", C2 = "";
let TRAIL = "";
const S = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

describe("census-discovery DV-72 — derived Discovery stores rebuild to identical rows, idempotently", { skip: !HAVE_DB }, () => {
  before(() => {
    V = seedUser("p9reb_v"); C1 = seedUser("p9reb_c1"); C2 = seedUser("p9reb_c2");
    const ev: string[] = [];
    // A: five recent impressions, no history → emerging.
    for (let h = 1; h <= 5; h++) ev.push(`('${V}', 'p9reb:A', 'discovery', 'impression', ${ago(h)}, NULL)`);
    // B: ten recent and ten mid-window impressions → trending (10 > (10/2.5)·1.5).
    for (let h = 1; h <= 10; h++) ev.push(`('${V}', 'p9reb:B', 'discovery', 'impression', ${ago(h)}, NULL)`);
    for (let h = 60; h < 70; h++) ev.push(`('${V}', 'p9reb:B', 'discovery', 'impression', ${ago(h)}, NULL)`);
    // C: two saves, each counted at served_at (1) and at outcome_at (3).
    ev.push(`('${V}', 'p9reb:C', 'discovery', 'save', ${ago(3)}, ${ago(2)})`, `('${V}', 'p9reb:C', 'discovery', 'save', ${ago(4)}, ${ago(1)})`);
    // D: an analytics row, which the rebuild must exclude, and a prior-window-only place.
    ev.push(`('${V}', 'p9reb:D', 'discovery', 'analytics', ${ago(2)}, NULL)`);
    for (let h = 200; h < 210; h++) ev.push(`('${V}', 'p9reb:E', 'discovery', 'impression', ${ago(h)}, NULL)`);
    TRAIL = randomUUID();
    exec(`
      INSERT INTO public.rank_events (user_id, item_id, surface, outcome, served_at, outcome_at) VALUES ${ev.join(",\n")};
      INSERT INTO public.trails (id, slug, title) VALUES ('${TRAIL}', 'p9reb-${TRAIL.slice(0, 8)}', 'p9 rebuild');
      INSERT INTO public.content_trails (trail_id, source_type, source_id, relationship, contributor_id, confidence, content_state, created_at) VALUES
        ('${TRAIL}', 'place', '${S[0]}', 'primary',    '${C1}', 0.9, 'featured',     ${ago(2)}),
        ('${TRAIL}', 'place', '${S[1]}', 'supporting', '${C1}', 0.4, 'just_arrived', ${ago(30)}),
        ('${TRAIL}', 'post',  '${S[2]}', 'supporting', '${C2}', 0.7, 'evergreen',    ${ago(24 * 100)}),
        ('${TRAIL}', 'place', '${S[3]}', 'supporting', NULL,    0.6, 'growing',      ${ago(24 * 10)});
      INSERT INTO public.trail_reports (trail_id, reported_by, reason, resolution) VALUES
        ('${TRAIL}', '${V}', 'stale', NULL), ('${TRAIL}', '${V}', 'duplicate_trail', 'dismissed');
    `);
  });

  after(() => {
    exec(`
      DELETE FROM public.place_momentum WHERE place_id LIKE 'p9reb:%';
      DELETE FROM public.rank_events WHERE user_id = '${V}';
      DELETE FROM public.trails WHERE id = '${TRAIL}';
    `);
    for (const u of [V, C1, C2]) deleteUser(u);
  });

  // ── place_momentum ────────────────────────────────────────────────────────
  it("P1. place_momentum: drop the derived rows, rebuild, identical", () => {
    exec(`DELETE FROM public.place_momentum WHERE place_id LIKE 'p9reb:%';`);
    rebuild();
    const built = momentumRows();
    assert.deepEqual(built.map((r) => [r.place_id, r.trend_state]), [
      ["p9reb:A", "emerging"], ["p9reb:B", "trending"], ["p9reb:C", "emerging"], ["p9reb:E", "unknown"],
    ], "the rebuild classifies from rank_events alone, and skips the analytics-only place");
    exec(`DELETE FROM public.place_momentum WHERE computed_at = '${P_NOW}'::timestamptz AND place_id LIKE 'p9reb:%';`);
    assert.equal(momentumRows().length, 0, "precondition: the derived rows are gone");
    rebuild();
    assert.deepEqual(momentumRows(), built, "a rebuild from the same source rows must reproduce every column");
  });

  it("P2. place_momentum: a second rebuild over the rebuilt rows changes nothing and adds no row", () => {
    rebuild();
    const once = momentumRows();
    const count = rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.place_momentum WHERE place_id LIKE 'p9reb:%'`)[0]!.n;
    rebuild();
    assert.deepEqual(momentumRows(), once);
    assert.equal(rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.place_momentum WHERE place_id LIKE 'p9reb:%'`)[0]!.n, count,
      "ON CONFLICT (place_id, computed_at) DO UPDATE: idempotent, not additive");
  });

  it("P3. place_momentum rows carry their own lineage: window, versions, computation time, source", () => {
    rebuild();
    for (const r of momentumRows()) {
      assert.equal(new Date(r.computed_at as string).toISOString(), P_NOW, "computation time is the rebuild's p_now");
      assert.equal(r.model_version, "discovery-trend-state-v1");
      assert.deepEqual(r.window_ms, { recent_ms: 172_800_000, mid_ms: 604_800_000, prior_ms: 2_592_000_000 }, "source event window");
      assert.deepEqual(r.thresholds, { min_rate: 3, growth_factor: 1.5, decline_factor: 0.6 });
      assert.deepEqual(r.event_weights, { impression: 1, save: 3, outcome: 2 });
      assert.equal(r.source_table, "rank_events");
    }
  });

  // ── trail_health_snapshots ────────────────────────────────────────────────
  /** The two reads TrailService makes (readMembers: newest 500; readOpenReportCount). */
  function trailSources() {
    const members = rows<{ source_id: string; contributor_id: string | null; confidence: string; content_state: string; created_at: string }>(
      `SELECT source_id, contributor_id, confidence, content_state, created_at FROM public.content_trails
        WHERE trail_id = '${TRAIL}' ORDER BY created_at DESC LIMIT 500`);
    const open = rows<{ n: number }>(`SELECT count(*)::int AS n FROM public.trail_reports WHERE trail_id = '${TRAIL}' AND resolution IS NULL`)[0]!.n;
    return computeTrailHealth({
      members: members.map((m) => ({ ...m, confidence: Number(m.confidence) })),
      reportCount: open, nowMs: NOW_MS,
    });
  }
  /** The five columns TrailService.recordTrailHealthSnapshot writes, with the computation clock. */
  function writeSnapshot(): void {
    const h = trailSources();
    exec(`INSERT INTO public.trail_health_snapshots (trail_id, metrics, model_version, member_count, captured_at)
          VALUES ('${TRAIL}', '${JSON.stringify(h.metrics)}'::jsonb, '${TRAIL_HEALTH_MODEL_VERSION}', ${h.memberCount}, '${P_NOW}'::timestamptz);`);
  }
  const snapshots = () => rows<{ metrics: Record<string, unknown>; model_version: string; member_count: number; captured_at: string }>(
    `SELECT metrics, model_version, member_count, captured_at FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}' ORDER BY captured_at`);

  it("T1. trail_health_snapshots: drop the snapshot, recompute from the same sources, identical", () => {
    writeSnapshot();
    const built = snapshots();
    assert.equal(built.length, 1);
    assert.equal(built[0]!.member_count, 4);
    assert.equal(built[0]!.model_version, TRAIL_HEALTH_MODEL_VERSION);
    exec(`DELETE FROM public.trail_health_snapshots WHERE trail_id = '${TRAIL}';`);
    writeSnapshot();
    assert.deepEqual(snapshots(), built);
  });

  it("T2. a second recomputation at the same instant produces the same metrics (idempotent)", () => {
    const stored = snapshots()[0]!;
    assert.deepEqual(JSON.parse(JSON.stringify(trailSources().metrics)), stored.metrics);
    assert.deepEqual(JSON.parse(JSON.stringify(trailSources().metrics)), stored.metrics);
  });

  it("T3. LIMIT, pinned: a past snapshot stops being rebuildable once a source row changes in place", () => {
    const stored = snapshots()[0]!;
    exec(`UPDATE public.content_trails SET content_state = 'archived_from_active_rotation' WHERE trail_id = '${TRAIL}' AND source_id = '${S[0]}';
          UPDATE public.trail_reports SET resolution = 'dismissed' WHERE trail_id = '${TRAIL}' AND resolution IS NULL;`);
    try {
      assert.notDeepEqual(JSON.parse(JSON.stringify(trailSources().metrics)), stored.metrics,
        "content_trails.content_state and trail_reports.resolution are mutable, so a snapshot's inputs are not retained; if this ever passes equal, the sources became versioned and DV-72 should be re-graded");
    } finally {
      exec(`SET session_replication_role = replica; UPDATE public.content_trails SET content_state = 'featured' WHERE trail_id = '${TRAIL}' AND source_id = '${S[0]}';
            UPDATE public.trail_reports SET resolution = NULL WHERE trail_id = '${TRAIL}' AND reason = 'stale'; SET session_replication_role = origin;`); // restoring the FIXTURE, not testing a transition: archived → featured is not an allowed 02 §7 move since 3381 (§51), so the restore bypasses that trigger
    }
    assert.deepEqual(JSON.parse(JSON.stringify(trailSources().metrics)), stored.metrics, "restored sources rebuild the snapshot again");
  });

});
