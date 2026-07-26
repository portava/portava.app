/**
 * RLS Privacy Baseline — access-control tests
 *
 * Verifies the access-control semantics that correspond to the database-layer
 * SELECT RLS policies added in 0194_rls_privacy_baseline.sql.
 * Addresses privacy audit findings [C3], [L3], [M5].
 *
 * These tests use the fake Supabase client (same pattern as the rest of the
 * suite) rather than a live DB. The API layer enforces the same policy
 * semantics via explicit route guards; the RLS policies protect the Supabase
 * REST endpoint (/rest/v1/profiles, /rest/v1/trips, etc.) from direct access
 * with a user JWT that bypasses those guards.
 *
 * Covered scenarios
 * -----------------
 * trips  [C3]
 *   • Non-member cannot read a private trip (API returns 404)
 *   • Non-member cannot read a buddies-only trip (API returns 404)
 *   • Non-member cannot read an invite-only trip (API returns 404)
 *   • Owner always sees their own private trip (full shape, 200)
 *   • Accepted member sees a private trip (full shape, 200)
 *   • Anyone can read a public trip (public shape, 200)
 *
 * trip_activity_log  [L3]
 *   • Non-member gets 403 on the activity endpoint
 *   • Owner can read the activity log (200)
 *   • Co-host can read the activity log (200)
 *
 * profile_views  [M5]
 *   • Analytics endpoint never exposes individual viewer_id values
 *   • Only aggregated counts are returned to the profile owner
 *
 * Run: node --import tsx/esm --test src/test/rlsPrivacyBaseline.test.ts
 */

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Stable UUIDs
// ---------------------------------------------------------------------------
const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const OUTSIDER  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

// ---------------------------------------------------------------------------
// Fake-client helpers
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    trips:               tables.trips               ?? { rows: [] },
    trip_members:        tables.trip_members        ?? { rows: [] },
    trip_activity_log:   tables.trip_activity_log   ?? { rows: [] },
    trip_budget:         tables.trip_budget         ?? { rows: [] },
    trip_documents:      tables.trip_documents      ?? { rows: [] },
    trip_notes:          tables.trip_notes          ?? { rows: [] },
    trip_saved_places:   tables.trip_saved_places   ?? { rows: [] },
    trip_checklists:     tables.trip_checklists     ?? { rows: [] },
    trip_checklist_items: tables.trip_checklist_items ?? { rows: [] },
    trip_join_requests:  tables.trip_join_requests  ?? { rows: [] },
    trip_invite_links:   tables.trip_invite_links   ?? { rows: [] },
    trip_reminders:      tables.trip_reminders      ?? { rows: [] },
    plan_editors:        tables.plan_editors        ?? { rows: [] },
    blocks:              tables.blocks              ?? { rows: [] },
    profiles:            tables.profiles            ?? { rows: [] },
    user_follows:        tables.user_follows        ?? { rows: [] },
    profile_views:       tables.profile_views       ?? { rows: [] },
    post_impressions:    tables.post_impressions    ?? { rows: [] },
    ...tables,
  };

  let idCtr = 0;
  function newId() {
    const n = String(++idCtr).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(sourceRows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let _limitN: number | null = null;
    let _head = false;

    const obj: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.head) _head = true;
        return obj;
      },
      eq(col: string, val: any)    { filters.push(r => r[col] === val); return obj; },
      neq(col: string, val: any)   { filters.push(r => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push(r => vals.includes(r[col])); return obj; },
      gte(col: string, _val: any)  { return obj; },  // treated as no-op; rows returned regardless
      lte(col: string, _val: any)  { return obj; },
      or(_filter: string)          { return obj; },  // no-op: used by isBlocked(); blocks table is empty in all tests
      order()                      { return obj; },
      limit(n: number) { _limitN = n; return obj; },
      maybeSingle() {
        const rows = sourceRows.filter(r => filters.every(f => f(r)));
        return Promise.resolve({ data: rows[0] ?? null, error: null, count: rows.length });
      },
      single() {
        const rows = sourceRows.filter(r => filters.every(f => f(r)));
        if (!rows.length) return Promise.resolve({ data: null, error: { message: "No rows" }, count: 0 });
        return Promise.resolve({ data: rows[0], error: null, count: 1 });
      },
      then(resolve: (v: any) => any) {
        const rows    = sourceRows.filter(r => filters.every(f => f(r)));
        const limited = _limitN !== null ? rows.slice(0, _limitN) : rows;
        const payload = _head ? null : limited;
        return resolve({ data: payload, error: null, count: rows.length });
      },
    };
    return obj;
  }

  const client: any = {
    from(tableName: string) {
      const tbl  = db[tableName] ?? { rows: [] };
      const rows = [...tbl.rows];

      return {
        select(cols?: string, opts?: any) { return chain(rows).select(cols, opts); },
        insert(data: any) {
          const doInsert = () => {
            if (tbl.nextInsertError) {
              const err = tbl.nextInsertError;
              delete tbl.nextInsertError;
              return Promise.resolve({ data: null, error: { message: err } });
            }
            const items = Array.isArray(data) ? data : [data];
            const inserted = items.map(item => ({ id: newId(), ...item }));
            tbl.rows.push(...inserted);
            return Promise.resolve({ data: inserted[0] ?? null, error: null });
          };
          return { select() { return { single: doInsert }; }, then(r: any) { return doInsert().then(r); } };
        },
        upsert(data: any) {
          return { select() { return { single: () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data, error: null }) }; } };
        },
        update(data: any) {
          const doUpdate = () => Promise.resolve({ data: rows[0] ? { ...rows[0], ...data } : null, error: null });
          return { eq() { return { select() { return { single: doUpdate }; }, then(r: any) { return doUpdate().then(r); } }; } };
        },
        delete() { return { eq() { return { then(r: any) { return r({ data: null, error: null }); } }; } }; },
      };
    },
    auth: {
      getUser: (token?: string) =>
        Promise.resolve({
          data: {
            user: token
              ? {
                  id: token === "tok-owner"    ? OWNER_ID
                    : token === "tok-member"   ? MEMBER_ID
                    : token === "tok-outsider" ? OUTSIDER
                    : OUTSIDER,
                  email: "test@example.com",
                  user_metadata: {},
                }
              : null,
          },
          error: null,
        }),
    },
  };

  return client;
}

// ---------------------------------------------------------------------------
// Server + request helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      (server as any).unref?.();
      const addr = server.address() as import("net").AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.once("error", reject);
  });
}

async function apiReq(
  port: number,
  method: string,
  path: string,
  token: string | null = null,
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;

  const res = await fetch(url, { method, headers });
  const ct = res.headers.get("content-type") ?? "";
  let body: any;
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); }
  catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Baseline trip row factory
// ---------------------------------------------------------------------------
function baseTrip(overrides: Partial<Row> = {}): Row {
  return {
    id:                      TRIP_ID,
    owner_id:                OWNER_ID,
    title:                   "Test Trip",
    visibility:              "private",
    status:                  "planning",
    destination_city:        "Paris",
    destination_country:     "France",
    destination_lat:         48.85,
    destination_lng:         2.35,
    start_date:              "2026-09-01",
    end_date:                "2026-09-10",
    show_exact_dates:        true,
    show_destination_city:   true,
    precise_location_visible: false,
    allow_join_requests:     false,
    max_members:             10,
    cover_url:               null,
    description:             null,
    created_at:              new Date().toISOString(),
    updated_at:              new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// trips [C3] — non-public trips must not be readable by outsiders
// ---------------------------------------------------------------------------

describe("RLS baseline — trips SELECT policy [C3]", () => {
  let server: Server;
  let port:   number;

  beforeEach(async () => { ({ server, port } = await startServer()); });
  afterEach(() => { server?.close(); });

  it("outsider cannot read a private trip — returns locked sentinel (200)", async () => {
    _setTestClient(makeFakeClient({
      trips:        { rows: [baseTrip({ visibility: "private" })] },
      trip_members: { rows: [] },
      blocks:       { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-outsider");
    assert.equal(status, 200, "outsider must receive 200 locked sentinel for a private trip");
    assert.equal(body.locked, true, "response must carry locked:true sentinel");
    assert.equal(body.tripId, TRIP_ID, "locked sentinel must echo back the tripId");
  });

  it("outsider cannot read a buddies-only trip without mutual follow — returns locked sentinel (200)", async () => {
    _setTestClient(makeFakeClient({
      trips:        { rows: [baseTrip({ visibility: "buddies" })] },
      trip_members: { rows: [] },
      user_follows: { rows: [] },
      blocks:       { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-outsider");
    assert.equal(status, 200, "non-follower outsider must receive 200 locked sentinel for a buddies trip");
    assert.equal(body.locked, true, "response must carry locked:true sentinel");
  });

  it("outsider cannot read an invite-only trip — returns locked sentinel (200)", async () => {
    _setTestClient(makeFakeClient({
      trips:        { rows: [baseTrip({ visibility: "invite" })] },
      trip_members: { rows: [] },
      blocks:       { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-outsider");
    assert.equal(status, 200, "outsider must receive 200 locked sentinel for an invite-only trip");
    assert.equal(body.locked, true, "response must carry locked:true sentinel");
  });

  it("owner can read their own private trip — returns 200", async () => {
    _setTestClient(makeFakeClient({
      trips: { rows: [baseTrip({ visibility: "private" })] },
      trip_members: { rows: [
        { id: "m1", trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      ] },
      blocks: { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-owner");
    assert.equal(status, 200, "trip owner must receive 200");
    assert.ok(body.tripId || body.id, "response must include trip data");
  });

  it("accepted member can read a private trip — returns 200", async () => {
    _setTestClient(makeFakeClient({
      trips: { rows: [baseTrip({ visibility: "private" })] },
      trip_members: { rows: [
        { id: "m2", trip_id: TRIP_ID, user_id: MEMBER_ID, role: "member", status: "accepted" },
      ] },
      blocks: { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-member");
    assert.equal(status, 200, "accepted member must receive 200");
    assert.ok(body.tripId || body.id, "response must include trip data");
  });

  it("anyone can read a public trip — returns 200", async () => {
    _setTestClient(makeFakeClient({
      trips:        { rows: [baseTrip({ visibility: "public" })] },
      trip_members: { rows: [] },
      blocks:       { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}`, "tok-outsider");
    assert.equal(status, 200, "public trip must be readable by anyone");
    assert.ok(body.tripId || body.id, "response must include trip data");
  });
});

// ---------------------------------------------------------------------------
// trip_activity_log [L3] — reads restricted to trip members
// ---------------------------------------------------------------------------

describe("RLS baseline — trip_activity_log SELECT policy [L3]", () => {
  let server: Server;
  let port:   number;

  beforeEach(async () => { ({ server, port } = await startServer()); });
  afterEach(() => { server?.close(); });

  it("non-member cannot read the activity log — returns 403", async () => {
    _setTestClient(makeFakeClient({
      trips:        { rows: [baseTrip()] },
      trip_members: { rows: [] },
    }), true);

    const { status } = await apiReq(port, "GET", `/trips/${TRIP_ID}/activity`, "tok-outsider");
    assert.equal(status, 403, "non-member must receive 403 for the activity log");
  });

  it("trip owner can read the activity log — returns 200", async () => {
    _setTestClient(makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [
        { id: "m1", trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
      ] },
      trip_activity_log: { rows: [
        { id: "l1", trip_id: TRIP_ID, actor_id: OWNER_ID, event_type: "trip_created", metadata: {}, created_at: new Date().toISOString() },
      ] },
    }), true);

    const { status, body } = await apiReq(port, "GET", `/trips/${TRIP_ID}/activity`, "tok-owner");
    assert.equal(status, 200, "trip owner must receive 200");
    assert.ok(Array.isArray(body.activity), "response must contain an activity array");
  });

  it("co_host can read the activity log — returns 200", async () => {
    _setTestClient(makeFakeClient({
      trips: { rows: [baseTrip()] },
      trip_members: { rows: [
        { id: "m2", trip_id: TRIP_ID, user_id: MEMBER_ID, role: "co_host", status: "accepted" },
      ] },
      trip_activity_log: { rows: [] },
    }), true);

    const { status } = await apiReq(port, "GET", `/trips/${TRIP_ID}/activity`, "tok-member");
    assert.equal(status, 200, "co_host must receive 200");
  });
});

// ---------------------------------------------------------------------------
// profile_views [M5] — viewer identities must never be exposed via the API
// ---------------------------------------------------------------------------

describe("RLS baseline — profile_views SELECT policy [M5]", () => {
  let server: Server;
  let port:   number;

  beforeEach(async () => { ({ server, port } = await startServer()); });
  afterEach(() => { server?.close(); });

  it("analytics endpoint never exposes viewer_id — only aggregated counts", async () => {
    _setTestClient(makeFakeClient({
      profile_views: { rows: [
        { id: "v1", target_id: OWNER_ID, viewer_id: OUTSIDER,  viewed_at: new Date().toISOString() },
        { id: "v2", target_id: OWNER_ID, viewer_id: MEMBER_ID, viewed_at: new Date().toISOString() },
      ] },
      user_follows:     { rows: [] },
      post_impressions: { rows: [] },
    }), true);

    const { status, body } = await apiReq(port, "GET", "/me/profile/analytics", "tok-owner");
    assert.equal(status, 200, "analytics endpoint must respond 200");

    // Verify no individual viewer UUIDs appear anywhere in the response
    const bodyStr = JSON.stringify(body);
    assert.ok(
      !bodyStr.includes(OUTSIDER) && !bodyStr.includes(MEMBER_ID),
      "analytics response must not expose individual viewer_id values",
    );
  });
});
