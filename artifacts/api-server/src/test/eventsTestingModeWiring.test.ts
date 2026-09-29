/**
 * Events & meetups — testing-mode wiring (WP-05: PLAT-F26/F28/F29/F30/F31).
 *
 * The client screens built for these flows call routes that already existed;
 * these tests pin the server behaviour those screens depend on and the
 * defects that wiring them made reachable:
 *
 *   - POST /events/:id/checkin      window + state gate; a failed write is a 500
 *                                   (it used to answer {ok:true} regardless).
 *   - GET  /events/share-link/:t/preview   a viewer blocked with the host is 404
 *                                   (the preview skipped the block check that
 *                                   GET /events/:id applies first).
 *   - POST /events/:id/cohosts      a failed write is a 500, not 201.
 *   - GET  /events/:id/cohosts      carries the co-host's public identity.
 *   - POST /events/:id/memory       a Going attendee may save a completed event
 *                                   as their own memory; a second save returns
 *                                   the same memory instead of a duplicate.
 *   - GET  /events/:id/posts        author real names follow the universal
 *                                   display-name rule (hidden unless opted in).
 *   - GET  /events/:id/comments     rows carry the author's public identity.
 *   - GET  /me/meetup-invites       an unreadable invites table is an error,
 *                                   never an empty inbox.
 *
 * Run: node --import tsx/esm --test src/test/eventsTestingModeWiring.test.ts
 */

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { eventCheckInRefusal } from "../routes/events.js";

interface Row { [k: string]: any; }
interface FakeTable { rows: Row[]; upsertError?: string; readError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags: tables.feature_flags ?? { rows: [
      { flag: "events_enabled", key: "events_enabled", enabled: true },
    ]},
    ...tables,
  };

  function chain(tableName: string, filtered: Row[]) {
    let singleMode = false;
    let upsertFailed: string | null = null;
    let pendingOp: null | { type: "delete" } | { type: "update"; data: Row } = null;
    const table = () => db[tableName] ?? (db[tableName] = { rows: [] });

    const settle = () => {
      if (!pendingOp) return;
      const t = table();
      if (pendingOp.type === "delete") {
        const del = new Set(filtered);
        t.rows = t.rows.filter((r) => !del.has(r));
        filtered = [];
      } else {
        const data = pendingOp.data;
        for (const row of filtered) Object.assign(row, data);
      }
      pendingOp = null;
    };

    const obj: any = {
      select() { return obj; },
      insert(data: Row | Row[]) {
        const rows = Array.isArray(data) ? data : [data];
        filtered = rows.map((r) => {
          const row = { id: `fake-${tableName}-${Math.random().toString(36).slice(2)}`, ...r };
          table().rows.push(row);
          return row;
        });
        return obj;
      },
      upsert(data: Row | Row[]) {
        if (table().upsertError) { upsertFailed = table().upsertError!; return obj; }
        const rows = Array.isArray(data) ? data : [data];
        filtered = rows.map((r) => {
          const existing = table().rows.find((row) =>
            r.event_id !== undefined && r.user_id !== undefined
              ? row.event_id === r.event_id && row.user_id === r.user_id
              : false);
          if (existing) { Object.assign(existing, r); return existing; }
          const row = { id: `fake-${tableName}-${Math.random().toString(36).slice(2)}`, ...r };
          table().rows.push(row);
          return row;
        });
        return obj;
      },
      update(data: Row) { pendingOp = { type: "update", data }; return obj; },
      delete() { pendingOp = { type: "delete" }; return obj; },
      eq(col: string, val: any) { filtered = filtered.filter((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      is(col: string, val: any) { filtered = filtered.filter((r) => val === null ? r[col] == null : r[col] === val); return obj; },
      not(col: string, op: string) { if (op === "is") filtered = filtered.filter((r) => r[col] != null); return obj; },
      or() { return obj; },
      order() { return obj; },
      limit() { return obj; },
      range(from: number, to: number) { filtered = filtered.slice(from, to + 1); return obj; },
      single() {
        singleMode = true; settle();
        if (upsertFailed) return Promise.resolve({ data: null, error: { message: upsertFailed } });
        const row = filtered[0] ?? null;
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "No rows", code: "PGRST116" } });
      },
      maybeSingle() {
        singleMode = true;
        if (table().readError) return Promise.resolve({ data: null, error: { message: table().readError } });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: any, reject: any) {
        settle();
        if (upsertFailed) return Promise.resolve({ data: null, error: { message: upsertFailed } }).then(resolve, reject);
        if (table().readError) return Promise.resolve({ data: null, error: { message: table().readError } }).then(resolve, reject);
        const data = singleMode ? (filtered[0] ?? null) : filtered;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return obj;
  }

  return {
    from(tableName: string) {
      const t = db[tableName] ?? (db[tableName] = { rows: [] });
      return chain(tableName, [...t.rows]);
    },
    auth: {
      getUser: async (token: string) => {
        const userId = token.startsWith("fake-token-") ? token.slice("fake-token-".length) : null;
        if (!userId) return { data: { user: null }, error: { message: "Invalid token" } };
        return { data: { user: { id: userId } }, error: null };
      },
    },
    _db: db,
  };
}

const ID = {
  ev1:    "00000000-0000-0000-0000-0000000000e1",
  host:   "00000000-0000-0000-0001-0000000000a1",
  going:  "00000000-0000-0000-0002-0000000000b1",
  other:  "00000000-0000-0000-0002-0000000000b2",
  meetup: "00000000-0000-0000-0003-0000000000c1",
} as const;

const HOUR = 3_600_000;

function makeEvent(overrides: Row = {}): Row {
  return {
    id: ID.ev1, host_id: ID.host, title: "Wiring Event", description: null,
    location_name: "Venue", location_lat: 1, location_lng: 2,
    starts_at: new Date(Date.now() + 24 * HOUR).toISOString(), ends_at: null,
    visibility: "public", state: "open", city: "Lisbon", country: "Portugal",
    attendee_comments_enabled: true, rsvp_options: ["going"], going_count: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

async function req(port: number, method: string, path: string, body: unknown, userId: string) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer fake-token-${userId}` },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

let port: number;
let close: () => Promise<void>;
beforeEach(async () => { ({ port, close } = await startServer()); });
afterEach(async () => { await close(); });

// ── Check-in window (pure rule) ───────────────────────────────────────────────

describe("eventCheckInRefusal — the check-in window", () => {
  const start = Date.parse("2026-10-01T18:00:00Z");
  const ev = (o: Row = {}) => ({ state: "open", starts_at: new Date(start).toISOString(), ends_at: null, ...o });

  it("opens 60 minutes before the start and not earlier", () => {
    assert.notEqual(eventCheckInRefusal(ev(), start - 61 * 60_000), null);
    assert.equal(eventCheckInRefusal(ev(), start - 60 * 60_000), null);
  });
  it("closes 2 hours after the end", () => {
    const end = start + 3 * HOUR;
    assert.equal(eventCheckInRefusal(ev({ ends_at: new Date(end).toISOString() }), end + 2 * HOUR), null);
    assert.notEqual(eventCheckInRefusal(ev({ ends_at: new Date(end).toISOString() }), end + 2 * HOUR + 1), null);
  });
  it("with no end time, closes 8 hours after the start", () => {
    assert.equal(eventCheckInRefusal(ev(), start + 8 * HOUR), null);
    assert.notEqual(eventCheckInRefusal(ev(), start + 8 * HOUR + 1), null);
  });
  it("refuses terminal and draft states and a missing start time", () => {
    for (const state of ["draft", "cancelled", "archived", "completed"]) {
      assert.notEqual(eventCheckInRefusal(ev({ state }), start), null, state);
    }
    assert.notEqual(eventCheckInRefusal(ev({ starts_at: null }), start), null);
    assert.equal(eventCheckInRefusal(ev({ state: "started" }), start + HOUR), null);
  });
});

// ── POST /events/:id/checkin ──────────────────────────────────────────────────

describe("POST /api/events/:id/checkin", () => {
  it("refuses a check-in a day before the event (409) and writes nothing", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent()] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
      event_attendee_states: { rows: [] },
    });
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/checkin`, {}, ID.going);
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(client._db.event_attendee_states.rows.length, 0);
  });

  it("checks a Going attendee in once the event is under way", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ starts_at: new Date(Date.now() - 10 * 60_000).toISOString() })] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
      event_attendee_states: { rows: [] },
    });
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/checkin`, {}, ID.going);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    const row = client._db.event_attendee_states.rows[0];
    assert.equal(row.user_id, ID.going);
    assert.equal(row.checked_in_at, r.body.checkedInAt);
  });

  it("refuses a cancelled event", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ state: "cancelled", starts_at: new Date().toISOString() })] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
    });
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/checkin`, {}, ID.going);
    assert.equal(r.status, 409);
  });

  it("a failed write is a 500, never {ok:true}", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ starts_at: new Date().toISOString() })] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
      event_attendee_states: { rows: [], upsertError: "disk full" },
    });
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/checkin`, {}, ID.going);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.notEqual(r.body.ok, true);
  });
});

// ── Share-link preview ────────────────────────────────────────────────────────

describe("GET /api/events/share-link/:token/preview", () => {
  const link = { id: "l1", event_id: ID.ev1, creator_id: ID.host, token: "sharetoken12345", max_uses: null, use_count: 0, expires_at: null };

  it("returns the event for a valid token", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [makeEvent({ visibility: "invite_only" })] },
      event_share_links: { rows: [{ ...link }] },
      blocks: { rows: [] },
    }), true);
    const r = await req(port, "GET", "/api/events/share-link/sharetoken12345/preview", null, ID.other);
    assert.equal(r.status, 200);
    assert.equal(r.body.event.id, ID.ev1);
  });

  it("is 404 for a viewer blocked with the host", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [makeEvent()] },
      event_share_links: { rows: [{ ...link }] },
      blocks: { rows: [{ blocker_id: ID.host, blocked_id: ID.other }] },
    }), true);
    const r = await req(port, "GET", "/api/events/share-link/sharetoken12345/preview", null, ID.other);
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.equal(r.body.event, undefined);
  });
});

// ── Co-hosts ──────────────────────────────────────────────────────────────────

describe("event co-hosts", () => {
  it("POST: a failed write is a 500, not 201", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [makeEvent()] },
      event_cohosts: { rows: [], upsertError: "constraint" },
    }), true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/cohosts`, { userId: ID.going }, ID.host);
    assert.equal(r.status, 500, JSON.stringify(r.body));
  });

  it("POST: a user blocked with the host cannot be added (403) and nothing is written", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent()] },
      event_cohosts: { rows: [] },
      blocks: { rows: [{ blocker_id: ID.going, blocked_id: ID.host }] },
    });
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/cohosts`, { userId: ID.going }, ID.host);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(client._db.event_cohosts.rows.length, 0);
  });

  it("GET: carries each co-host's public identity (handle; real name only if opted in)", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [makeEvent()] },
      event_cohosts: { rows: [{ event_id: ID.ev1, user_id: ID.going, permissions: {}, added_by: ID.host, added_at: "2026-01-01" }] },
      profiles: { rows: [{ id: ID.going, handle: "cohosty", name: "Real Name", avatar_url: null }] },
      profile_privacy_settings: { rows: [] },
    }), true);
    const r = await req(port, "GET", `/api/events/${ID.ev1}/cohosts`, null, ID.host);
    assert.equal(r.status, 200);
    assert.equal(r.body.cohosts.length, 1);
    assert.equal(r.body.cohosts[0].user_id, ID.going);
    assert.equal(r.body.cohosts[0].handle, "cohosty");
    assert.equal(r.body.cohosts[0].displayName, null);
  });
});

// ── Save as memory ────────────────────────────────────────────────────────────

describe("POST /api/events/:id/memory", () => {
  const tables = () => ({
    events: { rows: [makeEvent({ state: "completed" })] },
    event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
    passport_memories: { rows: [] as Row[] },
  });

  it("a Going attendee can save a completed event as their own memory", async () => {
    const client = makeFakeClient(tables());
    _setTestClient(client, true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/memory`, {}, ID.going);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(client._db.passport_memories.rows[0].user_id, ID.going);
  });

  it("a second save returns the same memory instead of a duplicate", async () => {
    const client = makeFakeClient(tables());
    _setTestClient(client, true);
    const a = await req(port, "POST", `/api/events/${ID.ev1}/memory`, {}, ID.host);
    const b = await req(port, "POST", `/api/events/${ID.ev1}/memory`, {}, ID.host);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    assert.equal(b.body.memoryId, a.body.memoryId);
    assert.equal(b.body.alreadySaved, true);
    assert.equal(client._db.passport_memories.rows.length, 1);
  });

  it("a non-participant is refused", async () => {
    _setTestClient(makeFakeClient(tables()), true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/memory`, {}, ID.other);
    assert.equal(r.status, 403);
  });

  it("an event that has not completed is refused", async () => {
    _setTestClient(makeFakeClient({ ...tables(), events: { rows: [makeEvent({ state: "open" })] } }), true);
    const r = await req(port, "POST", `/api/events/${ID.ev1}/memory`, {}, ID.host);
    assert.equal(r.status, 403);
  });
});

// ── Posts & comments identity ─────────────────────────────────────────────────

describe("event posts and comments carry sanitized author identity", () => {
  const base = () => ({
    events: { rows: [makeEvent()] },
    event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.going, status: "going" }] },
    profiles: { rows: [{ id: ID.other, handle: "poster", name: "Hidden Name", avatar_url: null }] },
    profile_privacy_settings: { rows: [] },
  });

  it("GET /posts hides a real name the author has not opted to show", async () => {
    _setTestClient(makeFakeClient({
      ...base(),
      event_posts: { rows: [{ id: "p1", event_id: ID.ev1, author_id: ID.other, body: "hi", media_urls: [], pinned: false, created_at: "2026-01-01" }] },
    }), true);
    const r = await req(port, "GET", `/api/events/${ID.ev1}/posts`, null, ID.going);
    assert.equal(r.status, 200);
    assert.equal(r.body.posts[0].author.handle, "poster");
    assert.equal(r.body.posts[0].author.displayName, null);
  });

  it("GET /comments returns each update with its author's handle", async () => {
    _setTestClient(makeFakeClient({
      ...base(),
      event_updates: { rows: [{ id: "u1", event_id: ID.ev1, author_id: ID.other, body: "see you", pinned: false, created_at: "2026-01-01" }] },
    }), true);
    const r = await req(port, "GET", `/api/events/${ID.ev1}/comments`, null, ID.going);
    assert.equal(r.status, 200);
    assert.equal(r.body.updates[0].body, "see you");
    assert.equal(r.body.updates[0].author.handle, "poster");
    assert.equal(r.body.updates[0].author.displayName, null);
  });
});

// ── Meetup invites inbox ──────────────────────────────────────────────────────

describe("GET /api/me/meetup-invites", () => {
  it("an unreadable invites table is an error, never an empty inbox", async () => {
    _setTestClient(makeFakeClient({ meetup_invites: { rows: [], readError: "relation unavailable" } }), true);
    const r = await req(port, "GET", "/api/me/meetup-invites", null, ID.going);
    assert.equal(r.status, 500, JSON.stringify(r.body));
    assert.equal(r.body.invites, undefined);
  });

  it("lists a pending invite", async () => {
    _setTestClient(makeFakeClient({
      meetup_invites: { rows: [{ id: "i1", meetup_id: ID.meetup, user_id: ID.going, status: "pending", invited_at: "2026-01-01" }] },
      meetups: { rows: [{ id: ID.meetup, title: "Tapas", creator_id: ID.host, status: "active" }] },
      profiles: { rows: [{ id: ID.host, handle: "hosty", name: "H", avatar_url: null }] },
    }), true);
    const r = await req(port, "GET", "/api/me/meetup-invites", null, ID.going);
    assert.equal(r.status, 200);
    assert.equal(r.body.invites.length, 1);
    assert.equal(r.body.invites[0].meetup.title, "Tapas");
  });
});
