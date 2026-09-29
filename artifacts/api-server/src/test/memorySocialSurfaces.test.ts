/**
 * Testing-mode lane WP-06 — the Memory social surfaces the client now reaches.
 *
 * Flows HM-F12 (a tagged person reaches the approval) and HM-F13 (a saved
 * Memory can be found again).
 *
 * 1. `notifyTagged` wrote an in-app notification with NO `action_url`, and a
 *    push whose `data` carried only `{screen: "memory", memoryId}` — a shape the
 *    client's push router does not route. The tagged person was told "Tap to
 *    approve or remove the tag" and the tap went nowhere. The notification now
 *    carries `/memory/<id>`, the screen that hosts the approval.
 *
 * 2. `POST /memories/:id/save` wrote `memory_saves` and nothing read it back as
 *    a list, so "save to your collection" was a write with no collection. `GET
 *    /me/saved-memories` is that list. It re-runs §23's `canReadMemory` and the
 *    block check per row at READ time, so a save does not outlive the owner
 *    narrowing the audience or a block; and an unreadable `memory_saves` is a
 *    503, never an empty shelf (DV-83).
 *
 * RED BEFORE GREEN: at 18518e982 the notification row has no `action_url`, and
 * `/me/saved-memories` is not a route (404).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BLOCKER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TRIP = "22222222-2222-4222-8222-222222222222";
const M_PUBLIC = "33333333-3333-4333-8333-000000000001";
const M_NARROWED = "33333333-3333-4333-8333-000000000002";
const M_BLOCKED = "33333333-3333-4333-8333-000000000003";
const M_DELETED = "33333333-3333-4333-8333-000000000004";

type Row = Record<string, any>;
interface FakeState { [t: string]: Row[] }

function mem(id: string, over: Row = {}): Row {
  return {
    id, owner_id: OWNER, title: `Memory ${id.slice(-1)}`, caption: null,
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    location_city: "Lisbon", location_country: "Portugal", location_lat: null, location_lng: null,
    starts_at: null, ends_at: null, state: "published",
    created_at: `2026-09-0${id.slice(-1)}T10:00:00.000Z`, updated_at: null,
    ...over,
  };
}

function baseState(): FakeState {
  return {
    memories: [
      mem(M_PUBLIC),
      mem(M_NARROWED, { visibility: "only_me" }),
      mem(M_BLOCKED, { owner_id: BLOCKER }),
      mem(M_DELETED, { state: "deleted" }),
    ],
    memory_saves: [
      { memory_id: M_PUBLIC, user_id: VIEWER, created_at: "2026-09-10T00:00:00.000Z" },
      { memory_id: M_NARROWED, user_id: VIEWER, created_at: "2026-09-11T00:00:00.000Z" },
      { memory_id: M_BLOCKED, user_id: VIEWER, created_at: "2026-09-12T00:00:00.000Z" },
      { memory_id: M_DELETED, user_id: VIEWER, created_at: "2026-09-13T00:00:00.000Z" },
      // Someone else's shelf never reaches this viewer's list.
      { memory_id: M_PUBLIC, user_id: CREW, created_at: "2026-09-14T00:00:00.000Z" },
    ],
    memory_items: [], memory_likes: [], memory_tags: [],
    trips: [{ id: TRIP, owner_id: OWNER, title: "Porto weekend", destination_city: "Porto", destination_country: "Portugal", start_date: "2026-08-01", end_date: "2026-08-03", status: "completed" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: CREW, role: "member", status: "accepted" },
    ],
    profiles: [
      { id: OWNER, name: "Olive", handle: "olive", expo_push_token: null },
      { id: CREW, name: "Cam", handle: "cam", expo_push_token: null },
      { id: VIEWER, name: "Vic", handle: "vic", expo_push_token: null },
    ],
    blocks: [{ blocker_id: BLOCKER, blocked_id: VIEWER }],
    notifications: [],
    feature_flags: [], user_follows: [], circle_memberships: [], profile_privacy_settings: [],
    hidden_gems: [], memory_command_audit: [],
  };
}

let seq = 0;
function makeClient(state: FakeState, failTables = new Set<string>()) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let limitN: number | null = null;
    let countMode = false;
    let pendingInsert: Row[] | null = null;
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const rows = () => (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = () => {
      if (fail) return { data: null, error: fail, count: null };
      if (pendingInsert) return { data: pendingInsert, error: null, count: pendingInsert.length };
      if (countMode) return { data: null, error: null, count: rows().length };
      const all = rows();
      return { data: limitN == null ? all : all.slice(0, limitN), error: null, count: all.length };
    };
    const b: any = {
      select(_c?: string, opts?: any) { if (opts?.count === "exact" && opts?.head) countMode = true; return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      or() { return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return b; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return b; },
      order() { return b; },
      limit(n: number) { limitN = n; return b; },
      insert(input: Row | Row[]) {
        const list = (Array.isArray(input) ? input : [input]).map((r) => ({ id: r.id ?? `row-${++seq}`, created_at: "2026-09-29T00:00:00.000Z", ...r }));
        if (!fail) (state[table] ??= []).push(...list);
        pendingInsert = list;
        return b;
      },
      upsert(input: Row) { return b.insert(input); },
      update() { return b; },
      delete() { return b; },
      maybeSingle: async () => { const r = result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      single: async () => { const r = result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
    };
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { message: "no rpc in this fake" } }),
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, string> = { "owner-tok": OWNER, "viewer-tok": VIEWER, "crew-tok": CREW };
        const id = map[tok];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>()) {
  _setTestClient(makeClient(state, failTables) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function call(base: string, method: string, path: string, tok?: string) {
  const h: Record<string, string> = { connection: "close" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { method, headers: h });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe("HM-F12 — a tag notification lands on the screen that hosts the approval", () => {
  it("create-from-trip tags the crew and each notification carries /memory/<id>", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status, body } = await call(app.baseUrl, "POST", `/api/trips/${TRIP}/memory`, "owner-tok");
      assert.equal(status, 201);
      assert.equal(body.taggedCount, 1);
      await settle();
      const notes = state.notifications.filter((n) => n.user_id === CREW);
      assert.equal(notes.length, 1);
      assert.equal(notes[0].event_type, "trip.memory_tagged");
      assert.equal(notes[0].action_url, `/memory/${body.memory.id}`);
    } finally { await app.close(); }
  });
});

describe("HM-F13 — GET /me/saved-memories is the collection a save puts a Memory in", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try { assert.equal((await call(app.baseUrl, "GET", "/api/me/saved-memories")).status, 401); } finally { await app.close(); }
  });

  it("lists only this viewer's saves that the viewer may still read", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await call(app.baseUrl, "GET", "/api/me/saved-memories", "viewer-tok");
      assert.equal(status, 200);
      // M_NARROWED: the owner took it to only_me after the save — re-checked now.
      // M_BLOCKED: its owner blocked the viewer. M_DELETED: gone.
      assert.deepEqual(body.memories.map((m: any) => m.id), [M_PUBLIC]);
      assert.equal(body.memories[0].savedByMe, true);
      // The owner's private audience lists never reach a saver.
      assert.equal(body.memories[0].hiddenUserIds, undefined);
      assert.equal(body.memories[0].allowedUserIds, undefined);
    } finally { await app.close(); }
  });

  it("an empty shelf is an empty list", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await call(app.baseUrl, "GET", "/api/me/saved-memories", "owner-tok");
      assert.equal(status, 200);
      assert.deepEqual(body.memories, []);
    } finally { await app.close(); }
  });

  it("an unreadable memory_saves is a 503, not an empty shelf", async () => {
    const app = await startApp(baseState(), new Set(["memory_saves"]));
    try {
      const { status, body } = await call(app.baseUrl, "GET", "/api/me/saved-memories", "viewer-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("an unreadable memories table is a 503, not an empty shelf", async () => {
    const app = await startApp(baseState(), new Set(["memories"]));
    try {
      const { status } = await call(app.baseUrl, "GET", "/api/me/saved-memories", "viewer-tok");
      assert.equal(status, 503);
    } finally { await app.close(); }
  });
});
