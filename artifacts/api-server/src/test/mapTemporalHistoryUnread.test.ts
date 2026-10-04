/**
 * census-discovery §113 (DV-83 round 16, lane W11-X2, D-W11X2-130): the temporal gateway's PAST arm names a failed
 * history read. It answered 200 `{ enabled: true, sources: [], history: { available: false } }` with no refusal, and
 * the client's own type called `available: false` "the honest 'no history yet'", so the Time Machine drew an empty
 * observed past over a read that failed (the round-15 verifier's B2).
 *
 *   V15-TH0  CONTROL (the verifier's): healthy, nothing observed → history available, source named, no refusal
 *   V15-TH1  (the verifier's) the `places` read FAILS → a refusal and failedSources are named
 *   TH1b     the snapshot-versions read FAILS → `history_unreadable`, failedSources ["intel_state_snapshot_versions"]
 *   TH1c     the history read THROWS → `history_unreadable`, both sources named (the route cannot tell which)
 *   THc      CONTROL: a healthy past with an observation → no `refusal` or `failedSources` key at all
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import temporalRouter from "../routes/mapProjectionTemporal.js";
import { _clearProtectedZoneCache } from "../routes/mapProjection.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

const VIEWER = "ab000000-0000-4000-a000-000000000016";
const TOKEN = "tok-r16-history";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const PLACE = { id: "11111111-1111-4111-8111-111111111111", name: "Cafe", latitude: 38.72, longitude: -9.15 };

function client(opts: { fail?: string[]; throwOn?: string; rows?: Record<string, any[]> } = {}) {
  const f = new Set(opts.fail ?? []);
  const b = (table: string): any => {
    if (opts.throwOn === table) throw new Error("socket hang up");
    const answer = (single: boolean) => {
      if (table === "feature_flags") return { data: single ? { enabled: true } : [{ flag: "map_projection_enabled", enabled: true }], error: null };
      if (f.has(table)) return { data: null, error: ERR };
      const rows = opts.rows?.[table] ?? [];
      return { data: single ? (rows[0] ?? null) : rows, error: null };
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
async function past(c: ReturnType<typeof client>) {
  _setTestClient(c as any, true); _setTestServiceClient(c as any);
  const r = await fetch(`${base}/map/projection/temporal?bbox=-9.2,38.7,-9.1,38.75&zoom=14&offsetMinutes=-180`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}
const pick = (b: any) => ({ enabled: b.enabled, mode: b.target?.mode, objects: b.objects?.length, sources: b.sources, history: b.history, refusal: b.refusal ?? null, failedSources: b.failedSources ?? null });

describe("§113 (D-W11X2-130): the temporal gateway's past arm over a failed history read", () => {
  it("V15-TH0 CONTROL: healthy, nothing observed → history available, source named, no refusal", async () => {
    const { status, body } = await past(client());
    assert.equal(status, 200); assert.equal(body.target.mode, "historical");
    assert.deepEqual(body.history, { available: true, covering: 0 }); assert.ok(body.sources.includes("history"));
    assert.equal(body.refusal ?? null, null);
  });

  it("V15-TH1 the places read FAILS → the answer names the failed read (a refusal / failedSources), not only available:false", async () => {
    const { status, body } = await past(client({ fail: ["places"] }));
    assert.equal(status, 200);
    assert.ok(body.refusal != null || body.failedSources != null,
      `a failed history read is answered 200 with no refusal: ${JSON.stringify(pick(body))}`);
    assert.equal(body.refusal, "history_unreadable");
    assert.deepEqual(body.failedSources, ["places"]);
    assert.equal(body.sources.includes("history"), false);
    assert.equal(body.history.available, false);
  });

  it("TH1b the snapshot-versions read FAILS → history_unreadable, failedSources names it", async () => {
    const { status, body } = await past(client({ fail: ["intel_state_snapshot_versions"], rows: { places: [PLACE] } }));
    assert.equal(status, 200);
    assert.equal(body.refusal, "history_unreadable", JSON.stringify(pick(body)));
    assert.deepEqual(body.failedSources, ["intel_state_snapshot_versions"]);
  });

  it("TH1c the history read THROWS → history_unreadable, both sources named", async () => {
    const { status, body } = await past(client({ throwOn: "places" }));
    assert.equal(status, 200);
    assert.equal(body.refusal, "history_unreadable", JSON.stringify(pick(body)));
    assert.deepEqual(body.failedSources, ["places", "intel_state_snapshot_versions"]);
  });

  it("THc CONTROL: a healthy past with an observation → no refusal or failedSources key", async () => {
    const at = Date.now() - 180 * 60_000;
    const version = { subject_id: PLACE.id, claim_type: "activity", value: { level: "busy" }, confidence_band: "established", privacy_eligible: true, observed_at: new Date(at - 60_000).toISOString(), expires_at: new Date(at + 3_600_000).toISOString() };
    const { status, body } = await past(client({ rows: { places: [PLACE], intel_state_snapshot_versions: [version] } }));
    assert.equal(status, 200);
    assert.equal(body.history.available, true);
    assert.equal("refusal" in body, false, JSON.stringify(Object.keys(body)));
    assert.equal("failedSources" in body, false);
    assert.ok(body.sources.includes("history"));
  });
});
