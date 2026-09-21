/**
 * Stories: "could not look" must not be served as "there is nothing there",
 * and trip_crew must mean what requireTripMember means by it.
 *
 * THREE DEFECTS, ONE FILE
 * -----------------------
 *
 * 1. GET /stories/feed built its candidate-owner set out of four reads —
 *    user_follows (both directions), trip_members, circle_memberships — and
 *    checked none of their `.error`s. supabase-js RESOLVES on a database error,
 *    so `(followRows.data ?? [])` on an unreadable follow graph is an EMPTY
 *    SET, candidateOwners comes out empty, and the handler answers
 *    `{ users: [] }`: "nobody you follow has posted a story". That is a
 *    statement about other people's lives produced by a lookup that never
 *    happened — the same shape a sibling lane found in the Wall ("you're all
 *    caught up") and the passport ("zero stamps"). §28.11.
 *
 * 2. trip_crew was `trip_members WHERE role IN ('owner','member')`, self-joined,
 *    with `status` ignored. requireTripMember (lib/http.ts, the definition of
 *    record) accepts role IN (owner, co_host, member, viewer) AND
 *    coalesce(status,'accepted')='accepted', plus trips.owner_id when no row
 *    exists. The old predicate ADMITTED a pending invitee and a REMOVED member,
 *    and DENIED a co_host, a viewer and a trip owner holding no row. Migration
 *    2530 repaired the identical defect in the RLS policy behind highlights;
 *    routes/highlights.ts repaired the app side; stories never did.
 *
 * 3. Two writes reported success without knowing they had done anything.
 *    DELETE /stories/:id and the save-to-highlight link update both ran an
 *    UPDATE with no `.select()`, so `data` was null and `error === null` meant
 *    only "the statement ran" — an update matching ZERO rows errors nothing.
 *    A person taking their Story down was told 204 for a Story still live.
 *
 * PAIRING (the false-green rule). A viewer who genuinely follows nobody and a
 * viewer whose follow graph is unreadable both produce an empty feed, so every
 * failure case below is paired with the SAME fixture read successfully. A suite
 * of failures alone would pass against a handler that always refuses.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/storiesReadFailures.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import storiesRouter from "../routes/stories.js";

const U = {
  OWNER:      "10000000-0000-4000-8000-000000000001", // owns T1 (holds an owner row)
  ACC:        "10000000-0000-4000-8000-000000000002", // T1 member/accepted
  COHOST:     "10000000-0000-4000-8000-000000000003", // T1 co_host/accepted
  TVIEWER:    "10000000-0000-4000-8000-000000000004", // T1 viewer/accepted
  PEND:       "10000000-0000-4000-8000-000000000005", // T1 member/invited  (pending)
  LEGACY:     "10000000-0000-4000-8000-000000000006", // T1 invited/accepted (legacy pending)
  REMOVED:    "10000000-0000-4000-8000-000000000007", // T1 member/removed
  STRANGER:   "10000000-0000-4000-8000-000000000008", // no rows anywhere
  T2_MEMBER:  "10000000-0000-4000-8000-000000000009", // T2 member/accepted; OWNER owns T2 with NO row
} as const;

const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const S_CREW   = "30000000-0000-4000-8000-000000000001"; // OWNER's trip_crew story on T1
const S_CREW2  = "30000000-0000-4000-8000-000000000002"; // OWNER's trip_crew story on T2
const S_PUBLIC = "30000000-0000-4000-8000-000000000003"; // OWNER's public story

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

const story = (id: string, owner_id: string, visibility: string, trip_id: string | null) => ({
  id, owner_id, visibility, trip_id,
  media_url: "post-media/x/y.jpg", media_type: "image/jpeg", caption: null,
  close_friends_only: false, event_id: null, place_id: null,
  expires_at: FUTURE, saved_to_highlight_id: null, state: "active",
  hide_viewer_list: false, created_at: "2026-01-01T00:00:00.000Z",
  allowed_user_ids: [], hidden_user_ids: [],
});

function fixtureTables(): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "stories_enabled", enabled: true }],
    profiles: Object.values(U).map((id) => ({
      id, handle: `h_${id.slice(-2)}`, name: "n", avatar_url: null, verified: false,
      account_status: "active", is_private: false,
    })),
    trips: [
      { id: T1, owner_id: U.OWNER },
      { id: T2, owner_id: U.OWNER }, // OWNER holds no trip_members row on T2
    ],
    trip_members: [
      { trip_id: T1, user_id: U.OWNER,   role: "owner",   status: "accepted" },
      { trip_id: T1, user_id: U.ACC,     role: "member",  status: "accepted" },
      { trip_id: T1, user_id: U.COHOST,  role: "co_host", status: "accepted" },
      { trip_id: T1, user_id: U.TVIEWER, role: "viewer",  status: "accepted" },
      { trip_id: T1, user_id: U.PEND,    role: "member",  status: "invited"  },
      { trip_id: T1, user_id: U.LEGACY,  role: "invited", status: "accepted" },
      { trip_id: T1, user_id: U.REMOVED, role: "member",  status: "removed"  },
      { trip_id: T2, user_id: U.T2_MEMBER, role: "member", status: "accepted" },
    ],
    stories: [
      story(S_CREW, U.OWNER, "trip_crew", T1),
      story(S_CREW2, U.OWNER, "trip_crew", T2),
      story(S_PUBLIC, U.OWNER, "public", null),
    ],
    // Everyone follows OWNER, so the feed has a candidate owner for every viewer
    // and a failure cannot be mistaken for "you follow nobody".
    user_follows: Object.values(U).filter((id) => id !== U.OWNER).map((id) => ({ follower_id: id, following_id: U.OWNER })),
    blocks: [], circle_memberships: [], close_friends: [], story_views: [], story_reactions: [], story_replies: [],
  };
}

/**
 * Filtering supabase-js stand-in. `failTables` makes every read of those tables
 * RESOLVE with an error, which is what supabase-js actually does — a fake that
 * threw would exercise a catch that does not exist in production.
 * `zeroRowUpdate` makes UPDATE .select() come back with no rows while erroring
 * nothing, which is the shape an RLS-filtered update really has.
 */
function makeFakeClient(
  tables: Record<string, any[]>,
  opts: { failTables?: Set<string>; zeroRowUpdate?: Set<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();
  const zeroRowUpdate = opts.zeroRowUpdate ?? new Set<string>();
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isUpdate = false, selectedAfterWrite = false;
    let updatePatch: any = null;
    const obj: any = {
      select(_c?: string, o?: any) {
        if (o?.head) head = true;
        if (isUpdate) selectedAfterWrite = true;
        return obj;
      },
      insert(d: any) { obj.__insert = d; return obj; },
      update(d: any) { isUpdate = true; updatePatch = d; return obj; },
      upsert() { return obj; },
      delete() { return obj; },
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
      if (obj.__insert) {
        const rows = (Array.isArray(obj.__insert) ? obj.__insert : [obj.__insert])
          .map((r: any) => ({ ...r, id: r.id ?? `new-${table}-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) (tables[table] ??= []).push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (isUpdate) {
        if (zeroRowUpdate.has(table)) rows = [];
        for (const r of rows) Object.assign(r, updatePatch);
        // An UPDATE without .select() returns data:null in supabase-js — the
        // whole point of the defect this suite pins.
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
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    // The bearer token IS the viewer id, so one app serves every viewer.
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

type App = {
  baseUrl: string;
  close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  tables: Record<string, any[]>;
};

async function startApp(opts: { failTables?: Set<string>; zeroRowUpdate?: Set<string> } = {}): Promise<App> {
  const tables = fixtureTables();
  _setTestClient(makeFakeClient(tables, opts) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  const app = express();
  app.use(express.json());
  // Without this shim the routes CRASH on req.log and a 500-from-crash would
  // masquerade as a deliberate refusal.
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: any, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", storiesRouter);
  app.use((err: any, _req: any, res: any, _n: any) => { res.status(500).json({ error: "crash", message: String(err?.message ?? err) }); });
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, errors, tables,
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
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const feedStoryIds = (body: any) =>
  new Set(((body?.users ?? []) as any[]).flatMap((u) => (u.stories ?? []).map((s: any) => s.id as string)));

// ── 1. The feed must not say "no stories" when it could not look ─────────────

describe("GET /stories/feed: an unreadable viewer context is refused, not rendered as an empty feed", () => {
  it("PAIRED CONTROL — everything readable: the feed is served and is NOT empty", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/stories/feed", U.ACC);
      assert.equal(r.status, 200);
      assert.ok(feedStoryIds(r.body).has(S_PUBLIC),
        `the control must actually return stories, or every failure case below passes for free; got ${JSON.stringify(r.body)}`);
    } finally { await app.close(); }
  });

  for (const table of ["user_follows", "trip_members", "circle_memberships", "close_friends", "trips"] as const) {
    it(`an unreadable ${table} → 503 degraded_unavailable + retryable, never { users: [] }`, async () => {
      const app = await startApp({ failTables: new Set([table]) });
      try {
        const r = await call(app, "GET", "/api/stories/feed", U.ACC);
        assert.equal(r.status, 503, `expected a refusal, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.equal(r.body?.error, "degraded_unavailable");
        assert.equal(r.body?.retryable, true);
        assert.equal(r.body?.users, undefined, "a refusal must not also ship an empty feed");
        assert.ok(app.errors.some((e) => /unreadable/.test(e.msg)),
          `the refusal must be logged; got ${JSON.stringify(app.errors.map((e) => e.msg))}`);
      } finally { await app.close(); }
    });
  }

  it("an unreadable blocks table is still refused (the pre-existing exclusion guard)", async () => {
    const app = await startApp({ failTables: new Set(["blocks"]) });
    try {
      const r = await call(app, "GET", "/api/stories/feed", U.ACC);
      assert.equal(r.status, 503);
      assert.equal(r.body?.error, "degraded_unavailable");
    } finally { await app.close(); }
  });
});

// ── 2. trip_crew is requireTripMember's rule, on both sides ──────────────────

/** viewer → may read OWNER's trip_crew story on T1? */
const CREW_EXPECTED: Array<[keyof typeof U, boolean, string]> = [
  ["ACC", true, "accepted member"],
  ["COHOST", true, "accepted co_host (was DENIED by the old role list)"],
  ["TVIEWER", true, "accepted viewer (was DENIED by the old role list)"],
  ["PEND", false, "pending invitee role=member status=invited (was ADMITTED)"],
  ["LEGACY", false, "legacy pending role=invited (was correctly denied, still is)"],
  ["REMOVED", false, "removed member status=removed (was ADMITTED)"],
  ["STRANGER", false, "no relationship"],
];

describe("stories trip_crew: requireTripMember's rule, applied to both people", () => {
  for (const [who, visible, why] of CREW_EXPECTED) {
    it(`GET /stories/:id — ${who}: ${visible ? "200" : "404"} (${why})`, async () => {
      const app = await startApp();
      try {
        const r = await call(app, "GET", `/api/stories/${S_CREW}`, U[who]);
        assert.equal(r.status, visible ? 200 : 404, JSON.stringify(r.body));
        if (!visible) assert.equal(r.body?.error, "not_found");
      } finally { await app.close(); }
    });

    it(`GET /stories/feed — ${who}: ${visible ? "sees" : "does not see"} the trip_crew story`, async () => {
      const app = await startApp();
      try {
        const r = await call(app, "GET", "/api/stories/feed", U[who]);
        assert.equal(r.status, 200);
        assert.ok(feedStoryIds(r.body).has(S_PUBLIC), "the public story is always in the feed");
        assert.equal(feedStoryIds(r.body).has(S_CREW), visible);
      } finally { await app.close(); }
    });
  }

  it("the trips.owner_id fallback works on the STORY OWNER's side: T2's owner holds no row", async () => {
    // OWNER owns T2 and has no trip_members row on it. The old self-join looked
    // for an ('owner','member') row for the story owner and found none, so this
    // story was invisible to T2's accepted crew.
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/stories/${S_CREW2}`, U.T2_MEMBER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("the owner always reads their own trip_crew story", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/stories/${S_CREW}`, U.OWNER);
      assert.equal(r.status, 200);
    } finally { await app.close(); }
  });
});

// ── 3. An undecidable gate withholds AND says so ─────────────────────────────

describe("stories single-story gate: undecidable is withheld and logged, not silently denied", () => {
  it("PAIRED CONTROL — readable crew: the accepted member gets 200 and nothing is logged", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/stories/${S_CREW}`, U.ACC);
      assert.equal(r.status, 200);
      assert.equal(app.errors.filter((e) => /visibility gate/.test(e.msg)).length, 0);
    } finally { await app.close(); }
  });

  it("an unreadable trip_members withholds the story (404) and logs the gate failure", async () => {
    const app = await startApp({ failTables: new Set(["trip_members"]) });
    try {
      const r = await call(app, "GET", `/api/stories/${S_CREW}`, U.ACC);
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.equal(r.body?.error, "not_found");
      assert.ok(app.errors.some((e) => /visibility gate lookup failed/.test(e.msg)),
        `the withholding must be distinguishable from a real deny; got ${JSON.stringify(app.errors.map((e) => e.msg))}`);
    } finally { await app.close(); }
  });

  it("an unreadable STORIES table is db_error, not 'Story not found'", async () => {
    const app = await startApp({ failTables: new Set(["stories"]) });
    try {
      const r = await call(app, "GET", `/api/stories/${S_PUBLIC}`, U.ACC);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
    } finally { await app.close(); }
  });
});

// ── 4. Writes that touched nothing must not report success ───────────────────

describe("stories writes: a zero-row UPDATE is not a success", () => {
  it("PAIRED CONTROL — DELETE /stories/:id matches its row: 204 and the row is state=deleted", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/stories/${S_PUBLIC}`, U.OWNER);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.equal(app.tables.stories.find((s) => s.id === S_PUBLIC)?.state, "deleted");
    } finally { await app.close(); }
  });

  it("DELETE /stories/:id that matches ZERO rows must NOT answer 204", async () => {
    const app = await startApp({ zeroRowUpdate: new Set(["stories"]) });
    try {
      const r = await call(app, "DELETE", `/api/stories/${S_PUBLIC}`, U.OWNER);
      assert.notEqual(r.status, 204, "a story that is still live must not be reported as deleted");
      assert.equal(r.status, 500);
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.stories.find((s) => s.id === S_PUBLIC)?.state, "active",
        "the fixture must really be untouched, or this passes for the wrong reason");
      assert.ok(app.errors.some((e) => /matched zero rows/.test(e.msg)));
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — save-to-highlight links the story and reports linked: true", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/stories/${S_PUBLIC}/save-to-highlight`, U.OWNER);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body?.linked, true);
      assert.equal(app.tables.stories.find((s) => s.id === S_PUBLIC)?.state, "saved");
    } finally { await app.close(); }
  });

  it("save-to-highlight whose link update matches zero rows reports linked: false, not silent success", async () => {
    const app = await startApp({ zeroRowUpdate: new Set(["stories"]) });
    try {
      const r = await call(app, "POST", `/api/stories/${S_PUBLIC}/save-to-highlight`, U.OWNER);
      assert.equal(r.status, 201, "the highlight WAS created, so the request did succeed");
      assert.equal(r.body?.linked, false,
        "a story left unmarked will mint a second highlight on the next call");
      assert.equal(app.tables.stories.find((s) => s.id === S_PUBLIC)?.saved_to_highlight_id, null);
      assert.ok(app.errors.some((e) => /link update did not take/.test(e.msg)));
    } finally { await app.close(); }
  });
});
