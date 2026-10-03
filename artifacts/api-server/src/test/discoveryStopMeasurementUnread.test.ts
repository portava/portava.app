/**
 * census-discovery §108 (DV-83 round 11, lane W11-X2; D-W11X2-78). §108.1 BK5: an ARMED Discovery stop
 * whose database measurement is UNREADABLE halts (D-W10-O-2, "cannot read halts"), and the gate named
 * that halt `stop_condition`, so GET /v1/discovery/recommendations/:kind answered its flag-off
 * `404 feature_disabled`, which the output-kinds rail hides as "off". D-W11X2-69 separated the unread
 * state only for the manual stop. A halt whose every tripped condition tripped only because its
 * measurement could not be read is now `stop_unreadable` — still a halt, answered 503.
 *
 * V10-* cases are the round-10 verifier's probes (scratchpad v10-probes/zz-v10-outputKindsStopMeasurementUnread),
 * copied in unchanged apart from the harness.
 *
 *   V10-SC0  CONTROL: armed, every measurement readable and clear → 200
 *   V10-SC1  armed, the rls_leak measurement unreadable → never the flag-off 404
 *   SC1b     ... it is 503 degraded_unavailable / stop_unreadable, with no rows
 *   SC2      CONTROL: armed, one condition MEASURED over its threshold beside the unreadable one → the stop's 404 bytes, as before
 *   SC3      the gate itself: unreadable-only → stop_unreadable (a halt); a measured trip → stop_condition; clear → null
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/discoveryStopMeasurementUnread.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { _resetStopConditionsForTest, refreshStopEnforcement, recordStopMeasurement, STOP_ENFORCEMENT_VALUES_VERSION, evaluateStopConditions } from "../lib/discoveryStopConditions.js";
import { discoveryStopHalt, unlessDiscoveryStopped } from "../lib/discoveryStopGate.js";
import { makeFakeCandidateDb } from "./helpers/fakeCandidateDb.js";
import { VIEWER, world } from "./helpers/candidateWorld.js";

const TOK = "tok-r11-stop";
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];

function serve(kindsFlagOn = true) {
  const w = world();
  w["feature_flags"] = [{ flag: "discovery_output_kinds_enabled", enabled: kindsFlagOn }];
  const d = makeFakeCandidateDb(w, {});
  const auth = { getUser: async (t: string) => (t === TOK ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) };
  const client = Object.assign(d, { auth });
  _setTestServiceClient(asServiceClient(client)); _setTestClient(client, true);
  return client;
}

let server: Server;
let base = "";
before(async () => {
  server = createServer(express()
    .use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); })
    .use(outputKindsRouter));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { _setTestServiceClient(null); await new Promise<void>((r) => server.close(() => r())); });
beforeEach(() => { _resetStopConditionsForTest(); });

async function get(path = "/v1/discovery/recommendations/trails?destination=Miami") {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  return { status: res.status, raw: await res.text() };
}

const armClient = { from: (_t: string) => { const b: any = new Proxy({}, { get(_x, p: string) {
  if (p === "maybeSingle") return () => Promise.resolve({ data: { enabled: true, metadata: { values_version: STOP_ENFORCEMENT_VALUES_VERSION } }, error: null });
  return () => b; } }); return b; } };
async function arm() { await refreshStopEnforcement(armClient); }
const now = () => Date.now();
const clear = (...cs: Array<"creator_concentration" | "reports_hides" | "rls_leak" | "attribution_double_count">) => { for (const c of cs) recordStopMeasurement(c, { state: "measured", value: 0, sample: 1000, at: now() }); };
const unreadableRls = () => recordStopMeasurement("rls_leak", { state: "unreadable", value: null, sample: 0, at: now(), detail: { reason: "rpc_error" } });

describe("§108 (BK5) the output kinds behind an ARMED stop with an UNREADABLE measurement", () => {
  it("V10-SC0 CONTROL: armed, measurements readable and clear → 200", async () => {
    serve(); await arm();
    clear("creator_concentration", "reports_hides", "rls_leak", "attribution_double_count");
    assert.deepEqual(evaluateStopConditions().tripped, []);
    const r = await get();
    assert.equal(r.status, 200, r.raw);
  });
  it("V10-SC1 armed, the rls_leak measurement is unreadable → must not be the flag-off 404", async () => {
    serve(); await arm();
    clear("creator_concentration", "reports_hides", "attribution_double_count"); unreadableRls();
    assert.deepEqual(evaluateStopConditions().tripped, ["rls_leak"], "precondition: the unreadable measurement halts");
    const r = await get();
    assert.notEqual(r.status, 404, `an UNREAD stop measurement is answered as the feature being off: ${r.status} ${r.raw}`);
  });
  it("SC1b ... it is 503 degraded_unavailable / stop_unreadable, with no rows", async () => {
    serve(); await arm();
    clear("creator_concentration", "reports_hides", "attribution_double_count"); unreadableRls();
    const r = await get();
    assert.equal(r.status, 503, r.raw);
    const body = JSON.parse(r.raw);
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(body.reason, "stop_unreadable", r.raw);
    assert.equal(body.items, undefined, r.raw);
  });
  it("SC2 CONTROL: a MEASURED trip beside the unreadable one → the stop's flag-off 404, as before", async () => {
    serve(); await arm();
    clear("reports_hides", "attribution_double_count"); unreadableRls();
    recordStopMeasurement("creator_concentration", { state: "measured", value: 0.9, sample: 100_000, at: now() });
    assert.deepEqual([...evaluateStopConditions().tripped].sort(), ["creator_concentration", "rls_leak"], "precondition: both trip");
    const r = await get();
    assert.equal(r.status, 404, r.raw);
    assert.equal(JSON.parse(r.raw).error, "feature_disabled");
  });
  it("SC3 the gate: unreadable-only → stop_unreadable (still a halt); a measured trip → stop_condition; clear → null", async () => {
    const sc = serve(); await arm();
    clear("creator_concentration", "reports_hides", "attribution_double_count"); unreadableRls();
    assert.equal(await discoveryStopHalt(sc), "stop_unreadable");
    assert.equal(await unlessDiscoveryStopped(sc, true), false, "an unreadable measurement still halts every rollout flag");
    recordStopMeasurement("creator_concentration", { state: "measured", value: 0.9, sample: 100_000, at: now() });
    assert.equal(await discoveryStopHalt(sc), "stop_condition");
    _resetStopConditionsForTest(); await arm();
    clear("creator_concentration", "reports_hides", "rls_leak", "attribution_double_count");
    assert.equal(await discoveryStopHalt(sc), null);
  });
});
