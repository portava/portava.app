/**
 * Integration tests for Trip Plan Builder routes.
 *
 * Covers all 15 scenarios specified in task-13:
 *   1.  Non-member cannot read plan (403)
 *   2.  Pending invitee cannot read plan (403)
 *   3.  Accepted member can read plan (200)
 *   4.  Owner can read plan (200)
 *   5.  Non-member cannot create plan item (403)
 *   6.  Accepted member can create plan item; creator_id set from token
 *   7.  Owner can create plan item
 *   8.  Member cannot edit another member's item (403)
 *   9.  Member CAN edit their own item (200)
 *  10.  Owner can edit any item
 *  11.  Soft-delete: remove sets removed_at; source fields unchanged
 *  12.  Removed item no longer appears in GET /plan
 *  13.  Duplicate meetup guard: second add returns 409
 *  14.  GPS fields are NOT present in any plan item response
 *  15.  creator_id in response always matches token user, not body
 *
 * Runtime: node:test + node:assert/strict
 * Run: node --import tsx/esm --test src/test/tripPlan.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient, canEditPlanItem } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";
import planRouter from "../routes/plan.js";

// ── ID constants (valid UUIDs) ────────────────────────────────────────────────

const ALICE_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const BOB_ID    = "bbbbbbbb-0000-0000-0000-000000000002";
const CAROL_ID  = "cccccccc-0000-0000-0000-000000000003";
const TRIP_ID   = "33333333-0000-0000-0000-000000000001";
const MEETUP_ID = "44444444-0000-0000-0000-000000000002";
const PLACE_ID  = "55555555-0000-0000-0000-000000000003";
const ITEM_ID_1 = "66666666-0000-0000-0000-000000000004";
const ITEM_ID_2 = "77777777-0000-0000-0000-000000000005";

// ── Fake state shape ──────────────────────────────────────────────────────────

interface TM   { trip_id: string; user_id: string; role: string }
interface Item { id: string; trip_id: string; creator_id: string; title: string;
                 category: string; status: string; source_type: string;
                 source_id: string | null; day_date: string | null;
                 starts_at: string | null; ends_at: string | null;
                 location_name: string | null; notes: string | null;
                 sort_order: number; visibility: string;
                 removed_at: string | null;
                 created_at: string; updated_at: string;
                 approximate_lat?: number; approximate_lng?: number }
interface Meetup { id: string; title: string; starts_at: string | null; location_name: string | null }
interface Place  { id: string; name: string; category: string; location_name: string | null;
                   approximate_lat?: number; approximate_lng?: number }
interface Trip   { id: string; owner_id: string; plan_edit_permission?: string;
                   start_date?: string | null; end_date?: string | null }

interface State {
  users:           Record<string, { id: string } | null>;
  trips:           Trip[];
  trip_members:    TM[];
  trip_plan_items: Item[];
  meetups:         Meetup[];
  places:          Place[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trips: [
      { id: TRIP_ID, owner_id: ALICE_ID, plan_edit_permission: "all_members",
        start_date: null, end_date: null },
    ],
    trip_members:    [],
    trip_plan_items: [],
    meetups: [
      { id: MEETUP_ID, title: "Beach Meetup", starts_at: "2026-07-10T18:00:00Z", location_name: "Mactan Shore" },
    ],
    places: [
      { id: PLACE_ID, name: "Anzani Restaurant", category: "dining", location_name: "Banilad, Cebu",
        approximate_lat: 10.32, approximate_lng: 123.89 },
    ],
  };
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any = null;
    let _updatePayload: any = null;
    let _selectCols: string | null = null;

    const b: any = {
      select(cols?: string) { _selectCols = cols ?? null; return b; },
      insert(row: any) {
        _op = "insert";
        _insertRow = row;
        return b;
      },
      update(patch: any) { _op = "update"; _updatePayload = patch; return b; },
      delete() { _op = "delete"; return b; },
      eq(col: string, val: any) { filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { filters.push((r: any) => vals.includes(r[col])); return b; },
      is(col: string, val: any) {
        filters.push((r: any) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      order() { return b; },
      limit() { return b; },
      maybeSingle() { return resolveOne(); },
      single()      { return resolveInsertOrOne(); },
      then(onF: any, onR: any) {
        if (_op === "update")  return resolveUpdate().then(onF, onR);
        if (_op === "delete")  return resolveDelete().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matchedRows() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    function stripGps(row: any) {
      const { approximate_lat: _a, approximate_lng: _b, ...rest } = row;
      return rest;
    }

    async function resolveOne() {
      if (_op === "update") {
        const m = matchedRows();
        return { data: m[0] ? { ...m[0], ..._updatePayload } : null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ?? null, error: null };
    }

    async function resolveInsertOrOne() {
      if (_op === "insert" && _insertRow) {
        // check for duplicate (unique index simulation for source items)
        if (table === "trip_plan_items" && _insertRow.source_id) {
          const dup = getSource().find((r: any) =>
            r.trip_id === _insertRow.trip_id &&
            r.source_type === _insertRow.source_type &&
            r.source_id === _insertRow.source_id &&
            r.removed_at == null
          );
          if (dup) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
        }
        const newRow: any = {
          id: `new-${Date.now()}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          removed_at: null, ..._insertRow,
        };
        getSource().push(newRow);
        return { data: newRow, error: null };
      }
      if (_op === "update" && _updatePayload) {
        // Apply update to matching rows and return the first updated row
        const source = getSource();
        let updated: any = null;
        for (const row of source) {
          if (filters.every((f) => f(row))) {
            Object.assign(row, _updatePayload);
            updated = row;
          }
        }
        return { data: updated ?? null, error: null };
      }
      const m = matchedRows();
      return { data: m[0] ?? null, error: null };
    }

    async function resolveList() {
      return { data: matchedRows(), error: null };
    }

    async function resolveUpdate() {
      for (const row of getSource()) {
        if (filters.every((f) => f(row))) Object.assign(row, _updatePayload);
      }
      return { data: null, error: null };
    }

    async function resolveDelete() {
      (state as any)[table] = getSource().filter((r: any) => !filters.every((f) => f(r)));
      return { data: null, error: null };
    }

    return b;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const u = state.users[token];
        if (!u) return { data: { user: null }, error: { message: "invalid token" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Server helpers ─────────────────────────────────────────────────────────────

function makeApp(state: State) {
  _setTestClient(makeFakeClient(state), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", tripsRouter);
  app.use("/api", planRouter);
  return app;
}

interface TestServer { port: number; state: State; close: () => Promise<void> }

async function startServer(state: State): Promise<TestServer> {
  const app = makeApp(state);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ port, state, close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => e ? rej(e) : res()); }) });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH", headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(port: number, path: string, token?: string) {
  const headers: Record<string, string> = { connection: "close" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE", headers });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ── Test helpers ──────────────────────────────────────────────────────────────

function stateWithMembers(roles: Record<string, string>): State {
  const s = baseState();
  for (const [userId, role] of Object.entries(roles)) {
    s.trip_members.push({ trip_id: TRIP_ID, user_id: userId, role });
  }
  return s;
}

function stateWithItem(creatorId: string): State {
  const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member", [creatorId]: creatorId === ALICE_ID || creatorId === BOB_ID ? (creatorId === ALICE_ID ? "owner" : "member") : "member" });
  s.trip_plan_items.push({
    id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: creatorId,
    title: "Test Item", category: "activity", status: "tentative",
    source_type: "manual", source_id: null,
    day_date: null, starts_at: null, ends_at: null,
    location_name: null, notes: null,
    sort_order: 0, visibility: "members", removed_at: null,
    created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
  });
  return s;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// ── 1. Non-member cannot read plan ───────────────────────────────────────────

describe("GET /api/trips/:tripId/plan — membership gate", () => {
  it("1. non-member gets 403", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "bob-tok");
    assert.equal(r.status, 403);
    await close();
  });

  it("2. pending invitee gets 403", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "invited" });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "bob-tok");
    assert.equal(r.status, 403);
    await close();
  });

  it("3. accepted member gets 200 with items array", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "bob-tok");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    await close();
  });

  it("4. owner gets 200 with items array", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items));
    await close();
  });
});

// ── 5-7. POST /plan/items — create ────────────────────────────────────────────

describe("POST /api/trips/:tripId/plan/items — create", () => {
  it("5. non-member gets 403", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, "bob-tok", { title: "Test" });
    assert.equal(r.status, 403);
    await close();
  });

  it("6. member can create; creator_id set from token (not body)", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, "bob-tok", {
      title: "Swimming", category: "activity",
      // evil: attacker passes wrong creator_id in body — must be ignored
      creatorId: ALICE_ID,
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.creatorId, BOB_ID, "creatorId must come from token, not body");
    await close();
  });

  it("7. owner can create plan item", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, "alice-tok", { title: "Check-in" });
    assert.equal(r.status, 201);
    assert.equal(r.body.tripId, TRIP_ID);
    await close();
  });
});

// ── 8-10. PATCH /plan/items/:itemId — edit permissions ───────────────────────

describe("PATCH /api/trips/:tripId/plan/items/:itemId — edit", () => {
  it("8. member cannot edit another member's item", async () => {
    // Item belongs to BOB; Carol tries to edit
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member", [CAROL_ID]: "member" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
      title: "Bob item", category: "activity", status: "tentative",
      source_type: "manual", source_id: null, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "carol-tok", { title: "Modified" });
    assert.equal(r.status, 403);
    await close();
  });

  it("9. member can edit their own item", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "bob-tok", { title: "Updated Title" });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, "Updated Title");
    await close();
  });

  it("10. owner can edit any item", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "alice-tok", { status: "confirmed" });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "confirmed");
    await close();
  });
});

// ── 11-12. Soft-delete ────────────────────────────────────────────────────────

describe("PATCH /remove — soft-delete", () => {
  it("11. remove sets removed_at; source_type and source_id unchanged", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
      title: "Meetup item", category: "meeting_point", status: "tentative",
      source_type: "meetup", source_id: MEETUP_ID, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/remove`, "bob-tok");
    assert.equal(r.status, 200);
    // The item row in state should now have removed_at set
    const dbItem = s.trip_plan_items.find((i) => i.id === ITEM_ID_1)!;
    assert.ok(dbItem.removed_at, "removed_at should be set after soft-delete");
    // source fields untouched
    assert.equal(dbItem.source_type, "meetup");
    assert.equal(dbItem.source_id, MEETUP_ID);
    await close();
  });

  it("12. removed item no longer appears in GET /plan", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: ALICE_ID,
      title: "Gone item", category: "activity", status: "tentative",
      source_type: "manual", source_id: null, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members",
      removed_at: "2026-06-05T00:00:00Z", // already removed
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-05T00:00:00Z",
    });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 0, "removed item should not appear");
    await close();
  });
});

// ── 13. Duplicate meetup guard ────────────────────────────────────────────────

describe("POST /meetups/:id/add-to-trip-plan — duplicate guard", () => {
  it("13. adding same meetup twice returns 409", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    // First add — should succeed
    const r1 = await post(port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
    assert.equal(r1.status, 201, "first add should succeed");
    // Second add — should be duplicate
    const r2 = await post(port, `/api/meetups/${MEETUP_ID}/add-to-trip-plan`, "alice-tok", { tripId: TRIP_ID });
    assert.equal(r2.status, 409, "second add should return 409 duplicate");
    await close();
  });
});

// ── 14. GPS fields not exposed ────────────────────────────────────────────────

describe("GET /plan — GPS privacy", () => {
  it("14. plan item responses do not include GPS coordinates", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner" });
    // Add a place item manually with GPS fields in the row
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: ALICE_ID,
      title: "Anzani", category: "dining", status: "tentative",
      source_type: "place", source_id: PLACE_ID,
      day_date: null, starts_at: null, ends_at: null,
      location_name: "Banilad, Cebu", notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
      // These should NOT appear in the response
      approximate_lat: 10.32,
      approximate_lng: 123.89,
    });
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    const item = r.body.items[0];
    assert.equal(item.approximate_lat, undefined, "approximate_lat must not be exposed");
    assert.equal(item.approximate_lng, undefined, "approximate_lng must not be exposed");
    await close();
  });
});

// ── 15. creator_id always from token ─────────────────────────────────────────

describe("POST /plan/items — creator_id from token", () => {
  it("15. creator_id in response matches token even if body sends different value", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, "bob-tok", {
      title: "My item",
      creatorId: ALICE_ID, // attacker tries to impersonate alice
      creator_id: ALICE_ID, // snake_case variant
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.creatorId, BOB_ID, "creator must always be set from JWT, not body");
    await close();
  });
});

// ── POST /plan/reorder — batch reorder (Optimize Today persistence) ───────────

const ITEM_ID_3 = "88888888-0000-0000-0000-000000000006";

function itemRow(id: string, sortOrder: number): Item {
  return {
    id, trip_id: TRIP_ID, creator_id: ALICE_ID,
    title: `Item ${id}`, category: "activity", status: "confirmed",
    source_type: "manual", source_id: null,
    day_date: null, starts_at: null, ends_at: null,
    location_name: null, notes: null,
    sort_order: sortOrder, visibility: "members", removed_at: null,
    created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
  };
}

function stateWithThreeItems(roles: Record<string, string>): State {
  const s = stateWithMembers(roles);
  s.trip_plan_items.push(itemRow(ITEM_ID_1, 2), itemRow(ITEM_ID_2, 5), itemRow(ITEM_ID_3, 7));
  return s;
}

describe("POST /api/trips/:tripId/plan/reorder — batch reorder", () => {
  it("R1. owner reorder swaps only the provided items within their own slots", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    // Reorder [ITEM_2, ITEM_1]: they hold slots {2,5}; new order → ITEM_2=2, ITEM_1=5.
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", {
      orderedItemIds: [ITEM_ID_2, ITEM_ID_1],
    });
    assert.equal(r.status, 200);
    const body = r.body as { status: string; count: number };
    assert.equal(body.status, "reordered");
    assert.equal(body.count, 2);

    const byId = (id: string) => s.trip_plan_items.find((i) => i.id === id)!;
    assert.equal(byId(ITEM_ID_2).sort_order, 2, "ITEM_2 takes the earlier slot");
    assert.equal(byId(ITEM_ID_1).sort_order, 5, "ITEM_1 takes the later slot");
    // The item NOT in the list keeps its exact slot — no silent rewrite (§11).
    assert.equal(byId(ITEM_ID_3).sort_order, 7, "unlisted item is untouched");
    await close();
  });

  it("R2. non-owner member is forbidden (owner-only, matches single-item reorder)", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "bob-tok", {
      orderedItemIds: [ITEM_ID_2, ITEM_ID_1],
    });
    assert.equal(r.status, 403);
    // Canonical order is untouched by a rejected reorder.
    assert.equal(s.trip_plan_items.find((i) => i.id === ITEM_ID_1)!.sort_order, 2);
    await close();
  });

  it("R3. a non-member is forbidden", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "bob-tok", {
      orderedItemIds: [ITEM_ID_2, ITEM_ID_1],
    });
    assert.equal(r.status, 403);
    await close();
  });

  it("R4. an id not on the trip is rejected", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", {
      orderedItemIds: [ITEM_ID_1, "99999999-0000-0000-0000-00000000000a"],
    });
    assert.equal(r.status, 400);
    await close();
  });

  it("R5. duplicate ids are rejected", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", {
      orderedItemIds: [ITEM_ID_1, ITEM_ID_1],
    });
    assert.equal(r.status, 400);
    await close();
  });

  it("R6. a soft-deleted item cannot be reordered", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    s.trip_plan_items.find((i) => i.id === ITEM_ID_2)!.removed_at = "2026-06-02T00:00:00Z";
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", {
      orderedItemIds: [ITEM_ID_2, ITEM_ID_1],
    });
    assert.equal(r.status, 400);
    await close();
  });

  it("R7. an unchanged order persists nothing but still succeeds", async () => {
    const s = stateWithThreeItems({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/reorder`, "alice-tok", {
      orderedItemIds: [ITEM_ID_1, ITEM_ID_2],
    });
    assert.equal(r.status, 200);
    assert.equal((r.body as { count: number }).count, 0, "already in slot order → no writes");
    await close();
  });
});

// ── canEditPlanItem — unit tests ──────────────────────────────────────────────

function makeMiniClient(items: any[], members: any[]) {
  return {
    from(table: string) {
      const source = table === "trip_plan_items" ? items : members;
      const filters: Array<(r: any) => boolean> = [];
      const b: any = {
        select() { return b; },
        eq(c: string, v: any) { filters.push((r: any) => r[c] === v); return b; },
        in(c: string, vs: any[]) { filters.push((r: any) => vs.includes(r[c])); return b; },
        is(c: string, v: any) {
          filters.push((r: any) => v === null ? r[c] == null : r[c] === v);
          return b;
        },
        async maybeSingle() {
          return { data: source.filter((r) => filters.every((f) => f(r)))[0] ?? null, error: null };
        },
      };
      return b;
    },
  };
}

function planItem(id: string, tripId: string, creatorId: string, removedAt: string | null = null) {
  return { id, trip_id: tripId, creator_id: creatorId, removed_at: removedAt };
}

function membership(tripId: string, userId: string, role: string) {
  return { trip_id: tripId, user_id: userId, role };
}

describe("canEditPlanItem — unit tests", () => {
  it("A. not_found when item does not exist", async () => {
    const client = makeMiniClient([], [membership(TRIP_ID, ALICE_ID, "owner")]);
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, ALICE_ID);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "not_found");
  });

  it("B. not_found when item is soft-deleted (removed_at set)", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, ALICE_ID, "2026-06-01T00:00:00Z")],
      [membership(TRIP_ID, ALICE_ID, "owner")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, ALICE_ID);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "not_found");
  });

  it("C. not_member when user has no accepted membership", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)],
      [],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, BOB_ID);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "not_member");
  });

  it("D. not_member when user is only invited (not accepted)", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)],
      [membership(TRIP_ID, BOB_ID, "invited")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, BOB_ID);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "not_member");
  });

  it("E. forbidden when member tries to edit another member's item", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, ALICE_ID)],
      [membership(TRIP_ID, BOB_ID, "member")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, BOB_ID);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "forbidden");
  });

  it("F. permitted when member edits their own item", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, BOB_ID)],
      [membership(TRIP_ID, BOB_ID, "member")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, BOB_ID);
    assert.equal(r.permitted, true);
    if (r.permitted) {
      assert.equal(r.role, "member");
      assert.equal(r.creatorId, BOB_ID);
    }
  });

  it("G. permitted when owner edits another member's item", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, BOB_ID)],
      [membership(TRIP_ID, ALICE_ID, "owner")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, ALICE_ID);
    assert.equal(r.permitted, true);
    if (r.permitted) assert.equal(r.role, "owner");
  });

  it("H. ownerOnly=true: forbidden for member even editing their own item", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, BOB_ID)],
      [membership(TRIP_ID, BOB_ID, "member")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, BOB_ID, true);
    assert.equal(r.permitted, false);
    assert.equal((r as any).code, "forbidden");
  });

  it("I. ownerOnly=true: permitted for trip owner", async () => {
    const client = makeMiniClient(
      [planItem(ITEM_ID_1, TRIP_ID, BOB_ID)],
      [membership(TRIP_ID, ALICE_ID, "owner")],
    );
    const r = await canEditPlanItem(client as any, TRIP_ID, ITEM_ID_1, ALICE_ID, true);
    assert.equal(r.permitted, true);
    if (r.permitted) assert.equal(r.role, "owner");
  });
});

// ── DELETE /plan/items/:itemId — REST soft-delete permissions ─────────────────

describe("DELETE /api/trips/:tripId/plan/items/:itemId — permissions", () => {
  it("16. member cannot delete another member's item (403)", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member", [CAROL_ID]: "member" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
      title: "Bob item", category: "activity", status: "tentative",
      source_type: "manual", source_id: null, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "carol-tok");
    assert.equal(r.status, 403);
    await close();
  });

  it("17. member can delete their own item (204)", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "bob-tok");
    assert.equal(r.status, 204);
    const dbItem = s.trip_plan_items.find((i) => i.id === ITEM_ID_1)!;
    assert.ok(dbItem.removed_at, "removed_at should be set after DELETE");
    await close();
  });

  it("18. owner can delete any member's item (204)", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, "alice-tok");
    assert.equal(r.status, 204);
    await close();
  });
});

// ── PATCH /remove — additional permission scenarios ───────────────────────────

describe("PATCH /remove — additional permission scenarios", () => {
  it("19. member cannot remove another member's item (403)", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member", [CAROL_ID]: "member" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
      title: "Bob item", category: "activity", status: "tentative",
      source_type: "manual", source_id: null, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/remove`, "carol-tok");
    assert.equal(r.status, 403);
    await close();
  });

  it("20. owner can remove any member's item (200)", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/remove`, "alice-tok");
    assert.equal(r.status, 200);
    await close();
  });
});

// ── POST /reorder — owner-only enforcement ────────────────────────────────────

describe("POST /plan/items/:itemId/reorder — owner-only", () => {
  it("21. member cannot reorder items (403)", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/reorder`, "bob-tok", { sortOrder: 2000 });
    assert.equal(r.status, 403);
    await close();
  });

  it("22. owner can reorder any item (200)", async () => {
    const s = stateWithItem(BOB_ID);
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/reorder`, "alice-tok", { sortOrder: 5000 });
    assert.equal(r.status, 200);
    assert.equal(r.body.sortOrder, 5000);
    await close();
  });
});

// ── 23-27. Invited (pending) member cannot mutate plan ────────────────────────
// The server already enforces this via isAcceptedTripMember / canEditPlanItem
// (both check role IN ('owner','member')), but these tests make it explicit.

describe("Invited member blocked from plan mutations", () => {
  const INVITED_TOK = "carol-tok";

  function stateWithInvitedAndItem(): State {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member", [CAROL_ID]: "invited" });
    s.trip_plan_items.push({
      id: ITEM_ID_1, trip_id: TRIP_ID, creator_id: BOB_ID,
      title: "Existing item", category: "activity", status: "tentative",
      source_type: "manual", source_id: null, day_date: null,
      starts_at: null, ends_at: null, location_name: null, notes: null,
      sort_order: 0, visibility: "members", removed_at: null,
      created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    });
    return s;
  }

  it("23. invited member cannot POST a new plan item (403)", async () => {
    const s = stateWithMembers({ [ALICE_ID]: "owner", [CAROL_ID]: "invited" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, INVITED_TOK, { title: "Sneak Add" });
    assert.equal(r.status, 403, "invited member must not be able to add plan items");
    await close();
  });

  it("24. invited member cannot PATCH an existing plan item (403)", async () => {
    const s = stateWithInvitedAndItem();
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, INVITED_TOK, { title: "Hijacked" });
    assert.equal(r.status, 403, "invited member must not be able to edit plan items");
    await close();
  });

  it("25. invited member cannot DELETE a plan item (403)", async () => {
    const s = stateWithInvitedAndItem();
    const { port, close } = await startServer(s);
    const r = await del(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}`, INVITED_TOK);
    assert.equal(r.status, 403, "invited member must not be able to delete plan items");
    await close();
  });

  it("26. invited member cannot soft-remove a plan item (403)", async () => {
    const s = stateWithInvitedAndItem();
    const { port, close } = await startServer(s);
    const r = await patch(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/remove`, INVITED_TOK);
    assert.equal(r.status, 403, "invited member must not be able to remove plan items");
    await close();
  });

  it("27. invited member cannot reorder plan items (403)", async () => {
    const s = stateWithInvitedAndItem();
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_1}/reorder`, INVITED_TOK, { sortOrder: 999 });
    assert.equal(r.status, 403, "invited member must not be able to reorder plan items");
    await close();
  });
});
