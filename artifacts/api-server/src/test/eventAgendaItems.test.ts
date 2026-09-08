/**
 * eventAgendaItems.test.ts
 *
 * Tests for POST /api/events/:id/agenda-items
 *
 * Scenarios:
 *  1. Host can attach a place → 201 + created item returned
 *  2. RSVP'd attendee can attach a place → 201
 *  3. Non-attendee (no RSVP, no role) → 403
 *  4. Non-existent event → 404
 *  5. Invalid payload (missing title) → 422 / 400
 *  6. DB insert error → 500
 *
 * Run standalone: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/eventAgendaItems.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── ID constants (valid UUIDs for isUuid()) ───────────────────────────────────

const HOST_ID    = "aaaa0001-0000-0000-0000-000000000001";
const COHOST_ID  = "aaaa0002-0000-0000-0000-000000000002";
const ATTENDEE_ID= "aaaa0003-0000-0000-0000-000000000003";
const OUTSIDER_ID= "aaaa0004-0000-0000-0000-000000000004";
const EVENT_ID   = "bbbb0001-0000-0000-0000-000000000001";
const MISSING_ID = "cccc0001-0000-0000-0000-000000000001";

// ── Fake Supabase client ──────────────────────────────────────────────────────

interface Row { [k: string]: any }

function makeFakeClient(opts: {
  eventExists?: boolean;
  rsvpUserId?: string | null;   // user who has an RSVP row
  insertError?: string | null;
  /** Rows the list endpoint should find — so a read case examines a NON-ZERO number of objects. */
  seedItems?: Row[];
  /**
   * Tables that answer `{ data: null, error }` — the RESOLVED failure
   * supabase-js really produces, never a throw. Without this the double
   * modelled only success and every fail-closed branch was unreachable.
   */
  failTables?: ReadonlySet<string>;
} = {}) {
  const {
    eventExists = true,
    rsvpUserId  = null,
    insertError = null,
    seedItems   = [],
    failTables  = new Set<string>(),
  } = opts;

  const agendaItems: Row[] = [...seedItems];

  const eventRow: Row = {
    id:          EVENT_ID,
    host_id:     HOST_ID,
    title:       "Test Event",
    state:       "open",
    visibility:  "public",
  };

  const eventRoleRows: Row[] = [
    { event_id: EVENT_ID, user_id: COHOST_ID, role: "co_host" },
  ];

  function chain(tableName: string, rows: Row[]) {
    let filtered = [...rows];
    let singleMode = false;
    let pendingInsert: Row | null = null;
    let shouldInsertError: string | null = null;
    const failed = failTables.has(tableName)
      ? { message: `${tableName} read failed`, code: "57014" }
      : null;

    const obj: any = {
      select() { return obj; },
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return obj;
      },
      in(col: string, vals: any[]) {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return obj;
      },
      or()    { return obj; },
      order() { return obj; },
      limit(n: number) { filtered = filtered.slice(0, n); return obj; },
      maybeSingle() {
        singleMode = true;
        if (failed) return Promise.resolve({ data: null, error: failed });
        return Promise.resolve({ data: filtered[0] ?? null, error: null });
      },
      single() {
        singleMode = true;
        if (pendingInsert) {
          if (shouldInsertError) {
            return Promise.resolve({ data: null, error: { message: shouldInsertError } });
          }
          const row = { id: `fake-agenda-${Date.now()}`, ...pendingInsert };
          agendaItems.push(row);
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({
          data: filtered[0] ?? null,
          error: filtered[0] ? null : { message: "No rows" },
        });
      },
      insert(data: Row) {
        pendingInsert = data;
        if (tableName === "event_agenda_items" && insertError) {
          shouldInsertError = insertError;
        }
        return obj;
      },
      // other write ops — no-op for these tests
      upsert() { return Promise.resolve({ data: null, error: null }); },
      update() { return obj; },
      delete() { return obj; },
      then(onFulfilled: any, onRejected: any) {
        if (failed) return Promise.resolve({ data: null, error: failed }).then(onFulfilled, onRejected);
        const data = singleMode ? (filtered[0] ?? null) : filtered;
        return Promise.resolve({ data, error: null }).then(onFulfilled, onRejected);
      },
    };
    return obj;
  }

  return {
    from(tableName: string) {
      if (tableName === "events") {
        return chain(tableName, eventExists ? [eventRow] : []);
      }
      if (tableName === "event_roles") {
        return chain(tableName, eventRoleRows);
      }
      if (tableName === "event_rsvps") {
        const rows = rsvpUserId
          ? [{ event_id: EVENT_ID, user_id: rsvpUserId, status: "going" }]
          : [];
        return chain(tableName, rows);
      }
      if (tableName === "event_agenda_items") {
        return chain(tableName, agendaItems);
      }
      // blocks, feature_flags, etc. — return empty / no-ops
      return chain(tableName, []);
    },
    auth: {
      getUser: async (token: string) => {
        const userId = token.startsWith("tok-") ? token.slice(4) : null;
        if (!userId) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: userId } }, error: null };
      },
    },
    _agendaItems: agendaItems,
  };
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv: Server = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({
        port,
        close: () => new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))),
      });
    });
    srv.on("error", reject);
  });
}

function tok(userId: string) { return `tok-${userId}`; }

async function postAgendaItem(
  port: number,
  eventId: string,
  body: unknown,
  userId: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/events/${eventId}/agenda-items`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${tok(userId)}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function getAgendaItems(
  port: number,
  eventId: string,
  userId: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/events/${eventId}/agenda-items`, {
    headers: { "Authorization": `Bearer ${tok(userId)}` },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /api/events/:id/agenda-items — host can attach a place", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 201 with the created agenda item", async () => {
    const r = await postAgendaItem(port, EVENT_ID, {
      title:        "Shibuya Crossing",
      locationName: "Shibuya, Tokyo",
      locationLat:  35.6595,
      locationLng:  139.7005,
      placeId:      "place-abc123",
    }, HOST_ID);

    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.id,                         "response must include an id");
    assert.equal(r.body.title, "Shibuya Crossing","title must match");
    assert.equal(r.body.event_id, EVENT_ID,        "event_id must be set");
    assert.equal(r.body.added_by, HOST_ID,         "added_by must be the caller");
    assert.equal(r.body.location_name, "Shibuya, Tokyo");
    assert.equal(r.body.place_id, "place-abc123");
  });

  it("persists lat/lng when provided", async () => {
    const r = await postAgendaItem(port, EVENT_ID, {
      title:       "Eiffel Tower",
      locationLat:  48.8584,
      locationLng:   2.2945,
    }, HOST_ID);

    assert.equal(r.status, 201);
    assert.equal(r.body.location_lat, 48.8584);
    assert.equal(r.body.location_lng,  2.2945);
  });

  it("accepts a minimal payload (title only)", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "Meet-up spot" }, HOST_ID);
    assert.equal(r.status, 201);
    assert.equal(r.body.title, "Meet-up spot");
    assert.equal(r.body.location_name, null);
    assert.equal(r.body.location_lat,  null);
  });
});

describe("POST /api/events/:id/agenda-items — co-host can attach a place", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 201 for a co-host", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "Co-host spot" }, COHOST_ID);
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.added_by, COHOST_ID);
  });
});

describe("POST /api/events/:id/agenda-items — RSVP'd attendee can attach a place", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient({ rsvpUserId: ATTENDEE_ID }), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 201 for an RSVP'd attendee", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "Attendee spot" }, ATTENDEE_ID);
    assert.equal(r.status, 201, `expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.added_by, ATTENDEE_ID);
  });
});

describe("POST /api/events/:id/agenda-items — non-attendee is rejected", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    // No rsvpUserId → outsider has no RSVP and no role
    _setTestClient(makeFakeClient(), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 403 for a user with no RSVP and no role", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "Intruder spot" }, OUTSIDER_ID);
    assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe("POST /api/events/:id/agenda-items — event not found", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient({ eventExists: false }), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 404 when the event does not exist", async () => {
    const r = await postAgendaItem(port, MISSING_ID, { title: "Ghost spot" }, HOST_ID);
    assert.equal(r.status, 404, `expected 404, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

describe("POST /api/events/:id/agenda-items — invalid payload", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient(), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 4xx when title is missing", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { locationName: "Somewhere" }, HOST_ID);
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  });

  it("returns 4xx when title is empty string", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "" }, HOST_ID);
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  });

  it("returns 400 for a non-UUID event id", async () => {
    const r = await postAgendaItem(port, "not-a-uuid", { title: "Spot" }, HOST_ID);
    assert.ok(r.status >= 400 && r.status < 500, `expected 4xx, got ${r.status}`);
  });
});

describe("POST /api/events/:id/agenda-items — DB insert error", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ port, close } = await startServer());
    _setTestClient(makeFakeClient({ insertError: "unique violation" }), true);
  });
  afterEach(async () => {
    _setTestClient(null as any, false);
    await close();
  });

  it("returns 5xx when the DB insert fails", async () => {
    const r = await postAgendaItem(port, EVENT_ID, { title: "DB error spot" }, HOST_ID);
    assert.ok(r.status >= 500, `expected 5xx, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /api/events/:id/agenda-items — the read side had NO coverage at all
// ══════════════════════════════════════════════════════════════════════════════
//
// The list is participant-scoped: host / co-host / going-or-maybe attendee only.
// That is an authorization gate, and nothing exercised it. Every case here
// asserts the number of objects it looked at, so a case that inspected an empty
// list FAILS rather than passing quietly.

const SEED_ITEMS: Row[] = [
  { id: "ag-1", event_id: EVENT_ID, title: "Meet at the gate", created_at: "2026-09-01T10:00:00Z" },
  { id: "ag-2", event_id: EVENT_ID, title: "Dinner",           created_at: "2026-09-01T11:00:00Z" },
];

describe("GET /api/events/:id/agenda-items — participant-scoped read", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeEach(async () => { ({ port, close } = await startServer()); });
  afterEach(async () => { _setTestClient(null as any, false); await close(); });

  it("the host receives the items — a NON-ZERO number of them", async () => {
    _setTestClient(makeFakeClient({ seedItems: SEED_ITEMS }), true);
    const { status, body } = await getAgendaItems(port, EVENT_ID, HOST_ID);
    assert.equal(status, 200, JSON.stringify(body));
    // Vacuity guard: an empty list would satisfy "the host is not refused".
    assert.equal(body.items.length, 2, `expected both seeded items, got ${JSON.stringify(body.items)}`);
    assert.deepEqual(body.items.map((i: Row) => i.id).sort(), ["ag-1", "ag-2"]);
  });

  it("a co-host receives them", async () => {
    _setTestClient(makeFakeClient({ seedItems: SEED_ITEMS }), true);
    const { status, body } = await getAgendaItems(port, EVENT_ID, COHOST_ID);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.items.length, 2);
  });

  it("a going attendee receives them", async () => {
    _setTestClient(makeFakeClient({ seedItems: SEED_ITEMS, rsvpUserId: ATTENDEE_ID }), true);
    const { status, body } = await getAgendaItems(port, EVENT_ID, ATTENDEE_ID);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.items.length, 2);
  });

  it("REFUSES an outsider with `forbidden`, and leaks no item", async () => {
    // The CODE, not merely a non-200: a request rejected at validation would
    // also be non-200 and would say nothing about the gate.
    _setTestClient(makeFakeClient({ seedItems: SEED_ITEMS }), true);
    const { status, body } = await getAgendaItems(port, EVENT_ID, OUTSIDER_ID);
    assert.equal(body?.error, "forbidden", JSON.stringify(body));
    assert.equal(status, 403);
    assert.ok(!body.items, "an outsider must not receive an items array at all");
  });

  it("FAILS CLOSED when event_rsvps cannot be read — an outage does not admit", async () => {
    // supabase-js RESOLVES on a database error, so the discarded `error` here
    // makes "this user has no RSVP" and "the RSVP table is unreadable" the same
    // falsy value. It happens to deny; this pins that it keeps denying.
    _setTestClient(
      makeFakeClient({ seedItems: SEED_ITEMS, rsvpUserId: ATTENDEE_ID, failTables: new Set(["event_rsvps"]) }),
      true,
    );
    const { status, body } = await getAgendaItems(port, EVENT_ID, ATTENDEE_ID);
    assert.equal(body?.error, "forbidden", JSON.stringify(body));
    assert.equal(status, 403);
  });

  it("REPORTS a failed list read instead of serving an empty agenda", async () => {
    // An unreadable event_agenda_items must not render as "this event has no
    // agenda". The route checks `.error`; this is what proves it still does.
    _setTestClient(
      makeFakeClient({ seedItems: SEED_ITEMS, failTables: new Set(["event_agenda_items"]) }),
      true,
    );
    const { status, body } = await getAgendaItems(port, EVENT_ID, HOST_ID);
    assert.equal(body?.error, "db_error", JSON.stringify(body));
    assert.notEqual(status, 200);
    assert.notDeepEqual(body?.items, [], "an outage must not be served as an empty agenda");
  });

  it("404s an event that does not exist", async () => {
    _setTestClient(makeFakeClient({ eventExists: false }), true);
    const { status, body } = await getAgendaItems(port, MISSING_ID, HOST_ID);
    assert.equal(body?.error, "not_found", JSON.stringify(body));
    assert.equal(status, 404);
  });
});
