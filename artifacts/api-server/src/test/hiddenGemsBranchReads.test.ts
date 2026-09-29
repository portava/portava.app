/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-97): GET /hidden-gems' `tripId` and
 * `submittedBy` branches never answer a failed read as "Trip not found" or as an empty list.
 *
 * Both branches read `{ data }` alone (the round-12 verifier's note; no client caller today): a failed
 * trips read was 404 "Trip not found", and a failed `trip_plan_items` or `hidden_gems` read was
 * `{ gems: [], total: 0 }` — a guide with no gems, or a trip with none attached. Each read's `.error`
 * is now bound; a failed read is a named failure, never those facts.
 *
 *   HG1  tripId: the trips read fails → never 404 "Trip not found"
 *   HG2  tripId: the trip_plan_items read fails → never `{ gems: [] }`
 *   HG3  submittedBy: the hidden_gems read fails → never `{ gems: [] }`
 *   HG4  tripId: the plan items read, the hidden_gems read fails → never `{ gems: [] }`
 *   HG5  tripId: the trip_members read fails for a non-owner → never 403 "not a member"
 *   HGc  CONTROL: a trip with no gems attached, every read healthy → `{ gems: [], total: 0 }`; no such trip → 404
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-0000000000e1";
const TRIP = "a1000000-0000-4000-a000-0000000000e9";
const GUIDE = "ab000000-0000-4000-a000-0000000000e2";
const TOKEN = "tok-r13-gems";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };

function client(opts: { fail?: string[]; trip?: boolean; planItems?: boolean; notOwner?: boolean } = {}) {
  const fail = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ enabled: true }], error: null };
      if (fail.has(table)) return { data: null, error: ERR };
      if (table === "trips") return { data: opts.trip === false ? null : { id: TRIP, owner_id: opts.notOwner ? GUIDE : VIEWER, status: "active" }, error: null };
      if (table === "trip_plan_items" && opts.planItems) return { data: [{ source_id: "11111111-1111-4111-a111-111111111111" }], error: null };
      if (table === "profiles" && single) return { data: { id: VIEWER, account_status: "active" }, error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
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
  app.use("/api", hiddenGemsRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
async function gems(qs: string, c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/hidden-gems?${qs}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}

describe("GET /hidden-gems' tripId and submittedBy branches over a failed read (§110, D-W11X2-97)", () => {
  it("HG1 tripId: the trips read fails → never 404 'Trip not found'", async () => {
    const { status, body } = await gems(`tripId=${TRIP}`, client({ fail: ["trips"] }));
    assert.notEqual(status, 404, JSON.stringify(body));
    assert.ok(status >= 500 || body.error, JSON.stringify(body));
  });
  it("HG2 tripId: the trip_plan_items read fails → never { gems: [] }", async () => {
    const { status, body } = await gems(`tripId=${TRIP}`, client({ fail: ["trip_plan_items"] }));
    assert.ok(!(status === 200 && Array.isArray(body.gems) && body.gems.length === 0), `${status} ${JSON.stringify(body)}`);
  });
  it("HG3 submittedBy: the hidden_gems read fails → never { gems: [] }", async () => {
    const { status, body } = await gems(`submittedBy=${GUIDE}`, client({ fail: ["hidden_gems"] }));
    assert.ok(!(status === 200 && Array.isArray(body.gems) && body.gems.length === 0), `${status} ${JSON.stringify(body)}`);
  });
  it("HG4 tripId: the plan items read, the hidden_gems read fails → never { gems: [] }", async () => {
    const { status, body } = await gems(`tripId=${TRIP}`, client({ fail: ["hidden_gems"], planItems: true }));
    assert.ok(!(status === 200 && Array.isArray(body.gems) && body.gems.length === 0), `${status} ${JSON.stringify(body)}`);
  });
  it("HG5 tripId: the trip_members read fails (the caller is not the owner) → never 403 'not a member'", async () => {
    const { status, body } = await gems(`tripId=${TRIP}`, client({ fail: ["trip_members"], notOwner: true }));
    assert.notEqual(status, 403, JSON.stringify(body));
    assert.equal(body.error, "degraded_unavailable", JSON.stringify(body));
  });
  it("HGc CONTROL: healthy reads → a trip with no gems is { gems: [], total: 0 }; no such trip is 404", async () => {
    const ok = await gems(`tripId=${TRIP}`, client());
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(ok.body, { gems: [], total: 0 });
    const none = await gems(`tripId=${TRIP}`, client({ trip: false }));
    assert.equal(none.status, 404);
    const guide = await gems(`submittedBy=${GUIDE}`, client());
    assert.deepEqual(guide.body, { gems: [], total: 0 });
  });
});
