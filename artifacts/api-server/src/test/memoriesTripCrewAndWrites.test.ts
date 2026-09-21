/**
 * Memories: trip_crew admitted anyone holding a trip_members row, gate reads
 * denied silently, and four writes reported success without knowing anything.
 *
 * 1. TRIP_CREW WAS THE LOOSEST OF THE THREE COPIES. canReadMemory's branch read
 *
 *      trip_members WHERE trip_id = memory.trip_id AND user_id = viewer
 *
 *    and nothing else: no role filter, no status filter, and NO CHECK ON THE
 *    MEMORY'S OWNER at all. Any row admitted — role='invited' (never accepted),
 *    status='removed' (thrown off the trip), any role whatsoever. Compare
 *    requireTripMember (lib/http.ts, the definition of record): role IN
 *    (owner, co_host, member, viewer) AND coalesce(status,'accepted')='accepted',
 *    plus the trips.owner_id fallback when no row exists. Migration 2530
 *    repaired the identical shape in the RLS policy behind highlights;
 *    routes/highlights.ts and routes/stories.ts carry the app-side rule.
 *
 * 2. THE GATE READS DENIED SILENTLY. supabase-js RESOLVES on a database error,
 *    so `Boolean(data)` on an unreadable follow graph, crew or circle produced a
 *    confident "not permitted" that nothing could tell from a real one. The
 *    denial is the safe verdict and is unchanged; what was missing is that
 *    anyone could SEE it. These are routes/memories.ts's four entries on the
 *    unchecked-reads ledger.
 *
 * 3. FOUR WRITES REPORTED SUCCESS BLIND.
 *      DELETE /memories/:id           — the soft-delete UPDATE was discarded
 *                                       entirely: 204 for a memory still
 *                                       published and still in the feed.
 *      DELETE /memories/:id/items/:id — the row delete was discarded and the
 *                                       STORAGE OBJECT IS REMOVED next, so a
 *                                       failed delete left a row pointing at
 *                                       erased bytes: a permanently broken item.
 *      DELETE …/like, DELETE …/save   — discarded deletes behind a 200.
 *      PATCH …/tags/:userId           — UPDATE with no .select(), so
 *                                       `error === null` did not mean a row
 *                                       changed; a consent decision reported as
 *                                       applied when nothing was written.
 *
 * PAIRING (the false-green rule). A viewer who is genuinely not crew and a
 * viewer whose crew table cannot be read are both denied, and a delete that
 * matched nothing and a delete that failed both leave the row in place — so
 * every failure case below is paired with the SAME fixture read successfully.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoriesTripCrewAndWrites.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import memoriesRouter from "../routes/memories.js";

const U = {
  OWNER:     "10000000-0000-4000-8000-000000000001", // owns M_CREW; T1 owner row
  ACC:       "10000000-0000-4000-8000-000000000002", // T1 member/accepted
  COHOST:    "10000000-0000-4000-8000-000000000003", // T1 co_host/accepted
  TVIEWER:   "10000000-0000-4000-8000-000000000004", // T1 viewer/accepted
  PEND:      "10000000-0000-4000-8000-000000000005", // T1 member/invited
  REMOVED:   "10000000-0000-4000-8000-000000000006", // T1 member/removed
  STRANGER:  "10000000-0000-4000-8000-000000000007", // no rows anywhere
  T2_MEMBER: "10000000-0000-4000-8000-000000000008", // T2 member/accepted
} as const;

const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002"; // OWNER owns it, holds NO row
const M_CREW  = "30000000-0000-4000-8000-000000000001";
const M_CREW2 = "30000000-0000-4000-8000-000000000002";
const M_MINE  = "30000000-0000-4000-8000-000000000003"; // ACC's own memory
const ITEM    = "40000000-0000-4000-8000-000000000001";

const memory = (id: string, owner_id: string, visibility: string, trip_id: string | null) => ({
  id, owner_id, visibility, trip_id,
  title: "t", caption: null, allowed_user_ids: [], hidden_user_ids: [],
  event_id: null, place_id: null, location_city: null, location_country: null,
  location_lat: null, location_lng: null, canonical_location_id: null,
  starts_at: null, ends_at: null, state: "published",
  created_at: "2026-01-01T00:00:00.000Z", updated_at: null,
});

function fixtureTables(): Record<string, any[]> {
  return {
    feature_flags: [{ flag: "memories_enabled", enabled: true }],
    profiles: Object.values(U).map((id) => ({
      id, handle: `h_${id.slice(-2)}`, name: "n", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    trips: [{ id: T1, owner_id: U.OWNER }, { id: T2, owner_id: U.OWNER }],
    trip_members: [
      { trip_id: T1, user_id: U.OWNER,   role: "owner",   status: "accepted" },
      { trip_id: T1, user_id: U.ACC,     role: "member",  status: "accepted" },
      { trip_id: T1, user_id: U.COHOST,  role: "co_host", status: "accepted" },
      { trip_id: T1, user_id: U.TVIEWER, role: "viewer",  status: "accepted" },
      { trip_id: T1, user_id: U.PEND,    role: "member",  status: "invited"  },
      { trip_id: T1, user_id: U.REMOVED, role: "member",  status: "removed"  },
      { trip_id: T2, user_id: U.T2_MEMBER, role: "member", status: "accepted" },
    ],
    memories: [
      memory(M_CREW, U.OWNER, "trip_crew", T1),
      memory(M_CREW2, U.OWNER, "trip_crew", T2),
      memory(M_MINE, U.ACC, "public", null),
    ],
    memory_items: [{ id: ITEM, memory_id: M_MINE, media_url: "https://x/storage/v1/object/public/post-media/memories/other/f.jpg", media_type: "image/jpeg", caption: null, position: 0, created_at: "2026-01-01T00:00:00.000Z" }],
    memory_tags: [{ memory_id: M_CREW, tagged_user_id: U.ACC, status: "pending", created_at: "2026-01-01T00:00:00.000Z" }],
    memory_likes: [{ memory_id: M_MINE, user_id: U.ACC }],
    memory_saves: [{ memory_id: M_MINE, user_id: U.ACC }],
    blocks: [], user_follows: [], circle_memberships: [], collections: [], collection_items: [],
    notifications: [], hidden_gems: [],
  };
}

const storageRemovals: string[][] = [];

function makeFakeClient(
  tables: Record<string, any[]>,
  opts: { failTables?: Set<string>; failWrites?: Set<string>; zeroRowWrite?: Set<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const zeroRowWrite = opts.zeroRowWrite ?? new Set<string>();
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "upsert" | "delete" | null = null;
    let payload: any = null;
    const obj: any = {
      select(_c?: string, o?: any) {
        if (o?.head) head = true;
        if (isWrite) selectedAfterWrite = true;
        return obj;
      },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "upsert"; payload = d; return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (isWrite && (failWrites.has(table) || failTables.has(table))) return { data: null, error: { message: `${table} write failed` }, count: null };
      if (!isWrite && failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (tables[table] ??= []);
      if (mode === "insert" || mode === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "delete") {
        if (zeroRowWrite.has(table)) matched = [];
        const gone = new Set(matched);
        tables[table] = all.filter((r) => !gone.has(r));
        // PostgREST returns the deleted rows only when .select() is chained.
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (mode === "update") {
        if (zeroRowWrite.has(table)) matched = [];
        for (const r of matched) Object.assign(r, payload);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: head ? matched.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: [], error: null }),
    storage: { from: () => ({ remove: async (paths: string[]) => { storageRemovals.push(paths); return { data: null, error: null }; } }) },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

type App = {
  baseUrl: string; close: () => Promise<void>;
  errors: Array<{ obj: any; msg: string }>;
  logged: Array<{ obj: any; msg: string }>;
  tables: Record<string, any[]>;
};

async function startApp(opts: { failTables?: Set<string>; failWrites?: Set<string>; zeroRowWrite?: Set<string> } = {}): Promise<App> {
  const tables = fixtureTables();
  storageRemovals.length = 0;
  _setTestClient(makeFakeClient(tables, opts) as any, true);
  const errors: Array<{ obj: any; msg: string }> = [];
  // canReadMemory logs through the module logger, not req.log, because it is
  // called per row from surfaces that have no request in scope.
  const logged: Array<{ obj: any; msg: string }> = [];
  const realLoggerError = logger.error.bind(logger);
  (logger as any).error = (obj: any, msg?: string) => { logged.push({ obj, msg: String(msg ?? obj) }); };
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: any, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, errors, logged, tables,
        close: () => new Promise<void>((r) => { (logger as any).error = realLoggerError; srv.close(() => r()); }),
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
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// ── 1. trip_crew ─────────────────────────────────────────────────────────────

/** viewer → may read OWNER's trip_crew memory on T1? */
const CREW: Array<[keyof typeof U, boolean, string]> = [
  ["ACC", true, "accepted member"],
  ["COHOST", true, "accepted co_host"],
  ["TVIEWER", true, "accepted viewer"],
  ["PEND", false, "pending invitee, role=member status=invited (WAS ADMITTED — any row passed)"],
  ["REMOVED", false, "removed member, status=removed (WAS ADMITTED — any row passed)"],
  ["STRANGER", false, "no relationship"],
  ["T2_MEMBER", false, "crew of a DIFFERENT trip (T2), not of T1"],
];

describe("memories trip_crew: requireTripMember's rule, applied to both people", () => {
  for (const [who, visible, why] of CREW) {
    it(`GET /memories/:id — ${who}: ${visible ? "200" : "404"} (${why})`, async () => {
      const app = await startApp();
      try {
        const r = await call(app, "GET", `/api/memories/${M_CREW}`, U[who]);
        assert.equal(r.status, visible ? 200 : 404, JSON.stringify(r.body));
      } finally { await app.close(); }
    });
  }

  it("the trips.owner_id fallback works: OWNER owns T2 with no row, so T2's crew can read the T2 memory", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/memories/${M_CREW2}`, U.T2_MEMBER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("the owner always reads their own trip_crew memory", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/memories/${M_CREW}`, U.OWNER);
      assert.equal(r.status, 200);
    } finally { await app.close(); }
  });
});

// ── 2. the gate reads are visible when they fail ─────────────────────────────

describe("memories visibility gate: an unreadable gate withholds AND is logged", () => {
  it("PAIRED CONTROL — readable crew: the accepted member is admitted and nothing is logged", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", `/api/memories/${M_CREW}`, U.ACC);
      assert.equal(r.status, 200);
      assert.equal(app.logged.filter((e) => /visibility gate read failed/.test(e.msg)).length, 0);
    } finally { await app.close(); }
  });

  for (const table of ["trip_members", "trips"] as const) {
    it(`an unreadable ${table} withholds the memory (404) and logs the gate failure`, async () => {
      const app = await startApp({ failTables: new Set([table]) });
      try {
        const r = await call(app, "GET", `/api/memories/${M_CREW}`, U.ACC);
        assert.equal(r.status, 404, JSON.stringify(r.body));
        assert.ok(app.logged.some((e) => /visibility gate read failed/.test(e.msg)),
          `the deny must be distinguishable from a real one; got ${JSON.stringify(app.logged.map((e) => e.msg))}`);
      } finally { await app.close(); }
    });
  }

  it("an unreadable MEMORIES table on POST /like is db_error, not 'Memory not found'", async () => {
    const app = await startApp({ failTables: new Set(["memories"]) });
    try {
      const r = await call(app, "POST", `/api/memories/${M_CREW}/like`, U.ACC);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
    } finally { await app.close(); }
  });
});

// ── 3. writes ────────────────────────────────────────────────────────────────

describe("memories writes: success is not reported on a write that touched nothing", () => {
  it("PAIRED CONTROL — DELETE /memories/:id soft-deletes: 204 and state='deleted'", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}`, U.ACC);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.equal(app.tables.memories.find((m) => m.id === M_MINE)?.state, "deleted");
    } finally { await app.close(); }
  });

  it("DELETE /memories/:id whose UPDATE matches zero rows must NOT answer 204", async () => {
    const app = await startApp({ zeroRowWrite: new Set(["memories"]) });
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}`, U.ACC);
      assert.notEqual(r.status, 204, "a memory still published must not be reported as deleted");
      assert.equal(r.status, 500);
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.memories.find((m) => m.id === M_MINE)?.state, "published",
        "the fixture must really be untouched, or this passes for the wrong reason");
      assert.ok(app.errors.some((e) => /matched zero rows/.test(e.msg)));
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — DELETE item removes the row: 204", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}/items/${ITEM}`, U.ACC);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.equal(app.tables.memory_items.length, 0);
    } finally { await app.close(); }
  });

  it("DELETE item whose row delete fails must NOT erase the storage object behind a 204", async () => {
    const app = await startApp({ failWrites: new Set(["memory_items"]) });
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}/items/${ITEM}`, U.ACC);
      assert.notEqual(r.status, 204);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(app.tables.memory_items.length, 1, "the row is still there");
      assert.equal(storageRemovals.length, 0,
        "the storage object must not be erased under a row that survived — that is a permanently broken item");
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — DELETE /like removes the like: 200 likedByMe false", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}/like`, U.ACC);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body?.likedByMe, false);
      assert.equal(app.tables.memory_likes.length, 0);
    } finally { await app.close(); }
  });

  it("a failed unlike must not answer 200 { likedByMe: false }", async () => {
    const app = await startApp({ failWrites: new Set(["memory_likes"]) });
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}/like`, U.ACC);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.memory_likes.length, 1, "the like is still stored");
    } finally { await app.close(); }
  });

  it("a failed unsave must not answer 200 { savedByMe: false }", async () => {
    const app = await startApp({ failWrites: new Set(["memory_saves"]) });
    try {
      const r = await call(app, "DELETE", `/api/memories/${M_MINE}/save`, U.ACC);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — PATCH tag applies: 200 and the row's status changed", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_CREW}/tags/${U.ACC}`, U.ACC, { action: "remove" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(app.tables.memory_tags[0]?.status, "removed");
    } finally { await app.close(); }
  });

  it("PATCH tag whose UPDATE matches zero rows must not report the consent decision as applied", async () => {
    const app = await startApp({ zeroRowWrite: new Set(["memory_tags"]) });
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_CREW}/tags/${U.ACC}`, U.ACC, { action: "remove" });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.memory_tags[0]?.status, "pending", "the tag really is unchanged");
      assert.ok(app.errors.some((e) => /tag update matched zero rows/.test(e.msg)));
    } finally { await app.close(); }
  });
});
