/**
 * Events routes — backend tests
 *
 * Tests cover:
 * - Create event (draft / publishNow)
 * - RSVP state machine (going → capacity → waitlist redirect)
 * - Waitlist join, leave, promotion on RSVP cancellation
 * - Host-only role mutations (assign co_host, moderator, ban)
 * - Ban prevents future RSVP
 * - Age gate enforcement
 * - Trust score gate
 * - Invite-only requires approved join request
 * - Attendance confirmation and no-show
 * - Host approval flow for join requests
 * - Event listing and GET detail
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { runSweep } from "../lib/eventWaitlistSweeper.js";

// ── Fake Supabase builder ─────────────────────────────────────────────────────

interface Row { [k: string]: any; }

interface FakeTable {
  rows: Row[];
  nextInsertError?: string;
}

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags: tables.feature_flags ?? { rows: [
      { flag: "events_enabled",              enabled: true },
      { flag: "events_waitlist_enabled",     enabled: true },
      { flag: "events_chat_enabled",         enabled: true },
      { flag: "events_trust_gates_enabled",  enabled: true },
      { flag: "trust_engine_enabled",        enabled: false },
    ]},
    events:               tables.events               ?? { rows: [] },
    event_rsvps:          tables.event_rsvps          ?? { rows: [] },
    event_waitlist:       tables.event_waitlist        ?? { rows: [] },
    event_roles:          tables.event_roles           ?? { rows: [] },
    event_attendee_states:tables.event_attendee_states ?? { rows: [] },
    event_join_requests:  tables.event_join_requests   ?? { rows: [] },
    event_updates:        tables.event_updates         ?? { rows: [] },
    profiles:             tables.profiles              ?? { rows: [] },
    blocks:               tables.blocks               ?? { rows: [] },
    user_friendships:     tables.user_friendships      ?? { rows: [] },
    trust_events:         tables.trust_events          ?? { rows: [] },
    trust_profiles:       tables.trust_profiles        ?? { rows: [] },
    trust_settings:       tables.trust_settings        ?? { rows: [] },
    trust_caps:           tables.trust_caps            ?? { rows: [] },
    message_threads:      tables.message_threads       ?? { rows: [] },
    message_thread_members:tables.message_thread_members ?? { rows: [] },
  };

  function chain(tableName: string, filtered: Row[]) {
    let limitCount: number | null = null;
    let singleMode = false;
    // Deferred mutations — stored when called, executed in .then() after all
    // filters have been accumulated (mirrors real Supabase SDK lazy evaluation).
    let pendingOp: null | { type: "delete" } | { type: "update"; data: Row } = null;

    const obj: any = {
      select()  { return obj; },
      insert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        if (table.nextInsertError) {
          const msg = table.nextInsertError;
          table.nextInsertError = undefined;
          return Promise.resolve({ data: null, error: { message: msg } });
        }
        const newRows = Array.isArray(data) ? data : [data];
        for (const r of newRows) {
          const row = { id: `fake-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2)}`, ...r };
          table.rows.push(row);
          filtered = [row];
        }
        return obj;
      },
      upsert(data: Row | Row[], _opts?: any) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        const newRows = Array.isArray(data) ? data : [data];
        for (const r of newRows) {
          const idx = table.rows.findIndex((row) => {
            if (row.flag !== undefined && r.flag !== undefined) return row.flag === r.flag;
            if (r.event_id !== undefined && r.user_id !== undefined)
              return row.event_id === r.event_id && row.user_id === r.user_id;
            if (r.user_id !== undefined && r.event_id === undefined)
              return row.user_id === r.user_id;
            return false;
          });
          if (idx >= 0) { table.rows[idx] = { ...table.rows[idx], ...r }; filtered = [table.rows[idx]]; }
          else { const row = { id: `fake-${tableName}-${Date.now()}`, ...r }; table.rows.push(row); filtered = [row]; }
        }
        return obj;
      },
      // Lazy: store the mutation, apply it in .then() after filters are applied
      update(data: Row) { pendingOp = { type: "update", data }; return obj; },
      delete()          { pendingOp = { type: "delete" }; return obj; },
      eq(col: string, val: any)    { filtered = filtered.filter((r) => r[col] === val); return obj; },
      neq(col: string, val: any)   { filtered = filtered.filter((r) => r[col] !== val); return obj; },
      gt(col: string, val: any)    { filtered = filtered.filter((r) => r[col] != null && r[col] > val); return obj; },
      gte(col: string, val: any)   { filtered = filtered.filter((r) => r[col] != null && r[col] >= val); return obj; },
      lt(col: string, val: any)    { filtered = filtered.filter((r) => r[col] != null && r[col] < val); return obj; },
      lte(col: string, val: any)   { filtered = filtered.filter((r) => r[col] != null && r[col] <= val); return obj; },
      in(col: string, vals: any[]) { filtered = filtered.filter((r) => vals.includes(r[col])); return obj; },
      not(col: string, op: string, val: any) {
        if (op === "is") filtered = filtered.filter((r) => r[col] !== null && r[col] !== undefined);
        else if (op === "in") {
          const raw = String(val).replace(/^\("|"\)$|^\(|"\)$/g, '');
          const vals = raw.split('","').map((s) => s.replace(/^"|"$/g, ''));
          filtered = filtered.filter((r) => !vals.includes(String(r[col])));
        }
        return obj;
      },
      is(col: string, val: any) {
        filtered = filtered.filter((r) =>
          val === null ? (r[col] === null || r[col] === undefined) : r[col] === val,
        );
        return obj;
      },
      or() { return obj; },
      ilike(col: string, pattern: string) {
        const q = pattern.replace(/%/g, '').toLowerCase();
        filtered = filtered.filter((r) => String(r[col] ?? '').toLowerCase().includes(q));
        return obj;
      },
      order() { return obj; },
      limit(n: number) { limitCount = n; return obj; },
      range(from: number, to: number) { filtered = filtered.slice(from, to + 1); return obj; },
      single() {
        singleMode = true;
        const row = filtered[0] ?? null;
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "No rows" } });
      },
      maybeSingle() {
        singleMode = true;
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: any, reject: any) {
        // Execute any deferred mutation now that all filters have been applied
        if (pendingOp) {
          const table = db[tableName] ?? { rows: [] };
          if (pendingOp.type === "delete") {
            const toDelete = new Set(filtered.map((r) => r.id));
            table.rows = table.rows.filter((r) => !toDelete.has(r.id));
            filtered = [];
          } else if (pendingOp.type === "update") {
            const updateData = (pendingOp as { type: "update"; data: Row }).data;
            filtered = filtered.map((row) => {
              const idx = table.rows.findIndex((r) => r === row || r.id === row.id);
              if (idx >= 0) { table.rows[idx] = { ...table.rows[idx], ...updateData }; return table.rows[idx]; }
              return { ...row, ...updateData };
            });
          }
          pendingOp = null;
        }
        const data = singleMode
          ? (filtered[0] ?? null)
          : (limitCount !== null ? filtered.slice(0, limitCount) : filtered);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return obj;
  }

  return {
    from(tableName: string) {
      const table = db[tableName] ?? (db[tableName] = { rows: [] });
      return chain(tableName, [...table.rows]);
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

// ── UUID constants (all IDs must be valid UUIDs for isUuid() to pass) ─────────

const ID = {
  ev1:           "00000000-0000-0000-0000-000000000001",
  ev2:           "00000000-0000-0000-0000-000000000002",
  host1:         "00000000-0000-0000-0001-000000000001",
  other_host:    "00000000-0000-0000-0001-000000000002",
  user1:         "00000000-0000-0000-0002-000000000001",
  user2:         "00000000-0000-0000-0002-000000000002",
  user3:         "00000000-0000-0000-0002-000000000003",
  banned_user:   "00000000-0000-0000-0002-000000000004",
  young_user:    "00000000-0000-0000-0002-000000000005",
  adult_user:    "00000000-0000-0000-0002-000000000006",
  low_trust:     "00000000-0000-0000-0002-000000000007",
  high_trust:    "00000000-0000-0000-0002-000000000008",
  unapproved:    "00000000-0000-0000-0002-000000000009",
  approved_user: "00000000-0000-0000-0002-000000000010",
  random_user:   "00000000-0000-0000-0002-000000000011",
  attendee1:     "00000000-0000-0000-0002-000000000012",
  requester:     "00000000-0000-0000-0002-000000000013",
  noshowuser:    "00000000-0000-0000-0002-000000000014",
  rsvp1:         "00000000-0000-0000-0003-000000000001",
  wl1:           "00000000-0000-0000-0003-000000000002",
  jr1:           "00000000-0000-0000-0003-000000000003",
  role1:         "00000000-0000-0000-0003-000000000004",
  tp1:           "00000000-0000-0000-0003-000000000005",
  tp2:           "00000000-0000-0000-0003-000000000006",
} as const;

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<Row> = {}): Row {
  return {
    id: ID.ev1,
    host_id: ID.host1,
    title: "Test Event",
    description: null,
    location_name: "Test Venue",
    starts_at: new Date(Date.now() + 86400000).toISOString(),
    ends_at: null,
    cover_url: null,
    max_attendees: 5,
    age_min: null,
    age_max: null,
    trust_score_min: null,
    verified_only: false,
    visibility: "public",
    state: "open",
    chat_enabled: false,
    chat_thread_id: null,
    waitlist_enabled: true,
    price_type: "free",
    price_url: null,
    rsvp_options: ["going","maybe","interested","cant_go"],
    going_count: 0,
    waitlist_count: 0,
    category: "test",
    city: "Testville",
    country: "Testland",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function tok(userId: string) { return `fake-token-${userId}`; }

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())),
      });
    });
    srv.on("error", reject);
  });
}

async function apiReq(
  port: number,
  method: string,
  path: string,
  body: unknown,
  userId: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${tok(userId)}`,
    },
    body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Events — create event", () => {
  it("creates a draft event", async () => {
    const client = makeFakeClient();
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", "/api/events", { title: "My Event", city: "Bangkok", publishNow: false }, ID.host1);
      assert.equal(r.status, 201);
      assert.equal(r.body.state, "draft");
      assert.equal(r.body.title, "My Event");
    } finally { await close(); }
  });

  it("creates an open event when publishNow=true", async () => {
    const client = makeFakeClient();
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", "/api/events", { title: "Open Event", publishNow: true }, ID.host1);
      assert.equal(r.status, 201);
      assert.equal(r.body.state, "open");
    } finally { await close(); }
  });

  it("rejects invalid ageMin/ageMax", async () => {
    const client = makeFakeClient();
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", "/api/events", { title: "Age Event", ageMin: 30, ageMax: 20, publishNow: true }, ID.host1);
      assert.equal(r.status, 400);
      assert.ok(r.body.error);
    } finally { await close(); }
  });
});

describe("Events — RSVP state machine", () => {
  function makeClientFull() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, max_attendees: 2, going_count: 0, state: "open" })] },
    });
  }

  it("RSVPs Going when event has capacity", async () => {
    _setTestClient(makeClientFull(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "going");
    } finally { await close(); }
  });

  it("redirects to waitlist when event is full", async () => {
    const c = makeClientFull();
    c._db.events.rows[0].state = "full";
    c._db.events.rows[0].going_count = 2;
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user3);
      assert.equal(r.status, 202);
      assert.equal(r.body.status, "waitlisted");
    } finally { await close(); }
  });

  it("rejects RSVP on cancelled event", async () => {
    const c = makeClientFull();
    c._db.events.rows[0].state = "cancelled";
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("rejects RSVP on completed event", async () => {
    const c = makeClientFull();
    c._db.events.rows[0].state = "completed";
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });
});

describe("Events — waitlist promotion on RSVP cancellation", () => {
  it("sets offer_expires_at on waitlisted user after cancellation", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, max_attendees: 1, going_count: 1, state: "waitlist" })] },
      event_rsvps: { rows: [{ id: "r1", event_id: ID.ev1, user_id: ID.user1, status: "going", updated_at: new Date().toISOString() }] },
      event_waitlist: { rows: [{ id: ID.wl1, event_id: ID.ev1, user_id: ID.user2, position: 1, offer_expires_at: null }] },
      profiles: { rows: [
        { id: ID.user1, handle: "u1", name: "User One", avatar_url: null, expo_push_token: null },
        { id: ID.user2, handle: "u2", name: "User Two", avatar_url: null, expo_push_token: null },
      ]},
    });
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "DELETE", `/api/events/${ID.ev1}/rsvp`, null, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      const wl = client._db.event_waitlist.rows.find((r: any) => r.user_id === ID.user2);
      assert.ok(wl?.offer_expires_at, "waitlisted user should have offer_expires_at set");
    } finally { await close(); }
  });
});

describe("Events — host-only role mutations", () => {
  function makeRoleClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, host_id: ID.host1 })] },
      event_roles: { rows: [] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
    });
  }

  it("host can assign co_host role", async () => {
    _setTestClient(makeRoleClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/roles`, { userId: ID.user2, role: "co_host" }, ID.host1);
      assert.equal(r.status, 200);
      assert.equal(r.body.role, "co_host");
    } finally { await close(); }
  });

  it("non-host cannot assign roles", async () => {
    _setTestClient(makeRoleClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/roles`, { userId: ID.user3, role: "moderator" }, ID.user2);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("host can assign banned role and RSVP is removed", async () => {
    const c = makeRoleClient();
    c._db.event_rsvps.rows.push({ id: ID.rsvp1, event_id: ID.ev1, user_id: ID.user2, status: "going" });
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/roles`, { userId: ID.user2, role: "banned" }, ID.host1);
      assert.equal(r.status, 200);
      assert.equal(r.body.role, "banned");
      const rsvp = c._db.event_rsvps.rows.find((r: any) => r.user_id === ID.user2 && r.event_id === ID.ev1);
      assert.equal(rsvp, undefined, "RSVP should be removed on ban");
    } finally { await close(); }
  });
});

describe("Events — ban prevents RSVP", () => {
  it("banned user cannot RSVP", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, host_id: ID.host1 })] },
      event_roles: { rows: [{ id: ID.role1, event_id: ID.ev1, user_id: ID.banned_user, role: "banned" }] },
    });
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.banned_user);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });
});

describe("Events — age gate enforcement", () => {
  function makeAgeClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, age_min: 21, age_max: null })] },
      profiles: { rows: [
        { id: ID.young_user, handle: "youngster", name: "Young", avatar_url: null,
          date_of_birth: new Date(Date.now() - 18 * 365.25 * 24 * 3600 * 1000).toISOString().split('T')[0] },
        { id: ID.adult_user, handle: "adult", name: "Adult", avatar_url: null,
          date_of_birth: new Date(Date.now() - 25 * 365.25 * 24 * 3600 * 1000).toISOString().split('T')[0] },
      ]},
    });
  }

  it("rejects RSVP from user below age minimum", async () => {
    _setTestClient(makeAgeClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.young_user);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("allows RSVP from user meeting age minimum", async () => {
    _setTestClient(makeAgeClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.adult_user);
      assert.equal(r.status, 200);
    } finally { await close(); }
  });
});

describe("Events — trust score gate", () => {
  function makeTrustClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, trust_score_min: 70 })] },
      trust_profiles: { rows: [
        { id: ID.tp1, user_id: ID.low_trust,  overall_score: 45 },
        { id: ID.tp2, user_id: ID.high_trust, overall_score: 80 },
      ]},
    });
  }

  it("rejects RSVP from user with insufficient trust score", async () => {
    _setTestClient(makeTrustClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.low_trust);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("allows RSVP from user with sufficient trust score", async () => {
    _setTestClient(makeTrustClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.high_trust);
      assert.equal(r.status, 200);
    } finally { await close(); }
  });
});

describe("Events — invite-only requires approved request", () => {
  function makeInviteClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, visibility: "invite_only" })] },
      event_join_requests: { rows: [
        { id: ID.jr1, event_id: ID.ev1, user_id: ID.approved_user, status: "approved" },
      ]},
    });
  }

  it("rejects RSVP from user without approved request", async () => {
    _setTestClient(makeInviteClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.unapproved);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("allows RSVP from user with approved request", async () => {
    _setTestClient(makeInviteClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.approved_user);
      assert.equal(r.status, 200);
    } finally { await close(); }
  });
});

describe("Events — attendance confirmation and no-show", () => {
  function makeAttendanceClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, host_id: ID.host1, state: "started" })] },
      event_rsvps: { rows: [{ id: ID.rsvp1, event_id: ID.ev1, user_id: ID.attendee1, status: "going" }] },
      profiles: { rows: [
        { id: ID.attendee1, handle: "att", name: "Attendee", avatar_url: null },
        { id: ID.host1, handle: "host", name: "Host", avatar_url: null },
      ]},
    });
  }

  it("host can confirm attendance", async () => {
    const c = makeAttendanceClient();
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/attendance/${ID.attendee1}`, null, ID.host1);
      assert.equal(r.status, 200);
      assert.ok(r.body.confirmedAt);
      const state = c._db.event_attendee_states.rows.find((r: any) => r.user_id === ID.attendee1);
      assert.ok(state?.confirmed_at);
    } finally { await close(); }
  });

  it("non-host cannot confirm attendance", async () => {
    _setTestClient(makeAttendanceClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/attendance/${ID.attendee1}`, null, ID.random_user);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });

  it("host can mark a no-show", async () => {
    const c = makeAttendanceClient();
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/noshow/${ID.attendee1}`, null, ID.host1);
      assert.equal(r.status, 200);
      assert.ok(r.body.noShowAt);
      const state = c._db.event_attendee_states.rows.find((r: any) => r.user_id === ID.attendee1);
      assert.ok(state?.no_show_at);
    } finally { await close(); }
  });
});

describe("Events — host approval flow for join requests", () => {
  function makeJoinReqClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "invite_only" })] },
      profiles: { rows: [
        { id: ID.requester, handle: "req", name: "Requester", avatar_url: null, expo_push_token: null },
        { id: ID.host1, handle: "host", name: "Host", avatar_url: null, expo_push_token: null },
      ]},
    });
  }

  it("user can submit join request for invite-only event", async () => {
    _setTestClient(makeJoinReqClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/requests`, { message: "I'd love to join!" }, ID.requester);
      assert.equal(r.status, 201);
      assert.equal(r.body.status, "pending");
    } finally { await close(); }
  });

  it("host can approve join request and RSVP is created", async () => {
    const c = makeJoinReqClient();
    c._db.event_join_requests.rows.push({ id: ID.jr1, event_id: ID.ev1, user_id: ID.requester, status: "pending", message: null });
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "PATCH", `/api/events/${ID.ev1}/requests/${ID.requester}`, { action: "approve" }, ID.host1);
      assert.equal(r.status, 200);
      assert.equal(r.body.action, "approve");
      const rsvp = c._db.event_rsvps.rows.find((r: any) => r.user_id === ID.requester && r.event_id === ID.ev1);
      assert.ok(rsvp);
      assert.equal(rsvp.status, "going");
    } finally { await close(); }
  });

  it("non-host cannot view join requests", async () => {
    _setTestClient(makeJoinReqClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", `/api/events/${ID.ev1}/requests`, null, ID.random_user);
      assert.equal(r.status, 403);
    } finally { await close(); }
  });
});

describe("Events — waitlist join, leave, and positions", () => {
  function makeWaitlistClient() {
    return makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, state: "waitlist", max_attendees: 1, going_count: 1 })] },
    });
  }

  it("user can join waitlist when event is full", async () => {
    _setTestClient(makeWaitlistClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/waitlist`, null, ID.user1);
      assert.equal(r.status, 201);
      assert.equal(r.body.position, 1);
    } finally { await close(); }
  });

  it("second user gets position 2", async () => {
    _setTestClient(makeWaitlistClient(), true);
    const { port, close } = await startServer();
    try {
      await apiReq(port, "POST", `/api/events/${ID.ev1}/waitlist`, null, ID.user1);
      const r = await apiReq(port, "POST", `/api/events/${ID.ev1}/waitlist`, null, ID.user2);
      assert.equal(r.status, 201);
      assert.equal(r.body.position, 2);
    } finally { await close(); }
  });

  it("user can leave waitlist", async () => {
    const c = makeWaitlistClient();
    _setTestClient(c, true);
    const { port, close } = await startServer();
    try {
      await apiReq(port, "POST", `/api/events/${ID.ev1}/waitlist`, null, ID.user1);
      const r = await apiReq(port, "DELETE", `/api/events/${ID.ev1}/waitlist`, null, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, true);
      const remaining = c._db.event_waitlist.rows.filter((r: any) => r.user_id === ID.user1);
      assert.equal(remaining.length, 0);
    } finally { await close(); }
  });
});

describe("Events — listing and GET detail", () => {
  function makeListClient() {
    return makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, state: "open", visibility: "public" }),
        makeEvent({ id: ID.ev2, state: "draft", visibility: "public", host_id: ID.other_host }),
      ]},
      profiles: { rows: [{ id: ID.host1, handle: "host", name: "Host User", avatar_url: null }] },
    });
  }

  it("GET /api/events returns open public events", async () => {
    _setTestClient(makeListClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", "/api/events?state=open", null, ID.user1);
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body.events));
      assert.equal(r.body.events.length, 1);
      assert.equal(r.body.events[0].id, ID.ev1);
    } finally { await close(); }
  });

  it("GET /api/events/:id returns event detail for open event", async () => {
    _setTestClient(makeListClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.id, ID.ev1);
      assert.ok("counts" in r.body);
      assert.ok("myRsvp" in r.body);
    } finally { await close(); }
  });

  it("GET /api/events/:id returns 404 for draft viewed by non-host", async () => {
    _setTestClient(makeListClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", `/api/events/${ID.ev2}`, null, ID.user1);
      assert.equal(r.status, 404);
    } finally { await close(); }
  });

  it("host can GET their own draft event", async () => {
    _setTestClient(makeListClient(), true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", `/api/events/${ID.ev2}`, null, ID.other_host);
      assert.equal(r.status, 200);
      assert.equal(r.body.id, ID.ev2);
    } finally { await close(); }
  });
});

// ── Waitlist expiry sweep ──────────────────────────────────────────────────────

describe("Events — waitlist expiry sweep", () => {
  it("runSweep removes expired offer holders and promotes next user", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const client = makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, state: "waitlist" })] },
      event_waitlist: { rows: [
        // user1 had an offer that expired
        { id: ID.wl1, event_id: ID.ev1, user_id: ID.user1, position: 1, offer_expires_at: expiredAt },
        // user2 is next in queue with no offer yet
        { id: "wl2", event_id: ID.ev1, user_id: ID.user2, position: 2, offer_expires_at: null },
      ]},
      profiles: { rows: [
        { id: ID.user1, handle: "u1", expo_push_token: null },
        { id: ID.user2, handle: "u2", expo_push_token: null },
      ]},
    });
    _setTestClient(client, true);

    await runSweep();

    // user1 should have been removed (deleted, not just nulled)
    const u1Row = client._db.event_waitlist.rows.find((r: any) => r.user_id === ID.user1);
    assert.ok(!u1Row, "expired offer holder should be deleted from queue");

    // user2 should now have an offer_expires_at set
    const u2Row = client._db.event_waitlist.rows.find((r: any) => r.user_id === ID.user2);
    assert.ok(u2Row?.offer_expires_at, "next user should receive a spot offer");
  });

  it("expired offer holder cannot be re-promoted on the same sweep", async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const client = makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, state: "waitlist" })] },
      event_waitlist: { rows: [
        { id: ID.wl1, event_id: ID.ev1, user_id: ID.user1, position: 1, offer_expires_at: expiredAt },
        // no other users on waitlist
      ]},
      profiles: { rows: [{ id: ID.user1, handle: "u1", expo_push_token: null }] },
    });
    _setTestClient(client, true);

    await runSweep();

    // user1 should be gone, queue should be empty
    assert.equal(client._db.event_waitlist.rows.length, 0, "queue should be empty after expiry with no successor");
  });
});

// ── Block enforcement on event reads ──────────────────────────────────────────

describe("Events — block enforcement on read", () => {
  it("blocked user gets 404 on GET /api/events/:id", async () => {
    const client = makeFakeClient({
      events: { rows: [makeEvent({ id: ID.ev1, host_id: ID.host1 })] },
      blocks: { rows: [
        // user1 blocked host1 (or host1 blocked user1)
        { id: "b1", blocker_id: ID.user1, blocked_id: ID.host1 },
      ]},
      profiles: { rows: [{ id: ID.host1, handle: "h1", name: "Host", avatar_url: null }] },
    });
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
      assert.equal(r.status, 404);
    } finally { await close(); }
  });
});

// ── Trust / age gate enforcement on listing ───────────────────────────────────

describe("Events — trust gates filter listing", () => {
  it("age-gated event is hidden from listing for viewer without DOB", async () => {
    const client = makeFakeClient({
      feature_flags: { rows: [
        { flag: "events_enabled",             enabled: true },
        { flag: "events_waitlist_enabled",    enabled: true },
        { flag: "events_chat_enabled",        enabled: true },
        { flag: "events_trust_gates_enabled", enabled: true },  // gates ON
        { flag: "trust_engine_enabled",       enabled: false },
      ]},
      events: { rows: [
        makeEvent({ id: ID.ev1, state: "open", visibility: "public", age_min: 21 }),
      ]},
      profiles: { rows: [
        { id: ID.user1, handle: "u1", date_of_birth: null, is_verified: false },
        { id: ID.host1, handle: "h1", name: "Host", avatar_url: null },
      ]},
    });
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", "/api/events?state=open", null, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.events.length, 0, "age-gated event should not appear for viewer without DOB");
    } finally { await close(); }
  });

  it("age-gated event appears for eligible viewer with matching age", async () => {
    const dob = new Date(Date.now() - 25 * 365.25 * 24 * 60 * 60 * 1000).toISOString(); // 25 years ago
    const client = makeFakeClient({
      feature_flags: { rows: [
        { flag: "events_enabled",             enabled: true },
        { flag: "events_waitlist_enabled",    enabled: true },
        { flag: "events_chat_enabled",        enabled: true },
        { flag: "events_trust_gates_enabled", enabled: true },
        { flag: "trust_engine_enabled",       enabled: false },
      ]},
      events: { rows: [
        makeEvent({ id: ID.ev1, state: "open", visibility: "public", age_min: 21 }),
      ]},
      profiles: { rows: [
        { id: ID.user1, handle: "u1", date_of_birth: dob, is_verified: false },
        { id: ID.host1, handle: "h1", name: "Host", avatar_url: null },
      ]},
    });
    _setTestClient(client, true);
    const { port, close } = await startServer();
    try {
      const r = await apiReq(port, "GET", "/api/events?state=open", null, ID.user1);
      assert.equal(r.status, 200);
      assert.equal(r.body.events.length, 1, "eligible viewer should see the event");
    } finally { await close(); }
  });
});
