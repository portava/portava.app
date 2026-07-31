/**
 * contentStampEarnedCount.test.ts
 *
 * Confirms that stamping a post increments the author's "Stamps Earned" count
 * end-to-end through both the service helper and the two HTTP endpoints that
 * surface the stat.
 *
 * Scenarios:
 *
 * A. countStampsReceived (direct service call)
 *   A1. author has one post with stamps → returns the correct count
 *   A2. author has no posts             → returns 0 (not NaN / not error)
 *
 * B. countContentStampsReceived (direct service call — paged-fallback path)
 *   B1. RPC unavailable (PGRST202) → falls back and counts via paged traversal
 *   B2. zero-posts user             → returns 0 via the fallback path
 *
 * C. GET /users/:username/passport — stampsEarned in the response
 *   C1. author B has one post stamped by user A → stampsEarned >= 1
 *   C2. author B has no posts                   → stampsEarned = 0
 *
 * D. GET /me/passport/stats — stampsEarned in the response
 *   D1. authenticated as user B, has a post stamped by user A → stampsEarned >= 1
 *   D2. authenticated as user B, no posts                     → stampsEarned = 0
 *
 * Pattern: node:test + tsx/esm, fake Supabase client, no vitest / no supertest.
 * Run: node --import tsx/esm --test src/test/contentStampEarnedCount.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import {
  countStampsReceived,
  countContentStampsReceived,
} from "../services/stamps/ContentStampService.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────────

const AUTHOR_ID  = "aa000000-0000-4000-8000-000000000001"; // user B (post author)
const STAMPER_ID = "bb000000-0000-4000-8000-000000000002"; // user A (stamps the post)
const POST_ID    = "cc000000-0000-4000-8000-000000000003"; // post owned by AUTHOR_ID

const AUTHOR_HANDLE = "testauthor";

// ── Fake Supabase client ───────────────────────────────────────────────────────

interface FakeDB {
  profiles:                any[];
  posts:                   any[];
  content_stamps:          any[];
  blocks:                  any[];
  user_stamps:             any[];
  feature_flags:           any[];
  user_follows:            any[];
  stamp_milestones:        any[];
  passport_stamps:         any[];
  profile_privacy_settings: any[];
  user_account_states:     any[];
  user_friendships:        any[];
  [key: string]:           any[];
}

/**
 * Build a fake DB pre-seeded with:
 *  - AUTHOR_ID's profile (public, active)
 *  - one post owned by AUTHOR_ID
 *  - one content_stamp by STAMPER_ID on that post
 *  - passport_stamps_enabled feature flag
 */
function makeDB(overrides: Partial<FakeDB> = {}): FakeDB {
  return {
    profiles: [
      {
        id:             AUTHOR_ID,
        handle:         AUTHOR_HANDLE,
        username:       AUTHOR_HANDLE,
        display_name:   "Test Author",
        name:           "Test Author",
        bio:            null,
        avatar_url:     null,
        cover_photo_url: null,
        home_city:      null,
        home_country:   null,
        travel_style:   null,
        interests:      [],
        verified:       false,
        verification_status: null,
        verified_at:    null,
        passport_visibility: "public",
        created_at:     "2024-01-01T00:00:00Z",
        is_private:     false,
        spoken_languages: [],
        travel_styles:  [],
        travel_pace:    null,
        looking_for:    [],
        account_status: "active",
        passport_tab_order: null,
        is_official:    false,
        featured_count: 0,
      },
    ],
    posts: [
      { id: POST_ID, author_id: AUTHOR_ID, visibility: "public", status: "active" },
    ],
    content_stamps: [
      { id: "st000000-0000-0000-0000-000000000001", user_id: STAMPER_ID, entity_type: "post", entity_id: POST_ID },
    ],
    blocks:                  [],
    user_stamps:             [],
    feature_flags:           [{ flag: "passport_stamps_enabled", enabled: true }],
    user_follows:            [],
    stamp_milestones:        [],
    passport_stamps:         [],
    profile_privacy_settings: [],
    user_account_states:     [],
    user_friendships:        [],
    ...overrides,
  };
}

/**
 * Minimal fake Supabase client that drives an in-memory FakeDB.
 *
 * `rpc` always returns PGRST202 ("function not found") so every test exercises
 * the paged-fallback path in countContentStampsReceived — the path that runs in
 * prod before the count_content_stamps_received migration is applied.
 */
function makeFakeClient(db: FakeDB, userId: string = AUTHOR_ID) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    let _count       = false;
    let _head        = false;
    let _single      = false;
    let _maybeSingle = false;
    let _insert: any = null;
    let _isDelete    = false;

    function tableArr(): any[] {
      if (!db[table]) db[table] = [];
      return db[table];
    }

    function applyFilters(arr: any[]) {
      return arr.filter((r) => _filters.every((f) => f(r)));
    }

    const chain: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === "exact") _count = true;
        if (opts?.head)              _head  = true;
        return chain;
      },
      insert(data: any) { _insert = Array.isArray(data) ? data : [data]; return chain; },
      update()          { return chain; },
      upsert(data: any) {
        // Treat upsert like insert for fake purposes
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) {
          const arr = tableArr();
          arr.push({ id: `gen-${Date.now()}-${Math.random()}`, ...row });
        }
        return chain;
      },
      delete()           { _isDelete = true; return chain; },
      eq(col: string, val: any) { _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { _filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]) {
        _filters.push((r) => vals.includes(r[col]));
        return chain;
      },
      is(col: string, val: any) {
        _filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return chain;
      },
      or()     { return chain; },
      gte()    { return chain; },
      lte()    { return chain; },
      gt()     { return chain; },
      ilike()  { return chain; },
      order()  { return chain; },
      range()  { return chain; },
      limit()  { return chain; },
      single()      { _single      = true; return chain; },
      maybeSingle() { _maybeSingle = true; return chain; },
      head()        { _head        = true; return chain; },

      then(resolve: any, reject: any) {
        return Promise.resolve().then(() => {
          try {
            const arr = tableArr();

            if (_isDelete) {
              db[table] = arr.filter((r) => !_filters.every((f) => f(r)));
              return resolve({ data: null, error: null });
            }

            if (_insert) {
              for (const row of _insert) {
                arr.push({ id: row.id ?? `gen-${Date.now()}-${Math.random()}`, ...row });
              }
              if (_single || _maybeSingle) return resolve({ data: _insert[0], error: null });
              return resolve({ data: _insert, error: null });
            }

            let results = applyFilters(arr).map((r) => ({ ...r }));
            const cnt   = results.length;

            if (_head)        return resolve({ data: null, error: null, count: cnt });
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
        data:  { user: { id: userId, email: `${userId}@test.example` } },
        error: null,
      }),
    },
    from: (table: string) => buildChain(table),
    // Always report PGRST202 so countContentStampsReceived always uses the
    // paged-fallback path rather than the RPC shortcut.
    rpc: async (_name: string) => ({
      data:  null,
      error: { code: "PGRST202", message: "function not found" },
    }),
  };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function startServer(
  app: Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as any).port as number;
      resolve({
        url:   `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function makeApp(router: any): Express {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", router);
  return app;
}

// ── A. countStampsReceived — direct service call ───────────────────────────────

describe("A. countStampsReceived — direct service call", () => {
  // A1. Author has a post with stamps → correct count returned

  describe("A1. author's post has stamps — returns the stamp count", () => {
    let result: number;

    before(async () => {
      const db = makeDB();
      const sc = makeFakeClient(db) as any;
      result = await countStampsReceived(sc, AUTHOR_ID);
    });

    it("returns 1 (matching the single content_stamp row)", () => {
      assert.equal(result, 1);
    });
  });

  // A2. Author has no posts → returns 0, not NaN or an error

  describe("A2. author has no posts — returns 0, not NaN or an error", () => {
    let result: number;

    before(async () => {
      const db = makeDB({ posts: [], content_stamps: [] });
      const sc = makeFakeClient(db) as any;
      result = await countStampsReceived(sc, AUTHOR_ID);
    });

    it("returns exactly 0", () => {
      assert.equal(result, 0);
    });

    it("is a finite number (not NaN)", () => {
      assert.ok(Number.isFinite(result), `Expected finite number, got ${result}`);
    });
  });
});

// ── B. countContentStampsReceived — paged-fallback path ───────────────────────

describe("B. countContentStampsReceived — paged-fallback path (RPC returns PGRST202)", () => {
  // B1. Author has a post with stamps → fallback counts it correctly

  describe("B1. author's post has stamps — fallback path returns the count", () => {
    let result: number;

    before(async () => {
      const db = makeDB();
      const sc = makeFakeClient(db) as any;
      result = await countContentStampsReceived(sc, AUTHOR_ID);
    });

    it("returns 1 via the paged fallback (same as the RPC would)", () => {
      assert.equal(result, 1);
    });
  });

  // B2. Author has no posts → fallback returns 0, not NaN

  describe("B2. zero-posts user — fallback returns 0, not NaN", () => {
    let result: number;

    before(async () => {
      const db = makeDB({ posts: [], content_stamps: [] });
      const sc = makeFakeClient(db) as any;
      result = await countContentStampsReceived(sc, AUTHOR_ID);
    });

    it("returns exactly 0", () => {
      assert.equal(result, 0);
    });

    it("is a finite number (not NaN)", () => {
      assert.ok(Number.isFinite(result), `Expected finite number, got ${result}`);
    });
  });
});

// ── C. GET /users/:username/passport — stampsEarned ───────────────────────────

describe("C. GET /users/:username/passport — stampsEarned includes content stamps", async () => {
  let srv: { url: string; close: () => Promise<void> };

  before(async () => {
    const { default: passportRouter } = await import("../routes/passport.js");
    const app = makeApp(passportRouter);
    srv = await startServer(app);
  });

  after(() => srv.close());

  // C1. Author has a post stamped by another user → stampsEarned >= 1

  describe("C1. author's post has one content stamp — stampsEarned >= 1", () => {
    let body: any;
    let status: number;

    before(async () => {
      const db = makeDB();
      // Unauthenticated viewer — auth.getUser is called but no Bearer header is
      // sent, so getOptionalViewerId returns null and viewerId = null.
      _setTestClient(makeFakeClient(db) as any, true);
      const res = await fetch(`${srv.url}/api/users/${AUTHOR_HANDLE}/passport`);
      status = res.status;
      body   = await res.json();
    });

    it("responds with 200 OK", () => {
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    it("stampsEarned is at least 1 (content stamp counted)", () => {
      assert.ok(
        typeof body.stampsEarned === "number" && body.stampsEarned >= 1,
        `Expected stampsEarned >= 1, got ${body.stampsEarned}`,
      );
    });
  });

  // C2. Author has no posts → stampsEarned = 0, not NaN or an error

  describe("C2. author has no posts — stampsEarned = 0, not NaN or error", () => {
    let body: any;
    let status: number;

    before(async () => {
      const db = makeDB({ posts: [], content_stamps: [] });
      _setTestClient(makeFakeClient(db) as any, true);
      const res = await fetch(`${srv.url}/api/users/${AUTHOR_HANDLE}/passport`);
      status = res.status;
      body   = await res.json();
    });

    it("responds with 200 OK", () => {
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    it("stampsEarned is exactly 0", () => {
      assert.equal(body.stampsEarned, 0, `Expected 0, got ${body.stampsEarned}`);
    });

    it("stampsEarned is a finite number (not NaN)", () => {
      assert.ok(
        Number.isFinite(body.stampsEarned),
        `Expected finite number, got ${body.stampsEarned}`,
      );
    });
  });
});

// ── D. GET /me/passport/stats — stampsEarned ──────────────────────────────────

describe("D. GET /me/passport/stats — stampsEarned includes content stamps", async () => {
  let srv: { url: string; close: () => Promise<void> };

  before(async () => {
    const { default: passportStampsRouter } = await import("../routes/passportStamps.js");
    const app = makeApp(passportStampsRouter);
    srv = await startServer(app);
  });

  after(() => srv.close());

  function authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization:  `Bearer token-${AUTHOR_ID}`,
    };
  }

  // D1. Authenticated as user B with one post stamped by user A → stampsEarned >= 1

  describe("D1. author has a post with one content stamp — stampsEarned >= 1", () => {
    let body: any;
    let status: number;

    before(async () => {
      const db = makeDB();
      _setTestClient(makeFakeClient(db, AUTHOR_ID) as any, true);
      const res = await fetch(`${srv.url}/api/me/passport/stats`, {
        headers: authHeaders(),
      });
      status = res.status;
      body   = await res.json();
    });

    it("responds with 200 OK", () => {
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    it("stampsEarned is at least 1 (content stamp counted)", () => {
      assert.ok(
        typeof body.stampsEarned === "number" && body.stampsEarned >= 1,
        `Expected stampsEarned >= 1, got ${body.stampsEarned}`,
      );
    });
  });

  // D2. Authenticated as user B with no posts → stampsEarned = 0, not NaN

  describe("D2. author has no posts — stampsEarned = 0, not NaN", () => {
    let body: any;
    let status: number;

    before(async () => {
      const db = makeDB({ posts: [], content_stamps: [] });
      _setTestClient(makeFakeClient(db, AUTHOR_ID) as any, true);
      const res = await fetch(`${srv.url}/api/me/passport/stats`, {
        headers: authHeaders(),
      });
      status = res.status;
      body   = await res.json();
    });

    it("responds with 200 OK", () => {
      assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    });

    it("stampsEarned is exactly 0", () => {
      assert.equal(body.stampsEarned, 0, `Expected 0, got ${body.stampsEarned}`);
    });

    it("stampsEarned is a finite number (not NaN)", () => {
      assert.ok(
        Number.isFinite(body.stampsEarned),
        `Expected finite number, got ${body.stampsEarned}`,
      );
    });
  });
});
