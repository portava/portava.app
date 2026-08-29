/**
 * Admin Ranking Config & Metrics tests
 *
 * Tests cover:
 *   1.  Tier bucketing — boundary values for each tier
 *   2.  Tier distribution — correct percentage computation
 *   3.  Concentration — top 1%/5%/10% share computation
 *   4.  Concentration — alert fires when top-10% exceeds 60%
 *   5.  Concentration — alert does NOT fire below the threshold
 *   6.  Concentration — empty input produces zeros
 *   7.  Config validation — rejects unknown key
 *   8.  Config validation — rejects value below range
 *   9.  Config validation — rejects value above range
 *   10. Config validation — accepts value at boundary
 *   11. Config validation — rejects non-finite value
 *   12. GET /admin/ranking/metrics — 403 for non-admin
 *   13. GET /admin/ranking/metrics — 200 with expected shape for admin
 *   14. GET /admin/ranking/config  — 403 for non-admin
 *   15. GET /admin/ranking/config  — 200 for admin
 *   16. PUT /admin/ranking/config  — 400 for unknown key
 *   17. PUT /admin/ranking/config  — 400 for out-of-range value
 *   18. PUT /admin/ranking/config  — 200 success
 *   19. GET /admin/ranking/flags   — 403 for non-admin
 *   20. GET /admin/ranking/flags   — 200 for admin
 *   21. PUT /admin/ranking/flags/:key — 403 for non-admin
 *   22. PUT /admin/ranking/flags/:key — 404 for unknown flag
 *   23. PUT /admin/ranking/flags/:key — 200 success with audit
 *   24. PUT /admin/ranking/flags/:key — 400 for non-RANKING_ prefix
 *   25. GET /admin/ranking/suspicious — 403 for non-admin
 *   26. GET /admin/ranking/suspicious — 200 with score breakdown
 *   27. GET /admin/ranking/debug-samples — 403 for non-admin
 *   28. GET /admin/ranking/debug-samples — 200 with samples
 *   29. GET /admin/ranking/debug-samples — respects surface filter
 *   30. GET /admin/ranking/fatigue-summary — 403 for non-admin
 *   31. GET /admin/ranking/fatigue-summary — 200 with expected shape
 *   32. GET /admin/ranking/fatigue-summary — top_pairs ordered by fatigue_score descending
 *   33. GET /admin/ranking/fatigue-summary — config contains fatigueHalfLifeHours and fatigueThreshold
 *
 * Run:
 *   node --import tsx/esm --test src/test/adminRankingConfig.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminRankingMetricsRouter from "../routes/adminRankingMetrics.js";
import adminRankingConfigRouter  from "../routes/adminRankingConfig.js";
import {
  bucketScoreToTier,
  computeTierDistribution,
  computeConcentration,
} from "../routes/adminRankingMetrics.js";
import { validateConfigValue } from "../routes/adminRankingConfig.js";

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — pure functions, no HTTP server needed
// ─────────────────────────────────────────────────────────────────────────────

describe("bucketScoreToTier — boundary values", () => {
  it("score 0 → new_inactive",   () => assert.equal(bucketScoreToTier(0),   "new_inactive"));
  it("score 20 → new_inactive",  () => assert.equal(bucketScoreToTier(20),  "new_inactive"));
  it("score 21 → occasional",    () => assert.equal(bucketScoreToTier(21),  "occasional"));
  it("score 40 → occasional",    () => assert.equal(bucketScoreToTier(40),  "occasional"));
  it("score 41 → moderate",      () => assert.equal(bucketScoreToTier(41),  "moderate"));
  it("score 65 → moderate",      () => assert.equal(bucketScoreToTier(65),  "moderate"));
  it("score 66 → active",        () => assert.equal(bucketScoreToTier(66),  "active"));
  it("score 85 → active",        () => assert.equal(bucketScoreToTier(85),  "active"));
  it("score 86 → highly_active", () => assert.equal(bucketScoreToTier(86),  "highly_active"));
  it("score 100 → highly_active",() => assert.equal(bucketScoreToTier(100), "highly_active"));
});

describe("computeTierDistribution", () => {
  it("empty array returns all zeros", () => {
    const result = computeTierDistribution([]);
    assert.equal(result.highly_active, 0);
    assert.equal(result.active,        0);
    assert.equal(result.moderate,      0);
    assert.equal(result.occasional,    0);
    assert.equal(result.new_inactive,  0);
  });

  it("single highly-active score", () => {
    const result = computeTierDistribution([90]);
    assert.equal(result.highly_active, 1);
    assert.equal(result.new_inactive,  0);
  });

  it("even split across five tiers", () => {
    const result = computeTierDistribution([10, 30, 50, 70, 90]);
    // Each tier should get exactly 0.2 (1/5)
    assert.equal(result.highly_active, 0.2);
    assert.equal(result.active,        0.2);
    assert.equal(result.moderate,      0.2);
    assert.equal(result.occasional,    0.2);
    assert.equal(result.new_inactive,  0.2);
  });

  it("fractions sum close to 1 for varied inputs", () => {
    const result = computeTierDistribution([5, 25, 45, 70, 90, 90, 90]);
    const sum = result.highly_active + result.active + result.moderate +
                result.occasional + result.new_inactive;
    assert.ok(Math.abs(sum - 1) < 0.001, `Expected sum ~1, got ${sum}`);
  });
});

describe("computeConcentration", () => {
  it("empty array returns zeros and no alert", () => {
    const r = computeConcentration([]);
    assert.equal(r.top_1pct,  0);
    assert.equal(r.top_5pct,  0);
    assert.equal(r.top_10pct, 0);
    assert.equal(r.alert,     false);
  });

  it("single creator holds 100% of top-1/5/10 pct", () => {
    const r = computeConcentration([100]);
    assert.equal(r.top_1pct,  1);
    assert.equal(r.top_5pct,  1);
    assert.equal(r.top_10pct, 1);
  });

  it("alert fires when top-10% share exceeds default threshold of 60%", () => {
    // 10 creators: top 1 has score 90, rest have score 1 each.
    // top-10% = 1 creator = score 90 out of total 90+9=99 ≈ 90.9%
    const scores = [90, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const r = computeConcentration(scores);
    assert.ok(r.top_10pct > 0.6, `Expected top_10pct > 0.6, got ${r.top_10pct}`);
    assert.equal(r.alert, true);
  });

  it("alert does NOT fire when top-10% share is below threshold", () => {
    // 10 uniform creators — each holds exactly 10% of total impressions
    const scores = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const r = computeConcentration(scores);
    assert.ok(r.top_10pct <= 0.1 + 0.001, `Expected top_10pct ~0.1, got ${r.top_10pct}`);
    assert.equal(r.alert, false);
  });

  it("top_1pct ≤ top_5pct ≤ top_10pct", () => {
    const scores = [100, 80, 60, 40, 30, 20, 15, 10, 5, 2];
    const r = computeConcentration(scores);
    assert.ok(r.top_1pct  <= r.top_5pct,  "top_1pct should be <= top_5pct");
    assert.ok(r.top_5pct  <= r.top_10pct, "top_5pct should be <= top_10pct");
  });

  it("custom alert threshold is respected", () => {
    // Uniform 10 creators — top 10% holds 10% of impressions
    const scores = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
    const r = computeConcentration(scores, 0.05); // very tight threshold
    assert.equal(r.alert, true, "should alert when threshold is set below top-10pct share");
  });
});

describe("validateConfigValue", () => {
  it("rejects unknown key", () => {
    const err = validateConfigValue("ranking.unknown.key", 10);
    assert.ok(err !== null);
    assert.ok(err!.includes("Unknown config key"));
  });

  it("rejects value below min", () => {
    const err = validateConfigValue("ranking.weights.relevance", -1);
    assert.ok(err !== null);
    assert.ok(err!.includes("out of range"));
  });

  it("rejects value above max", () => {
    const err = validateConfigValue("ranking.weights.relevance", 101);
    assert.ok(err !== null);
    assert.ok(err!.includes("out of range"));
  });

  it("accepts value at lower boundary", () => {
    const err = validateConfigValue("ranking.weights.relevance", 0);
    assert.equal(err, null);
  });

  it("accepts value at upper boundary", () => {
    const err = validateConfigValue("ranking.weights.relevance", 100);
    assert.equal(err, null);
  });

  it("rejects NaN", () => {
    const err = validateConfigValue("ranking.weights.relevance", NaN);
    assert.ok(err !== null);
  });

  it("rejects Infinity", () => {
    const err = validateConfigValue("ranking.weights.relevance", Infinity);
    assert.ok(err !== null);
  });

  it("accepts mid-range value", () => {
    const err = validateConfigValue("ranking.caps.maxPerPage", 5);
    assert.equal(err, null);
  });

  it("rejects caps.maxPerPage above 20", () => {
    const err = validateConfigValue("ranking.caps.maxPerPage", 21);
    assert.ok(err !== null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP integration tests
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_TOKEN = "fake.jwt.token";
const ADMIN_ID   = "aaaaaaaa-0000-0000-0000-000000000001";

let server: http.Server;
let base: string;

function makeReq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r       = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${FAKE_TOKEN}`,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// ── Fake client helpers ───────────────────────────────────────────────────────

const AUDIT_LOG: any[] = [];
const CONFIG_ROWS: any[] = [
  { key: "ranking.weights.relevance", value: 35 },
  { key: "ranking.weights.freshness", value: 20 },
];
const FLAG_ROWS: any[] = [
  { flag: "RANKING_EXPERIMENT_ENABLED", enabled: false, description: "A/B ranking experiment", updated_at: "2026-01-01T00:00:00Z" },
];
const ACTIVITY_SCORE_ROWS: any[] = [
  { user_id: "u1", score: 90, spam_penalty: 25, repetition_penalty: 15, updated_at: "2026-07-01T00:00:00Z" },
  { user_id: "u2", score: 30, spam_penalty: 5,  repetition_penalty: 2,  updated_at: "2026-07-01T00:00:00Z" },
];
const DEBUG_SAMPLE_ROWS: any[] = [
  { id: "s1", surface: "discovery", content_type: "post", ranking_version: "1.0", sampled_at: "2026-07-20T00:00:00Z" },
  { id: "s2", surface: "pulse",     content_type: "post", ranking_version: "1.0", sampled_at: "2026-07-19T00:00:00Z" },
];

// Dynamic dates so gte/lt filters work correctly relative to "now" in the route
const NOW_MS = Date.now();
const daysAgo = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();

const VIEWER_ID_A  = "vvvvvvvv-0000-0000-0000-000000000001";
const CREATOR_ID_A = "cccccccc-0000-0000-0000-000000000001";
const VIEWER_ID_B  = "vvvvvvvv-0000-0000-0000-000000000002";
const CREATOR_ID_B = "cccccccc-0000-0000-0000-000000000002";

// expires_at within 24 h from NOW_MS so the expiring-in-24h count can be tested
const EXPIRES_SOON = new Date(NOW_MS + 12 * 60 * 60 * 1_000).toISOString();
const EXPIRES_LATE = new Date(NOW_MS + 72 * 60 * 60 * 1_000).toISOString();

// A past timestamp so the third row is already expired
const EXPIRES_PAST = new Date(NOW_MS - 2 * 60 * 60 * 1_000).toISOString(); // 2 h ago

const VIEWER_ID_C  = "vvvvvvvv-0000-0000-0000-000000000003";
const CREATOR_ID_C = "cccccccc-0000-0000-0000-000000000003";

const FATIGUE_ROWS: any[] = [
  // highest score — suppressed most aggressively, expiring soon (active)
  {
    viewer_id: VIEWER_ID_A, creator_id: CREATOR_ID_A,
    fatigue_score: 9.2, recent_impressions: 15,
    last_impression_at: daysAgo(1), expires_at: EXPIRES_SOON,
  },
  // second highest — expiring far in the future (active)
  {
    viewer_id: VIEWER_ID_B, creator_id: CREATOR_ID_B,
    fatigue_score: 4.1, recent_impressions: 6,
    last_impression_at: daysAgo(2), expires_at: EXPIRES_LATE,
  },
  // expired row — must NOT appear in total_active_rows or top_pairs
  {
    viewer_id: VIEWER_ID_C, creator_id: CREATOR_ID_C,
    fatigue_score: 7.0, recent_impressions: 20,
    last_impression_at: daysAgo(3), expires_at: EXPIRES_PAST,
  },
];

// rank_events rows: in-window (2 days ago) + one pre-window (15 days ago)
const RANK_EVENT_ROWS: any[] = [
  // new_viewer: recently joined, gets an impression in the window
  { outcome: "impression", item_kind: "post",  position: 0, surface: "discovery", user_id: "new_viewer",       served_at: daysAgo(2) },
  // old_viewer: existing user, had activity pre-window too
  { outcome: "tap",        item_kind: "post",  position: 1, surface: "discovery", user_id: "old_viewer",       served_at: daysAgo(2) },
  // returning_viewer: old user, no pre-window row, gets impression in window
  { outcome: "impression", item_kind: "event", position: 6, surface: "pulse",     user_id: "returning_viewer", served_at: daysAgo(2) },
  // old_viewer pre-window activity (15 days ago — between cutoffPreWindow and cutoff)
  { outcome: "impression", item_kind: "post",  position: 0, surface: "discovery", user_id: "old_viewer",       served_at: daysAgo(15) },
];

// profiles rows with created_at so the new-user query works
const PROFILE_ROWS: any[] = [
  { id: ADMIN_ID,          role: "admin",   username: "adminuser",        display_name: "Admin User",       created_at: daysAgo(60) },
  { id: "u1",              role: "member",  username: "user1",            display_name: "User One",         created_at: daysAgo(60), show_real_name: true  },
  { id: "u2",              role: "member",  username: "user2",            display_name: "User Two",         created_at: daysAgo(60), show_real_name: false },
  { id: "new_viewer",      role: "member",  username: "newviewer",        display_name: "New Viewer",       created_at: daysAgo(5)  },
  { id: "old_viewer",      role: "member",  username: "oldviewer",        display_name: "Old Viewer",       created_at: daysAgo(60) },
  { id: "returning_viewer",role: "member",  username: "returningviewer",  display_name: "Returning Viewer", created_at: daysAgo(60) },
  // fatigue-summary test identities
  { id: VIEWER_ID_A,       role: "member",  username: "viewer_a",         display_name: "Viewer A",         created_at: daysAgo(30) },
  { id: CREATOR_ID_A,      role: "member",  username: "creator_a",        display_name: "Creator A",        created_at: daysAgo(30) },
  { id: VIEWER_ID_B,       role: "member",  username: "viewer_b",         display_name: "Viewer B",         created_at: daysAgo(30) },
  { id: CREATOR_ID_B,      role: "member",  username: "creator_b",        display_name: "Creator B",        created_at: daysAgo(30) },
  { id: VIEWER_ID_C,       role: "member",  username: "viewer_c",         display_name: "Viewer C",         created_at: daysAgo(30) },
  { id: CREATOR_ID_C,      role: "member",  username: "creator_c",        display_name: "Creator C",        created_at: daysAgo(30) },
];

function makeFakeClient(isAdmin = true) {
  let _configRows = [...CONFIG_ROWS];

  function builder(rows: any[]) {
    let filtered = [...rows];
    const b: any = {
      select: (_cols: string) => b,
      eq:   (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
      // The route excludes ranking-analytics rows with .neq("outcome","analytics").
      // The stub must model the query the route actually makes: without this it
      // threw "neq is not a function" and the route 500'd — a fixture gap that
      // reads exactly like a production failure.
      neq:  (col: string, val: any) => { filtered = filtered.filter((r) => r[col] !== val); return b; },
      in:   (col: string, vals: any[]) => { filtered = filtered.filter((r) => vals.includes(r[col])); return b; },
      like: (col: string, pattern: string) => {
        const prefix = pattern.replace(/%$/, "");
        filtered = filtered.filter((r) => String(r[col] ?? "").startsWith(prefix));
        return b;
      },
      gte: (col: string, val: any) => {
        // Filter rows where the column value is >= val (works for ISO date strings)
        filtered = filtered.filter((r) => r[col] === undefined || r[col] >= val);
        return b;
      },
      lt: (col: string, val: any) => {
        // Filter rows where the column value is < val
        filtered = filtered.filter((r) => r[col] === undefined || r[col] < val);
        return b;
      },
      order: (_c: string, _o?: any) => b,
      limit: (_n: number) => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: (v: any) => void) => Promise.resolve({ data: filtered, error: null }).then(resolve),
    };
    return b;
  }

  const client: any = {
    from: (table: string) => {
      if (table === "profiles") {
        const rows = PROFILE_ROWS.map((r) => ({
          ...r,
          role: r.id === ADMIN_ID ? (isAdmin ? "admin" : "member") : r.role,
        }));
        return builder(rows);
      }
      if (table === "rank_events") {
        return builder(RANK_EVENT_ROWS);
      }
      if (table === "ranking_config") {
        let _filtered = [..._configRows];
        const b: any = {
          select: (_c: string) => b,
          like:   (col: string, pattern: string) => {
            const prefix = pattern.replace(/%$/, "");
            _filtered = _filtered.filter((r) => String(r[col] ?? "").startsWith(prefix));
            return b;
          },
          order:  (_c: string) => b,
          in:     (col: string, vals: any[]) => {
            _filtered = _filtered.filter((r) => vals.includes(r[col]));
            return b;
          },
          eq:     (col: string, val: any) => {
            const matched = _configRows.filter((r) => r[col] === val);
            return {
              maybeSingle: () => Promise.resolve({ data: matched[0] ?? null, error: null }),
            };
          },
          upsert: (row: any) => {
            _configRows = _configRows.filter((r) => r.key !== row.key);
            _configRows.push(row);
            return Promise.resolve({ error: null });
          },
          then: (resolve: (v: any) => void) =>
            Promise.resolve({ data: _filtered, error: null }).then(resolve),
        };
        return b;
      }
      if (table === "feature_flags") {
        const rows = FLAG_ROWS.map((r) => ({ ...r }));
        const b = builder(rows);
        // Add update support for the flag toggle route
        b.update = (_patch: any) => ({
          eq: (_col: string, _val: any) => Promise.resolve({ error: null }),
        });
        return b;
      }
      if (table === "creator_activity_scores") {
        const b: any = {
          select: (_c: string) => b,
          order:  (_c: string, _o?: any) => b,
          gte:    (_c: string, _v: any) => b,
          limit:  (_n: number) => b,
          then: (resolve: (v: any) => void) =>
            Promise.resolve({ data: ACTIVITY_SCORE_ROWS, error: null }).then(resolve),
        };
        return b;
      }
      if (table === "content_distribution_stats") {
        return {
          select: () => ({ in: () => ({ then: (r: any) => Promise.resolve({ data: [], error: null }).then(r) }) }),
        };
      }
      if (table === "profile_privacy_settings") {
        return builder([
          { user_id: "u1", show_real_name: true },
          { user_id: "u2", show_real_name: false },
        ]);
      }
      if (table === "ranking_debug_samples") {
        let filtered = [...DEBUG_SAMPLE_ROWS];
        const b: any = {
          select: (_c: string) => b,
          order:  (_c: string, _o?: any) => b,
          limit:  (_n: number) => b,
          eq:     (col: string, val: any) => { filtered = filtered.filter((r) => r[col] === val); return b; },
          then:   (resolve: (v: any) => void) =>
            Promise.resolve({ data: filtered, error: null }).then(resolve),
        };
        return b;
      }
      if (table === "viewer_creator_fatigue") {
        // Support select with count:"exact"+head:true (returns { count, data, error })
        // and a regular data select with order/limit/filter chains.
        let filtered = [...FATIGUE_ROWS];
        let _isHead  = false;
        let _count   = FATIGUE_ROWS.length;
        const b: any = {
          select: (_cols: string, opts?: any) => {
            if (opts?.head)  _isHead = true;
            if (opts?.count === "exact") _count = filtered.length;
            return b;
          },
          gt: (col: string, val: any) => {
            filtered = filtered.filter((r) => r[col] != null && r[col] > val);
            _count = filtered.length;
            return b;
          },
          gte: (col: string, val: any) => {
            filtered = filtered.filter((r) => r[col] != null && r[col] >= val);
            _count = filtered.length;
            return b;
          },
          lte: (col: string, val: any) => {
            filtered = filtered.filter((r) => r[col] <= val);
            _count = filtered.length;
            return b;
          },
          not: (_col: string, _op: string, _val: any) => {
            // filter out rows with null expires_at
            filtered = filtered.filter((r) => r.expires_at != null);
            _count = filtered.length;
            return b;
          },
          order: (_c: string, _o?: any) => b,
          limit: (_n: number) => b,
          then: (resolve: (v: any) => void) => {
            const result = _isHead
              ? { data: null, error: null, count: _count }
              : { data: filtered, error: null, count: _count };
            return Promise.resolve(result).then(resolve);
          },
        };
        return b;
      }
      if (table === "feature_flag_audit_log" || table === "ranking_config_audit_log") {
        return {
          insert: (row: any) => {
            AUDIT_LOG.push({ table, ...row });
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "job_health") {
        return builder([
          { job: "creator_activity_score",           last_run_at: "2026-07-25T00:00:00Z", metadata: {} },
          { job: "content_distribution_aggregation", last_run_at: "2026-07-25T00:00:00Z", metadata: {} },
        ]);
      }
      // Catch-all: return empty builder
      return builder([]);
    },
    auth: {
      getUser: (_token: string) =>
        Promise.resolve({ data: { user: { id: ADMIN_ID } }, error: null }),
    },
  };

  return client;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminRankingMetricsRouter);
  app.use(adminRankingConfigRouter);

  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close();
});

// ── Metrics endpoint ──────────────────────────────────────────────────────────

describe("GET /admin/ranking/metrics", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/metrics");
    assert.equal(status, 403);
  });

  it("returns 200 with expected shape for admin", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/metrics");
    assert.equal(status, 200);

    // Backward-compatible fields
    assert.ok(typeof body.period_days === "number");
    assert.ok(typeof body.impressions === "number");
    assert.ok(typeof body.tap_through_rate === "number");
    assert.ok(body.tap_through_by_kind != null);
    assert.ok(body.exploration_slot != null);
    assert.ok(body.by_surface != null);

    // New fields
    assert.ok(body.exposure_by_tier != null, "exposure_by_tier missing");
    assert.ok(typeof body.exposure_by_tier.highly_active === "number");
    assert.ok(body.creator_concentration != null, "creator_concentration missing");
    assert.ok(typeof body.creator_concentration.top_10pct === "number");
    assert.ok(typeof body.creator_concentration.alert === "boolean");
    assert.ok(typeof body.new_user_exposure_rate === "number");
    assert.ok(body.new_user_exposure_rate > 0,
      `new_user_exposure_rate should be > 0, got ${body.new_user_exposure_rate}`);
    assert.ok(typeof body.returning_user_recovery_rate === "number");
    assert.ok(body.returning_user_recovery_rate > 0,
      `returning_user_recovery_rate should be > 0, got ${body.returning_user_recovery_rate}`);
    assert.ok(typeof body.underexposed_content_rate === "number");
    assert.ok(body.diversity != null, "diversity missing");
    assert.ok(body.negative_feedback != null, "negative_feedback missing");
    assert.ok(typeof body.ranking_version === "string", "ranking_version missing");
    assert.ok(typeof body.experiment_enabled === "boolean", "experiment_enabled missing");
    assert.ok(body.spam_risk != null, "spam_risk missing");
    assert.ok(typeof body.spam_risk.high_spam_count === "number");
    assert.ok(body.job_health != null, "job_health missing");
  });
});

// ── Config endpoint ───────────────────────────────────────────────────────────

describe("GET /admin/ranking/config", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/config");
    assert.equal(status, 403);
  });

  it("returns 200 with config map for admin", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/config");
    assert.equal(status, 200);
    assert.ok(body.config != null);
    // Spot-check a known key
    assert.ok(body.config["ranking.weights.relevance"] != null);
    assert.ok(typeof body.config["ranking.weights.relevance"].description === "string");
  });
});

describe("PUT /admin/ranking/config", () => {
  it("returns 400 for unknown config key", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("PUT", "/admin/ranking/config", {
      key: "ranking.unknown.key",
      value: 10,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "validation_error");
  });

  it("returns 400 for out-of-range value", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("PUT", "/admin/ranking/config", {
      key: "ranking.weights.relevance",
      value: 150,
    });
    assert.equal(status, 400);
    assert.equal(body.error, "validation_error");
  });

  it("returns 200 on valid update", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("PUT", "/admin/ranking/config", {
      key: "ranking.weights.relevance",
      value: 40,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.key, "ranking.weights.relevance");
    assert.equal(body.value, 40);
  });
});

// ── Flags endpoint ────────────────────────────────────────────────────────────

describe("GET /admin/ranking/flags", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/flags");
    assert.equal(status, 403);
  });

  it("returns 200 with flags array for admin", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/flags");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.flags));
    // Our fake data has one RANKING_ flag
    const expFlag = body.flags.find((f: any) => f.flag === "RANKING_EXPERIMENT_ENABLED");
    assert.ok(expFlag != null, "RANKING_EXPERIMENT_ENABLED flag should be present");
  });
});

describe("PUT /admin/ranking/flags/:key", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq(
      "PUT", "/admin/ranking/flags/RANKING_EXPERIMENT_ENABLED", { enabled: true },
    );
    assert.equal(status, 403);
  });

  it("returns 400 when flag key lacks RANKING_ prefix", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status } = await makeReq(
      "PUT", "/admin/ranking/flags/COMPASS_ENABLED", { enabled: true },
    );
    assert.equal(status, 400);
  });

  it("returns 404 for unknown flag", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status } = await makeReq(
      "PUT", "/admin/ranking/flags/RANKING_NONEXISTENT", { enabled: true },
    );
    assert.equal(status, 404);
  });

  it("returns 200 and writes audit log on success", async () => {
    AUDIT_LOG.length = 0; // reset
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq(
      "PUT", "/admin/ranking/flags/RANKING_EXPERIMENT_ENABLED", { enabled: true },
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.flag, "RANKING_EXPERIMENT_ENABLED");
    assert.equal(body.new_enabled, true);
  });
});

// ── Suspicious endpoint ───────────────────────────────────────────────────────

describe("GET /admin/ranking/suspicious", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/suspicious");
    assert.equal(status, 403);
  });

  it("returns 200 with suspicious users and score breakdown", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/suspicious");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.suspicious));
    if (body.suspicious.length > 0) {
      const first = body.suspicious[0];
      assert.ok("user_id" in first, "user_id should be present");
      assert.ok("spam_penalty" in first, "spam_penalty should be present");
      assert.ok("repetition_penalty" in first, "repetition_penalty should be present");
      // display_name is gated by show_real_name — user u1 has show_real_name=true
      // so display_name may be present; u2 should not expose it
    }
  });
});

// ── Debug samples endpoint ────────────────────────────────────────────────────

describe("GET /admin/ranking/debug-samples", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/debug-samples");
    assert.equal(status, 403);
  });

  it("returns 200 with samples array", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/debug-samples");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.samples));
    assert.ok(typeof body.limit === "number");
  });

  it("respects surface filter", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq(
      "GET", "/admin/ranking/debug-samples?surface=discovery",
    );
    assert.equal(status, 200);
    // All returned samples should be from the discovery surface
    for (const s of body.samples) {
      assert.equal(s.surface, "discovery");
    }
  });
});

// ── Fatigue summary endpoint ──────────────────────────────────────────────────

describe("GET /admin/ranking/fatigue-summary", () => {
  it("returns 403 for non-admin", async () => {
    _setTestClient(makeFakeClient(false), true);
    const { status } = await makeReq("GET", "/admin/ranking/fatigue-summary");
    assert.equal(status, 403);
  });

  it("returns 200 with expected shape for admin", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/fatigue-summary");
    assert.equal(status, 200);

    assert.ok(typeof body.total_active_rows === "number", "total_active_rows missing");
    assert.ok(typeof body.expiring_in_24h   === "number", "expiring_in_24h missing");
    assert.ok(Array.isArray(body.top_pairs),              "top_pairs should be an array");
    assert.ok(body.config != null,                        "config missing");
    assert.ok(typeof body.config.fatigueHalfLifeHours === "number", "fatigueHalfLifeHours missing");
    assert.ok(typeof body.config.fatigueThreshold      === "number", "fatigueThreshold missing");
  });

  it("top_pairs are ordered by fatigue_score descending", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/fatigue-summary");
    assert.equal(status, 200);

    const pairs: any[] = body.top_pairs;
    assert.ok(pairs.length >= 2, "Expected at least 2 pairs from fake data");

    // Each pair must carry the required fields
    const first = pairs[0];
    assert.ok("viewer_id"          in first, "viewer_id missing from pair");
    assert.ok("creator_id"         in first, "creator_id missing from pair");
    assert.ok("fatigue_score"      in first, "fatigue_score missing from pair");
    assert.ok("recent_impressions" in first, "recent_impressions missing from pair");
    assert.ok("last_impression_at" in first, "last_impression_at missing from pair");

    // Highest score must come first
    assert.ok(
      first.fatigue_score >= pairs[1].fatigue_score,
      `Expected pairs sorted descending, got ${first.fatigue_score} then ${pairs[1].fatigue_score}`,
    );
  });

  it("config falls back to defaults when ranking_config has no fatigue keys", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/fatigue-summary");
    assert.equal(status, 200);
    // Our fake ranking_config rows don't include fatigueHalfLifeHours/fatigueThreshold,
    // so the endpoint should fall back to the documented defaults: 48 and 5.
    assert.equal(body.config.fatigueHalfLifeHours, 48);
    assert.equal(body.config.fatigueThreshold,      5);
  });

  it("excludes expired rows from total_active_rows and top_pairs", async () => {
    _setTestClient(makeFakeClient(true), true);
    const { status, body } = await makeReq("GET", "/admin/ranking/fatigue-summary");
    assert.equal(status, 200);

    // FATIGUE_ROWS has 3 rows: 2 active (expires_at in the future) + 1 expired.
    // total_active_rows must reflect only the 2 active rows.
    assert.equal(
      body.total_active_rows, 2,
      `Expected 2 active rows (excluding expired), got ${body.total_active_rows}`,
    );

    // top_pairs must not include the expired viewer_c / creator_c pair.
    const expiredViewerPresent = (body.top_pairs as any[]).some(
      (p: any) => p.viewer_id === VIEWER_ID_C,
    );
    assert.equal(
      expiredViewerPresent, false,
      "Expired pair (VIEWER_ID_C) must not appear in top_pairs",
    );

    // The expired pair had the second-highest fatigue_score (7.0) — verify it
    // hasn't slipped into the results even though its score is high.
    const expiredCreatorPresent = (body.top_pairs as any[]).some(
      (p: any) => p.creator_id === CREATOR_ID_C,
    );
    assert.equal(
      expiredCreatorPresent, false,
      "Expired creator (CREATOR_ID_C) must not appear in top_pairs",
    );
  });
});
