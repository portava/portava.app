/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-115; D-W11X2-104's deferral corrected): the
 * temporal gateway's forecast never names `events` as read over a failed or gated events read.
 *
 * routes/mapProjectionTemporal.ts read `loadNearbyEvents(...).catch(() => [])` — the loader answers null on a
 * failed read and does not throw, so `events ?? []` was used — and then `sources.push("events")`
 * unconditionally, so a failed events read, or events a gate withheld unchecked, was `forecast.events: 0` with
 * `events` named as read: exactly GW1's shape on the NOW gateway (§110, D-W11X2-93). The source is now named
 * only over a read that succeeded and withheld nothing unchecked, and the forecast's event count is null over
 * one that failed. The client says a forecast layer it was not sent could not be read.
 *
 * The round-13 verifier's probes, copied in unchanged (V13-TF0, TF1, TF2), and this lane's:
 *   TF1b the events read fails → `forecast.events` is null (not a count of 0) and `events` is not named
 *   TF3  the loader throws (rather than answering null) → the same
 *   TF2b a per-event gate read fails → `events` not named; the forecast still counts what it did read
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
async function forecast(c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/map/projection/temporal?bbox=-9.2,38.7,-9.1,38.75&zoom=14&offsetMinutes=90`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}

describe("v13: the temporal gateway's forecast over a failed events read", () => {
  it("V13-TF0 CONTROL: healthy reads → the event is forecast and `events` is named", async () => {
    const { status, body } = await forecast(client());
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.forecast?.events, 1, JSON.stringify(body.forecast));
    assert.ok(body.sources.includes("events"));
  });
  it("V13-TF1 the events read fails → `events` is not named as read over `events: 0`", async () => {
    const { status, body } = await forecast(client(["events"]));
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(!(body.sources?.includes("events") && body.forecast?.events === 0), `a failed events read was served as a read source with no events: ${JSON.stringify({ sources: body.sources, forecast: body.forecast })}`);
  });
  it("V13-TF2 a per-event gate read fails → `events` is not named as read over `events: 0`", async () => {
    const { status, body } = await forecast(client(["event_roles"]));
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(!(body.sources?.includes("events") && body.forecast?.events === 0), `an event withheld unchecked was served as a read source with no events: ${JSON.stringify({ sources: body.sources, forecast: body.forecast })}`);
  });
  it("TF1b the events read fails → forecast.events is null and `events` is not named", async () => {
    const { body } = await forecast(client(["events"]));
    assert.equal(body.forecast?.events, null, JSON.stringify(body.forecast));
    assert.ok(!body.sources.includes("events"), JSON.stringify(body.sources));
    assert.ok(body.sources.includes("itinerary"), "the other sources are still named when read");
  });
  it("TF2b a per-event gate read fails → `events` not named; the count is of what was read (0 here), not null", async () => {
    const { body } = await forecast(client(["event_roles"]));
    assert.ok(!body.sources.includes("events"), JSON.stringify(body.sources));
    assert.equal(body.forecast?.events, 0, JSON.stringify(body.forecast));
  });
  it("TF3 the events loader THROWS → the same: `events` not named, forecast.events null", async () => {
    const c: any = client();
    const from = c.from;
    c.from = (t: string) => { if (t === "events") throw new Error("socket hang up"); return from(t); };
    const { status, body } = await forecast(c);
    assert.equal(status, 200, JSON.stringify(body));
    assert.ok(!body.sources.includes("events"), JSON.stringify(body.sources));
    assert.equal(body.forecast?.events, null, JSON.stringify(body.forecast));
  });
});

