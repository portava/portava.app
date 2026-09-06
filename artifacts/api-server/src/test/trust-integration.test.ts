/**
 * Trust Score Engine — integration + route tests
 *
 * Two layers:
 *   1. Service-layer chains (node:test + fake client, no HTTP)
 *   2. HTTP route tests  (trust-admin.ts mounted on a real Express server,
 *      fake client injected via _setTestClient/_setTestServiceClient)
 *
 * Run: node --import tsx/esm --test src/test/trust-integration.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import trustAdminRouter from "../routes/trust-admin.js";

import { recordTrustEvent, recordAdjudicatedTrustEvent } from "../services/trust/TrustEventService.js";
import { recalculateTrustScore, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { getActiveCaps } from "../services/trust/TrustCapService.js";
import { getRestrictionState } from "../services/trust/TrustRestrictionService.js";
import {
  confirmEvent, dismissEvent,
  adminApplyRestriction, adminLiftRestriction,
  adminOverrideScore, adminRemoveOverride,
  getPendingEvents, getOpenReviews,
  revokeModerationTrustConsequences,
} from "../services/trust/TrustAdminService.js";
import { getSafeTrustSummary, getPublicTrustBadge } from "../services/trust/TrustPrivacyGuard.js";
import { getRecoveryStatus } from "../services/trust/TrustRecoveryService.js";
import { runGamingDetectionScan } from "../services/trust/TrustGamingDetectionService.js";
import { runTrustMaintenance } from "../lib/trustMaintenanceScheduler.js";

// ── Fake users ────────────────────────────────────────────────────────────────

const ADMIN   = "admin-int-001";
const USER_A  = "00000000-0000-0000-0000-000000000a01";  // valid UUIDs for route tests
const USER_B  = "00000000-0000-0000-0000-000000000b01";
const USER_C  = "00000000-0000-0000-0000-000000000c01";

// ── Shared fake-client factory (service-layer tests) ─────────────────────────

interface FakeTables {
  feature_flags:       any[];
  trust_settings:      any[];
  trust_events:        any[];
  trust_caps:          any[];
  trust_restrictions:  any[];
  trust_profiles:      any[];
  trust_reviews:       any[];
  trust_admin_actions: any[];
  plan_attendance_events: any[];
}

function makeTrustClient(tables: FakeTables) {
  let idCounter = 1;
  function nextId() { return `integ-${idCounter++}`; }

  function from(table: keyof FakeTables) {
    const store = tables[table] as any[];
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    let limitN: number | null = null;
    let isCount = false;

    const builder: any = {
      select(_f?: string, opts?: any) { if (opts?.count === "exact") isCount = true; return builder; },
      insert(row: any) {
        const r = { id: nextId(), created_at: new Date().toISOString(), ...row };
        store.push(r); pendingInsert = r; return builder;
      },
      upsert(row: any, opts?: any) {
        const key = opts?.onConflict ?? "id";
        const idx = store.findIndex((r) => r[key] === (row as any)[key]);
        if (idx >= 0) { store[idx] = { ...store[idx], ...row }; pendingInsert = store[idx]; }
        else { const r = { id: nextId(), created_at: new Date().toISOString(), ...row }; store.push(r); pendingInsert = r; }
        return builder;
      },
      update(p: any) { pendingUpdate = p; return builder; },
      delete()       { pendingDelete = true; return builder; },
      eq(c: string, v: any)    { filters.push((r) => r[c] === v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      is(c: string, v: any)    { filters.push((r) => v === null ? r[c] == null : r[c] === v); return builder; },
      gt(c: string, v: any)    { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any)    { filters.push((r) => r[c] < v); return builder; },
      not(c: string, _op: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      or() { return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      range() { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function matched() {
      let rows = store.filter((r) => filters.every((f) => f(r)));
      if (limitN !== null) rows = rows.slice(0, limitN);
      return rows;
    }
    async function resolveSingle(_maybe: boolean) {
      if (pendingInsert && !pendingUpdate) return { data: pendingInsert, error: null };
      if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: rows[0] ?? null, error: null }; }
      if (pendingDelete) { const rows = matched(); rows.forEach((r) => { store.splice(store.indexOf(r), 1); }); return { data: rows[0] ?? null, error: null }; }
      const rows = matched();
      return { data: rows[0] ?? null, error: null };
    }
    async function resolveList() {
      if (pendingInsert && !pendingUpdate) return { data: [pendingInsert], error: null, count: 1 };
      if (pendingUpdate) { const rows = matched(); rows.forEach((r) => Object.assign(r, pendingUpdate)); return { data: rows, error: null }; }
      if (pendingDelete) { const rows = matched(); rows.forEach((r) => { store.splice(store.indexOf(r), 1); }); return { data: rows, error: null, count: rows.length }; }
      const rows = matched();
      return { data: rows, error: null, count: rows.length };
    }
    return builder;
  }

  const client: any = {
    from,
    auth: { getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }) },
  };
  return client;
}

function makeTables(): FakeTables {
  return {
    feature_flags: [
      // The feature_flags table uses "flag" as the column name, not "key".
      { flag: "trust_engine_enabled",          enabled: true },
      { flag: "trust_gaming_detection_enabled", enabled: true },
    ],
    trust_settings: [{
      id: 1,
      weight_plan_attendance: 0.18, weight_host_quality: 0.12,
      weight_communication:   0.10, weight_respect_safety: 0.15,
      weight_location_honesty: 0.13, weight_content_quality: 0.08,
      weight_community_value: 0.08, weight_guide_accuracy: 0.08,
      weight_passport_auth:   0.08,
      decay_half_life_days: 90,
      level_building_trust: 35, level_reliable: 50,
      level_trusted: 65, level_highly_trusted: 78, level_city_trusted: 90,
      daily_cap_plan_attend: 3, daily_cap_guide_verify: 5, daily_cap_gem_save: 10,
      weekly_cap_plan_attend: 10, weekly_cap_guide_verify: 20, weekly_cap_gem_save: 40,
      gaming_checkin_cluster_limit: 5,
      gaming_mutual_rate_threshold: 0.80,
      gaming_rapid_jump_points: 20,
    }],
    trust_events:          [],
    trust_caps:            [],
    trust_restrictions:    [],
    trust_profiles:        [],
    trust_reviews:         [],
    trust_admin_actions:   [],
    plan_attendance_events:[],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// PART 1: HTTP Route Tests (trust-admin.ts endpoints)
// ══════════════════════════════════════════════════════════════════════════════

let server: http.Server;
let base:   string;
const FAKE_TOKEN = "fake.jwt.token";

function httpReq(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: url.hostname,
        port:     Number(url.port),
        path:     url.pathname + url.search,
        method,
        headers: {
          "content-type":  "application/json",
          "authorization": `Bearer ${FAKE_TOKEN}`,
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
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

/**
 * Build a route-test fake client.
 * `role` controls whether requireAdminGuard passes (admin) or rejects (user/non-admin).
 * `tables` is the live in-memory store shared by all route calls in a test.
 */
function makeRouteFakeClient(opts: {
  role?: string;
  tables?: FakeTables;
}) {
  const { role = "admin", tables = makeTables() } = opts;

  function from(table: string) {
    // Admin guard profile lookup
    if (table === "profiles") {
      return {
        select: () => b,
        eq:     () => b,
        maybeSingle: () => Promise.resolve({ data: { id: ADMIN, role }, error: null }),
      };
    }

    // All other tables — delegate to the shared fake-client builder
    const tblKey = table as keyof FakeTables;
    if (!(tblKey in tables)) {
      // Unknown table — return an empty no-op builder
      const empty: any = {
        select: () => empty, insert: () => empty, update: () => empty,
        delete: () => empty, upsert: () => empty,
        eq: () => empty, in: () => empty, is: () => empty, not: () => empty,
        gt: () => empty, lt: () => empty, or: () => empty,
        order: () => empty, limit: () => empty, range: () => empty,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single:      () => Promise.resolve({ data: null, error: null }),
        then: (r: any) => Promise.resolve({ data: [], error: null, count: 0 }).then(r),
      };
      return empty;
    }

    return makeTrustClient(tables).from(tblKey);
  }

  const b: any = {
    select: () => b,
    eq:     () => b,
    maybeSingle: () => Promise.resolve({ data: { id: ADMIN, role }, error: null }),
  };

  return {
    from,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id: ADMIN } }, error: null }),
    },
  } as any;
}

function setClients(opts: { role?: string; tables?: FakeTables }) {
  const c = makeRouteFakeClient(opts);
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(trustAdminRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as any;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  _setTestClient(null as any, false);
  _setTestServiceClient(null);
  server.close();
});

// ── Auth / admin guard ─────────────────────────────────────────────────────────

describe("trust-admin routes — admin guard", () => {
  it("GET /admin/trust/reviews returns 403 for non-admin", async () => {
    setClients({ role: "user" });
    const { status } = await httpReq("GET", "/admin/trust/reviews");
    assert.equal(status, 403);
  });

  it("GET /admin/trust/reviews returns 200 for admin", async () => {
    setClients({ role: "admin" });
    const { status, body } = await httpReq("GET", "/admin/trust/reviews");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reviews), "reviews should be an array");
    assert.ok("total" in body, "should include total count");
    assert.ok("page" in body, "should include page");
  });

  it("GET /admin/trust/gaming-flags returns 403 for non-admin", async () => {
    setClients({ role: "user" });
    const { status } = await httpReq("GET", "/admin/trust/gaming-flags");
    assert.equal(status, 403);
  });
});

// ── GET /admin/trust/reviews with filters ─────────────────────────────────────

describe("trust-admin routes — review queue", () => {
  it("returns only open/in_progress reviews by default", async () => {
    const tables = makeTables();
    tables.trust_reviews.push(
      { id: "rev-open-1",     user_id: USER_A, review_type: "gaming_suspected", status: "open",       metadata: {}, assigned_to: null, created_at: "2026-01-01T00:00:00Z" },
      { id: "rev-resolved-1", user_id: USER_B, review_type: "appeal",           status: "resolved",   metadata: {}, assigned_to: null, created_at: "2026-01-01T00:00:00Z" },
    );
    setClients({ tables });
    const { status, body } = await httpReq("GET", "/admin/trust/reviews");
    assert.equal(status, 200);
    assert.ok(
      body.reviews.every((r: any) => ["open", "in_progress"].includes(r.status)),
      "default filter should return only open/in_progress",
    );
  });

  it("assigned_to filter narrows results", async () => {
    const tables = makeTables();
    tables.trust_reviews.push(
      { id: "rev-a1", user_id: USER_A, review_type: "gaming_suspected", status: "open", assigned_to: "admin-X", metadata: {}, created_at: "2026-01-01T00:00:00Z" },
      { id: "rev-a2", user_id: USER_B, review_type: "appeal",           status: "open", assigned_to: null,      metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    );
    setClients({ tables });
    const { status, body } = await httpReq("GET", "/admin/trust/reviews?assigned_to=admin-X");
    assert.equal(status, 200);
    assert.ok(
      body.reviews.every((r: any) => r.assigned_to === "admin-X"),
      "assigned_to filter should only return assigned reviews",
    );
  });

  it("type filter narrows to gaming_suspected", async () => {
    const tables = makeTables();
    tables.trust_reviews.push(
      { id: "rev-g1", user_id: USER_A, review_type: "gaming_suspected", status: "open", assigned_to: null, metadata: {}, created_at: "2026-01-01T00:00:00Z" },
      { id: "rev-ap1", user_id: USER_B, review_type: "appeal",          status: "open", assigned_to: null, metadata: {}, created_at: "2026-01-01T00:00:00Z" },
    );
    setClients({ tables });
    const { status, body } = await httpReq("GET", "/admin/trust/reviews?type=gaming_suspected");
    assert.equal(status, 200);
    assert.ok(
      body.reviews.every((r: any) => r.review_type === "gaming_suspected"),
      "type filter should only return gaming_suspected reviews",
    );
  });
});

// ── GET /admin/trust/users/:userId ─────────────────────────────────────────────

describe("trust-admin routes — user trust detail", () => {
  it("returns correct shape for a known user", async () => {
    const tables = makeTables();
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 55, public_level: "reliable_traveler",
      plan_attendance: 60, host_quality: 50, communication: 55, respect_safety: 70,
      location_honesty: 40, content_quality: 45, community_value: 50,
      guide_accuracy: 45, passport_authenticity: 55, updated_at: new Date().toISOString(),
    });
    tables.trust_events.push({
      id: "ev-detail-1", user_id: USER_A, event_type: "PLAN_ATTENDED",
      category: "plan_attendance", delta: 5, severity: "minor",
      status: "applied", source_type: "user_action", metadata: {}, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("GET", `/admin/trust/users/${USER_A}`);
    assert.equal(status, 200);
    assert.equal(body.userId, USER_A);
    assert.ok("profile" in body, "response should include profile");
    assert.ok(Array.isArray(body.caps), "caps should be an array");
    assert.ok(Array.isArray(body.restrictions), "restrictions should be an array");
    assert.ok(Array.isArray(body.events), "events should be an array");
    assert.ok(Array.isArray(body.openReviews), "openReviews should be an array");
  });

  it("returns 400 for invalid userId", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("GET", "/admin/trust/users/not-a-uuid");
    assert.equal(status, 400);
  });
});

// ── POST /admin/trust/events/:eventId/confirm ─────────────────────────────────

describe("trust-admin routes — confirm/dismiss event", () => {
  it("POST confirm returns 200 and ok:true for a pending_review event", async () => {
    const tables = makeTables();
    const eventId = "00000000-0000-0000-0000-000000000e01";
    tables.trust_events.push({
      id: eventId, user_id: USER_A, event_type: "FAKE_GPS_CONFIRMED",
      category: "location_honesty", delta: -20, severity: "severe",
      status: "pending_review", source_type: "admin", metadata: {}, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/events/${eventId}/confirm`, { reason: "Verified by ops" });
    assert.equal(status, 200);
    assert.equal(body.ok, true, "confirm should return ok:true");
    // Event should now be confirmed in the store
    const evt = tables.trust_events.find((e) => e.id === eventId);
    assert.equal(evt?.status, "confirmed", "event status should be confirmed");
  });

  it("POST confirm returns 400 when reason is missing", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("POST", "/admin/trust/events/00000000-0000-0000-0000-000000000e99/confirm", {});
    assert.equal(status, 400);
  });

  it("POST dismiss returns 200 and marks event dismissed", async () => {
    const tables = makeTables();
    const eventId = "00000000-0000-0000-0000-000000000e02";
    tables.trust_events.push({
      id: eventId, user_id: USER_A, event_type: "GPS_IMPOSSIBLE_SPEED",
      category: "location_honesty", delta: -8, severity: "serious",
      status: "pending_review", source_type: "automated", metadata: {}, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/events/${eventId}/dismiss`, { reason: "False positive — device glitch" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const evt = tables.trust_events.find((e) => e.id === eventId);
    assert.equal(evt?.status, "dismissed");
  });
});

// ── POST /admin/trust/users/:userId/restrict ──────────────────────────────────

describe("trust-admin routes — restrict / remove restriction", () => {
  it("POST restrict returns 201 with restrictionId", async () => {
    const tables = makeTables();
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/restrict`, {
      restrictionType: "hosting",
      reason:          "Repeated no-shows confirmed",
    });
    assert.equal(status, 201);
    assert.equal(body.ok, true);
    assert.ok(body.restrictionId, "restrictionId should be returned");
    // Verify it was stored
    const restriction = tables.trust_restrictions.find((r: any) => r.restriction_type === "hosting");
    assert.ok(restriction, "restriction row should exist in store");
  });

  it("POST restrict returns 400 for unknown restrictionType", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/restrict`, {
      restrictionType: "fly_fishing",
      reason:          "test",
    });
    assert.equal(status, 400);
  });

  it("POST restrictions/:id/remove returns 200 and lifts restriction", async () => {
    const tables = makeTables();
    const restrictionId = "00000000-0000-0000-0000-00000000aa01";
    tables.trust_restrictions.push({
      id: restrictionId, user_id: USER_A, restriction_type: "hosting",
      reason: "No-shows", lifted_at: null, expires_at: null, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/restrictions/${restrictionId}/remove`, {
      targetUser: USER_A,
      reason:     "Period served, reinstated",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // lifted_at should now be set
    const r = tables.trust_restrictions.find((x: any) => x.id === restrictionId);
    assert.ok(r?.lifted_at, "restriction lifted_at should be set after removal");
  });

  it("POST restrictions/:id/remove returns 400 if targetUser missing", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("POST", `/admin/trust/restrictions/00000000-0000-0000-0000-00000000ba99/remove`, {
      reason: "test",
      // targetUser missing
    });
    assert.equal(status, 400);
  });

  it("DELETE /admin/trust/restrictions/:id (old endpoint) is NOT registered — returns 404", async () => {
    // Regression guard: mobile service must use POST /:id/remove, not DELETE /:id
    // If this starts passing with 200, a DELETE route was re-added and the contract broke.
    setClients({ role: "admin" });
    const { status } = await httpReq("DELETE", `/admin/trust/restrictions/00000000-0000-0000-0000-00000000aa01`);
    assert.notEqual(status, 200, "DELETE endpoint must not be registered — use POST /:id/remove");
  });
});

// ── POST /admin/trust/users/:userId/cap/override ──────────────────────────────

describe("trust-admin routes — cap override (lift cap early)", () => {
  it("lifts an active cap and returns ok:true with capId", async () => {
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-000000000c01";
    tables.trust_caps.push({
      id: capId, user_id: USER_A, category: "location_honesty",
      ceiling_score: 30, reason_code: "fake_gps_severe",
      lifted_at: null, lifted_by: null, expires_at: null, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId,
      reason: "GPS sensor confirmed faulty — lifting cap",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.capId, capId);
    // Cap should be lifted in the store
    const cap = tables.trust_caps.find((c: any) => c.id === capId);
    assert.ok(cap?.lifted_at, "cap.lifted_at should be set after override");
  });

  it("returns 400 if capId is not a UUID", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId: "not-a-uuid",
      reason: "test",
    });
    assert.equal(status, 400);
  });
});

// ── GET /admin/trust/gaming-flags ─────────────────────────────────────────────

describe("trust-admin routes — gaming flags", () => {
  it("returns gaming_suspected reviews with flags array", async () => {
    const tables = makeTables();
    tables.trust_reviews.push(
      { id: "gf-1", user_id: USER_A, review_type: "gaming_suspected", status: "open",       metadata: { pattern: "rapid_jump" }, created_at: new Date().toISOString() },
      { id: "gf-2", user_id: USER_B, review_type: "appeal",           status: "open",       metadata: {},                        created_at: new Date().toISOString() },
      { id: "gf-3", user_id: USER_C, review_type: "gaming_suspected", status: "in_progress", metadata: { pattern: "checkin_cluster" }, created_at: new Date().toISOString() },
    );
    setClients({ tables });
    const { status, body } = await httpReq("GET", "/admin/trust/gaming-flags");
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.flags), "flags should be an array");
    assert.ok(
      body.flags.every((f: any) => f.review_type === "gaming_suspected"),
      "all returned flags should be gaming_suspected",
    );
    assert.equal(body.flags.length, 2, "should return 2 gaming flags (not the appeal)");
  });

  it("POST mark-reviewed dismisses the gaming flag", async () => {
    const tables = makeTables();
    const reviewId = "00000000-0000-0000-0000-00000000bb01";
    tables.trust_reviews.push({
      id: reviewId, user_id: USER_A, review_type: "gaming_suspected",
      status: "open", metadata: { pattern: "rapid_jump" }, created_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/gaming-flags/${reviewId}/mark-reviewed`, { notes: "False positive — legitimate travel" });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const rev = tables.trust_reviews.find((r: any) => r.id === reviewId);
    assert.equal(rev?.status, "dismissed");
  });
});

// ── GET/PUT /admin/trust/settings ─────────────────────────────────────────────

describe("trust-admin routes — trust settings", () => {
  it("GET settings returns settings object", async () => {
    setClients({ role: "admin" });
    const { status, body } = await httpReq("GET", "/admin/trust/settings");
    assert.equal(status, 200);
    assert.ok("settings" in body, "response should include settings object");
  });

  it("PUT settings/:key updates value and triggers async recalc", async () => {
    const tables = makeTables();
    // Add a trust profile so recalc has something to iterate over
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 50, public_level: "reliable_traveler",
      updated_at: new Date().toISOString(),
    });
    setClients({ tables });
    const { status, body } = await httpReq("PUT", "/admin/trust/settings/decay_half_life_days", { value: 120 });
    assert.equal(status, 200);
    assert.ok("settings" in body, "response should include updated settings");
    assert.equal(body.updated.key,   "decay_half_life_days");
    assert.equal(body.updated.value, 120);
    // The settings row should now reflect the update
    const row = tables.trust_settings[0];
    assert.equal(row?.decay_half_life_days, 120, "trust_settings row should be updated");
  });

  it("PUT settings/:key returns 400 for unknown key", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("PUT", "/admin/trust/settings/unknown_key", { value: 99 });
    assert.equal(status, 400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 2: Service-layer chain tests (no HTTP)
// ══════════════════════════════════════════════════════════════════════════════

// ── Full event → recalculation → public-level round-trip ──────────────────────

describe("Service: full event → recalc → public level round-trip", () => {
  it("records positive events and derives correct public level", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    await db.from("trust_events").insert({ user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance", delta: 8, severity: "minor", status: "applied", source_type: "user_action" });
    await db.from("trust_events").insert({ user_id: USER_A, event_type: "HOST_QUALITY_RATING", category: "host_quality", delta: 10, severity: "minor", status: "applied", source_type: "user_action" });

    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(result.overall_score > 0);
    assert.ok(["new_traveler","building_trust","reliable_traveler","trusted_traveler","highly_trusted","city_trusted"].includes(result.public_level));

    const profile = await getTrustProfile(db, USER_A);
    assert.ok(profile !== null);
    assert.equal(profile!.overall_score, result.overall_score);
  });

  it("new user with no events computes 50 ARITHMETICALLY but is never persisted as one", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_B);

    // The arithmetic is unchanged: nine empty categories at a neutral 50 with
    // weights summing to 1.000 is 50, and 50 >= level_reliable.
    assert.equal(result.overall_score, 50);
    assert.equal(result.public_level, "reliable_traveler");

    // …but it must never become STATE. This assertion is the whole point: this
    // test's old name claimed a zero-evidence user "gets" that baseline, and
    // nothing checked whether it was written. It was — and because
    // PassportProjectionService maps public_level through LEVEL_RANK into
    // capability grants, persisting it handed canHostTrip, canUseCrewLocation
    // and canContributeLiveIntel to every user on the first flag enable.
    assert.equal(result.persisted, false, "a zero-evidence user must not be persisted");
    assert.equal(
      tables.trust_profiles.length, 0,
      "no trust_profiles row may exist for a user with no qualifying events — row " +
      "absence IS the canonical 'no earned trust' representation that " +
      "getDisplayTrustScore, lib/trustScore and TrustPrivacyGuard all already honour",
    );
  });
});

// ── Severe event creates pending review ────────────────────────────────────────

describe("Service: severe event creates pending review (appeal scenario)", () => {
  it("FAKE_GPS_CONFIRMED severe → pendingReview=true; appears in getPendingEvents queue", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const rec = await recordTrustEvent(db, {
      userId:     USER_A, eventType: "FAKE_GPS_CONFIRMED",
      category:   "location_honesty", delta: -20, severity: "severe",
      sourceType: "admin", sourceId: "gps-case-1",
    });
    assert.equal(rec.pendingReview, true, "severe event should be pending_review");
    assert.ok(rec.eventId);

    // Should appear in admin queue
    const queue = await getPendingEvents(db);
    assert.equal(queue.length, 1, "pending events queue should have exactly one entry");
    assert.equal(queue[0].id, rec.eventId);
  });

  it("appeal scenario: user can create a review that appears in getOpenReviews", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Simulate an appeal by inserting a review row directly (would come from user-facing appeal endpoint)
    await db.from("trust_reviews").insert({
      user_id:     USER_A,
      review_type: "appeal",
      status:      "open",
      metadata:    { reason: "My GPS was broken during a flight" },
    });

    const reviews = await getOpenReviews(db);
    assert.equal(reviews.length, 1, "should have one open review");
    assert.equal(reviews[0].review_type, "appeal");
    assert.equal(reviews[0].user_id, USER_A);
  });
});

// ── Admin confirm → recalculation + caps ──────────────────────────────────────

describe("Service: admin confirm event triggers recalculation", () => {
  it("confirming a severe event caps the category and lowers the score", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const rec = await recordTrustEvent(db, { userId: USER_A, eventType: "FAKE_GPS_CONFIRMED", category: "location_honesty", delta: -20, severity: "severe", sourceType: "admin" });
    assert.equal(rec.pendingReview, true);

    await confirmEvent(db, ADMIN, rec.eventId!, "Verified");
    const evt = tables.trust_events.find((e) => e.id === rec.eventId);
    assert.equal(evt?.status, "confirmed");

    const caps = await getActiveCaps(db, USER_A);
    assert.ok(caps.length > 0, "at least one cap should be active");

    const result = await recalculateTrustScore(db, USER_A);
    assert.ok(result.categories.location_honesty <= 50, `location_honesty should be ≤50, got ${result.categories.location_honesty}`);
  });

  it("dismissing a serious event leaves no caps", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const rec = await recordTrustEvent(db, { userId: USER_A, eventType: "GPS_IMPOSSIBLE_SPEED", category: "location_honesty", delta: -8, severity: "serious", sourceType: "automated" });
    await dismissEvent(db, ADMIN, rec.eventId!, "False positive");
    const caps = await getActiveCaps(db, USER_A);
    assert.equal(caps.length, 0, "no caps after dismissal");
  });
});

// ── Hosting restriction round-trip ────────────────────────────────────────────

describe("Service: admin restrict blocks hosting seam, lift restores it", () => {
  it("apply hosting → canHost=false; lift → canHost=true", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const before = await getRestrictionState(db, USER_A);
    assert.equal(before.canHost, true);

    const { restrictionId } = await adminApplyRestriction(db, ADMIN, USER_A, "hosting", "No-show pattern", null);
    const after = await getRestrictionState(db, USER_A);
    assert.equal(after.canHost, false);

    await adminLiftRestriction(db, ADMIN, USER_A, restrictionId, "Served");
    const restored = await getRestrictionState(db, USER_A);
    assert.equal(restored.canHost, true);
  });
});

// ── Override cap → remove override ────────────────────────────────────────────

describe("Service: adminOverrideScore → adminRemoveOverride restores score", () => {
  it("cap override locks score; removing it allows natural recalc", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    for (let i = 0; i < 5; i++) {
      await db.from("trust_events").insert({ user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance", delta: 10, severity: "minor", status: "applied", source_type: "user_action" });
    }

    await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 5, "Test");
    const capped = await recalculateTrustScore(db, USER_A);
    assert.ok(capped.categories.plan_attendance <= 5, `got ${capped.categories.plan_attendance}`);

    await adminRemoveOverride(db, ADMIN, USER_A, "plan_attendance", "Restoring");
    const restored = await recalculateTrustScore(db, USER_A);
    assert.ok(restored.categories.plan_attendance >= capped.categories.plan_attendance);
  });
});

// ── Gaming detection + dedup ───────────────────────────────────────────────────

describe("Service: gaming detection scan", () => {
  it("rapid jump pattern creates gaming_suspected review", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 6; i++) {
      tables.trust_events.push({ id: `gd-${i}`, user_id: USER_C, category: "plan_attendance", delta: 5, severity: "minor", status: "applied", source_type: "user_action", created_at: new Date().toISOString() });
    }
    const result = await runGamingDetectionScan(db);
    assert.equal(result.ok, true);
    const review = tables.trust_reviews.find((r) => r.user_id === USER_C && r.review_type === "gaming_suspected");
    assert.ok(review, "gaming review should be created");
  });

  it("dedup: second scan does not create a second open review", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_reviews.push({ id: "existing-1", user_id: USER_C, review_type: "gaming_suspected", status: "open", metadata: { pattern: "rapid_jump" }, created_at: new Date().toISOString() });
    for (let i = 0; i < 6; i++) {
      tables.trust_events.push({ id: `gd2-${i}`, user_id: USER_C, category: "plan_attendance", delta: 5, severity: "minor", status: "applied", source_type: "user_action", created_at: new Date().toISOString() });
    }
    await runGamingDetectionScan(db);
    assert.equal(tables.trust_reviews.filter((r) => r.user_id === USER_C && r.review_type === "gaming_suspected").length, 1);
  });
});

// ── Public badge contains no sensitive fields ──────────────────────────────────

describe("Service: public trust badge contains no sensitive fields", () => {
  it("getPublicTrustBadge does not include raw category scores", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 42, public_level: "building_trust",
      plan_attendance: 55, host_quality: 60, communication: 50, respect_safety: 70,
      location_honesty: 30, content_quality: 40, community_value: 45, guide_accuracy: 35, passport_authenticity: 50, updated_at: new Date().toISOString(),
    });
    const badge = await getPublicTrustBadge(db, USER_A);
    assert.ok(badge !== null);
    assert.ok(!("plan_attendance" in badge!), "no raw category score");
    assert.ok(!("overall_score" in badge!),   "no overall_score");
    assert.ok("level" in badge!,              "badge should include level");
  });
});

// ── New user has no restrictions ───────────────────────────────────────────────

describe("Service: new user has no restrictions", () => {
  it("user with no restriction rows has all permissions open", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const state = await getRestrictionState(db, USER_B);
    assert.equal(state.canHost,              true);
    assert.equal(state.canMessage,           true);
    assert.equal(state.canJoinPrivatePlans,  true);
    assert.equal(state.canJoinLocationPlans, true);
    assert.deepEqual(state.activeRestrictions, []);
  });

  it("new user recovery status shows no probation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_profiles.push({ user_id: USER_B, overall_score: 0, public_level: "new_traveler", updated_at: new Date().toISOString() });
    const recovery = await getRecoveryStatus(db, USER_B);
    assert.equal(recovery.onProbation, false);
  });
});

// ── Probation lifecycle ────────────────────────────────────────────────────────

describe("Service: probation lifecycle on severe confirmed event", () => {
  it("confirming a severe event puts user on probation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const rec = await recordTrustEvent(db, { userId: USER_A, eventType: "BEHAVIOR_REPORT_CONFIRMED", category: "respect_safety", delta: -30, severity: "severe", sourceType: "admin" });
    assert.equal(rec.pendingReview, true);
    await confirmEvent(db, ADMIN, rec.eventId!, "Confirmed");
    const recovery = await getRecoveryStatus(db, USER_A);
    assert.equal(recovery.onProbation, true);
    assert.ok(recovery.probationEndsAt);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 3: Earn/lose asymmetry + the maintenance driver
//
// These pin the two properties the engine is supposed to have and previously
// did not: a score must be SLOW TO EARN and IMMEDIATE TO LOSE, and something
// must actually drive recalculation. Before this, `computeCategoryScore` was a
// raw decay-weighted mean, so one +6 event put a category at 80; and
// `recalculateTrustScore` ran only on admin action, so on production
// trust_events accumulated while trust_profiles stayed empty.
// ══════════════════════════════════════════════════════════════════════════════

const DAY = 24 * 60 * 60 * 1000;

/** Seed an already-`applied` event directly, bypassing caps/dedup/flag routing. */
function seedEvent(
  tables: FakeTables,
  userId: string,
  category: string,
  delta: number,
  ageDays = 0,
  status = "applied",
) {
  tables.trust_events.push({
    id: `ev-${tables.trust_events.length + 1}`,
    user_id: userId,
    event_type: "seeded",
    category,
    delta,
    severity: delta < 0 ? "moderate" : "minor",
    status,
    source_type: "system",
    created_at: new Date(Date.now() - ageDays * DAY).toISOString(),
  });
}

describe("Scoring: positive movement is ramped, negative movement is not", () => {
  it("a single positive event no longer maxes a category (was 80, now 56)", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    seedEvent(tables, USER_A, "host_quality", 6);

    const r = await recalculateTrustScore(db, USER_A);
    // 50 + (6*5) * confidence(1/5) = 56 — not the old 50 + 30 = 80.
    assert.ok(
      r.categories.host_quality > 50 && r.categories.host_quality < 60,
      `expected a damped gain in 50..60, got ${r.categories.host_quality}`,
    );
  });

  it("sustained positive history earns the full gain", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) seedEvent(tables, USER_A, "host_quality", 6);

    const r = await recalculateTrustScore(db, USER_A);
    // Five events of equal weight → confidence 1 → the full 50 + 30.
    assert.equal(Math.round(r.categories.host_quality), 80);
  });

  it("volume alone cannot inflate a score beyond the honest mean", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 200; i++) seedEvent(tables, USER_A, "host_quality", 6);

    const r = await recalculateTrustScore(db, USER_A);
    // The mean (not the sum) is used, so 200 events land where 5 do.
    assert.equal(Math.round(r.categories.host_quality), 80);
  });

  it("a single negative event bites at FULL strength on first occurrence", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    seedEvent(tables, USER_A, "respect_safety", -20);

    const r = await recalculateTrustScore(db, USER_A);
    // No confidence ramp on the negative branch — a user must never have to
    // "earn" their way into a penalty.
    assert.equal(r.categories.respect_safety, 0);
  });

  // ── The limit of the delta model, stated explicitly ────────────────────────
  //
  // These two tests exist as a pair and must be read together. The first
  // documents a REAL LIMITATION rather than asserting a desired property: a
  // decay-weighted mean cannot let one bad event dominate a long good history.
  // Ten +3 events against one -20 still average positive (54.55), so a severe
  // finding does NOT by itself drag a well-regarded user below neutral.
  //
  // That is why "fast loss on something horrible" is delivered by the CEILING
  // (trust_caps), not by the delta — a ceiling clamps the category no matter how
  // much good history surrounds it. The second test proves that path.
  //
  // Consequence worth knowing: the ceiling is applied by
  // TrustCapService.applyEventCaps, which today runs only from the admin
  // confirmEvent path. Until a severe event is confirmed by a human, a
  // well-regarded user's score barely moves.
  it("delta alone does NOT sink a good history — this is the model's limit, not a bug", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 10; i++) seedEvent(tables, USER_A, "respect_safety", 3);
    seedEvent(tables, USER_A, "respect_safety", -20);

    const r = await recalculateTrustScore(db, USER_A);
    assert.ok(
      r.categories.respect_safety > 50,
      `documents the limitation: the mean stays positive, got ${r.categories.respect_safety}`,
    );
  });

  it("the CEILING is what delivers the sharp drop, regardless of good history", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 10; i++) seedEvent(tables, USER_A, "respect_safety", 3);
    seedEvent(tables, USER_A, "respect_safety", -20);
    // What confirmEvent → applyEventCaps writes for behavior_report_confirmed.
    tables.trust_caps.push({
      id: "cap-severe", user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed",
      expires_at: null, lifted_at: null,
      created_at: new Date().toISOString(),
    });

    const r = await recalculateTrustScore(db, USER_A);
    assert.equal(r.categories.respect_safety, 40);
    assert.ok(r.capsApplied.includes("respect_safety"));
  });

  it("decayed evidence loses confidence, so trust must be maintained not banked", async () => {
    const fresh = makeTables();
    const stale = makeTables();
    for (let i = 0; i < 5; i++) seedEvent(fresh, USER_A, "host_quality", 6, 0);
    for (let i = 0; i < 5; i++) seedEvent(stale, USER_A, "host_quality", 6, 180);

    const rFresh = await recalculateTrustScore(makeTrustClient(fresh), USER_A);
    const rStale = await recalculateTrustScore(makeTrustClient(stale), USER_A);
    assert.ok(
      rStale.categories.host_quality < rFresh.categories.host_quality,
      `stale evidence must confer less credit (fresh=${rFresh.categories.host_quality}, stale=${rStale.categories.host_quality})`,
    );
  });
});

describe("Maintenance: the driver the engine was missing", () => {
  it("fails CLOSED when trust_engine_enabled is off", async () => {
    const tables = makeTables();
    tables.feature_flags = [{ flag: "trust_engine_enabled", enabled: false }];
    seedEvent(tables, USER_A, "host_quality", 6);

    const r = await runTrustMaintenance(makeTrustClient(tables));
    assert.equal(r.skipped, true);
    assert.equal(r.skipReason, "flag_off");
    assert.equal(tables.trust_profiles.length, 0);
  });

  it("scores a user who has events but NO trust_profiles row (the production case)", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    seedEvent(tables, USER_A, "host_quality", 6);
    assert.equal(tables.trust_profiles.length, 0);

    const r = await runTrustMaintenance(db);
    assert.equal(r.usersRecalculated, 1);
    assert.equal(tables.trust_profiles.length, 1);
    assert.equal(tables.trust_profiles[0].user_id, USER_A);
    assert.ok(tables.trust_profiles[0].last_recalculated_at, "must stamp last_recalculated_at");
  });

  it("ignores pending_review events — an unconfirmed report generates no work", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    seedEvent(tables, USER_A, "respect_safety", -20, 0, "pending_review");

    const r = await runTrustMaintenance(db);
    assert.equal(r.usersRecalculated, 0);
    assert.equal(tables.trust_profiles.length, 0);
  });

  it("lifts an expired cap, and the lifted ceiling no longer clamps the score", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) seedEvent(tables, USER_A, "host_quality", 6);
    tables.trust_caps.push({
      id: "cap-1", user_id: USER_A, category: "host_quality",
      ceiling_score: 55, reason_code: "expired_test",
      expires_at: new Date(Date.now() - DAY).toISOString(),
      lifted_at: null, created_at: new Date(Date.now() - 30 * DAY).toISOString(),
    });

    const r = await runTrustMaintenance(db);
    assert.equal(r.capsExpired, 1);
    assert.ok(tables.trust_caps[0].lifted_at, "expired cap must be lifted");
    // Caps are lifted BEFORE recalculation, so this pass already reflects it.
    assert.equal(Math.round(tables.trust_profiles[0].host_quality), 80);
  });

  it("ends probation whose term has run", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_profiles.push({
      user_id: USER_B, overall_score: 40, public_level: "building_trust",
      on_probation: true,
      probation_ends_at: new Date(Date.now() - DAY).toISOString(),
      last_recalculated_at: new Date(Date.now() - 30 * DAY).toISOString(),
    });

    const r = await runTrustMaintenance(db);
    assert.equal(r.probationCleared, 1);
    assert.equal(tables.trust_profiles[0].on_probation, false);
  });

  it("leaves unexpired probation alone", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_profiles.push({
      user_id: USER_B, overall_score: 40, public_level: "building_trust",
      on_probation: true,
      probation_ends_at: new Date(Date.now() + 7 * DAY).toISOString(),
      last_recalculated_at: new Date().toISOString(),
    });

    const r = await runTrustMaintenance(db);
    assert.equal(r.probationCleared, 0);
    assert.equal(tables.trust_profiles[0].on_probation, true);
  });

  it("refreshes a score that is merely stale, so decay is reflected without new events", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    tables.trust_profiles.push({
      user_id: USER_C, overall_score: 70, public_level: "trusted_traveler",
      last_recalculated_at: new Date(Date.now() - 60 * DAY).toISOString(),
    });

    const r = await runTrustMaintenance(db);
    assert.equal(r.usersRecalculated, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PART 4: Moderation → trust
//
// Every declared moderation trust type (CONTENT_REMOVED, BEHAVIOR_REPORT_CONFIRMED,
// MESSAGE_REPORT_CONFIRMED, STAMP_DISPUTED…) was emitted by nothing, so a
// confirmed ban cost the user exactly zero trust. Wiring it raised two questions
// these tests pin: a severe finding must APPLY (not sit in a queue waiting for a
// second admin to re-adjudicate a decision one already made), and reversing the
// sanction must reverse its consequence — including the ceiling, which has no
// expiry and would otherwise stand forever.
// ══════════════════════════════════════════════════════════════════════════════

describe("Moderation → trust: an adjudicated finding applies immediately", () => {
  it("a severe event from an admin action is confirmed in the same request", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const r = await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety",
      delta: -20,
      severity: "severe",
      sourceType: "moderation",
      sourceId: "mod-action-1",
    });

    assert.equal(r.ok, true);
    assert.equal(r.confirmed, true, "an already-adjudicated finding must not wait in the queue");

    const ev = tables.trust_events.find((e) => e.id === r.eventId);
    assert.equal(ev.status, "confirmed", "the scorer only counts applied/confirmed");
    assert.equal(ev.reviewed_by, ADMIN, "the audit trail must name the human who decided");
  });

  it("confirming imposes the CEILING, which is what actually bites", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety",
      delta: -20,
      severity: "severe",
      sourceType: "moderation",
      sourceId: "mod-action-2",
    });

    const caps = tables.trust_caps.filter((c) => c.user_id === USER_A && !c.lifted_at);
    assert.ok(caps.length > 0, "a severe adjudicated finding must impose a ceiling");
    assert.equal(caps[0].category, "respect_safety");
  });

  it("a moderate event needs no confirmation — it applies on its own", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const r = await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "stamp_disputed",
      category: "passport_authenticity",
      delta: -6,
      severity: "moderate",
      sourceType: "moderation",
      sourceId: "user-stamp-1",
    });

    assert.equal(r.confirmed, true);
    assert.equal(tables.trust_events.find((e) => e.id === r.eventId).status, "applied");
  });

  it("one adjudication charges once, however many times it is retried", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const input = {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety" as const,
      delta: -20,
      severity: "severe" as const,
      sourceType: "moderation",
      sourceId: "mod-action-same",
      dedupWindowHours: 24 * 365,
    };

    await recordAdjudicatedTrustEvent(db, ADMIN, input);
    const second = await recordAdjudicatedTrustEvent(db, ADMIN, input);

    assert.equal(second.skipped, true, "a retried ban must not charge the user twice");
    assert.equal(second.skipReason, "dedup");
    assert.equal(tables.trust_events.filter((e) => e.event_type === "behavior_report_confirmed").length, 1);
  });
});

describe("Moderation → trust: reversing the sanction reverses the consequence", () => {
  it("restoring an account lifts the ceiling the ban imposed", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety",
      delta: -20,
      severity: "severe",
      sourceType: "moderation",
      sourceId: "mod-action-3",
    });
    assert.ok(tables.trust_caps.some((c) => c.user_id === USER_A && !c.lifted_at));

    const out = await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Account restored");

    assert.ok(out.eventsDismissed >= 1);
    assert.ok(out.capsLifted >= 1, "a behavior_confirmed ceiling has NO expiry — it must be lifted explicitly");
    assert.equal(
      tables.trust_caps.filter((c) => c.user_id === USER_A && !c.lifted_at).length, 0,
      "no active cap may survive the reversal",
    );
    assert.ok(tables.trust_events.every((e) => e.user_id !== USER_A || e.status === "dismissed"));
  });

  it("reversal is scoped to moderation — an unrelated finding still stands", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // A machine-detected GPS finding, on its own evidence.
    tables.trust_events.push({
      id: "ev-gps", user_id: USER_A, event_type: "fake_gps_confirmed",
      category: "location_honesty", delta: -20, severity: "severe",
      status: "confirmed", source_type: "gps",
      created_at: new Date().toISOString(),
    });

    await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety",
      delta: -20,
      severity: "severe",
      sourceType: "moderation",
      sourceId: "mod-action-4",
    });

    await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Account restored");

    const gps = tables.trust_events.find((e) => e.id === "ev-gps");
    assert.equal(gps.status, "confirmed", "un-banning must not clear an unrelated GPS finding");
  });

  it("reversing clears probation the finding set", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    await recordAdjudicatedTrustEvent(db, ADMIN, {
      userId: USER_A,
      eventType: "behavior_report_confirmed",
      category: "respect_safety",
      delta: -20,
      severity: "severe",
      sourceType: "moderation",
      sourceId: "mod-action-5",
    });
    await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Appeal upheld");

    const prof = tables.trust_profiles.find((p) => p.user_id === USER_A);
    if (prof) assert.notEqual(prof.on_probation, true, "a reversed finding must not leave probation running");
  });
});

// ─── ZERO-EVIDENCE REGRESSION SUITE ──────────────────────────────────────────
//
// THE DEFECT. computeCategoryScore returns 50 for a category with no events
// (TrustScoreService.ts:195). Its single caller loops over the fixed nine
// ALL_CATEGORIES rather than the categories actually present, and the nine
// weights sum to exactly 1.000 — so a user with zero events scores exactly
// 50.00. `level_reliable` is 50 and scoreToLevel compares with >=, so 50
// promotes to `reliable_traveler`, rung 3 of 6. The old code then PERSISTED it.
//
// WHY THAT MATTERS MORE THAN A BADGE. PassportProjectionService maps
// public_level through LEVEL_RANK into capability grants
// (canHostTrip / canUseCrewLocation / canContributeLiveIntel). The ingest lane
// is gated behind `trust_engine_enabled`, so trust_events is empty; enabling
// that flag would therefore have scored every user at 50, promoted every user
// to reliable_traveler, and granted those three capabilities to everyone at
// once.
//
// THE FIX USES AN EXISTING REPRESENTATION, not a new one: absence of a
// trust_profiles row already means "no earned trust" everywhere else —
// getDisplayTrustScore returns null for it, lib/trustScore types the score as
// `number | null` explicitly "rather than a fabricated number", and
// TrustPrivacyGuard falls back to the `new_traveler` label.

describe("Trust: zero evidence is not earned trust", () => {
  const ev = (category: string, delta: number, userId = USER_A) => ({
    id: `e-${category}-${delta}`,
    user_id: userId,
    category,
    delta,
    severity: "normal",
    created_at: new Date().toISOString(),
    status: "confirmed",
  });

  it("zero events earn no category trust — nothing is persisted", async () => {
    const tables = makeTables();
    const r = await recalculateTrustScore(makeTrustClient(tables), USER_B);
    assert.equal(r.persisted, false);
    assert.equal(tables.trust_profiles.length, 0);
  });

  it("zero events cannot promote a trust level — the read path reports no profile", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await recalculateTrustScore(db, USER_B);

    const profile = await getTrustProfile(db, USER_B);
    assert.equal(
      profile, null,
      "getTrustProfile must report null. That null is what makes " +
      "TrustPrivacyGuard fall back to `new_traveler` (LEVEL_RANK 0) instead of " +
      "`reliable_traveler` (rank 2), and rank 0 grants no capabilities.",
    );
  });

  it("one legitimate event DOES produce a score and IS persisted", async () => {
    const tables = makeTables();
    tables.trust_events.push(ev("host_quality", 6));
    const r = await recalculateTrustScore(makeTrustClient(tables), USER_A);

    assert.equal(r.persisted, true, "real evidence must be scored and stored");
    assert.equal(tables.trust_profiles.length, 1);
    assert.ok(r.categories.host_quality > 50, "the evidenced category moves above neutral");
  });

  it("a category WITH evidence is still scored correctly after the change", async () => {
    const tables = makeTables();
    tables.trust_events.push(ev("respect_safety", -20));
    const r = await recalculateTrustScore(makeTrustClient(tables), USER_A);

    assert.equal(r.persisted, true);
    assert.ok(
      r.categories.respect_safety < 50,
      "negative evidence must still lower the evidenced category",
    );
  });

  it("KNOWN LIMIT, pinned so it is not mistaken for correct: unevidenced categories still carry 50", async () => {
    // This is the per-category half of the contract gap. trust_profiles' nine
    // category columns and overall_score are all `numeric(5,2) NOT NULL DEFAULT
    // 50.00`, so there is no way to persist "this one category is unscored". A
    // user with a single negative event is therefore pulled UP toward 50 by the
    // eight fabricated neutrals — an inflation of a bad actor. Closing this
    // needs a migration and an owner decision, so it is asserted here as a
    // KNOWN state rather than left to be rediscovered as a surprise.
    const tables = makeTables();
    tables.trust_events.push(ev("respect_safety", -20));
    const r = await recalculateTrustScore(makeTrustClient(tables), USER_A);

    assert.equal(r.categories.host_quality, 50, "unevidenced category is still a fabricated 50");
    assert.ok(
      r.overall_score > r.categories.respect_safety,
      "and it drags the overall UP away from the only real measurement — " +
      `overall ${r.overall_score} vs evidenced ${r.categories.respect_safety}`,
    );
  });

  it("a user who ALREADY has a profile is still refreshed when evidence decays away", async () => {
    // Deliberately preserved behaviour. A stale score really is wrong, and
    // trustAsymmetryAndMaintenance.test.ts pins the refresh. The fix is scoped
    // to users who were NEVER scored, which is the population that would have
    // been promoted en masse on first enable.
    const tables = makeTables();
    tables.trust_profiles.push({ user_id: USER_A, overall_score: 60, public_level: "trusted_traveler" });
    const r = await recalculateTrustScore(makeTrustClient(tables), USER_A);

    assert.equal(r.persisted, true, "an existing row is still refreshed, not abandoned");
    assert.equal(tables.trust_profiles.length, 1);
  });

  it("BOUNDARY: 50 is inclusive of level_reliable, which is why a fabricated 50 promoted", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const r = await recalculateTrustScore(db, USER_B);
    assert.equal(r.overall_score, 50);
    assert.equal(
      r.public_level, "reliable_traveler",
      "scoreToLevel uses >= against level_reliable=50, so the neutral default " +
      "lands exactly ON the promotion boundary — the reason this defect granted " +
      "capabilities rather than merely looking untidy",
    );
    // And the whole point: that computation reaches no persisted state.
    assert.equal(tables.trust_profiles.length, 0);
  });
});
