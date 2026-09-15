/**
 * GET /admin/ranking/metrics — the `trip_add` total — node:test
 *
 * WHAT THIS PINS
 * --------------
 * routes/adminRankingMetrics.ts builds `totals` with an if/else-if chain over
 * the outcome vocabulary and has NO else arm. An outcome the chain does not
 * name is added to no bucket, appears in no response field, and produces no
 * error — the dashboard simply reports a smaller world than the one that
 * exists.
 *
 * Migration 2894 admits 'trip_add' to rank_events.outcome; routes/rankEvents.ts
 * accepts it at rung 3 and travel-buddy-standalone's PlanPickerController writes
 * it when a traveller adds a served Discovery item to a trip. Before this
 * change every one of those rows was invisible here: `body.trip_adds` did not
 * exist, and no other field moved, so an operator could not tell "nobody adds
 * anything to a trip" from "we never counted it".
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT
 * ------------------------------------
 * Nothing about 'dismiss'. That outcome (2297) is dropped by the same chain and
 * stays dropped: it is a NEGATIVE outcome and belongs with `negative_feedback`,
 * not with the positive totals. See the comment on the tally.
 *
 * Run:
 *   SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *     node --import tsx --test src/test/adminRankingMetricsTripAdd.test.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import adminRankingMetricsRouter from "../routes/adminRankingMetrics.js";

const ADMIN_ID   = "ad000001-1111-4111-8111-111111111111";
const PLANNER    = "cc000001-1111-4111-8111-111111111111";
const OTHER      = "cc000002-2222-4222-8222-222222222222";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * Window rows (default days=7):
 *   surface 'discovery'  — 2 impressions, 1 tap, 1 save, 2 trip_add
 *   surface 'live_pulse' — 1 trip_add  (must NOT reach the surface-blind totals)
 *
 * The two ranked trip_adds and the one Live Pulse trip_add are distinguishable:
 * a tally that forgot the exclusion would report 3.
 */
const ROWS: any[] = [
  { outcome: "impression", item_kind: "place", position: 0, surface: "discovery",
    user_id: PLANNER, served_at: daysAgo(2) },
  { outcome: "impression", item_kind: "place", position: 1, surface: "discovery",
    user_id: OTHER,   served_at: daysAgo(2) },
  { outcome: "tap",        item_kind: "place", position: 0, surface: "discovery",
    user_id: PLANNER, served_at: daysAgo(2) },
  { outcome: "save",       item_kind: "place", position: 0, surface: "discovery",
    user_id: PLANNER, served_at: daysAgo(2) },
  { outcome: "trip_add",   item_kind: "place", position: 0, surface: "discovery",
    user_id: PLANNER, served_at: daysAgo(2) },
  { outcome: "trip_add",   item_kind: "place", position: 1, surface: "discovery",
    user_id: OTHER,   served_at: daysAgo(2) },
  { outcome: "trip_add",   item_kind: "gem",   position: 0, surface: "live_pulse",
    user_id: OTHER,   served_at: daysAgo(2) },
];

/** Same fixture with every trip_add removed — the control for non-vacuity. */
const ROWS_WITHOUT_TRIP_ADD = ROWS.filter((r) => r.outcome !== "trip_add");

const PROFILES: any[] = [
  { id: ADMIN_ID, role: "admin",  account_status: "active", created_at: daysAgo(60) },
  { id: PLANNER,  role: "member", account_status: "active", created_at: daysAgo(60) },
  { id: OTHER,    role: "member", account_status: "active", created_at: daysAgo(60) },
];

/** Minimal PostgREST-shaped builder: the metrics route needs real ranges. */
function makeAdminClient(rankEvents: any[]) {
  const tables: Record<string, any[]> = {
    rank_events:                rankEvents,
    profiles:                   PROFILES,
    creator_activity_scores:    [],
    content_distribution_stats: [],
    feature_flags:              [],
    job_health:                 [],
  };

  function builder(rows: any[]) {
    let filtered = rows.map((r) => ({ ...r }));
    const b: any = {
      select: (_c?: string, _o?: any) => b,
      eq:  (col: string, val: any)  => { filtered = filtered.filter((r) => r[col] === val); return b; },
      neq: (col: string, val: any)  => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:  (col: string, vs: any[]) => { filtered = filtered.filter((r) => vs.includes(r[col])); return b; },
      gte: (col: string, val: any)  => { filtered = filtered.filter((r) => r[col] != null && r[col] >= val); return b; },
      lt:  (col: string, val: any)  => { filtered = filtered.filter((r) => r[col] != null && r[col] <  val); return b; },
      order: (_c: string, _o?: any) => b,
      limit: (_n: number) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => Promise.resolve({ data: filtered, error: null }).then(resolve),
    };
    return b;
  }

  return {
    auth: {
      getUser: async (token: string) =>
        token === "valid-token"
          ? { data: { user: { id: ADMIN_ID } }, error: null }
          : { data: null, error: { message: "invalid" } },
    },
    from: (table: string) => builder(tables[table] ?? []),
  };
}

async function getMetrics(): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use("/api", adminRankingMetricsRouter);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port as number;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/admin/ranking/metrics`, {
      headers: { Authorization: "Bearer valid-token" },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("GET /admin/ranking/metrics — trip_add is counted, not dropped", () => {
  after(() => {
    _setTestClient(null as any, false);
  });

  it("reports trip_adds for the ranked trip-add rows", async () => {
    // RED before the fix: `trip_adds` is not a key on the response at all, so
    // this reads `undefined` — every trip_add row aggregated into nothing.
    _setTestClient(makeAdminClient(ROWS) as any, true);
    const { status, body } = await getMetrics();
    assert.equal(status, 200);
    assert.equal(typeof body.trip_adds, "number",
      "trip_adds must be a real field, not an absent key the dashboard renders as blank");
    assert.equal(body.trip_adds, 2, "2 trip_add rows on the ranked surface");
  });

  it("a Live Pulse trip_add is excluded, like every other surface-blind total", async () => {
    // The fixture has 3 trip_add rows; one is surface='live_pulse'. A tally that
    // counted `all` instead of `nonLivePulse` would report 3.
    _setTestClient(makeAdminClient(ROWS) as any, true);
    const { body } = await getMetrics();
    assert.equal(body.trip_adds, 2, "the surface='live_pulse' trip_add is not ranker signal");
  });

  it("a trip_add is counted as a trip_add and as nothing else", async () => {
    // The chain is else-if, so a misplaced arm would move the same row into
    // saves or attended. Both are pinned against the no-trip_add control below.
    _setTestClient(makeAdminClient(ROWS) as any, true);
    const { body } = await getMetrics();
    assert.equal(body.impressions, 2);
    assert.equal(body.taps,        1);
    assert.equal(body.saves,       1, "a trip_add must not land in saves");
    assert.equal(body.joins,       0);
    assert.equal(body.rsvps,       0);
    assert.equal(body.attended,    0, "a trip_add is 'I plan to', never 'I went'");
  });

  it("the derived rates do not move when trip_add rows appear", async () => {
    // trip_adds is an ADDED field: these rows were previously counted in no
    // bucket, so nothing that was already reported may change value.
    _setTestClient(makeAdminClient(ROWS_WITHOUT_TRIP_ADD) as any, true);
    const control = (await getMetrics()).body;

    _setTestClient(makeAdminClient(ROWS) as any, true);
    const withTripAdds = (await getMetrics()).body;

    assert.equal(control.trip_adds, 0,
      "the field is present and honestly zero when nothing was added to a trip");
    assert.equal(withTripAdds.trip_adds, 2,
      "non-vacuity: the fixtures really do differ in the dimension under test");
    for (const k of ["impressions", "taps", "saves", "joins", "rsvps", "attended",
                     "tap_through_rate", "realized_connection_rate"] as const) {
      assert.equal(withTripAdds[k], control[k], `${k} must be unchanged by trip_add rows`);
    }
  });
});
