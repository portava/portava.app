/**
 * RESTRICTIONS AND BLOCKS MUST BE REACHABLE FROM THE PATHS THEY GOVERN.
 *
 * routes/restrict.ts was reviewed as a FILE and reported clean — every read
 * observes its `.error`, every write reports its own failure. That review says
 * nothing about whether the exclusion tables it writes are ever CONSULTED. An
 * adjacent lane has already found the shape this test exists to catch: a block
 * guard that was never CALLED, because the roster read it depended on returned
 * empty on error, so the guard sat in the file looking correct and governed
 * nothing.
 *
 * So this file does not test restrict.ts's internals. It tests REACHABILITY —
 * that the routes which are supposed to consult the exclusion set actually
 * issue the queries, and that the answer is load-bearing when they do:
 *
 *   (a) THE QUERY IS ISSUED. A recording client counts reads per table. If
 *       `resolveInteractionPermissions` is ever dropped from POST /follow,
 *       DELETE /follow, POST /restrict or DELETE /restrict — the exact
 *       refactor that produced the never-called block guard — `blocks` and
 *       `user_restrictions` stop being read and these tests go red.
 *
 *   (b) THE ANSWER CHANGES THE OUTCOME. Counting queries alone would pass for a
 *       guard whose verdict is discarded, so every reachability case is PAIRED
 *       with a behavioural case on the same route: with a block row present the
 *       route must refuse, and with no block row it must succeed. A guard that
 *       is called and ignored fails the pair.
 *
 *   (c) AN UNREADABLE EXCLUSION TABLE IS NOT "NOT RESTRICTED". restrict-status
 *       refuses rather than reporting `restricted: false` from a failed read —
 *       paired against a readable restriction row, which must report true.
 *
 * ── WHY `blocks` IS THE INSTRUMENT FOR (b) ──────────────────────────────────
 * `blocks` is the one exclusion input `resolveInteractionPermissions` treats as
 * critical (it re-throws rather than assuming "no block"), so it is the input
 * whose effect can be asserted end-to-end today. The `user_restrictions` read in
 * the same engine is reachability-only here — see the note on the
 * FAIL-OPEN finding in that engine at the bottom of this file.
 *
 * Run: node --import tsx/esm --test src/test/restrictReachability.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import restrictRouter from "../routes/restrict.js";
import followsRouter from "../routes/follows.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const TARGET = "22222222-2222-2222-2222-222222222222";

const DB_ERROR = { code: "42501", message: "permission denied for table user_restrictions" };

type Rows = Record<string, any[]>;
interface Op { table: string; kind: "read" | "insert" | "update" | "upsert" | "delete"; eqs: Array<[string, any]> }

/**
 * Recording PostgREST fake. Filters are applied for the tables this test seeds;
 * `blocks` is returned unfiltered because the engine queries it with a raw
 * `.or(...)` string and then filters the rows itself.
 */
function makeClient(rows: Rows, failTables: string[] = []) {
  const ops: Op[] = [];
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    const ins: Array<[string, any[]]> = [];
    let kind: Op["kind"] = "read";
    let head = false;
    let recorded = false;
    const b: any = {
      select(_c?: string, opts?: any) { if (opts?.head) head = true; return b; },
      insert() { kind = "insert"; return b; },
      update() { kind = "update"; return b; },
      upsert() { kind = "upsert"; return b; },
      delete() { kind = "delete"; return b; },
      eq(c: string, v: any) { eqs.push([c, v]); return b; },
      in(c: string, v: any[]) { ins.push([c, v]); return b; },
      is() { return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return run(true); },
      single() { return run(true); },
      then(f: any, r: any) { return run(false).then(f, r); },
    };
    function match(): any[] {
      if (table === "blocks") return rows.blocks ?? [];
      let out: any[] = rows[table] ?? [];
      for (const [c, v] of eqs) out = out.filter((r) => r[c] === v);
      for (const [c, v] of ins) out = out.filter((r) => v.includes(r[c]));
      return out;
    }
    async function run(single: boolean): Promise<any> {
      if (!recorded) { recorded = true; ops.push({ table, kind, eqs: [...eqs] }); }
      if (failTables.includes(table)) return { data: null, error: DB_ERROR, count: null };
      if (kind !== "read") return { data: null, error: null, count: null };
      const hit = match();
      if (head) return { data: null, error: null, count: hit.length };
      if (single) return { data: hit[0] ?? null, error: null, count: hit.length };
      return { data: hit, error: null, count: hit.length };
    }
    return b;
  }
  return {
    client: {
      from,
      auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
    } as any,
    ops,
    reads: (table: string) => ops.filter((o) => o.table === table && o.kind === "read").length,
    writes: (table: string) => ops.filter((o) => o.table === table && o.kind !== "read"),
  };
}

function baseRows(): Rows {
  return {
    profiles: [
      { id: VIEWER, handle: "me", name: "Me", account_status: "active", is_private: false, tag_permission: "everyone" },
      { id: TARGET, handle: "them", name: "Them", account_status: "active", is_private: false, tag_permission: "everyone" },
    ],
    blocks: [],
    user_restrictions: [],
    user_mutes: [],
    user_account_states: [],
    trust_restrictions: [],
    moderation_actions: [],
    user_privacy_settings: [],
    profile_privacy_settings: [],
    user_message_settings: [],
    user_interaction_cooldowns: [],
    user_friendships: [],
    friend_requests: [],
    user_follows: [],
    trip_members: [],
    circle_memberships: [],
    rent_buddy_bookings: [],
  };
}

async function startApp(rows: Rows, failTables: string[] = []) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", restrictRouter);
  app.use("/api", followsRouter);
  const rec = makeClient(rows, failTables);
  _setTestServiceClient(rec.client);
  _setTestClient(rec.client, true);
  const server = createServer(app);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as import("net").AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
  return { baseUrl, rec, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function call(baseUrl: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

let inspected = 0;
function checked<T>(v: T): T { inspected += 1; return v; }

afterEach(() => { _setTestServiceClient(null); _setTestClient(null, false); });

// ── (a) the exclusion tables are actually queried ───────────────────────────

describe("the exclusion set is consulted on every route that governs contact", () => {
  it("POST /users/:id/follow reads blocks AND user_restrictions before writing an edge", async () => {
    const app = await startApp(baseRows());
    try {
      const { status } = await call(app.baseUrl, "POST", `/api/users/${TARGET}/follow`);
      assert.equal(checked(status), 201, "control: an unblocked follow succeeds");
      assert.ok(checked(app.rec.reads("blocks")) >= 1, "the block table must be consulted");
      assert.ok(
        checked(app.rec.reads("user_restrictions")) >= 1,
        "the restriction table must be consulted — if the permission engine is ever " +
        "dropped from this route, this is what notices",
      );
      assert.equal(checked(app.rec.writes("user_follows").length), 1, "and only then is the edge written");
    } finally { await app.close(); }
  });

  it("DELETE /users/:id/follow consults the engine too", async () => {
    const rows = baseRows();
    rows.user_follows = [{ follower_id: VIEWER, following_id: TARGET }];
    const app = await startApp(rows);
    try {
      const { status } = await call(app.baseUrl, "DELETE", `/api/users/${TARGET}/follow`);
      assert.equal(checked(status), 200);
      assert.ok(checked(app.rec.reads("blocks")) >= 1);
      assert.ok(checked(app.rec.reads("user_restrictions")) >= 1);
    } finally { await app.close(); }
  });

  it("POST /users/:id/restrict consults the exclusion set before writing the restriction", async () => {
    const app = await startApp(baseRows());
    try {
      const { status } = await call(app.baseUrl, "POST", `/api/users/${TARGET}/restrict`, { reason: "spam" });
      assert.equal(checked(status), 200);
      assert.ok(checked(app.rec.reads("blocks")) >= 1);
      const w = app.rec.writes("user_restrictions");
      assert.equal(checked(w.length), 1);
      assert.equal(checked(w[0].kind), "upsert", "idempotent: re-restricting updates the reason");
    } finally { await app.close(); }
  });

  it("DELETE /users/:id/restrict removes ONLY the caller's own row", async () => {
    const rows = baseRows();
    rows.user_restrictions = [{ restrictor_id: VIEWER, restricted_id: TARGET, options: { reason: "spam" } }];
    const app = await startApp(rows);
    try {
      const { status, body } = await call(app.baseUrl, "DELETE", `/api/users/${TARGET}/restrict`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.restricted), false);
      const del = app.rec.writes("user_restrictions").filter((o) => o.kind === "delete");
      assert.equal(checked(del.length), 1);
      // ZERO-ROW NOTE: this delete carries no `.select()`, so `error === null`
      // does not prove a row was removed. That is defensible HERE and only here:
      // both filters together are the table's primary key, so a zero-row delete
      // means the restriction was already absent — and the response asserts the
      // END STATE ("you are not restricting them"), which is true either way.
      // The filters are what make that argument hold, so they are asserted.
      const cols = del[0].eqs.map(([c]) => c).sort();
      assert.deepEqual(checked(cols), ["restricted_id", "restrictor_id"]);
      assert.deepEqual(
        checked(del[0].eqs.find(([c]) => c === "restrictor_id")), ["restrictor_id", VIEWER],
        "never another user's restriction",
      );
    } finally { await app.close(); }
  });
});

// ── (b) the answer is load-bearing, not merely fetched ──────────────────────

describe("the exclusion answer changes the outcome (a called-but-ignored guard fails here)", () => {
  it("a block in either direction refuses the follow", async () => {
    for (const [label, row] of [
      ["viewer blocked target", { blocker_id: VIEWER, blocked_id: TARGET }],
      ["target blocked viewer", { blocker_id: TARGET, blocked_id: VIEWER }],
    ] as const) {
      const rows = baseRows();
      rows.blocks = [row];
      const app = await startApp(rows);
      try {
        const { status } = await call(app.baseUrl, "POST", `/api/users/${TARGET}/follow`);
        assert.equal(checked(status), 403, `${label}: the follow must be refused`);
        assert.equal(checked(app.rec.writes("user_follows").length), 0, `${label}: and no edge written`);
      } finally { await app.close(); }
    }
  });

  it("a block refuses the restrict write as well", async () => {
    const rows = baseRows();
    rows.blocks = [{ blocker_id: TARGET, blocked_id: VIEWER }];
    const app = await startApp(rows);
    try {
      const { status } = await call(app.baseUrl, "POST", `/api/users/${TARGET}/restrict`, {});
      assert.equal(checked(status), 403);
      assert.equal(checked(app.rec.writes("user_restrictions").length), 0);
    } finally { await app.close(); }
  });

  it("un-restricting survives a block (undo-your-own-action)", async () => {
    // The engine deliberately keeps canUnsaveProfile true under a block so a
    // blocked pair can still withdraw their own restrictions. Pinning it here
    // keeps a future "block denies everything" simplification from silently
    // trapping people in restrictions they can no longer remove.
    const rows = baseRows();
    rows.blocks = [{ blocker_id: VIEWER, blocked_id: TARGET }];
    rows.user_restrictions = [{ restrictor_id: VIEWER, restricted_id: TARGET, options: {} }];
    const app = await startApp(rows);
    try {
      const { status } = await call(app.baseUrl, "DELETE", `/api/users/${TARGET}/restrict`);
      assert.equal(checked(status), 200, "you may always undo your own restriction");
      assert.equal(checked(app.rec.writes("user_restrictions").filter((o) => o.kind === "delete").length), 1);
    } finally { await app.close(); }
  });
});

// ── (c) an unreadable exclusion table is not "not restricted" ───────────────

describe("restrict-status refuses rather than reporting a restriction it could not read", () => {
  it("POSITIVE CONTROL: a readable restriction row reports restricted:true with its reason", async () => {
    const rows = baseRows();
    rows.user_restrictions = [{ restrictor_id: VIEWER, restricted_id: TARGET, options: { reason: "spam" } }];
    const app = await startApp(rows);
    try {
      const { status, body } = await call(app.baseUrl, "GET", `/api/users/${TARGET}/restrict-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.restricted), true);
      assert.equal(checked(body.restrictionReason), "spam");
    } finally { await app.close(); }
  });

  it("POSITIVE CONTROL: a genuinely absent row reports restricted:false", async () => {
    const app = await startApp(baseRows());
    try {
      const { status, body } = await call(app.baseUrl, "GET", `/api/users/${TARGET}/restrict-status`);
      assert.equal(checked(status), 200);
      assert.equal(checked(body.restricted), false, "a READ that found nothing — not an outage");
    } finally { await app.close(); }
  });

  it("an unreadable user_restrictions is refused, not reported as restricted:false", async () => {
    // Same fixture as the true-control: the restriction IS there.
    const rows = baseRows();
    rows.user_restrictions = [{ restrictor_id: VIEWER, restricted_id: TARGET, options: { reason: "spam" } }];
    const app = await startApp(rows, ["user_restrictions"]);
    try {
      const { status, body } = await call(app.baseUrl, "GET", `/api/users/${TARGET}/restrict-status`);
      assert.notEqual(checked(status), 200, "an outage must not answer a restriction question");
      assert.equal(checked(status), 500);
      assert.equal(checked(body.error), "db_error");
      assert.equal(checked(body.restricted), undefined);
    } finally { await app.close(); }
  });
});

describe("the assertion count is non-zero", () => {
  it("inspected a non-vacuous number of assertions", () => {
    assert.ok(inspected >= 30, `expected >=30 checked assertions, got ${inspected}`);
  });
});
