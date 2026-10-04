/**
 * census-discovery §112 (DV-83 round 15, lane W11-X2, D-W11X2-125): GET /hidden-gems/trip-city/:tripId never
 * answers a failed trips read as "Trip not found".
 *
 * routes/hiddenGems.ts read the trip `const { data: trip }` and bound no error, so a failed read was `404 "Trip not
 * found"` — the class D-W11X2-97 closed on the sibling GET /hidden-gems?tripId. The error is bound and a failed read
 * is 503 `degraded_unavailable`.
 *
 * The round-14 verifier's probes, copied in (V14-TC0, TC1; the fake client also answers "no such trip" for the
 * control TCc), and this lane's:
 *   TC2  the trips read fails → 503 degraded_unavailable, with no gems
 *   TCc  CONTROL: the trip is not the viewer's (the read succeeds, no row) → 404 "Trip not found" as before
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const TRIP = "7a000000-0000-4000-a000-000000000001";
const GEM = { id: "9e000000-0000-4000-a000-000000000001", name: "Tile courtyard", category: "viewpoint", city: "Lisbon", country: "PT", sensitivity_level: "public", verification_level: "community", status: "active", submitted_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
function client(fail: string[] = []) {
  const f = new Set(fail);
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (f.has(table)) return { data: null, error: ERR };
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (table === "trips") return { data: single ? (f.has("trips:none") ? null : { id: TRIP, destination_city: "Lisbon, Portugal" }) : [], error: null };
      if (table === "hidden_gems") return { data: single ? GEM : [GEM], error: null };
      return { data: single ? null : [], error: null, count: 0 };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (fn: any, r: any) => Promise.resolve(answer(false)).then(fn, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t?: string) => (t === "tok-gem" ? { data: { user: { id: "ab000000-0000-4000-a000-0000000000a1" } }, error: null } : { data: { user: null }, error: { message: "anon" } }) }, from: b, rpc: () => Promise.resolve({ data: [], error: null }) };
}
let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", hiddenGemsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
async function tripCity(c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/hidden-gems/trip-city/${TRIP}`, { headers: { Authorization: "Bearer tok-gem" } });
  const body = await r.json() as any; console.log("V14-TC", r.status, JSON.stringify(body).slice(0, 200)); return { status: r.status, body };
}
describe("v14: GET /hidden-gems/trip-city over a failed trips read", () => {
  it("V14-TC0 CONTROL: healthy → 200 with the city's gems", async () => {
    const { status, body } = await tripCity(client());
    assert.equal(status, 200, JSON.stringify(body)); assert.equal(body.gems?.length, 1, JSON.stringify(body));
  });
  it("V14-TC1 the trips read fails → never 404 'Trip not found'", async () => {
    const { status, body } = await tripCity(client(["trips"]));
    assert.ok(!(status === 404 && body.error === "not_found"), `a failed trips read answered 'Trip not found': ${status} ${JSON.stringify(body)}`);
  });
});

describe("§112 (D-W11X2-125): GET /hidden-gems/trip-city names a failed trips read", () => {
  it("TC2 the trips read fails → 503 degraded_unavailable, with no gems", async () => {
    const { status, body } = await tripCity(client(["trips"]));
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(body.gems, undefined);
  });
  it("TCc CONTROL: a trip the viewer cannot read (no row, no error) → 404 'Trip not found'", async () => {
    const { status, body } = await tripCity(client(["trips:none"]));
    assert.equal(status, 404, JSON.stringify(body));
    assert.equal(body.error, "not_found");
  });
});
