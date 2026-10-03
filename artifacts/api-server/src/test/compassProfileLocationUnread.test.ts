/**
 * census-discovery §107 sweep (DV-83 round 10, lane W11-X2, register D-W11X2-73): a failed read of
 * the viewer's location is never "this viewer has no city".
 *
 * `buildProfile` read `user_location_state` inside a `Promise.allSettled` and kept `data` alone, so a
 * failed read left `currentCity: null` — the same value as a viewer who never shared a city — and
 * `getCompassProfile` cached that profile. Every city-scoped Compass candidate source (buddies,
 * places, hidden gems, the home's events and forecast) then answered "nothing here" as complete:
 * GET /compass/home said "ok" over an empty best move and forecast, and GET /compass/telegraph drew
 * cards for no city.
 *
 *   PL1  the location read fails → the home's best move, events and forecast are unavailable, degraded
 *   PL2  ... and the profile is not cached: after the read recovers the next home re-reads it
 *   PL3  the location read fails, no trip city → Telegraph refuses, naming user_location_state
 *   PLc  CONTROL: no location row (read, none shared) → the home's forecast is ok (null), not degraded by it
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import compassHomeRouter, { _clearCompassHomeCache } from "../routes/compassHome.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { compassWorld, TOKEN, THREAD, type WorldOpts } from "./helpers/compassReadWorld.js";

let base = "";
let server: Server;
let world = compassWorld();
function serve(opts: WorldOpts = {}) { world = compassWorld(opts); _setTestClient(world.client as any, true); }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassHomeRouter);
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); _clearCompassHomeCache(); clearCompassProfileCache(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}
let n = 0;
const homePath = () => `/compass/home?tzOffsetMinutes=${(n++ % 40) * 15}`;

describe("census-discovery §107 sweep (DV-83, D-W11X2-73): a failed location read is not 'no city'", () => {
  it("PL1 the location read fails → best move, events and forecast unavailable, degraded", async () => {
    serve({ failTables: ["user_location_state"] });
    const { body } = await get(homePath());
    assert.equal(body.city, null);
    assert.equal(body.sources.bestNextMove, "unavailable", JSON.stringify(body.sources));
    assert.equal(body.sources.startingSoon, "unavailable");
    assert.equal(body.sources.weatherWindow, "unavailable");
    assert.equal(body.degraded, true);
  });

  it("PL2 ... and the profile is not cached: after the read recovers the next home re-reads the location", async () => {
    serve({ failTables: ["user_location_state"] });
    await get("/compass/home?tzOffsetMinutes=0");
    serve();
    const { body } = await get("/compass/home?tzOffsetMinutes=0");
    assert.ok(world.readsSeen.includes("user_location_state"), "the profile built over a failed location read was cached");
    assert.equal(body.city, "Paris");
  });

  it("PL3 the location read fails, no trip city → Telegraph refuses, naming user_location_state", async () => {
    serve({ failTables: ["user_location_state"] });
    const r = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(r.status, 200);
    assert.ok(r.body.refusal, JSON.stringify(r.body));
    assert.ok(r.body.refusal.failedSources.includes("user_location_state"), JSON.stringify(r.body.refusal));
  });

  it("PLc CONTROL: no location row (read, none shared) → the forecast is ok (null), and no source is failed for it", async () => {
    serve({ city: null });
    const { body } = await get(homePath());
    assert.equal(body.city, null);
    assert.equal(body.sources.weatherWindow, "ok", JSON.stringify(body.sources));
    assert.equal(body.sources.startingSoon, "ok");
  });
});
