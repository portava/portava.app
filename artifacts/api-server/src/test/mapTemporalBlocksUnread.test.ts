/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-121; D-W11X2-115 corrected): the temporal gateway
 * never answers a failed blocks read as an enabled, empty forecast.
 *
 * routes/mapProjectionTemporal.ts answered `fetchBlockedSet(...) === null` with 200 `{ enabled: true, objects: [],
 * sources: [], forecast: null }` and no refusal — the same body a request that simply read nothing would get, so the
 * client's `forecastLayersUnread` reported nothing unread and the Time Machine drew the honest-empty state. The NOW
 * gateway (routes/mapProjection.ts) names the refusal `block_set_unreadable`. The temporal branch now names it too,
 * and a forecast target carries `forecast.events: null` (no layer is stated as read, no count as measured).
 *
 * The round-14 verifier's probes, copied in unchanged (V14-TB0, TB1), and this lane's:
 *   TB2  the refusal is named `block_set_unreadable` (a forecast target)
 *   TB3  a forecast target: `forecast` is a report whose events, itinerary and plan are all unread (null)
 *   TB4  a historical target: the refusal is named, and no history report is stated
 *   TBc  CONTROL: healthy reads → no refusal key at all, and the forecast report counts what it read
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import temporalRouter from "../routes/mapProjectionTemporal.js";
import { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-000000000014";
const TOKEN = "tok-v13-temporal";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();
const EV = () => ({ id: "e1000000-0000-4000-a000-0000000000t1", host_id: "ab000000-0000-4000-a000-0000000000f4", title: "Fado night", location_name: "Club", location_lat: 38.72, location_lng: -9.14, show_exact_location: true, starts_at: inAnHour(), ends_at: new Date(Date.now() + 3 * 3600_000).toISOString(), cover_url: null, visibility: "public", state: "open", age_min: null, age_max: null, trust_score_min: null, verified_only: false });

function client(fail: string[] = []) {
  const f = new Set(fail);
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ flag: "map_projection_enabled", enabled: true }], error: null };
      if (f.has(table)) return { data: null, error: ERR };
      if (table === "events") return { data: single ? EV() : [EV()], error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (fn: any, r: any) => Promise.resolve(answer(false)).then(fn, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", temporalRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _clearProtectedZoneCache());
async function at(c: ReturnType<typeof client>, offsetMinutes: number) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/map/projection/temporal?bbox=-9.2,38.7,-9.1,38.75&zoom=14&offsetMinutes=${offsetMinutes}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}
const forecast = (c: ReturnType<typeof client>) => at(c, 90);

describe("v14 (copied in unchanged): the temporal gateway over a failed blocks read", () => {
  it("V14-TB0 CONTROL: healthy → the forecast names events", async () => {
    const { status, body } = await forecast(client());
    assert.equal(status, 200); assert.ok(body.forecast && body.sources.includes("events"), JSON.stringify(body));
  });
  it("V14-TB1 the blocks read fails → the body tells the client the forecast's events layer was not read", async () => {
    const { status, body } = await forecast(client(["blocks"]));
    const saysUnread = (body.forecast && body.forecast.events === null) || (body.refusal != null);
    assert.ok(saysUnread, `a failed blocks read answered as an enabled, empty forecast the client cannot tell from "nothing forecast": ${JSON.stringify(body).slice(0, 400)}`);
  });
});

describe("§112 (D-W11X2-121): the temporal gateway names a failed blocks read", () => {
  it("TB2 a forecast target → refusal block_set_unreadable, nothing served, no source named", async () => {
    const { status, body } = await forecast(client(["blocks"]));
    assert.equal(status, 200);
    assert.equal(body.refusal, "block_set_unreadable", JSON.stringify(body));
    assert.deepEqual(body.objects, []); assert.deepEqual(body.sources, []);
  });
  it("TB3 a forecast target → forecast.events, itinerary and plan are unread (null), never a count", async () => {
    const { body } = await forecast(client(["blocks"]));
    assert.deepEqual(body.forecast, { events: null, itinerary: null, plan: null }, JSON.stringify(body));
  });
  it("TB4 a historical target → the refusal is named, and no history report is stated", async () => {
    const { status, body } = await at(client(["blocks"]), -120);
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.target?.mode, "historical", JSON.stringify(body));
    assert.equal(body.refusal, "block_set_unreadable");
    assert.equal(body.forecast, null); assert.equal(body.history, null);
  });
  it("TBc CONTROL: healthy reads → no refusal key, and the forecast counts what it read", async () => {
    const { body } = await forecast(client());
    assert.equal("refusal" in body, false, JSON.stringify(body));
    assert.equal(body.forecast.events, 1); assert.equal(typeof body.forecast.itinerary, "number");
  });
});
