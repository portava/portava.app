/**
 * The public Memory surface: what may appear on it, and what a page of it means.
 *
 * Highlights/Memories Development Architecture Spec v1
 *   §10  "Public search only queries public derivatives, never private
 *         canonical storage followed by post-query filtering."
 *   §23  canReadMemory(userId, memoryId, SURFACE) — the surface is part of the
 *         signature; one verdict must not serve every surface.
 *   §25  hard invariant: "PRIVATE memory cannot appear in public search."
 *   §25  certification fixture: "Public-to-private revocation."
 *   §28.6 "Never expose private canonical Memory records to public search and
 *         rely on post-filtering."
 *
 * WHAT WAS ACTUALLY WRONG (both defects are live, not hypothetical)
 * ----------------------------------------------------------------
 * 1. GET /memories never consulted `hidden_user_ids`. The MEM·M1 fix — "a
 *    hidden viewer is denied for EVERY visibility mode" — was made inside the
 *    read helper, and the discovery feed is the one read path that did not call
 *    the helper. A user the owner had explicitly hidden read that owner's
 *    public Memories in the global feed.
 *
 * 2. `.limit(n)` ran in the database and the block filter ran afterwards in
 *    TypeScript, so a page shrank by however many blocked owners it contained.
 *    Ask for 2, get 1 — and since nextCursor is emitted only on a FULL page,
 *    that short page also ended the feed while rows were still behind it.
 *
 * Both are the same mistake — filtering after the page is cut — which is why
 * §10 and §28.6 forbid the shape rather than any particular missing predicate.
 *
 * Run: node --import tsx/esm --test src/test/memoriesPublicFeedPrivacy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VIEWER   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const OTHER    = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BLOCKER  = "dddddddd-dddd-dddd-dddd-dddddddddddd";

const M_PUBLIC  = "11111111-1111-1111-1111-111111111111";
const M_PRIVATE = "22222222-2222-2222-2222-222222222222";
const M_CUSTOM  = "33333333-3333-3333-3333-333333333333";
const M_BLOCKED = "44444444-4444-4444-4444-444444444444";
const M_SECOND  = "55555555-5555-5555-5555-555555555555";

interface Row { [k: string]: any }

function memory(over: Row): Row {
  return {
    id: M_PUBLIC, owner_id: OWNER, title: "t", caption: null,
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null,
    location_city: null, location_country: null,
    location_lat: null, location_lng: null, canonical_location_id: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

interface State {
  memories: Row[];
  blocks: Row[];
  feature_flags: Row[];
  profiles: Row[];
  /** Rows the fake `rpc("memory_public_feed")` hands back, when used. */
  rpcRows?: Row[];
  /** Every table name whose query errored, for the fail-closed assertions. */
  errorTables: Set<string>;
}

function baseState(over: Partial<State> = {}): State {
  return {
    memories: [memory({})],
    blocks: [],
    feature_flags: [],
    profiles: [
      { id: OWNER,   account_status: "active", name: "Owner",   handle: "owner",   avatar_url: null },
      { id: VIEWER,  account_status: "active", name: "Viewer",  handle: "viewer",  avatar_url: null },
      { id: OTHER,   account_status: "active", name: "Other",   handle: "other",   avatar_url: null },
      { id: BLOCKER, account_status: "active", name: "Blocker", handle: "blocker", avatar_url: null },
    ],
    errorTables: new Set<string>(),
    ...over,
  };
}

/**
 * A fake with a WORKING `.limit()` and `.order()`.
 *
 * That matters: the fake used by memories.test.ts treats limit() as a no-op,
 * which is precisely why the limit-before-filter defect could not be seen from
 * the existing suite. A fake that ignores the operation under test cannot fail
 * on it.
 */
function makeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let pendingUpdate: any = null;
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;
    let countMode = false;

    const builder: any = {
      select(_c?: string, opts?: any) { if (opts?.count === "exact" && opts?.head) countMode = true; return builder; },
      update(p: any) { pendingUpdate = p; return builder; },
      insert() { return builder; },
      upsert() { return builder; },
      delete() { return builder; },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return builder; },
      lt(c: string, v: any)  { filters.push((r) => r[c] < v); return builder; },
      gt(c: string, v: any)  { filters.push((r) => r[c] > v); return builder; },
      is(c: string, v: any)  { filters.push((r) => r[c] === v); return builder; },
      not(c: string, op: string, v: any) {
        if (op === "cs") {
          const wanted = String(v).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
          filters.push((r) => !wanted.some((w) => (r[c] ?? []).includes(w)));
        } else if (op === "in") {
          // PostgREST accepts quoted and bare list members; strip either.
          const list = String(v).replace(/^\(|\)$/g, "").split(",")
            .map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
          filters.push((r) => !list.includes(r[c]));
        } else {
          filters.push((r) => r[c] !== v);
        }
        return builder;
      },
      order(c: string, o?: any) { orderCol = c; orderAsc = o?.ascending !== false; return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(onF: any, onR: any) { return resolve(false).then(onF, onR); },
    };

    function matched(): Row[] {
      let out = ((state as any)[table] ?? []).filter((r: Row) => filters.every((f) => f(r)));
      if (orderCol) {
        const c = orderCol;
        out = [...out].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0));
        if (!orderAsc) out.reverse();
      }
      // The point of this fake: LIMIT is applied by the "database", exactly as
      // PostgREST would, so anything the route filters afterwards shrinks the page.
      if (limitN != null) out = out.slice(0, limitN);
      return out;
    }

    async function resolve(single: boolean) {
      if (state.errorTables.has(table)) {
        return { data: null, error: { message: `${table} lookup failed` }, count: null };
      }
      if (pendingUpdate) {
        const rows = ((state as any)[table] ?? []).filter((r: Row) => filters.every((f) => f(r)));
        rows.forEach((r: Row) => Object.assign(r, pendingUpdate));
        return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
      }
      const rows = matched();
      if (countMode) return { data: null, error: null, count: rows.length };
      return { data: single ? (rows[0] ?? null) : rows, error: null, count: rows.length };
    }

    return builder;
  }

  return {
    from,
    async rpc(fn: string, _args: any) {
      if (fn === "memory_public_feed") return { data: state.rpcRows ?? [], error: null };
      return { data: null, error: { message: `unknown rpc ${fn}` } };
    },
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, string> = {
          "owner-tok": OWNER, "viewer-tok": VIEWER, "other-tok": OTHER, "blocker-tok": BLOCKER,
        };
        const id = map[tok];
        if (!id) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id } }, error: null };
      },
    },
  };
}

async function startApp(state: State) {
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; state: State; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(base: string, path: string, tok?: string) {
  const hdrs: Record<string, string> = { connection: "close" };
  if (tok) hdrs["Authorization"] = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { headers: hdrs });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function patchReq(base: string, path: string, tok: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", connection: "close", Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const idsOf = (b: any): string[] => (b?.memories ?? []).map((m: any) => m.id);

// ── §25 hard invariant: PRIVATE cannot appear in public search ────────────────

describe("GET /memories — §25 'PRIVATE memory cannot appear in public search'", () => {
  it("omits only_me memories", async () => {
    const state = baseState();
    state.memories.push(memory({ id: M_PRIVATE, visibility: "only_me" }));
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.equal(status, 200);
      assert.ok(idsOf(body).includes(M_PUBLIC), "the public memory should be served");
      assert.ok(!idsOf(body).includes(M_PRIVATE), "an only_me memory must never reach the public feed");
    } finally { await app.close(); }
  });

  it("omits a `custom` memory even when the viewer is on its allow-list", async () => {
    // §23: the surface is part of the predicate. Being permitted to open
    // something you asked for is not permission to have it pushed at you in a
    // global feed of strangers' content.
    const state = baseState();
    state.memories.push(memory({ id: M_CUSTOM, visibility: "custom", allowed_user_ids: [VIEWER] }));
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.ok(!idsOf(body).includes(M_CUSTOM), "a custom-audience memory is not public-feed content");
    } finally { await app.close(); }
  });
});

// ── The hidden-viewer leak (audit MEM·M1, on the surface that missed it) ─────

describe("GET /memories — a hidden viewer is denied on the discovery feed too", () => {
  it("does not serve the owner's public memory to a viewer the owner hid", async () => {
    const state = baseState();
    state.memories = [memory({ hidden_user_ids: [VIEWER] })];
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.equal(status, 200);
      assert.deepEqual(idsOf(body), [], "a hidden viewer must not read the memory from the feed");
    } finally { await app.close(); }
  });

  it("still serves the same memory to a viewer who is not hidden (positive control)", async () => {
    const state = baseState();
    state.memories = [memory({ hidden_user_ids: [OTHER] })];
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.deepEqual(idsOf(body), [M_PUBLIC], "hiding one viewer must not hide the memory from everyone");
    } finally { await app.close(); }
  });
});

// ── The page-shrinking defect ────────────────────────────────────────────────

describe("GET /memories — the page is cut AFTER the privacy filters, not before", () => {
  it("returns a full page of visible memories when a blocked owner's memory would have taken a slot", async () => {
    const state = baseState();
    // Newest first: the blocked owner's memory sorts ahead of both visible ones,
    // so a limit applied before filtering eats one of the two requested slots.
    state.memories = [
      memory({ id: M_PUBLIC, created_at: "2026-01-01T00:00:00.000Z" }),
      memory({ id: M_SECOND, created_at: "2026-01-02T00:00:00.000Z" }),
      memory({ id: M_BLOCKED, owner_id: BLOCKER, created_at: "2026-01-03T00:00:00.000Z" }),
    ];
    state.blocks = [{ blocker_id: BLOCKER, blocked_id: VIEWER }];
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories?limit=2", "viewer-tok");
      assert.equal(status, 200);
      const ids = idsOf(body);
      assert.ok(!ids.includes(M_BLOCKED), "a blocking owner's memory must not be served");
      assert.equal(ids.length, 2, "asking for 2 visible memories must yield 2, not 1 — the block must not consume a slot");
    } finally { await app.close(); }
  });

  it("does not let a hidden-from viewer's memory consume a slot either", async () => {
    const state = baseState();
    state.memories = [
      memory({ id: M_PUBLIC, created_at: "2026-01-01T00:00:00.000Z" }),
      memory({ id: M_SECOND, created_at: "2026-01-02T00:00:00.000Z" }),
      memory({ id: M_CUSTOM, created_at: "2026-01-03T00:00:00.000Z", hidden_user_ids: [VIEWER] }),
    ];
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/memories?limit=2", "viewer-tok");
      const ids = idsOf(body);
      assert.ok(!ids.includes(M_CUSTOM));
      assert.equal(ids.length, 2, "the hidden row must be excluded by the query, not after the page was cut");
    } finally { await app.close(); }
  });
});

// ── §25 certification fixture: public-to-private revocation ──────────────────

describe("§25 fixture — public-to-private revocation", () => {
  it("removes the memory from the public feed and from a stranger's read as soon as the owner makes it private", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const before = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.deepEqual(idsOf(before.body), [M_PUBLIC], "precondition: the memory is public and on the feed");

      const single = await get(app.baseUrl, `/api/memories/${M_PUBLIC}`, "viewer-tok");
      assert.equal(single.status, 200, "precondition: a stranger can read it directly");

      const revoked = await patchReq(app.baseUrl, `/api/memories/${M_PUBLIC}`, "owner-tok", { visibility: "only_me" });
      assert.equal(revoked.status, 200);

      const after = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.deepEqual(idsOf(after.body), [], "revocation must clear the public feed");

      const afterSingle = await get(app.baseUrl, `/api/memories/${M_PUBLIC}`, "viewer-tok");
      assert.equal(afterSingle.status, 404, "revocation must close the addressed read too");

      const owner = await get(app.baseUrl, `/api/memories/${M_PUBLIC}`, "owner-tok");
      assert.equal(owner.status, 200, "revocation retains the Memory for its owner — §21 'make private', not 'delete'");
    } finally { await app.close(); }
  });
});

// ── The §18 derivative path serves the same verdicts ─────────────────────────

describe("GET /memories — the PublicMemoryProjection path", () => {
  it("serves rows from memory_public_feed when memory_public_feed_projection_enabled is on", async () => {
    const state = baseState({ rpcRows: [memory({ id: M_SECOND })] });
    state.feature_flags = [{ flag: "memory_public_feed_projection_enabled", enabled: true }];
    // The canonical table holds a DIFFERENT row, so a result matching rpcRows
    // proves the route really went through the derivative.
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.equal(status, 200);
      assert.deepEqual(idsOf(body), [M_SECOND]);
    } finally { await app.close(); }
  });

  it("re-asserts the public-surface verdict on rows the derivative returned", async () => {
    // Defence in depth: if the SQL ever regressed and handed back a non-public
    // or hidden-from row, the route must still not serve it.
    const state = baseState({
      rpcRows: [
        memory({ id: M_PRIVATE, visibility: "only_me" }),
        memory({ id: M_CUSTOM, hidden_user_ids: [VIEWER] }),
        memory({ id: M_SECOND }),
      ],
    });
    state.feature_flags = [{ flag: "memory_public_feed_projection_enabled", enabled: true }];
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.deepEqual(idsOf(body), [M_SECOND]);
    } finally { await app.close(); }
  });
});

// ── Block state must remain fail-closed on both paths ────────────────────────

describe("GET /memories — block state stays fail-closed", () => {
  it("returns db_error rather than an unfiltered feed when the blocks lookup fails", async () => {
    const state = baseState();
    state.errorTables.add("blocks");
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, "/api/memories", "viewer-tok");
      assert.equal(status, 500);
    } finally { await app.close(); }
  });
});
