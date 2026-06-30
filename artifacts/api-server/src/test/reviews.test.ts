/**
 * Reviews & Appeals backend tests
 *
 * Covers:
 *  - Review blocked without confirmed attendance (review_not_eligible)
 *  - Duplicate review blocked (duplicate_review — one per entity per user)
 *  - Review trust event fires through recordTrustEvent (not direct score write)
 *  - Appeal create → state transition submitted → under_review → approved with reversal
 *  - Appeal blocked when one is already active for the same target (appeal_already_active)
 *  - Admin-only appeal queue access (GET /api/appeals)
 *  - Non-admin cannot access the admin queue
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Row { [k: string]: any; }
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}, opts: { adminUserId?: string } = {}) {
  const db: Record<string, FakeTable> = {
    event_attendee_states:  tables.event_attendee_states  ?? { rows: [] },
    trip_members:           tables.trip_members           ?? { rows: [] },
    rent_buddy_bookings:    tables.rent_buddy_bookings    ?? { rows: [] },
    reviews:                tables.reviews                ?? { rows: [] },
    appeals:                tables.appeals                ?? { rows: [] },
    trust_events:           tables.trust_events           ?? { rows: [] },
    trust_profiles:         tables.trust_profiles         ?? { rows: [] },
    trust_settings:         tables.trust_settings         ?? { rows: [] },
    trust_caps:             tables.trust_caps             ?? { rows: [] },
    profiles:               tables.profiles               ?? { rows: [
      { id: "admin-user-1", role: "admin" },
      { id: "regular-user-1", role: "user" },
    ]},
    notifications:          tables.notifications          ?? { rows: [] },
    events:                 tables.events                 ?? { rows: [] },
    trips:                  tables.trips                  ?? { rows: [] },
    feature_flags:          tables.feature_flags          ?? { rows: [] },
    reports:                tables.reports                ?? { rows: [] },
    ...tables,
  };

  const inserted: Array<{ table: string; row: Row }> = [];
  (client as any)._inserted = inserted;

  function from(table: string) {
    const t = db[table] ?? { rows: [] };
    const filters: Array<(r: any) => boolean> = [];
    let _upsert = false;
    let _conflict = "";
    let pendingInsert: Row | null = null;
    let pendingUpdate: Row | null = null;
    let _selectCols = "*";
    let _limit: number | null = null;
    let _range: [number, number] | null = null;
    let _notFilter: Array<(r: any) => boolean> = [];

    const builder: any = {
      select(cols?: string) { _selectCols = cols ?? "*"; return builder; },
      insert(row: Row) {
        pendingInsert = row;
        return builder;
      },
      upsert(row: Row, opts?: any) {
        _upsert = true;
        if (opts?.onConflict) _conflict = opts.onConflict;
        pendingInsert = row;
        return builder;
      },
      update(patch: Row) { pendingUpdate = patch; return builder; },
      delete() { return builder; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return builder; },
      not(col: string, op: string, val: any) {
        if (op === "is" && val === null) _notFilter.push((r) => r[col] != null);
        return builder;
      },
      or() { return builder; },
      order() { return builder; },
      limit(n: number) { _limit = n; return builder; },
      range(from: number, to: number) { _range = [from, to]; return builder; },
      maybeSingle() { return resolveOne(true); },
      single() { return resolveOne(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function matchedRows() {
      return t.rows.filter((r) => [...filters, ..._notFilter].every((f) => f(r)));
    }

    function resolveOne(maybeNull: boolean): Promise<{ data: Row | null; error: any; count?: number }> {
      if (pendingInsert) {
        if (t.nextInsertError) {
          const err = { message: t.nextInsertError, code: t.nextInsertError === "unique" ? "23505" : "PGRST000" };
          t.nextInsertError = undefined;
          return Promise.resolve({ data: null, error: err });
        }
        const row = { id: `generated-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString(), ...pendingInsert };
        t.rows.push(row);
        inserted.push({ table, row });
        return Promise.resolve({ data: row, error: null });
      }
      if (pendingUpdate) {
        const rows = matchedRows();
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      }
      const rows = matchedRows();
      if (!maybeNull && rows.length === 0) return Promise.resolve({ data: null, error: { message: "no rows" } });
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }

    function resolveList(): Promise<{ data: Row[]; error: any; count?: number }> {
      if (pendingInsert) {
        if (t.nextInsertError) {
          const err = { message: t.nextInsertError, code: t.nextInsertError === "unique" ? "23505" : "PGRST000" };
          t.nextInsertError = undefined;
          return Promise.resolve({ data: [], error: err });
        }
        const row = { id: `generated-${Date.now()}-${Math.random()}`, created_at: new Date().toISOString(), ...pendingInsert };
        t.rows.push(row);
        inserted.push({ table, row });
        return Promise.resolve({ data: [row], error: null, count: 1 });
      }
      if (pendingUpdate) {
        const rows = matchedRows();
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        return Promise.resolve({ data: rows, error: null });
      }
      let rows = matchedRows();
      if (_range) rows = rows.slice(_range[0], _range[1] + 1);
      else if (_limit !== null) rows = rows.slice(0, _limit);
      return Promise.resolve({ data: rows, error: null, count: rows.length });
    }

    return builder;
  }

  const client: any = {
    auth: {
      getUser(token?: string) {
        if (!token) return Promise.resolve({ data: { user: null }, error: { message: "no token" } });
        const userId = token === "admin-token" ? "admin-user-1" : "regular-user-1";
        return Promise.resolve({ data: { user: { id: userId } }, error: null });
      },
    },
    from,
    rpc() { return Promise.resolve({ data: null, error: null }); },
  };

  return client;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function post(server: Server, path: string, body: any, token = "regular-token") {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const payload = JSON.stringify(body);
    const req = require("node:http").request(
      { method: "POST", path, port: (server.address() as any).port, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }));
      },
    );
    req.write(payload);
    req.end();
  });
}

function get(server: Server, path: string, token = "regular-token") {
  return new Promise<{ status: number; body: any }>((resolve) => {
    require("node:http").request(
      { method: "GET", path, port: (server.address() as any).port, headers: { authorization: `Bearer ${token}` } },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }));
      },
    ).end();
  });
}

function patch(server: Server, path: string, body: any, token = "admin-token") {
  return new Promise<{ status: number; body: any }>((resolve) => {
    const payload = JSON.stringify(body);
    require("node:http").request(
      { method: "PATCH", path, port: (server.address() as any).port, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }));
      },
    ).end(() => {}).write && (() => {})();
    const r2 = require("node:http").request(
      { method: "PATCH", path, port: (server.address() as any).port, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), authorization: `Bearer ${token}` } },
      (res: any) => {
        let buf = "";
        res.on("data", (c: any) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf || "{}") }));
      },
    );
    r2.write(payload);
    r2.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Reviews API", () => {
  let server: Server;
  let fakeClient: any;

  beforeEach(() => {
    fakeClient = makeFakeClient();
    _setTestClient(fakeClient, true);
    server = createServer(app).listen(0);
  });

  afterEach(() => {
    server.close();
    _setTestClient(null as any, false);
  });

  it("blocks review without confirmed attendance (trip)", async () => {
    // trip_members table is empty — user is not a member
    const res = await post(server, "/api/reviews", {
      entityType: "trip",
      entityId:   "00000000-0000-0000-0000-000000000001",
      rating: 4,
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "review_not_eligible");
  });

  it("allows review when user is a confirmed trip member", async () => {
    const entityId = "00000000-0000-0000-0000-000000000002";
    fakeClient = makeFakeClient({
      trip_members: { rows: [{ id: "m1", trip_id: entityId, user_id: "regular-user-1", role: "member" }] },
      reviews: { rows: [] },
      trust_events: { rows: [] },
    });
    _setTestClient(fakeClient, true);

    const res = await post(server, "/api/reviews", {
      entityType: "trip",
      entityId,
      rating: 5,
      body: "Great trip!",
      tags: ["friendly", "well_planned"],
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.rating, 5);
  });

  it("blocks duplicate review for same entity", async () => {
    const entityId = "00000000-0000-0000-0000-000000000003";
    const reviews: any = { rows: [], nextInsertError: undefined };
    fakeClient = makeFakeClient({
      trip_members: { rows: [{ id: "m2", trip_id: entityId, user_id: "regular-user-1", role: "member" }] },
      reviews,
      trust_events: { rows: [] },
    });
    _setTestClient(fakeClient, true);

    // First review succeeds
    const first = await post(server, "/api/reviews", {
      entityType: "trip",
      entityId,
      rating: 3,
    });
    assert.equal(first.status, 201);

    // Second review hits unique constraint
    reviews.nextInsertError = "unique";
    const second = await post(server, "/api/reviews", {
      entityType: "trip",
      entityId,
      rating: 4,
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "duplicate_review");
  });

  it("fires review_submitted trust event (not direct score write)", async () => {
    const entityId = "00000000-0000-0000-0000-000000000004";
    const trustEvents: Row[] = [];
    fakeClient = makeFakeClient({
      trip_members: { rows: [{ id: "m3", trip_id: entityId, user_id: "regular-user-1", role: "member" }] },
      reviews:       { rows: [] },
      trust_events:  { rows: trustEvents },
      trust_profiles:{ rows: [] },
      trust_settings:{ rows: [] },
      trust_caps:    { rows: [] },
    });
    _setTestClient(fakeClient, true);

    await post(server, "/api/reviews", {
      entityType: "trip",
      entityId,
      rating: 4,
    });

    // A trust_event row with event_type=review_submitted should have been inserted
    const reviewEvent = (fakeClient as any)._inserted.find(
      (i: any) => i.table === "trust_events" && i.row.event_type === "review_submitted",
    );
    assert.ok(reviewEvent, "review_submitted trust event should be recorded");
    assert.equal(reviewEvent.row.category, "community_value");
    // Verify no direct score write happened (trust_profiles not updated directly)
    const directScoreWrite = (fakeClient as any)._inserted.find(
      (i: any) => i.table === "trust_profiles" && i.row.overall_score !== undefined,
    );
    assert.equal(directScoreWrite, undefined, "trust_profiles should NOT be written directly");
  });
});

describe("Appeals API", () => {
  let server: Server;
  let fakeClient: any;

  beforeEach(() => {
    fakeClient = makeFakeClient();
    _setTestClient(fakeClient, true);
    server = createServer(app).listen(0);
  });

  afterEach(() => {
    server.close();
    _setTestClient(null as any, false);
  });

  it("user can submit an appeal", async () => {
    const res = await post(server, "/api/appeals", {
      targetType: "no_show",
      targetId:   "00000000-0000-0000-0000-000000000010",
      reason:     "I was present at the event but marked as no-show in error.",
    });
    assert.equal(res.status, 201);
    assert.ok(res.body.id);
    assert.equal(res.body.state, "submitted");
    assert.equal(res.body.targetType, "no_show");
  });

  it("blocks appeal when one is already active for the same target", async () => {
    const targetId = "00000000-0000-0000-0000-000000000011";
    const appeals: any = { rows: [], nextInsertError: undefined };
    fakeClient = makeFakeClient({ appeals });
    _setTestClient(fakeClient, true);

    const first = await post(server, "/api/appeals", {
      targetType: "no_show",
      targetId,
      reason: "First appeal with sufficient explanation text here.",
    });
    assert.equal(first.status, 201);

    appeals.nextInsertError = "unique";
    const second = await post(server, "/api/appeals", {
      targetType: "no_show",
      targetId,
      reason: "Duplicate appeal attempt for the same target.",
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, "appeal_already_active");
  });

  it("user can view their own appeals", async () => {
    fakeClient = makeFakeClient({
      appeals: { rows: [
        {
          id: "appeal-1",
          appellant_id: "regular-user-1",
          target_type: "no_show",
          target_id: "00000000-0000-0000-0000-000000000020",
          reason: "I was there.",
          evidence_url: null,
          state: "submitted",
          moderator_id: null,
          resolution_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]},
    });
    _setTestClient(fakeClient, true);

    const res = await get(server, "/api/appeals/me");
    assert.equal(res.status, 200);
    assert.equal(res.body.appeals.length, 1);
    assert.equal(res.body.appeals[0].state, "submitted");
  });

  it("non-admin cannot access admin appeal queue", async () => {
    const res = await get(server, "/api/appeals", "regular-token");
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "forbidden");
  });

  it("admin can view the full appeal queue", async () => {
    fakeClient = makeFakeClient({
      profiles: { rows: [
        { id: "admin-user-1", role: "admin" },
        { id: "regular-user-1", role: "user" },
      ]},
      appeals: { rows: [
        {
          id: "appeal-2",
          appellant_id: "regular-user-1",
          target_type: "trust_score_event",
          target_id: "00000000-0000-0000-0000-000000000030",
          reason: "This trust event was incorrect.",
          evidence_url: null,
          state: "submitted",
          moderator_id: null,
          resolution_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          profiles: { handle: "user1", display_name: "User One", avatar_url: null },
        },
      ]},
    });
    _setTestClient(fakeClient, true);

    const res = await get(server, "/api/appeals", "admin-token");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.appeals));
  });

  it("admin can approve an appeal and reversal runs", async () => {
    const appealId = "00000000-0000-0000-0000-000000000040";
    const trustEvents: Row[] = [
      { id: "00000000-0000-0000-0000-000000000041", user_id: "regular-user-1", event_type: "PLAN_NO_SHOW", status: "confirmed" },
    ];
    fakeClient = makeFakeClient({
      profiles: { rows: [
        { id: "admin-user-1", role: "admin" },
        { id: "regular-user-1", role: "user" },
      ]},
      appeals: { rows: [
        {
          id: appealId,
          appellant_id: "regular-user-1",
          target_type: "trust_score_event",
          target_id: "00000000-0000-0000-0000-000000000041",
          reason: "The no-show was recorded in error.",
          evidence_url: null,
          state: "submitted",
          moderator_id: null,
          resolution_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]},
      trust_events: { rows: trustEvents },
      notifications: { rows: [] },
    });
    _setTestClient(fakeClient, true);

    const res = await patch(server, `/api/appeals/${appealId}`, {
      state: "approved",
      resolutionNote: "Verified no-show was an error.",
    });

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "approved");

    // trust_event should be dismissed
    const dismissedEvent = trustEvents.find((e) => e.status === "dismissed");
    assert.ok(dismissedEvent, "trust_event should be dismissed on appeal approval");

    // notification should be sent to appellant
    const notif = (fakeClient as any)._inserted.find(
      (i: any) => i.table === "notifications" && i.row.notification_type === "appeal_approved",
    );
    assert.ok(notif, "appeal_approved notification should be sent");
  });

  it("admin can deny an appeal", async () => {
    const appealId = "00000000-0000-0000-0000-000000000050";
    fakeClient = makeFakeClient({
      profiles: { rows: [
        { id: "admin-user-1", role: "admin" },
        { id: "regular-user-1", role: "user" },
      ]},
      appeals: { rows: [
        {
          id: appealId,
          appellant_id: "regular-user-1",
          target_type: "no_show",
          target_id: "00000000-0000-0000-0000-000000000051",
          reason: "I was there.",
          evidence_url: null,
          state: "submitted",
          moderator_id: null,
          resolution_note: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]},
      event_attendee_states: { rows: [] },
      notifications: { rows: [] },
    });
    _setTestClient(fakeClient, true);

    const res = await patch(server, `/api/appeals/${appealId}`, {
      state: "denied",
      resolutionNote: "Attendance records confirm the no-show.",
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "denied");

    const notif = (fakeClient as any)._inserted.find(
      (i: any) => i.table === "notifications" && i.row.notification_type === "appeal_denied",
    );
    assert.ok(notif, "appeal_denied notification should be sent");
  });
});
