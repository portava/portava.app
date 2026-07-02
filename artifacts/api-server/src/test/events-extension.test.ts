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
    assert.ok(body.data);
  });

  it("PATCH /drafts/:id updates draft data", async () => {
    const { status, body } = await req(port, "PATCH", `/api/events/drafts/${ID.draft1}`, { title: "Updated Draft" }, ID.host1);
    assert.equal(status, 200);
    assert.ok(body.id === ID.draft1 || body.data !== undefined);
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
      events: { rows: [ makeEvent({ id: ID.ev1, state: "open", host_id: ID.host1 }) ] },
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

  beforeEach(async () => {
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
  afterEach(async () => { await close(); });

  it("going attendee can upload media", async () => {
    const { status, body } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl: "https://example.com/photo.jpg",
      mediaType: "image",
      caption: "Great time!",
    }, ID.user1);
    assert.equal(status, 201);
    assert.equal(body.media_url, "https://example.com/photo.jpg");
  });

  it("non-attendee gets 403 uploading media", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/media`, {
      mediaUrl: "https://example.com/photo.jpg",
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

// ── Cross-system stubs ────────────────────────────────────────────────────────

describe("Cross-system stub routes", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    _setTestClient(makeFakeClient(), true);
    ({ port, close } = await startServer());
  });
  afterEach(async () => { await close(); });

  it("POST /add-to-trip returns 501", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/add-to-trip`, { tripId: ID.ev2 }, ID.host1);
    assert.equal(status, 501);
  });

  it("POST /link-circle returns 501", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/link-circle`, { circleId: ID.ev2 }, ID.host1);
    assert.equal(status, 501);
  });

  it("POST /telegraph-thread returns 501", async () => {
    const { status } = await req(port, "POST", `/api/events/${ID.ev1}/telegraph-thread`, {}, ID.host1);
    assert.equal(status, 501);
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
