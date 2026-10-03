/**
 * TWO BACKLOG ITEMS, ONE ROUTE FILE.
 *
 * #A6 — the proactive highlight feeds swallowed their SUPPLEMENTARY reads.
 * #A9 — KEEP_PRIVATE_FOREVER evicted only the setter's Compass cache.
 *
 * ── #A6, AND HOW IT DIFFERS FROM highlightsReadFailures.test.ts ─────────────
 * That file fixed five FAIL-CLOSED defects on this surface (the follow graph,
 * resolveViewAccess, the DELETE, the like/report writes, the reply thread) and
 * established the harness and the pairing rule reused here. It did not touch
 * the engagement-count and profile reads, and those must NOT become refusals:
 * §21's posture for them is degrade-rather-than-refuse. A view count that
 * cannot be read is not a permission answer and is no reason to take a feed
 * down.
 *
 * So the defect was never the degrade. It was that `(<read>.data ?? [])` made
 * the degrade INVISIBLE — supabase-js resolves on a database error, so `.data`
 * is null, `?? []` is a legitimate-looking zero, and a Highlight with 400 views
 * was served as "0 views" with nothing written anywhere. Every assertion below
 * therefore checks BOTH halves: the page still answers (it degraded) AND the
 * failure is on the record (it was not silent).
 *
 * PAIRING (the false-green rule). A Highlight with no views and a Highlight
 * whose `highlight_views` table is unreadable both render "0 views". Every
 * failure case is paired with the SAME fixture read successfully, so a test
 * that passed because the fixture was empty would fail its control.
 *
 * ── #A9 ─────────────────────────────────────────────────────────────────────
 * Asserted as STATE, per CONTRIBUTING.md: a second viewer's cache entry is
 * SEEDED, the control is set by its owner over HTTP, and the test then reads
 * the cache back — L1 through getCachedFeed(null, …) so only L1 can answer,
 * and the persisted rows straight out of the fake's `compass_feed_cache`. A
 * 200 from the route proves nothing about either.
 *
 * The other half of #A9 is that the report must not OVERCLAIM.
 * CompassCacheEngine.invalidate returns void and swallows the persisted delete,
 * so a complete purge is unobservable from the caller; the tests pin that the
 * strongest reported outcome is `l1_evicted_persisted_unverifiable`, that
 * `persistedPurgeVerified` is false, and that an audience the code could not
 * establish is reported as `audience_incomplete` rather than as a success.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightsDegradedReadsAndCacheFanout.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import { clearL1Cache, getCachedFeed, setCachedFeed } from "../compass/CompassCacheEngine.js";
import { resetHighlightSchemaMemo } from "../services/highlights/highlightSchemaAvailability.js";

const OWNER    = "20000000-0000-4000-8000-000000000001";
const VIEWER   = "20000000-0000-4000-8000-000000000002"; // follows OWNER, in OWNER's circle
const VIEWER2  = "20000000-0000-4000-8000-000000000003"; // in OWNER's circle, does NOT follow
const STRANGER = "20000000-0000-4000-8000-000000000004"; // no relationship at all
const H_PUB    = "40000000-0000-4000-8000-000000000001"; // OWNER's public highlight
const H_CIRCLE = "40000000-0000-4000-8000-000000000002"; // OWNER's circle_only highlight

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const CACHE_KEY = "feed:home:v1";

const highlight = (id: string, owner_id: string, visibility: string) => ({
  id, owner_id, visibility,
  media_url: "https://example.invalid/h.jpg", media_type: "image/jpeg",
  video_duration_seconds: null, caption: null,
  location_name: null, location_city: null, location_country: null,
  expires_at: FUTURE, created_at: "2026-01-01T00:00:00.000Z", deleted_at: null,
});

function fixtureTables(): Record<string, any[]> {
  return {
    profiles: [OWNER, VIEWER, VIEWER2, STRANGER].map((id) => ({
      id, handle: `h_${id.slice(-2)}`, name: "Real Name", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    // show_real_name is what makes the display-name degrade OBSERVABLE: without
    // an opt-in row, a failed read and a successful one both yield name: null.
    profile_privacy_settings: [{ user_id: OWNER, show_real_name: true }],
    highlights: [highlight(H_PUB, OWNER, "public"), highlight(H_CIRCLE, OWNER, "circle_only")],
    user_follows: [{ follower_id: VIEWER, following_id: OWNER }],
    circle_memberships: [
      { user_id: OWNER, other_id: VIEWER },
      { user_id: OWNER, other_id: VIEWER2 },
    ],
    blocks: [], trip_members: [], trips: [], feature_flags: [],
    // Seeded so "0 views / not liked" is a REAL degrade and not the fixture's
    // own emptiness. VIEWER has viewed and liked H_PUB.
    highlight_views: [{ highlight_id: H_PUB, viewer_id: VIEWER, viewed_at: "2026-02-01T00:00:00.000Z" }],
    highlight_likes: [{ highlight_id: H_PUB, user_id: VIEWER }],
    highlight_reports: [], highlight_replies: [],
    message_threads: [], message_thread_members: [], messages: [],
    highlight_resurfacing_preferences: [],
    highlight_projection_policies: [],
    compass_feed_cache: [], compass_cache_invalidations: [],
  };
}

/**
 * Filtering supabase-js stand-in. `failTables` makes reads of those tables
 * RESOLVE with an error, which is what supabase-js does; a fake that threw
 * would exercise a catch that does not exist in production. Lifted from
 * src/test/highlightsReadFailures.test.ts so the two files cannot disagree
 * about what a failed read looks like.
 */
function makeFakeClient(
  tables: Record<string, any[]>,
  opts: { failTables?: Set<string>; failProjections?: Set<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();
  // `profiles` is read several times on these routes and the reads UPSTREAM of
  // the author lookup fail closed (correctly — an unreadable `profiles` cannot
  // answer account_status). Failing the whole table therefore never reaches the
  // author read at all. A projection key — `table|selected columns` — fails
  // exactly the one read under test, which is the only way to observe the
  // author degrade on these handlers.
  const failProjections = opts.failProjections ?? new Set<string>();
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, isUpdate = false, selectedAfterWrite = false;
    let patch: any = null;
    let cols = "";
    const obj: any = {
      select(_c?: string, o?: any) {
        if (typeof _c === "string") cols = _c;
        if (o?.head) head = true;
        if (isWrite) selectedAfterWrite = true;
        return obj;
      },
      insert(d: any) { isWrite = true; obj.__insert = d; return obj; },
      update(d: any) { isWrite = true; isUpdate = true; patch = d; return obj; },
      upsert(d: any) { isWrite = true; obj.__upsert = d; return obj; },
      delete() { isWrite = true; obj.__delete = true; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      ilike() { return obj; }, or() { return obj; }, not() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<{ data: any; error: any; count: number | null }> {
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (failProjections.has(`${table}|${cols}`)) return { data: null, error: { message: `${table} read of (${cols}) unavailable` }, count: null };
      if (obj.__insert || obj.__upsert) {
        const raw = obj.__insert ?? obj.__upsert;
        const rows = (Array.isArray(raw) ? raw : [raw]).map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) (tables[table] ??= []).push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (obj.__delete) {
        const gone = new Set(rows);
        tables[table] = (tables[table] ?? []).filter((r) => !gone.has(r));
        return { data: rows, error: null, count: null };
      }
      if (isUpdate) {
        for (const r of rows) Object.assign(r, patch);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: rows, error: null, count: null };
      }
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: head ? rows.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

type App = {
  baseUrl: string;
  close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  tables: Record<string, any[]>;
  client: any;
};

const AUTHOR_PROJECTION = "profiles|id, handle, name, avatar_url";

async function startApp(opts: { failTables?: Set<string>; failProjections?: Set<string> } = {}): Promise<App> {
  const tables = fixtureTables();
  const client = makeFakeClient(tables, opts);
  _setTestClient(client as any, true);
  resetHighlightSchemaMemo();
  clearL1Cache();
  const errors: Array<{ obj: any; msg: string }> = [];
  const app = express();
  app.use(express.json());
  // Without this shim the routes CRASH on req.log and a 500-from-crash would
  // masquerade as a deliberate refusal.
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: any, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", highlightsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, errors, tables, client,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, viewer: string, body?: unknown) {
  const res = await fetch(app.baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${viewer}`, "Content-Type": "application/json", connection: "close" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  return { status: res.status, json, text };
}

/** Degrade log lines only — the surface already logs plenty of other things. */
function degradeLogs(app: App, read: string): Array<{ obj: any; msg: string }> {
  return app.errors.filter((e) => e.obj?.read === read);
}

/* ============================================================================
 * #A6
 * ==========================================================================*/

describe("#A6 GET /highlights/active — supplementary reads degrade, and SAY SO", () => {
  it("PAIRED CONTROL — every table readable: the counts are real and NOTHING is logged as degraded", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.ok(h, "the public highlight is on the feed");
      // The fixture really does hold one view and one like by VIEWER. If it did
      // not, "0 views" below would prove nothing.
      assert.equal(h.viewCount, 1);
      assert.equal(h.likeCount, 1);
      assert.equal(h.viewedByMe, true);
      assert.equal(h.likedByMe, true);
      assert.equal(h.author.name, "Real Name");
      assert.equal(app.errors.filter((e) => e.obj?.degradedTo).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable highlight_views still answers the feed, and logs both the count and the viewer's own read", async () => {
    const app = await startApp({ failTables: new Set(["highlight_views"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200, "DEGRADE, not refuse: a view count is not a permission answer");
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.ok(h);
      assert.equal(h.viewCount, 0);
      assert.equal(h.viewedByMe, false);
      // …and the zero is on the record, which is the whole defect.
      const counted = degradeLogs(app, "highlight_views count");
      assert.equal(counted.length, 1);
      assert.equal(counted[0]!.obj.where, "GET /highlights/active");
      assert.equal(counted[0]!.obj.degradedTo, "viewCount 0");
      assert.match(counted[0]!.msg, /degrading rather than refusing/);
      assert.ok(counted[0]!.obj.err, "the bound error is carried, not just the fact of one");
      assert.equal(degradeLogs(app, "viewer's own highlight_views").length, 1);
    } finally { await app.close(); }
  });

  it("an unreadable highlight_likes still answers the feed, and logs the count and the viewer's own likes", async () => {
    const app = await startApp({ failTables: new Set(["highlight_likes"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.equal(h.likeCount, 0);
      assert.equal(h.likedByMe, false);
      assert.equal(degradeLogs(app, "highlight_likes count").length, 1);
      assert.equal(degradeLogs(app, "viewer's own highlight_likes").length, 1);
    } finally { await app.close(); }
  });

  it("an unreadable author profiles read serves the feed authorless, and logs it", async () => {
    const app = await startApp({ failProjections: new Set([AUTHOR_PROJECTION]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.ok(h, "the Highlight survives an unreadable author");
      assert.equal(h.author, null);
      const logged = degradeLogs(app, "author profiles");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.where, "GET /highlights/active");
    } finally { await app.close(); }
  });

  it("an unreadable profile_privacy_settings withholds every real name — the private direction — and logs the reason", async () => {
    const app = await startApp({ failTables: new Set(["profile_privacy_settings"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/active", VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      // The control above proves this is "Real Name" when the read works, so
      // null here is the degrade and not the fixture.
      assert.equal(h.author.name, null);
      assert.equal(h.author.handle, `h_${OWNER.slice(-2)}`, "the handle still identifies the author");
      const logged = degradeLogs(app, "profile_privacy_settings");
      assert.equal(logged.length, 1);
      assert.match(logged[0]!.msg, /display-name visibility read failed/);
    } finally { await app.close(); }
  });
});

describe("#A6 GET /highlights/following-feed — an unreadable author profiles read EMPTIES the feed, so it must shout", () => {
  it("PAIRED CONTROL — readable: the followed owner and their Highlight are on the feed", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.equal((r.json.users as any[]).length, 1);
      assert.equal(r.json.users[0].userId, OWNER);
      assert.ok((r.json.users[0].highlights as any[]).some((h: any) => h.id === H_PUB));
      assert.equal(app.errors.filter((e) => e.obj?.degradedTo).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable author profiles read answers `{ users: [] }` — identical to 'nobody you follow posted' — and that is now LOGGED", async () => {
    const app = await startApp({ failProjections: new Set([AUTHOR_PROJECTION]) });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.deepEqual(r.json.users, [], "the grouping drops profile-less owners: the page really is empty");
      const logged = degradeLogs(app, "author profiles");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.where, "GET /highlights/following-feed");
      assert.equal(logged[0]!.obj.degradedTo, "every author dropped from the feed");
    } finally { await app.close(); }
  });

  it("an unreadable highlight_views still serves the followed Highlight, with the zero recorded", async () => {
    const app = await startApp({ failTables: new Set(["highlight_views"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.users[0].highlights as any[]).find((x: any) => x.id === H_PUB);
      assert.ok(h);
      assert.equal(h.viewCount, 0);
      const logged = degradeLogs(app, "highlight_views count");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.where, "GET /highlights/following-feed");
    } finally { await app.close(); }
  });
});

describe("#A6 GET /users/:userId/highlights — the profile page", () => {
  it("PAIRED CONTROL — readable: real counts and a named author", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.ok(h);
      assert.equal(h.viewCount, 1);
      assert.equal(h.author.name, "Real Name");
      assert.equal(app.errors.filter((e) => e.obj?.degradedTo).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable author profiles read serves the Highlights with author null, and logs it", async () => {
    const app = await startApp({ failProjections: new Set([AUTHOR_PROJECTION]) });
    try {
      const r = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.ok(h, "someone's Highlights are not withheld because their profile row would not load");
      assert.equal(h.author, null);
      const logged = degradeLogs(app, "author profiles");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.where, "GET /users/:userId/highlights");
    } finally { await app.close(); }
  });

  it("an unreadable highlight_likes serves the page with likeCount 0, and logs both like reads", async () => {
    const app = await startApp({ failTables: new Set(["highlight_likes"]) });
    try {
      const r = await call(app, "GET", `/api/users/${OWNER}/highlights`, VIEWER);
      assert.equal(r.status, 200);
      const h = (r.json.highlights as any[]).find((x) => x.id === H_PUB);
      assert.equal(h.likeCount, 0);
      assert.equal(h.likedByMe, false);
      assert.equal(degradeLogs(app, "highlight_likes count").length, 1);
      assert.equal(degradeLogs(app, "viewer's own highlight_likes").length, 1);
    } finally { await app.close(); }
  });
});

describe("#A6 GET /highlights/:id/viewers — the owner's viewer list", () => {
  it("PAIRED CONTROL — readable: the viewer is named and their like is shown", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/highlights/${H_PUB}/viewers`, OWNER);
      assert.equal(r.status, 200);
      assert.equal((r.json.viewers as any[]).length, 1);
      assert.equal(r.json.viewers[0].user_id, VIEWER);
      assert.equal(r.json.viewers[0].handle, `h_${VIEWER.slice(-2)}`);
      assert.equal(r.json.viewers[0].liked, true);
      assert.equal(app.errors.filter((e) => e.obj?.degradedTo).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable viewer profiles read still lists the viewer, as a bare id, and logs it", async () => {
    const app = await startApp({ failProjections: new Set([AUTHOR_PROJECTION]) });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_PUB}/viewers`, OWNER);
      assert.equal(r.status, 200);
      assert.equal((r.json.viewers as any[]).length, 1, "the viewer row itself came from a read that worked");
      assert.equal(r.json.viewers[0].handle, null);
      const logged = degradeLogs(app, "viewer profiles");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.where, "GET /highlights/:id/viewers");
    } finally { await app.close(); }
  });

  it("an unreadable highlight_likes shows `liked: false` for a viewer who DID like it, and logs the lie", async () => {
    const app = await startApp({ failTables: new Set(["highlight_likes"]) });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_PUB}/viewers`, OWNER);
      assert.equal(r.status, 200);
      assert.equal(r.json.viewers[0].liked, false);
      const logged = degradeLogs(app, "highlight_likes of the viewer set");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.obj.degradedTo, "liked false");
    } finally { await app.close(); }
  });
});

/* ============================================================================
 * #A9
 * ==========================================================================*/

/** Seed a cache entry for `userId` in BOTH tiers, the way a served feed does. */
async function seedCache(app: App, userId: string): Promise<void> {
  await setCachedFeed(app.client, userId, CACHE_KEY, "feed", { served: userId });
}

/** L1 ONLY — `db: null` means nothing else can answer. */
async function l1Of(userId: string): Promise<unknown> {
  return getCachedFeed(null, userId, CACHE_KEY, "feed");
}

function persistedRowsFor(app: App, userId: string): any[] {
  return (app.tables.compass_feed_cache ?? []).filter((r) => r.user_id === userId);
}

function invalidationsFor(app: App, userId: string): any[] {
  return (app.tables.compass_cache_invalidations ?? []).filter((r) => r.user_id === userId);
}

const setControl = (app: App, control: string, subjectId: string, actor = OWNER) =>
  call(app, "PUT", "/api/highlights/resurfacing-controls", actor, { control, subjectId });

describe("#A9 KEEP_PRIVATE_FOREVER fans the cache eviction out to the OTHER viewers", () => {
  it("PAIRED CONTROL — the seed really is there before the control is set", async () => {
    const app = await startApp();
    try {
      await seedCache(app, OWNER);
      await seedCache(app, VIEWER2);
      assert.deepEqual(await l1Of(VIEWER2), { served: VIEWER2 });
      assert.equal(persistedRowsFor(app, VIEWER2).length, 1);
    } finally { await app.close(); }
  });

  it("evicts a SECOND VIEWER's cache, not just the setter's — both tiers, asserted by reading them back", async () => {
    const app = await startApp();
    try {
      await seedCache(app, OWNER);
      await seedCache(app, VIEWER2);

      const r = await setControl(app, "KEEP_PRIVATE_FOREVER", H_CIRCLE);
      assert.equal(r.status, 200);

      // THE STATE, not the 200. VIEWER2 is in OWNER's circle and H_CIRCLE is
      // circle_only, so VIEWER2 is in the audience by the same rule
      // canViewHighlight used to serve it.
      assert.equal(await l1Of(VIEWER2), null, "VIEWER2's L1 entry is gone");
      assert.equal(persistedRowsFor(app, VIEWER2).length, 0, "VIEWER2's persisted row is gone");
      assert.equal(await l1Of(OWNER), null, "the setter is still evicted too");
      assert.equal(persistedRowsFor(app, OWNER).length, 0);
      // An eviction was ISSUED per user, which is what the audit row records.
      assert.equal(invalidationsFor(app, VIEWER2).length, 1);
      assert.equal(invalidationsFor(app, OWNER).length, 1);
      assert.ok(r.json.cacheEviction.audience.includes(VIEWER2));
    } finally { await app.close(); }
  });

  it("the reported outcome does NOT overclaim: L1 evicted, persisted purge best-effort and unverifiable", async () => {
    const app = await startApp();
    try {
      await seedCache(app, VIEWER2);
      const r = await setControl(app, "KEEP_PRIVATE_FOREVER", H_CIRCLE);
      const ev = r.json.cacheEviction;
      assert.equal(ev.reachesOtherViewers, true);
      // The strongest word the module owns. There is no "complete"/"purged".
      assert.equal(ev.outcome, "l1_evicted_persisted_unverifiable");
      assert.equal(ev.persistedPurgeVerified, false);
      assert.match(ev.detail, /PERSISTED PURGE IS BEST-EFFORT AND UNVERIFIABLE/);
      assert.match(ev.detail, /permission audience, not the set of cache rows/);
      assert.ok(!/\bcomplete\b/i.test(ev.outcome), "no outcome of this module says complete");
      assert.equal(ev.audienceBounded, true, "circle_only IS a bounded audience");
    } finally { await app.close(); }
  });

  it("a PUBLIC Highlight reports `audience_incomplete` — 'any authenticated user' is not an enumerable audience — while still evicting the reachable part", async () => {
    const app = await startApp();
    try {
      await seedCache(app, VIEWER);   // a follower
      await seedCache(app, STRANGER); // no relationship, not evicted
      const r = await setControl(app, "KEEP_PRIVATE_FOREVER", H_PUB);
      const ev = r.json.cacheEviction;
      assert.equal(await l1Of(VIEWER), null, "the follower's cache IS evicted");
      assert.deepEqual(await l1Of(STRANGER), { served: STRANGER }, "and a stranger's is not — which is why the report must not claim completeness");
      assert.equal(ev.outcome, "audience_incomplete");
      assert.equal(ev.audienceBounded, false);
      assert.match(ev.detail, /any authenticated user/);
      assert.equal(ev.persistedPurgeVerified, false);
    } finally { await app.close(); }
  });

  it("an audience source that cannot be read is reported as INCOMPLETE and logged — while the control stays stored", async () => {
    // highlight_views is one of the reads that DEFINES the audience. A fan-out
    // that could not establish who the viewers are must not report success.
    const app = await startApp({ failTables: new Set(["highlight_views"]) });
    try {
      const r = await setControl(app, "KEEP_PRIVATE_FOREVER", H_CIRCLE);
      assert.equal(r.status, 200, "the control was STORED; a cache miss does not undo a privacy decision");
      // The stored row is the state that matters for the 200.
      const stored = app.tables.highlight_resurfacing_preferences.filter(
        (p) => p.owner_id === OWNER && p.control === "KEEP_PRIVATE_FOREVER" && p.subject_id === H_CIRCLE,
      );
      assert.equal(stored.length, 1);

      const ev = r.json.cacheEviction;
      assert.equal(ev.outcome, "audience_incomplete");
      assert.equal(ev.audienceBounded, false);
      const unresolved = (ev.sources as any[]).filter((s) => !s.resolved).map((s) => s.source);
      assert.ok(unresolved.includes("highlight_views"), `expected highlight_views unresolved, got ${JSON.stringify(unresolved)}`);
      const logged = app.errors.filter((e) => e.obj?.outcome === "audience_incomplete");
      assert.equal(logged.length, 1);
      assert.match(logged[0]!.msg, /reported partial rather than complete/);
    } finally { await app.close(); }
  });

  it("a control with no cross-viewer effect is NOT fanned out, and says so rather than pretending it was", async () => {
    const app = await startApp();
    try {
      await seedCache(app, OWNER);
      await seedCache(app, VIEWER2);
      const r = await setControl(app, "DO_NOT_RESURFACE", H_CIRCLE);
      assert.equal(r.status, 200);
      assert.equal(await l1Of(OWNER), null, "the setter's own proactive surfaces changed, so their cache goes");
      assert.deepEqual(await l1Of(VIEWER2), { served: VIEWER2 }, "DO_NOT_RESURFACE suppresses nothing another viewer sees");
      const ev = r.json.cacheEviction;
      assert.equal(ev.reachesOtherViewers, false);
      assert.deepEqual(ev.audience, [OWNER]);
      assert.equal(ev.persistedPurgeVerified, false);
    } finally { await app.close(); }
  });

  it("a DELETE naming a Highlight the caller never set a control on resolves NO audience — `audience` must not become a viewer-list oracle", async () => {
    // The DELETE's selector is unchecked user input and clearResurfacingControl
    // scopes its delete to owner_id without verifying the subject. VIEWER names
    // the OWNER's Highlight: the clear matches nothing, so nothing of the
    // OWNER's audience may be resolved or returned.
    const app = await startApp();
    try {
      await seedCache(app, VIEWER2);
      const r = await call(
        app, "DELETE",
        `/api/highlights/resurfacing-controls?control=KEEP_PRIVATE_FOREVER&subjectId=${H_CIRCLE}&confirm=true`,
        VIEWER,
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.cleared, false);
      const ev = r.json.cacheEviction;
      assert.equal(ev.reachesOtherViewers, false);
      assert.deepEqual(ev.audience, [VIEWER], "only the caller's own cache, and no other id is disclosed");
      assert.ok(!ev.audience.includes(VIEWER2));
      // STATE: the uninvolved viewer's cache is untouched.
      assert.deepEqual(await l1Of(VIEWER2), { served: VIEWER2 });
    } finally { await app.close(); }
  });

  it("the audience resolver refuses an unowned subject on its own, independently of the route", async () => {
    const { resolveCacheEvictionAudience } = await import("../services/highlights/highlightCacheFanout.js");
    const app = await startApp();
    try {
      const a = await resolveCacheEvictionAudience(app.client, H_CIRCLE, VIEWER);
      assert.deepEqual(a.userIds, [VIEWER]);
      assert.equal(a.bounded, false, "a refusal is not a bounded audience");
      assert.ok(a.sources.some((x: any) => !x.resolved && /not owned by the caller/.test(x.detail)));
      // PAIRED CONTROL — the real owner DOES get an audience from the same call.
      const owned = await resolveCacheEvictionAudience(app.client, H_CIRCLE, OWNER);
      assert.ok(owned.userIds.includes(VIEWER2));
      assert.equal(owned.bounded, true);
    } finally { await app.close(); }
  });

  it("CLEARING KEEP_PRIVATE_FOREVER fans out too — re-admitting a Highlight is as stale-making as withdrawing it", async () => {
    const app = await startApp();
    try {
      await setControl(app, "KEEP_PRIVATE_FOREVER", H_CIRCLE);
      clearL1Cache();
      app.tables.compass_feed_cache.length = 0;
      await seedCache(app, VIEWER2);

      const r = await call(
        app, "DELETE",
        `/api/highlights/resurfacing-controls?control=KEEP_PRIVATE_FOREVER&subjectId=${H_CIRCLE}&confirm=true`,
        OWNER,
      );
      assert.equal(r.status, 200);
      assert.equal(r.json.cleared, true);
      assert.equal(await l1Of(VIEWER2), null, "the second viewer's stale entry is evicted on the way back out");
      assert.equal(persistedRowsFor(app, VIEWER2).length, 0);
      assert.equal(r.json.cacheEviction.reachesOtherViewers, true);
      assert.equal(r.json.cacheEviction.persistedPurgeVerified, false);
    } finally { await app.close(); }
  });
});
