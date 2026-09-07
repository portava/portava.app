/**
 * layoverRouteFailureSemantics.test.ts
 *
 * The first ROUTE-LEVEL tests for the airport/Layover surface.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE HAD TO EXIST
 * ══════════════════════════════════════════════════════════════════════════════
 * `src/routes/airport.ts` registers 35 endpoints and had NO route-level tests.
 * `airport.test.ts` is pure-unit: it calls `assess`, `computeWindow` and
 * `adviseLeaving` with candidates it builds itself. That is why a category
 * constant standing in for measured travel time survived a green suite for
 * months — every test fed the arithmetic a plausible number, and none of them
 * asked where the number came from.
 *
 * It is also why three mutations survived the first matrix on this branch:
 * "the consequential endpoints answer anyway", "the trip mirror writes from an
 * unread airport" and "a thrown transport error degrades to the fallback" are
 * all statements about a HANDLER, and nothing exercised a handler.
 *
 * Layover is the one Portava surface that is LIVE in production (all five flags
 * seeded TRUE in 0127_layover_system.sql:225-229), so this is the surface where
 * missing route coverage costs the most.
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT IT PINS
 * ══════════════════════════════════════════════════════════════════════════════
 * The airport profile carries the RETURN BUFFERS — 60/90/120/180/30/15/20 in the
 * generic fallback. Those numbers are the safety arithmetic: `computeWindow`
 * subtracts them to produce `usableMinutes` and `hardReturnTime`, and
 * `adviseLeaving` turns that into "can I leave the airport?". A failed read used
 * to swap a curated airport's buffers for generic ones and keep answering.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

const USER = "aaaaaaaa-1111-4111-8111-000000000001";
const TOKEN = "tok-layover";
const SESSION = "bbbbbbbb-1111-4111-8111-000000000002";
const AIRPORT = "cccccccc-1111-4111-8111-000000000003";

const iso = (mins: number) => new Date(Date.now() + mins * 60_000).toISOString();

/** A curated airport whose buffers differ sharply from the generic fallback. */
const CURATED = {
  id: AIRPORT, iata_code: "TPE", name: "Taoyuan", city: "Taoyuan", country: "Taiwan",
  country_code: "TW", timezone: "Asia/Taipei", lat: 25.077, lng: 121.233,
  domestic_buffer_min: 240, domestic_buffer_max: 300,
  international_buffer_min: 240, international_buffer_max: 300,
  immigration_extra_min: 90, checked_bags_extra_min: 45, traffic_extra_min: 70,
  verified: true,
};

const SESSION_ROW = {
  id: SESSION, user_id: USER, airport_id: AIRPORT, trip_id: null,
  arrival_time: iso(-60), departure_time: iso(600), boarding_time: null,
  flight_type: "international", immigration_required: false, checked_bags: false,
  lounge_access: false, wants_to_leave: true, comfort_level: "moderate",
  vibe_chips: [], manual_airport_name: null, manual_city: "Taoyuan",
  manual_country: "Taiwan", manual_iata: "TPE", canonical_city_id: null,
  share_city_status: false, return_reminder_at: null, status: "active",
  created_at: iso(-60), updated_at: iso(-60), layover_minutes: 660,
};

const FLAGS = [
  "airport_mode_enabled", "layover_safety_engine_enabled",
  "layover_plans_enabled", "layover_compass_enabled", "airport_pulse_enabled",
];

interface Cfg { airportError?: boolean; sessionError?: boolean; airportRows?: any[] }

function makeClient(cfg: Cfg = {}) {
  const tables: Record<string, any[]> = {
    layover_sessions: [SESSION_ROW],
    airport_profiles: cfg.airportRows ?? [CURATED],
    layover_recommendations: [],
    layover_plan_stops: [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [{ id: USER, handle: "t", name: "T" }],
  };
  function from(table: string) {
    const eqs: Array<[string, any]> = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    const failing =
      (table === "airport_profiles" && cfg.airportError) ||
      (table === "layover_sessions" && cfg.sessionError);
    const rows = () =>
      (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v));
    const answer = () =>
      failing ? { data: null, error: { message: "permission denied" } } : { data: rows(), error: null };
    const b: any = {
      select: () => b, eq: (c: string, v: any) => { eqs.push([c, v]); return b; },
      in: () => b, is: () => b, gt: () => b, gte: () => b, lt: () => b, lte: () => b,
      neq: () => b, ilike: () => b, order: () => b, limit: () => b, contains: () => b,
      not: () => b, or: () => b,
      insert: (p: any) => { op = "insert"; payload = p; (tables[table] ??= []).push(...(Array.isArray(p) ? p : [p])); return b; },
      upsert: (p: any) => { op = "insert"; payload = p; (tables[table] ??= []).push(...(Array.isArray(p) ? p : [p])); return b; },
      update: (p: any) => {
        op = "update"; payload = p;
        // updateSession does .update(patch)...select("*").maybeSingle() and
        // treats a null row as "not found", so the fake must hand back the
        // patched row or the PATCH route 404s before it ever reaches the mirror.
        for (const r of tables[table] ?? []) Object.assign(r, p);
        return b;
      },
      delete: () => { op = "delete"; return b; },
      maybeSingle: async () => {
        const a = answer();
        if (a.error) return { data: null, error: a.error };
        if (op === "update") return { data: (tables[table] ?? [])[0] ?? null, error: null };
        return { data: (a.data as any[])[0] ?? null, error: null };
      },
      single: async () => {
        const a = answer();
        return a.error ? { data: null, error: a.error } : { data: (a.data as any[])[0] ?? null, error: null };
      },
      then: (res: any, rej?: any) => {
        if (op !== "select") return Promise.resolve({ data: payload, error: null }).then(res, rej);
        return Promise.resolve(answer()).then(res, rej);
      },
    };
    return b;
  }
  return {
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: USER, email: "t@test" } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    from(table: string) {
      if (table === "feature_flags") {
        const b: any = {
          select: () => b,
          eq: (_c: string, v: any) => { (b as any)._flag = v; return b; },
          maybeSingle: async () => ({ data: { enabled: FLAGS.includes((b as any)._flag) }, error: null }),
          then: (r: any) => Promise.resolve({ data: [], error: null }).then(r),
        };
        return b;
      }
      return from(table);
    },
    storage: { from: () => ({ remove: async () => ({ data: null, error: null }) }) },
    _tables: tables,
  };
}

let server: Server;
let port: number;
beforeEach(async () => {
  await new Promise<void>((r) => {
    server = createServer(app);
    server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; r(); });
  });
});
afterEach(async () => {
  _setTestClient(null, false);
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

async function get(path: string) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

async function patch(path: string, body: any) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}

// ══ THE TRIP TIMELINE MIRROR ══════════════════════════════════════════════════

describe("Layover routes — the trip mirror never writes from an unread airport", () => {
  it("PATCH does not leave a plan item behind when the airport read fails", async () => {
    // The last surviving mutation on this branch, and it lives at the CALL SITE:
    // the mirror's own guard was in place, but the caller could still hand it a
    // fabricated success. Nothing exercised PATCH, so nothing noticed.
    const client = makeClient({ airportError: true }) as any;
    client._tables.layover_sessions[0].trip_id = "trip-1";
    client._tables.trip_members = [{ trip_id: "trip-1", user_id: USER, status: "accepted", role: "owner" }];
    _setTestClient(client, true);

    await patch(`/api/airport/sessions/${SESSION}`, { wantsToLeave: true });

    assert.deepEqual(client._tables.trip_plan_items ?? [], [],
      "a failed airport read must not title a trip plan item from 'stopover city'");
  });

  it("PATCH still mirrors when the airport reads cleanly", async () => {
    // The control. Without it, refusing everything would also pass.
    const client = makeClient() as any;
    client._tables.layover_sessions[0].trip_id = "trip-1";
    client._tables.trip_members = [{ trip_id: "trip-1", user_id: USER, status: "accepted", role: "owner" }];
    _setTestClient(client, true);

    await patch(`/api/airport/sessions/${SESSION}`, { wantsToLeave: true });

    assert.ok((client._tables.trip_plan_items ?? []).length > 0,
      "a clean read must still produce the timeline row");
  });
});

// ══ THE SAFETY VERDICT ════════════════════════════════════════════════════════

describe("Layover routes — an unreadable airport never becomes a generic one", () => {
  it("serves a verdict from the CURATED buffers when the airport reads", async () => {
    _setTestClient(makeClient() as any, true);
    const r = await get(`/api/airport/sessions/${SESSION}/safety`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.featureEnabled, true);
    assert.equal(r.json.breakdown.baseBuffer, 240,
      "the airport's own international buffer, not the generic 120");
    assert.equal(r.json.breakdown.trafficExtra, 70);
  });

  it("REFUSES the verdict when the airport read fails", async () => {
    // The mutation that survived the first matrix. Before this, the handler fell
    // through to the generic fallback and answered with 120/30/20 — a safety
    // verdict computed from an airport nobody read.
    _setTestClient(makeClient({ airportError: true }) as any, true);
    const r = await get(`/api/airport/sessions/${SESSION}/safety`);
    // A DELIBERATE refusal, not merely "not a 200". An earlier version of this
    // test asserted `status >= 400`, which a 500 crash also satisfies — so
    // deleting the guard entirely still passed. The code is the assertion.
    assert.equal(r.json?.error, "degraded_unavailable", JSON.stringify(r.json));
    assert.notEqual(r.json?.breakdown?.baseBuffer, 120,
      "a failed read must not produce a generic-buffer verdict");
  });

  it("refuses on /overview too — the same buffers reach the same advice", async () => {
    _setTestClient(makeClient({ airportError: true }) as any, true);
    const r = await get(`/api/airport/sessions/${SESSION}/overview`);
    assert.equal(r.json?.error, "degraded_unavailable", JSON.stringify(r.json));
  });

  it("refuses on /recommendations, which had its own copy of the resolver", async () => {
    // That endpoint inlined a verbatim copy of resolveAirportForSession,
    // including the dropped error. One definition now.
    _setTestClient(makeClient({ airportError: true }) as any, true);
    const r = await get(`/api/airport/sessions/${SESSION}/recommendations`);
    assert.equal(r.json?.error, "degraded_unavailable", JSON.stringify(r.json));
  });

  it("a session with NO airport row still answers — that is the honest fallback", async () => {
    // A successful empty read is a real state: a manually-entered airport has no
    // profile, and generic buffers are the best available answer. The fix must
    // stop FAILURE arriving here, not this.
    _setTestClient(makeClient({ airportRows: [] }) as any, true);
    const r = await get(`/api/airport/sessions/${SESSION}/safety`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.breakdown.baseBuffer, 120, "the generic international buffer");
  });
});
