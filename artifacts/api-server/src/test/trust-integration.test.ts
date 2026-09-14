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
import { getActiveCaps, createCap, expireOldCaps } from "../services/trust/TrustCapService.js";
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

/**
 * A builder that answers one table with a RESOLVED `{ data: null, error }` —
 * the shape supabase-js actually returns on a database error, and the shape
 * every fail-closed reader in this package is written against. Used to prove a
 * route separates "could not read" from "nothing there".
 */
function unreadableBuilder(table: string): any {
  const error = { message: `${table} unreadable (injected)`, code: "57014" };
  const b: any = {};
  for (const m of ["select", "insert", "upsert", "update", "delete", "eq", "in",
                   "is", "gt", "lt", "not", "or", "order", "limit", "range"]) {
    b[m] = () => b;
  }
  b.maybeSingle = async () => ({ data: null, error });
  b.single      = async () => ({ data: null, error });
  b.then = (onF: any, onR: any) =>
    Promise.resolve({ data: null, error, count: null }).then(onF, onR);
  return b;
}

/** Route-test clients with ONE table made unreadable (profiles stays readable
 *  so the admin guard still passes and the 403 does not mask the case). */
function setClientsWithUnreadable(opts: { tables: FakeTables; table: string }) {
  const base = makeRouteFakeClient({ tables: opts.tables });
  const c: any = {
    ...base,
    from: (t: string) => (t === opts.table ? unreadableBuilder(opts.table) : base.from(t)),
  };
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

/** An active cap row, ready to push into `tables.trust_caps`. */
function capRow(over: Record<string, any>) {
  return {
    user_id: USER_A, category: "location_honesty", ceiling_score: 30,
    reason_code: "admin_override", lifted_at: null, lifted_by: null,
    expires_at: null, created_at: new Date().toISOString(),
    ...over,
  };
}

/** Every `trust_admin_actions` row written during a test, for audit assertions. */
function auditRows(tables: FakeTables, actionType?: string) {
  return tables.trust_admin_actions.filter(
    (a: any) => actionType === undefined || a.action_type === actionType,
  );
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

// ── C22: THE FOUR DEFECTS OF THE ONE OVERRIDE-ADJACENT ROUTE ─────────────────
//
// `POST /admin/trust/users/:userId/cap/override` is, despite its name, the
// REMOVAL half of the admin ceiling. It carried four defects and they are one
// family: reporting success without confirming it.
//
//   1. no type check      — it lifted ANY cap by id, a `behavior_confirmed`
//                           moderation ceiling included, which is relief an
//                           admin does not have the authority to grant
//   2. no user scoping    — `liftCap` filtered on the cap id ALONE, so cap X
//                           belonging to user B could be lifted through user A's
//                           URL: B's ceiling gone, the audit row filed against
//                           A, and B's compass cache never invalidated. This is
//                           the one that was not written down anywhere
//   3. no observed effect — the update carried no `.select()`, so lifting a
//                           nonexistent or already-lifted cap resolved and the
//                           route answered `ok`
//   4. fire-and-forget    — the recalculation's failure was swallowed and the
//                           route returned `{ ok: true }` anyway, so the ceiling
//                           could be lifted with the score never recomputed
//
// Each `it` below pins exactly one of them, and each names the mutation that
// turns it red again.
describe("trust-admin routes — cap/override (C22: removal must be observed)", () => {
  it("DEFECT 1 — refuses to lift a MODERATION ceiling, and says why", async () => {
    // Mutation that turns this red: drop the `reason_code !== "admin_override"`
    // check from the route, i.e. restore "lift any cap by id".
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-0000000000c1";
    tables.trust_caps.push(capRow({
      id: capId, user_id: USER_A, category: "respect_safety",
      ceiling_score: 40, reason_code: "behavior_confirmed",
    }));
    setClients({ tables });

    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId, reason: "Appeal granted",
    });

    assert.equal(status, 403, "relief from a moderation ceiling is not built");
    assert.match(String(body.message ?? ""), /behavior_confirmed/,
      "the refusal names the kind of ceiling, so the admin is not left guessing");
    const cap = tables.trust_caps.find((c: any) => c.id === capId) as any;
    assert.equal(cap.lifted_at, null, "the moderation ceiling still stands");
    assert.equal(auditRows(tables).length, 0, "and nothing was audited as if it had been lifted");
  });

  it("DEFECT 2 — cannot lift another user's cap through this user's URL", async () => {
    // THE ONE NOBODY HAD WRITTEN DOWN. Mutation that turns this red: remove the
    // `.eq("user_id", userId)` from the route's cap lookup, or from `liftCap`.
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-0000000000c2";
    tables.trust_caps.push(capRow({ id: capId, user_id: USER_B, category: "communication" }));
    setClients({ tables });

    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId, reason: "Lifting A's override",
    });

    assert.equal(status, 404, "a cap that is not this user's does not exist for this route");
    const cap = tables.trust_caps.find((c: any) => c.id === capId) as any;
    assert.equal(cap.lifted_at, null, "USER_B's ceiling is untouched");
    assert.equal(auditRows(tables).length, 0,
      "and no audit row claims USER_A had an override removed");
  });

  it("DEFECT 3 — a cap that does not exist is 404, not ok", async () => {
    // Mutation that turns this red: drop `.select("id")` from liftCap and let
    // the route answer on a matched-nothing update.
    const tables = makeTables();
    setClients({ tables });
    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId: "00000000-0000-0000-0000-0000000000c9", reason: "Undo",
    });
    assert.equal(status, 404);
    assert.notEqual(body.ok, true);
    assert.equal(auditRows(tables).length, 0);
  });

  it("DEFECT 3 — an ALREADY-lifted cap is a conflict, not a second success", async () => {
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-0000000000c3";
    tables.trust_caps.push(capRow({
      id: capId, user_id: USER_A, lifted_at: new Date().toISOString(), lifted_by: ADMIN,
    }));
    setClients({ tables });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId, reason: "Undo again",
    });
    assert.equal(status, 409);
    assert.equal(auditRows(tables).length, 0);
  });

  it("an UNREADABLE trust_caps is a 500, never a clean 404", async () => {
    // The fail-closed rule: a failed read must not be reported as "nothing
    // there". Mutation that turns this red: drop the `capErr` branch.
    const tables = makeTables();
    setClientsWithUnreadable({ tables, table: "trust_caps" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId: "00000000-0000-0000-0000-0000000000c4", reason: "Undo",
    });
    assert.equal(status, 500, "an outage is not an answer about this cap");
  });

  it("DEFECT 4 — a failed recalculation is NOT reported as a successful lift", async () => {
    // trust_events unreadable makes `recalculateTrustScore` fail closed and
    // THROW. Before the fix the throw was swallowed by a fire-and-forget
    // `.catch(() => {})` and the route answered `{ ok: true }` regardless.
    // Mutation that turns this red: restore the fire-and-forget call —
    //   `await recalculateTrustScore(db, targetUserId).catch(() => {});`
    // in TrustAdminService.adminRemoveOverride.
    //
    // ── WHY THIS FIXTURE SEEDS trust_profiles, AND WHY IT HAD TO ────────────
    // THE PIN WAS A LIE. This case stayed GREEN under the very mutation its own
    // comment names, and passed for a reason that has nothing to do with
    // recalculation: `makeTables()` starts `trust_profiles` EMPTY, and the only
    // thing that ever puts a row there is `recalculateTrustScore`'s own upsert.
    // So with the recalculation swallowed, the NEXT step —
    // `confirmOverrideRemoved`'s read-back — found no profile, read `absent`,
    // and threw on its own account. The route 500'd either way and every
    // assertion below passed either way.
    //
    // Seeding the profile removes that second reason to fail. Now the ONLY
    // thing standing between this request and a `{ ok: true }` is the thrown
    // recalculation, which is precisely the property the title claims. Measured
    // by applying the mutation: red with the seed, green without it.
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-0000000000c5";
    tables.trust_caps.push(capRow({ id: capId, user_id: USER_A, category: "communication" }));
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 40, public_level: "reliable",
      plan_attendance: 40, host_quality: 40, communication: 40, respect_safety: 40,
      location_honesty: 40, content_quality: 40, community_value: 40,
      guide_accuracy: 40, passport_auth: 40,
    });
    setClientsWithUnreadable({ tables, table: "trust_events" });

    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId, reason: "Undo",
    });

    assert.notEqual(status, 200, "the caller must not be told the removal landed");
    assert.notEqual(body.ok, true);
    assert.equal(auditRows(tables, "score_override").length, 0,
      "and no audit row claims a removal the engine never applied");
  });

  it("the happy path lifts the RIGHT user's admin_override and reports the score it observed", async () => {
    const tables = makeTables();
    const capId = "00000000-0000-0000-0000-0000000000c6";
    tables.trust_caps.push(capRow({ id: capId, user_id: USER_A, category: "communication", ceiling_score: 20 }));
    // A second user with the same kind of cap, so a rule that ignored scoping
    // would have something to hit by accident.
    tables.trust_caps.push(capRow({ id: "00000000-0000-0000-0000-0000000000c7", user_id: USER_B, category: "communication" }));
    setClients({ tables });

    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId, reason: "Override no longer warranted",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.capId, capId);
    assert.deepEqual(body.liftedCapIds, [capId], "the response names the cap it actually lifted");
    assert.equal(typeof body.persistedScore, "number",
      "and the score it READ BACK from trust_profiles, not one it computed");

    const lifted = tables.trust_caps.find((c: any) => c.id === capId) as any;
    assert.ok(lifted.lifted_at, "the cap is lifted");
    const other = tables.trust_caps.find((c: any) => c.user_id === USER_B) as any;
    assert.equal(other.lifted_at, null, "and only that user's cap is");

    const audit = auditRows(tables, "score_override");
    assert.equal(audit.length, 1, "exactly one audit row");
    assert.equal((audit[0] as any).target_user, USER_A,
      "filed against the user whose ceiling was actually lifted");
    assert.equal((audit[0] as any).source_id, capId);
  });

  it("returns 400 if capId is not a UUID", async () => {
    setClients({ role: "admin" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId: "not-a-uuid",
      reason: "test",
    });
    assert.equal(status, 400);
  });

  it("is admin-only", async () => {
    setClients({ role: "user" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/cap/override`, {
      capId: "00000000-0000-0000-0000-0000000000c8", reason: "test",
    });
    assert.equal(status, 403);
  });
});

// ── IDF-50: the APPLY half was unreachable from any route ────────────────────
//
// `adminOverrideScore` had no caller outside its own tests, so the owner's
// ruling — CAP NOW, PIN LATER BEHIND A FLAG — governed a capability no admin
// had. These cases exist because "the ceiling persists" is worth nothing while
// nothing can set one.
describe("trust-admin routes — score/override (C22: an admin can set a ceiling)", () => {
  it("applies a downward ceiling and reports the value it READ BACK", async () => {
    const tables = makeTables();
    const tablesClient = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) {
      await tablesClient.from("trust_events").insert({
        user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance",
        delta: 10, severity: "minor", status: "applied", source_type: "user_action",
      });
    }
    setClients({ tables });

    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_A}/score/override`, {
      category: "plan_attendance", score: 20, reason: "Watchlist",
    });

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.persistedScore, 20, "the value on trust_profiles, not the value requested");
    assert.equal(body.ceilingBinding, true, "and the fact that it is what is holding the score down");

    const cap = tables.trust_caps.find((c: any) => c.user_id === USER_A) as any;
    assert.equal(cap?.reason_code, "admin_override", "the ceiling is durable in trust_caps");
    const profile = tables.trust_profiles.find((r: any) => r.user_id === USER_A) as any;
    assert.equal(Number(profile.plan_attendance), 20, "and it reached the row the product gates on");
  });

  it("an UPWARD override is reported as binding nothing — CAP semantics, on the wire", async () => {
    // Mutation that turns this red: making the route answer a bare `{ ok: true }`
    // again, which reads identically for an override that withheld standing and
    // one that did nothing at all.
    const tables = makeTables();
    const seed = makeTrustClient(tables);
    await seed.from("trust_events").insert({
      user_id: USER_B, event_type: "PLAN_NO_SHOW", category: "plan_attendance",
      delta: -20, severity: "minor", status: "applied", source_type: "user_action",
    });
    setClients({ tables });

    const { status, body } = await httpReq("POST", `/admin/trust/users/${USER_B}/score/override`, {
      category: "plan_attendance", score: 90, reason: "Restoring standing",
    });

    assert.equal(status, 200);
    assert.equal(body.ceilingBinding, false, "an override cannot grant standing, and says so");
    assert.ok(body.persistedScore < 90, "the natural score stands");
  });

  it("refuses an unknown category rather than writing a cap nothing reads", async () => {
    const tables = makeTables();
    setClients({ tables });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/score/override`, {
      category: "vibes", score: 10, reason: "test",
    });
    assert.equal(status, 400);
    assert.equal(tables.trust_caps.length, 0, "and no cap row was created");
  });

  it("refuses a score outside 0–100", async () => {
    const tables = makeTables();
    setClients({ tables });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/score/override`, {
      category: "communication", score: 140, reason: "test",
    });
    assert.equal(status, 400);
    assert.equal(tables.trust_caps.length, 0);
  });

  it("is admin-only", async () => {
    setClients({ role: "user" });
    const { status } = await httpReq("POST", `/admin/trust/users/${USER_A}/score/override`, {
      category: "communication", score: 10, reason: "test",
    });
    assert.equal(status, 403);
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

  it("new user with no events gets neutral baseline (score=50, reliable_traveler)", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    const result = await recalculateTrustScore(db, USER_B);
    assert.equal(result.overall_score, 50);
    assert.equal(result.public_level, "reliable_traveler");
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
  it("a DOWNWARD cap override binds; removing it allows natural recalc", async () => {
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

// ── D-OVERRIDE: an override is a CEILING, and a ceiling is not a pin ──────────
//
// `adminOverrideScore` creates a `trust_caps` row with `ceiling_score = newScore`
// and ALSO upserts `trust_profiles` directly "for immediate effect". Those two
// writes disagree the moment anything recalculates, and they disagree in ONE
// direction only:
//
//   override BELOW the natural score -> the cap binds, the override survives.
//   override ABOVE the natural score -> the cap does not bind, recalculation
//                                       returns the natural score, and the
//                                       admin's number is silently gone.
//
// `loadCaps` folds caps with `Math.min` (TrustScoreService.ts:186) and
// `trust_caps` has no floor column at all, so this is structural rather than a
// bug in one branch. The tests below PIN that asymmetry so the product decision
// — does an admin override mean PIN or CAP? — has to change an assertion to be
// made, instead of being made by accident. Nothing here says which answer is
// right; it says what today's answer is.
describe("D-OVERRIDE: adminOverrideScore caps, and a cap only binds downward", () => {
  it("an override BELOW the natural score survives recalculation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) {
      await db.from("trust_events").insert({ user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance", delta: 10, severity: "minor", status: "applied", source_type: "user_action" });
    }
    const natural = (await recalculateTrustScore(db, USER_A)).categories.plan_attendance;
    assert.ok(natural > 20, `fixture must earn a natural score well above the override; got ${natural}`);

    await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 20, "Downward");
    const after = (await recalculateTrustScore(db, USER_A)).categories.plan_attendance;
    assert.equal(after, 20, "a downward override is a binding ceiling");
  });

  it("an override ABOVE the natural score does NOT survive recalculation", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    // One negative event, so the natural score sits below the neutral 50.
    await db.from("trust_events").insert({ user_id: USER_B, event_type: "PLAN_NO_SHOW", category: "plan_attendance", delta: -20, severity: "minor", status: "applied", source_type: "user_action" });
    const natural = (await recalculateTrustScore(db, USER_B)).categories.plan_attendance;
    assert.ok(natural < 90, `fixture must sit below the override; got ${natural}`);

    await adminOverrideScore(db, ADMIN, USER_B, "plan_attendance", 90, "Upward");

    // WORSE THAN "it does not persist": the override never lands at all.
    // `adminOverrideScore` upserts `trust_profiles` "for immediate effect" and
    // then, on its own last line before the audit write, awaits
    // `recalculateTrustScore` — which recomputes from events, applies the cap
    // as a CEILING, and overwrites the upsert. The admin's number is gone
    // before the function returns, so there is no window in which it was true.
    const persisted = tables.trust_profiles.find((r: any) => r.user_id === USER_B);
    assert.equal(
      (persisted as any)?.plan_attendance, natural,
      "the trailing recalculate inside adminOverrideScore overwrites its own upsert",
    );

    // And it stays gone on every later recalculation, because a ceiling of 90
    // cannot lift a score of `natural`. No event, no audit line, no error.
    const after = (await recalculateTrustScore(db, USER_B)).categories.plan_attendance;
    assert.equal(after, natural, "an upward override is discarded — a cap is not a pin");
    assert.notEqual(after, 90, "the admin's number is nowhere in the result");
  });

  it("trust_caps records the override as a ceiling, with no floor anywhere", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await adminOverrideScore(db, ADMIN, USER_A, "communication", 30, "Ceiling shape");
    const cap = tables.trust_caps.find((c: any) => c.user_id === USER_A && c.category === "communication");
    assert.ok(cap, "an override must leave a cap row");
    assert.equal((cap as any).ceiling_score, 30, "the override value is stored as a CEILING");
    assert.equal((cap as any).reason_code, "admin_override");
    assert.ok(
      !Object.keys(cap as any).some((k) => /floor/i.test(k)),
      "trust_caps has no floor column — an override can only ever pull a score down",
    );
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

// ── D-OVERRIDE, part 2: the three questions the v2 spec asks and no row answers ──
//
// `Portava_Trust_Architecture_Upgrade_v2.md` does not only ask "pin or cap?".
// It asks for "the selected semantics, PRECEDENCE WITH RESTRICTIONS, EXPIRY and
// REMOVAL behavior". Those three are separately observable and none of them was
// pinned anywhere, so any of them could have drifted without a test noticing.
//
// Nothing below chooses an answer. Each assertion records what the code does
// TODAY so that the owner's decision (census-trust D-OVERRIDE) has a concrete
// before-state, and so that converting ceiling into pin cannot happen quietly:
// it would have to rewrite these assertions by name.
describe("D-OVERRIDE precedence, expiry and removal — characterization, not a verdict", () => {
  it("EXPIRY: an admin override never expires on its own", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await adminOverrideScore(db, ADMIN, USER_A, "communication", 30, "No expiry");

    const cap = tables.trust_caps.find((c: any) => c.user_id === USER_A && c.category === "communication");
    assert.ok(cap, "an override must leave a cap row");
    assert.equal(
      (cap as any).expires_at, null,
      "adminOverrideScore passes no expiresAt, so the ceiling is permanent until an admin lifts it",
    );

    // expireOldCaps only touches rows whose expires_at has PASSED, so a null
    // one is never swept. A 'pin' product would probably want a review date;
    // a 'cap' product may well want permanence. Today it is permanence, by
    // omission rather than by decision.
    const lifted = await expireOldCaps(db);
    assert.equal(lifted, 0, "the sweeper cannot expire a null-expiry override");
    const stillActive = await getActiveCaps(db, USER_A);
    assert.equal(stillActive.length, 1, "the override is still in force after an expiry sweep");
  });

  it("PRECEDENCE vs other caps: an upward override cannot loosen a moderation ceiling", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // A confirmed serious finding capped respect_safety at 40.
    await createCap(db, {
      userId: USER_A, category: "respect_safety", ceilingScore: 40,
      reasonCode: "behavior_confirmed", sourceEventId: "evt-serious-1",
    });

    // An admin tries to restore standing by overriding to 90.
    await adminOverrideScore(db, ADMIN, USER_A, "respect_safety", 90, "Restoring standing");

    // TrustScoreService.loadCaps folds caps with Math.min, so the two ceilings
    // combine as 40 — the admin's 90 is inert. Under PIN semantics this is the
    // single most visible behavioural change: the admin would win.
    const after = (await recalculateTrustScore(db, USER_A)).categories.respect_safety;
    assert.ok(after <= 40, `the moderation ceiling still binds; got ${after}`);
    assert.notEqual(after, 90, "an override cannot grant relief from another cap today");
  });

  it("PRECEDENCE vs restrictions: an override is a SCORE ceiling and touches no restriction", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    const before = await getRestrictionState(db, USER_A);
    await adminOverrideScore(db, ADMIN, USER_A, "respect_safety", 0, "Zero the score");
    const after = await getRestrictionState(db, USER_A);

    // Zeroing every point of a user's safety score does not stop them doing
    // anything: restrictions live in trust_restrictions and nothing reads caps
    // to derive one. Whichever semantics is chosen, this stays a separate
    // decision — and it is worth the owner knowing that "override to 0" is NOT
    // a way to withhold access.
    assert.equal(tables.trust_restrictions.length, 0, "no restriction row was created");
    assert.deepEqual(
      { canMessage: after.canMessage, canHost: after.canHost },
      { canMessage: before.canMessage, canHost: before.canHost },
      "an override changes no eligibility",
    );
  });

  it("REMOVAL: adminRemoveOverride lifts every admin_override in the category and nothing else", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Two admins each set an override on the same category…
    await adminOverrideScore(db, ADMIN, USER_A, "communication", 30, "First admin");
    await adminOverrideScore(db, "admin-two", USER_A, "communication", 20, "Second admin");
    // …and an unrelated moderation cap stands in the same category.
    await createCap(db, {
      userId: USER_A, category: "communication", ceilingScore: 45,
      reasonCode: "message_report", sourceEventId: "evt-msg-1",
    });

    await adminRemoveOverride(db, ADMIN, USER_A, "communication", "Undo");

    const active = await getActiveCaps(db, USER_A);
    const reasons = active.map((c) => c.reasonCode).sort();
    // One admin's removal clears BOTH admins' overrides — the lift is keyed on
    // (user, category, reason_code), not on which admin set it. The moderation
    // cap is untouched, which is the half that must not change under either
    // semantics.
    assert.deepEqual(reasons, ["message_report"], `expected only the moderation cap to survive; got ${reasons.join(",")}`);
  });
});

// ── D-OVERRIDE, part 3: THE OWNER RULED — CAP NOW, and the ceiling must PERSIST ──
//
// census-trust §14.4 asked one question and the owner answered it: **CAP now,
// PIN later behind a flag.** An admin override is a MAXIMUM. It withholds
// standing and cannot grant it; it does not take precedence over a moderation
// ceiling; it does not expire; and PIN semantics (a floor column, an upward
// override, a relief path) is named as later work and is NOT built.
//
// The parts 1 and 2 blocks above pin the semantics and stay exactly as they
// were — the ruling ratified them, so not one of those assertions moves. What
// the ruling DID change is one defect, and it is not the one the census cell
// described. The cell said an upward override "never lands at all — there is no
// window in which it was true". That is right only while `recalculateTrustScore`
// SUCCEEDS. It is fail-closed by design (an unreadable trust_settings,
// trust_events or trust_caps makes it THROW and write nothing), the throw was
// swallowed by `.catch(() => {})`, and `adminOverrideScore` wrote the admin's
// raw number into `trust_profiles` BEFORE it. So on that path the raw number did
// not merely land — it STAYED, uncapped by anything, on a row whose
// `overall_score` and `public_level` still described the old score, while the
// admin was told `{ ok: true }` and a `score_override` audit row recorded an
// override the engine had never applied.
//
// That is the reverse of a cap: an upward 90 against a `behavior_confirmed`
// ceiling of 40 granted, permanently, exactly the relief the ruling says an
// admin does not have today. The fix is the narrow one the ruling asked for:
// the raw write is gone, `recalculateTrustScore` is the only writer of a scored
// column, its failure is no longer swallowed, and the persisted value is READ
// BACK so "the ceiling is in force" is a measurement rather than a claim.
describe("D-OVERRIDE: the ceiling the owner ruled for must PERSIST", () => {
  // A client that answers one table with a database error, everything else
  // normally. supabase-js RESOLVES on a database error, which is the shape the
  // fail-closed loaders in TrustScoreService are written against.
  function unreadable(table: string): any {
    const error = { message: `${table} unreadable (injected)`, code: "57014" };
    const b: any = {};
    for (const m of ["select", "insert", "upsert", "update", "delete", "eq", "in",
                     "is", "gt", "lt", "not", "or", "order", "limit", "range"]) {
      b[m] = () => b;
    }
    b.maybeSingle = async () => ({ data: null, error });
    b.single      = async () => ({ data: null, error });
    b.then = (onF: any, onR: any) =>
      Promise.resolve({ data: null, error, count: null }).then(onF, onR);
    return b;
  }

  function makeClientWithUnreadableTable(tables: FakeTables, table: string): any {
    const real = makeTrustClient(tables);
    return {
      ...real,
      from: (t: string) => (t === table ? unreadable(table) : real.from(t as any)),
    };
  }

  it("a downward ceiling reaches trust_profiles, and the call REPORTS that it bound", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) {
      await db.from("trust_events").insert({
        user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance",
        delta: 10, severity: "minor", status: "applied", source_type: "user_action",
      });
    }
    const before = await recalculateTrustScore(db, USER_A);
    assert.ok(before.categories.plan_attendance > 20,
      `fixture must earn a natural score well above the ceiling; got ${before.categories.plan_attendance}`);

    const result = await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 20, "Watchlist");

    // The measurement, not the computation: read the row.
    const persisted = tables.trust_profiles.find((r: any) => r.user_id === USER_A) as any;
    assert.equal(persisted.plan_attendance, 20,
      "the ceiling survives adminOverrideScore's own recalculation");
    assert.ok(Number(persisted.overall_score) < Number(before.overall_score),
      `the ceiling reached the weighted number the product gates on; ${persisted.overall_score} vs ${before.overall_score}`);

    // And the caller is TOLD what happened, rather than told `{ ok: true }` and
    // left to read the table to find out.
    assert.equal(result.persistedScore, 20, "persistedScore is read back from trust_profiles");
    assert.equal(result.ceilingBinding, true, "the admin's number is what is holding the score down");
  });

  it("an UPWARD override reports that it bound NOTHING — CAP semantics, said out loud", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await db.from("trust_events").insert({
      user_id: USER_B, event_type: "PLAN_NO_SHOW", category: "plan_attendance",
      delta: -20, severity: "minor", status: "applied", source_type: "user_action",
    });
    const natural = (await recalculateTrustScore(db, USER_B)).categories.plan_attendance;

    const result = await adminOverrideScore(db, ADMIN, USER_B, "plan_attendance", 90, "Upward");

    // Unchanged from the characterization block above: a cap is not a pin, and
    // the ruling ratified that. What is new is that the admin is no longer told
    // "ok" about a number that did nothing.
    assert.equal(result.persistedScore, natural, "the natural score stands");
    assert.equal(result.ceilingBinding, false, "an upward override withholds nothing, and says so");
    const audit = tables.trust_admin_actions.find((a: any) => a.action_type === "score_override") as any;
    assert.equal(audit?.metadata?.ceilingBinding, false,
      "the audit records what HAPPENED, not what was asked for");
  });

  // ── THE DEFECT ────────────────────────────────────────────────────────────
  it("a failed recalculation leaves NO raw admin number on the row, and is never audited as applied", async () => {
    const tables = makeTables();
    const seed = makeTrustClient(tables);

    // A confirmed serious finding has capped respect_safety at 40, and the
    // persisted profile reflects that ceiling.
    await createCap(seed, {
      userId: USER_A, category: "respect_safety", ceilingScore: 40,
      reasonCode: "behavior_confirmed", sourceEventId: "evt-serious-2",
    });
    tables.trust_profiles.push({
      user_id: USER_A, overall_score: 48.5, public_level: "reliable_traveler",
      plan_attendance: 50, host_quality: 50, communication: 50, respect_safety: 40,
      location_honesty: 50, content_quality: 50, community_value: 50,
      guide_accuracy: 50, passport_authenticity: 50,
      on_probation: false, probation_ends_at: null,
      last_recalculated_at: new Date().toISOString(),
    });

    // trust_events cannot be read, so recalculateTrustScore is fail-closed and
    // throws — the exact state its own header says must write nothing.
    const db = makeClientWithUnreadableTable(tables, "trust_events");

    await assert.rejects(
      () => adminOverrideScore(db, ADMIN, USER_A, "respect_safety", 90, "Restoring standing"),
      /trust_events read failed|did not take effect|NOT confirmed/,
      "an override whose recalculation did not happen must not be reported as applied",
    );

    const persisted = tables.trust_profiles.find((r: any) => r.user_id === USER_A) as any;
    // THE ASSERTION THAT WAS RED. The raw upsert used to write 90 here and the
    // swallowed throw used to leave it standing: an admin granting themselves
    // relief from a moderation ceiling, permanently, by accident.
    assert.equal(persisted.respect_safety, 40,
      "no raw admin number is written to a scored column — only a recalculation writes one");
    assert.equal(persisted.overall_score, 48.5,
      "and the row stays internally consistent: the category and the weighted number still agree");

    assert.equal(
      tables.trust_admin_actions.filter((a: any) => a.action_type === "score_override").length, 0,
      "no audit row may claim an override the engine never applied",
    );

    // The ceiling itself is durable and is NOT rolled back: trust_caps is where
    // it lives, and the next successful recalculation applies it.
    const capRow = tables.trust_caps.find((c: any) => c.user_id === USER_A && c.reason_code === "admin_override") as any;
    assert.equal(capRow?.ceiling_score, 90, "the cap row stands; only the claim of effect is withheld");
  });

  // ── IDF-51: THE REMOVAL PATH HAD THE DEFECT THE APPLY PATH NO LONGER HAS ──
  //
  // `adminRemoveOverride` swallowed the lift with `.catch(() => {})`, swallowed
  // the recalculation with another, then wrote the audit row and returned
  // `{ ok: true }` unconditionally, with no read-back. So a removal that lifted
  // nothing — or that lifted the cap and never got the score back up — was
  // reported and audited as done. Ceiling persistence was confirmed on apply and
  // unconfirmed on remove, which is half a guarantee.
  //
  // The shape these assert is the apply path's own, deliberately: every step
  // awaited, nothing swallowed, and the outcome READ BACK before it is claimed.

  /**
   * A client whose `trust_caps` SELECT works and whose UPDATE matches nothing —
   * the race where the cap is lifted by someone else between the read and the
   * write, and the state in which the old `liftCap` (no `.select()`) was
   * indistinguishable from success.
   */
  function makeClientWhereLiftMatchesNothing(tables: FakeTables): any {
    const real = makeTrustClient(tables);
    return {
      ...real,
      from: (t: string) => {
        const b = real.from(t as any);
        if (t !== "trust_caps") return b;
        const origUpdate = b.update.bind(b);
        b.update = (patch: any) => { origUpdate(patch); return b.eq("__no_such_column__", "x"); };
        return b;
      },
    };
  }

  it("REMOVAL: a lift that matched nothing REJECTS, and is not audited as a removal", async () => {
    const tables = makeTables();
    const seed = makeTrustClient(tables);
    await adminOverrideScore(seed, ADMIN, USER_A, "communication", 30, "Set the ceiling");
    const auditBefore = tables.trust_admin_actions.length;

    const db = makeClientWhereLiftMatchesNothing(tables);
    await assert.rejects(
      () => adminRemoveOverride(db, ADMIN, USER_A, "communication", "Undo"),
      /were not lifted|still in force/,
      "a removal that lifted nothing must say so instead of returning ok",
    );

    assert.equal(
      tables.trust_admin_actions.length, auditBefore,
      "no audit row claims an override was removed",
    );
    const cap = tables.trust_caps.find((c: any) => c.user_id === USER_A && c.reason_code === "admin_override") as any;
    assert.ok(!cap.lifted_at, "and the ceiling is still standing, which is the truth");
  });

  it("REMOVAL: a failed recalculation REJECTS, and is not audited as a removal", async () => {
    const tables = makeTables();
    const seed = makeTrustClient(tables);
    await adminOverrideScore(seed, ADMIN, USER_A, "communication", 30, "Set the ceiling");
    const auditBefore = tables.trust_admin_actions.length;

    // recalculateTrustScore is fail-closed: an unreadable trust_events makes it
    // THROW and write nothing. That throw used to be swallowed.
    const db = makeClientWithUnreadableTable(tables, "trust_events");
    await assert.rejects(
      () => adminRemoveOverride(db, ADMIN, USER_A, "communication", "Undo"),
      /trust_events|not confirmed|NOT confirmed/i,
      "a removal whose recalculation did not run has not taken effect",
    );

    assert.equal(
      tables.trust_admin_actions.length, auditBefore,
      "no audit row claims a removal the engine never applied",
    );
  });

  it("REMOVAL: removing an override that is not there REJECTS rather than reporting a removal", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    await assert.rejects(
      () => adminRemoveOverride(db, ADMIN, USER_A, "communication", "Undo"),
      /nothing was removed/,
      "an empty result is not a completed removal",
    );
    assert.equal(auditRows(tables).length, 0);
  });

  it("REMOVAL: an unreadable trust_caps REJECTS — a failed read is not an empty one", async () => {
    const tables = makeTables();
    const db = makeClientWithUnreadableTable(tables, "trust_caps");
    await assert.rejects(
      () => adminRemoveOverride(db, ADMIN, USER_A, "communication", "Undo"),
      /trust_caps read failed/,
    );
    assert.equal(auditRows(tables).length, 0);
  });

  it("REMOVAL: the success path returns what it OBSERVED, and the score comes back", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);
    for (let i = 0; i < 5; i++) {
      await db.from("trust_events").insert({
        user_id: USER_A, event_type: "PLAN_ATTENDED", category: "plan_attendance",
        delta: 10, severity: "minor", status: "applied", source_type: "user_action",
      });
    }
    const natural = (await recalculateTrustScore(db, USER_A)).categories.plan_attendance;
    await adminOverrideScore(db, ADMIN, USER_A, "plan_attendance", 20, "Watchlist");
    assert.equal(
      (tables.trust_profiles.find((r: any) => r.user_id === USER_A) as any).plan_attendance, 20,
      "precondition: the ceiling is in force",
    );

    const result = await adminRemoveOverride(db, ADMIN, USER_A, "plan_attendance", "Undo");

    assert.equal(result.ok, true);
    assert.equal(result.liftedCapIds.length, 1, "it names the cap it actually lifted");
    assert.equal(result.persistedScore, natural,
      "and the score is READ BACK from trust_profiles, not computed and asserted");
    const persisted = tables.trust_profiles.find((r: any) => r.user_id === USER_A) as any;
    assert.equal(Number(persisted.plan_attendance), natural, "the ceiling is gone from the scored row");
    assert.equal(
      auditRows(tables, "score_override").filter((a: any) => a.metadata?.action === "remove_override").length, 1,
      "exactly one removal audit row, written only after all of that",
    );
  });
});

// ── D-REVERSAL (census-trust TRV2-10): what reversal does NOT reach today ─────
//
// TRV2-10 is this census's one CANNOT-VERIFY: its correctness is defined by
// "the DEFINED reversal/retention policy" and no approved document defines one.
// Three mechanisms exist and they disagree about scope. The cell describing
// them was prose; this block makes the load-bearing half of it a MEASUREMENT,
// so the owner's decision has a tested before-state and so a future change to
// the scope cannot happen without an assertion going red.
//
// Nothing here says what SHOULD happen. It says what does.
describe("D-REVERSAL: revocation reverses moderation consequences and nothing else", () => {
  it("dismisses moderation-sourced events and leaves an identity_verified award standing", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Two events on the same user from two different provenances.
    //   - a confirmed behaviour report, source_type 'moderation'
    //   - the +10 identity_verified award, source_type 'identity_verification'
    //     (routes/verification.ts writes exactly that source_type)
    await db.from("trust_events").insert({
      user_id: USER_A, event_type: "behavior_report_confirmed", category: "respect_safety",
      delta: -20, severity: "severe", status: "applied", source_type: "moderation",
    });
    await db.from("trust_events").insert({
      user_id: USER_A, event_type: "identity_verified", category: "respect_safety",
      delta: 10, severity: "minor", status: "applied", source_type: "identity_verification",
    });

    await revokeModerationTrustConsequences(db, ADMIN, USER_A, "Ban lifted on appeal");

    const byType = (t: string) =>
      tables.trust_events.find((e: any) => e.user_id === USER_A && e.event_type === t);

    assert.equal(
      (byType("behavior_report_confirmed") as any)?.status, "dismissed",
      "the moderation finding's trust consequence is reversed — this half is C14 and works",
    );
    // THE MEASUREMENT. `revokeModerationTrustConsequences` selects on
    // source_type = 'moderation', so an award that came from the identity
    // provider is outside its reach by construction. Revoking a user's
    // verification therefore clears profiles.verification_level (TV-4c) and
    // leaves the +10 it earned in the ledger, scoring, indefinitely.
    //
    // Whether that is right is D-REVERSAL and is NOT decided here. What is
    // recorded is that the two halves of "verified" — the displayed level and
    // the trust award — currently come apart on revocation, and that nothing in
    // the code expresses an intention either way.
    assert.equal(
      (byType("identity_verified") as any)?.status, "applied",
      "the identity award is untouched by moderation reversal — the D-REVERSAL gap, measured",
    );
  });

  it("keys the reversal on the source EVENT, so one reversed finding cannot clear another", async () => {
    const tables = makeTables();
    const db = makeTrustClient(tables);

    // Two independent moderation findings, each with its own cap.
    const e1 = await db.from("trust_events").insert({
      user_id: USER_B, event_type: "behavior_report_confirmed", category: "respect_safety",
      delta: -20, severity: "severe", status: "applied", source_type: "moderation",
    }).select("id").single();
    await createCap(db, {
      userId: USER_B, category: "respect_safety", ceilingScore: 40,
      reasonCode: "behavior_confirmed", sourceEventId: (e1 as any).data.id,
    });
    // A cap from an event that is NOT being reversed (a different provenance).
    await createCap(db, {
      userId: USER_B, category: "content_quality", ceilingScore: 50,
      reasonCode: "content_removed", sourceEventId: "some-other-event-id",
    });

    await revokeModerationTrustConsequences(db, ADMIN, USER_B, "Restored");

    const active = await getActiveCaps(db, USER_B);
    assert.deepEqual(
      active.map((c) => c.reasonCode),
      ["content_removed"],
      "only the cap whose SOURCE EVENT was reversed is lifted; an unrelated standing finding survives",
    );
  });
});
