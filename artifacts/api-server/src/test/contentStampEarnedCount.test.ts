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
import { measureContentStampsReceived } from "../services/stamps/ContentStampService.js";

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
interface FakeOpts {
  /**
   * PostgREST's `max-rows`: a non-head read returns at most this many rows and
   * says nothing about the rest. Undefined = uncapped.
   */
  maxRows?: number;
  /** Make one read RESOLVE an error, the way supabase-js does (never a throw). */
  failOn?: (table: string, desc: string[]) => { message: string; code?: string } | null;
  /** Treat `.gt()` as a no-op — a server/proxy that drops the keyset filter. */
  ignoreGt?: boolean;
  /** RPC answer; default is PGRST202 (function not in the schema cache). */
  rpc?: (name: string, args: any) => { data: any; error: any };
}

function makeFakeClient(db: FakeDB, userId: string = AUTHOR_ID, opts: FakeOpts = {}) {
  function buildChain(table: string) {
    const _filters: Array<(r: any) => boolean> = [];
    const _desc: string[] = [];
    let _order: string | null = null;
    let _limit: number | null = null;
    let _range: [number, number] | null = null;
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
      eq(col: string, val: any) { _desc.push(`eq:${col}`); _filters.push((r) => r[col] === val); return chain; },
      neq(col: string, val: any) { _filters.push((r) => r[col] !== val); return chain; },
      in(col: string, vals: any[]) {
        _desc.push(`in:${col}`);
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
      gt(col: string, val: any) {
        _desc.push(`gt:${col}`);
        if (!opts.ignoreGt) _filters.push((r) => String(r[col]) > String(val));
        return chain;
      },
      ilike()  { return chain; },
      order(col: string) { _desc.push("order"); _order = col; return chain; },
      range(a: number, b: number) { _desc.push("range"); _range = [a, b]; return chain; },
      limit(n: number) { _limit = n; return chain; },
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

            const injected = opts.failOn?.(table, _desc) ?? null;
            if (injected) return resolve({ data: null, error: injected, count: null });

            let results = applyFilters(arr).map((r) => ({ ...r }));
            const cnt   = results.length;
            // Row order is insertion order unless asked; PostgREST promises
            // none, which is exactly why an unordered offset walk is unsafe.
            if (_order) {
              const k = _order;
              results.sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : String(a[k]) > String(b[k]) ? 1 : 0));
            }
            if (_range) results = results.slice(_range[0], _range[1] + 1);
            if (_limit != null) results = results.slice(0, _limit);
            if (opts.maxRows != null && !_head) results = results.slice(0, opts.maxRows);

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
    rpc: async (name: string, args: any) =>
      opts.rpc
        ? opts.rpc(name, args)
        : { data: null, error: { code: "PGRST202", message: "function not found" } },
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

// ── A. measureContentStampsReceived — RPC path ─────────────────────────────────

describe("A. measureContentStampsReceived — the RPC answers", () => {
  it("A1. returns the RPC's number as a measurement", async () => {
    const sc = makeFakeClient(makeDB(), AUTHOR_ID, {
      rpc: (name, args) => {
        assert.equal(name, "count_content_stamps_received");
        assert.equal(args.p_user_id, AUTHOR_ID);
        return { data: 7, error: null };
      },
    }) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 7, unavailable: false });
  });

  it("A2. a bigint arriving as a string is still a number", async () => {
    const sc = makeFakeClient(makeDB(), AUTHOR_ID, { rpc: () => ({ data: "12", error: null }) }) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 12, unavailable: false });
  });
});

// ── B. measureContentStampsReceived — paged-fallback path ─────────────────────

describe("B. measureContentStampsReceived — paged-fallback path (RPC returns PGRST202)", () => {
  it("B1. author's post has stamps — fallback path returns the count", async () => {
    const sc = makeFakeClient(makeDB()) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 1, unavailable: false });
  });

  it("B2. zero-posts user — fallback returns a MEASURED 0, not NaN", async () => {
    const sc = makeFakeClient(makeDB({ posts: [], content_stamps: [] })) as any;
    const r = await measureContentStampsReceived(sc, AUTHOR_ID);
    assert.deepEqual(r, { count: 0, unavailable: false });
    assert.ok(Number.isFinite(r.count));
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

// ── E. A failed or cut read is never a measured count (passport lane, 2026-10-03) ──
//
// `count_content_stamps_received` is NOT in the canonical chain and NOT on the
// hosted testing database (read-only pg_proc SELECT, 2026-10-03), so the
// fallback below is the path every "Stamps Earned" number takes there. It used
// to walk `posts` by unordered OFFSET, treat a failed page as the end of the
// data, skip a failed chunk count, stop at the first page shorter than ITS OWN
// page size (a lower server max-rows cut it at page one), and answer 0 for any
// throw. Each of those put a partial or zero count on the wire as a measurement.

/** `n` posts by AUTHOR_ID, each stamped once by STAMPER_ID. */
function manyPosts(n: number): Partial<FakeDB> {
  const posts: any[] = [];
  const content_stamps: any[] = [];
  for (let i = 0; i < n; i++) {
    const id = `cc000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    posts.push({ id, author_id: AUTHOR_ID, visibility: "public", status: "active" });
    content_stamps.push({ id: `st-${i}`, user_id: STAMPER_ID, entity_type: "post", entity_id: id });
  }
  return { posts, content_stamps };
}

describe("E. measureContentStampsReceived — failures and cuts are not counts", () => {
  it("E1. 2,500 posts under a 1,000-row server cap are counted exactly", async () => {
    const sc = makeFakeClient(makeDB(manyPosts(2500)), AUTHOR_ID, { maxRows: 1000 }) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 2500, unavailable: false });
  });

  it("E2. a server cap BELOW the walk's page size does not end the walk at page one", async () => {
    const sc = makeFakeClient(makeDB(manyPosts(2500)), AUTHOR_ID, { maxRows: 300 }) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 2500, unavailable: false });
  });

  it("E3. a posts page failing mid-walk is unavailable, not the pages read so far", async () => {
    let postsReads = 0;
    const sc = makeFakeClient(makeDB(manyPosts(2500)), AUTHOR_ID, {
      maxRows: 1000,
      failOn: (t) => (t === "posts" && ++postsReads === 2 ? { message: "statement timeout", code: "57014" } : null),
    }) as any;
    const r = await measureContentStampsReceived(sc, AUTHOR_ID);
    assert.equal(r.unavailable, true);
    assert.equal(r.count, null);
  });

  it("E4. the first posts read failing is unavailable, not 0", async () => {
    const sc = makeFakeClient(makeDB(), AUTHOR_ID, {
      failOn: (t) => (t === "posts" ? { message: "connection reset" } : null),
    }) as any;
    const r = await measureContentStampsReceived(sc, AUTHOR_ID);
    assert.equal(r.unavailable, true);
    assert.equal(r.count, null);
  });

  it("E5. a content_stamps count failing is unavailable, not skipped", async () => {
    const sc = makeFakeClient(makeDB(), AUTHOR_ID, {
      failOn: (t) => (t === "content_stamps" ? { message: "connection reset" } : null),
    }) as any;
    const r = await measureContentStampsReceived(sc, AUTHOR_ID);
    assert.equal(r.unavailable, true);
    assert.equal(r.count, null);
  });

  it("E6. an RPC outage that the exact fallback survives is still a measurement", async () => {
    const sc = makeFakeClient(makeDB(manyPosts(40)), AUTHOR_ID, {
      rpc: () => ({ data: null, error: { code: "57014", message: "statement timeout" } }),
    }) as any;
    assert.deepEqual(await measureContentStampsReceived(sc, AUTHOR_ID), { count: 40, unavailable: false });
  });

  it("E8. a keyset filter that is not honoured is unavailable — never a loop or a double count", async () => {
    const sc = makeFakeClient(makeDB(manyPosts(40)), AUTHOR_ID, { ignoreGt: true }) as any;
    const r = await measureContentStampsReceived(sc, AUTHOR_ID);
    assert.equal(r.unavailable, true);
    assert.equal(r.count, null);
  });

  it("E7. an RPC outage AND a fallback outage is unavailable", async () => {
    const sc = makeFakeClient(makeDB(), AUTHOR_ID, {
      rpc: () => ({ data: null, error: { code: "57014", message: "statement timeout" } }),
      failOn: (t) => (t === "posts" ? { message: "connection reset" } : null),
    }) as any;
    assert.equal((await measureContentStampsReceived(sc, AUTHOR_ID)).unavailable, true);
  });
});

// ── F. The three routes that show "Stamps Earned" say when they could not count ──

describe("F. stampsEarned on the wire — null plus stampsEarnedUnavailable, never a guessed number", async () => {
  let passportSrv: { url: string; close: () => Promise<void> };
  let statsSrv: { url: string; close: () => Promise<void> };

  before(async () => {
    const { default: passportRouter } = await import("../routes/passport.js");
    const { default: passportStampsRouter } = await import("../routes/passportStamps.js");
    passportSrv = await startServer(makeApp(passportRouter));
    statsSrv = await startServer(makeApp(passportStampsRouter));
  });
  after(async () => { await passportSrv.close(); await statsSrv.close(); });

  const contentDown = (t: string) => (t === "content_stamps" ? { message: "connection reset" } : null);
  const milestonesDown = (t: string, d: string[]) =>
    t === "user_stamps" && d.includes("eq:is_revoked") ? { message: "connection reset" } : null;

  async function publicPassport(db: FakeDB, opts: FakeOpts) {
    _setTestClient(makeFakeClient(db, AUTHOR_ID, opts) as any, true);
    const res = await fetch(`${passportSrv.url}/api/users/${AUTHOR_HANDLE}/passport`);
    return { status: res.status, body: await res.json() as any };
  }
  async function myStats(db: FakeDB, opts: FakeOpts) {
    _setTestClient(makeFakeClient(db, AUTHOR_ID, opts) as any, true);
    const res = await fetch(`${statsSrv.url}/api/me/passport/stats`, {
      headers: { Authorization: `Bearer token-${AUTHOR_ID}` },
    });
    return { status: res.status, body: await res.json() as any };
  }

  for (const [name, failOn] of [["content stamps", contentDown], ["milestone stamps", milestonesDown]] as const) {
    it(`F1. public passport: ${name} unreadable → 200, stampsEarned null, flagged`, async () => {
      const { status, body } = await publicPassport(makeDB(), { failOn });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.stampsEarned, null);
      assert.equal(body.stampsEarnedUnavailable, true);
    });

    it(`F2. /me/passport/stats: ${name} unreadable → 200, stampsEarned null, flagged`, async () => {
      const { status, body } = await myStats(makeDB(), { failOn });
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.stampsEarned, null);
      assert.equal(body.stampsEarnedUnavailable, true);
    });
  }

  it("F3. public passport: 1,500 stamped posts under a 1,000-row cap count 1,500, not 1,000", async () => {
    const { status, body } = await publicPassport(makeDB(manyPosts(1500)), { maxRows: 1000 });
    assert.equal(status, 200);
    assert.equal(body.stampsEarned, 1500);
    assert.equal(body.stampsEarnedUnavailable, undefined);
  });

  it("F4. healthy reads carry no flag on either route", async () => {
    const a = await publicPassport(makeDB(), {});
    const b = await myStats(makeDB(), {});
    assert.equal(a.body.stampsEarned, 1);
    assert.equal(b.body.stampsEarned, 1);
    assert.equal(a.body.stampsEarnedUnavailable, undefined);
    assert.equal(b.body.stampsEarnedUnavailable, undefined);
  });
});

// ── G. GET /me/profile — the third surface that carries Stamps Earned ─────────

describe("G. GET /me/profile — stampsEarned is a measurement or null + flag", async () => {
  const { makeFailClosedClient } = await import("./helpers/failClosedSupabase.js");
  const { _setTestServiceClient } = await import("../lib/supabase.js");
  let srv: { url: string; close: () => Promise<void> };
  before(async () => {
    const { default: profileRouter } = await import("../routes/profile.js");
    srv = await startServer(makeApp(profileRouter));
  });
  after(async () => {
    await srv.close();
    _setTestServiceClient(null);
  });

  const TOKEN = "tok-stamps-earned";
  function install(failOn?: (table: string) => any) {
    const client = makeFailClosedClient({
      users: { [TOKEN]: AUTHOR_ID },
      rows: {
        profiles: [{ id: AUTHOR_ID, account_status: "active", username: "a", handle: "a", name: "A" }],
        posts: [{ id: POST_ID, author_id: AUTHOR_ID }],
        content_stamps: [{ id: "s1", user_id: STAMPER_ID, entity_type: "post", entity_id: POST_ID }],
        user_stamps: [
          { id: "u1", user_id: AUTHOR_ID, is_revoked: false },
          { id: "u2", user_id: AUTHOR_ID, is_revoked: true },
        ],
      },
      rpc: { count_content_stamps_received: () => ({ data: null, error: { code: "PGRST202", message: "not found" } }) },
      failOn: (ctx) => failOn?.(ctx.table) ?? null,
    });
    _setTestClient(client, true);
    _setTestServiceClient(client);
  }
  async function get() {
    const res = await fetch(`${srv.url}/api/me/profile`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, body: await res.json() as any };
  }

  it("G1. healthy: one owned (non-revoked) + one received = 2, no flag", async () => {
    install();
    const { status, body } = await get();
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.stampsEarned, 2);
    assert.equal(body.stampsEarnedUnavailable, undefined);
  });

  for (const table of ["content_stamps", "user_stamps", "posts"]) {
    it(`G2. ${table} unreadable: still 200, stampsEarned null + flag (not a partial sum)`, async () => {
      install((t) => (t === table ? { message: "connection reset", code: "08006" } : null));
      const { status, body } = await get();
      assert.equal(status, 200, "GET /me/profile is the app's primary read");
      assert.equal(body.stampsEarned, null);
      assert.equal(body.stampsEarnedUnavailable, true);
    });
  }
});

// ── H. Passport stats (Countries / Stamps on the passport home) are a WHOLE read ──
//
// buildStats read every non-revoked user_stamps row in ONE request. PostgREST
// answers at most max-rows (1,000) and says nothing about the rest, so a
// traveller past 1,000 stamps was shown "1,000 stamps" and the countries/cities
// of whichever 1,000 rows came back — a cut read served as a measurement.

function manyUserStamps(n: number): Partial<FakeDB> {
  const user_stamps: any[] = [];
  for (let i = 0; i < n; i++) {
    user_stamps.push({
      id: `us000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      user_id: AUTHOR_ID, is_revoked: false, visibility: "public",
      country: `Country ${i % 120}`, city: `City ${i}`,
      stamp_definitions: { category: "trip", slug: "city_visit", evidences_presence: true },
    });
  }
  return { user_stamps };
}

describe("H. GET /me/passport/stats — countries and stamps over a 1,000-row server cap", async () => {
  let srv: { url: string; close: () => Promise<void> };
  before(async () => {
    const { default: passportStampsRouter } = await import("../routes/passportStamps.js");
    srv = await startServer(makeApp(passportStampsRouter));
  });
  after(() => srv.close());

  async function stats(db: FakeDB, opts: FakeOpts) {
    _setTestClient(makeFakeClient(db, AUTHOR_ID, opts) as any, true);
    const res = await fetch(`${srv.url}/api/me/passport/stats`, {
      headers: { Authorization: `Bearer token-${AUTHOR_ID}` },
    });
    return { status: res.status, body: await res.json() as any };
  }

  it("H1. 1,500 stamps under a 1,000-row cap: totalStamps 1,500, all 120 countries, all 1,500 cities", async () => {
    const { status, body } = await stats(makeDB(manyUserStamps(1500)), { maxRows: 1000 });
    assert.equal(status, 200, JSON.stringify(body).slice(0, 300));
    assert.equal(body.totalStamps, 1500);
    assert.equal(body.countries, 120);
    assert.equal(body.cities, 1500);
    assert.equal(body.readFailed, false);
  });

  it("H2. a page failing after the first is readFailed, not the first page's numbers", async () => {
    let reads = 0;
    const { body } = await stats(makeDB(manyUserStamps(1500)), {
      maxRows: 1000,
      // Only the WHOLE-ROW walk (not the head count behind Stamps Earned).
      failOn: (t, d) => (t === "user_stamps" && d.includes("order") && ++reads === 2
        ? { message: "statement timeout", code: "57014" } : null),
    });
    assert.equal(body.readFailed, true);
    assert.equal(body.totalStamps, 0, "the placeholder is flagged, never a partial 1,000");
  });

  it("H3. a keyset filter that is not honoured ends the walk as readFailed — never a loop or a double count", async () => {
    const { status, body } = await stats(makeDB(manyUserStamps(1500)), { maxRows: 1000, ignoreGt: true });
    assert.equal(status, 200);
    assert.equal(body.readFailed, true);
    assert.equal(body.totalStamps, 0);
  });
});
