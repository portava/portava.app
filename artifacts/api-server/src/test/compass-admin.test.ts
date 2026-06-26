/**
 * Compass Phase 6 — Admin & Ops tests
 *
 * Tests cover:
 *   1.  runSandbox — fixture safety filter is enforced (unsafe item blocked)
 *   2.  runSandbox — returns expected result shape for all four user types
 *   3.  runSandbox — null db is accepted without error
 *   4.  buildFallbackFeed — returns fallback:true with empty sections
 *   5.  buildFallbackFeed — null db short-circuits to empty safeItems
 *   6.  isFallbackModeEnabled — returns false when flag is off
 *   7.  isFallbackModeEnabled — returns true when flag is on
 *   8.  isFallbackModeEnabled — returns false on DB error (fail-open)
 *   9.  Admin dashboard — 403 if not admin
 *  10.  Admin dashboard — 200 with expected shape for admin
 *  11.  POST /admin/compass/weights — 201 with weightSet object
 *  12.  POST /admin/compass/weights — 400 on missing name
 *  13.  PATCH /admin/compass/weights/:id — 200 with weightSet object
 *  14.  POST /admin/compass/version — 201 with version object
 *  15.  POST /admin/compass/rollback — 200 with rollback + fromVersion
 *  16.  POST /admin/compass/rebuild-cache — 200 ok:true
 *  17.  PATCH /admin/compass/frontload-rules — 200 with updated array
 *  18.  POST .../remove-boost-eligibility — 200 boostEligible:false
 *  19.  POST .../restore-boost-eligibility — 200 boostEligible:true
 *  20.  POST /admin/compass/testing-sandbox/preview — sandbox shape + unsafe item blocked
 *
 * Run: node --import tsx/esm --test src/test/compass-admin.test.ts
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import adminCompassRouter from "../routes/adminCompass.js";
import { runSandbox } from "../compass/CompassTestingSandbox.js";
import {
  buildFallbackFeed,
  isFallbackModeEnabled,
} from "../compass/CompassFallbackFeedBuilder.js";

// ── Test server ───────────────────────────────────────────────────────────────

let server: http.Server;
let base: string;
const FAKE_TOKEN = "fake.jwt.token";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(adminCompassRouter);
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

// ── HTTP helper ───────────────────────────────────────────────────────────────

function req(
  method:  string,
  path:    string,
  body?:   unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url     = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname,
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

// ── Fake client builder ───────────────────────────────────────────────────────

type FakeRows = Record<string, unknown>[];
type TableOverrides = Record<string, { data?: FakeRows | null; error?: { message: string } | null; count?: number }>;

function makeFakeClient(role: "admin" | "user" = "admin", tables: TableOverrides = {}) {
  function builder(tableKey: string) {
    const entry = tables[tableKey] ?? { data: [], error: null };
    let _rows: any[] = Array.isArray(entry.data) ? [...entry.data] : [];
    const b: any = {
      select:      (..._: any[]) => b,
      insert:      (data: any) => { _rows = Array.isArray(data) ? data : [data]; return b; },
      update:      (data: any) => { _rows = _rows.map((r: any) => ({ ...r, ...data })); return b; },
      delete:      () => { _rows = []; return b; },
      upsert:      (data: any) => { const d = Array.isArray(data) ? data : [data]; _rows = d; return b; },
      eq:          (..._: any[]) => b,
      neq:         (..._: any[]) => b,
      in:          (..._: any[]) => b,
      is:          (..._: any[]) => b,
      ilike:       (..._: any[]) => b,
      like:        (..._: any[]) => b,
      or:          (..._: any[]) => b,
      gte:         (..._: any[]) => b,
      gt:          (..._: any[]) => b,
      lt:          (..._: any[]) => b,
      lte:         (..._: any[]) => b,
      not:         (..._: any[]) => b,
      order:       (..._: any[]) => b,
      limit:       (..._: any[]) => b,
      range:       (..._: any[]) => b,
      maybeSingle: () => Promise.resolve({ data: _rows[0] ?? null, error: entry.error ?? null }),
      single:      () => Promise.resolve({ data: _rows[0] ?? null, error: entry.error ?? null, count: null }),
      then:        (resolve: any) =>
        Promise.resolve({ data: _rows, error: entry.error ?? null, count: entry.count ?? _rows.length }).then(resolve),
    };
    return b;
  }

  return {
    from: (table: string) => {
      if (table === "profiles") return builder("__profiles__");
      return builder(table);
    },
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: "admin-uid" } }, error: null }),
    },
    // profiles is always resolved to the given role (not overridable via tables)
    _role: role,
  } as any;
}

/**
 * Build a full fake client with role + per-table overrides.
 * Profiles always return the given role so requireAdmin passes/fails correctly.
 */
function makeAdminClient(role: "admin" | "user" = "admin", tables: TableOverrides = {}) {
  const inner = makeFakeClient(role, tables);

  // Override the profiles table to always return the role
  const origFrom = inner.from.bind(inner);
  inner.from = (table: string) => {
    if (table === "profiles") {
      const b: any = {
        select:      (..._: any[]) => b,
        eq:          (..._: any[]) => b,
        maybeSingle: () =>
          Promise.resolve({ data: { id: "admin-uid", role }, error: null }),
        then:        (resolve: any) =>
          Promise.resolve({ data: [{ id: "admin-uid", role }], error: null, count: 1 }).then(resolve),
      };
      return b;
    }
    return origFrom(table);
  };
  return inner;
}

/** Set both test client slots to the same fake client. */
function setClients(role: "admin" | "user" = "admin", tables: TableOverrides = {}) {
  const c = makeAdminClient(role, tables);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

// ── Default table stubs for admin tests ──────────────────────────────────────

const WEIGHT_SET_ROW = {
  id:          "ws-1",
  name:        "Test",
  description: null,
  weights:     {},
  is_active:   false,
  created_at:  new Date().toISOString(),
  updated_at:  new Date().toISOString(),
};

const VERSION_ROW = {
  id:             "av-1",
  version_tag:    "v1",
  rollout_status: "active",
  launched_at:    new Date().toISOString(),
};

const ROLLBACK_ROW = {
  id:              "rb-1",
  from_version_id: "av-1",
  to_version_id:   null,
  created_at:      new Date().toISOString(),
};

// =============================================================================
// 1–3: runSandbox (pure function — no HTTP)
// =============================================================================

describe("runSandbox", () => {
  test("1. unsafe item (hasAdultServiceFlag) is blocked by safety filter", async () => {
    const result = await runSandbox(null, { userType: "traveler", city: "Bangkok", intentMode: "explore_now" });
    const blocked = result.safetyFilters.find((h) => h.itemId === "fixture-unsafe-1");
    assert.ok(blocked, "fixture-unsafe-1 should be blocked by safety filter");
    assert.ok(result.safetyFilters.length >= 1, "at least one item should be safety-filtered");
  });

  test("2. returns expected result shape for all four user types", async () => {
    for (const userType of ["traveler", "buddy", "new_user", "creator"] as const) {
      const result = await runSandbox(null, { userType, city: "Tokyo", intentMode: "explore_now" });
      assert.ok(typeof result.feed === "object",            `${userType}: feed should be object`);
      assert.ok(Array.isArray(result.rankingReasons),       `${userType}: rankingReasons should be array`);
      assert.ok(Array.isArray(result.hiddenReasons),        `${userType}: hiddenReasons should be array`);
      assert.ok(Array.isArray(result.safetyFilters),        `${userType}: safetyFilters should be array`);
      assert.ok(typeof result.diversityMix === "object",    `${userType}: diversityMix should be object`);
      assert.ok(Array.isArray(result.activeRewards),        `${userType}: activeRewards should be array`);
      assert.ok(Array.isArray(result.frontLoadPlan),        `${userType}: frontLoadPlan should be array`);
      assert.ok(typeof result.estimatedLoadMs === "number", `${userType}: estimatedLoadMs should be number`);
    }
  });

  test("3. null db is accepted and produces a result without throwing", async () => {
    const result = await runSandbox(null, { userType: "new_user", city: "Lisbon", intentMode: "plan_ahead" });
    assert.ok(result, "result should be returned");
    assert.ok(result.estimatedLoadMs >= 0, "timing should be non-negative");
  });
});

// =============================================================================
// 4–5: buildFallbackFeed (pure function — no HTTP)
// =============================================================================

describe("buildFallbackFeed", () => {
  test("4. returns fallback:true with empty sections array", async () => {
    const result = await buildFallbackFeed(null, "user-1", null, "test_reason");
    assert.equal(result.fallback, true);
    assert.deepEqual(result.sections, []);
    assert.equal(result.nextCursor, null);
    assert.equal(result.fallbackReason, "test_reason");
  });

  test("5. null db short-circuits to empty safeItems without throwing", async () => {
    const result = await buildFallbackFeed(null, "user-1", null, "null_db");
    assert.ok(Array.isArray(result.safeItems), "safeItems should be array");
    assert.equal(result.safeItems.length, 0, "null db should return empty safeItems");
  });
});

// =============================================================================
// 6–8: isFallbackModeEnabled (pure function — no HTTP)
// =============================================================================

describe("isFallbackModeEnabled", () => {
  test("6. returns false when flag is disabled", async () => {
    const client = makeAdminClient("admin", {
      feature_flags: { data: [{ flag: "COMPASS_FALLBACK_MODE_ENABLED", enabled: false }] },
    });
    const result = await isFallbackModeEnabled(client as any);
    assert.equal(result, false);
  });

  test("7. returns true when flag is enabled", async () => {
    const client = makeAdminClient("admin", {
      feature_flags: { data: [{ flag: "COMPASS_FALLBACK_MODE_ENABLED", enabled: true }] },
    });
    const result = await isFallbackModeEnabled(client as any);
    assert.equal(result, true);
  });

  test("8. returns false on DB error (fail-open)", async () => {
    const client = makeAdminClient("admin", {
      feature_flags: { data: null, error: { message: "connection timeout" } },
    });
    const result = await isFallbackModeEnabled(client as any);
    assert.equal(result, false, "should fail-open to false on DB error");
  });
});

// =============================================================================
// 9–20: Admin routes (HTTP)
// =============================================================================

describe("admin compass routes", () => {
  test("9. GET /admin/compass/dashboard — 403 if not admin", async () => {
    setClients("user");
    const { status } = await req("GET", "/admin/compass/dashboard");
    assert.equal(status, 403);
  });

  test("10. GET /admin/compass/dashboard — 200 with expected shape for admin", async () => {
    setClients("admin", {
      compass_abuse_flags:             { data: [] },
      compass_safety_filter_logs:      { data: [] },
      compass_feed_cache:              { data: [], count: 0 },
      compass_active_user_scores:      { data: [] },
      compass_notification_decisions:  { data: [] },
      compass_algorithm_versions:      { data: [VERSION_ROW] },
      compass_feedback_events:         { data: [] },
      user_location_state:             { data: [] },
      posts:                           { data: [], count: 0 },
      rent_buddy_profiles:             { data: [], count: 0 },
    });
    const { status, body } = await req("GET", "/admin/compass/dashboard");
    assert.equal(status, 200);
    assert.ok("generatedAt"         in body, "should have generatedAt");
    assert.ok("windowDays"          in body, "should have windowDays");
    assert.ok("abuse"               in body, "should have abuse block");
    assert.ok("safetyFilterFires"   in body, "should have safetyFilterFires");
    assert.ok("cache"               in body, "should have cache block");
    assert.ok("topBoostedUsers"     in body, "should have topBoostedUsers");
    assert.ok("notifications"       in body, "should have notifications block");
    assert.ok("feedbackRates"       in body, "should have feedbackRates");
    assert.ok("citySupplyDemand"    in body, "should have citySupplyDemand");
    assert.ok("delayedPosts"        in body, "should have delayedPosts");
    assert.ok("overexposedUsers"    in body, "should have overexposedUsers");
    assert.ok("newUserExposure"     in body, "should have newUserExposure");
    assert.ok("categoriesShown"     in body, "should have categoriesShown");
    assert.ok("feedPerformance"     in body, "should have feedPerformance");
    assert.ok("buddyExposure"       in body, "should have buddyExposure");
    assert.ok("eventCompletion"     in body, "should have eventCompletion");
    assert.ok(Array.isArray(body.categoriesShown?.sections), "categoriesShown.sections should be array");
    assert.ok(body.categoriesShown.total > 0, "categoriesShown.total should be > 0");
    assert.ok("preloadHitRatePct"   in body.feedPerformance, "should have preloadHitRatePct");
    assert.ok("clickRatePct"        in body.feedPerformance, "should have clickRatePct");
    assert.ok("feedLoadTimeMsNote"  in body.feedPerformance, "should have feedLoadTimeMsNote");
  });

  test("11. POST /admin/compass/weights — 201 with weightSet", async () => {
    setClients("admin", {
      compass_admin_weight_sets: { data: [WEIGHT_SET_ROW] },
      compass_admin_actions:     { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/admin/compass/weights",
      { name: "Test Weights", description: "Phase 6 set", weights: { event: 1.5, buddy: 1.2 } },
    );
    assert.equal(status, 201);
    assert.ok(body.weightSet, "should return weightSet");
  });

  test("12. POST /admin/compass/weights — 400 on missing name", async () => {
    setClients("admin");
    const { status } = await req("POST", "/admin/compass/weights", { weights: { event: 1.5 } });
    assert.equal(status, 400);
  });

  test("13. PATCH /admin/compass/weights/:id — 200 with weightSet", async () => {
    setClients("admin", {
      compass_admin_weight_sets: { data: [WEIGHT_SET_ROW] },
      compass_admin_actions:     { data: [] },
    });
    const { status, body } = await req(
      "PATCH",
      "/admin/compass/weights/ws-1",
      { name: "Updated Weights" },
    );
    assert.equal(status, 200);
    assert.ok(body.weightSet, "should return weightSet");
  });

  test("14. POST /admin/compass/version — 201 with version object", async () => {
    setClients("admin", {
      compass_algorithm_versions:  { data: [VERSION_ROW] },
      compass_admin_weight_sets:   { data: [WEIGHT_SET_ROW] },
      compass_admin_actions:       { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/api/admin/compass/version",
      { weightSetId: "00000000-0000-0000-0000-000000000001", versionTag: "v2.0" },
    );
    // path is /admin/compass/version (no /api prefix in test server)
    const { status: s2, body: b2 } = await req(
      "POST",
      "/admin/compass/version",
      { weightSetId: "00000000-0000-0000-0000-000000000001", versionTag: "v2.0", notes: "Phase 6" },
    );
    assert.equal(s2, 201);
    assert.ok(b2.version, "should return version");
  });

  test("15. POST /admin/compass/rollback — 200 with rollback + fromVersion", async () => {
    setClients("admin", {
      compass_algorithm_versions: { data: [VERSION_ROW] },
      compass_rollbacks:          { data: [ROLLBACK_ROW] },
      compass_admin_weight_sets:  { data: [WEIGHT_SET_ROW] },
      compass_admin_actions:      { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/admin/compass/rollback",
      { reason: "scoring regression" },
    );
    assert.equal(status, 200);
    assert.ok("fromVersion" in body, "should have fromVersion");
    assert.ok("rollback"    in body, "should have rollback");
  });

  test("16. POST /admin/compass/rebuild-cache — 200 ok:true", async () => {
    setClients("admin", {
      compass_feed_cache:    { data: [], count: 0 },
      compass_admin_actions: { data: [] },
    });
    const { status, body } = await req("POST", "/admin/compass/rebuild-cache");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test("17. PATCH /admin/compass/frontload-rules — 200 with updated array", async () => {
    setClients("admin", {
      feature_flags:         { data: [{ flag: "COMPASS_V2_AB_ENABLED", enabled: true }] },
      compass_admin_actions: { data: [] },
    });
    const { status, body } = await req(
      "PATCH",
      "/admin/compass/frontload-rules",
      { rules: [{ flag: "COMPASS_V2_AB_ENABLED", enabled: true }] },
    );
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.updated), "should return updated array");
    assert.equal(body.updated.length, 1);
  });

  test("18. POST .../remove-boost-eligibility — 200 boostEligible:false", async () => {
    setClients("admin", {
      compass_active_user_scores: { data: [{ user_id: "target-1", boost_eligible: false }] },
      compass_feed_cache:         { data: [] },
      compass_cache_invalidations: { data: [] },
      compass_admin_actions:      { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/admin/compass/users/target-1/remove-boost-eligibility",
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.boostEligible, false);
    assert.equal(body.userId, "target-1");
  });

  test("19. POST .../restore-boost-eligibility — 200 boostEligible:true", async () => {
    setClients("admin", {
      compass_active_user_scores:  { data: [{ user_id: "target-1", boost_eligible: true }] },
      compass_feed_cache:          { data: [] },
      compass_cache_invalidations: { data: [] },
      compass_admin_actions:       { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/admin/compass/users/target-1/restore-boost-eligibility",
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.boostEligible, true);
  });

  test("20. POST /admin/compass/testing-sandbox/preview — shape + unsafe item blocked", async () => {
    setClients("admin", {
      compass_admin_actions:      { data: [] },
      compass_testing_scenarios:  { data: [] },
    });
    const { status, body } = await req(
      "POST",
      "/admin/compass/testing-sandbox/preview",
      { userType: "traveler", city: "Bangkok", intentMode: "explore_now" },
    );
    assert.equal(status, 200);
    assert.ok(typeof body.feed === "object",            "should have feed object");
    assert.ok(Array.isArray(body.rankingReasons),       "should have rankingReasons array");
    assert.ok(Array.isArray(body.safetyFilters),        "should have safetyFilters array");
    assert.ok(Array.isArray(body.frontLoadPlan),        "should have frontLoadPlan array");
    assert.ok(typeof body.estimatedLoadMs === "number", "should have estimatedLoadMs number");
    const blocked = (body.safetyFilters as any[]).find((h) => h.itemId === "fixture-unsafe-1");
    assert.ok(blocked, "fixture-unsafe-1 must be safety-filtered in sandbox preview");
  });
});
