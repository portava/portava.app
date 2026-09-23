/**
 * The layover PLAN STOPS route family — per-pin feasibility, and the scope of
 * every write it makes.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * Two census rows, both about `routes/airport.ts` and neither about arithmetic.
 *
 * census-layover **L17** ("Map visualises the certified envelope /
 * recommendations / routes") and **L115** ("Map consumes the active snapshot
 * and envelope geometry") both read, at their last verdict, that the map
 * "visualises nothing the requirement names: no envelope, no route, no PER-PIN
 * FEASIBILITY". Half of that is stale — `GET /:id/overview` has published
 * `safeEnvelope` (a centre and a radius: geometry) since census L63. The half
 * that was true is the per-pin one: the traveller's OWN plan stops came back
 * with a title, a duration and a coordinate and NO statement about whether the
 * certified window reaches them. `generateRecommendations` has banded its
 * candidates against that same disc for several passes
 * (`services/airport/LayoverRecommendationService.ts:577`); the plan a
 * traveller actually built was the one surface that never asked.
 *
 * census-layover **L205** ("Service-role processing should be narrow and
 * auditable") is the other. Every layover route runs on `getServiceClient()`,
 * which bypasses RLS, so the ONLY thing standing between a plan-stop write and
 * another traveller's row is the filter the handler writes by hand. One write
 * in this family did not carry one: the stop-order compaction pass after
 * `DELETE /stops/:stopId` filtered on `id` alone.
 *
 * ── WHAT COULD HAVE MADE THIS SUITE PASS WITHOUT THE PROPERTY ────────────────
 *  * A crash. Every case asserts a status code AND a body shape, and `req.log`
 *    is installed so a handler throw cannot masquerade as a 500 this suite
 *    would read as a refusal.
 *  * A route that bands everything BLOCKED. Every blocked pin is paired with a
 *    positive control on the same fixture and the same window.
 *  * A route that bands everything by distance alone. The airside and
 *    no-coordinate cases assert an explicit UNBANDED reason and a NULL
 *    distance — an invented zero is the defect census L47 was opened for.
 *  * The write-scope case passing because the fake silently ignores filters.
 *    It reads the FILTERS the handler issued, out of a recording double, and
 *    separately asserts that a control write in the same family carries the
 *    same scope — so "no write happened at all" cannot pass it.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverRoutePlanStops.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  AIRSIDE_UNBANDED_REASON,
  NO_POSITION_UNBANDED_REASON,
} from "../services/airport/layoverRankingFeasibility.js";

const TOKEN = "plan-stops-token";
const USER = "plan-stops-user";
const SESSION = "session-plan-stops";
const HOUR = 3_600_000;

let server: http.Server;
let base = "";
let tables: Record<string, any[]>;
/** Every filter the handlers issued, in order, table by table. */
let issued: Array<{ table: string; op: string; eqs: Array<[string, unknown]> }>;

// ── the recording double ─────────────────────────────────────────────────────
/**
 * `makeLayoverDb` with every builder call observed.
 *
 * It CHANGES NOTHING about the answers — the inner double settles every query —
 * so a case that reads `issued` and a case that reads the table state are
 * looking at the same run. The proxy returns itself wherever the inner builder
 * returned itself, which is what keeps the chain chainable.
 */
function recordingDb(seed: Record<string, any[]>, users: Record<string, string>) {
  const inner: any = makeLayoverDb(seed, { users });
  return {
    ...inner,
    from(table: string) {
      const target = inner.from(table);
      const rec = { table, op: "select", eqs: [] as Array<[string, unknown]> };
      let recorded = false;
      const proxy: any = new Proxy(target, {
        get(t: any, prop: string | symbol) {
          const value = t[prop];
          if (typeof value !== "function") return value;
          return (...args: any[]) => {
            if (prop === "eq") rec.eqs.push([args[0], args[1]]);
            if (prop === "update" || prop === "insert" || prop === "upsert" || prop === "delete") {
              rec.op = String(prop);
              if (!recorded) { issued.push(rec); recorded = true; }
            }
            const out = value.apply(t, args);
            return out === t ? proxy : out;
          };
        },
      });
      return proxy;
    },
  } as any;
}

/** The writes this family made against `layover_plan_stops`. */
const stopWrites = () => issued.filter((w) => w.table === "layover_plan_stops");

function stopRow(over: Record<string, unknown> = {}) {
  return {
    id: "stop-a", session_id: SESSION, title: "A stop", description: null,
    stop_order: 0, duration_min: 45, travel_min: 20,
    place_id: null, recommendation_id: null, lat: null, lng: null,
    location_label: null, inside_airport: false, source: "user",
    created_at: new Date(Date.now() - 60_000).toISOString(),
    updated_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

/** A long layover at a curated airport: the window reaches the city. */
function stage(stops: Array<Record<string, unknown>> = []) {
  const now = Date.now();
  issued = [];
  tables = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
    ],
    airport_profiles: [airportRow({ verified: true })],
    layover_sessions: [
      sessionRow({
        id: SESSION, user_id: USER, status: "active",
        arrival_time: new Date(now - 5 * 60_000).toISOString(),
        departure_time: new Date(now + 12 * HOUR).toISOString(),
        flight_type: "international", immigration_required: false,
      }),
    ],
    layover_plan_stops: stops,
    layover_recommendations: [],
    layover_events: [],
    trip_plan_items: [], trips: [], trip_members: [],
  };
  _setTestClient(recordingDb(tables, { [TOKEN]: USER }), true);
  return tables;
}

function send(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const raw = body === undefined ? "" : JSON.stringify(body);
    const req = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(raw),
        },
      },
      (res) => {
        let acc = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { acc += c; });
        res.on("end", () => {
          let parsed: any; try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (raw) req.write(raw);
    req.end();
  });
}

const getStops = () => send("GET", `/api/airport/sessions/${SESSION}/stops`);
const overview = () => send("GET", `/api/airport/sessions/${SESSION}/overview`);

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => { server?.close(); _setTestClient(null as any, false); });

beforeEach(() => { issued = []; });

// ─────────────────────────────────────────────────────────────────────────────
// census L17 / L115 / L270 — per-pin feasibility
// ─────────────────────────────────────────────────────────────────────────────

describe("census L17 / L115 — the plan a traveller built is banded against the certified envelope", () => {
  it("a stop near the airport is inside the envelope and carries its measured distance", async () => {
    // ~5 km north of TPE (25.0797, 121.2342). Well inside a 12-hour window.
    stage([stopRow({ id: "stop-near", lat: 25.1247, lng: 121.2342, inside_airport: false })]);
    const r = await getStops();
    assert.equal(r.status, 200);
    const stop = r.body.stops.find((s: any) => s.id === "stop-near");
    assert.ok(stop, "the stop should be served");
    assert.ok(stop.envelope, "every stop must carry an envelope verdict");
    assert.equal(stop.envelope.certified, true, "a bound was computed for this pin");
    assert.notEqual(stop.envelope.band, "BLOCKED", "a 5 km stop in a 12h window is not blocked");
    assert.equal(typeof stop.envelope.distanceMetres, "number");
    assert.ok(stop.envelope.distanceMetres > 0, "a measured distance, not a placeholder");
  });

  it("a stop beyond the certified reach is BLOCKED and the refusal says why", async () => {
    // ~9 degrees of latitude north — a thousand kilometres away.
    stage([stopRow({ id: "stop-far", lat: 34.0797, lng: 121.2342, inside_airport: false })]);
    const r = await getStops();
    assert.equal(r.status, 200);
    const stop = r.body.stops.find((s: any) => s.id === "stop-far");
    assert.equal(stop.envelope.band, "BLOCKED");
    assert.equal(stop.envelope.certified, true);
    assert.equal(stop.envelope.impliesFit, false, "a BLOCKED band never certifies a fit");
    assert.ok(
      typeof stop.envelope.reason === "string" && stop.envelope.reason.length > 0,
      "a block is a refusal and refusals are explained",
    );
    assert.ok(
      stop.envelope.roundTripLowerBoundMin > 0,
      "the bound that produced the block travels with it",
    );
  });

  it("an AIRSIDE stop is unbanded with a named reason and no invented distance", async () => {
    stage([stopRow({ id: "stop-airside", inside_airport: true, travel_min: 0, lat: null, lng: null })]);
    const r = await getStops();
    const stop = r.body.stops.find((s: any) => s.id === "stop-airside");
    assert.equal(stop.envelope.certified, false, "there is no landside journey to certify");
    assert.equal(stop.envelope.reason, AIRSIDE_UNBANDED_REASON);
    assert.equal(stop.envelope.lowerBoundOneWayMin, null);
    assert.equal(stop.envelope.distanceMetres, null, "no distance is a null, never a zero");
  });

  it("a landside stop with NO coordinate is unbanded — absence is not admission", async () => {
    stage([stopRow({ id: "stop-nowhere", inside_airport: false, lat: null, lng: null })]);
    const r = await getStops();
    const stop = r.body.stops.find((s: any) => s.id === "stop-nowhere");
    assert.equal(stop.envelope.certified, false, "an unplaced stop is not an admitted stop");
    assert.equal(stop.envelope.reason, NO_POSITION_UNBANDED_REASON);
    assert.equal(stop.envelope.distanceMetres, null);
  });

  it("the dashboard bands the same pins against the envelope it publishes beside them", async () => {
    stage([
      stopRow({ id: "stop-near", lat: 25.1247, lng: 121.2342 }),
      stopRow({ id: "stop-far", lat: 34.0797, lng: 121.2342, stop_order: 1 }),
    ]);
    const r = await overview();
    assert.equal(r.status, 200);
    assert.ok(r.body.safeEnvelope, "the disc is published");
    assert.equal(typeof r.body.safeEnvelope.radiusMetres, "number");
    const byId = new Map(r.body.stops.map((s: any) => [s.id, s]));
    const near: any = byId.get("stop-near");
    const far: any = byId.get("stop-far");
    assert.notEqual(near.envelope.band, "BLOCKED");
    assert.equal(far.envelope.band, "BLOCKED");
    // The pin and the disc are cut from ONE certification: a pin the disc
    // cannot reach must be outside the radius the same response published.
    assert.ok(
      far.envelope.distanceMetres > r.body.safeEnvelope.radiusMetres,
      "a blocked pin lies outside the radius drawn on the same screen",
    );
  });

  it("an empty plan is still an empty plan — banding invents no stops", async () => {
    stage([]);
    const r = await getStops();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.stops, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// census L205 / L200 — the scope of a service-role write
// ─────────────────────────────────────────────────────────────────────────────

describe("census L205 — every layover_plan_stops write names the session it belongs to", () => {
  it("the stop-order compaction after a delete is scoped to the owned session", async () => {
    stage([
      stopRow({ id: "stop-a", stop_order: 0 }),
      stopRow({ id: "stop-b", stop_order: 1 }),
    ]);
    const r = await send("DELETE", `/api/airport/sessions/${SESSION}/stops/stop-a`);
    assert.equal(r.status, 200, "the delete succeeds — this is not a refusal test");
    assert.deepEqual(r.body.stops.map((s: any) => s.id), ["stop-b"]);

    const updates = stopWrites().filter((w) => w.op === "update");
    assert.ok(updates.length > 0, "the compaction pass must actually have run");
    for (const u of updates) {
      const cols = u.eqs.map(([c]) => c);
      assert.ok(
        cols.includes("session_id"),
        `a layover_plan_stops UPDATE filtered on ${JSON.stringify(cols)} — the service role bypasses RLS, ` +
          "so a write that does not name the session is bounded by nothing",
      );
    }
  });

  it("the control: the reorder route's writes carry the same scope", async () => {
    stage([
      stopRow({ id: "stop-a", stop_order: 0 }),
      stopRow({ id: "stop-b", stop_order: 1 }),
    ]);
    const r = await send("POST", `/api/airport/sessions/${SESSION}/stops/reorder`, {
      orderedIds: ["stop-b", "stop-a"],
    });
    assert.equal(r.status, 200);
    const updates = stopWrites().filter((w) => w.op === "update");
    assert.ok(updates.length > 0);
    for (const u of updates) {
      assert.ok(u.eqs.map(([c]) => c).includes("session_id"));
    }
  });

  it("the targeted stop edit is scoped too", async () => {
    stage([stopRow({ id: "stop-a", stop_order: 0 })]);
    const r = await send("PATCH", `/api/airport/sessions/${SESSION}/stops/stop-a`, { durationMin: 60 });
    assert.equal(r.status, 200);
    const updates = stopWrites().filter((w) => w.op === "update");
    assert.ok(updates.length > 0);
    for (const u of updates) {
      assert.ok(u.eqs.map(([c]) => c).includes("session_id"));
    }
  });
});
