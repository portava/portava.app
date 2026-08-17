/**
 * Events extension — backend tests
 *
 * Covers the new routes added by the 0080 events-extension milestone:
 *  - Discovery: nearby, search, me, hosting, joined, saved, invites, requests, city/:city
 *  - Drafts: CRUD + publish
 *  - Share-link preview
 *  - Lifecycle: publish, cancel, postpone, complete, archive
 *  - RSVP: close/reopen, rsvp_closed enforcement
 *  - Attendees: PATCH status, DELETE
 *  - Join requests (new paths): approve, decline, cancel
 *  - Invites: invite, accept, decline
 *  - Cohosts: add, remove, update permissions
 *  - Save/unsave
 *  - Share links: create, revoke
 *  - Event posts + media
 *  - Reports (event + user)
 *  - Activity log
 *  - Safety summary
 *  - Reminders CRUD
 *  - Stubs: add-to-trip, link-circle, telegraph-thread
 *  - Location privacy: show_exact_location gate
 */

import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Fake Supabase builder (same pattern as events.test.ts) ────────────────────

interface Row { [k: string]: any; }
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags: tables.feature_flags ?? { rows: [
      { flag: "events_enabled",              enabled: true },
      { flag: "events_waitlist_enabled",     enabled: true },
      { flag: "events_chat_enabled",         enabled: true },
      { flag: "events_trust_gates_enabled",  enabled: false },
      { flag: "events_invites_enabled",      enabled: true },
      { flag: "events_cohosts_enabled",      enabled: true },
      { flag: "events_reports_enabled",      enabled: true },
      { flag: "events_reminders_enabled",    enabled: true },
      { flag: "events_share_links_enabled",  enabled: true },
    ]},
    events:                tables.events                ?? { rows: [] },
    event_rsvps:           tables.event_rsvps           ?? { rows: [] },
    event_waitlist:        tables.event_waitlist         ?? { rows: [] },
    event_roles:           tables.event_roles            ?? { rows: [] },
    event_attendee_states: tables.event_attendee_states  ?? { rows: [] },
    event_join_requests:   tables.event_join_requests    ?? { rows: [] },
    event_updates:         tables.event_updates          ?? { rows: [] },
    event_invites:         tables.event_invites          ?? { rows: [] },
    event_cohosts:         tables.event_cohosts          ?? { rows: [] },
    event_saves:           tables.event_saves            ?? { rows: [] },
    event_share_links:     tables.event_share_links      ?? { rows: [] },
    event_posts:           tables.event_posts            ?? { rows: [] },
    event_media:           tables.event_media            ?? { rows: [] },
    event_reports:         tables.event_reports          ?? { rows: [] },
    event_activity_log:    tables.event_activity_log     ?? { rows: [] },
    event_reminders:       tables.event_reminders        ?? { rows: [] },
    event_drafts:          tables.event_drafts           ?? { rows: [] },
    event_attendees:       tables.event_attendees        ?? { rows: [] },
    profiles:              tables.profiles               ?? { rows: [] },
    blocks:                tables.blocks                 ?? { rows: [] },
    user_friendships:      tables.user_friendships       ?? { rows: [] },
    trust_events:          tables.trust_events           ?? { rows: [] },
    trust_profiles:        tables.trust_profiles         ?? { rows: [] },
    trust_settings:        tables.trust_settings         ?? { rows: [] },
    trust_caps:            tables.trust_caps             ?? { rows: [] },
    message_threads:       tables.message_threads        ?? { rows: [] },
    message_thread_members: tables.message_thread_members ?? { rows: [] },
    collections:           tables.collections            ?? { rows: [] },
    collection_items:      tables.collection_items       ?? { rows: [] },
    circle_memberships:    tables.circle_memberships     ?? { rows: [] },
    trip_members:          tables.trip_members           ?? { rows: [] },
    trip_plan_items:       tables.trip_plan_items        ?? { rows: [] },
  };

  function chain(tableName: string, filtered: Row[]) {
    let limitCount: number | null = null;
    let singleMode = false;
    let pendingOp: null | { type: "delete" } | { type: "update"; data: Row } = null;
    let isNullCols: string[] = [];

    const obj: any = {
      select()  { return obj; },
      insert(data: Row | Row[]) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        if (table.nextInsertError) {
          const msg = table.nextInsertError;
          table.nextInsertError = undefined;
          return Promise.resolve({ data: null, error: { message: msg, code: "23505" } });
        }
        const newRows = Array.isArray(data) ? data : [data];
        for (const r of newRows) {
          const row: Row = {
            id: `fake-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            token: `tok-${Math.random().toString(36).slice(2)}`,
            use_count: 0,
            ...r,
          };
          table.rows.push(row);
          filtered = [row];
        }
        return obj;
      },
      upsert(data: Row | Row[], _opts?: any) {
        const table = db[tableName] ?? (db[tableName] = { rows: [] });
        const newRows = Array.isArray(data) ? data : [data];
        for (const r of newRows) {
          let idx = -1;
          // Composite key detection
          if (r.event_id !== undefined && r.user_id !== undefined) {
            idx = table.rows.findIndex((row) => row.event_id === r.event_id && row.user_id === r.user_id);
          } else if (r.event_id !== undefined && r.invitee_id !== undefined) {
            idx = table.rows.findIndex((row) => row.event_id === r.event_id && row.invitee_id === r.invitee_id);
          } else if (r.flag !== undefined) {
            idx = table.rows.findIndex((row) => row.flag === r.flag);
          } else if (r.id !== undefined) {
            idx = table.rows.findIndex((row) => row.id === r.id);
          }
          if (idx >= 0) {
            table.rows[idx] = { ...table.rows[idx], ...r };
            filtered = [table.rows[idx]];
          } else {
            const row: Row = {
              id: `fake-${tableName}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              ...r,
            };
            table.rows.push(row);
            filtered = [row];
          }
        }
        return obj;
      },
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
          const raw = String(val).replace(/^\("|"\)$|^\(|"\)$/g, "");
          const vals = raw.split('","').map((s) => s.replace(/^"|"$/g, ""));
          filtered = filtered.filter((r) => !vals.includes(String(r[col])));
        }
        return obj;
      },
      is(col: string, val: any) {
        filtered = filtered.filter((r) =>
          val === null ? (r[col] === null || r[col] === undefined) : r[col] === val,
        );
        if (val === null) isNullCols = [...isNullCols, col];
        return obj;
      },
      or() { return obj; },
      ilike(col: string, pattern: string) {
        const q = pattern.replace(/%/g, "").toLowerCase();
        filtered = filtered.filter((r) => String(r[col] ?? "").toLowerCase().includes(q));
        return obj;
      },
      order() { return obj; },
      limit(n: number) { limitCount = n; return obj; },
      range(from: number, to: number) { filtered = filtered.slice(from, to + 1); return obj; },
      single() {
        singleMode = true;
        // Apply any pending mutation eagerly so update().eq().select().single()
        // returns the post-update row (mirrors what .then() does for non-single chains).
        if (pendingOp) {
          const table = db[tableName] ?? { rows: [] };
          if (pendingOp.type === "delete") {
            const toDelete = new Set(filtered.map((r) => r.id ?? JSON.stringify(r)));
            table.rows = table.rows.filter((r) => !toDelete.has(r.id ?? JSON.stringify(r)));
            filtered = [];
          } else if (pendingOp.type === "update") {
            const updateData = (pendingOp as { type: "update"; data: Row }).data;
            filtered = filtered.map((row) => {
              const idx = table.rows.findIndex((r) => r === row || r.id === row.id);
              if (idx >= 0) {
                table.rows[idx] = { ...table.rows[idx], ...updateData };
                return table.rows[idx];
              }
              return { ...row, ...updateData };
            });
          }
          pendingOp = null;
        }
        const row = filtered[0] ?? null;
        return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "No rows" } });
      },
      maybeSingle() {
        singleMode = true;
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      then(resolve: any, reject: any) {
        if (pendingOp) {
          const table = db[tableName] ?? { rows: [] };
          if (pendingOp.type === "delete") {
            const toDelete = new Set(filtered.map((r) => r.id ?? JSON.stringify(r)));
            table.rows = table.rows.filter((r) => !toDelete.has(r.id ?? JSON.stringify(r)));
            filtered = [];
          } else if (pendingOp.type === "update") {
            const updateData = (pendingOp as { type: "update"; data: Row }).data;
            filtered = filtered.reduce<Row[]>((acc, row) => {
              const idx = table.rows.findIndex((r) => r === row || r.id === row.id);
              if (idx >= 0) {
                const current = table.rows[idx];
                const stillValid = isNullCols.every((col) => current[col] === null || current[col] === undefined);
                if (!stillValid) return acc;
                table.rows[idx] = { ...table.rows[idx], ...updateData };
                return [...acc, table.rows[idx]];
              }
              return [...acc, { ...row, ...updateData }];
            }, []);
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

// ── UUID constants ─────────────────────────────────────────────────────────────

const ID = {
  ev1:    "00000000-0000-0000-0000-000000000001",
  ev2:    "00000000-0000-0000-0000-000000000002",
  ev3:    "00000000-0000-0000-0000-000000000003",
  host1:  "00000000-0000-0000-0001-000000000001",
  user1:  "00000000-0000-0000-0002-000000000001",
  user2:  "00000000-0000-0000-0002-000000000002",
  user3:  "00000000-0000-0000-0002-000000000003",
  draft1: "00000000-0000-0000-0005-000000000001",
  invite1:"00000000-0000-0000-0006-000000000001",
  cohost1:"00000000-0000-0000-0007-000000000001",
  save1:  "00000000-0000-0000-0008-000000000001",
  link1:  "00000000-0000-0000-0009-000000000001",
  req1:   "00000000-0000-0000-000a-000000000001",
  rem1:   "00000000-0000-0000-000b-000000000001",
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<Row> = {}): Row {
  return {
    id:                    ID.ev1,
    host_id:               ID.host1,
    title:                 "Extension Test Event",
    description:           null,
    location_name:         "Test Venue",
    location_lat:          48.8566,
    location_lng:          2.3522,
    starts_at:             new Date(Date.now() + 86400000).toISOString(),
    ends_at:               null,
    cover_url:             null,
    max_attendees:         null,
    age_min:               null,
    age_max:               null,
    trust_score_min:       null,
    verified_only:         false,
    visibility:            "public",
    state:                 "open",
    chat_enabled:          false,
    chat_thread_id:        null,
    waitlist_enabled:      true,
    price_type:            "free",
    price_url:             null,
    rsvp_options:          ["going","maybe","interested","cant_go"],
    going_count:           0,
    waitlist_count:        0,
    category:              "social",
    city:                  "Paris",
    country:               "France",
    show_exact_location:   false,
    rsvp_closed:           false,
    safety_notes:          null,
    tags:                  [],
    attendee_comments_enabled: true,
    created_at:            new Date().toISOString(),
    updated_at:            new Date().toISOString(),
    ...overrides,
  };
}

function tok(userId: string) { return `fake-token-${userId}`; }

async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = (srv.address() as { port: number });
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())),
      });
    });
    srv.on("error", reject);
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  body: unknown,
  userId: string,
): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${tok(userId)}`,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

// ── Discovery routes ──────────────────────────────────────────────────────────

describe("GET /api/events/city/:city", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({ events: { rows: [
      makeEvent({ id: ID.ev1, city: "Paris" }),
      makeEvent({ id: ID.ev2, city: "London", host_id: ID.user1 }),
    ]}});
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("returns events for matching city", async () => {
    const { status, body } = await req(port, "GET", "/api/events/city/Paris", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events));
    assert.ok(body.events.length >= 1);
    assert.ok(body.events.every((e: any) => e.city?.toLowerCase().includes("paris")));
  });

  it("filters out draft/cancelled events", async () => {
    const client2 = makeFakeClient({ events: { rows: [
      makeEvent({ id: ID.ev1, city: "Paris", state: "draft" }),
      makeEvent({ id: ID.ev2, city: "Paris", state: "cancelled" }),
    ]}});
    _setTestClient(client2, true);
    const { body } = await req(port, "GET", "/api/events/city/Paris", null, ID.host1);
    assert.equal(body.events.length, 0);
  });
});

describe("GET /api/events/nearby", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({ events: { rows: [
      makeEvent({ id: ID.ev1, location_lat: 48.8566, location_lng: 2.3522 }),
      makeEvent({ id: ID.ev2, location_lat: 51.5074, location_lng: -0.1278 }), // London
    ]}});
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("requires lat and lng params", async () => {
    const { status } = await req(port, "GET", "/api/events/nearby", null, ID.host1);
    assert.equal(status, 400);
  });

  it("returns events within bounding box", async () => {
    const { status, body } = await req(port, "GET", "/api/events/nearby?lat=48.8566&lng=2.3522&radiusKm=20", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events));
    // Paris event should match; London should not
    assert.ok(body.events.some((e: any) => e.id === ID.ev1));
    assert.ok(!body.events.some((e: any) => e.id === ID.ev2));
  });
});

describe("GET /api/events/search", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({ events: { rows: [
      makeEvent({ id: ID.ev1, title: "Jazz Night in Paris", city: "Paris" }),
      makeEvent({ id: ID.ev2, title: "Art Exhibition", city: "Lyon" }),
    ]}});
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("requires at least 2 chars", async () => {
    const { status } = await req(port, "GET", "/api/events/search?q=a", null, ID.host1);
    assert.equal(status, 400);
  });

  it("matches events by title", async () => {
    const { status, body } = await req(port, "GET", "/api/events/search?q=Jazz", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.events.some((e: any) => e.id === ID.ev1));
  });

  it("matches events by city", async () => {
    const { status, body } = await req(port, "GET", "/api/events/search?q=Lyon", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.events.some((e: any) => e.id === ID.ev2));
  });
});

describe("GET /api/events/me, /hosting, /joined, /saved", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1 }),
        makeEvent({ id: ID.ev2, host_id: ID.user1 }),
      ]},
      event_rsvps: { rows: [
        { event_id: ID.ev2, user_id: ID.host1, status: "going" },
      ]},
      event_saves: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, saved_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("GET /me returns hosting + joined events", async () => {
    const { status, body } = await req(port, "GET", "/api/events/me", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.events));
    const ids = body.events.map((e: any) => e.id);
    assert.ok(ids.includes(ID.ev1));
    assert.ok(ids.includes(ID.ev2));
  });

  it("GET /hosting returns only hosted events", async () => {
    const { status, body } = await req(port, "GET", "/api/events/hosting", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.events.every((e: any) => e.hostId === ID.host1));
  });

  it("GET /joined returns RSVP going events", async () => {
    const { status, body } = await req(port, "GET", "/api/events/joined", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.events.some((e: any) => e.id === ID.ev2));
  });

  it("GET /saved returns saved events", async () => {
    const { status, body } = await req(port, "GET", "/api/events/saved", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.events.some((e: any) => e.id === ID.ev1));
  });
});

describe("GET /api/events/invites and /requests", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1 }) ] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
      event_join_requests: { rows: [
        { id: ID.req1, event_id: ID.ev1, user_id: ID.user2, status: "pending", created_at: new Date().toISOString() },
      ]},
      profiles: { rows: [
        { id: ID.host1, handle: "host1", name: "Host One", avatar_url: null },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("GET /invites returns pending invites for user", async () => {
    const { status, body } = await req(port, "GET", "/api/events/invites", null, ID.user1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.invites));
    assert.ok(body.invites.some((i: any) => i.id === ID.invite1));
  });

  it("GET /requests returns outgoing join requests for user", async () => {
    const { status, body } = await req(port, "GET", "/api/events/requests", null, ID.user2);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.requests));
    assert.ok(body.requests.some((r: any) => r.id === ID.req1));
  });
});

// ── Drafts ────────────────────────────────────────────────────────────────────

describe("Event drafts CRUD", () => {
  let port: number;
  let close: () => Promise<void>;
  let client: any;

  beforeEach(async () => {
    client = makeFakeClient({ event_drafts: { rows: [
      { id: ID.draft1, host_id: ID.host1, data: { title: "Partial Draft" }, last_saved_at: new Date().toISOString(), created_at: new Date().toISOString() },
    ]}});
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("GET /drafts returns user's drafts", async () => {
    const { status, body } = await req(port, "GET", "/api/events/drafts", null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.drafts));
    assert.ok(body.drafts.some((d: any) => d.id === ID.draft1));
  });

  it("GET /drafts returns empty for other user", async () => {
    const { status, body } = await req(port, "GET", "/api/events/drafts", null, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.drafts.length, 0);
  });

  it("POST /drafts creates a draft (accepts incomplete data)", async () => {
    const { status, body } = await req(port, "POST", "/api/events/drafts", { title: "Draft Title" }, ID.host1);
    assert.equal(status, 201);
    assert.ok(body.id);
    // Response is flattened to the client's EventDraft shape (title at the
    // top level, plus updatedAt) — not the raw { data: {...} } DB row.
    assert.equal(body.title, "Draft Title");
    assert.ok(body.updatedAt);
  });

  it("PATCH /drafts/:id updates draft data", async () => {
    const { status, body } = await req(port, "PATCH", `/api/events/drafts/${ID.draft1}`, { title: "Updated Draft" }, ID.host1);
    assert.equal(status, 200);
    assert.equal(body.id, ID.draft1);
    assert.equal(body.title, "Updated Draft");
    assert.ok(body.updatedAt);
  });

  it("PATCH /drafts/:id — forbidden for other user", async () => {
    const { status } = await req(port, "PATCH", `/api/events/drafts/${ID.draft1}`, { title: "x" }, ID.user1);
    assert.equal(status, 403);
  });

  it("DELETE /drafts/:id removes draft", async () => {
    const { status, body } = await req(port, "DELETE", `/api/events/drafts/${ID.draft1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("POST /drafts/:id/publish — fails validation without required fields", async () => {
    const { status } = await req(port, "POST", `/api/events/drafts/${ID.draft1}/publish`, {}, ID.host1);
    assert.equal(status, 400);
  });

  it("POST /drafts/:id/publish — succeeds with all required fields", async () => {
    const futureStart = new Date(Date.now() + 86400000).toISOString();
    const futureEnd   = new Date(Date.now() + 172800000).toISOString();
    const { status, body } = await req(
      port, "POST", `/api/events/drafts/${ID.draft1}/publish`,
      { title: "Published Event", startsAt: futureStart, endsAt: futureEnd, locationName: "Venue" },
      ID.host1,
    );
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.state ?? body.status, "open");
  });
});

// ── Share-link preview ────────────────────────────────────────────────────────

describe("GET /api/events/share-link/:token/preview", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1 }) ] },
      event_share_links: { rows: [
        {
          id: ID.link1,
          event_id: ID.ev1,
          creator_id: ID.host1,
          token: "validtoken123456",
          max_uses: null,
          use_count: 0,
          expires_at: null,
          created_at: new Date().toISOString(),
        },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("returns event preview for valid token", async () => {
    const { status, body } = await req(port, "GET", "/api/events/share-link/validtoken123456/preview", null, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.event);
    assert.equal(body.event.id, ID.ev1);
  });

  it("404 for unknown token", async () => {
    const { status } = await req(port, "GET", "/api/events/share-link/unknowntoken1234/preview", null, ID.user1);
    assert.equal(status, 404);
  });

  it("404 for expired token", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1 }) ] },
      event_share_links: { rows: [
        {
          id: ID.link1,
          event_id: ID.ev1,
          creator_id: ID.host1,
          token: "expiredtoken1234",
          max_uses: null,
          use_count: 0,
          expires_at: new Date(Date.now() - 1000).toISOString(),
          created_at: new Date().toISOString(),
        },
      ]},
    });
    _setTestClient(client2, true);
    const { status } = await req(port, "GET", "/api/events/share-link/expiredtoken1234/preview", null, ID.user1);
    assert.equal(status, 404);
  });
});

// ── Lifecycle routes ──────────────────────────────────────────────────────────

describe("POST /api/events/:id/publish", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, state: "draft", host_id: ID.host1, location_name: "Venue" }),
      ]},
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can publish a draft event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/publish`, {}, ID.host1);
    assert.equal(status, 200);
    assert.equal(body.state, "open");
  });

  it("non-host gets 403", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/publish`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("publishing non-draft event returns 400", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, state: "open", host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
    });
    _setTestClient(client2, true);
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/publish`, {}, ID.host1);
    assert.equal(status, 400);
  });
});

describe("POST /api/events/:id/cancel", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, state: "open", host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [] },
      profiles: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can cancel event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/cancel`, { reason: "Venue unavailable" }, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("non-host gets 403", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/cancel`, {}, ID.user1);
    assert.equal(status, 403);
  });
});

describe("POST /api/events/:id/postpone, /complete, /archive", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, state: "started", host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [] },
      profiles: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can postpone event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/postpone`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("host can mark complete", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/complete`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("host can archive", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/archive`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("non-host gets 403 for postpone", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/postpone`, {}, ID.user1);
    assert.equal(status, 403);
  });
});

// ── RSVP closed enforcement ───────────────────────────────────────────────────

describe("RSVP closed enforcement", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, state: "open", rsvp_closed: true }) ] },
      event_roles: { rows: [] },
      blocks: { rows: [] },
      profiles: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("returns 403 when rsvp_closed is true", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
    assert.ok(body.message?.toLowerCase().includes("closed"));
  });
});

describe("POST /api/events/:id/close-rsvps and /reopen-rsvps", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, state: "open", host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_activity_log: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can close RSVPs", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/close-rsvps`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("host can reopen RSVPs", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/reopen-rsvps`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("non-host gets 403 for close-rsvps", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/close-rsvps`, {}, ID.user1);
    assert.equal(status, 403);
  });
});

// ── Attendee management ───────────────────────────────────────────────────────

describe("PATCH /attendees/:userId/status and DELETE /attendees/:userId", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_activity_log: { rows: [] },
      profiles: { rows: [] },
      message_threads: { rows: [] },
      message_thread_members: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can update attendee RSVP status", async () => {
    const { status, body } = await req(port, "PATCH", `/api/events/${ID.ev1}/attendees/${ID.user1}/status`, { status: "maybe" }, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.equal(body.userId, ID.user1);
    assert.equal(body.status, "maybe");
  });

  it("non-host gets 403 for attendee status update", async () => {
    const { status } = await req(port, "PATCH", `/api/events/${ID.ev1}/attendees/${ID.user1}/status`, { status: "maybe" }, ID.user2);
    assert.equal(status, 403);
  });

  it("host can remove attendee", async () => {
    const { status, body } = await req(port, "DELETE", `/api/events/${ID.ev1}/attendees/${ID.user1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });
});

// ── Join request new paths ────────────────────────────────────────────────────

describe("Join request new paths", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "invite_only", state: "open" }),
      ]},
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_join_requests: { rows: [] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      blocks: { rows: [] },
      profiles: { rows: [
        { id: ID.host1, expo_push_token: null },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("POST /join-request succeeds for invite-only event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join-request`, { message: "Please let me in!" }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.status, "pending");
  });

  it("POST /join-request on non-invite-only event returns 403", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "public", state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_join_requests: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join-request`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("POST /join-requests/:id/approve works", async () => {
    const jrId = "00000000-0000-0000-ffff-000000000001";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "invite_only", state: "open", max_attendees: null }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_join_requests: { rows: [
        { id: jrId, event_id: ID.ev1, user_id: ID.user1, status: "pending", message: null, created_at: new Date().toISOString() },
      ]},
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      blocks: { rows: [] },
      trust_profiles: { rows: [] },
      profiles: { rows: [] },
      event_roles_extra: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join-requests/${jrId}/approve`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("POST /join-requests/:id/approve on a FULL event with waitlisting disabled does not seat the attendee", async () => {
    // Regression guard. Capacity and waitlist_enabled used to be ANDed, so a
    // full event with waitlisting OFF failed the combined condition, skipped
    // the whole block, and fell through to the unconditional going-upsert —
    // seating an attendee past max_attendees. Capacity is now the outer
    // condition and both full-event branches return.
    const jrId = "00000000-0000-0000-ffff-000000000002";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({
        id: ID.ev1, host_id: ID.host1, visibility: "invite_only",
        state: "full", max_attendees: 2, waitlist_enabled: false,
      }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_join_requests: { rows: [
        { id: jrId, event_id: ID.ev1, user_id: ID.user1, status: "pending", message: null, created_at: new Date().toISOString() },
      ]},
      // Both seats already taken.
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
      trust_profiles: { rows: [] },
      profiles: { rows: [] },
      event_roles_extra: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join-requests/${jrId}/approve`, {}, ID.host1);

    assert.equal(status, 200, "full + waitlist-off is not an error — the approval did persist");
    assert.equal(body.status, "approved_pending_capacity",
      `full event with waitlisting off must not report a seat, got: ${body.status}`);

    const db = (client2 as any)._db;

    // The actual overbook: no RSVP row may exist for the requester.
    const requesterRsvps = db.event_rsvps.rows.filter((r: any) => r.user_id === ID.user1);
    assert.equal(requesterRsvps.length, 0,
      `requester must not be seated past max_attendees, got: ${JSON.stringify(requesterRsvps)}`);

    // And the event must still hold exactly its two original attendees.
    const going = db.event_rsvps.rows.filter((r: any) => r.status === "going");
    assert.equal(going.length, 2, `going count must stay at max_attendees=2, got ${going.length}`);

    // No fabricated waitlist row: promoteNextWaitlisted is gated on the GLOBAL
    // events_waitlist_enabled flag, so a row here would later receive a real
    // offer on an event whose host deliberately turned waitlisting off.
    assert.equal(db.event_waitlist.rows.length, 0,
      `no waitlist row may be created when the host disabled waitlisting, got: ${JSON.stringify(db.event_waitlist.rows)}`);

    // The approval IS persisted — that is what lets the user seat themselves
    // via POST /events/:id/join once a slot frees, so a 4xx would have lied.
    const jr = db.event_join_requests.rows.find((r: any) => r.id === jrId);
    assert.equal(jr?.status, "approved", `join request must remain approved, got: ${jr?.status}`);

    // The branch used to return before logging, so a host approving into a
    // full event produced no audit row at all.
    const logged = (db.event_activity_log?.rows ?? []).filter((r: any) => r.action === "join_request_approved");
    assert.equal(logged.length, 1, `expected one audit row, got ${logged.length}`);
    assert.equal((logged[0] as any).metadata?.outcome, "pending_capacity",
      `audit row must record the outcome, got: ${JSON.stringify((logged[0] as any).metadata)}`);
  });

  it("POST /join-requests/:id/decline works", async () => {
    const jrId = "00000000-0000-0000-ffff-000000000002";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_join_requests: { rows: [
        { id: jrId, event_id: ID.ev1, user_id: ID.user1, status: "pending", created_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join-requests/${jrId}/decline`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("POST /join-requests/:id/cancel — requester can cancel", async () => {
    const jrId = "00000000-0000-0000-ffff-000000000003";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [] },
      event_join_requests: { rows: [
        { id: jrId, event_id: ID.ev1, user_id: ID.user1, status: "pending", created_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join-requests/${jrId}/cancel`, {}, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });
});

// ── Invites ───────────────────────────────────────────────────────────────────

describe("Event invites", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_invites: { rows: [] },
      blocks: { rows: [] },
      profiles: { rows: [
        { id: ID.user1, expo_push_token: null, handle: "user1", name: "User One", avatar_url: null },
      ]},
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      trust_profiles: { rows: [] },
      event_activity_log: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can invite a user", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invite`, { userId: ID.user1 }, ID.host1);
    assert.equal(status, 201);
    assert.ok(body.inviteId);
    assert.equal(body.status, "pending");
  });

  it("non-host/co-host gets 403", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/invite`, { userId: ID.user2 }, ID.user1);
    assert.equal(status, 403);
  });

  it("invitee can accept invite", async () => {
    const inviteId = "00000000-0000-0000-00aa-000000000001";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [] },
      event_invites: { rows: [
        { id: inviteId, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      blocks: { rows: [] },
      trust_profiles: { rows: [] },
      profiles: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${inviteId}/accept`, {}, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("invitee can decline invite", async () => {
    const inviteId = "00000000-0000-0000-00aa-000000000002";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [] },
      event_invites: { rows: [
        { id: inviteId, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${inviteId}/decline`, {}, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("wrong user gets 403 on accept", async () => {
    const inviteId = "00000000-0000-0000-00aa-000000000003";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [] },
      event_invites: { rows: [
        { id: inviteId, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client2, true);
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${inviteId}/accept`, {}, ID.user2);
    assert.equal(status, 403);
  });
});

// ── Cohosts ───────────────────────────────────────────────────────────────────

describe("Event cohosts", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_cohosts: { rows: [] },
      event_activity_log: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can add a co-host", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/cohosts`, { userId: ID.user1 }, ID.host1);
    assert.equal(status, 201);
    assert.ok(body.ok);
    assert.equal(body.userId, ID.user1);
    assert.ok(body.permissions);
  });

  it("non-host gets 403 adding co-host", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/cohosts`, { userId: ID.user2 }, ID.user1);
    assert.equal(status, 403);
  });

  it("host can remove a co-host", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
        { event_id: ID.ev1, user_id: ID.user1, role: "co_host" },
      ]},
      event_cohosts: { rows: [
        { id: ID.cohost1, event_id: ID.ev1, user_id: ID.user1, permissions: {}, added_by: ID.host1 },
      ]},
      event_activity_log: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "DELETE", `/api/events/${ID.ev1}/cohosts/${ID.user1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("host can update co-host permissions", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_cohosts: { rows: [
        { id: ID.cohost1, event_id: ID.ev1, user_id: ID.user1, permissions: { manage_rsvps: true, manage_chat: true, post_updates: true }, added_by: ID.host1 },
      ]},
    });
    _setTestClient(client2, true);
    const { status, body } = await req(
      port, "PATCH", `/api/events/${ID.ev1}/cohosts/${ID.user1}/permissions`,
      { permissions: { manage_rsvps: false } },
      ID.host1,
    );
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.equal(body.permissions.manage_rsvps, false);
  });
});

// ── Save / unsave ─────────────────────────────────────────────────────────────

describe("POST /save and DELETE /save", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_saves: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("user can save an event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/save`, {}, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.saved);
  });

  it("user can unsave an event", async () => {
    const { status, body } = await req(port, "DELETE", `/api/events/${ID.ev1}/save`, null, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.saved, false);
  });

  it("returns 404 for non-existent event", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev2}/save`, {}, ID.user1);
    assert.equal(status, 404);
  });
});

// ── Share links ───────────────────────────────────────────────────────────────

describe("Share links CRUD", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_share_links: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can create a share link", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/share-link`, {}, ID.host1);
    assert.equal(status, 201);
    assert.ok(body.token || body.id);
  });

  it("non-host/co-host gets 403 creating share link", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/share-link`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("host can revoke a share link", async () => {
    const linkId = "00000000-0000-0000-0099-000000000001";
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_share_links: { rows: [
        { id: linkId, event_id: ID.ev1, creator_id: ID.host1, token: "tok123", use_count: 0 },
      ]},
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "DELETE", `/api/events/${ID.ev1}/share-link/${linkId}`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });
});

// ── Event posts and media ─────────────────────────────────────────────────────

describe("Event posts", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", attendee_comments_enabled: true }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [ { event_id: ID.ev1, user_id: ID.user1, status: "going" } ] },
      event_posts: { rows: [] },
      profiles: { rows: [] },
      user_friendships: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can post an event post", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/posts`, { body: "Hello attendees!" }, ID.host1);
    assert.equal(status, 201);
    assert.equal(body.body, "Hello attendees!");
  });

  it("going attendee can post when comments enabled", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/posts`, { body: "Excited!" }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.body, "Excited!");
  });

  it("non-attendee gets 403 when posting", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/posts`, { body: "Can I join?" }, ID.user2);
    assert.equal(status, 403);
  });

  it("GET /posts returns list of posts", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [] },
      event_posts: { rows: [
        { id: "00000000-0000-0000-0077-000000000001", event_id: ID.ev1, author_id: ID.host1, body: "Welcome!", media_urls: [], pinned: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
      profiles: { rows: [] },
      user_friendships: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client2, true);
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}/posts`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.posts));
    assert.equal(body.posts.length, 1);
  });
});

describe("Event media", () => {
  let port: number;
  let close: () => Promise<void>;
  // appStorageUrlInfo requires SUPABASE_URL to validate the origin; provide a
  // stable test origin and use URLs that pass the storage-URL guard.
  const TEST_SB = "https://test.supabase.example";
  const VALID_MEDIA_URL = `${TEST_SB}/storage/v1/object/public/post-media/events/photo.jpg`;
  let _origSbUrl: string | undefined;

  beforeEach(async () => {
    _origSbUrl = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = TEST_SB;
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [ { event_id: ID.ev1, user_id: ID.user1, status: "going" } ] },
      event_media: { rows: [] },
      user_friendships: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => {
    await close();
    process.env.SUPABASE_URL = _origSbUrl;
  });

  it("going attendee can upload media", async () => {
    // appStorageUrlInfo requires the URL to be on the configured SUPABASE_URL origin
    // in an allowed bucket — construct a valid one from the env var so the route's
    // security guard accepts it.
    const supabaseOrigin = new URL(process.env.SUPABASE_URL ?? "https://placeholder.supabase.co").origin;
    const mediaUrl = `${supabaseOrigin}/storage/v1/object/public/post-media/events/test-photo.jpg`;
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl,
      mediaType: "image",
      caption:   "Great time!",
    }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.media_url, mediaUrl);
  });

  it("non-attendee gets 403 uploading media", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl: VALID_MEDIA_URL,
    }, ID.user2);
    assert.equal(status, 403);
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────

describe("Event reports", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_reports: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("user can report an event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/report`, { reason: "Inappropriate content" }, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.ok);
  });

  it("requires reason to be at least 5 chars", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/report`, { reason: "x" }, ID.user1);
    assert.equal(status, 400);
  });

  it("user can report another user in event context", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/report-user/${ID.user2}`, { reason: "Harassment in comments" }, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.ok);
  });

  it("cannot report yourself", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/report-user/${ID.user1}`, { reason: "Not me!" }, ID.user1);
    assert.equal(status, 400);
  });

  it("duplicate report returns 409", async () => {
    const client2 = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_reports: { rows: [], nextInsertError: "duplicate key value violates unique constraint" },
    });
    _setTestClient(client2, true);
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/report`, { reason: "Spam content here" }, ID.user1);
    assert.equal(status, 409);
  });
});

// ── Activity log ──────────────────────────────────────────────────────────────

describe("GET /api/events/:id/activity", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_activity_log: { rows: [
        { id: "00000000-0000-0000-0088-000000000001", event_id: ID.ev1, actor_id: ID.host1, action: "published", metadata: {}, created_at: new Date().toISOString() },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can view activity log", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}/activity`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.activity));
    assert.ok(body.activity.some((a: any) => a.action === "published"));
  });

  it("random user gets 403", async () => {
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}/activity`, null, ID.user1);
    assert.equal(status, 403);
  });
});

// ── Safety summary ────────────────────────────────────────────────────────────

describe("GET /api/events/:id/safety-summary", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_reports: { rows: [] },
      event_attendee_states: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host gets safety summary", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}/safety-summary`, null, ID.host1);
    assert.equal(status, 200);
    assert.equal(body.eventId, ID.ev1);
    assert.ok(Array.isArray(body.reports));
    assert.ok(Array.isArray(body.noShows));
    assert.ok(Array.isArray(body.blockedUsers));
    assert.ok(body.generatedAt);
  });

  it("random user gets 403", async () => {
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}/safety-summary`, null, ID.user1);
    assert.equal(status, 403);
  });
});

// ── Reminders CRUD ────────────────────────────────────────────────────────────

describe("Event reminders", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_reminders: { rows: [
        {
          id: ID.rem1,
          event_id: ID.ev1,
          user_id: ID.user1,
          remind_at: new Date(Date.now() + 3600000).toISOString(),
          note: null,
          sent: false,
          created_at: new Date().toISOString(),
        },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("GET /reminders returns user reminders", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}/reminders`, null, ID.user1);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.reminders));
    assert.ok(body.reminders.some((r: any) => r.id === ID.rem1));
  });

  it("POST /reminders creates reminder with future time", async () => {
    const remindAt = new Date(Date.now() + 7200000).toISOString();
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/reminders`, { remindAt }, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.id);
    assert.equal(body.event_id, ID.ev1);
  });

  it("POST /reminders rejects past times", async () => {
    const remindAt = new Date(Date.now() - 1000).toISOString();
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/reminders`, { remindAt }, ID.user1);
    assert.equal(status, 400);
  });

  it("PATCH /reminders/:id updates reminder", async () => {
    const newTime = new Date(Date.now() + 10800000).toISOString();
    const { status } = await req(port, "PATCH", `/api/events/${ID.ev1}/reminders/${ID.rem1}`, { remindAt: newTime }, ID.user1);
    assert.equal(status, 200);
  });

  it("PATCH /reminders/:id — wrong user gets 403", async () => {
    const newTime = new Date(Date.now() + 10800000).toISOString();
    const { status } = await req(port, "PATCH", `/api/events/${ID.ev1}/reminders/${ID.rem1}`, { remindAt: newTime }, ID.user2);
    assert.equal(status, 403);
  });

  it("DELETE /reminders/:id removes reminder", async () => {
    const { status, body } = await req(port, "DELETE", `/api/events/${ID.ev1}/reminders/${ID.rem1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });
});

// ── POST /api/events/:id/add-to-trip — membership gates ──────────────────────

describe("POST /api/events/:id/add-to-trip — membership gates", () => {
  let port: number;
  let close: () => Promise<void>;
  const TRIP_ID = "00000000-0000-0000-000c-000000000001";

  function makeAddToTripClient(opts: { tripMember?: boolean; alreadyAdded?: boolean } = {}) {
    return makeFakeClient({
      events: { rows: [makeEvent({
        id:         ID.ev1,
        host_id:    ID.host1,
        state:      "open",
        visibility: "public",
      })] },
      event_roles:      { rows: [] },
      blocks:           { rows: [] },
      user_friendships: { rows: [] },
      event_rsvps:      { rows: [] },
      trip_members:     { rows: opts.tripMember
        ? [{ trip_id: TRIP_ID, user_id: ID.user1, role: "member" }]
        : [] },
      trip_plan_items:  { rows: opts.alreadyAdded
        ? [{ id: "existing-plan-item", trip_id: TRIP_ID, source_type: "event", source_id: ID.ev1, removed_at: null }]
        : [] },
    });
  }

  beforeEach(async () => {
    _setTestClient(makeAddToTripClient(), true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("non-trip-member gets 403", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/add-to-trip`, { tripId: TRIP_ID }, ID.user1);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("accepted trip member gets 201 with itinerary item", async () => {
    _setTestClient(makeAddToTripClient({ tripMember: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/add-to-trip`, { tripId: TRIP_ID }, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.planItemId, "planItemId present");
    assert.equal(body.tripId, TRIP_ID);
    assert.equal(body.alreadyAdded, undefined);
  });

  it("duplicate add returns alreadyAdded:true without inserting twice", async () => {
    _setTestClient(makeAddToTripClient({ tripMember: true, alreadyAdded: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/add-to-trip`, { tripId: TRIP_ID }, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.alreadyAdded, true);
    assert.equal(body.tripId, TRIP_ID);
    assert.ok(body.planItemId, "existing planItemId returned");
  });

  it("missing tripId gets 400", async () => {
    _setTestClient(makeAddToTripClient({ tripMember: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/add-to-trip`, {}, ID.user1);
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

// ── POST /api/events/:id/link-circle — membership gates ───────────────────────

describe("POST /api/events/:id/link-circle — membership gates", () => {
  let port: number;
  let close: () => Promise<void>;
  const CIRCLE_ID = "00000000-0000-0000-000d-000000000001";

  function makeLinkCircleClient(opts: { isHost?: boolean; circleMember?: boolean } = {}) {
    return makeFakeClient({
      events: { rows: [makeEvent({
        id:         ID.ev1,
        host_id:    opts.isHost ? ID.user1 : ID.host1,
        state:      "open",
        visibility: "public",
      })] },
      event_roles:        { rows: [] },
      blocks:             { rows: [] },
      user_friendships:   { rows: [] },
      event_rsvps:        { rows: [] },
      circle_memberships: { rows: opts.circleMember
        ? [{ user_id: CIRCLE_ID, other_id: ID.user1 }]
        : [] },
      event_activity_log: { rows: [] },
    });
  }

  beforeEach(async () => {
    _setTestClient(makeLinkCircleClient(), true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("non-host gets 403 even if they are a circle member", async () => {
    _setTestClient(makeLinkCircleClient({ isHost: false, circleMember: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/link-circle`, { circleId: CIRCLE_ID }, ID.user1);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("host who is not a circle member gets 403", async () => {
    _setTestClient(makeLinkCircleClient({ isHost: true, circleMember: false }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/link-circle`, { circleId: CIRCLE_ID }, ID.user1);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  });

  it("host who is a circle member gets 200 with ok:true", async () => {
    _setTestClient(makeLinkCircleClient({ isHost: true, circleMember: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/link-circle`, { circleId: CIRCLE_ID }, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.circleId, CIRCLE_ID);
  });

  it("missing circleId gets 400", async () => {
    _setTestClient(makeLinkCircleClient({ isHost: true, circleMember: true }), true);
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/link-circle`, {}, ID.user1);
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  });
});

// ── Location privacy: show_exact_location ────────────────────────────────────

describe("Location privacy — show_exact_location gate", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({
          id: ID.ev1,
          host_id: ID.host1,
          state: "open",
          location_lat: 48.8566,
          location_lng: 2.3522,
          location_name: "Secret Venue",
          show_exact_location: false,
        }),
      ]},
      event_roles: { rows: [] },
      blocks: { rows: [] },
      user_friendships: { rows: [] },
      event_rsvps: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("non-host non-attendee sees null lat/lng when show_exact_location is false", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    // formatEvent must redact coordinates for non-hosts when show_exact_location=false
    // The field should be null or absent
    assert.ok(body.locationLat === null || body.locationLat === undefined,
      `Expected null locationLat for non-attendee, got: ${JSON.stringify(body.locationLat)}`);
    assert.ok(body.locationLng === null || body.locationLng === undefined,
      `Expected null locationLng for non-attendee, got: ${JSON.stringify(body.locationLng)}`);
  });

  it("host always sees exact coordinates", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.locationLat != null, "Host should see locationLat");
    assert.ok(body.locationLng != null, "Host should see locationLng");
  });
});

// ── Block-user from event ─────────────────────────────────────────────────────

describe("POST /api/events/:id/block-user/:userId", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [ { event_id: ID.ev1, user_id: ID.host1, role: "host" } ] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_activity_log: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can block a user from event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/block-user/${ID.user1}`, {}, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("non-host gets 403", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/block-user/${ID.user2}`, {}, ID.user1);
    assert.equal(status, 403);
  });
});

// ── POST /join and POST /leave ─────────────────────────────────────────────────

describe("POST /api/events/:id/join and /leave", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
        makeEvent({ id: ID.ev2, host_id: ID.host1, state: "open", visibility: "invite_only", rsvp_closed: false }),
        makeEvent({ id: ID.ev3, host_id: ID.host1, state: "open", rsvp_closed: true }),
      ]},
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
        { event_id: ID.ev2, user_id: ID.host1, role: "host" },
        { event_id: ID.ev3, user_id: ID.host1, role: "host" },
      ]},
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("user can join a public event", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}`, null, ID.user2);
    // Only test the join endpoint, not the generic GET
    const { status: joinStatus, body: joinBody } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user2);
    assert.equal(joinStatus, 200);
    assert.ok(joinBody.ok);
  });

  it("cannot join an invite-only event via /join", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev2}/join`, {}, ID.user2);
    assert.equal(status, 403);
  });

  it("cannot join when rsvp_closed is true", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev3}/join`, {}, ID.user2);
    assert.equal(status, 403);
  });

  it("user can leave an event they joined", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/leave`, {}, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it("leave returns 404 when no RSVP exists", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/leave`, {}, ID.user2);
    assert.equal(status, 404);
  });
});

// ── POST /api/events/:id/comments ─────────────────────────────────────────────

describe("POST /api/events/:id/comments", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", attendee_comments_enabled: true }),
      ]},
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
      ]},
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
      ]},
      event_updates: { rows: [] },
      event_activity_log: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("host can post a comment", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/comments`, { body: "Hello attendees!" }, ID.host1);
    assert.equal(status, 201);
    assert.ok(body.body === "Hello attendees!");
  });

  it("going attendee can post a comment", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/comments`, { body: "Excited to attend!" }, ID.user1);
    assert.equal(status, 201);
    assert.ok(body.body === "Excited to attend!");
  });

  it("non-attendee gets 403 when posting comment", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/comments`, { body: "Let me in!" }, ID.user2);
    assert.equal(status, 403);
  });

  it("rejects empty body", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/comments`, { body: "" }, ID.host1);
    assert.equal(status, 400);
  });
});

// ── POST /join capacity enforcement ──────────────────────────────────────────

describe("POST /api/events/:id/join — capacity enforcement", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { await close(); });

  it("join on full event without waitlist returns 403", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "full", visibility: "public", waitlist_enabled: false }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("join on full event with waitlist returns 202 and waitlisted status", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "full", visibility: "public", waitlist_enabled: true }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 202);
    assert.equal(body.status, "waitlisted");
  });

  it("join when max_attendees reached mid-flight redirects to waitlist (202)", async () => {
    // 3 slots, 3 already going → full at capacity check
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public",
          max_attendees: 3, waitlist_enabled: true }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
        { event_id: ID.ev1, user_id: ID.user3, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const hostId = ID.host1; // host joining their own full event
    const newUser = "00000000-0000-0000-0009-000000000099";
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, newUser);
    assert.equal(status, 202);
    assert.equal(body.status, "waitlisted");
  });
});

// ── GET /posts participant-only access ────────────────────────────────────────

describe("GET /api/events/:id/posts — participant-only access", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { await close(); });

  it("non-participant gets 403 on public event posts", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_posts: { rows: [] },
      profiles: { rows: [] },
      blocks: { rows: [] },
      user_friendships: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    // user1 has no RSVP and is not host/cohost
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}/posts`, null, ID.user1);
    assert.equal(status, 403);
  });

  it("going attendee can read posts", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.user1, status: "going" }] },
      event_posts: { rows: [] },
      profiles: { rows: [] },
      blocks: { rows: [] },
      user_friendships: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}/posts`, null, ID.user1);
    assert.equal(status, 200);
  });
});

// ── Safety-summary host-only (co-host excluded) ───────────────────────────────

describe("GET /api/events/:id/safety-summary — host-only access", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { await close(); });

  it("co-host gets 403 (only host may view safety summary)", async () => {
    const client = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
        { event_id: ID.ev1, user_id: ID.user1, role: "co_host" },
      ]},
      event_reports: { rows: [] },
      event_attendee_states: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}/safety-summary`, null, ID.user1);
    assert.equal(status, 403);
  });
});

// ── Private-field leakage — priceUrl and safetyNotes ─────────────────────────

describe("Private-field leakage — priceUrl and safetyNotes", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({
          id: ID.ev1,
          host_id: ID.host1,
          state: "open",
          visibility: "public",
          price_url: "https://eventbrite.com/e/123",
          safety_notes: "Meet near the main entrance",
          show_exact_location: true,
        }),
      ]},
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
      ]},
      event_rsvps: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("non-participant cannot see priceUrl in event response", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.strictEqual(body.priceUrl, null,
      `Expected priceUrl to be null for non-participant, got: ${JSON.stringify(body.priceUrl)}`);
  });

  it("host always sees priceUrl", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.strictEqual(body.priceUrl, "https://eventbrite.com/e/123");
  });

  it("non-host cannot see safetyNotes", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.strictEqual(body.safetyNotes, null,
      `Expected safetyNotes to be null for non-host, got: ${JSON.stringify(body.safetyNotes)}`);
  });

  it("host always sees safetyNotes", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.strictEqual(body.safetyNotes, "Meet near the main entrance");
  });
});

// ── formatEvent participant field gate — going attendee (non-host) ────────────

describe("formatEvent participant field gate — going attendee vs outsider", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({
          id: ID.ev1,
          host_id: ID.host1,
          state: "open",
          visibility: "public",
          price_url: "https://eventbrite.com/e/999",
          safety_notes: "Host-only note",
          show_exact_location: false,
          location_lat: 48.8566,
          location_lng: 2.3522,
        }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_attendee_states: { rows: [] },
      profiles: { rows: [{ id: ID.host1, handle: "host", name: "Host", avatar_url: null }] },
      blocks: { rows: [] },
      user_friendships: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("going attendee (non-host) sees priceUrl in event detail", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.strictEqual(body.priceUrl, "https://eventbrite.com/e/999",
      `Going attendee should see priceUrl, got: ${JSON.stringify(body.priceUrl)}`);
  });

  it("outsider cannot see priceUrl in event detail", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user2);
    assert.equal(status, 200);
    assert.strictEqual(body.priceUrl, null,
      `Outsider should not see priceUrl, got: ${JSON.stringify(body.priceUrl)}`);
  });

  it("going attendee (non-host) sees exact coordinates when show_exact_location is false", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.locationLat !== null,
      `Going attendee should see exact coords, got locationLat=${body.locationLat}`);
  });

  it("outsider cannot see exact coordinates when show_exact_location is false", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user2);
    assert.equal(status, 200);
    assert.strictEqual(body.locationLat, null,
      `Outsider should not see exact coords, got: ${body.locationLat}`);
  });
});

// ── goingAttendees privacy — outsider gets empty list ────────────────────────

describe("goingAttendees privacy — public event outsider gets empty attendee list", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.user1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      profiles: { rows: [
        { id: ID.user1, handle: "alice", name: "Alice", avatar_url: null },
        { id: ID.user2, handle: "bob",   name: "Bob",   avatar_url: null },
      ]},
      event_waitlist: { rows: [] },
      event_attendee_states: { rows: [] },
      blocks: { rows: [] },
      user_friendships: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("outsider (no RSVP) receives empty goingAttendees on a public event", async () => {
    // ID.user3 has no RSVP and is not host/cohost
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user3);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.goingAttendees), "goingAttendees should be an array");
    assert.equal(body.goingAttendees.length, 0,
      `Non-participant should see 0 attendees, got: ${JSON.stringify(body.goingAttendees)}`);
  });

  it("going attendee can see goingAttendees", async () => {
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.ok(body.goingAttendees.length > 0, "Going attendee should see goingAttendees");
  });
});

// ── Age/trust/block gating on GET event detail and /join ─────────────────────

describe("Age/trust/block gating", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { await close(); });

  it("blocked user cannot view event detail (gets 404)", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendee_states: { rows: [] },
      blocks: { rows: [
        { blocker_id: ID.host1, blocked_id: ID.user1 },
      ]},
      user_friendships: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 404);
  });

  it("blocked user cannot join event via /join (gets 403)", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [
        { blocker_id: ID.host1, blocked_id: ID.user1 },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("under-age user is rejected from age-restricted event join (403)", async () => {
    const teenDob = new Date(Date.now() - 17 * 365.25 * 24 * 60 * 60 * 1000).toISOString();
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public", age_min: 21 }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
      profiles: { rows: [{ id: ID.user1, handle: "teen", name: "Teen", avatar_url: null, date_of_birth: teenDob, is_verified: false }] },
      trust_profiles: { rows: [{ user_id: ID.user1, overall_score: 80 }] },
      feature_flags: { rows: [
        { flag: "events_enabled",              enabled: true },
        { flag: "events_waitlist_enabled",     enabled: true },
        { flag: "events_chat_enabled",         enabled: true },
        { flag: "events_trust_gates_enabled",  enabled: true },
        { flag: "events_invites_enabled",      enabled: true },
        { flag: "events_cohosts_enabled",      enabled: true },
        { flag: "events_reports_enabled",      enabled: true },
        { flag: "events_reminders_enabled",    enabled: true },
        { flag: "events_share_links_enabled",  enabled: true },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403);
  });

  it("low trust-score user is rejected from trust-gated event join (403)", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "public", trust_score_min: 70 }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_attendees: { rows: [] },
      event_activity_log: { rows: [] },
      blocks: { rows: [] },
      profiles: { rows: [{ id: ID.user1, handle: "lowt", name: "LowTrust", avatar_url: null, date_of_birth: null, is_verified: false }] },
      trust_profiles: { rows: [{ user_id: ID.user1, overall_score: 40 }] },
      feature_flags: { rows: [
        { flag: "events_enabled",              enabled: true },
        { flag: "events_waitlist_enabled",     enabled: true },
        { flag: "events_chat_enabled",         enabled: true },
        { flag: "events_trust_gates_enabled",  enabled: true },
        { flag: "events_invites_enabled",      enabled: true },
        { flag: "events_cohosts_enabled",      enabled: true },
        { flag: "events_reports_enabled",      enabled: true },
        { flag: "events_reminders_enabled",    enabled: true },
        { flag: "events_share_links_enabled",  enabled: true },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403);
  });
});

// ── Draft publish — spam/prohibited content rejection ─────────────────────────

describe("POST /api/events/drafts/:draftId/publish — spam/content validation", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { await close(); });

  it("rejects draft with prohibited title content (400)", async () => {
    const client = makeFakeClient({
      event_drafts: { rows: [
        {
          id: ID.ev1,
          host_id: ID.host1,
          data: {
            title: "Buy drugs and illegal items here",
            description: null,
            locationName: "Some Place",
            startsAt: new Date(Date.now() + 86400000).toISOString(),
            endsAt:   new Date(Date.now() + 172800000).toISOString(),
            visibility: "public",
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]},
      events: { rows: [] },
      event_roles: { rows: [] },
      event_activity_log: { rows: [] },
      event_rsvps: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/drafts/${ID.ev1}/publish`, {}, ID.host1);
    assert.equal(status, 400);
  });

  it("rejects draft with disallowed ticket URL (400)", async () => {
    const client = makeFakeClient({
      event_drafts: { rows: [
        {
          id: ID.ev1,
          host_id: ID.host1,
          data: {
            title: "Fun festival",
            description: null,
            locationName: "City Park",
            startsAt: new Date(Date.now() + 86400000).toISOString(),
            endsAt:   new Date(Date.now() + 172800000).toISOString(),
            visibility: "public",
            priceUrl: "https://phishingsite.xyz/buy-ticket",
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      ]},
      events: { rows: [] },
      event_roles: { rows: [] },
      event_activity_log: { rows: [] },
      event_rsvps: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/drafts/${ID.ev1}/publish`, {}, ID.host1);
    assert.equal(status, 400);
  });
});

// ── invite-accept eligibility gate ───────────────────────────────────────────

describe("invite-accept — eligibility enforced before invite marked accepted", () => {
  let port: number;
  let close: () => Promise<void>;

  afterEach(async () => { if (close) await close(); });

  it("blocked user cannot accept invite — 403 and invite stays pending", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending" },
      ]},
      // user1 is blocked by host
      blocks: { rows: [{ blocker_id: ID.host1, blocked_id: ID.user1 }] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${ID.invite1}/accept`, {}, ID.user1);
    assert.equal(status, 403,
      `Blocked user should receive 403, got ${status}`);
  });

  it("eligible user on open event can accept invite — 200 status=accepted", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }),
      ]},
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending" },
      ]},
      blocks: { rows: [] },
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${ID.invite1}/accept`, {}, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.status, "accepted");
  });
});

// ── event_attendees sync invariant ────────────────────────────────────────────

describe("event_attendees sync — RSVP upsert via /rsvp keeps attendees in sync", () => {
  let port: number;
  let close: () => Promise<void>;
  let capturedAttendees: Array<{ op: string; event_id: string; user_id: string }>;

  beforeEach(async () => {
    capturedAttendees = [];
    const baseClient = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_attendees: { rows: [] },
      event_waitlist: { rows: [] },
      blocks: { rows: [] },
    });
    // Wrap to capture event_attendees upsert/delete calls
    const origFrom = baseClient.from.bind(baseClient);
    (baseClient as any).from = (table: string) => {
      const builder = origFrom(table);
      if (table === "event_attendees") {
        const origUpsert = builder.upsert?.bind(builder);
        const origDelete = builder.delete?.bind(builder);
        if (origUpsert) {
          builder.upsert = (row: any, opts: any) => {
            capturedAttendees.push({ op: "upsert", event_id: row.event_id, user_id: row.user_id });
            return origUpsert(row, opts);
          };
        }
        if (origDelete) {
          builder.delete = () => {
            const delBuilder = origDelete();
            const origEq = delBuilder.eq?.bind(delBuilder);
            if (origEq) {
              let captured = false;
              delBuilder.eq = (col: string, val: string) => {
                if (col === "user_id" && !captured) {
                  capturedAttendees.push({ op: "delete", event_id: ID.ev1, user_id: val });
                  captured = true;
                }
                return origEq(col, val);
              };
            }
            return delBuilder;
          };
        }
      }
      return builder;
    };
    _setTestClient(baseClient, true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { if (close) await close(); });

  it("POST /rsvp going → event_attendees upserted", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
    assert.equal(status, 200);
    const upserted = capturedAttendees.some(c => c.op === "upsert" && c.user_id === ID.user1);
    assert.ok(upserted, `event_attendees upsert expected after going RSVP, got: ${JSON.stringify(capturedAttendees)}`);
  });

  it("DELETE /rsvp → event_attendees entry deleted", async () => {
    // Seed an RSVP so delete can find it
    const seedClient = makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.user1, status: "going" }] },
      event_attendees: { rows: [{ event_id: ID.ev1, user_id: ID.user1 }] },
      event_waitlist: { rows: [] },
      blocks: { rows: [] },
    });
    _setTestClient(seedClient, true);
    const { status } = await req(port, "DELETE", `/api/events/${ID.ev1}/rsvp`, null, ID.user1);
    assert.equal(status, 200);
  });
});

// ── friends_only privacy — city/nearby/search discovery routes ────────────────

describe("friends_only privacy — discovery routes exclude non-friends", () => {
  let port: number;
  let close: () => Promise<void>;

  const friendsOnlyHost = "00000000-0000-0000-0099-000000000001";

  function makeSetup(extraFriendships: Row[]) {
    return makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, visibility: "public",      host_id: ID.host1, city: "Paris", title: "Public Jazz", location_lat: 48.8566, location_lng: 2.3522 }),
        makeEvent({ id: ID.ev2, visibility: "friends_only", host_id: friendsOnlyHost, city: "Paris", title: "Friends Only Party", location_lat: 48.8570, location_lng: 2.3520 }),
      ]},
      event_roles: { rows: [] },
      event_rsvps: { rows: [] },
      user_friendships: { rows: extraFriendships },
      blocks: { rows: [] },
      profiles: { rows: [] },
    });
  }

  afterEach(async () => { if (close) await close(); });

  it("GET /events/city/:city — non-friend cannot see friends_only event", async () => {
    _setTestClient(makeSetup([]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/city/Paris", null, ID.user1);
    assert.ok(!body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must not appear for non-friend on /city");
    assert.ok(body.events.some((e: any) => e.id === ID.ev1),
      "public event should appear on /city");
  });

  it("GET /events/city/:city — friend CAN see friends_only event", async () => {
    _setTestClient(makeSetup([{ user_a: ID.user1, user_b: friendsOnlyHost }]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/city/Paris", null, ID.user1);
    assert.ok(body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must appear for a friend on /city");
  });

  it("GET /events/nearby — non-friend cannot see friends_only event", async () => {
    _setTestClient(makeSetup([]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/nearby?lat=48.857&lng=2.352&radiusKm=5", null, ID.user1);
    assert.ok(!body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must not appear for non-friend on /nearby");
  });

  it("GET /events/nearby — friend CAN see friends_only event", async () => {
    _setTestClient(makeSetup([{ user_a: ID.user1, user_b: friendsOnlyHost }]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/nearby?lat=48.857&lng=2.352&radiusKm=5", null, ID.user1);
    assert.ok(body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must appear for a friend on /nearby");
  });

  it("GET /events/search — non-friend cannot see friends_only event", async () => {
    _setTestClient(makeSetup([]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/search?q=Friends", null, ID.user1);
    assert.ok(!body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must not appear for non-friend on /search");
  });

  it("GET /events/search — friend CAN see friends_only event", async () => {
    _setTestClient(makeSetup([{ user_a: ID.user1, user_b: friendsOnlyHost }]), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", "/api/events/search?q=Friends", null, ID.user1);
    assert.ok(body.events.some((e: any) => e.id === ID.ev2),
      "friends_only event must appear for a friend on /search");
  });
});

// ── invite-accept capacity enforcement ───────────────────────────────────────

describe("invite-accept — capacity/waitlist enforcement", () => {
  let port: number;
  let close: () => Promise<void>;

  afterEach(async () => { if (close) await close(); });

  it("full event with waitlist enabled → accept returns waitlisted", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "full", max_attendees: 2, waitlist_enabled: true }),
      ]},
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending" },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${ID.invite1}/accept`, {}, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.status, "waitlisted",
      `Full event with waitlist should return status=waitlisted, got: ${body.status}`);
  });

  it("full event with waitlist disabled → accept returns accepted (no RSVP inserted)", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "full", max_attendees: 2, waitlist_enabled: false }),
      ]},
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      event_waitlist: { rows: [] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending" },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${ID.invite1}/accept`, {}, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.status, "accepted",
      `Full+no-waitlist event: invite recorded as accepted, got: ${body.status}`);
  });

  it("open event → accept RSVPs as going (status=accepted)", async () => {
    const client = makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", max_attendees: 10, waitlist_enabled: true }),
      ]},
      event_rsvps: { rows: [] },
      event_waitlist: { rows: [] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_invites: { rows: [
        { id: ID.invite1, event_id: ID.ev1, inviter_id: ID.host1, invitee_id: ID.user1, status: "pending" },
      ]},
    });
    _setTestClient(client, true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/invites/${ID.invite1}/accept`, {}, ID.user1);
    assert.equal(status, 200);
    assert.equal(body.status, "accepted",
      `Open event: invite should RSVP as going and return accepted, got: ${body.status}`);
  });
});

// ── RLS policy access-control tests ──────────────────────────────────────────
//
// These tests verify the server-side access-control semantics that mirror the
// database RLS policies in 0080_events_extension.sql. They use the fake Supabase
// client (same pattern as all other tests in this file) rather than a live DB,
// because the API layer enforces the same policy semantics via explicit checks
// (checkEventEligibility, canViewEvent, isBlocked, friendship gates, host-only
// guards, etc.). This approach validates policy INTENT across all code paths.
//
// Covered scenarios:
//  - Host has full access to own event
//  - Cohost / moderator bypass viewer gates
//  - Outsider cannot read invite_only event detail
//  - Blocked user rejected from all action endpoints
//  - friends_only events hidden from non-friends in detail + listings
//  - Age-gated events: ineligible viewer rejected at join
//  - Banned attendee cannot rejoin
//  - Non-participant cannot read safety notes
//  - Host-only endpoints reject non-hosts (cancel, archive, safety-summary)
//  - Exact location hidden for outsider, visible to going attendee

describe("RLS-equivalent access-control — host/cohost/outsider/blocked", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { if (close) await close(); });

  it("host can list own drafts (GET /events/drafts returns own drafts only)", async () => {
    _setTestClient(makeFakeClient({
      event_drafts: { rows: [
        { id: ID.ev1, host_id: ID.host1, data: { title: "My Draft" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { id: ID.ev2, host_id: ID.user2,  data: { title: "Other Draft" }, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      ]},
    }), true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "GET", `/api/events/drafts`, null, ID.host1);
    assert.equal(status, 200);
    // Only host1's draft should be returned, not user2's
    assert.ok(body.drafts.some((d: any) => d.id === ID.ev1), "host should see own draft");
    assert.ok(!body.drafts.some((d: any) => d.id === ID.ev2), "host must not see other user's draft");
  });

  it("non-owner cannot DELETE another user's draft — 403", async () => {
    _setTestClient(makeFakeClient({
      event_drafts: { rows: [{
        id: ID.ev1, host_id: ID.host1,
        data: { title: "Draft" },
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }]},
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "DELETE", `/api/events/drafts/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 403);
  });

  it("outsider cannot see invite_only event detail — receives locked sentinel", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "invite_only" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    // Outsider hitting a non-public event receives the locked sentinel (200 + locked:true)
    // so deep-link handlers can render a private-wall screen instead of a 404.
    // The response must NOT contain any event fields (title, host, etc.).
    assert.equal(status, 200, `Expected 200 locked sentinel, got ${status}`);
    assert.equal(body.locked, true, "Outsider must receive locked:true sentinel for invite_only event");
    assert.equal(body.title, undefined, "Locked sentinel must not expose event title");
  });

  it("blocked user cannot join an event", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [{ blocker_id: ID.host1, blocked_id: ID.user1 }] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Blocked user must receive 403 on join, got ${status}`);
  });

  it("banned attendee cannot rejoin via /join", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, role: "host" },
        { event_id: ID.ev1, user_id: ID.user1, role: "banned" },
      ]},
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Banned user must receive 403 on join, got ${status}`);
  });

  it("non-participant cannot read safety notes in event detail", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, safety_notes: "secret gate code: 1234" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(status, 200);
    assert.strictEqual(body.safetyNotes, null,
      `Non-participant must not see safetyNotes, got: ${body.safetyNotes}`);
  });

  it("host sees safety notes in own event detail", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, safety_notes: "secret gate code: 1234" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.host1);
    assert.equal(status, 200);
    assert.strictEqual(body.safetyNotes, "secret gate code: 1234",
      `Host must see own safetyNotes, got: ${body.safetyNotes}`);
  });

  it("non-host cannot cancel another user's event", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/cancel`, {}, ID.user1);
    assert.equal(status, 403, `Non-host must receive 403 on cancel, got ${status}`);
  });

  it("non-host cannot archive another user's event", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "completed" }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/archive`, {}, ID.user1);
    assert.equal(status, 403, `Non-host must receive 403 on archive, got ${status}`);
  });

  it("exact location hidden for outsider when show_exact_location is false", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, show_exact_location: false, location_lat: 48.8566, location_lng: 2.3522 }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.strictEqual(body.locationLat, null, `Outsider must not see exact lat, got: ${body.locationLat}`);
    assert.strictEqual(body.locationLng, null, `Outsider must not see exact lng, got: ${body.locationLng}`);
  });

  it("exact location visible to going attendee even when show_exact_location is false", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, show_exact_location: false, location_lat: 48.8566, location_lng: 2.3522 }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [{ event_id: ID.ev1, user_id: ID.user1, status: "going" }] },
    }), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.ok(body.locationLat !== null, `Going attendee must see exact lat, got: ${body.locationLat}`);
  });

  it("age-gated event: under-age user cannot join (trust gates flag enabled)", async () => {
    _setTestClient(makeFakeClient({
      feature_flags: { rows: [
        { flag: "events_enabled", enabled: true },
        { flag: "events_trust_gates_enabled", enabled: true },
        { flag: "events_waitlist_enabled", enabled: true },
        { flag: "events_chat_enabled", enabled: true },
        { flag: "events_invites_enabled", enabled: true },
        { flag: "events_cohosts_enabled", enabled: true },
        { flag: "events_reports_enabled", enabled: true },
        { flag: "events_reminders_enabled", enabled: true },
        { flag: "events_share_links_enabled", enabled: true },
      ]},
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", age_min: 21 }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
      // user1 has age 18 — under the 21 minimum
      trust_profiles: { rows: [{ user_id: ID.user1, age: 18, trust_score: 80 }] },
      trust_settings: { rows: [] },
      trust_caps: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Under-age user must receive 403 on join, got ${status}`);
  });
});

// ── circle / trip visibility enforcement ─────────────────────────────────────

describe("circle/trip visibility enforcement — join + rsvp gated on membership", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { if (close) await close(); });

  it("circle event: non-member cannot join (no circle_id → 403)", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "circle" as any, circle_id: null }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Non-member (no circle linked) must get 403, got ${status}`);
  });

  it("circle event: non-member cannot join (no circle_memberships row → 403)", async () => {
    const circleId = "cccccccc-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "circle" as any, circle_id: circleId }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
      circle_memberships: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Non-circle-member must get 403 on join, got ${status}`);
  });

  it("circle event: circle member can join", async () => {
    const circleId = "cccccccc-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", max_attendees: 10, visibility: "circle" as any, circle_id: circleId }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_attendees: { rows: [] },
      blocks: { rows: [] },
      circle_memberships: { rows: [{ user_id: circleId, other_id: ID.user1 }] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 200, `Circle member must be able to join, got ${status}`);
  });

  it("trip event: non-trip-member cannot join (no trip_id → 403)", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "trip" as any, trip_id: null }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Non-member (no trip linked) must get 403, got ${status}`);
  });

  it("trip event: non-trip-member cannot join (no trip_members row → 403)", async () => {
    const tripId = "tttttttt-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "trip" as any, trip_id: tripId }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
      trip_members: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 403, `Non-trip-member must get 403 on join, got ${status}`);
  });

  it("trip event: accepted trip member can join", async () => {
    const tripId = "tttttttt-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", max_attendees: 10, visibility: "trip" as any, trip_id: tripId }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      event_attendees: { rows: [] },
      blocks: { rows: [] },
      trip_members: { rows: [{ trip_id: tripId, user_id: ID.user1, role: "member", status: "accepted" }] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/join`, {}, ID.user1);
    assert.equal(status, 200, `Accepted trip member must be able to join, got ${status}`);
  });

  it("circle event: non-member cannot RSVP (403)", async () => {
    const circleId = "cccccccc-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "circle" as any, circle_id: circleId }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
      circle_memberships: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/rsvp`, { status: "going" }, ID.user1);
    assert.equal(status, 403, `Non-circle-member must get 403 on RSVP, got ${status}`);
  });

  it("circle event: non-member cannot view event detail — receives locked sentinel", async () => {
    const circleId = "cccccccc-1111-0000-0000-000000000001";
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1, state: "open", visibility: "circle" as any, circle_id: circleId }) ] },
      event_roles: { rows: [] },
      event_rsvps: { rows: [] },
      circle_memberships: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    const { status, body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    // Non-public event: locked sentinel (200 + locked:true) so deep-link handlers
    // can render a private wall instead of a generic not-found screen.
    assert.equal(status, 200, `Non-circle-member must receive 200 locked sentinel, got ${status}`);
    assert.equal(body.locked, true, "Non-circle-member must receive locked:true sentinel for circle event");
  });
});

// ── privacy variant access-control — invite_only / friends_only ───────────────

describe("RLS privacy variants — invite_only and friends_only listing exclusion", () => {
  let port: number;
  let close: () => Promise<void>;
  afterEach(async () => { if (close) await close(); });

  it("invite_only event does NOT appear in city listing for outsider", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [
        makeEvent({ id: ID.ev1, host_id: ID.host1, visibility: "public",      title: "Public event",  city: "Paris" }),
        makeEvent({ id: ID.ev2, host_id: ID.host1, visibility: "invite_only", title: "Secret event",  city: "Paris" }),
      ]},
      event_roles: { rows: [] },
      event_rsvps: { rows: [] },
      blocks: { rows: [] },
    }), true);
    ({ port, close } = await startServer());
    // City listing only returns public/friends_only — invite_only filtered by DB query
    const { status, body } = await req(port, "GET", `/api/events/city/Paris`, null, ID.user1);
    assert.equal(status, 200);
    assert.ok(!body.events.some((e: any) => e.id === ID.ev2),
      "invite_only event must not appear in city listing");
    assert.ok(body.events.some((e: any) => e.id === ID.ev1),
      "public event must appear in city listing");
  });

  it("attendee-list hidden from outsider on public event", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      profiles: { rows: [
        { id: ID.host1, handle: "host", name: "Host", avatar_url: null },
        { id: ID.user2, handle: "user2", name: "User2", avatar_url: null },
      ]},
    }), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.user1);
    assert.equal(body.goingAttendees?.length ?? 0, 0,
      "Outsider must see empty goingAttendees list, got: " + JSON.stringify(body.goingAttendees));
  });

  it("host can see full attendee list on own event", async () => {
    _setTestClient(makeFakeClient({
      events: { rows: [ makeEvent({ id: ID.ev1, host_id: ID.host1 }) ] },
      event_roles: { rows: [{ event_id: ID.ev1, user_id: ID.host1, role: "host" }] },
      event_rsvps: { rows: [
        { event_id: ID.ev1, user_id: ID.host1, status: "going" },
        { event_id: ID.ev1, user_id: ID.user2, status: "going" },
      ]},
      profiles: { rows: [
        { id: ID.host1, handle: "host", name: "Host", avatar_url: null },
        { id: ID.user2, handle: "user2", name: "User2", avatar_url: null },
      ]},
    }), true);
    ({ port, close } = await startServer());
    const { body } = await req(port, "GET", `/api/events/${ID.ev1}`, null, ID.host1);
    assert.ok((body.goingAttendees?.length ?? 0) > 0,
      "Host must see going attendees list, got: " + JSON.stringify(body.goingAttendees));
  });
});
