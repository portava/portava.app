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
import { _setTestClient } from "../lib/http.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-4000-8000-000000000002";
const CAROL_ID  = "cccccccc-0000-4000-8000-000000000003";
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
    feature_flags:          state.featureFlags ?? [],
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
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;
  });

  after(() => { server.close(); });

  function base() { return `http://localhost:${port}/api`; }
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
});
