/**
 * Backend tests for Task #14: Trip Itinerary Timeline + Map View
 *
 * 12 scenarios:
 *  1.  Non-member gets 403 on GET /plan
 *  2.  Accepted member gets 200 with items array + warnings field
 *  3.  time_overlap warning when two items on same day start within 30 min
 *  4.  duplicate warning when same source_id in two active items
 *  5.  outside_trip_dates warning when item day_date outside trip start/end
 *  6.  No warnings when no conflicts exist
 *  7.  GET /plan/map returns only items with safe public coordinates
 *  8.  lat/lng absent (null) in /plan response when location_is_private=true
 *  9.  lat/lng present in /plan response when location_is_private=false
 * 10.  Removed item does NOT appear in /plan or /plan/map
 * 11.  Non-member cannot create plan item (403)
 * 12.  Member cannot edit another member's item (403)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import tripsRouter from "../routes/trips.js";
import planRouter from "../routes/plan.js";

// ── ID constants ──────────────────────────────────────────────────────────────

const ALICE_ID   = "aaaaaaaa-1111-0000-0000-000000000001";
const BOB_ID     = "bbbbbbbb-1111-0000-0000-000000000002";
const CAROL_ID   = "cccccccc-1111-0000-0000-000000000003";
const TRIP_ID    = "11110000-1111-0000-0000-000000000001";
const ITEM_ID_A  = "aaaaaaaa-2222-0000-0000-000000000001";
const ITEM_ID_B  = "bbbbbbbb-2222-0000-0000-000000000002";
const ITEM_ID_C  = "cccccccc-2222-0000-0000-000000000003";
const SOURCE_ID  = "ssssssss-0000-0000-0000-000000000001";

// ── State shape ──────────────────────────────────────────────────────────────

interface TM   { trip_id: string; user_id: string; role: string }
interface Trip { id: string; start_date: string | null; end_date: string | null }
interface Item {
  id: string; trip_id: string; creator_id: string; title: string;
  category: string; status: string; source_type: string;
  source_id: string | null; day_date: string | null;
  starts_at: string | null; ends_at: string | null;
  location_name: string | null; notes: string | null;
  sort_order: number; visibility: string; removed_at: string | null;
  created_at: string; updated_at: string;
  lat?: number | null; lng?: number | null; location_is_private?: boolean;
}

interface Meetup { id: string; status: string }

interface State {
  users:           Record<string, { id: string } | null>;
  trips:           Trip[];
  trip_members:    TM[];
  trip_plan_items: Item[];
  meetups:         Meetup[];
}

function baseState(): State {
  return {
    users: {
      "alice-tok": { id: ALICE_ID },
      "bob-tok":   { id: BOB_ID },
      "carol-tok": { id: CAROL_ID },
    },
    trips: [
      { id: TRIP_ID, start_date: "2026-07-01", end_date: "2026-07-15" },
    ],
    trip_members:    [],
    trip_plan_items: [],
    meetups:         [],
  };
}

function withMembers(roles: Record<string, string>): State {
  const s = baseState();
  for (const [uid, role] of Object.entries(roles)) {
    s.trip_members.push({ trip_id: TRIP_ID, user_id: uid, role });
  }
  return s;
}

// ── Fake Supabase client ──────────────────────────────────────────────────────

function makeFakeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let _op: "select" | "update" | "delete" | "insert" = "select";
    let _insertRow: any = null;
    let _updatePayload: any = null;

    const b: any = {
      select(_cols?: string) { return b; },
      insert(row: any)  { _op = "insert"; _insertRow = row; return b; },
      update(p: any)    { _op = "update"; _updatePayload = p; return b; },
      delete()          { _op = "delete"; return b; },
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
        if (_op === "update") return resolveUpdate().then(onF, onR);
        if (_op === "delete") return resolveDelete().then(onF, onR);
        return resolveList().then(onF, onR);
      },
    };

    function getSource(): any[] { return (state as any)[table] ?? []; }
    function matched() { return getSource().filter((r: any) => filters.every((f) => f(r))); }

    async function resolveOne() {
      if (_op === "update") {
        const m = matched();
        return { data: m[0] ? { ...m[0], ..._updatePayload } : null, error: null };
      }
      const m = matched();
      return { data: m[0] ?? null, error: null };
    }

    async function resolveInsertOrOne() {
      if (_op === "insert" && _insertRow) {
        const newRow: any = {
          id: `new-${Date.now()}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          removed_at: null, ..._insertRow,
        };
        getSource().push(newRow);
        return { data: newRow, error: null };
      }
      if (_op === "update" && _updatePayload) {
        const source = getSource();
        let updated: any = null;
        for (const row of source) {
          if (filters.every((f) => f(row))) { Object.assign(row, _updatePayload); updated = row; }
        }
        return { data: updated ?? null, error: null };
      }
      const m = matched();
      return { data: m[0] ?? null, error: null };
    }

    async function resolveList() { return { data: matched(), error: null }; }

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

// ── Server helpers ────────────────────────────────────────────────────────────

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

async function startServer(state: State) {
  const app = makeApp(state);
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patchReq(port: number, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH", headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function makeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    trip_id: TRIP_ID, creator_id: ALICE_ID, title: "Test Item",
    category: "activity", status: "tentative", source_type: "manual",
    source_id: null, day_date: null, starts_at: null, ends_at: null,
    location_name: null, notes: null, sort_order: 0, visibility: "members",
    removed_at: null, created_at: "2026-06-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
    lat: null, lng: null, location_is_private: true,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function deleteReq(port: number, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "DELETE", headers });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

describe("Itinerary timeline + map — 15 scenarios", () => {

  it("1. Non-member gets 403 on GET /plan", async () => {
    const s = withMembers({});
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "carol-tok");
    await close();
    assert.equal(r.status, 403);
  });

  it("2. Accepted member gets 200 with items array and warnings field", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(makeItem({ id: ITEM_ID_A, title: "Lunch" }));
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.items), "items must be an array");
    assert.equal(r.body.items.length, 1);
    const item = r.body.items[0];
    assert.ok(Array.isArray(item.warnings), "each item must have a warnings array");
  });

  it("3. time_overlap warning: two items same day_date starting within 30 min", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Breakfast", day_date: "2026-07-05", starts_at: "2026-07-05T08:00:00Z" }),
      makeItem({ id: ITEM_ID_B, title: "Gym",       day_date: "2026-07-05", starts_at: "2026-07-05T08:20:00Z" }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    assert.ok(items.every((i: any) => i.warnings.includes("time_overlap")),
      "both overlapping items must have time_overlap warning");
  });

  it("4. duplicate warning: same source_id in two active plan items", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, source_type: "meetup", source_id: SOURCE_ID, title: "Meetup 1" }),
      makeItem({ id: ITEM_ID_B, source_type: "meetup", source_id: SOURCE_ID, title: "Meetup 2" }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    assert.ok(items.every((i: any) => i.warnings.includes("duplicate")),
      "both items with same source_id must have duplicate warning");
  });

  it("5. outside_trip_dates warning: item day_date outside trip start/end", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Pre-trip meal", day_date: "2026-06-20" }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const item = r.body.items[0];
    assert.ok(item.warnings.includes("outside_trip_dates"),
      "item with day_date before trip start must have outside_trip_dates warning");
  });

  it("6. No warnings when items have no conflicts", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Morning swim", day_date: "2026-07-03", starts_at: "2026-07-03T07:00:00Z" }),
      makeItem({ id: ITEM_ID_B, title: "Lunch",        day_date: "2026-07-03", starts_at: "2026-07-03T12:00:00Z" }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    assert.ok(items.every((i: any) => i.warnings.length === 0),
      "well-spaced items must have no warnings");
  });

  it("7. GET /plan/map returns only items with safe public coordinates", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "No coords",     lat: null, lng: null, location_is_private: true }),
      makeItem({ id: ITEM_ID_B, title: "Private coords", lat: 10.32, lng: 123.89, location_is_private: true }),
      makeItem({ id: ITEM_ID_C, title: "Public coords",  lat: 10.35, lng: 123.91, location_is_private: false }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan/map`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    assert.equal(items.length, 1, "map endpoint must return only items with public coordinates");
    assert.equal(items[0].title, "Public coords");
    assert.ok(items[0].lat != null, "lat must be present for public items");
    assert.ok(items[0].lng != null, "lng must be present for public items");
  });

  it("8. lat/lng null in /plan response when location_is_private=true", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Hotel", lat: 10.32, lng: 123.89, location_is_private: true }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const item = r.body.items[0];
    assert.equal(item.lat, null, "lat must be null when location_is_private=true");
    assert.equal(item.lng, null, "lng must be null when location_is_private=true");
    assert.equal(item.locationIsPrivate, true);
  });

  it("9. lat/lng present in /plan response when location_is_private=false", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Cafe", lat: 10.32, lng: 123.89, location_is_private: false }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const item = r.body.items[0];
    assert.equal(item.lat, 10.32, "lat must be present when location_is_private=false");
    assert.equal(item.lng, 123.89, "lng must be present when location_is_private=false");
    assert.equal(item.locationIsPrivate, false);
  });

  it("10. Removed item does not appear in /plan or /plan/map", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Removed", removed_at: "2026-06-10T00:00:00Z",
                 lat: 10.32, lng: 123.89, location_is_private: false }),
      makeItem({ id: ITEM_ID_B, title: "Active" }),
    );
    const { port, close } = await startServer(s);
    const [plan, map] = await Promise.all([
      get(port, `/api/trips/${TRIP_ID}/plan`,     "alice-tok"),
      get(port, `/api/trips/${TRIP_ID}/plan/map`, "alice-tok"),
    ]);
    await close();
    assert.equal(plan.body.items.length, 1);
    assert.equal(plan.body.items[0].title, "Active");
    assert.equal(map.body.items.length, 0, "removed item must not appear in map endpoint");
  });

  it("11. Non-member cannot create plan item (403)", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    const { port, close } = await startServer(s);
    const r = await post(port, `/api/trips/${TRIP_ID}/plan/items`, "carol-tok", { title: "Crash" });
    await close();
    assert.equal(r.status, 403);
  });

  it("12. Member cannot edit another member's plan item (403)", async () => {
    const s = withMembers({ [ALICE_ID]: "owner", [BOB_ID]: "member" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Alice item", creator_id: ALICE_ID }),
    );
    const { port, close } = await startServer(s);
    const r = await patchReq(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_A}`,
      "bob-tok", { title: "Bob hijacks" });
    await close();
    assert.equal(r.status, 403, "member must not be able to edit another member's item");
  });

  it("13. missing_location warning: item has location_name but no coordinates", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Eiffel Tower", location_name: "Eiffel Tower, Paris", lat: null, lng: null }),
      makeItem({ id: ITEM_ID_B, title: "Louvre",       location_name: "Louvre Museum",        lat: 48.860, lng: 2.337, location_is_private: false }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    const noCoord = items.find((i: any) => i.title === "Eiffel Tower");
    const withCoord = items.find((i: any) => i.title === "Louvre");
    assert.ok(noCoord.warnings.includes("unmapped_location"),
      "item with location_name but no lat/lng must have unmapped_location warning");
    assert.ok(!withCoord.warnings.includes("unmapped_location"),
      "item with coordinates must NOT have unmapped_location warning");
  });

  it("14. cancelled_source warning: meetup-sourced item from a cancelled meetup", async () => {
    const MEETUP_ID = "mmmmmmm0-1111-0000-0000-000000000001";
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.meetups.push({ id: MEETUP_ID, status: "cancelled" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "Cancelled meetup event",
                 source_type: "meetup", source_id: MEETUP_ID }),
      makeItem({ id: ITEM_ID_B, title: "Regular item", source_type: "manual" }),
    );
    const { port, close } = await startServer(s);
    const r = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(r.status, 200);
    const items: any[] = r.body.items;
    const sourced = items.find((i: any) => i.title === "Cancelled meetup event");
    const regular = items.find((i: any) => i.title === "Regular item");
    assert.ok(sourced.warnings.includes("cancelled_source"),
      "item sourced from cancelled meetup must have cancelled_source warning");
    assert.ok(!regular.warnings.includes("cancelled_source"),
      "manual item must NOT have cancelled_source warning");
  });

  it("15. DELETE /plan/items/:itemId removes item (204)", async () => {
    const s = withMembers({ [ALICE_ID]: "owner" });
    s.trip_plan_items.push(
      makeItem({ id: ITEM_ID_A, title: "To delete", creator_id: ALICE_ID }),
    );
    const { port, close } = await startServer(s);
    const del = await deleteReq(port, `/api/trips/${TRIP_ID}/plan/items/${ITEM_ID_A}`, "alice-tok");
    const plan = await get(port, `/api/trips/${TRIP_ID}/plan`, "alice-tok");
    await close();
    assert.equal(del.status, 204, "DELETE must return 204");
    assert.equal(plan.body.items.length, 0, "deleted item must not appear in plan");
  });

});
