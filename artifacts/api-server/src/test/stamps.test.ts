/**
 * Stamp System v2 — Smoke Tests
 *
 * Covers:
 *  A. Non-repeatable stamp: first award succeeds, second returns awarded:false
 *  B. recalculate/me is idempotent
 *  C. Revoked stamp excluded from GET /stamps/user/:userId public view
 *  D. check-eligibility returns eligible:true on fresh state
 *  E. POST /stamps/award requires admin role (authz gate)
 *  F. friends_only stamp: visible to friend, hidden from public
 *  G. Source validation: cancelled trip rejected
 *  H. Audit event required: revoke fails if audit write would fail
 *
 * Runtime: node:test + node:assert/strict (no vitest / no supertest)
 * Run: node --import tsx/esm --test src/test/stamps.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient, _setTestServiceClient } from "../lib/http.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL_ID  = "cccccccc-0000-4000-8000-000000000003";
const DAVE_ID   = "dddddddd-0000-4000-8000-000000000004";
const ADMIN_ID  = "dddddddd-0000-4000-8000-000000000004";
const DEF_ID    = "eeeeeeee-0000-4000-8000-000000000005";
const STAMP_ID  = "ffffffff-0000-4000-8000-000000000006";

const DEF_SLUG = "first_trip";

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  currentUserId?: string;
  profiles?: any[];
  stampDefinitions?: any[];
  userStamps?: any[];
  stampAwardEvents?: any[];
  stampProgress?: any[];
  stampCollections?: any[];
  stampCollectionItems?: any[];
  stampCampaigns?: any[];
  blocks?: any[];
  featureFlags?: any[];
  userFriendships?: any[];
  trips?: any[];
  posts?: any[];
  events?: any[];
  /** When true, stamp_award_events inserts will always fail with a generic error */
  failAuditInserts?: boolean;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    profiles:               state.profiles ?? [],
    stamp_definitions:      state.stampDefinitions ?? [],
    user_stamps:            state.userStamps ?? [],
    stamp_award_events:     state.stampAwardEvents ?? [],
    stamp_progress:         state.stampProgress ?? [],
    stamp_collections:      state.stampCollections ?? [],
    stamp_collection_items: state.stampCollectionItems ?? [],
    stamp_campaigns:        state.stampCampaigns ?? [],
    blocks:                 state.blocks ?? [],
    feature_flags:          state.featureFlags ?? [
      { flag: "stamp_system_v2_enabled", key: "stamp_system_v2_enabled", enabled: true },
    ],
    user_friendships:       state.userFriendships ?? [],
    trips:                  state.trips ?? [],
    posts:                  state.posts ?? [],
    events:                 state.events ?? [],
  };

  const userId = state.currentUserId ?? ALICE_ID;
  const failAudit = state.failAuditInserts ?? false;

  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _insert: any = null;
    let _update: any = null;
    let _limit: number | null = null;
    let _count = false;
    let _single = false;
    let _maybeSingle = false;
    let _head = false;

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    const chain: any = {
      select(cols?: string, opts?: any) {
        if (opts?.count === "exact") _count = true;
        if (opts?.head) _head = true;
        return chain;
      },
      insert(data: any) {
        _insert = Array.isArray(data) ? data : [data];
        return chain;
      },
      update(data: any) { _update = data; return chain; },
      upsert(data: any) { _insert = Array.isArray(data) ? data : [data]; return chain; },
      delete() { return chain; },
      eq(col: string, val: any) {
        _filters.push((r) => r[col] === val);
        return chain;
      },
      neq(col: string, val: any) {
        _filters.push((r) => r[col] !== val);
        return chain;
      },
      is(col: string, val: any) {
        if (val === null) _filters.push((r) => r[col] == null);
        else _filters.push((r) => r[col] === val);
        return chain;
      },
      or(expr: string) {
        // Simple OR support for block/friendship checks using comma-separated and() groups
        // We parse patterns like: and(a.eq.X,b.eq.Y),and(a.eq.Z,b.eq.W)
        const andGroups = expr.split(/,(?=and\()/).map((g: string) => {
          const inner = g.replace(/^and\(/, "").replace(/\)$/, "");
          return inner.split(",").map((clause: string) => {
            const m = clause.match(/^(\w+)\.(eq|is)\.(.+)$/);
            if (!m) return () => true;
            const [, col, op, val] = m;
            return (r: any) => op === "is" ? (val === "null" ? r[col] == null : r[col] === val) : r[col] === val;
          });
        });
        _filters.push((r) =>
          andGroups.some((group: Array<(r: any) => boolean>) => group.every((f) => f(r))),
        );
        return chain;
      },
      in(col: string, vals: any[]) {
        _filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      gte() { return chain; },
      lte() { return chain; },
      gt() { return chain; },
      ilike() { return chain; },
      order() { return chain; },
      range() { return chain; },
      limit(n: number) { _limit = n; return chain; },
      single() { _single = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head() { _head = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            // Insert
            if (_insert) {
              // Simulate audit insert failure when flag is set
              if (table === "stamp_award_events" && failAudit) {
                return resolve({ data: null, error: { message: "simulated audit failure", code: "500" } });
              }

              for (const row of _insert) {
                if (!db[table]) db[table] = [];
                const newRow = { id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row };
                db[table].push(newRow);
              }

              // Check idempotency_key uniqueness on stamp_award_events
              if (table === "stamp_award_events") {
                const keys = db[table].map((r: any) => r.idempotency_key).filter(Boolean);
                const unique = new Set(keys);
                if (unique.size < keys.length) {
                  // Remove the duplicate just added
                  db[table].pop();
                  return resolve({ data: null, error: { message: "duplicate key value", code: "23505" } });
                }
              }

              const inserted = _insert.length === 1 ? { ...db[table][db[table].length - 1] } : _insert;
              if (_single || _maybeSingle) return resolve({ data: inserted, error: null });
              return resolve({ data: _insert, error: null });
            }

            // Update
            if (_update) {
              const matches = applyFilters(db[table] ?? []);
              for (const row of matches) Object.assign(row, _update);
              if (_single)      return resolve({ data: matches[0] ?? null, error: null });
              if (_maybeSingle) return resolve({ data: matches[0] ?? null, error: null });
              return resolve({ data: matches, error: null });
            }

            // Select
            let results = applyFilters(db[table] ?? []);
            if (_limit !== null) results = results.slice(0, _limit);
            const cnt = results.length;
            if (_head) return resolve({ data: null, error: null, count: cnt });
            if (_single)      return resolve({ data: results[0] ?? null, error: null, count: _count ? cnt : undefined });
            if (_maybeSingle) return resolve({ data: results[0] ?? null, error: null, count: _count ? cnt : undefined });
            return resolve({ data: results, error: null, count: _count ? cnt : undefined });
          } catch (e) {
            return resolve({ data: null, error: { message: String(e) } });
          }
        }).catch(reject);
      },
    };

    return chain;
  }

  return {
    auth: {
      getUser: async (_token: string) => ({
        data: { user: { id: userId, email: "test@example.com" } },
        error: null,
      }),
    },
    from: (table: string) => buildChain(table),
    rpc: async () => ({ data: null, error: null }),
  };
}

// ── App factory ───────────────────────────────────────────────────────────────

async function makeApp() {
  const { default: stampsRouter } = await import("../routes/stamps.js");
  const { default: adminStampsRouter } = await import("../routes/adminStamps.js");

  const app = express();
  app.use(express.json());
  app.use("/api", stampsRouter);
  app.use("/api", adminStampsRouter);
  return app;
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe("Stamp system v2 — smoke tests", async () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  before(async () => {
    const app = await makeApp();
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as any).port;
  });

  after(() => { server.close(); });

  function base() { return `http://127.0.0.1:${port}/api`; }
  function authHeaders(uid = ALICE_ID) {
    return { "Content-Type": "application/json", Authorization: `Bearer token-${uid}` };
  }

  const baseDef = {
    id: DEF_ID, slug: DEF_SLUG, name: "First Trip",
    is_active: true, is_repeatable: false,
    max_awards_per_user: null, visibility_default: "public",
    criteria_type: "automatic",
  };

  // ── A. Non-repeatable stamp idempotency ──────────────────────────────────────
  // Award goes through /api/admin/stamps/award (service-role internal;
  // admin HTTP is the only supported HTTP path).

  describe("A. Non-repeatable stamp idempotency", () => {
    let state: FakeState;

    before(() => {
      state = {
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [baseDef],
        userStamps: [],
        stampAwardEvents: [],
        trips: [{ id: "f1f1f1f1-0000-4000-8000-000000000001", status: "completed" }],
      };
      _setTestClient(makeClient(state), true);
    });

    it("awards stamp on first call (admin/stamps/award endpoint)", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          sourceType: "trips",
          sourceId: "f1f1f1f1-0000-4000-8000-000000000001",
          reason: "Completed first trip",
        }),
      });
      const body = await res.json();
      assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(body)}`);
      assert.equal(body.awarded, true);
      assert.ok(body.userStampId);
    });

    it("returns awarded:false on second call (non-repeatable idempotency)", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          sourceType: "trips",
          sourceId: "f1f1f1f1-0000-4000-8000-000000000001",
          reason: "Completed first trip",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.awarded, false);
    });
  });

  // ── B. recalculate/me idempotency ────────────────────────────────────────────

  describe("B. recalculate/me idempotency", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles: [{ id: ALICE_ID, role: "user" }],
        stampDefinitions: [baseDef],
        userStamps: [{ id: STAMP_ID, user_id: ALICE_ID, stamp_definition_id: DEF_ID, is_revoked: false }],
        stampAwardEvents: [],
      }), true);
    });

    it("recalculate/me returns numeric counts", async () => {
      const res = await fetch(`${base()}/stamps/recalculate/me`, {
        method: "POST",
        headers: authHeaders(),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(typeof body.checked === "number");
      assert.ok(typeof body.skipped === "number");
      assert.ok(typeof body.awarded === "number");
    });

    it("recalculate/me twice produces same awarded count (idempotent)", async () => {
      const r1 = await fetch(`${base()}/stamps/recalculate/me`, { method: "POST", headers: authHeaders() });
      const r2 = await fetch(`${base()}/stamps/recalculate/me`, { method: "POST", headers: authHeaders() });
      const [b1, b2] = await Promise.all([r1.json(), r2.json()]);
      assert.equal(b1.awarded, b2.awarded);
    });
  });

  // ── C. Revoked stamp excluded from public view ────────────────────────────────

  describe("C. Revoked stamp excluded from public view", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles: [{ id: ALICE_ID, role: "user" }, { id: BOB_ID, role: "user" }],
        blocks: [],
        userFriendships: [],
        userStamps: [{
          id: STAMP_ID, user_id: BOB_ID, stamp_definition_id: DEF_ID,
          is_revoked: true, visibility: "public", display_on_passport: true,
          earned_at: new Date().toISOString(), created_at: new Date().toISOString(),
        }],
        stampDefinitions: [baseDef],
        stampAwardEvents: [],
      }), true);
    });

    it("GET /stamps/user/:userId excludes revoked stamps", async () => {
      const res = await fetch(`${base()}/stamps/user/${BOB_ID}`, {
        headers: authHeaders(ALICE_ID),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      const revoked = (body.stamps ?? []).filter((s: any) => s.isRevoked);
      assert.equal(revoked.length, 0, "No revoked stamps should appear in public view");
    });
  });

  // ── D. check-eligibility dry-run ─────────────────────────────────────────────

  describe("D. check-eligibility dry-run", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles: [{ id: ALICE_ID, role: "user" }],
        stampDefinitions: [baseDef],
        userStamps: [],
        stampAwardEvents: [],
        trips: [{ id: "f1f1f1f1-0000-4000-8000-000000000001", status: "completed" }],
      }), true);
    });

    it("returns eligible:true when stamp not yet earned", async () => {
      const res = await fetch(`${base()}/stamps/check-eligibility`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          sourceType: "trips",
          sourceId: "f1f1f1f1-0000-4000-8000-000000000001",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.eligible, true);
    });
  });

  // ── E. POST /admin/stamps/award requires admin role ──────────────────────────
  // Internal award is service-role only (not HTTP). Admin HTTP award is at
  // /api/admin/stamps/award and requires admin role.

  describe("E. Admin award endpoint requires admin role", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles: [{ id: ALICE_ID, role: "user" }],
        stampDefinitions: [],
        userStamps: [],
        stampAwardEvents: [],
      }), true);
    });

    it("returns 403 for non-admin caller on /admin/stamps/award", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ALICE_ID),
        body: JSON.stringify({
          userId: BOB_ID,
          definitionSlug: DEF_SLUG,
          reason: "test",
        }),
      });
      assert.equal(res.status, 403);
    });
  });

  // ── F. friends_only visibility ────────────────────────────────────────────────

  describe("F. friends_only stamp visibility", () => {
    const friendsOnlyStamp = {
      id: STAMP_ID, user_id: BOB_ID, stamp_definition_id: DEF_ID,
      is_revoked: false, visibility: "friends_only", display_on_passport: true,
      earned_at: new Date().toISOString(), created_at: new Date().toISOString(),
    };

    it("non-friend cannot see friends_only stamp", async () => {
      _setTestClient(makeClient({
        currentUserId: CAROL_ID,
        profiles: [{ id: CAROL_ID, role: "user" }, { id: BOB_ID, role: "user" }],
        blocks: [],
        userFriendships: [],       // Carol and Bob are NOT friends
        userStamps: [friendsOnlyStamp],
        stampDefinitions: [baseDef],
        stampAwardEvents: [],
      }), true);

      const res = await fetch(`${base()}/stamps/user/${BOB_ID}`, {
        headers: authHeaders(CAROL_ID),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.stamps.length, 0, "Non-friend should not see friends_only stamp");
    });

    it("accepted friend can see friends_only stamp", async () => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles: [{ id: ALICE_ID, role: "user" }, { id: BOB_ID, role: "user" }],
        blocks: [],
        userFriendships: [{
          id: "aa01-0000-0000-0000-000000000001",
          user_a: ALICE_ID, user_b: BOB_ID,
        }],
        userStamps: [friendsOnlyStamp],
        stampDefinitions: [baseDef],
        stampAwardEvents: [],
      }), true);

      const res = await fetch(`${base()}/stamps/user/${BOB_ID}`, {
        headers: authHeaders(ALICE_ID),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.stamps.length, 1, "Friend should see friends_only stamp");
    });
  });

  // ── G. Source validation: cancelled trip rejected ─────────────────────────────

  describe("G. Source validation rejects cancelled trip", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [baseDef],
        userStamps: [],
        stampAwardEvents: [],
        trips: [{ id: "f1f1f1f1-0000-4000-8000-000000000001", status: "cancelled" }],
      }), true);
    });

    it("returns awarded:false for cancelled source trip", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          sourceType: "trips",
          sourceId: "f1f1f1f1-0000-4000-8000-000000000001",
          reason: "test",
        }),
      });
      // 200 because not awarded, with reason about invalid source
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.awarded, false);
      assert.ok(
        body.reason.includes("cancelled") || body.reason.includes("source_invalid"),
        `Expected source_invalid reason, got: ${body.reason}`,
      );
    });
  });

  // ── H. Unknown definitionSlug returns awarded:false ───────────────────────────

  describe("H. Unknown definitionSlug returns awarded:false", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles:         [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [],       // empty — slug cannot be found
        userStamps:       [],
        stampAwardEvents: [],
      }), true);
    });

    it("returns awarded:false with definition_not_found reason", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: "does_not_exist",
          sourceType: "system",
          reason: "test",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.awarded, false);
      assert.equal(body.reason, "definition_not_found");
    });
  });

  // ── I. Service client unavailable returns a safe structured error ─────────────

  describe("I. Service client unavailable returns safe structured error", () => {
    before(() => {
      // Set up auth client (so requireUser can authenticate the request)...
      _setTestClient(makeClient({ currentUserId: ALICE_ID }), true);
      // ...then replace the service client with a broken fake that throws on every
      // DB call. Setting _testServiceClient to null does NOT work when
      // SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are present in the environment —
      // getServiceClient() falls back to the real client instead.
      const brokenClient: any = {
        auth: { getUser: async () => ({ data: { user: { id: ALICE_ID } }, error: null }) },
        from: () => {
          throw new Error("service client simulated failure");
        },
        rpc: async () => ({ data: null, error: { message: "service client simulated failure" } }),
      };
      _setTestServiceClient(brokenClient);
    });

    after(() => {
      // Restore both slots so later tests are not affected
      _setTestClient(makeClient({ currentUserId: ALICE_ID }), true);
    });

    it("GET /stamps/me returns a structured error (not a crash) when service client is broken", async () => {
      const res = await fetch(`${base()}/stamps/me`, {
        headers: authHeaders(ALICE_ID),
      });
      // Must return 500 or 503 — never a connection error or unhandled exception
      assert.ok(
        res.status === 500 || res.status === 503,
        `Expected 500 or 503, got ${res.status}`,
      );
      const body = await res.json();
      assert.ok(body.error, "Response must include an error field");
    });
  });

  // ── J. POST /stamps/award internal endpoint rejects invalid secrets ───────────

  describe("J. POST /stamps/award rejects missing or wrong X-Internal-Secret", () => {
    before(() => {
      process.env.INTERNAL_API_SECRET = "stamps-test-secret-xyz";
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        stampDefinitions: [baseDef],
        userStamps:       [],
        stampAwardEvents: [],
        trips: [{ id: "f1f1f1f1-0000-4000-8000-000000000001", status: "completed" }],
      }), true);
    });

    after(() => {
      delete process.env.INTERNAL_API_SECRET;
    });

    it("returns 401 when X-Internal-Secret header is absent", async () => {
      const res = await fetch(`${base()}/stamps/award`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: ALICE_ID, definitionSlug: DEF_SLUG }),
      });
      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    });

    it("returns 401 when X-Internal-Secret header has wrong value", async () => {
      const res = await fetch(`${base()}/stamps/award`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Secret": "not-the-right-secret" },
        body: JSON.stringify({ userId: ALICE_ID, definitionSlug: DEF_SLUG }),
      });
      assert.equal(res.status, 401, `Expected 401, got ${res.status}`);
    });
  });

  // ── K. recalculate/me with no award events returns zero counts ──────────────

  describe("K. recalculate/me with no award events returns zero counts", () => {
    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles:         [{ id: ALICE_ID, role: "user" }],
        stampDefinitions: [],
        userStamps:       [],
        stampAwardEvents: [],   // empty — recalculateForUser returns early
      }), true);
    });

    it("returns { checked: 0, awarded: 0, skipped: 0 } when no award events exist", async () => {
      const res = await fetch(`${base()}/stamps/recalculate/me`, {
        method: "POST",
        headers: authHeaders(),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.checked, 0, `Expected checked=0, got ${body.checked}`);
      assert.equal(body.awarded, 0, `Expected awarded=0, got ${body.awarded}`);
      assert.equal(body.skipped, 0, `Expected skipped=0, got ${body.skipped}`);
    });
  });

  // ── M. first_trip_created awarded on first non-draft trip ────────────────────

  describe("M. first_trip_created awarded on first non-draft trip", () => {
    const TRIP_DEF: typeof baseDef = {
      id: "dddddef0-0000-4000-8000-000000000099",
      slug: "first_trip_created",
      name: "First Trip Created",
      is_active: true,
      is_repeatable: false,
      max_awards_per_user: null,
      visibility_default: "public",
      criteria_type: "automatic",
    };

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [TRIP_DEF],
        userStamps: [],
        stampAwardEvents: [],
        trips: [{ id: "aa00aa00-0000-4000-8000-000000000001", status: "upcoming" }],
      }), true);
    });

    it("awards first_trip_created on first call", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: "first_trip_created",
          sourceType: "trips",
          sourceId: "aa00aa00-0000-4000-8000-000000000001",
          reason: "backfill test",
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.awarded, true, "Expected awarded:true on first_trip_created");
    });

    it("returns awarded:false on second call (non-repeatable)", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: "first_trip_created",
          sourceType: "trips",
          sourceId: "aa00aa00-0000-4000-8000-000000000001",
          reason: "backfill test",
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.awarded, false, "Expected awarded:false on duplicate call");
    });
  });

  // ── N. first_postcard awarded on first passport postcard ──────────────────────

  describe("N. first_postcard stamp awarded once", () => {
    const POSTCARD_DEF: typeof baseDef = {
      id: "dddddef1-0000-4000-8000-000000000099",
      slug: "first_postcard",
      name: "First Postcard",
      is_active: true,
      is_repeatable: false,
      max_awards_per_user: null,
      visibility_default: "public",
      criteria_type: "automatic",
    };
    const POST_ID = "pp000001-0000-4000-8000-000000000001";

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [POSTCARD_DEF],
        userStamps: [],
        stampAwardEvents: [],
        posts: [{ id: POST_ID, status: "active" }],
      }), true);
    });

    it("awards first_postcard when sourceType=posts", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: BOB_ID,
          definitionSlug: "first_postcard",
          sourceType: "posts",
          sourceId: POST_ID,
          reason: "backfill test",
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.awarded, true, "Expected awarded:true for first_postcard");
    });
  });

  // ── O. Stamp definitions unknown to the engine do not crash the routes ────────

  describe("O. Unknown stamp slugs (safe_return_ready, safe_return_completed, etc.) return definition_not_found gracefully", () => {
    const unknownSlugs = [
      "safe_return_ready",
      "safe_return_completed",
      "first_buddy_booking",
      "first_buddy_hosted",
      "hidden_gem_explorer",
      "verified_traveler",
    ];

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [],  // empty — none of these are in DB
        userStamps: [],
        stampAwardEvents: [],
      }), true);
    });

    for (const slug of unknownSlugs) {
      it(`returns awarded:false with definition_not_found for ${slug}`, async () => {
        const res = await fetch(`${base()}/admin/stamps/award`, {
          method: "POST",
          headers: authHeaders(ADMIN_ID),
          body: JSON.stringify({
            userId: ALICE_ID,
            definitionSlug: slug,
            sourceType: "system",
            reason: "backfill test",
          }),
        });
        assert.equal(res.status, 200, `Expected 200 for unknown slug, got ${res.status}`);
        const body = await res.json();
        assert.equal(body.awarded, false, `Expected awarded:false for ${slug}`);
        assert.equal(body.reason, "definition_not_found", `Expected definition_not_found for ${slug}, got ${body.reason}`);
      });
    }
  });

  // ── P. Trip completion v2 slugs return definition_not_found gracefully ────────
  // first_trip_completed / solo_traveler / group_tripper / weekend_wanderer are the
  // renamed slugs used by awardTripCompletionStamps(). Until the DB definitions are
  // inserted they must degrade gracefully — never 500, never throw.

  describe("P. Trip completion v2 slugs return definition_not_found gracefully", () => {
    const completionSlugs = [
      "first_trip_completed",
      "solo_traveler",
      "group_tripper",
      "weekend_wanderer",
      "long_haul",
      "international_voyager",
      "road_warrior",
      "frequent_flyer",
    ];

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [],  // empty — definitions not yet seeded in DB
        userStamps: [],
        stampAwardEvents: [],
      }), true);
    });

    for (const slug of completionSlugs) {
      it(`returns awarded:false with definition_not_found for ${slug}`, async () => {
        const res = await fetch(`${base()}/admin/stamps/award`, {
          method: "POST",
          headers: authHeaders(ADMIN_ID),
          body: JSON.stringify({
            userId: ALICE_ID,
            definitionSlug: slug,
            sourceType: "trips",
            reason: "completion test",
          }),
        });
        assert.equal(res.status, 200, `Expected 200 for unknown slug ${slug}, got ${res.status}`);
        const body = await res.json();
        assert.equal(body.awarded, false, `Expected awarded:false for ${slug}`);
        assert.equal(body.reason, "definition_not_found", `Expected definition_not_found for ${slug}, got ${body.reason}`);
      });
    }
  });

  // ── Q. Backfill idempotency — second award for same source returns already_awarded
  // Validates the (userId:definitionId:sourceType:sourceId) idempotency key that the
  // backfill script relies on to skip already-processed candidates.

  describe("Q. Backfill idempotency: second award for same source returns already_awarded", () => {
    const TRIP_ID_Q = "eeeeeeee-0000-4000-8000-0000000000ee";

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ADMIN_ID,
        profiles: [{ id: ALICE_ID, role: "user" }, { id: ADMIN_ID, role: "admin" }],
        stampDefinitions: [{ id: DEF_ID, slug: DEF_SLUG, is_active: true, requires_approval: false, criteria_type: "automatic", visibility_default: "public" }],
        userStamps: [],
        stampAwardEvents: [],
      }), true);
    });

    it("first call awards the stamp", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          // rent_buddy sourceType skips validateSource() table lookup
          sourceType: "rent_buddy",
          sourceId: TRIP_ID_Q,
          reason: "backfill run 1",
        }),
      });
      assert.equal(res.status, 201);
      const body = await res.json();
      assert.equal(body.awarded, true, "First call must award the stamp");
    });

    it("second call (same source) returns already_awarded with awarded:false", async () => {
      const res = await fetch(`${base()}/admin/stamps/award`, {
        method: "POST",
        headers: authHeaders(ADMIN_ID),
        body: JSON.stringify({
          userId: ALICE_ID,
          definitionSlug: DEF_SLUG,
          sourceType: "rent_buddy",
          sourceId: TRIP_ID_Q,
          reason: "backfill run 2 (duplicate)",
        }),
      });
      assert.equal(res.status, 200, "Duplicate must be HTTP 200 (not 201 or 4xx)");
      const body = await res.json();
      assert.equal(body.awarded, false, "Duplicate must return awarded:false");
      assert.equal(body.reason, "already_awarded", `Expected already_awarded, got ${body.reason}`);
    });
  });

  // ── L. recalculate/me skips events whose definitions are missing/inactive ─────

  describe("L. recalculate/me skips events with no matching definition", () => {
    const MISSING_DEF_ID = "99999999-0000-4000-8000-000000000099";

    before(() => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        profiles:         [{ id: ALICE_ID, role: "user" }],
        stampDefinitions: [],   // intentionally empty — definition does not exist
        userStamps:       [],
        stampAwardEvents: [
          {
            id:                  "evtaaa01-0000-4000-8000-000000000001",
            user_id:             ALICE_ID,
            stamp_definition_id: MISSING_DEF_ID,
            source_type:         "trips",
            source_id:           null,
            award_reason:        "test",
            idempotency_key:     `${ALICE_ID}:${MISSING_DEF_ID}:trips:none`,
            admin_id:            null,
            status:              "awarded",
          },
        ],
      }), true);
    });

    it("returns awarded:0, skipped:1 when the referenced definition does not exist", async () => {
      const res = await fetch(`${base()}/stamps/recalculate/me`, {
        method: "POST",
        headers: authHeaders(),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.checked, 1,  `Expected checked=1, got ${body.checked}`);
      assert.equal(body.awarded, 0,  `Expected awarded=0, got ${body.awarded}`);
      assert.equal(body.skipped, 1,  `Expected skipped=1, got ${body.skipped}`);
    });
  });

  // ── M. GET /stamps/me pagination contract ─────────────────────────────────────
  // total is the infinite-scroll stop sentinel: it must never be smaller than
  // the rows served, even when the count query itself fails.

  describe("M. GET /stamps/me pagination total sentinel", () => {
    const ownStamp = {
      id: STAMP_ID, user_id: ALICE_ID, stamp_definition_id: DEF_ID,
      is_revoked: false, visibility: "public", earned_at: "2026-07-01T00:00:00Z",
    };

    after(() => {
      _setTestClient(makeClient({ currentUserId: ALICE_ID }), true);
    });

    it("returns total >= stamps.length when the count query fails but data succeeds", async () => {
      const inner = makeClient({
        currentUserId: ALICE_ID,
        stampDefinitions: [baseDef],
        userStamps: [ownStamp],
      });
      // Wrap: head-count selects on user_stamps fail; page selects pass through.
      const client = {
        ...inner,
        from(table: string) {
          const chain = inner.from(table);
          if (table === "user_stamps") {
            const origSelect = chain.select;
            chain.select = (cols?: string, opts?: any) => {
              if (opts?.count === "exact" && opts?.head) {
                const failing: any = {
                  eq: () => failing,
                  then: (resolve: any) =>
                    Promise.resolve().then(() =>
                      resolve({ data: null, error: { message: "simulated count failure" }, count: null })),
                };
                return failing;
              }
              return origSelect(cols, opts);
            };
          }
          return chain;
        },
      };
      _setTestClient(client, true);

      const res = await fetch(`${base()}/stamps/me`, { headers: authHeaders(ALICE_ID) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.stamps.length, 1);
      assert.ok(
        typeof body.total === "number" && body.total >= body.stamps.length,
        `total (${body.total}) must be >= stamps.length (${body.stamps.length})`,
      );
    });

    it("returns the exact total when the count query works", async () => {
      _setTestClient(makeClient({
        currentUserId: ALICE_ID,
        stampDefinitions: [baseDef],
        userStamps: [ownStamp],
      }), true);

      const res = await fetch(`${base()}/stamps/me`, { headers: authHeaders(ALICE_ID) });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.stamps.length, 1);
      assert.equal(body.total, 1);
    });
  });
});

// ── Feed read-path privacy (audit six-system STAMP·H1/H2) ────────────────────
// The recent/city/country feeds were unauthenticated and served the public
// stamps of users whose PASSPORT is private (per-stamp visibility defaults to
// 'public'), leaking user_id + city + earned_at; and /stamps/user/:userId did
// not honor passport_visibility. These pin the fix.
describe("Stamp feed read-path privacy", () => {
  let server: ReturnType<typeof createServer>;
  let port: number;

  const stamp = (uid: string, id: string) => ({
    id, user_id: uid, stamp_definition_id: DEF_ID, source_type: "manual",
    earned_at: "2026-07-01T00:00:00Z", city: "Da Nang", country: "Vietnam",
    title_override: null, visibility: "public", display_on_passport: true,
    is_revoked: false, created_at: "2026-07-01T00:00:00Z", catalog_id: null,
  });
  const state: FakeState = {
    currentUserId: ALICE_ID,
    profiles: [
      { id: ALICE_ID, passport_visibility: "public" },
      { id: BOB_ID,   passport_visibility: "private" },  // private → must not surface
      { id: CAROL_ID, passport_visibility: "public" },   // public  → surfaces
      { id: DAVE_ID,  passport_visibility: null },        // public-by-default, but blocked
    ],
    userStamps: [
      stamp(ALICE_ID, "s-alice"),
      stamp(BOB_ID,   "s-bob"),
      stamp(CAROL_ID, "s-carol"),
      stamp(DAVE_ID,  "s-dave"),
    ],
    blocks: [{ id: "blk-1", blocker_id: ALICE_ID, blocked_id: DAVE_ID }],
  };

  before(async () => {
    _setTestClient(makeClient(state), true);
    const app = await makeApp();
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as any).port;
  });
  after(() => { server.close(); });

  const get = (path: string, auth = true) =>
    fetch(`http://127.0.0.1:${port}/api${path}`,
      auth ? { headers: { Authorization: `Bearer token-${ALICE_ID}` } } : {});

  const ownerIds = (body: any) => new Set((body.stamps ?? []).map((s: any) => s.userId ?? s.user_id));

  it("/stamps/recent requires authentication", async () => {
    const res = await get("/stamps/recent", false);
    assert.equal(res.status, 401);
  });

  for (const path of ["/stamps/recent", "/stamps/city/Da%20Nang", "/stamps/country/Vietnam"]) {
    it(`${path} hides private-passport owners and blocked users, keeps public + self`, async () => {
      const res = await get(path);
      assert.equal(res.status, 200, `${path} status`);
      const ids = ownerIds(await res.json());
      assert.ok(ids.has(CAROL_ID), `${path}: public-passport owner must appear (positive control)`);
      assert.ok(ids.has(ALICE_ID), `${path}: caller's own stamp must appear`);
      assert.ok(!ids.has(BOB_ID),  `${path}: private-passport owner must be hidden`);
      assert.ok(!ids.has(DAVE_ID), `${path}: blocked user must be hidden`);
    });
  }

  it("/stamps/user/:userId returns empty for a private-passport target", async () => {
    const res = await get(`/stamps/user/${BOB_ID}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.stamps, [], "private passport must not be readable via the userId route");
  });

  it("/stamps/user/:userId still serves a public-passport target (positive control)", async () => {
    const res = await get(`/stamps/user/${CAROL_ID}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal((body.stamps ?? []).length, 1, "public passport still served");
  });
});
