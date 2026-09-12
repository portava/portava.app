/**
 * Telegraph §13.2 — the three events the census found missing, emitted from the
 * real write paths.
 *
 * §13.2 lists eighteen events. census-telegraph found `message.deleted` (T182),
 * `member.joined` (T185) and `safety.reported` (T194) absent from the union AND
 * from every writer — "a delete reaches other clients only on their next poll",
 * "a trip-membership sync is silent to open clients", "reports write a row and
 * emit nothing".
 *
 * WHAT IS PROVED, AND WHAT WOULD TURN IT RED
 * ==========================================
 *   - The delete route publishes, and EXCLUDES the deleter. Without the
 *     exclusion the sender's own client would be told about its own action and
 *     would have to filter it — which is where double-removal bugs live.
 *   - `member.joined` fires for a NEWCOMER and not for someone already in the
 *     thread. The prior roster must be read BEFORE the upsert; if that read
 *     moved after it, every sync would announce the whole crew and the
 *     already-a-member test goes red.
 *   - An unreadable prior roster emits NOTHING. A burst of false "X joined"
 *     lines is worse than a missing one, and the next poll shows the truth
 *     either way.
 *   - `safety.reported` reaches the REPORTER and nobody else, and its payload
 *     contains no target id. If it were published to the thread, the
 *     audience test fails — and that failure is the one that matters, because
 *     telling a reported party about a report is how a reporter gets hurt.
 *   - Both sync implementations emit. There are two in this tree
 *     (`lib/chatSync.ts` and `services/groupChatSync.ts`), reached from
 *     different routes; an event that fires on one of two paths teaches a
 *     client not to trust it.
 *
 * Runtime: node:test + node:assert/strict. Run:
 *   node --import tsx/esm --test src/test/telegraphEventUnion.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { subscribe, type TelegraphEvent } from "../lib/telegraphEvents.js";
import groupChatRouter from "../routes/groupChat.js";
import messagingRouter from "../routes/messaging.js";
import { syncTripChatMembers as libSyncTrip } from "../lib/chatSync.js";
import { syncTripChatMembers as svcSyncTrip } from "../services/groupChatSync.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const CARL = "cccccccc-0000-4000-8000-000000000003";
const THREAD = "00000000-0000-4000-8000-00000000000a";
const TRIP = "11111111-0000-4000-8000-000000000001";
const MSG = "22222222-0000-4000-8000-000000000001";

/* ───────────── a recording bus subscriber, one per user ───────────── */

interface Recorder { events: TelegraphEvent[]; stop: () => void }

function record(userIds: string[]): Map<string, Recorder> {
  const out = new Map<string, Recorder>();
  for (const uid of userIds) {
    const events: TelegraphEvent[] = [];
    const stop = subscribe(uid, (e) => { events.push(e); });
    out.set(uid, { events, stop });
  }
  return out;
}

function typesFor(rec: Map<string, Recorder>, uid: string): string[] {
  return (rec.get(uid)?.events ?? []).map((e) => e.type);
}

/* ────────────────────────── the fake client ───────────────────────── */

interface State {
  /** message_thread_members rows in the thread, before anything runs. */
  members: Array<{ user_id: string; left_at: string | null; role?: string }>;
  /** trip_members rows for TRIP. */
  tripMembers: Array<{ user_id: string; role: string }>;
  /** Fail the roster read the joined-event depends on. */
  rosterError?: boolean;
  messageDeleted?: boolean;
}

function makeClient(state: State) {
  const db: Record<string, any[]> = {
    message_threads: [
      { id: THREAD, thread_type: "trip", trip_id: TRIP, circle_owner_id: null, status: "active",
        title: "T", created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
        last_message_at: null, is_e2ee: false },
    ],
    message_thread_members: state.members.map((m) => ({
      thread_id: THREAD, user_id: m.user_id, role: m.role ?? "member",
      joined_at: "2026-01-01T00:00:00.000Z", left_at: m.left_at,
      last_read_at: null, muted_at: null, archived_at: null, visible_from_at: null,
    })),
    trips: [{ id: TRIP, owner_id: ALICE, title: "Trip", destination_city: "Hanoi" }],
    trip_members: state.tripMembers.map((m) => ({ trip_id: TRIP, user_id: m.user_id, role: m.role, status: "accepted" })),
    messages: [
      { id: MSG, thread_id: THREAD, sender_id: ALICE, body: "hello",
        created_at: "2026-05-01T00:00:00.000Z",
        deleted_at: state.messageDeleted ? "2026-05-02T00:00:00.000Z" : null,
        edited_at: null, original_language: null, msg_type: "text", subtype: null,
        media_url: null, media_type: null, media_thumbnail_url: null,
        media_duration_seconds: null, reply_to_id: null },
    ],
    reports: [],
    profiles: [
      { id: ALICE, handle: "alice", name: "Alice" },
      { id: BOB, handle: "bob", name: "Bob" },
      { id: CARL, handle: "carl", name: "Carl" },
    ],
    feature_flags: [],
    message_translations: [],
    circle_memberships: [],
  };

  function from(table: string) {
    const preds: Array<(r: any) => boolean> = [];
    let _limit: number | null = null;
    let nFilters = 0;
    let pendingInsert: any[] | null = null;

    const rowsNow = () => {
      const rows = (db[table] ?? []).filter((r) => preds.every((f) => f(r)));
      return _limit !== null ? rows.slice(0, _limit) : rows;
    };
    const injected = () => {
      // The joined-event's prior-roster read is `select(user_id).eq(thread_id).is(left_at,null)`
      // — two filters. The caller's own membership lookup adds an eq(user_id).
      if (table === "message_thread_members" && state.rosterError && nFilters === 2) {
        return { message: "roster read blew up" };
      }
      return null;
    };

    const target: any = {
      select() { return proxy; },
      insert(rows: any) {
        pendingInsert = Array.isArray(rows) ? rows : [rows];
        for (const r of pendingInsert) {
          const row = { id: r.id ?? `gen-${Math.random().toString(16).slice(2)}`, ...r };
          (db[table] ??= []).push(row);
        }
        return proxy;
      },
      upsert(rows: any) {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const r of list) {
          const existing = (db[table] ??= []).find(
            (x) => x.thread_id === r.thread_id && x.user_id === r.user_id,
          );
          if (existing) Object.assign(existing, r);
          else db[table]!.push({ ...r });
        }
        return proxy;
      },
      update(patch: any) {
        for (const r of rowsNow()) Object.assign(r, patch);
        return proxy;
      },
      eq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) === String(val)); return proxy; },
      neq(col: string, val: any) { nFilters++; preds.push((r) => String(r[col]) !== String(val)); return proxy; },
      is(col: string, val: any) { nFilters++; preds.push((r) => (val === null ? r[col] == null : r[col] === val)); return proxy; },
      in(col: string, vals: any[]) { nFilters++; preds.push((r) => vals.map(String).includes(String(r[col]))); return proxy; },
      lt() { return proxy; },
      gte() { return proxy; },
      order() { return proxy; },
      limit(n: number) { _limit = n; return proxy; },
      maybeSingle() {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err });
        if (pendingInsert) { const r = pendingInsert[0]; pendingInsert = null; return Promise.resolve({ data: r, error: null }); }
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      single() {
        if (pendingInsert) { const r = pendingInsert[0]; pendingInsert = null; return Promise.resolve({ data: r, error: null }); }
        return Promise.resolve({ data: rowsNow()[0] ?? null, error: null });
      },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        const err = injected();
        if (err) return Promise.resolve({ data: null, error: err, count: null }).then(resolve, reject);
        if (pendingInsert) { pendingInsert = null; return Promise.resolve({ data: null, error: null }).then(resolve, reject); }
        const rows = rowsNow();
        return Promise.resolve({ data: rows, error: null, count: rows.length }).then(resolve, reject);
      },
    };
    const proxy: any = new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as string];
        if (prop === "catch" || prop === "finally") return undefined;
        return () => proxy;
      },
    });
    return proxy;
  }

  return {
    _db: db,
    from,
    rpc: async () => ({ data: null, error: { message: "rpc not modelled" } }),
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  } as any;
}

/** Give the fire-and-forget publishes a turn of the event loop to land. */
const settle = () => new Promise<void>((r) => setTimeout(r, 15));

/* ───────────────────────── §13.2 union coverage ───────────────────── */

describe("Telegraph §13.2 — union coverage", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "../lib/telegraphEvents.ts"), "utf8");

  it("declares the three the census found missing", () => {
    for (const t of ["message.deleted", "member.joined", "safety.reported"]) {
      assert.ok(src.includes(`| "${t}"`), `${t} is not in TelegraphEventType`);
    }
  });

  it("keeps member.left, so joined did not replace it", () => {
    assert.ok(src.includes('| "member.left"'));
  });
});

/* ──────────────────────── message.deleted ─────────────────────────── */

describe("Telegraph §13.2 message.deleted — DELETE /messages/:id", () => {
  let server: any;
  let base = "";

  it("publishes to the thread and EXCLUDES the deleter", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null }, { user_id: BOB, left_at: null }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: BOB, role: "member" }],
    });
    _setTestClient(client, true);

    const app = express();
    app.use(express.json());
    app.use("/api", groupChatRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}/api`;

    const rec = record([ALICE, BOB]);
    const res = await fetch(`${base}/messages/${MSG}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${ALICE}` },
    });
    assert.equal(res.status, 200);
    await settle();

    assert.ok(typesFor(rec, BOB).includes("message.deleted"), "the other member was not told");
    assert.ok(!typesFor(rec, ALICE).includes("message.deleted"), "the deleter was told about their own delete");

    const ev = rec.get(BOB)!.events.find((e) => e.type === "message.deleted")!;
    assert.equal((ev.payload as any).messageId, MSG);
    assert.equal((ev.payload as any).body, undefined, "a tombstone carries no body");

    for (const r of rec.values()) r.stop();
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null, false);
  });
});

/* ───────────────────────── member.joined ──────────────────────────── */

describe("Telegraph §13.2 member.joined — both sync implementations", () => {
  beforeEach(() => { _setTestClient(null, false); });

  it("services/groupChatSync: fires for a NEWCOMER only", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: BOB, role: "member" }],
    });
    const rec = record([ALICE, BOB]);
    await svcSyncTrip(client, TRIP);
    await settle();

    const joined = rec.get(ALICE)!.events.filter((e) => e.type === "member.joined");
    assert.equal(joined.length, 1, `expected exactly one joined event, got ${joined.length}`);
    assert.equal((joined[0]!.payload as any).userId, BOB, "the newcomer is Bob, not the existing member");
    assert.equal((joined[0]!.payload as any).source, "trip_sync");
    for (const r of rec.values()) r.stop();
  });

  it("services/groupChatSync: fires for NOBODY when everyone was already here", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null }, { user_id: BOB, left_at: null }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: BOB, role: "member" }],
    });
    const rec = record([ALICE, BOB]);
    await svcSyncTrip(client, TRIP);
    await settle();
    assert.deepEqual(
      rec.get(ALICE)!.events.filter((e) => e.type === "member.joined"),
      [],
      "a sync that changed nothing announced somebody",
    );
    for (const r of rec.values()) r.stop();
  });

  it("services/groupChatSync: an UNREADABLE prior roster emits nothing at all", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: BOB, role: "member" }],
      rosterError: true,
    });
    const rec = record([ALICE, BOB]);
    await svcSyncTrip(client, TRIP).catch(() => { /* the sync's own error path */ });
    await settle();
    assert.deepEqual(
      rec.get(ALICE)!.events.filter((e) => e.type === "member.joined"),
      [],
      "a failed read produced a false announcement",
    );
    for (const r of rec.values()) r.stop();
  });

  it("lib/chatSync: the OTHER implementation emits too", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null, role: "owner" }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: CARL, role: "member" }],
    });
    const rec = record([ALICE, CARL]);
    await libSyncTrip(TRIP, client);
    await settle();
    const joined = rec.get(ALICE)!.events.filter((e) => e.type === "member.joined");
    assert.equal(joined.length, 1, "lib/chatSync is a live path and must emit as well");
    assert.equal((joined[0]!.payload as any).userId, CARL);
    for (const r of rec.values()) r.stop();
  });
});

/* ──────────────────────── safety.reported ─────────────────────────── */

describe("Telegraph §13.2 safety.reported — the reporter, and nobody else", () => {
  let server: any;
  let base = "";

  it("reaches the reporter, not the thread, and names no target", async () => {
    const client = makeClient({
      members: [{ user_id: ALICE, left_at: null }, { user_id: BOB, left_at: null }],
      tripMembers: [{ user_id: ALICE, role: "owner" }, { user_id: BOB, role: "member" }],
    });
    _setTestClient(client, true);

    const app = express();
    app.use(express.json());
    app.use("/api", messagingRouter);
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}/api`;

    const rec = record([ALICE, BOB]);
    const res = await fetch(`${base}/messages/${MSG}/report`, {
      method: "POST",
      headers: { authorization: `Bearer ${BOB}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "scam" }),
    });
    assert.equal(res.status, 201);
    await settle();

    assert.ok(typesFor(rec, BOB).includes("safety.reported"), "the reporter got no confirmation");
    assert.ok(!typesFor(rec, ALICE).includes("safety.reported"),
      "the reported party was told a report exists — that is how a reporter gets hurt");

    const ev = rec.get(BOB)!.events.find((e) => e.type === "safety.reported")!;
    assert.equal((ev.payload as any).targetType, "message");
    assert.equal((ev.payload as any).targetId, undefined, "the target's identity must not be on the wire");
    assert.equal(ev.threadId, null, "a reporter-scoped event carries no thread");

    for (const r of rec.values()) r.stop();
    await new Promise<void>((r) => server.close(() => r()));
    _setTestClient(null, false);
  });
});
