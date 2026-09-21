/**
 * §23 `canPublishMemory(userId, memoryId, audience)` — the audience predicate,
 * and the property that decides which audiences it may refuse.
 *
 * SPEC: Portava Highlights / Memories Development Architecture Specification v1
 *   §23 names `canPublishMemory(userId, memoryId, audience)` beside
 *       `canReadMemory(userId, memoryId, surface)`.
 *   §10 canonical storage and the published audience are separate decisions.
 *
 * CENSUS: H207 was NOT-BUILT — "Publishing is a `visibility` write with no
 *         audience predicate." Any of the six visibility values was accepted on
 *         POST and PATCH with no question asked about whether the row could
 *         deliver it.
 *
 * THE DEFECT THIS CLOSES IS AN HONESTY DEFECT, NOT A LEAK
 * ======================================================
 * Three combinations make `canReadMemory` deny EVERY non-owner viewer:
 *   • trip_crew with no trip_id
 *   • trip_crew whose OWNER is not accepted crew of that trip
 *   • custom with an empty allow-list
 * The user is told the Memory is shared with their crew, or with a chosen few.
 * It is shared with nobody, and nothing ever says so.
 *
 * THE PROPERTY, NOT A LIST OF OPINIONS
 * ====================================
 * The first suite below is the one that matters: for every combination the
 * policy REFUSES, it runs the real `canReadMemory` over eight candidate viewers
 * on all five surfaces and requires all forty verdicts to be `false`; and for
 * every combination it ADMITS, it requires at least one viewer to be able to
 * read it. So the refusal list cannot drift into taste — an audience added to
 * it that somebody can actually see fails, and an audience removed from it that
 * nobody can see fails too.
 *
 * WHAT WOULD TURN THIS RED
 * ========================
 *   - Admitting trip_crew with no trip, or custom with an empty list: the
 *     property suite fails on the admitted-but-unreadable side.
 *   - Refusing friends_only or circle_only for an empty social graph: those are
 *     deliverable tomorrow with no further write, and the property suite fails
 *     on the refused-but-readable side.
 *   - Reading an unreadable trip_members as "you are not on the trip": the two
 *     reasons stop being distinguishable and that test fails.
 *   - Removing either route call: the POST and PATCH tests fail with 201/200
 *     where a 409 is required.
 *   - Judging a PATCH on `d.visibility` alone instead of the merged row: the
 *     "empties the allow-list without touching visibility" test fails.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryPublishPolicy.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import memoriesRouter from "../routes/memories.js";
import {
  canPublishMemory,
  canReadMemory,
  VISIBILITY_VALUES,
  type MemoryReadSurface,
} from "../services/memory/memoryReadPolicy.js";

const OWNER = "10000000-0000-4000-8000-0000000000a1";
const CREW_MATE = "10000000-0000-4000-8000-0000000000a2";
const FRIEND = "10000000-0000-4000-8000-0000000000a3";
const CIRCLE_MATE = "10000000-0000-4000-8000-0000000000a4";
const ALLOWED = "10000000-0000-4000-8000-0000000000a5";
const STRANGER = "10000000-0000-4000-8000-0000000000a6";
const OTHER = "10000000-0000-4000-8000-0000000000a7";
const NOBODY = "10000000-0000-4000-8000-0000000000a8";

const TRIP_WITH_OWNER = "20000000-0000-4000-8000-0000000000b1";
const TRIP_WITHOUT_OWNER = "20000000-0000-4000-8000-0000000000b2";

const M_ID = "30000000-0000-4000-8000-0000000000c1";
const M_CUSTOM = "30000000-0000-4000-8000-0000000000c2";

const SURFACES: MemoryReadSurface[] = ["single", "profile", "trip", "public_feed", "compass"];
const VIEWERS = [CREW_MATE, FRIEND, CIRCLE_MATE, ALLOWED, STRANGER, OTHER, NOBODY];

function tables(): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [OWNER, CREW_MATE, FRIEND, CIRCLE_MATE, ALLOWED, STRANGER, OTHER, NOBODY].map((id) => ({
      id, handle: `h${id.slice(-2)}`, name: "n", avatar_url: null, account_status: "active", is_private: false,
    })),
    trips: [{ id: TRIP_WITH_OWNER, owner_id: OWNER }, { id: TRIP_WITHOUT_OWNER, owner_id: OTHER }],
    trip_members: [
      { trip_id: TRIP_WITH_OWNER, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP_WITH_OWNER, user_id: CREW_MATE, role: "member", status: "accepted" },
      { trip_id: TRIP_WITHOUT_OWNER, user_id: CREW_MATE, role: "owner", status: "accepted" },
      { trip_id: TRIP_WITHOUT_OWNER, user_id: OTHER, role: "member", status: "accepted" },
    ],
    // Mutual follow OWNER <-> FRIEND, so friends_only is genuinely deliverable.
    user_follows: [
      { follower_id: OWNER, following_id: FRIEND },
      { follower_id: FRIEND, following_id: OWNER },
    ],
    circle_memberships: [{ user_id: OWNER, other_id: CIRCLE_MATE }],
    blocks: [],
    memories: [],
    memory_items: [],
    memory_tags: [],
    memory_likes: [],
    memory_saves: [],
    notifications: [],
    hidden_gems: [],
    collections: [],
    collection_items: [],
  };
}

function makeClient(db: Record<string, any[]>, failTables = new Set<string>()) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false, head = false, isWrite = false, selectedAfterWrite = false;
    let mode: "insert" | "update" | "delete" | null = null;
    let payload: any = null;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; if (isWrite) selectedAfterWrite = true; return obj; },
      insert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      update(d: any) { isWrite = true; mode = "update"; payload = d; return obj; },
      upsert(d: any) { isWrite = true; mode = "insert"; payload = d; return obj; },
      delete() { isWrite = true; mode = "delete"; return obj; },
      eq(c: string, v: any) { filters.push((r) => String(r[c]) === String(v)); return obj; },
      neq(c: string, v: any) { filters.push((r) => String(r[c]) !== String(v)); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs.map(String)); filters.push((r) => s.has(String(r[c]))); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      not() { return obj; }, ilike() { return obj; }, or() { return obj; }, filter() { return obj; },
      gt() { return obj; }, lt() { return obj; }, gte() { return obj; }, lte() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<any> {
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const all = (db[table] ??= []);
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({ ...r, id: r.id ?? M_ID }));
        for (const r of rows) all.push(r);
        return { data: single ? rows[0] : rows, error: null, count: null };
      }
      let matched = all.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of matched) Object.assign(r, payload);
        if (!selectedAfterWrite) return { data: null, error: null, count: null };
        return { data: single ? (matched[0] ?? null) : matched, error: null, count: matched.length };
      }
      if (mode === "delete") {
        const gone = new Set(matched);
        db[table] = all.filter((r) => !gone.has(r));
        return { data: selectedAfterWrite ? matched : null, error: null, count: matched.length };
      }
      if (single) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched, error: null, count: head ? matched.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    rpc: async () => ({ data: null, error: { message: "kernel rpc not applied here" } }),
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

function row(over: Record<string, unknown>) {
  return {
    id: M_ID, owner_id: OWNER, title: "t", caption: null, visibility: "public",
    allowed_user_ids: [], hidden_user_ids: [], state: "published",
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    starts_at: null, ends_at: null, location_city: null, location_country: null,
    location_lat: null, location_lng: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/** Can ANY viewer, on ANY surface, read this row? */
async function anyoneCanRead(sc: any, r: Record<string, unknown>): Promise<string | null> {
  for (const viewer of VIEWERS) {
    for (const surface of SURFACES) {
      if (await canReadMemory(sc, r, viewer, surface)) return `${viewer} on ${surface}`;
    }
  }
  return null;
}

/* ─────────── the property: refuse exactly the undeliverable audiences ─────── */

describe("§23 canPublishMemory — refuses exactly the audiences nobody could read", () => {
  const CASES: Array<{ name: string; audience: string; over: Record<string, unknown>; refuse: boolean }> = [
    { name: "trip_crew with no trip",            audience: "trip_crew", over: { trip_id: null }, refuse: true },
    { name: "trip_crew whose owner is not crew", audience: "trip_crew", over: { trip_id: TRIP_WITHOUT_OWNER }, refuse: true },
    { name: "custom with an empty allow-list",   audience: "custom",    over: { allowed_user_ids: [] }, refuse: true },
    { name: "trip_crew with the owner on the trip", audience: "trip_crew", over: { trip_id: TRIP_WITH_OWNER }, refuse: false },
    { name: "custom with one person on the list",   audience: "custom",    over: { allowed_user_ids: [ALLOWED] }, refuse: false },
    { name: "public",                               audience: "public",    over: {}, refuse: false },
    { name: "friends_only with a mutual follow",    audience: "friends_only", over: {}, refuse: false },
    { name: "circle_only with a circle member",     audience: "circle_only",  over: {}, refuse: false },
  ];

  for (const c of CASES) {
    it(`${c.refuse ? "refuses" : "admits"}: ${c.name}`, async () => {
      const sc = makeClient(tables());
      const r = row({ ...c.over, visibility: c.audience });
      const decision = await canPublishMemory(sc, OWNER, r as any, c.audience);
      assert.equal(decision.ok, !c.refuse, `${c.name}: policy said ok=${decision.ok}`);

      const reader = await anyoneCanRead(sc, r);
      if (c.refuse) {
        assert.equal(reader, null, `${c.name} was refused, but ${reader} can read it — the refusal is not derived from the ladder`);
      } else {
        assert.notEqual(reader, null, `${c.name} was admitted, but no viewer on any surface can read it`);
      }
    });
  }

  it("only_me is admitted — it means nobody ON PURPOSE, which is not the same defect", async () => {
    const sc = makeClient(tables());
    const r = row({ visibility: "only_me" });
    assert.equal((await canPublishMemory(sc, OWNER, r as any, "only_me")).ok, true);
    assert.equal(await anyoneCanRead(sc, r), null);
  });

  it("an empty social graph does NOT refuse friends_only or circle_only — those become deliverable without a write", async () => {
    const empty = tables();
    empty.user_follows = [];
    empty.circle_memberships = [];
    const sc = makeClient(empty);
    for (const audience of ["friends_only", "circle_only"]) {
      assert.equal((await canPublishMemory(sc, OWNER, row({ visibility: audience }) as any, audience)).ok, true);
    }
  });

  it("every declared visibility value has a decision — no audience falls through", async () => {
    const sc = makeClient(tables());
    for (const v of VISIBILITY_VALUES) {
      const d = await canPublishMemory(sc, OWNER, row({ trip_id: TRIP_WITH_OWNER, allowed_user_ids: [ALLOWED] }) as any, v);
      assert.equal(d.ok, true, `${v} was refused with a fully deliverable row`);
    }
    const unknown = await canPublishMemory(sc, OWNER, row({}) as any, "everyone");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.reason, "unknown_audience");
  });

  it("refuses a non-owner, and names the reason distinctly", async () => {
    const sc = makeClient(tables());
    const d = await canPublishMemory(sc, STRANGER, row({}) as any, "public");
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, "not_owner");
  });

  it("fails CLOSED on an unreadable trip_members, and does NOT call it 'you are not on the trip'", async () => {
    const sc = makeClient(tables(), new Set(["trip_members"]));
    const d = await canPublishMemory(sc, OWNER, row({ trip_id: TRIP_WITH_OWNER }) as any, "trip_crew");
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, "trip_crew_unreadable");

    const real = makeClient(tables());
    const notCrew = await canPublishMemory(real, OWNER, row({ trip_id: TRIP_WITHOUT_OWNER }) as any, "trip_crew");
    assert.equal(notCrew.ok, false);
    if (!notCrew.ok) assert.equal(notCrew.reason, "trip_crew_owner_not_crew");
  });
});

/* ─────────────────────────── through the routes ──────────────────────────── */

type App = { baseUrl: string; db: Record<string, any[]>; close: () => Promise<void> };

async function startApp(db: Record<string, any[]>): Promise<App> {
  _setTestClient(makeClient(db) as any, true);
  const realError = logger.error.bind(logger);
  (logger as any).error = () => {};
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", memoriesRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, db,
        close: () => new Promise<void>((r) => { (logger as any).error = realError; srv.close(() => r()); }),
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

describe("§23 canPublishMemory is on the write path, not beside it", () => {
  it("POST refuses a crew audience with no trip — 409, a reason, and NOTHING written", async () => {
    const db = tables();
    const app = await startApp(db);
    try {
      const r = await call(app, "POST", "/api/memories", OWNER, { title: "x", visibility: "trip_crew" });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "conflict");
      assert.equal(r.body.reason, "trip_crew_without_trip");
      assert.equal(db.memories.length, 0, "a Memory was written despite the refusal");
    } finally { await app.close(); }
  });

  it("POST refuses a custom audience with an empty list, and ACCEPTS the same audience with one name", async () => {
    const db = tables();
    const app = await startApp(db);
    try {
      const bad = await call(app, "POST", "/api/memories", OWNER, { title: "x", visibility: "custom", allowedUserIds: [] });
      assert.equal(bad.status, 409);
      assert.equal(bad.body.reason, "custom_without_allow_list");
      assert.equal(db.memories.length, 0);

      const good = await call(app, "POST", "/api/memories", OWNER, { title: "x", visibility: "custom", allowedUserIds: [ALLOWED] });
      assert.equal(good.status, 201, JSON.stringify(good.body));
      assert.equal(db.memories.length, 1);
    } finally { await app.close(); }
  });

  it("POST accepts a crew audience on a trip the owner is actually on", async () => {
    const db = tables();
    const app = await startApp(db);
    try {
      const r = await call(app, "POST", "/api/memories", OWNER, { title: "x", visibility: "trip_crew", tripId: TRIP_WITH_OWNER });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    } finally { await app.close(); }
  });

  it("PATCH refuses emptying an allow-list even though `visibility` is not in the patch", async () => {
    const db = tables();
    db.memories.push(row({ id: M_CUSTOM, visibility: "custom", allowed_user_ids: [ALLOWED] }));
    const app = await startApp(db);
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_CUSTOM}`, OWNER, { allowedUserIds: [] });
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, "custom_without_allow_list");
      assert.deepEqual(db.memories[0]!.allowed_user_ids, [ALLOWED], "the allow-list was emptied anyway");
    } finally { await app.close(); }
  });

  it("PATCH leaves an unrelated edit alone — the gate is not a blanket refusal", async () => {
    const db = tables();
    db.memories.push(row({ id: M_CUSTOM, visibility: "custom", allowed_user_ids: [ALLOWED] }));
    const app = await startApp(db);
    try {
      const r = await call(app, "PATCH", `/api/memories/${M_CUSTOM}`, OWNER, { caption: "a new caption" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(db.memories[0]!.caption, "a new caption");
    } finally { await app.close(); }
  });
});
