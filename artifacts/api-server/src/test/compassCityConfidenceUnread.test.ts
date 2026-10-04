/**
 * census-discovery §107 (DV-83 round 10, lane W11-X2, register D-W11X2-70): GET
 * /compass/city-confidence never presents a failed read as a measured "thin".
 *
 * §107.1 BK4: `getCityConfidence` read `compass_city_confidence` with `{ data }` alone, and when
 * the platform coverage read failed too it answered null; the route turned null into
 * `tier: "thin"`, `depthScore: 0`, "Limited local data for X" — the bytes of a city with no rows.
 * The client caches that answer in memory and in AsyncStorage and draws the thin badge and its note
 * on the destination screen. D-W11X2-59 called the null "the documented neutral default"; for this
 * route it is a measurement that was never taken.
 *
 *   CC0  CONTROL: both reads answer, no rows → exactly the old "thin" bytes
 *   CC1  (V9-CC1) both reads fail → 503 degraded_unavailable / city_confidence_unreadable
 *   CC2  the Compass read fails, the platform read answers with no rows → 503 (nothing was measured)
 *   CC3  the Compass read answers with no row, the platform read fails → 503 (the platform may cover it)
 *   CC4  CONTROL: a Compass row, the platform read fails → the Compass row, labelled platform_unreadable
 *   CC5  CONTROL: the Compass read fails, the platform read has coverage → the platform's answer
 *   CC6  the Compass read THROWS and the platform has no rows → 503
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassGraphRouter from "../routes/compassGraph.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { compassWorld, TOKEN, DB_ERR, type WorldOpts } from "./helpers/compassReadWorld.js";

let base = "";
let server: Server;
function serve(opts: WorldOpts = {}) { _setTestClient(compassWorld(opts).client as any, true); }

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassGraphRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { _resetRateLimit(); });

async function get(): Promise<{ status: number; text: string; body: any }> {
  const r = await fetch(`${base}/compass/city-confidence?city=Lyon`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const LOCAL_ROW = { city: "lyon", depth_score: 72, tier: "deep", signals: { posts: 40 }, computed_at: "2026-09-28T00:00:00.000Z" };
const COVERAGE = [0, 1, 2].map((i) => ({ city: "lyon", zone_id: `z${i}`, claim_family: "places", coverage_state: "covered", current_confidence: 0.9, score: 1, computed_at: "2026-09-28T01:00:00.000Z", expires_at: future() }));
const THIN_BYTES = '{"city":"Lyon","depthScore":0,"tier":"thin","note":"Limited local data for Lyon — be upfront that suggestions there are less certain.","computedAt":null}';

function assertUnreadable(r: { status: number; body: any; text: string }) {
  assert.equal(r.status, 503, r.text);
  assert.equal(r.body.error, "degraded_unavailable");
  assert.equal(r.body.reason, "city_confidence_unreadable");
  assert.equal(r.body.tier, undefined, "no tier is claimed over a failed read");
}

describe("census-discovery §107 (DV-83, D-W11X2-70): GET /compass/city-confidence over a failed read", () => {
  it("CC0 CONTROL: both reads answer, no rows → exactly the old 'thin' bytes", async () => {
    serve();
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.text, THIN_BYTES);
  });

  it("CC1 (V9-CC1) both reads fail → 503, never the measured 'thin' bytes", async () => {
    serve({ failTables: ["compass_city_confidence", "intel_coverage_snapshots"] });
    const r = await get();
    assert.notEqual(r.text, THIN_BYTES);
    assertUnreadable(r);
  });

  it("CC2 the Compass read fails, the platform read answers with no rows → 503", async () => {
    serve({ failTables: ["compass_city_confidence"] });
    assertUnreadable(await get());
  });

  it("CC3 the Compass read answers with no row, the platform read fails → 503", async () => {
    serve({ failTables: ["intel_coverage_snapshots"] });
    assertUnreadable(await get());
  });

  it("CC4 CONTROL: a Compass row, the platform read fails → the Compass row", async () => {
    serve({ failTables: ["intel_coverage_snapshots"], answer: (t) => (t === "compass_city_confidence" ? { data: LOCAL_ROW, error: null } : undefined) });
    const r = await get();
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.tier, "deep");
    assert.equal(r.body.depthScore, 72);
  });

  it("CC5 CONTROL: the Compass read fails, the platform read has coverage → the platform's answer", async () => {
    serve({ failTables: ["compass_city_confidence"], answer: (t) => (t === "intel_coverage_snapshots" ? { data: COVERAGE, error: null } : undefined) });
    const r = await get();
    assert.equal(r.status, 200, r.text);
    assert.ok(r.body.depthScore > 0, r.text);
  });

  it("CC6 the Compass read THROWS and the platform has no rows → 503", async () => {
    serve({ answer: (t) => { if (t === "compass_city_confidence") throw new Error("socket hang up"); return undefined; } });
    assertUnreadable(await get());
  });
});

void DB_ERR;
