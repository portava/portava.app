/**
 * Trip reservations tests — paste-to-import, confirm-before-commit, CRUD.
 *
 * Covers:
 *  - Import inserts ONLY pending_confirm reservation rows — never plan items
 *  - Fenced ```json model output is fence-stripped correctly
 *  - Pasted text reaches the model UGC-wrapped (data, not instructions)
 *  - confirm + addToPlan creates a trip_plan_items row with the mapped category
 *  - Flag + membership gates
 *  - PATCH permission matrix (creator / owner / co_host yes; other member no)
 *  - extraction_failed → empty import with error field, zero inserts
 *
 * Runtime: node:test + node:assert/strict. No network / no real DB.
 * Run: node --import tsx/esm --test src/test/tripReservations.test.ts
 */
import { describe, it, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestOpenAI } from "../lib/openai.js";

// ── Test IDs ──────────────────────────────────────────────────────────────────
const OWNER_ID   = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID  = "22222222-2222-2222-2222-222222222222"; // reservation creator
const COHOST_ID  = "33333333-3333-3333-3333-333333333333";
const MEMBER2_ID = "44444444-4444-4444-4444-444444444444";
const OTHER_ID   = "55555555-5555-5555-5555-555555555555"; // not on the trip
const TRIP_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const RES_ID     = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const RES2_ID    = "dddddddd-dddd-dddd-dddd-dddddddddddd";

// ── Fake supabase client ──────────────────────────────────────────────────────
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    feature_flags:     tables.feature_flags     ?? { rows: [] },
    profiles:          tables.profiles          ?? { rows: [] },
    trips:             tables.trips             ?? { rows: [] },
    trip_members:      tables.trip_members      ?? { rows: [] },
    trip_reservations: tables.trip_reservations ?? { rows: [] },
    trip_plan_items:   tables.trip_plan_items   ?? { rows: [] },
    ...tables,
  };

  let idCtr = 0;
  const newId = () => `${String(++idCtr).padStart(8, "0")}-0000-0000-0000-000000000000`;

  function chain(tableName: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _single = false;
    let _maybeSingle = false;

    const obj: any = {
      select: () => obj,
      insert(data: Row | Row[]) { _insert = data; return obj; },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any)    { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any)   { filters.push((r) => r[col] !== val); return obj; },
      is(col: string, val: any)    { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      ilike(col: string, pattern: string) {
        const re = new RegExp("^" + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$", "i");
        filters.push((r) => re.test(String(r[col] ?? "")));
        return obj;
      },
      order: () => obj,
      limit: () => obj,
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single = true;      return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        if (!db[tableName]) db[tableName] = { rows: [] };
        const table = db[tableName];

        if (_insert !== null) {
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
          table.rows.push(...inserted);
          return { data: _single || _maybeSingle ? inserted[0] ?? null : inserted, error: null };
        }
        if (_update !== null) {
          const matched: Row[] = [];
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              const updated = { ...r, ..._update };
              matched.push(updated);
              return updated;
            }
            return r;
          });
          return { data: _single || _maybeSingle ? matched[0] ?? null : matched, error: null };
        }
        if (_delete) {
          table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }
        const rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_single || _maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = {
          "owner-token":   OWNER_ID,
          "member-token":  MEMBER_ID,
          "cohost-token":  COHOST_ID,
          "member2-token": MEMBER2_ID,
          "other-token":   OTHER_ID,
        };
        const id = map[token];
        return id
          ? { data: { user: { id } }, error: null }
          : { data: { user: null }, error: { message: "invalid token" } };
      },
    },
    from: (tableName: string) => chain(tableName),
  };

  return { client, db };
}

function baseTables(overrides: Record<string, FakeTable> = {}): Record<string, FakeTable> {
  return {
    feature_flags: { rows: [{ flag: "reservation_import_enabled", enabled: true }] },
    trips: { rows: [{ id: TRIP_ID, owner_id: OWNER_ID }] },
    trip_members: { rows: [
      { trip_id: TRIP_ID, user_id: OWNER_ID,   role: "owner",   status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER_ID,  role: "member",  status: "accepted" },
      { trip_id: TRIP_ID, user_id: COHOST_ID,  role: "co_host", status: "accepted" },
      { trip_id: TRIP_ID, user_id: MEMBER2_ID, role: "member",  status: "accepted" },
    ]},
    ...overrides,
  };
}

function seedReservation(over: Row = {}): Row {
  return {
    id: RES_ID,
    trip_id: TRIP_ID,
    user_id: MEMBER_ID,
    type: "stay",
    title: "Hotel Azul",
    starts_at: "2026-08-14T15:00:00.000Z",
    ends_at: "2026-08-18T11:00:00.000Z",
    location_name: "Lisbon",
    confirmation_ref: "ABC123",
    cancellation_deadline_at: null,
    raw_text: null,
    extraction: null,
    extraction_confidence: null,
    status: "pending_confirm",
    created_from: "paste",
    ...over,
  };
}

// ── Fake OpenAI helpers ───────────────────────────────────────────────────────

function makeOpenAIMock(content: string, capture?: { opts: any[] }): any {
  return {
    chat: {
      completions: {
        create: async (opts: any) => {
          capture?.opts.push(opts);
          return { choices: [{ message: { role: "assistant", content } }] };
        },
      },
    },
  };
}

const FENCED_EXTRACTION =
  "```json\n" +
  JSON.stringify({
    reservations: [
      {
        type: "stay",
        title: "Hotel Azul",
        startsAt: "2026-08-14T15:00:00Z",
        endsAt: "2026-08-18T11:00:00Z",
        locationName: "Lisbon",
        confirmationRef: "ABC123",
        confidence: 0.92,
      },
    ],
  }) +
  "\n```";

// ── Server setup (router mounted directly; index.ts is not edited) ────────────

let app: Express;
let server: Server;
let port: number;

async function startServer() {
  const { default: reservationsRouter } = await import("../routes/tripReservations.js");
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).log = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };
    next();
  });
  app.use("/api", reservationsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as any).port;
}

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = null;
  try { body = (r.headers.get("content-type") ?? "").includes("json") ? await r.json() : await r.text(); }
  catch { body = null; }
  return { status: r.status, body };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("trip reservations routes", () => {
  beforeEach(async () => {
    if (server) server.close();
    await startServer();
  });

  afterEach(() => {
    _setTestOpenAI(null);
  });

  after(() => {
    if (server) server.close();
    _setTestClient(null as any, false);
    _setTestOpenAI(null);
  });

  // ── Import ──────────────────────────────────────────────────────────────────

  it("import inserts pending_confirm rows only — NEVER plan items — and strips fences", async () => {
    const { client, db } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    const capture = { opts: [] as any[] };
    _setTestOpenAI(makeOpenAIMock(FENCED_EXTRACTION, capture));

    const pasted = "Booking confirmed: Hotel Azul, Lisbon. Check-in Aug 14 2026 3pm. Ref ABC123.";
    const r = await req("POST", `/trips/${TRIP_ID}/reservations/import`, {
      token: "member-token",
      body: { text: pasted },
    });

    assert.equal(r.status, 201);
    assert.equal(r.body.reservations.length, 1);
    const row = r.body.reservations[0];
    assert.equal(row.status, "pending_confirm");
    assert.equal(row.created_from, "paste");
    assert.equal(row.title, "Hotel Azul");
    assert.equal(row.raw_text, pasted, "original text stored for audit");
    assert.equal(row.extraction_confidence, 0.92);
    assert.equal(row.extraction.confirmationRef, "ABC123", "model output kept verbatim");
    assert.equal(row.starts_at, "2026-08-14T15:00:00.000Z");
    assert.equal(r.body.needsConfirmation, true);

    // Confirm-before-commit contract:
    assert.equal(db.trip_plan_items.rows.length, 0, "import must NEVER create plan items");
    assert.equal(db.trip_reservations.rows.length, 1);

    // UGC wrapping reached the model, and the model was instructed via system.
    const sent = capture.opts[0];
    const userMsg = sent.messages.find((m: any) => m.role === "user");
    assert.ok(userMsg.content.includes("<portava:ugc>"), "pasted text must be UGC-wrapped");
    assert.ok(userMsg.content.includes(pasted));
    assert.equal(sent.model, "gpt-5-mini");
    // No temperature assertion: gpt-5 reasoning models reject any
    // non-default temperature, so the route no longer sends one.
  });

  it("extraction failure returns an empty import with error field and inserts nothing", async () => {
    const { client, db } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock("Sorry, I could not find any JSON here."));

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/import`, {
      token: "member-token",
      body: { text: "gibberish that yields nothing" },
    });

    assert.equal(r.status, 200);
    assert.deepEqual(r.body.reservations, []);
    assert.equal(r.body.error, "extraction_failed");
    assert.equal(db.trip_reservations.rows.length, 0, "no rows on failed extraction");
    assert.equal(db.trip_plan_items.rows.length, 0);
  });

  it("import is gated by the reservation_import_enabled flag", async () => {
    const { client } = makeFakeClient(baseTables({
      feature_flags: { rows: [{ flag: "reservation_import_enabled", enabled: false }] },
    }));
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(FENCED_EXTRACTION));

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/import`, {
      token: "member-token",
      body: { text: "anything" },
    });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("import rejects non-members", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(FENCED_EXTRACTION));

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/import`, {
      token: "other-token",
      body: { text: "anything" },
    });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "not_member");
  });

  it("import rejects oversized text (>20000 chars)", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);
    _setTestOpenAI(makeOpenAIMock(FENCED_EXTRACTION));

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/import`, {
      token: "member-token",
      body: { text: "x".repeat(20_001) },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_payload");
  });

  // ── Manual create + list ────────────────────────────────────────────────────

  it("manual create lands as confirmed / created_from manual", async () => {
    const { client } = makeFakeClient(baseTables());
    _setTestClient(client, true);

    const r = await req("POST", `/trips/${TRIP_ID}/reservations`, {
      token: "member-token",
      body: { type: "flight", title: "TP 123 LIS→BCN", startsAt: "2026-08-20T09:00:00Z" },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.reservation.status, "confirmed");
    assert.equal(r.body.reservation.created_from, "manual");
    assert.equal(r.body.reservation.type, "flight");
  });

  it("list filters by status for members", async () => {
    const { client } = makeFakeClient(baseTables({
      trip_reservations: { rows: [
        seedReservation(),
        seedReservation({ id: RES2_ID, title: "Old one", status: "dismissed" }),
      ]},
    }));
    _setTestClient(client, true);

    const all = await req("GET", `/trips/${TRIP_ID}/reservations`, { token: "member2-token" });
    assert.equal(all.status, 200);
    assert.equal(all.body.reservations.length, 2);

    const pending = await req("GET", `/trips/${TRIP_ID}/reservations?status=pending_confirm`, { token: "member2-token" });
    assert.equal(pending.body.reservations.length, 1);
    assert.equal(pending.body.reservations[0].id, RES_ID);

    const bad = await req("GET", `/trips/${TRIP_ID}/reservations?status=bogus`, { token: "member2-token" });
    assert.equal(bad.status, 400);
  });

  // ── Confirm + addToPlan ─────────────────────────────────────────────────────

  it("confirm with addToPlan creates a plan item with the mapped category (stay→accommodation)", async () => {
    const { client, db } = makeFakeClient(baseTables({
      trip_reservations: { rows: [seedReservation()] },
    }));
    _setTestClient(client, true);

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/${RES_ID}/confirm`, {
      token: "member-token",
      body: { addToPlan: true },
    });

    assert.equal(r.status, 200);
    assert.equal(r.body.reservation.status, "confirmed");
    assert.equal(db.trip_plan_items.rows.length, 1, "confirm+addToPlan is the ONLY path to a plan item");

    const item = db.trip_plan_items.rows[0];
    assert.equal(item.category, "accommodation", "stay maps to accommodation");
    assert.equal(item.title, "Hotel Azul");
    assert.equal(item.trip_id, TRIP_ID);
    assert.equal(item.creator_id, MEMBER_ID, "creator from token");
    assert.equal(item.day_date, "2026-08-14", "day_date from starts_at date");
    assert.equal(item.source_type, "manual");
    assert.equal(item.source_id, RES_ID, "linked back to the reservation");
    assert.equal(item.status, "confirmed");
    assert.equal(item.visibility, "members");
  });

  it("confirm maps flight→transport and skips the plan when addToPlan is false", async () => {
    const { client, db } = makeFakeClient(baseTables({
      trip_reservations: { rows: [
        seedReservation({ id: RES2_ID, type: "flight", title: "TP 123" }),
      ]},
    }));
    _setTestClient(client, true);

    const noPlan = await req("POST", `/trips/${TRIP_ID}/reservations/${RES2_ID}/confirm`, {
      token: "member-token",
      body: {},
    });
    assert.equal(noPlan.status, 200);
    assert.equal(db.trip_plan_items.rows.length, 0, "no addToPlan → no plan item");

    const withPlan = await req("POST", `/trips/${TRIP_ID}/reservations/${RES2_ID}/confirm`, {
      token: "member-token",
      body: { addToPlan: true },
    });
    assert.equal(withPlan.status, 200);
    assert.equal(db.trip_plan_items.rows.length, 1);
    assert.equal(db.trip_plan_items.rows[0].category, "transport", "flight maps to transport");
  });

  it("confirm+addToPlan is idempotent per reservation (duplicate guard)", async () => {
    const { client, db } = makeFakeClient(baseTables({
      trip_reservations: { rows: [seedReservation()] },
    }));
    _setTestClient(client, true);

    await req("POST", `/trips/${TRIP_ID}/reservations/${RES_ID}/confirm`, {
      token: "member-token", body: { addToPlan: true },
    });
    await req("POST", `/trips/${TRIP_ID}/reservations/${RES_ID}/confirm`, {
      token: "member-token", body: { addToPlan: true },
    });
    assert.equal(db.trip_plan_items.rows.length, 1, "second confirm must not duplicate the plan item");
  });

  // ── PATCH permission matrix ─────────────────────────────────────────────────

  it("PATCH: creator, trip owner, and co_host may edit; another member may not", async () => {
    const cases: Array<{ token: string; expect: number }> = [
      { token: "member-token",  expect: 200 }, // creator
      { token: "owner-token",   expect: 200 }, // trip owner
      { token: "cohost-token",  expect: 200 }, // co_host
      { token: "member2-token", expect: 403 }, // unrelated member
    ];

    for (const c of cases) {
      const { client } = makeFakeClient(baseTables({
        trip_reservations: { rows: [seedReservation()] },
      }));
      _setTestClient(client, true);
      const r = await req("PATCH", `/trips/${TRIP_ID}/reservations/${RES_ID}`, {
        token: c.token,
        body: { title: "Renamed" },
      });
      assert.equal(r.status, c.expect, `${c.token} should get ${c.expect}`);
      if (c.expect === 200) assert.equal(r.body.reservation.title, "Renamed");
    }
  });

  it("dismiss sets status dismissed", async () => {
    const { client, db } = makeFakeClient(baseTables({
      trip_reservations: { rows: [seedReservation()] },
    }));
    _setTestClient(client, true);

    const r = await req("POST", `/trips/${TRIP_ID}/reservations/${RES_ID}/dismiss`, {
      token: "cohost-token",
      body: {},
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.reservation.status, "dismissed");
    assert.equal(db.trip_plan_items.rows.length, 0);
  });

  it("DELETE allows creator and trip owner, but not co_host", async () => {
    const mk = () => makeFakeClient(baseTables({
      trip_reservations: { rows: [seedReservation()] },
    }));

    let ctx = mk();
    _setTestClient(ctx.client, true);
    const asCohost = await req("DELETE", `/trips/${TRIP_ID}/reservations/${RES_ID}`, { token: "cohost-token" });
    assert.equal(asCohost.status, 403, "co_host cannot delete someone else's reservation");
    assert.equal(ctx.db.trip_reservations.rows.length, 1);

    ctx = mk();
    _setTestClient(ctx.client, true);
    const asCreator = await req("DELETE", `/trips/${TRIP_ID}/reservations/${RES_ID}`, { token: "member-token" });
    assert.equal(asCreator.status, 204);
    assert.equal(ctx.db.trip_reservations.rows.length, 0);

    ctx = mk();
    _setTestClient(ctx.client, true);
    const asOwner = await req("DELETE", `/trips/${TRIP_ID}/reservations/${RES_ID}`, { token: "owner-token" });
    assert.equal(asOwner.status, 204);
    assert.equal(ctx.db.trip_reservations.rows.length, 0);
  });
});
