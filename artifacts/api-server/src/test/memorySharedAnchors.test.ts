/**
 * memorySharedAnchors.test.ts — census-highlights-memories H53, §5 "Remember this
 * together" (B58 cluster MEM-ANCHOR-1, the server half; migration 3805).
 *
 * Drives the REAL router (routes/memorySharedAnchors.ts) over HTTP, with a
 * table-backed fake that records every read and write. The fake ports 3805's
 * SQL — memory_shared_anchor_invite, the members guard, the dissolution trigger,
 * the one-anchor-per-Memory index and the anchor → member cascade — so the API's
 * behaviour can be driven end to end; the SQL itself is executed by
 * src/test/db/memorySharedAnchors.db.test.ts (CI's local-db job) and the PGlite
 * rehearsal sql/rehearsals/3805_01_memory_shared_anchors.sql.
 *
 *   F  flag OFF or absent: every route answers exactly as an app WITHOUT the
 *      router does (status, type, body), reads nothing past the flag, writes nothing
 *   I  invite: a PENDING tag is 403; only an APPROVED tag on the host's own live
 *      Memory; blocks either way (and an unreadable or thrown block read) are the
 *      same 403; in-app notice only, never the push path
 *   S  the anchor is not shared until the second accept
 *   R  a member cannot read another member's only_me Memory through the anchor
 *   L  after B leaves, B sees nothing; the host leaving or a last decline erases it
 *   K  a block between A and C removes each from the other's view
 *   A  accept / decline: own live Memory only, one anchor per Memory, hidden
 *      invitations cannot be accepted, every exit always works
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memorySharedAnchors.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import memorySharedAnchorsRouter from "../routes/memorySharedAnchors.js";
import apiRouter from "../routes/index.js";
import { blocksAmong, MEMORY_SHARED_ANCHORS_FLAG } from "../services/memory/memorySharedAnchors.js";

const H = "a5000000-0000-4000-8000-000000000001"; // the host: owns MH (only_me); B and C approved tags, D a pending one
const B = "a5000000-0000-4000-8000-000000000002"; // owns MB (only_me)
const C = "a5000000-0000-4000-8000-000000000003"; // owns MC (public)
const D = "a5000000-0000-4000-8000-000000000004"; // PENDING tag on MH
const E = "a5000000-0000-4000-8000-000000000005"; // no tag at all
const X = "a5000000-0000-4000-8000-000000000006"; // owns MX; approved tag on MB

const MH = "b5000000-0000-4000-8000-0000000000a1";
const MH_DELETED = "b5000000-0000-4000-8000-0000000000a2";
const MB = "b5000000-0000-4000-8000-0000000000b1";
const MC = "b5000000-0000-4000-8000-0000000000c1";
const MX = "b5000000-0000-4000-8000-0000000000d1";
const MISSING = "b5000000-0000-4000-8000-0000000000ff";

function memory(id: string, owner: string, visibility: string, state = "published") {
  return { id, owner_id: owner, title: id, visibility, state, allowed_user_ids: [], hidden_user_ids: [], trip_id: null };
}

interface World {
  flag: "absent" | "off" | "on" | "unreadable";
  failReads?: Set<string>;
  failWrites?: Set<string>;
  throwOn?: Set<string>;
}

function seed(w: World): Record<string, any[]> {
  return {
    feature_flags: w.flag === "absent" || w.flag === "unreadable" ? [] : [{ flag: MEMORY_SHARED_ANCHORS_FLAG, enabled: w.flag === "on" }],
    profiles: [H, B, C, D, E, X].map((id, i) => ({ id, handle: `user${i + 1}`, name: `User ${i + 1}`, account_status: "active" })),
    memories: [
      memory(MH, H, "only_me"), memory(MH_DELETED, H, "public", "deleted"), memory(MB, B, "only_me"),
      memory(MC, C, "public"), memory(MX, X, "public"),
    ],
    memory_tags: [
      { memory_id: MH, tagged_user_id: B, status: "approved" },
      { memory_id: MH, tagged_user_id: C, status: "approved" },
      { memory_id: MH, tagged_user_id: D, status: "pending" },
      { memory_id: MH_DELETED, tagged_user_id: B, status: "approved" },
      { memory_id: MB, tagged_user_id: X, status: "approved" },
      { memory_id: MX, tagged_user_id: B, status: "approved" },
    ],
    blocks: [], user_follows: [], circle_memberships: [], trip_members: [], trips: [],
    memory_shared_anchors: [], memory_shared_anchor_members: [], notifications: [],
  };
}

interface Op { table: string; mode: string; cols?: string; payload?: any }

/** 3805, ported: the guard (transitions, a member's OWN live Memory, a link only while accepted, one anchor per Memory). */
function guard(store: Record<string, any[]>, prev: any, next: any): { code: string; message: string } | null {
  const ok = (prev.status === next.status)
    || (prev.status === "invited" && (next.status === "accepted" || next.status === "declined"))
    || (prev.status === "accepted" && next.status === "left");
  if (!ok || next.anchor_id !== prev.anchor_id || next.user_id !== prev.user_id) return { code: "23514", message: "transition" };
  if (next.memory_id != null && next.status !== "accepted") return { code: "23514", message: "memory_while_accepted" };
  if (next.status === "accepted" && !next.consented_at) return { code: "23514", message: "consent_stamped" };
  if (next.memory_id != null && next.memory_id !== prev.memory_id) {
    const m = store.memories.find((r) => r.id === next.memory_id);
    if (!m || m.owner_id !== next.user_id || m.state === "deleted" || m.state === "removed") return { code: "23514", message: "own live Memory" };
    if (store.memory_shared_anchor_members.some((r) => r !== prev && r.memory_id === next.memory_id)) return { code: "23505", message: "memory_shared_anchor_members_memory_once" };
  }
  return null;
}

/** 3805's memory_shared_anchor_dissolve, ported. */
function dissolve(store: Record<string, any[]>, anchorId: string): void {
  const anchor = store.memory_shared_anchors.find((a) => a.id === anchorId);
  if (!anchor) return;
  const rows = store.memory_shared_anchor_members.filter((r) => r.anchor_id === anchorId);
  const hostAccepted = rows.some((r) => r.user_id === anchor.created_by && r.status === "accepted");
  const live = rows.filter((r) => r.status === "invited" || r.status === "accepted").length;
  if (!hostAccepted || live < 2) {
    store.memory_shared_anchors = store.memory_shared_anchors.filter((a) => a.id !== anchorId);
    store.memory_shared_anchor_members = store.memory_shared_anchor_members.filter((r) => r.anchor_id !== anchorId);
  }
}

function makeDb(store: Record<string, any[]>, ops: Op[], w: World) {
  let idN = 0;
  function chain(table: string) {
    if (w.throwOn?.has(table)) throw new Error(`${table}: the client was torn down`);
    const filters: Array<(r: any) => boolean> = [];
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null; let wantRows = false; let single = false; let limitN: number | null = null;
    let selected: string[] | null = null; let selectText = ""; const orders: Array<[string, boolean]> = [];
    const f = (p: (r: any) => boolean) => { filters.push(p); return obj; };
    const obj: any = {
      select(c?: string) {
        if (mode !== "select") wantRows = true;
        if (typeof c === "string") { selectText = c; if (mode === "select") selected = c.split(",").map((k) => k.trim()).filter((k) => k && !k.includes("(") && !k.includes("!")); }
        return obj;
      },
      insert(d: any) { mode = "insert"; payload = d; return obj; },
      update(d: any) { mode = "update"; payload = d; return obj; },
      delete() { mode = "delete"; return obj; },
      eq: (c: string, v: any) => f((r) => r[c] === v),
      neq: (c: string, v: any) => f((r) => r[c] !== v),
      in: (c: string, vs: any[]) => f((r) => vs.includes(r[c])),
      is: (c: string, v: any) => f((r) => (v === null ? r[c] == null : r[c] === v)),
      gt: (c: string, v: any) => f((r) => String(r[c] ?? "") > String(v)),
      or() { throw new Error("this fake does not model or()"); },
      order(c: string, o?: any) { orders.push([c, o?.ascending !== false]); return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(ok: any, bad: any) { return run().then(ok, bad); },
    };
    async function run(): Promise<any> {
      ops.push({ table, mode, cols: selectText, payload });
      if (mode === "select" && (w.failReads?.has(table) || (table === "feature_flags" && w.flag === "unreadable"))) {
        return { data: null, error: { code: "57014", message: `${table} read failed` }, count: null };
      }
      if (mode !== "select" && w.failWrites?.has(table)) return { data: null, error: { code: "57014", message: `${table} write failed` } };
      const all = (store[table] ??= []);
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ id: `ins-${++idN}`, created_at: new Date().toISOString(), ...r }));
        all.push(...rows);
        if (single) return { data: rows[0], error: null };
        return { data: wantRows ? rows : null, error: null };
      }
      let matched = all.filter((r) => filters.every((p) => p(r)));
      if (mode === "update") {
        const touched = new Set<string>();
        for (const r of matched) {
          const next = { ...r, ...payload };
          if (table === "memory_shared_anchor_members") {
            const bad = guard(store, r, next);
            if (bad) return { data: null, error: bad };
            if (next.status !== r.status) touched.add(r.anchor_id);
          }
          Object.assign(r, next);
        }
        const out = matched.map((x) => ({ ...x }));
        for (const a of touched) dissolve(store, a);
        return { data: wantRows ? out : null, error: null };
      }
      if (mode === "delete") {
        store[table] = all.filter((r) => !matched.includes(r));
        if (table === "memory_shared_anchors") {
          const gone = new Set(matched.map((r) => r.id));
          store.memory_shared_anchor_members = store.memory_shared_anchor_members.filter((r) => !gone.has(r.anchor_id));
        }
        if (table === "memory_shared_anchor_members") for (const a of new Set(matched.map((r) => r.anchor_id))) dissolve(store, a);
        return { data: wantRows ? matched : null, error: null };
      }
      if (orders.length > 0) matched = [...matched].sort((x, y) => { for (const [c, asc] of orders) { const d = String(x[c] ?? "").localeCompare(String(y[c] ?? "")); if (d !== 0) return asc ? d : -d; } return 0; });
      if (limitN != null) matched = matched.slice(0, limitN);
      const project = (x: any) => (selected && selected.length > 0 && !selected.includes("*") ? Object.fromEntries(selected.filter((k) => k in x).map((k) => [k, x[k]])) : { ...x });
      if (single) {
        if (matched.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: matched[0] ? project(matched[0]) : null, error: null };
      }
      return { data: matched.map(project), error: null };
    }
    return obj;
  }

  /** 3805's memory_shared_anchor_invite, ported. */
  async function rpc(fn: string, args: any) {
    ops.push({ table: `rpc:${fn}`, mode: "rpc", payload: args });
    if (fn !== "memory_shared_anchor_invite") return { data: null, error: { code: "PGRST202", message: `${fn} not modelled` } };
    if (w.failWrites?.has("memory_shared_anchor_members")) return { data: null, error: { code: "57014", message: "invite failed" } };
    const { p_memory_id: m, p_inviter_id: host, p_invitee_id: who } = args;
    const mem = store.memories.find((r) => r.id === m);
    if (!mem || mem.state === "deleted" || mem.state === "removed" || mem.owner_id !== host) return { data: { outcome: "not_found" }, error: null };
    if (who === host || !store.memory_tags.some((t) => t.memory_id === m && t.tagged_user_id === who && t.status === "approved")) {
      return { data: { outcome: "not_invitable" }, error: null };
    }
    const link = store.memory_shared_anchor_members.find((r) => r.memory_id === m && r.status === "accepted");
    let anchorId: string; let created = false;
    if (link) {
      const anchor = store.memory_shared_anchors.find((a) => a.id === link.anchor_id)!;
      if (anchor.created_by !== host) return { data: { outcome: "not_host" }, error: null };
      anchorId = anchor.id;
    } else {
      anchorId = `c5000000-0000-4000-8000-${String(++idN).padStart(12, "0")}`;
      store.memory_shared_anchors.push({ id: anchorId, created_by: host, created_at: new Date().toISOString() });
      store.memory_shared_anchor_members.push({ anchor_id: anchorId, user_id: host, memory_id: m, status: "accepted", invited_at: new Date(Date.now() - 1000).toISOString(), consented_at: new Date().toISOString(), left_at: null });
      created = true;
    }
    if (store.memory_shared_anchor_members.some((r) => r.anchor_id === anchorId && r.user_id === who)) return { data: { outcome: "already_invited", anchor_id: anchorId }, error: null };
    store.memory_shared_anchor_members.push({ anchor_id: anchorId, user_id: who, memory_id: null, status: "invited", invited_at: new Date().toISOString(), consented_at: null, left_at: null });
    return { data: { outcome: "invited", anchor_id: anchorId, created }, error: null };
  }

  return {
    from: (t: string) => chain(t),
    rpc,
    auth: { getUser: async (token: string) => ({ data: { user: { id: token, app_metadata: {} } }, error: null }) },
  };
}

interface App { base: string; store: Record<string, any[]>; ops: Op[]; w: World; close: () => Promise<void> }
const open: App[] = [];

async function start(w: World, opts: { mounted?: boolean | "api"; mutate?: (s: Record<string, any[]>) => void } = {}): Promise<App> {
  const store = seed(w);
  opts.mutate?.(store);
  const ops: Op[] = [];
  _setTestClient(makeDb(store, ops, w) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  if (opts.mounted === "api") app.use("/api", apiRouter);
  else if (opts.mounted !== false) app.use("/api", memorySharedAnchorsRouter);
  const srv = http.createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const { port } = srv.address() as { port: number };
  const a: App = { base: `http://127.0.0.1:${port}`, store, ops, w, close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
  open.push(a);
  return a;
}
afterEach(async () => { while (open.length) await open.pop()!.close(); _resetRateLimit("memory_shared_anchor_invite"); });

async function call(a: App, method: string, p: string, actor: string | null, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (actor) headers.Authorization = `Bearer ${actor}`;
  const res = await fetch(`${a.base}/api${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: any = text; try { parsed = text ? JSON.parse(text) : null; } catch { /* the default 404 page is HTML */ }
  return { status: res.status, type: res.headers.get("content-type"), body: parsed };
}

const invite = (a: App, memoryId: string, userId: string, actor = H) => call(a, "POST", `/memories/${memoryId}/shared-anchor/invites`, actor, { userId });
const view = (a: App, anchorId: string, actor: string) => call(a, "GET", `/memory-shared-anchors/${anchorId}`, actor);
const list = (a: App, actor: string) => call(a, "GET", "/me/memory-shared-anchors", actor);
const accept = (a: App, anchorId: string, actor: string, memoryId?: string | null) => call(a, "POST", `/memory-shared-anchors/${anchorId}/accept`, actor, memoryId === undefined ? {} : { memoryId });
const decline = (a: App, anchorId: string, actor: string) => call(a, "POST", `/memory-shared-anchors/${anchorId}/decline`, actor, {});
const leave = (a: App, anchorId: string, actor: string) => call(a, "POST", `/memory-shared-anchors/${anchorId}/leave`, actor, {});
const writes = (a: App) => a.ops.filter((o) => o.mode !== "select");
const memberIds = (v: any) => (v.members as any[]).map((m) => m.userId).sort();
const member = (v: any, id: string) => (v.members as any[]).find((m) => m.userId === id);

/** H invites B and C; both accept (B linking MB, C linking MC). */
async function threeAccepted(a: App): Promise<string> {
  const r1 = await invite(a, MH, B); assert.equal(r1.status, 201);
  const anchorId = r1.body.anchorId as string;
  assert.equal((await invite(a, MH, C)).status, 201);
  assert.equal((await accept(a, anchorId, B, MB)).status, 200);
  assert.equal((await accept(a, anchorId, C, MC)).status, 200);
  return anchorId;
}

// ─────────────────────────────────────────────────────────────────────────────

const ROUTES: Array<[string, string, unknown]> = [
  ["POST", `/memories/${MH}/shared-anchor/invites`, { userId: B }],
  ["GET", "/me/memory-shared-anchors", undefined],
  ["GET", "/memory-shared-anchors/c5000000-0000-4000-8000-000000000001", undefined],
  ["POST", "/memory-shared-anchors/c5000000-0000-4000-8000-000000000001/accept", { memoryId: MB }],
  ["POST", "/memory-shared-anchors/c5000000-0000-4000-8000-000000000001/decline", {}],
  ["POST", "/memory-shared-anchors/c5000000-0000-4000-8000-000000000001/leave", {}],
];

describe("F: flag OFF or absent — every route answers as if the feature does not exist, and nothing is written", () => {
  for (const flag of ["absent", "off"] as const) {
    it(`flag ${flag}: each of the six routes is indistinguishable from an app without the router, signed in or not, and reads nothing past the flag`, async () => {
      const without = await start({ flag }, { mounted: false }); // started first: the last start() owns the test client
      const withRouter = await start({ flag });
      for (const [method, p, body] of ROUTES) {
        for (const actor of [H, null]) {
          withRouter.ops.length = 0;
          const got = await call(withRouter, method, p, actor, body);
          const expected = await call(without, method, p, actor, body);
          assert.deepEqual(got, expected, `${method} ${p} (${actor ? "signed in" : "anonymous"}) differs from no router`);
          assert.equal(got.status, 404);
          assert.deepEqual(withRouter.ops.map((o) => `${o.mode}:${o.table}`), ["select:feature_flags"], `${method} ${p} read past the flag`);
        }
      }
      assert.equal(withRouter.store.memory_shared_anchors.length, 0);
      assert.equal(withRouter.store.memory_shared_anchor_members.length, 0);
      assert.equal(withRouter.store.notifications.length, 0);
    });
  }

  it("an unreadable flag is a 503, never 'does not exist', and nothing past it is read", async () => {
    const a = await start({ flag: "unreadable" });
    for (const [method, p, body] of ROUTES) {
      a.ops.length = 0;
      const r = await call(a, method, p, H, body);
      assert.equal(r.status, 503, `${method} ${p}`);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.deepEqual(a.ops.map((o) => o.table), ["feature_flags"]);
    }
  });

  it("flag ON: the routes exist (control for the cases above)", async () => {
    const a = await start({ flag: "on" });
    assert.equal((await list(a, H)).status, 200);
    assert.equal((await call(a, "GET", "/me/memory-shared-anchors", null)).status, 401);
  });
});

describe("M: mounted on the real API router (routes/index.ts), and nothing mounted before it answers these paths", () => {
  it("flag ON: the list, an anchor view and an invitation answer through the full router exactly as through this one", async () => {
    const a = await start({ flag: "on" }, { mounted: "api" });
    assert.deepEqual((await list(a, H)).body, { anchors: [] });
    const r = await invite(a, MH, B);
    assert.equal(r.status, 201);
    assert.equal((await view(a, r.body.anchorId, H)).body.anchor.yourStatus, "accepted");
    assert.equal((await accept(a, r.body.anchorId, B)).status, 200);
  });
});

describe("I: who may be invited (Q-H53-1: an APPROVED tag on the host's own live Memory, nobody blocked)", () => {
  it("a PENDING-tag invitee is 403, and nothing is written", async () => {
    const a = await start({ flag: "on" });
    const r = await invite(a, MH, D);
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "not_invitable");
    assert.deepEqual(writes(a), []);
    assert.equal(a.store.memory_shared_anchors.length, 0);
  });

  it("no tag, the host themself: the same 403; another person's Memory, a deleted one, a missing one: 404", async () => {
    const a = await start({ flag: "on" });
    const pending = await invite(a, MH, D);
    for (const who of [E, H]) assert.deepEqual(await invite(a, MH, who), pending);
    assert.equal((await invite(a, MH, B, C)).status, 404, "C does not own MH");
    assert.equal((await invite(a, MH_DELETED, B)).status, 404, "a deleted Memory starts nothing");
    assert.equal((await invite(a, MISSING, B)).status, 404);
    assert.equal((await invite(a, MH, "not-a-uuid")).status, 400);
    assert.deepEqual(writes(a), []);
  });

  it("a block in EITHER direction is the same 403 as a pending tag — and so is an unreadable or a THROWN block read", async () => {
    const pendingBody = (await invite(await start({ flag: "on" }), MH, D)).body;
    for (const mutate of [
      (s: Record<string, any[]>) => s.blocks.push({ blocker_id: H, blocked_id: B }),
      (s: Record<string, any[]>) => s.blocks.push({ blocker_id: B, blocked_id: H }),
    ]) {
      const a = await start({ flag: "on" }, { mutate });
      const r = await invite(a, MH, B);
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, pendingBody);
      assert.deepEqual(writes(a), []);
    }
    for (const w of [{ flag: "on" as const, failReads: new Set(["blocks"]) }, { flag: "on" as const, throwOn: new Set(["blocks"]) }]) {
      const a = await start(w);
      const r = await invite(a, MH, B);
      assert.equal(r.status, 403, "an unreadable block read is a block");
      assert.deepEqual(r.body, pendingBody);
      assert.deepEqual(writes(a), []);
    }
  });

  it("an approved tag, nobody blocked: 201 — the anchor exists with the host accepted (MH linked) and B invited (nothing linked)", async () => {
    const a = await start({ flag: "on" });
    const r = await invite(a, MH, B);
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.invitee, { userId: B, status: "invited" });
    const rows = a.store.memory_shared_anchor_members;
    assert.deepEqual(rows.map((m) => [m.user_id, m.status, m.memory_id]).sort(), [[H, "accepted", MH], [B, "invited", null]].sort());
    assert.equal(a.store.memory_shared_anchors[0].created_by, H);
    assert.equal(a.ops.filter((o) => o.mode === "rpc").length, 1);
  });

  it("Q-H53-2: the invitee is told IN-APP only — one notifications row, and the push path (devices, tokens, delivery attempts) is never touched", async () => {
    const a = await start({ flag: "on" });
    const r = await invite(a, MH, B);
    const notes = a.store.notifications;
    assert.equal(notes.length, 1);
    assert.equal(notes[0].user_id, B);
    assert.equal(notes[0].event_type, "memory.shared_anchor_invited");
    assert.equal(notes[0].category, "trips");
    assert.deepEqual(notes[0].metadata, { anchorId: r.body.anchorId });
    assert.match(notes[0].body, /^@user1 invited you/);
    assert.ok(!a.ops.some((o) => o.table === "notification_devices" || o.table === "notification_delivery_attempts"));
    assert.ok(!a.ops.some((o) => /expo_push_token/.test(o.cols ?? "")));
  });

  it("a repeat invitation is 409 and sends nothing more; a failed notice does not undo the invitation", async () => {
    const a = await start({ flag: "on" });
    await invite(a, MH, B);
    const again = await invite(a, MH, B);
    assert.equal(again.status, 409);
    assert.equal(again.body.reason, "already_invited");
    assert.equal(a.store.notifications.length, 1);
    const b = await start({ flag: "on", failWrites: new Set(["notifications"]) });
    assert.equal((await invite(b, MH, B)).status, 201);
    assert.equal(b.store.memory_shared_anchor_members.length, 2);
  });

  it("only the host invites: a member cannot invite into it from their own linked Memory (409 not_host)", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    await accept(a, anchorId, B, MB);
    const r = await invite(a, MB, X, B);
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, "not_host");
    assert.equal(a.store.memory_shared_anchors.length, 1);
  });
});

describe("S: an explicitly shared object only after participant consent", () => {
  it("not shared until the second accept: the host alone sees only themself; the invitee sees only who asked", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    await invite(a, MH, C);
    const host = await view(a, anchorId, H);
    assert.equal(host.status, 200);
    assert.equal(host.body.anchor.shared, false);
    assert.deepEqual(memberIds(host.body.anchor), [H], "an invitation is not a member");
    const inv = await view(a, anchorId, B);
    assert.equal(inv.body.anchor.yourStatus, "invited");
    assert.equal(inv.body.anchor.invitedBy.userId, H);
    assert.equal(inv.body.anchor.memoryId, null, "MH is only_me: the invitation does not open it");
    assert.equal(inv.body.anchor.members, undefined, "an invitee is shown no members");
    assert.equal((await accept(a, anchorId, B)).status, 200);
    const after = await view(a, anchorId, H);
    assert.equal(after.body.anchor.shared, true);
    assert.deepEqual(memberIds(after.body.anchor), [H, B].sort());
    assert.ok(!memberIds(after.body.anchor).includes(C), "C, still only invited, is not shown");
  });
});

describe("R: the anchor adds NO read grant", () => {
  it("member B cannot read the host's only_me Memory through the anchor; a public one is linked; each sees their own", async () => {
    const a = await start({ flag: "on" });
    const anchorId = await threeAccepted(a);
    const asB = (await view(a, anchorId, B)).body.anchor;
    assert.equal(member(asB, H).memoryId, null, "MH is only_me");
    assert.equal(member(asB, C).memoryId, MC, "MC is public: the ladder admits B");
    assert.equal(member(asB, B).memoryId, MB, "B's own");
    const asC = (await view(a, anchorId, C)).body.anchor;
    assert.equal(member(asC, B).memoryId, null, "MB is only_me");
    const asH = (await view(a, anchorId, H)).body.anchor;
    assert.equal(member(asH, H).memoryId, MH);
    assert.equal(member(asH, B).memoryId, null);
    assert.ok(!JSON.stringify(asB).includes(MH) && !JSON.stringify(asC).includes(MB));
  });

  it("an unreadable Memory read withholds every link, never the membership", async () => {
    const a = await start({ flag: "on" });
    const anchorId = await threeAccepted(a);
    a.w.failReads = new Set(["memories"]);
    const asB = (await view(a, anchorId, B)).body.anchor;
    assert.deepEqual(memberIds(asB), [H, B, C].sort());
    assert.ok((asB.members as any[]).every((m) => m.memoryId === null));
  });
});

describe("L: leave at any time; after B leaves, B sees nothing; dissolution erases", () => {
  it("after B leaves, B sees nothing — not the anchor, not the list — and the others no longer see B", async () => {
    const a = await start({ flag: "on" });
    const anchorId = await threeAccepted(a);
    const r = await leave(a, anchorId, B);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { anchorId, status: "left" });
    assert.equal((await view(a, anchorId, B)).status, 404);
    assert.deepEqual((await list(a, B)).body, { anchors: [] });
    assert.equal((await leave(a, anchorId, B)).status, 404, "leaving twice is the same 404 as never having been there");
    const asH = (await view(a, anchorId, H)).body.anchor;
    assert.deepEqual(memberIds(asH), [H, C].sort());
    const row = a.store.memory_shared_anchor_members.find((m) => m.user_id === B)!;
    assert.equal(row.status, "left");
    assert.equal(row.memory_id, null, "B's Memory is unlinked in the same write");
    assert.ok(row.left_at);
  });

  it("the last other member leaving, the host leaving, or a lone decline erases the anchor and every row", async () => {
    const a = await start({ flag: "on" });
    const one = (await invite(a, MH, B)).body.anchorId;
    await accept(a, one, B);
    await leave(a, one, B);
    assert.equal(a.store.memory_shared_anchors.length, 0);
    assert.equal(a.store.memory_shared_anchor_members.length, 0);
    assert.equal((await view(a, one, H)).status, 404);

    const two = await threeAccepted(a);
    assert.equal((await leave(a, two, H)).status, 200);
    assert.equal(a.store.memory_shared_anchors.length, 0, "the host left: dissolved");
    assert.equal((await view(a, two, B)).status, 404);

    const three = (await invite(a, MH, B)).body.anchorId;
    assert.equal((await decline(a, three, B)).status, 200);
    assert.equal(a.store.memory_shared_anchor_members.length, 0, "a lone declined invitation leaves nothing");
  });
});

describe("K: a block between A and C removes each from the other's view", () => {
  for (const [blocker, blocked] of [[H, C], [C, H]] as const) {
    it(`${blocker === H ? "H blocks C" : "C blocks H"}: H and C each lose the other; B, blocked with nobody, still sees both`, async () => {
      const a = await start({ flag: "on" });
      const anchorId = await threeAccepted(a);
      a.store.blocks.push({ blocker_id: blocker, blocked_id: blocked });
      assert.deepEqual(memberIds((await view(a, anchorId, H)).body.anchor), [H, B].sort());
      assert.deepEqual(memberIds((await view(a, anchorId, C)).body.anchor), [C, B].sort());
      assert.deepEqual(memberIds((await view(a, anchorId, B)).body.anchor), [H, B, C].sort());
      const listed = (await list(a, H)).body.anchors[0];
      assert.deepEqual(memberIds(listed), [H, B].sort());
      assert.ok(!JSON.stringify((await view(a, anchorId, H)).body).includes(C));
    });
  }

  it("an unreadable or thrown block read is a 503 for a roster, never a roster without the blocked", async () => {
    const a = await start({ flag: "on" });
    const anchorId = await threeAccepted(a);
    a.w.failReads = new Set(["blocks"]);
    assert.equal((await view(a, anchorId, H)).status, 503);
    assert.equal((await list(a, H)).status, 503);
    a.w.failReads = undefined; a.w.throwOn = new Set(["blocks"]);
    assert.equal((await view(a, anchorId, H)).status, 503);
  });

  it("an invitation from a host the invitee is blocked with is hidden and cannot be accepted; declining still works", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    await invite(a, MH, C);
    a.store.blocks.push({ blocker_id: B, blocked_id: H });
    assert.equal((await view(a, anchorId, B)).status, 404);
    assert.deepEqual((await list(a, B)).body, { anchors: [] });
    assert.equal((await accept(a, anchorId, B)).status, 404);
    assert.equal(a.store.memory_shared_anchor_members.find((m) => m.user_id === B)!.status, "invited");
    assert.equal((await decline(a, anchorId, B)).status, 200, "an exit always works");
    a.store.blocks.length = 0;
    a.w.throwOn = new Set(["blocks"]);
    assert.equal((await accept(a, anchorId, C)).status, 404, "an unreadable block read hides the invitation too");
    assert.equal((await view(a, anchorId, C)).status, 503, "and the invitation is not shown: nothing about the host is served");
    assert.equal((await list(a, C)).status, 503);
  });
});

describe("A: accept and decline", () => {
  it("accept links only the caller's OWN live Memory; a Memory belongs to one anchor; accepted twice is 404", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    assert.equal((await accept(a, anchorId, B, MC)).status, 404, "MC is C's");
    assert.equal((await accept(a, anchorId, B, MH_DELETED)).status, 404);
    assert.equal((await accept(a, anchorId, B, "nope")).status, 400);
    assert.equal(a.store.memory_shared_anchor_members.find((m) => m.user_id === B)!.status, "invited");
    assert.equal(a.ops.filter((o) => o.mode === "update").length, 0, "the API refused before writing: the database guard is a second line, not the first");
    const ok = await accept(a, anchorId, B, MB);
    assert.deepEqual(ok.body, { anchorId, status: "accepted", memoryId: MB });
    const row = a.store.memory_shared_anchor_members.find((m) => m.user_id === B)!;
    assert.ok(row.consented_at, "consent is stamped");
    assert.equal((await accept(a, anchorId, B, MB)).status, 404);
    assert.equal((await decline(a, anchorId, B)).status, 404, "an accepted member leaves; declining is for an open invitation");
    assert.equal(a.store.memory_shared_anchor_members.find((m) => m.user_id === B)!.status, "accepted");

    const other = (await invite(a, MX, B, X)).body.anchorId;
    const dup = await accept(a, other, B, MB);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.reason, "memory_already_linked");
  });

  it("someone never invited cannot accept, decline, leave or see it", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    for (const r of [await accept(a, anchorId, E), await decline(a, anchorId, E), await leave(a, anchorId, E), await view(a, anchorId, E)]) {
      assert.equal(r.status, 404);
    }
    assert.equal((await leave(a, anchorId, B)).status, 404, "an invitee has not accepted, so there is nothing to leave");
  });

  it("an unreadable membership read is a 503, never 'not found'", async () => {
    const a = await start({ flag: "on" });
    const anchorId = (await invite(a, MH, B)).body.anchorId;
    a.w.failReads = new Set(["memory_shared_anchor_members"]);
    assert.equal((await view(a, anchorId, B)).status, 503);
    assert.equal((await accept(a, anchorId, B)).status, 503);
    assert.equal((await list(a, B)).status, 503);
  });
});

describe("blocksAmong (the shared reader, read fail-closed)", () => {
  it("a thrown read and an unreadable one are ok:false; nobody to ask is an empty answer without a read", async () => {
    const store = seed({ flag: "on" }); const ops: Op[] = [];
    assert.deepEqual(await blocksAmong(makeDb(store, ops, { flag: "on" }), H, [H]), { ok: true, blocked: new Set() });
    assert.equal(ops.length, 0);
    assert.equal((await blocksAmong(makeDb(store, ops, { flag: "on", throwOn: new Set(["blocks"]) }), H, [B])).ok, false);
    assert.equal((await blocksAmong(makeDb(store, ops, { flag: "on", failReads: new Set(["blocks"]) }), H, [B])).ok, false);
    store.blocks.push({ blocker_id: B, blocked_id: H });
    const r = await blocksAmong(makeDb(store, ops, { flag: "on" }), H, [B, C]);
    assert.ok(r.ok && r.blocked.has(B) && !r.blocked.has(C));
  });
});
