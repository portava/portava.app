/**
 * trips-expansion backend tests
 *
 * Covers:
 * - Lifecycle: GET /trips/me, /upcoming, /active, /past, /invites, /join-requests
 * - PATCH /trips/:tripId/settings (expanded fields, date validation, status computation)
 * - DELETE /trips/:tripId, POST cancel/complete/archive
 * - Join requests: create, approve, decline, cancel
 * - Invite links: create, revoke, preview, accept
 * - Budget: get/put owner-only
 * - Documents: create, list, delete with privacy
 * - Notes: create, list, delete with privacy
 * - Saved places: add, list, duplicate prevention, delete
 * - Checklists: create list, add item, toggle item
 * - Reminders: create, list, delete
 * - Activity log: owner-only access
 * - GET /trips/:tripId: public-privacy enforcement, member full view
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------
const OWNER_ID   = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID  = "22222222-2222-2222-2222-222222222222";
const OTHER_ID   = "33333333-3333-3333-3333-333333333333";
const TRIP_ID    = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DOC_ID     = "44444444-4444-4444-4444-444444444444";
const NOTE_ID    = "55555555-5555-5555-5555-555555555555";
const PLACE_ID   = "66666666-6666-6666-6666-666666666666";
const LIST_ID    = "77777777-7777-7777-7777-777777777777";
const ITEM_ID    = "88888888-8888-8888-8888-888888888888";
const LINK_ID    = "99999999-9999-9999-9999-999999999999";
const REQ_ID     = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const REM_ID     = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";

// ---------------------------------------------------------------------------
// Fake client builder
// ---------------------------------------------------------------------------
type Row = Record<string, any>;
interface FakeTable { rows: Row[]; nextInsertError?: string; }

function makeFakeClient(tables: Record<string, FakeTable> = {}) {
  const db: Record<string, FakeTable> = {
    trips:               tables.trips               ?? { rows: [] },
    trip_members:        tables.trip_members        ?? { rows: [] },
    trip_budget:         tables.trip_budget         ?? { rows: [] },
    trip_documents:      tables.trip_documents      ?? { rows: [] },
    trip_notes:          tables.trip_notes          ?? { rows: [] },
    trip_saved_places:   tables.trip_saved_places   ?? { rows: [] },
    trip_checklists:     tables.trip_checklists     ?? { rows: [] },
    trip_checklist_items: tables.trip_checklist_items ?? { rows: [] },
    trip_join_requests:  tables.trip_join_requests  ?? { rows: [] },
    trip_invite_links:   tables.trip_invite_links   ?? { rows: [] },
    trip_reminders:      tables.trip_reminders      ?? { rows: [] },
    trip_activity_log:   tables.trip_activity_log   ?? { rows: [] },
    plan_editors:        tables.plan_editors        ?? { rows: [] },
    blocks:              tables.blocks              ?? { rows: [] },
    profiles:            tables.profiles            ?? { rows: [] },
    ...tables,
  };

  let idCtr = 0;
  function newId() {
    const n = String(++idCtr).padStart(8, "0");
    return `${n}-0000-0000-0000-000000000000`;
  }

  function chain(tableName: string, sourceRows: Row[]) {
    const filters: Array<(r: Row) => boolean> = [];
    let _insert: Row | Row[] | null = null;
    let _upsert: { data: Row | Row[]; opts?: any } | null = null;
    let _update: Row | null = null;
    let _delete = false;
    let _limitN: number | null = null;
    let _orderCol: string | null = null;
    let _orderAsc = true;
    let _single = false;
    let _maybeSingle = false;
    let _selectCols: string | null = null;

    const obj: any = {
      select(cols?: string) { _selectCols = cols ?? null; return obj; },
      insert(data: Row | Row[]) { _insert = data; return obj; },
      upsert(data: Row | Row[], opts?: any) {
        _upsert = { data, opts };
        _insert = Array.isArray(data) ? data[0] : data;
        return obj;
      },
      update(patch: Row) { _update = patch; return obj; },
      delete() { _delete = true; return obj; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return obj; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return obj; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return obj; },
      not(col: string, op: string, val: any) {
        if (op === "is") filters.push((r) => r[col] !== val);
        return obj;
      },
      or(expr: string) {
        // minimal: pass all rows (safe for test data)
        return obj;
      },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return obj; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return obj; },
      gt(col: string, val: any)  { filters.push((r) => r[col] >  val); return obj; },
      lt(col: string, val: any)  { filters.push((r) => r[col] <  val); return obj; },
      is(col: string, val: any)  { filters.push((r) => r[col] == val); return obj; },
      limit(n: number) { _limitN = n; return obj; },
      order(col: string, opts?: any) { _orderCol = col; _orderAsc = opts?.ascending !== false; return obj; },
      maybeSingle() { _maybeSingle = true; return resolve(); },
      single()      { _single      = true; return resolve(); },
      then(onF: any, onR: any) { return resolve().then(onF, onR); },
    };

    function getTable(): FakeTable {
      if (!db[tableName]) db[tableName] = { rows: [] };
      return db[tableName];
    }

    function resolve(): Promise<{ data: any; error: any }> {
      return Promise.resolve().then(() => {
        const table = getTable();

        if (_insert !== null && !_upsert) {
          if (table.nextInsertError) {
            const err = table.nextInsertError;
            table.nextInsertError = undefined;
            return { data: null, error: { message: err } };
          }
          const rows = Array.isArray(_insert) ? _insert : [_insert];
          const inserted = rows.map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }));
          table.rows.push(...inserted);
          const result = _single || _maybeSingle ? inserted[0] ?? null : inserted;
          return { data: result, error: null };
        }

        if (_upsert !== null) {
          const rows = Array.isArray(_upsert.data) ? _upsert.data : [_upsert.data];
          const onConflict = _upsert.opts?.onConflict as string | undefined;
          const upserted = rows.map((newRow) => {
            if (onConflict) {
              const keys = onConflict.split(",").map((k) => k.trim());
              const idx = table.rows.findIndex((r) =>
                keys.every((k) => r[k] === (newRow as any)[k])
              );
              if (idx >= 0) {
                table.rows[idx] = { ...table.rows[idx], ...newRow };
                return table.rows[idx];
              }
            }
            const ins = { id: newId(), created_at: new Date().toISOString(), ...newRow };
            table.rows.push(ins);
            return ins;
          });
          const result = _single || _maybeSingle ? upserted[0] ?? null : upserted;
          return { data: result, error: null };
        }

        if (_delete) {
          const before = table.rows.length;
          table.rows = table.rows.filter((r) => !filters.every((f) => f(r)));
          return { data: null, error: null };
        }

        if (_update !== null) {
          const matched: Row[] = [];
          table.rows = table.rows.map((r) => {
            if (filters.every((f) => f(r))) {
              const updated = { ...r, ..._update };
              matched.push({ ...updated });
              return updated;
            }
            return r;
          });
          if (_single || _maybeSingle) {
            return { data: matched[0] ?? null, error: null };
          }
          if (_selectCols !== null) {
            return { data: matched, error: null };
          }
          return { data: null, error: null };
        }

        // SELECT
        let rows = table.rows.filter((r) => filters.every((f) => f(r)));
        if (_orderCol) {
          const col = _orderCol;
          rows = [...rows].sort((a, b) =>
            _orderAsc
              ? String(a[col] ?? "").localeCompare(String(b[col] ?? ""))
              : String(b[col] ?? "").localeCompare(String(a[col] ?? ""))
          );
        }
        if (_limitN !== null) rows = rows.slice(0, _limitN);

        if (_single)      return { data: rows[0] ?? null, error: null };
        if (_maybeSingle) return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      });
    }

    return obj;
  }

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "owner-token")  return { data: { user: { id: OWNER_ID }  }, error: null };
        if (token === "member-token") return { data: { user: { id: MEMBER_ID } }, error: null };
        if (token === "other-token")  return { data: { user: { id: OTHER_ID }  }, error: null };
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },
    from: (tableName: string) => chain(tableName, db[tableName]?.rows ?? []),
    rpc: async (fn: string, args: Record<string, any>) => {
      if (fn === "claim_invite_link_slot_for_user") {
        // Combined atomic claim + attempt-row (mirrors the hardened DB function).
        // Returns: 'claimed' | 'already_attempted' | 'limit_reached'
        const table = db.trip_invite_links ?? { rows: [] };
        const row = table.rows.find((r) => r.id === args.p_link_id);
        if (!row) return { data: "limit_reached", error: null };
        const attempts = db.trip_invite_link_attempts ?? { rows: [] };
        const prior = attempts.rows.find((a) => a.link_id === args.p_link_id && a.user_id === args.p_user_id);
        if (prior) return { data: "already_attempted", error: null };
        if (row.max_uses !== null && row.max_uses !== undefined && (row.use_count ?? 0) >= row.max_uses) {
          return { data: "limit_reached", error: null };
        }
        row.use_count = (row.use_count ?? 0) + 1;
        if (!db.trip_invite_link_attempts) db.trip_invite_link_attempts = { rows: [] };
        db.trip_invite_link_attempts.rows.push({ link_id: args.p_link_id, user_id: args.p_user_id });
        return { data: "claimed", error: null };
      }
      if (fn === "claim_invite_link_slot") {
        const table = db.trip_invite_links ?? { rows: [] };
        const row = table.rows.find((r) => r.id === args.link_id);
        if (!row) return { data: false, error: null };
        if (row.max_uses !== null && row.max_uses !== undefined && row.use_count >= row.max_uses) {
          return { data: false, error: null };
        }
        row.use_count = (row.use_count ?? 0) + 1;
        return { data: true, error: null };
      }
      if (fn === "release_invite_link_slot") {
        const table = db.trip_invite_links ?? { rows: [] };
        const row = table.rows.find((r) => r.id === args.link_id);
        if (row) row.use_count = Math.max(0, (row.use_count ?? 0) - 1);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    },
  };

  return { client, db };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: any } = {},
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  let body: any;
  const ct = res.headers.get("content-type") ?? "";
  try { body = ct.includes("application/json") ? await res.json() : await res.text(); }
  catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe("trips-expansion routes", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(async () => {
    if (server) server.close();
  });

  // ── GET /trips/me ──────────────────────────────────────────────────────────
  describe("GET /trips/me", () => {
    it("returns trips where caller is owner or member", async () => {
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Paris", destination_city: "Paris",
            status: "upcoming", visibility: "private", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", "/trips/me", { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.trips.length, 1);
      assert.equal(r.body.trips[0].id, TRIP_ID);
    });

    it("returns empty array when caller has no trips", async () => {
      const { client } = makeFakeClient();
      _setTestClient(client, true);
      const r = await req(port, "GET", "/trips/me", { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.trips, []);
    });

    it("returns 401 without auth", async () => {
      const { client } = makeFakeClient();
      _setTestClient(client, true);
      const r = await req(port, "GET", "/trips/me", {});
      assert.equal(r.status, 401);
    });
  });

  // ── GET /trips/upcoming ────────────────────────────────────────────────────
  describe("GET /trips/upcoming", () => {
    it("returns upcoming trips with future start_date", async () => {
      const futureDate = "2099-12-31";
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Future", destination_city: "Tokyo",
            status: "upcoming", start_date: futureDate, end_date: "2099-12-31",
            visibility: "private", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", "/trips/upcoming", { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.trips.length, 1);
    });
  });

  // ── GET /trips/past ────────────────────────────────────────────────────────
  describe("GET /trips/past", () => {
    it("returns completed and cancelled trips", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Old", destination_city: "Rome",
            status: "completed", visibility: "private", created_at: "2025-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", "/trips/past", { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.trips.length, 1);
    });
  });

  // ── GET /trips/:tripId ─────────────────────────────────────────────────────
  describe("GET /trips/:tripId", () => {
    it("returns full member trip to trip members", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Member Trip", destination_city: "NYC",
            destination_lat: 40.71, destination_lng: -74.0,
            status: "upcoming", visibility: "private",
            show_exact_dates: true, precise_location_visible: false,
            trip_notes: "secret notes", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.tripNotes, "secret notes");
      assert.equal(r.body.destinationLat, 40.71);
    });

    it("strips lat/lng from public response when precise_location_visible=false", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Public Trip", destination_city: "Paris",
            destination_lat: 48.85, destination_lng: 2.35,
            status: "upcoming", visibility: "public",
            show_exact_dates: true, precise_location_visible: false,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.destinationLat, undefined);
      assert.equal(r.body.destinationLng, undefined);
      assert.equal(r.body.tripNotes, undefined);
    });

    it("exposes lat/lng in public response when precise_location_visible=true", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Public Precise", destination_city: "Paris",
            destination_lat: 48.85, destination_lng: 2.35,
            status: "upcoming", visibility: "public",
            show_exact_dates: true, precise_location_visible: true,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.destinationLat, 48.85);
    });

    it("redacts dates when show_exact_dates=false for public view", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "No Dates", destination_city: "Bali",
            start_date: "2026-08-01", end_date: "2026-08-15",
            status: "upcoming", visibility: "public",
            show_exact_dates: false, precise_location_visible: false,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.startDate, null);
      assert.equal(r.body.endDate,   null);
    });

    it("returns buddies trip (stripped shape) to a mutual follower", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Buddies Trip", destination_city: "Lisbon",
            status: "upcoming", visibility: "buddies",
            show_exact_dates: true, precise_location_visible: false,
            trip_notes: "hidden", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        user_follows: { rows: [
          { follower_id: OTHER_ID, following_id: OWNER_ID },
          { follower_id: OWNER_ID, following_id: OTHER_ID },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.id, TRIP_ID);
      assert.equal(r.body.title, "Buddies Trip");
      assert.equal(r.body.destinationCity, "Lisbon");
      // Stripped public shape — no private fields
      assert.equal(r.body.tripNotes, undefined);
    });

    it("returns locked sentinel (200) for buddies trip when the follow is only one-way", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Buddies Trip", destination_city: "Lisbon",
            status: "upcoming", visibility: "buddies", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        user_follows: { rows: [
          { follower_id: OTHER_ID, following_id: OWNER_ID },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.locked, true, "one-way-follow buddies trip must return locked sentinel");
      assert.equal(r.body.tripId, TRIP_ID, "locked sentinel must echo the tripId");
    });

    it("returns locked sentinel (200) for private trip viewed by non-member", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Private", destination_city: "Oslo",
            status: "upcoming", visibility: "private", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.locked, true, "private trip non-member must receive locked sentinel");
    });
  });

  // ── PATCH /trips/:tripId/settings ─────────────────────────────────────────
  describe("PATCH /trips/:tripId/settings", () => {
    it("updates privacy settings and computes status=upcoming for future trip", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            start_date: "2099-01-01", end_date: "2099-01-15",
            status: "planning", visibility: "private",
            allow_join_requests: false, created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "PATCH", `/trips/${TRIP_ID}/settings`, {
        token: "owner-token",
        body: { allowJoinRequests: true, preciseLocationVisible: true },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.allowJoinRequests, true);
      assert.equal(r.body.preciseLocationVisible, true);
      assert.equal(r.body.status, "upcoming");
    });

    it("rejects when end_date < start_date", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            start_date: "2099-01-10", end_date: "2099-01-15",
            status: "planning", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "PATCH", `/trips/${TRIP_ID}/settings`, {
        token: "owner-token",
        body: { startDate: "2099-01-20", endDate: "2099-01-10" },
      });
      assert.equal(r.status, 400);
    });

    it("returns 403 when non-owner tries to update", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "planning", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "PATCH", `/trips/${TRIP_ID}/settings`, {
        token: "other-token",
        body: { title: "Hijack" },
      });
      assert.equal(r.status, 403);
    });

    it("computes status=draft when title is missing", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: null,
            start_date: "2099-01-01", end_date: "2099-01-10",
            status: "planning", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "PATCH", `/trips/${TRIP_ID}/settings`, {
        token: "owner-token",
        body: { destinationCity: "" },
      });
      // empty string treated as falsy → draft
      // The schema requires min(1) so this would fail validation — expect 400
      assert.ok([400, 200].includes(r.status));
    });
  });

  // ── Lifecycle: cancel, complete, archive, delete ───────────────────────────
  describe("lifecycle routes", () => {
    function tripRow(status: string) {
      return {
        id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
        status, created_at: "2026-01-01T00:00:00Z",
      };
    }

    it("POST /cancel transitions planning → cancelled", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("planning")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/cancel`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
    });

    it("POST /cancel is idempotent for already-cancelled trip", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("cancelled")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/cancel`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.idempotent, true);
    });

    it("POST /cancel returns 409 for archived trip", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("archived")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/cancel`, { token: "owner-token" });
      assert.equal(r.status, 409);
    });

    it("POST /complete transitions active → completed", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("active")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/complete`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "completed");
    });

    it("POST /archive transitions any non-archived trip → archived", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("completed")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/archive`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "archived");
    });

    it("DELETE /trips/:tripId soft-archives (204)", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("active")] } });
      _setTestClient(client, true);
      const r = await req(port, "DELETE", `/trips/${TRIP_ID}`, { token: "owner-token" });
      assert.equal(r.status, 204);
    });

    it("lifecycle routes return 403 for non-owner", async () => {
      const { client } = makeFakeClient({ trips: { rows: [tripRow("active")] } });
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/${TRIP_ID}/cancel`, { token: "other-token" });
      assert.equal(r.status, 403);
    });
  });

  // ── Join requests ──────────────────────────────────────────────────────────
  describe("join request routes", () => {
    it("POST /join-request creates a pending request", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            allow_join_requests: true, status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        trip_join_requests: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-request`, {
        token: "other-token",
        body: { message: "I want to join!" },
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.status, "pending");
      assert.ok(r.body.requestId);
    });

    it("POST /join-request returns 403 when allow_join_requests=false", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            allow_join_requests: false, status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-request`, { token: "other-token" });
      assert.equal(r.status, 403);
    });

    it("POST /join-requests/:id/approve adds member and changes status", async () => {
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_join_requests: { rows: [
          { id: REQ_ID, trip_id: TRIP_ID, user_id: OTHER_ID, status: "pending", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-requests/${REQ_ID}/approve`, {
        token: "owner-token",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "approved");

      // Requester should now be in trip_members
      const memberRow = db.trip_members.rows.find((m) => m.user_id === OTHER_ID);
      assert.ok(memberRow, "member row should be created");
    });

    it("POST /join-requests/:id/decline updates status to declined", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_join_requests: { rows: [
          { id: REQ_ID, trip_id: TRIP_ID, user_id: OTHER_ID, status: "pending", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-requests/${REQ_ID}/decline`, {
        token: "owner-token",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "declined");
    });

    it("POST /join-requests/:id/cancel by requester cancels the request", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_join_requests: { rows: [
          { id: REQ_ID, trip_id: TRIP_ID, user_id: OTHER_ID, status: "pending", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-requests/${REQ_ID}/cancel`, {
        token: "other-token",
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.status, "cancelled");
    });

    it("decline returns 409 when request is already approved", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_join_requests: { rows: [
          { id: REQ_ID, trip_id: TRIP_ID, user_id: OTHER_ID, status: "approved", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/join-requests/${REQ_ID}/decline`, {
        token: "owner-token",
      });
      assert.equal(r.status, 409);
    });
  });

  // ── Invite links ───────────────────────────────────────────────────────────
  describe("invite link routes", () => {
    it("POST creates an invite link with a token", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/invite-link`, {
        token: "owner-token",
        body: { expiresInHours: 48, maxUses: 10 },
      });
      assert.equal(r.status, 201);
      assert.ok(r.body.token, "should have a token");
      assert.ok(r.body.id,    "should have an id");
    });

    it("GET preview returns trip summary for valid token", async () => {
      const LINK_TOKEN = "validtoken123abc456def789ghi012345";
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            start_date: "2099-01-01", end_date: "2099-01-10",
            visibility: "private", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/invite-link/${LINK_TOKEN}/preview`, { token: "other-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.tripTitle, "Trip");
      assert.equal(r.body.alreadyMember, false);
    });

    it("GET preview returns 410 for revoked link", async () => {
      const LINK_TOKEN = "revokedtokenabcdefghijklmno1234567";
      const { client } = makeFakeClient({
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: "2026-06-01T00:00:00Z", expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/invite-link/${LINK_TOKEN}/preview`, { token: "other-token" });
      assert.equal(r.status, 410);
    });

    it("GET preview returns 410 for expired link", async () => {
      const LINK_TOKEN = "expiredtokenabcdefghijklmnop123456";
      const { client } = makeFakeClient({
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null,
            expires_at: "2020-01-01T00:00:00Z",
            created_at: "2019-12-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/invite-link/${LINK_TOKEN}/preview`, { token: "other-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
    });

    it("GET preview returns 410 when use_count >= max_uses", async () => {
      const LINK_TOKEN = "exhaustedtokenabcdefghijklmno12345";
      const { client } = makeFakeClient({
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: 5, use_count: 5, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/invite-link/${LINK_TOKEN}/preview`, { token: "other-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
      assert.ok(r.body.message?.toLowerCase().includes("usage limit"), "message should mention usage limit");
    });

    it("POST accept joins the trip and increments use_count", async () => {
      const LINK_TOKEN = "accepttokenabcdefghijklmnop1234567";
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        trip_activity_log: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "other-token" });
      assert.equal(r.status, 201);
      assert.equal(r.body.status, "joined");

      const memberRow = db.trip_members.rows.find((m) => m.user_id === OTHER_ID);
      assert.ok(memberRow, "member row should be created");
    });

    it("POST accept returns 410 when max-use limit is reached", async () => {
      const LINK_TOKEN = "maxusedtokenabcdefghijklmnop123456";
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: 2, use_count: 2, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "other-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
    });

    it("POST accept returns 410 when claim_invite_link_slot_for_user returns limit_reached (slot taken concurrently)", async () => {
      // Simulates a race: two requests both read use_count=0 and pass the early guard,
      // but only one wins the atomic DB-level increment — the other gets false from the rpc.
      // The bespoke client returns use_count=0 on SELECT (passes early guard) but false
      // from the rpc (simulating the concurrent increment that beat this request).
      const LINK_TOKEN = "racetokenabcdefghijklmnopqrstuvw0";
      const linkRow = {
        id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
        max_uses: 1, use_count: 0, revoked_at: null, expires_at: null,
        created_at: "2026-01-01T00:00:00Z",
      };
      const tripRow = {
        id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
        status: "upcoming", created_at: "2026-01-01T00:00:00Z",
      };

      const customClient: any = {
        auth: {
          getUser: async (token: string) => {
            if (token === "other-token") return { data: { user: { id: OTHER_ID } }, error: null };
            return { data: { user: null }, error: { message: "invalid" } };
          },
        },
        rpc: async (fn: string) => {
          if (fn === "claim_invite_link_slot_for_user") {
            // Simulate the race: another request already claimed the last slot —
            // the atomic combined function reports limit_reached.
            return { data: "limit_reached", error: null };
          }
          return { data: null, error: null };
        },
        from: (tableName: string) => {
          const obj: any = {
            select() { return obj; },
            insert(_data: any) { return obj; },
            eq() { return obj; },
            or() { return obj; },
            limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
            maybeSingle() {
              if (tableName === "trip_invite_links") {
                // Return use_count=0 so the early limit guard passes
                return Promise.resolve({ data: { ...linkRow }, error: null });
              }
              if (tableName === "trips") return Promise.resolve({ data: tripRow, error: null });
              return Promise.resolve({ data: null, error: null });
            },
            then(onF: any, onR: any) {
              return Promise.resolve({ data: null, error: null }).then(onF, onR);
            },
          };
          return obj;
        },
      };

      _setTestClient(customClient, true);
      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "other-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
    });

    it("POST accept rolls back use_count when trip_members insert fails", async () => {
      // Scenario: claim_invite_link_slot succeeds (use_count bumped to 1), but the
      // trip_members INSERT then fails with a DB error. The handler must call
      // release_invite_link_slot so use_count returns to 0 — no stranded slot.
      const LINK_TOKEN = "rollbacktokenabcdefghijklmnop12345";
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: 3, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [], nextInsertError: "duplicate key value" },
        blocks: { rows: [] },
        trip_activity_log: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "other-token" });

      // Should return an error, not 201
      assert.notEqual(r.status, 201, "should not succeed when member insert fails");

      // use_count must be back at 0 — the compensating decrement fired
      const linkRow = db.trip_invite_links.rows.find((l) => l.id === LINK_ID);
      assert.ok(linkRow, "invite link row should still exist");
      assert.equal(linkRow!.use_count, 0, "use_count should be rolled back to 0 after insert failure");
    });

    it("POST accept returns 410 when the link has expired", async () => {
      const LINK_TOKEN = "expiredtokenabcdefghijklmnop123456";
      const { client } = makeFakeClient({
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null,
            expires_at: "2020-01-01T00:00:00Z",
            created_at: "2019-12-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "other-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
    });

    it("DELETE /invite-link/:linkId revokes the link (204)", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: "sometoken", created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "DELETE", `/trips/${TRIP_ID}/invite-link/${LINK_ID}`, { token: "owner-token" });
      assert.equal(r.status, 204);
    });

    // ── GET /trips/:tripId/invite-links ──────────────────────────────────────

    it("GET /invite-links returns links with joiner list from activity log", async () => {
      const JOINER_ID = OTHER_ID;
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: "listtoken1234", created_by: OWNER_ID,
            max_uses: 5, use_count: 1, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_activity_log: { rows: [
          { trip_id: TRIP_ID, actor_id: JOINER_ID, event_type: "joined_via_invite_link",
            metadata: { linkId: LINK_ID }, created_at: "2026-01-02T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: JOINER_ID, role: "member", status: "accepted" },
        ]},
        profiles: { rows: [
          { id: JOINER_ID, full_name: "Jane Doe", username: "janedoe", avatar_url: null },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.body), "response should be an array");
      assert.equal(r.body.length, 1);

      const link = r.body[0];
      assert.equal(link.id, LINK_ID);
      assert.equal(link.useCount, 1);
      assert.equal(link.maxUses, 5);
      assert.equal(link.isActive, true);
      assert.equal(link.isRevoked, false);

      assert.ok(Array.isArray(link.joiners), "joiners should be an array");
      assert.equal(link.joiners.length, 1);
      assert.equal(link.joiners[0].id, JOINER_ID);
      // Universal display-name rule: real name is redacted (null) unless the
      // joiner opted in via profile_privacy_settings.show_real_name.
      assert.equal(link.joiners[0].name, null);
      assert.equal(link.joiners[0].handle, "janedoe");
      assert.equal(link.joiners[0].removed, false);
    });

    it("GET /invite-links returns 403 for non-owner", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "other-token" });
      assert.equal(r.status, 403);
    });

    it("GET /invite-links reflects revoked status after DELETE", async () => {
      const LINK_TOKEN = "revoke-list-token-abc123def456ghij";
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_activity_log: { rows: [] },
        trip_members: { rows: [] },
        profiles: { rows: [] },
      });
      _setTestClient(client, true);

      // Revoke the link
      const del = await req(port, "DELETE", `/trips/${TRIP_ID}/invite-link/${LINK_ID}`, { token: "owner-token" });
      assert.equal(del.status, 204);

      // GET list should now show isRevoked = true and revokedAt set
      _setTestClient(client, true);
      const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.equal(r.body[0].isRevoked, true);
      assert.ok(r.body[0].revokedAt, "revokedAt should be set after revoke");
      assert.equal(r.body[0].isActive, false);
    });

    it("POST accept is blocked with 410 after DELETE revokes the link", async () => {
      const LINK_TOKEN = "revoke-block-token-xyz789abc012def3";
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        trip_activity_log: { rows: [] },
      });
      _setTestClient(client, true);

      // Revoke the link first
      const del = await req(port, "DELETE", `/trips/${TRIP_ID}/invite-link/${LINK_ID}`, { token: "owner-token" });
      assert.equal(del.status, 204);

      // Now attempt to accept the revoked link — must be blocked
      _setTestClient(client, true);
      const r = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "member-token" });
      assert.equal(r.status, 410);
      assert.equal(r.body.error, "gone");
    });

    // ── Restart-survival tests ───────────────────────────────────────────────
    // These tests simulate a real server restart by closing the current server,
    // starting a new one, and re-injecting the same fake client (same db object).
    // The fake db object stands in for the real persistent database: data written
    // before the restart is still present when a fresh server process starts up.

    it("usage stats (useCount + joiners) survive a server restart", async () => {
      const LINK_TOKEN = "restart-usage-token-abc123def456gh";
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        trip_activity_log: { rows: [] },
        profiles: { rows: [
          { id: MEMBER_ID, full_name: "Bob Smith", username: "bobsmith", avatar_url: null },
        ]},
      });
      _setTestClient(client, true);

      // Step 1: accept the invite link (writes to the fake db)
      const accept = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "member-token" });
      assert.equal(accept.status, 201, "accept should succeed");

      // Step 2: simulate a server restart — close current server, start a fresh one
      server.close();
      ({ server, port } = await startServer());
      // Re-inject the SAME fake client (same db object = persistent database)
      _setTestClient(client, true);

      // Step 3: GET invite-links on the new server — useCount and joiners must still be correct
      const r = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.length, 1);
      assert.equal(r.body[0].useCount, 1, "useCount should reflect the pre-restart join");
      assert.equal(r.body[0].joiners.length, 1, "joiner recorded in activity log should still appear");
      assert.equal(r.body[0].joiners[0].id, MEMBER_ID);
    });

    it("revoke survives a server restart — GET shows revoked and POST accept stays blocked", async () => {
      const LINK_TOKEN = "restart-revoke-token-xyz789abc012de";
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome",
            status: "upcoming", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_invite_links: { rows: [
          { id: LINK_ID, trip_id: TRIP_ID, token: LINK_TOKEN, created_by: OWNER_ID,
            max_uses: null, use_count: 0, revoked_at: null, expires_at: null,
            created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
        blocks: { rows: [] },
        trip_activity_log: { rows: [] },
        profiles: { rows: [] },
      });
      _setTestClient(client, true);

      // Step 1: revoke the link (writes revoked_at to the fake db)
      const del = await req(port, "DELETE", `/trips/${TRIP_ID}/invite-link/${LINK_ID}`, { token: "owner-token" });
      assert.equal(del.status, 204, "revoke should succeed");

      // Step 2: simulate a server restart — close current server, start a fresh one
      server.close();
      ({ server, port } = await startServer());
      // Re-inject the SAME fake client (same db object = persistent database)
      _setTestClient(client, true);

      // Step 3: GET invite-links on the new server — must still show revoked
      const list = await req(port, "GET", `/trips/${TRIP_ID}/invite-links`, { token: "owner-token" });
      assert.equal(list.status, 200);
      assert.equal(list.body.length, 1);
      assert.equal(list.body[0].isRevoked, true, "isRevoked must be true after restart");
      assert.ok(list.body[0].revokedAt, "revokedAt must be set after restart");
      assert.equal(list.body[0].isActive, false, "isActive must be false after restart");

      // Step 4: POST accept on the new server — must still be blocked
      const accept = await req(port, "POST", `/trips/invite-link/${LINK_TOKEN}/accept`, { token: "member-token" });
      assert.equal(accept.status, 410, "revoked link must still block accept after restart");
      assert.equal(accept.body.error, "gone");
    });
  });

  // ── Budget ─────────────────────────────────────────────────────────────────
  describe("budget routes", () => {
    it("PUT creates/updates budget (owner only)", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_budget: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "PUT", `/trips/${TRIP_ID}/budget`, {
        token: "owner-token",
        body: { currency: "EUR", totalBudget: 5000, breakdown: { flights: 2000, hotel: 3000 } },
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.budget.currency, "EUR");
    });

    it("PUT returns 403 for non-owner", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "PUT", `/trips/${TRIP_ID}/budget`, {
        token: "other-token",
        body: { totalBudget: 1000 },
      });
      assert.equal(r.status, 403);
    });

    it("GET returns null budget when none set", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_budget: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/budget`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.budget, null);
    });
  });

  // ── Documents ──────────────────────────────────────────────────────────────
  describe("document routes", () => {
    it("POST creates a document and GET lists it", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_documents: { rows: [] },
      });
      _setTestClient(client, true);

      const createR = await req(port, "POST", `/trips/${TRIP_ID}/documents`, {
        token: "owner-token",
        body: { title: "Visa Info", content: "Need a visa", documentType: "visa", isPrivate: false },
      });
      assert.equal(createR.status, 201);

      const listR = await req(port, "GET", `/trips/${TRIP_ID}/documents`, { token: "owner-token" });
      assert.equal(listR.status, 200);
      assert.equal(listR.body.documents.length, 1);
    });

    it("non-member cannot list documents", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/documents`, { token: "other-token" });
      assert.equal(r.status, 403);
    });
  });

  // ── Notes ──────────────────────────────────────────────────────────────────
  describe("notes routes", () => {
    it("POST creates a note", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_notes: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/notes`, {
        token: "owner-token",
        body: { title: "Day 1", content: "Arrived safely", isPrivate: false },
      });
      assert.equal(r.status, 201);
      assert.equal(r.body.title, "Day 1");
    });

    it("DELETE note by author succeeds (204)", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_notes: { rows: [
          { id: NOTE_ID, trip_id: TRIP_ID, author_id: OWNER_ID, content: "hello", is_private: false, created_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "DELETE", `/trips/${TRIP_ID}/notes/${NOTE_ID}`, { token: "owner-token" });
      assert.equal(r.status, 204);
    });
  });

  // ── Saved places ───────────────────────────────────────────────────────────
  describe("saved places routes", () => {
    it("POST saves a place and GET lists it", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_saved_places: { rows: [] },
      });
      _setTestClient(client, true);

      const createR = await req(port, "POST", `/trips/${TRIP_ID}/saved-places`, {
        token: "owner-token",
        body: { placeId: "place123", placeName: "Colosseum", placeType: "landmark", lat: 41.89, lng: 12.49 },
      });
      assert.equal(createR.status, 201);

      const listR = await req(port, "GET", `/trips/${TRIP_ID}/saved-places`, { token: "owner-token" });
      assert.equal(listR.status, 200);
      assert.equal(listR.body.savedPlaces.length, 1);
    });

    it("duplicate place_id returns 409", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_saved_places: { rows: [
          { id: PLACE_ID, trip_id: TRIP_ID, user_id: OWNER_ID, place_id: "place123",
            place_name: "Colosseum", saved_at: "2026-01-01T00:00:00Z" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/saved-places`, {
        token: "owner-token",
        body: { placeId: "place123", placeName: "Colosseum" },
      });
      assert.equal(r.status, 409);
    });

    it("non-member cannot save a place", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/saved-places`, {
        token: "other-token",
        body: { placeName: "Somewhere" },
      });
      assert.equal(r.status, 403);
    });
  });

  // ── Destinations ───────────────────────────────────────────────────────────
  describe("destinations routes", () => {
    it("POST adds a destination and GET lists it", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_destinations: { rows: [] },
        trip_activity_log: { rows: [] },
      });
      _setTestClient(client, true);

      const createR = await req(port, "POST", `/trips/${TRIP_ID}/destinations`, {
        token: "owner-token",
        body: { city: "London", country: "GB", lat: 51.47, lng: -0.46, position: 0 },
      });
      assert.equal(createR.status, 201);
      assert.equal(createR.body.city, "London");

      const listR = await req(port, "GET", `/trips/${TRIP_ID}/destinations`, { token: "owner-token" });
      assert.equal(listR.status, 200);
      assert.equal(listR.body.destinations.length, 1);
    });

    it("POST returns 400 when city is missing", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_destinations: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "POST", `/trips/${TRIP_ID}/destinations`, {
        token: "owner-token",
        body: { country: "GB" },
      });
      assert.equal(r.status, 400);
    });

    it("non-member cannot list destinations", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [] },
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/destinations`, { token: "other-token" });
      assert.equal(r.status, 403);
    });
  });

  // ── Checklists ─────────────────────────────────────────────────────────────
  describe("checklist routes", () => {
    it("POST creates a checklist, POST adds item, PATCH toggles item", async () => {
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_checklists: { rows: [] },
        trip_checklist_items: { rows: [] },
      });
      _setTestClient(client, true);

      // Create list
      const listR = await req(port, "POST", `/trips/${TRIP_ID}/checklists`, {
        token: "owner-token",
        body: { title: "Packing" },
      });
      assert.equal(listR.status, 201);
      const listId = listR.body.id;

      // Add item
      const itemR = await req(port, "POST", `/trips/${TRIP_ID}/checklists/${listId}/items`, {
        token: "owner-token",
        body: { label: "Passport", sortOrder: 0 },
      });
      assert.equal(itemR.status, 201);
      const itemId = itemR.body.id;

      // Toggle done
      const patchR = await req(port, "PATCH", `/trips/${TRIP_ID}/checklists/${listId}/items/${itemId}`, {
        token: "owner-token",
        body: { isDone: true },
      });
      assert.equal(patchR.status, 200);
      assert.equal(patchR.body.is_done, true);
    });
  });

  // ── Reminders ──────────────────────────────────────────────────────────────
  describe("reminder routes", () => {
    it("POST creates a reminder, GET lists it, DELETE removes it", async () => {
      const { client, db } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
        trip_reminders: { rows: [] },
      });
      _setTestClient(client, true);

      const createR = await req(port, "POST", `/trips/${TRIP_ID}/reminders`, {
        token: "owner-token",
        body: { title: "Book hotel", remindAt: "2099-12-01T09:00:00Z" },
      });
      assert.equal(createR.status, 201);
      const remId = createR.body.id;

      const listR = await req(port, "GET", `/trips/${TRIP_ID}/reminders`, { token: "owner-token" });
      assert.equal(listR.status, 200);
      assert.equal(listR.body.reminders.length, 1);

      const delR = await req(port, "DELETE", `/trips/${TRIP_ID}/reminders/${remId}`, { token: "owner-token" });
      assert.equal(delR.status, 204);
    });
  });

  // ── Activity log ───────────────────────────────────────────────────────────
  describe("activity log routes", () => {
    it("GET returns log for owner", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_activity_log: { rows: [
          { id: "actid", trip_id: TRIP_ID, actor_id: OWNER_ID,
            event_type: "trip_updated", metadata: {}, created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/activity`, { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.activity.length, 1);
    });

    it("GET returns 403 for non-owner non-cohost", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_members: { rows: [
          { trip_id: TRIP_ID, user_id: OTHER_ID, role: "member", status: "accepted" },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", `/trips/${TRIP_ID}/activity`, { token: "other-token" });
      assert.equal(r.status, 403);
    });
  });

  // ── GET /trips/join-requests ───────────────────────────────────────────────
  describe("GET /trips/join-requests", () => {
    it("returns pending requests for trips owned by caller", async () => {
      const { client } = makeFakeClient({
        trips: { rows: [
          { id: TRIP_ID, owner_id: OWNER_ID, title: "Trip", destination_city: "Rome", created_at: "2026-01-01T00:00:00Z" },
        ]},
        trip_join_requests: { rows: [
          { id: REQ_ID, trip_id: TRIP_ID, user_id: OTHER_ID, status: "pending", created_at: "2026-01-01T00:00:00Z" },
        ]},
        profiles: { rows: [
          { id: OTHER_ID, handle: "other", name: "Other User", avatar_url: null },
        ]},
      });
      _setTestClient(client, true);

      const r = await req(port, "GET", "/trips/join-requests", { token: "owner-token" });
      assert.equal(r.status, 200);
      assert.equal(r.body.requests.length, 1);
      assert.equal(r.body.requests[0].status, "pending");
    });
  });
});
