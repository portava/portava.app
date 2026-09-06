/**
 * Integration-style tests for the route plan API routes.
 * Uses node:test + the local-express pattern from tripPlan.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import routePlanRouter from "../routes/routePlan.js";

// ── Fake client builder ────────────────────────────────────────────────────────

const PLAN_ID  = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const STOP_ID_1 = "11111111-2222-3333-4444-555555555555";

interface Store {
  route_plans: any[];
  route_stops: any[];
  route_legs:  any[];
}

function makeClient(store: Store = { route_plans: [], route_stops: [], route_legs: [] }) {
  const fakeUser = { id: "user-001", email: "test@example.com" };

  function makeChain(table: string): any {
    let _data: any = null;
    let _error: any = null;
    let _conds: Record<string, unknown> = {};
    let _patch: Record<string, unknown> | null = null;
    let _inserting: any[] | null = null;
    let _deleting = false;

    const obj: any = {
      select:  () => obj,
      eq:      (col: string, val: unknown) => { _conds[col] = val; return obj; },
      in:      () => obj,
      is:      () => obj,
      order:   () => obj,
      limit:   () => obj,
      gte:     () => obj,
      lte:     () => obj,
      filter:  () => obj,

      insert: (rows: any) => {
        _inserting = Array.isArray(rows) ? rows : [rows];
        return obj;
      },

      update: (patch: any) => {
        _patch = patch;
        return obj;
      },

      delete: () => {
        _deleting = true;
        return obj;
      },

      maybeSingle: async () => {
        // Flush any pending mutations first
        _flush();
        if (table === "trip_members") return { data: null, error: null };
        if (table === "route_plans") {
          // If the flush already produced a row (an update path), that IS the
          // result — including a null from a CAS that matched nothing.
          if (_patch === null && _data !== null) return { data: _data, error: null };
          const id = _conds["id"] ?? _conds["route_plan_id"];
          const found = store.route_plans.find((p) => p.id === id);
          return { data: found ?? null, error: null };
        }
        if (table === "route_stops") {
          const id = _conds["id"];
          const planId = _conds["route_plan_id"];
          const found = store.route_stops.find((s) => s.id === id && s.route_plan_id === planId);
          return { data: found ?? null, error: null };
        }
        return { data: _data, error: _error };
      },

      single: async () => {
        _flush();
        if (table === "route_plans") {
          return { data: _data ?? store.route_plans[store.route_plans.length - 1] ?? null, error: null };
        }
        if (table === "route_stops") {
          return { data: _data ?? store.route_stops[store.route_stops.length - 1] ?? null, error: null };
        }
        return { data: _data, error: _error };
      },

      then: (resolve: Function) => {
        _flush();
        return Promise.resolve({ data: table === "route_stops" ? store.route_stops : _data, error: _error }).then(resolve);
      },
    };

    function _flush() {
      if (_inserting) {
        if (table === "route_plans") {
          const r = { ..._inserting[0], id: PLAN_ID, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          store.route_plans.push(r);
          _data = r;
        } else if (table === "route_stops") {
          _inserting.forEach((r: any, i: number) => {
            const saved = { ...r, id: STOP_ID_1 + String(i), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            store.route_stops.push(saved);
            if (i === 0) _data = saved;
          });
        } else if (table === "route_legs") {
          _inserting.forEach((r: any) => store.route_legs.push({ ...r, id: "leg-" + Math.random() }));
        }
        _inserting = null;
      }

      if (_patch) {
        if (table === "route_plans") {
          // COMPARE-AND-SET, honoured properly. The accept and complete handlers
          // both write `.eq("id", id).eq("status", <expected>)` so two concurrent
          // transitions collapse into one. A fake that ignored the status
          // condition would apply the update unconditionally and every
          // race/invalid-transition assertion below would pass for the wrong
          // reason — which is exactly the vacuous-fixture shape this repo keeps
          // getting caught by.
          const idx = store.route_plans.findIndex((pl) =>
            Object.entries(_conds).every(([col, val]) => pl[col] === val));
          if (idx !== -1) {
            store.route_plans[idx] = { ...store.route_plans[idx], ..._patch };
            _data = store.route_plans[idx];
          } else {
            _data = null; // CAS matched nothing -> the handler must report conflict
          }
        } else if (table === "route_stops") {
          const id     = _conds["id"];
          const planId = _conds["route_plan_id"];
          const idx    = store.route_stops.findIndex((s) => s.id === id && s.route_plan_id === planId);
          if (idx !== -1) {
            store.route_stops[idx] = { ...store.route_stops[idx], ..._patch };
            _data = store.route_stops[idx];
          }
        }
        _patch = null;
      }

      if (_deleting) {
        if (table === "route_plans") {
          const id = _conds["id"];
          store.route_plans = store.route_plans.filter((p) => p.id !== id);
        }
        _deleting = false;
      }
    }

    return obj;
  }

  return {
    auth: {
      getUser: async (_token: string) => ({ data: { user: fakeUser }, error: null }),
    },
    from: (table: string) => makeChain(table),
  };
}

// ── Local app builder ─────────────────────────────────────────────────────────

function makeApp(store: Store) {
  _setTestClient(makeClient(store), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", routePlanRouter);
  return app;
}

interface TestServer { port: number; close: () => Promise<void> }

function startServer(store: Store): Promise<TestServer> {
  const app = makeApp(store);
  return new Promise((resolve, reject) => {
    const srv = createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ port, close: () => new Promise<void>((res, rej) => srv.close((e) => e ? rej(e) : res())) });
    });
    srv.on("error", reject);
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

import http from "node:http";

function req(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer test-token",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const r = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: text }); }
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test("POST /api/route-plans — creates plan and returns 201", async () => {
  const store: Store = { route_plans: [], route_stops: [], route_legs: [] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", "/api/route-plans", {
      title: "Test Route",
      routeStyle: "custom",
      stops: [
        { title: "Stop A", lat: 1.28, lng: 103.85 },
        { title: "Stop B", lat: 1.29, lng: 103.87 },
      ],
    });
    assert.equal(status, 201);
    assert.ok(body.plan,              "response must have .plan");
    assert.ok(Array.isArray(body.stops), "response must have .stops array");
    assert.ok(Array.isArray(body.legs),  "response must have .legs array");
    assert.equal(body.plan.isApproximated, true);
  } finally { await srv.close(); }
});

test("POST /api/route-plans — rejects fewer than 2 stops", async () => {
  const store: Store = { route_plans: [], route_stops: [], route_legs: [] };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", "/api/route-plans", {
      routeStyle: "custom",
      stops: [{ title: "Only one", lat: 1.28, lng: 103.85 }],
    });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_payload");
  } finally { await srv.close(); }
});

test("PATCH /api/route-plans/:id/stops/:stopId — checkpoint arrived", async () => {
  const store: Store = {
    route_plans: [{ id: PLAN_ID, owner_user_id: "user-001", trip_id: null, title: "T", route_style: "custom", status: "draft", is_approximated: true }],
    route_stops: [{ id: STOP_ID_1, route_plan_id: PLAN_ID, title: "Stop A", structured_location: { lat: 1.28, lng: 103.85 }, order_index: 0, checkpoint_status: "pending", arrived_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    route_legs: [],
  };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(
      srv.port, "PATCH",
      `/api/route-plans/${PLAN_ID}/stops/${STOP_ID_1}`,
      { checkpointStatus: "arrived" },
    );
    assert.equal(status, 200);
    assert.equal(body.checkpointStatus, "arrived");
    assert.ok(body.arrivedAt, "arrivedAt should be set");
  } finally { await srv.close(); }
});

test("PATCH stop — skip sets status to skipped", async () => {
  const store: Store = {
    route_plans: [{ id: PLAN_ID, owner_user_id: "user-001", trip_id: null, title: "T", route_style: "custom", status: "draft", is_approximated: true }],
    route_stops: [{ id: STOP_ID_1, route_plan_id: PLAN_ID, title: "S", structured_location: {}, order_index: 0, checkpoint_status: "pending", arrived_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    route_legs: [],
  };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(
      srv.port, "PATCH",
      `/api/route-plans/${PLAN_ID}/stops/${STOP_ID_1}`,
      { checkpointStatus: "skipped" },
    );
    assert.equal(status, 200);
    assert.equal(body.checkpointStatus, "skipped");
  } finally { await srv.close(); }
});

test("DELETE /api/route-plans/:id — owner can delete", async () => {
  const store: Store = {
    route_plans: [{ id: PLAN_ID, owner_user_id: "user-001", trip_id: null, title: "T", route_style: "custom", status: "draft", is_approximated: true }],
    route_stops: [],
    route_legs: [],
  };
  const srv = await startServer(store);
  try {
    const { status } = await req(srv.port, "DELETE", `/api/route-plans/${PLAN_ID}`);
    assert.equal(status, 204);
  } finally { await srv.close(); }
});

test("DELETE /api/route-plans/:id — non-owner gets 403", async () => {
  const store: Store = {
    route_plans: [{ id: PLAN_ID, owner_user_id: "other-user", trip_id: null, title: "T", route_style: "custom", status: "draft", is_approximated: true }],
    route_stops: [],
    route_legs: [],
  };
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "DELETE", `/api/route-plans/${PLAN_ID}`);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
  } finally { await srv.close(); }
});

// ─── ROUTE LIFECYCLE: acceptance and termination ─────────────────────────────
//
// Start Route is the act that means the traveller is actually doing the route,
// and it is authoritative only on the server. Before this lane was wired, the
// accept endpoint had ZERO callers: "Start Route" set a local boolean, no plan
// ever reached status='active', and both Map layers that read only active plans
// (§36 traveler_flow, and the §10 crowd_flow accepted_plan family) were starved.
//
// Termination had no endpoint at all, so an ended walk stayed 'active' and kept
// contributing route-flow intelligence for the whole freshness window after the
// traveller went home. lib/routeHopSignal.ts:118 declares ACCEPTED_PLAN_STATUS
// = 'active' as the ONLY contributing status, so 'completed' stops it.
//
// The vocabulary here is the EXISTING route_plan_status enum
// (draft | active | completed | cancelled) — nothing is invented.

const draftPlan = (owner = "user-001") => ({
  id: PLAN_ID, owner_user_id: owner, trip_id: null, title: "T",
  route_style: "custom", status: "draft", is_approximated: true,
  accepted_at: null, accepted_by_user_id: null,
});
const activePlan = (owner = "user-001", acceptedAt = "2026-09-01T00:00:00.000Z") => ({
  ...draftPlan(owner), status: "active",
  accepted_at: acceptedAt, accepted_by_user_id: owner,
});
const storeWith = (plan: any): Store => ({ route_plans: [plan], route_stops: [], route_legs: [] });

test("a freshly created plan is 'draft' — creating or viewing a route is NOT accepting it", async () => {
  const store = storeWith(draftPlan());
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "GET", `/api/route-plans/${PLAN_ID}`);
    assert.equal(status, 200);
    assert.equal(store.route_plans[0].status, "draft", "a GET must not transition the plan");
    assert.equal(store.route_plans[0].accepted_at, null, "viewing must not stamp acceptance");
    assert.ok(body);
  } finally { await srv.close(); }
});

test("Start Route: accept stamps status='active', accepted_at and accepted_by_user_id", async () => {
  const store = storeWith(draftPlan());
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/accept`);
    assert.equal(status, 200);
    assert.equal(body.status, "active");
    assert.equal(body.alreadyAccepted, false);
    const row = store.route_plans[0];
    assert.equal(row.status, "active", "the DB row itself must transition");
    assert.ok(row.accepted_at, "accepted_at must be stamped server-side");
    assert.equal(row.accepted_by_user_id, "user-001", "and attributed to the accepter");
  } finally { await srv.close(); }
});

test("Start Route by a non-owner is denied and changes nothing", async () => {
  const store = storeWith(draftPlan("someone-else"));
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/accept`);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
    assert.equal(store.route_plans[0].status, "draft", "a refused accept must not transition");
    assert.equal(store.route_plans[0].accepted_at, null);
  } finally { await srv.close(); }
});

test("Start Route is idempotent — a retry reports alreadyAccepted and does not re-stamp", async () => {
  const original = "2026-09-01T00:00:00.000Z";
  const store = storeWith(activePlan("user-001", original));
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/accept`);
    assert.equal(status, 200);
    assert.equal(body.alreadyAccepted, true);
    assert.equal(store.route_plans[0].accepted_at, original,
      "a retry must not rewrite the original acceptance instant");
  } finally { await srv.close(); }
});

test("End Route: complete transitions active -> completed, so the plan stops contributing", async () => {
  const store = storeWith(activePlan());
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/complete`);
    assert.equal(status, 200);
    assert.equal(body.status, "completed");
    assert.equal(body.alreadyCompleted, false);
    const row = store.route_plans[0];
    assert.equal(row.status, "completed");
    assert.notEqual(row.status, "active",
      "routeHopSignal counts ONLY status='active'; leaving it active is what made an " +
      "ended walk keep contributing for the rest of the freshness window");
    assert.ok(row.accepted_at, "the acceptance instant is history and must be preserved");
    assert.equal(row.accepted_by_user_id, "user-001",
      "migration 2224's CHECK requires any non-draft row to keep both acceptance columns");
  } finally { await srv.close(); }
});

test("End Route by a non-owner is denied and leaves the plan active", async () => {
  const store = storeWith(activePlan("someone-else"));
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/complete`);
    assert.equal(status, 403);
    assert.equal(body.error, "forbidden");
    assert.equal(store.route_plans[0].status, "active");
  } finally { await srv.close(); }
});

test("End Route is idempotent — completing a completed plan is a no-op success", async () => {
  const store = storeWith({ ...activePlan(), status: "completed" });
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/complete`);
    assert.equal(status, 200);
    assert.equal(body.alreadyCompleted, true);
    assert.equal(store.route_plans[0].status, "completed");
  } finally { await srv.close(); }
});

test("a draft plan cannot be completed — termination requires acceptance first", async () => {
  const store = storeWith(draftPlan());
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/complete`);
    // 409, per the repo's own mapping in lib/http.ts:97 — not 400.
    assert.equal(status, 409);
    assert.equal(body.error, "invalid_state_transition");
    assert.equal(store.route_plans[0].status, "draft");
  } finally { await srv.close(); }
});

test("a completed plan cannot be re-accepted", async () => {
  const store = storeWith({ ...activePlan(), status: "completed" });
  const srv = await startServer(store);
  try {
    const { status, body } = await req(srv.port, "POST", `/api/route-plans/${PLAN_ID}/accept`);
    assert.equal(status, 409);
    assert.equal(body.error, "invalid_state_transition");
  } finally { await srv.close(); }
});

test("accept and complete are the ONLY writers of active/completed in this router", () => {
  // Source-level, because no fixture can prove absence. If a third writer appears,
  // the invariant routeHopSignal depends on — that status='active' means a human
  // accepted this plan — stops holding.
  const src = readFileSync(new URL("../routes/routePlan.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const actives = src.match(/status:\s*"active"/g) ?? [];
  const completes = src.match(/status:\s*"completed"/g) ?? [];
  assert.equal(actives.length, 1, "exactly one writer of status='active' (the accept handler)");
  assert.equal(completes.length, 1, "exactly one writer of status='completed' (the complete handler)");
});
