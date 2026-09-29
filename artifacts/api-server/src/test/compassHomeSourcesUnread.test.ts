/**
 * census-discovery §106 (DV-83 round 10, lane W11-X2, register D-W11X2-67): GET /compass/home never
 * says "ok" over a read that failed, and never caches a home built over one.
 *
 * The round-9 verifier found three sections of the home claiming "ok" over failed reads (§106.1 BK1):
 *   - circle activity: `getWhosAround` swallowed its read errors, so a failed presence read was
 *     `people: []`, i.e. `sourced(null)` — "nobody is around", the answer the route's own comment
 *     calls the single most misleading thing it can say;
 *   - best next move: a best move picked from a PARTIAL candidate pool (one source failed) was
 *     "ok" and not degraded, so the payload was cached for 45 s and replayed after recovery;
 *   - weather: `getWeatherContext` answered null on a provider failure, and the section said "ok".
 *
 *   H0   CONTROL (V9-H0): healthy reads → every source ok, not degraded, a best move
 *   HC1  (V9-HC1) the viewer's presence-context reads fail → circleActivity unavailable
 *   HC2  a context's member read fails → circleActivity unavailable
 *   HC3  the consent gate cannot read the viewer's membership → circleActivity unavailable
 *   HC4  CONTROL: a readable context with nobody sharing → circleActivity ok (null)
 *   HB1  (V9-HB1) one candidate source fails, others serve → bestNextMove unavailable, rows kept
 *   HB2  (V9-HB2) ... and the partial home is not cached: the next call rebuilds
 *   HB3  CONTROL: a healthy home IS cached (the second call makes no reads)
 *   HW1  (V9-HW1) the forecast provider fails (503) → weatherWindow unavailable
 *   HW2  the geocoder fails (503) → weatherWindow unavailable
 *   HW3  CONTROL: the geocoder answers "no such place" → weatherWindow ok (null)
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassHomeRouter, { _clearCompassHomeCache } from "../routes/compassHome.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { compassWorld, eqValue, TOKEN, VIEWER, DB_ERR, CANDIDATE_SOURCES, type WorldOpts } from "./helpers/compassReadWorld.js";

const TRIP = "a1000000-0000-4000-a000-000000000001";
const FRIEND = "a2000000-0000-4000-a000-000000000002";

let base = "";
let server: Server;
const realFetch = globalThis.fetch;
let provider: "ok" | "forecast_down" | "geocode_down" | "geocode_empty" = "ok";
let world = compassWorld();
function serve(opts: WorldOpts = {}) { world = compassWorld(opts); _setTestClient(world.client as any, true); }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassHomeRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
  // External providers (geocode, Open-Meteo).
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const geo = url.includes("geocod");
    if (geo && provider === "geocode_down") return new Response("upstream down", { status: 503 });
    if (geo && provider === "geocode_empty") return new Response(JSON.stringify({ results: [] }), { status: 200 });
    if (geo) return new Response(JSON.stringify({ results: [{ latitude: 48.85, longitude: 2.35 }] }), { status: 200 });
    if (provider === "forecast_down") return new Response("upstream down", { status: 503 });
    const d = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    return new Response(JSON.stringify({ daily: { time: [d], weathercode: [1], temperature_2m_max: [20], temperature_2m_min: [10], precipitation_sum: [0] } }), { status: 200 });
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; server.close(); });
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); _clearCompassHomeCache(); clearCompassProfileCache(); provider = "ok"; });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await realFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}
// A different tz offset per call keeps the home cache out of the way; a different city per
// weather case keeps the weather layer's in-memory cache out of it.
let n = 0;
const homePath = () => `/compass/home?tzOffsetMinutes=${(n++ % 40) * 15}`;

/** A viewer on one active trip with one other accepted member (FRIEND). */
function tripWorld(fail: { contextMembers?: boolean; gateMembership?: boolean } = {}): WorldOpts["answer"] {
  return (table, calls) => {
    if (table === "trip_members") {
      const byTrip = eqValue(calls, "trip_id"), byUser = eqValue(calls, "user_id");
      if (byTrip && byUser) return fail.gateMembership ? { data: null, error: DB_ERR } : { data: { role: "owner", status: "accepted" }, error: null };
      if (byTrip) return fail.contextMembers ? { data: null, error: DB_ERR } : { data: [{ user_id: VIEWER, role: "owner", status: "accepted" }, { user_id: FRIEND, role: "member", status: "accepted" }], error: null };
      if (byUser === VIEWER) return { data: [{ trip_id: TRIP, role: "owner", status: "accepted" }], error: null };
    }
    if (table === "trips" && calls.some(([k, a]) => k === "in" && a[0] === "status")) return { data: [{ id: TRIP, title: "Paris trip", destination_city: "Paris", status: "active" }], error: null };
    return undefined;
  };
}

describe("census-discovery §106 (DV-83, D-W11X2-67): GET /compass/home's presence, best move and weather", () => {
  it("H0 (V9-H0) CONTROL: healthy reads → every source ok, not degraded, a best move", async () => {
    serve();
    const { body } = await get(homePath());
    assert.equal(body.compassEnabled, true);
    assert.equal(body.degraded, false, JSON.stringify(body.sources));
    assert.ok(body.bestNextMove, "the control has a best move");
    for (const k of ["bestNextMove", "circleActivity", "startingSoon", "tonightVibe", "weatherWindow"]) assert.equal(body.sources[k], "ok", k);
    assert.equal(body.refusal, undefined);
  });

  it("HC1 (V9-HC1) the viewer's presence-context reads fail → circleActivity unavailable, never 'nobody is around'", async () => {
    serve({ failTables: ["trip_members", "event_rsvps"] });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "unavailable", JSON.stringify(body.sources));
    assert.equal(body.circleActivity, null);
    assert.equal(body.degraded, true);
  });

  it("HC2 a context's member read fails → circleActivity unavailable", async () => {
    serve({ answer: tripWorld({ contextMembers: true }) });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "unavailable", JSON.stringify(body.sources));
    assert.equal(body.degraded, true);
  });

  it("HC3 the consent gate cannot read the viewer's membership → circleActivity unavailable", async () => {
    serve({ answer: tripWorld({ gateMembership: true }) });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "unavailable", JSON.stringify(body.sources));
  });

  it("HC4 CONTROL: a readable context with nobody sharing → circleActivity ok (null)", async () => {
    serve({ answer: tripWorld() });
    const { body } = await get(homePath());
    assert.equal(body.sources.circleActivity, "ok", JSON.stringify(body.sources));
    assert.equal(body.circleActivity, null);
  });

  it("HB1 (V9-HB1) one candidate source fails, others serve → bestNextMove unavailable, its row kept", async () => {
    serve({ failTables: ["posts"] });
    const { body } = await get(homePath());
    assert.ok(body.bestNextMove, "the rows that were read are kept");
    assert.equal(body.sources.bestNextMove, "unavailable", JSON.stringify(body.sources));
    assert.equal(body.degraded, true);
  });

  it("HB1b every candidate source fails → bestNextMove unavailable and null", async () => {
    serve({ failTables: CANDIDATE_SOURCES });
    const { body } = await get(homePath());
    assert.equal(body.bestNextMove, null);
    assert.equal(body.sources.bestNextMove, "unavailable");
  });

  it("HB2 (V9-HB2) the partial home is not cached: after the source recovers the next call rebuilds", async () => {
    serve({ failTables: ["posts"] });
    await get("/compass/home?tzOffsetMinutes=0");
    serve();
    await get("/compass/home?tzOffsetMinutes=0");
    assert.ok(world.readsSeen.includes("posts"), "the home built over a failed posts read was cached and replayed");
  });

  it("HB3 CONTROL: a healthy home IS cached (the second call makes no candidate read)", async () => {
    serve();
    await get("/compass/home?tzOffsetMinutes=15");
    serve();
    await get("/compass/home?tzOffsetMinutes=15");
    assert.ok(!world.readsSeen.includes("posts"), `a healthy home was rebuilt: ${world.readsSeen.join(",")}`);
  });

  it("HW1 (V9-HW1) the forecast provider fails (503) → weatherWindow unavailable", async () => {
    provider = "forecast_down";
    serve({ city: "Porto" });
    const { body } = await get(homePath());
    assert.equal(body.sources.weatherWindow, "unavailable", JSON.stringify(body.sources));
    assert.equal(body.weatherWindow, null);
    assert.equal(body.degraded, true);
  });

  it("HW2 the geocoder fails (503) → weatherWindow unavailable", async () => {
    provider = "geocode_down";
    serve({ city: "Braga" });
    const { body } = await get(homePath());
    assert.equal(body.sources.weatherWindow, "unavailable", JSON.stringify(body.sources));
  });

  it("HW3 CONTROL: the geocoder answers 'no such place' → weatherWindow ok (null)", async () => {
    provider = "geocode_empty";
    serve({ city: "Nowhereville" });
    const { body } = await get(homePath());
    assert.equal(body.sources.weatherWindow, "ok", JSON.stringify(body.sources));
    assert.equal(body.weatherWindow, null);
  });
});
