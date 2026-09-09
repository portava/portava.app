/**
 * Highlights: a table that could not be read must not be reported as a person
 * with nothing to show, and a write that touched nothing must not report
 * success.
 *
 * FIVE DEFECTS, ONE FILE
 * ----------------------
 *
 * 1. GET /highlights/following-feed opened with
 *
 *      const { data: followRows } = await sc.from("user_follows")…
 *      const followingIds = (followRows ?? []).map(…)
 *      if (followingIds.length === 0) return res.json({ users: [] })
 *
 *    supabase-js RESOLVES on a database error, so an unreadable follow graph
 *    produced an empty list and the next line answered `{ users: [] }` — the
 *    entire feed reported as empty from a lookup that never happened. A sibling
 *    lane found the same shape in the Wall ("you're all caught up") and the
 *    passport ("zero stamps"). §28.11.
 *
 * 2. resolveViewAccess — the gate in front of view, like, unlike, reply and
 *    report — read the highlight itself with `const { data: h }` and answered
 *    "Highlight not found" for a `highlights` table outage. That is not a
 *    permission verdict, and saying so discloses nothing: we do not know
 *    whether the row exists.
 *
 * 3. DELETE /highlights/:id ran `UPDATE … SET deleted_at` with no `.select()`.
 *    An UPDATE without .select() returns `data: null`, so `error === null` meant
 *    only "the statement ran" — under the caller's own RLS an update matching
 *    ZERO rows errors nothing at all, and the owner was told 204 for a highlight
 *    still live on their profile.
 *
 * 4. POST /highlights/:id/like, DELETE …/like and POST …/report threw their
 *    write results away. Each is issued (the await sends it) but a resolved
 *    failure was invisible: a filled heart for a like the database never took,
 *    and a 204 "reported" for a report nobody received.
 *
 * 5. POST /highlights/:id/reply read message_thread_members with `?? []`. On an
 *    error that reads as "these two have never spoken", so the handler did not
 *    lose a message — it CREATED A SECOND DM THREAD between the same two people
 *    and split their conversation permanently, which no retry can undo.
 *
 * PAIRING (the false-green rule). A viewer who follows nobody and a viewer
 * whose follow graph is unreadable both yield an empty feed; a highlight that
 * does not exist and a highlights table that cannot be read both yield 404. So
 * every failure case below is paired with the SAME fixture read successfully.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/highlightsReadFailures.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";

const VIEWER = "10000000-0000-4000-8000-000000000001";
const OWNER  = "10000000-0000-4000-8000-000000000002";
const H_PUB  = "30000000-0000-4000-8000-000000000001"; // OWNER's public highlight
const H_MINE = "30000000-0000-4000-8000-000000000002"; // VIEWER's own highlight

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

const highlight = (id: string, owner_id: string, visibility = "public") => ({
  id, owner_id, visibility,
  media_url: "https://example.invalid/h.jpg", media_type: "image/jpeg",
  video_duration_seconds: null, caption: null,
  location_name: null, location_city: null, location_country: null,
  expires_at: FUTURE, created_at: "2026-01-01T00:00:00.000Z", deleted_at: null,
});

function fixtureTables(): Record<string, any[]> {
  return {
    profiles: [VIEWER, OWNER].map((id) => ({
      id, handle: `h_${id.slice(-2)}`, name: "n", avatar_url: null,
      account_status: "active", is_private: false,
    })),
    highlights: [highlight(H_PUB, OWNER), highlight(H_MINE, VIEWER)],
    user_follows: [{ follower_id: VIEWER, following_id: OWNER }],
    blocks: [], circle_memberships: [], trip_members: [], trips: [],
    feature_flags: [], highlight_views: [], highlight_likes: [],
    highlight_reports: [], highlight_replies: [],
    message_threads: [], message_thread_members: [], messages: [],
  };
}

/**
 * Filtering supabase-js stand-in. `failTables` makes reads of those tables
 * RESOLVE with an error — which is what supabase-js does; a fake that threw
 * would exercise a catch that does not exist in production. `zeroRowUpdate`
 * makes an UPDATE .select() come back empty while erroring nothing, which is
 * the shape an RLS-filtered update really has.
 */
function makeFakeClient(
  tables: Record<string, any[]>,
  opts: { failTables?: Set<string>; failWrites?: Set<string>; zeroRowUpdate?: Set<string> } = {},
) {
  const failTables = opts.failTables ?? new Set<string>();
  const failWrites = opts.failWrites ?? new Set<string>();
  const zeroRowUpdate = opts.zeroRowUpdate ?? new Set<string>();
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, isUpdate = false, selectedAfterWrite = false;
    let patch: any = null;
    const obj: any = {
      select(_c?: string, o?: any) {
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
      if (isWrite && failWrites.has(table)) return { data: null, error: { message: `${table} write failed` }, count: null };
      if (!isWrite && failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (isWrite && failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      if (obj.__insert || obj.__upsert) {
        const raw = obj.__insert ?? obj.__upsert;
        const rows = (Array.isArray(raw) ? raw : [raw]).map((r: any) => ({ ...r, id: r.id ?? `new-${Math.random().toString(16).slice(2)}` }));
        for (const r of rows) (tables[table] ??= []).push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (obj.__delete) {
        const ids = new Set(rows);
        tables[table] = (tables[table] ?? []).filter((r) => !ids.has(r));
        return { data: null, error: null, count: null };
      }
      if (isUpdate) {
        if (zeroRowUpdate.has(table)) rows = [];
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
};

async function startApp(opts: { failTables?: Set<string>; failWrites?: Set<string>; zeroRowUpdate?: Set<string> } = {}): Promise<App> {
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
  app.use("/api", highlightsRouter);
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
    body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

const feedIds = (body: any) =>
  new Set(((body?.users ?? []) as any[]).flatMap((u) => (u.highlights ?? []).map((h: any) => h.id as string)));

// ── 1. the following feed ────────────────────────────────────────────────────

describe("GET /highlights/following-feed: an unreadable follow graph is refused, not rendered as an empty feed", () => {
  it("PAIRED CONTROL — readable: the feed is served and is NOT empty", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 200);
      assert.ok(feedIds(r.body).has(H_PUB),
        `the control must return highlights or every failure case passes for free; got ${JSON.stringify(r.body)}`);
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — a viewer who genuinely follows nobody still gets { users: [] }", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", OWNER); // OWNER follows nobody
      assert.equal(r.status, 200);
      assert.deepEqual(r.body?.users, [],
        "an honestly empty follow list must keep its 200 — the fix must not turn 'none' into a refusal");
    } finally { await app.close(); }
  });

  it("an unreadable user_follows → 503 degraded_unavailable + retryable, never { users: [] }", async () => {
    const app = await startApp({ failTables: new Set(["user_follows"]) });
    try {
      const r = await call(app, "GET", "/api/highlights/following-feed", VIEWER);
      assert.equal(r.status, 503, `expected a refusal, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body?.error, "degraded_unavailable");
      assert.equal(r.body?.retryable, true);
      assert.equal(r.body?.users, undefined, "a refusal must not also ship an empty feed");
      assert.ok(app.errors.some((e) => /follow graph unreadable/.test(e.msg)),
        `the refusal must be logged; got ${JSON.stringify(app.errors.map((e) => e.msg))}`);
    } finally { await app.close(); }
  });
});

// ── 2. resolveViewAccess ─────────────────────────────────────────────────────

describe("resolveViewAccess: an unreadable highlights table is db_error, not 'not found'", () => {
  it("PAIRED CONTROL — readable table, real highlight: POST /view is 200", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/view`, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — readable table, highlight that does not exist: 404 not_found", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/30000000-0000-4000-8000-0000000000ff/view`, VIEWER);
      assert.equal(r.status, 404);
      assert.equal(r.body?.error, "not_found");
    } finally { await app.close(); }
  });

  it("an unreadable highlights table on POST /view: 500 db_error, and the outage is logged", async () => {
    const app = await startApp({ failTables: new Set(["highlights"]) });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/view`, VIEWER);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
      assert.ok(app.errors.some((e) => /highlight read failed/.test(e.msg)));
    } finally { await app.close(); }
  });

  it("GET /highlights/:id/viewers with an unreadable highlights table: db_error, not 'not found'", async () => {
    const app = await startApp({ failTables: new Set(["highlights"]) });
    try {
      const r = await call(app, "GET", `/api/highlights/${H_MINE}/viewers`, VIEWER);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
    } finally { await app.close(); }
  });
});

// ── 3. the delete that deleted nothing ───────────────────────────────────────

describe("DELETE /highlights/:id: a zero-row UPDATE is not a deletion", () => {
  it("PAIRED CONTROL — the update matches: 204 and deleted_at is set", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_MINE}`, VIEWER);
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.notEqual(app.tables.highlights.find((h) => h.id === H_MINE)?.deleted_at, null);
    } finally { await app.close(); }
  });

  it("an update that matches ZERO rows must NOT answer 204", async () => {
    const app = await startApp({ zeroRowUpdate: new Set(["highlights"]) });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_MINE}`, VIEWER);
      assert.notEqual(r.status, 204, "a highlight still live must not be reported as deleted");
      assert.equal(r.status, 500);
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.highlights.find((h) => h.id === H_MINE)?.deleted_at, null,
        "the fixture must really be untouched, or this passes for the wrong reason");
      assert.ok(app.errors.some((e) => /matched zero rows/.test(e.msg)));
    } finally { await app.close(); }
  });
});

// ── 4. engagement writes ─────────────────────────────────────────────────────

describe("highlight engagement writes: a discarded write result is a lie to the client", () => {
  it("PAIRED CONTROL — like succeeds: 200 likedByMe true and the row exists", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/like`, VIEWER);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body?.likedByMe, true);
      assert.equal(app.tables.highlight_likes.length, 1);
    } finally { await app.close(); }
  });

  it("a failed like write must not answer 200 { likedByMe: true }", async () => {
    const app = await startApp({ failWrites: new Set(["highlight_likes"]) });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/like`, VIEWER);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.highlight_likes.length, 0);
      assert.ok(app.errors.some((e) => /like write failed/.test(e.msg)));
    } finally { await app.close(); }
  });

  it("a failed unlike write must not answer 200 { likedByMe: false }", async () => {
    const app = await startApp({ failWrites: new Set(["highlight_likes"]) });
    try {
      const r = await call(app, "DELETE", `/api/highlights/${H_PUB}/like`, VIEWER);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
    } finally { await app.close(); }
  });

  it("PAIRED CONTROL — report succeeds: 204 and the report row exists", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/report`, VIEWER, { reason: "spam" });
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.equal(app.tables.highlight_reports.length, 1);
    } finally { await app.close(); }
  });

  it("a failed report write must NOT answer 204 — a report nobody receives is the worst silence here", async () => {
    const app = await startApp({ failWrites: new Set(["highlight_reports"]) });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/report`, VIEWER, { reason: "spam" });
      assert.notEqual(r.status, 204);
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body?.error, "db_error");
      assert.equal(app.tables.highlight_reports.length, 0);
      assert.ok(app.errors.some((e) => /report was NOT filed/.test(e.msg)));
    } finally { await app.close(); }
  });
});

// ── 5. the reply that forked a conversation ──────────────────────────────────

describe("POST /highlights/:id/reply: an unreadable thread list must not mint a duplicate DM thread", () => {
  it("PAIRED CONTROL — readable: one thread is created and the reply is sent", async () => {
    const app = await startApp();
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/reply`, VIEWER, { message: "nice" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(app.tables.message_threads.length, 1);
      assert.equal(app.tables.messages.filter((m) => m.msg_type === "text").length, 1);
    } finally { await app.close(); }
  });

  it("an unreadable message_thread_members refuses (503) and creates NO thread", async () => {
    const app = await startApp({ failTables: new Set(["message_thread_members"]) });
    try {
      const r = await call(app, "POST", `/api/highlights/${H_PUB}/reply`, VIEWER, { message: "nice" });
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body?.error, "degraded_unavailable");
      assert.equal(r.body?.retryable, true);
      assert.equal(app.tables.message_threads.length, 0,
        "a duplicate thread cannot be undone by retrying, so none may be created on an undecidable lookup");
      assert.ok(app.errors.some((e) => /duplicate DM thread/.test(e.msg)));
    } finally { await app.close(); }
  });
});
