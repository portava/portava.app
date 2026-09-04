/**
 * GET /api/route-plans/for-trip/:tripId — the Trip Map's route source (§11, §19).
 *
 * The map is opened with a tripId, not a plan id, so this endpoint resolves the
 * VIEWER'S OWN route plan for the trip — active first (§10: only accepted plans
 * are declarations), else most recently updated. Scoped to owner_user_id = the
 * caller, so a member never sees another member's plan.
 *
 * Run: node --import tsx/esm --test src/test/tripRoutePlan.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import routePlanRouter from "../routes/routePlan.js";

const USER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const TRIP_ID  = "33333333-0000-0000-0000-000000000001";
const OTHER_TRIP = "33333333-0000-0000-0000-000000000009";
const ACTIVE_PLAN = "aaaa1111-0000-0000-0000-000000000001";
const DRAFT_PLAN  = "aaaa2222-0000-0000-0000-000000000002";

interface Store {
  route_plans: Record<string, unknown>[];
  route_stops: Record<string, unknown>[];
  route_legs:  Record<string, unknown>[];
  trip_plan_items: Record<string, unknown>[];
  profiles: Record<string, unknown>[];
}

function makeClient(store: Store) {
  const user = { id: USER_ID, email: "u@example.com" };

  function from(table: keyof Store | string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const rows = (): Record<string, unknown>[] =>
      (store as unknown as Record<string, Record<string, unknown>[]>)[table as string] ?? [];
    const matched = () => rows().filter((r) => filters.every((f) => f(r)));
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => unknown) =>
        Promise.resolve({ data: matched(), error: null }).then(resolve),
    };
    return b;
  }

  return {
    from,
    auth: { getUser: async (_token: string) => ({ data: { user }, error: null }) },
  };
}

function makeApp(store: Store) {
  _setTestClient(makeClient(store) as never, true);
  const app = express();
  app.use(express.json());
  app.use((req: express.Request & { log?: unknown }, _res, next) => {
    (req as { log: unknown }).log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", routePlanRouter);
  return app;
}

function startServer(store: Store): Promise<{ port: number; close: () => Promise<void> }> {
  const app = makeApp(store);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({ port, close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }) });
    });
    srv.on("error", reject);
  });
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: "Bearer test-token", connection: "close" },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function planRow(over: { id: string; status: string; ownerUserId?: string; tripId?: string; updatedAt?: string }): Record<string, unknown> {
  return {
    id: over.id,
    owner_user_id: over.ownerUserId ?? USER_ID,
    trip_id: over.tripId ?? TRIP_ID,
    title: "Night route",
    start_location: null,
    end_location: null,
    route_style: "nightlife",
    status: over.status,
    compass_explanation: null,
    is_approximated: false,
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: over.updatedAt ?? "2026-09-01T00:00:00.000Z",
  };
}

function emptyStore(): Store {
  return { route_plans: [], route_stops: [], route_legs: [], trip_plan_items: [], profiles: [] };
}

test("prefers the viewer's ACTIVE plan for the trip over a draft", async () => {
  const store = emptyStore();
  store.route_plans.push(
    planRow({ id: DRAFT_PLAN, status: "draft", updatedAt: "2026-09-03T00:00:00.000Z" }),
    planRow({ id: ACTIVE_PLAN, status: "active", updatedAt: "2026-09-02T00:00:00.000Z" }),
  );
  store.route_stops.push(
    { id: "rs-1", route_plan_id: ACTIVE_PLAN, source_type: "trip_plan_item", source_id: null, title: "A", order_index: 0, planned_arrival_time: null, planned_departure_time: null, checkpoint_status: "pending", arrived_at: null, notes: null, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" },
  );
  const { port, close } = await startServer(store);
  const r = await get(port, `/api/route-plans/for-trip/${TRIP_ID}`);
  assert.equal(r.status, 200);
  const body = r.body as { plan: { id: string; status: string; tripId: string }; stops: unknown[] };
  assert.equal(body.plan.id, ACTIVE_PLAN, "active plan wins over the draft");
  assert.equal(body.plan.status, "active");
  assert.equal(body.plan.tripId, TRIP_ID);
  assert.ok(Array.isArray(body.stops));
  await close();
});

test("returns null when the viewer has no route plan for the trip", async () => {
  const store = emptyStore();
  // A plan exists, but for a DIFFERENT trip.
  store.route_plans.push(planRow({ id: ACTIVE_PLAN, status: "active", tripId: OTHER_TRIP }));
  const { port, close } = await startServer(store);
  const r = await get(port, `/api/route-plans/for-trip/${TRIP_ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, null);
  await close();
});

test("never returns another user's plan for the trip", async () => {
  const store = emptyStore();
  // Someone else's plan on the same trip must be invisible to this viewer.
  store.route_plans.push(planRow({ id: ACTIVE_PLAN, status: "active", ownerUserId: OTHER_ID }));
  const { port, close } = await startServer(store);
  const r = await get(port, `/api/route-plans/for-trip/${TRIP_ID}`);
  assert.equal(r.status, 200);
  assert.equal(r.body, null, "scoped to owner_user_id = caller");
  await close();
});

test("rejects an invalid trip id", async () => {
  const { port, close } = await startServer(emptyStore());
  const r = await get(port, `/api/route-plans/for-trip/not-a-uuid`);
  assert.equal(r.status, 400);
  await close();
});
