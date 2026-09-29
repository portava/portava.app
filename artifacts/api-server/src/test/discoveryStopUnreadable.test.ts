/**
 * census-discovery §107 (DV-83 round 10, lane W11-X2, register D-W11X2-69): an UNREAD Discovery
 * stop is a failed read, never the flag-off answer. Adapted from the round-9 verifier's probe
 * (scratchpad v9-probes/zz-v9-outputKindsKillSwitchUnread).
 *
 * GET /v1/discovery/recommendations/:kind with its rollout flag READ and ON, and the manual stop
 * `disable_discovery_pde` UNREAD: `isKillSwitchEngaged` answers the error as "engaged" (fail
 * closed, D3=B), the stop gate halts, and the route answered `404 feature_disabled` — the flag-off
 * body the output-kinds rail hides exactly like the feature being off (§107.1 BK3). §104's FK1/FK2
 * fixed the same observable for the rollout flag one line earlier. Fail-closed stays (no rows); the
 * answer now says the stop could not be read.
 *
 *   KS0  CONTROL (V9-KS0): the stop read, absent → the rail is served (200)
 *   KS1  (V9-KS1) the stop read fails → 503 degraded_unavailable / stop_unreadable, never 404
 *   KS1b the stop read THROWS → the same 503
 *   KS2  CONTROL: the stop READ and engaged → exactly the flag-off 404 bytes
 *   KS3  an unread stop is not cached: once the read recovers, the next request serves
 *   KS4  the gate: an unread stop is `stop_unreadable`, and every other reader still halts on it
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import outputKindsRouter from "../routes/discoveryOutputKinds.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _setTestClient } from "../lib/http.js";
import { _resetStopConditionsForTest } from "../lib/discoveryStopConditions.js";
import { discoveryStopHalt, unlessDiscoveryStopped } from "../lib/discoveryStopGate.js";
import { makeFakeCandidateDb } from "./helpers/fakeCandidateDb.js";
import { VIEWER, world } from "./helpers/candidateWorld.js";

const TOK = "tok-r10-stop";
const asServiceClient = (c: object) => c as unknown as Parameters<typeof _setTestServiceClient>[0];
type Stop = "absent" | "engaged" | "fails" | "throws";
const state: { stop: Stop } = { stop: "absent" };

/** One client whose manual-stop read answers `state.stop` at the time of each read. */
function serve(kindsFlagOn = true) {
  const w = world();
  w["feature_flags"] = [{ flag: "discovery_output_kinds_enabled", enabled: kindsFlagOn }];
  const d = makeFakeCandidateDb(w, {});
  const auth = { getUser: async (t: string) => (t === TOK ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid token" } }) };
  const from = (d as unknown as { from: (t: string) => any }).from.bind(d);
  const wrapped = (t: string) => {
    const b = from(t);
    if (t !== "feature_flags") return b;
    let flag: unknown = null;
    const wrap: any = new Proxy({}, {
      get(_x, p: string) {
        if (p === "maybeSingle") {
          return () => {
            if (flag !== "disable_discovery_pde") return b.maybeSingle();
            if (state.stop === "fails") return Promise.resolve({ data: null, error: { code: "57014", message: "timeout" } });
            if (state.stop === "throws") throw new Error("socket hang up");
            if (state.stop === "engaged") return Promise.resolve({ data: { enabled: true }, error: null });
            return Promise.resolve({ data: null, error: null });
          };
        }
        if (p === "then") return (f: any, r: any) => b.then(f, r);
        return (...a: unknown[]) => { if (p === "eq" && a[0] === "flag") flag = a[1]; b[p](...a); return wrap; };
      },
    });
    return wrap;
  };
  const client = Object.assign(d, { auth, from: wrapped });
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
beforeEach(() => { _resetStopConditionsForTest(); state.stop = "absent"; });

async function get(path = "/v1/discovery/recommendations/trails?destination=Miami") {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${TOK}` } });
  return { status: res.status, raw: await res.text() };
}

describe("census-discovery §107 (DV-83, D-W11X2-69): the output kinds behind an UNREAD Discovery stop", () => {
  it("KS0 (V9-KS0) CONTROL: the stop read, absent → the rail is served", async () => {
    serve();
    const r = await get();
    assert.equal(r.status, 200, r.raw);
  });

  it("KS1 (V9-KS1) the stop read fails → 503 degraded_unavailable / stop_unreadable, never the flag-off 404", async () => {
    serve(); state.stop = "fails";
    const r = await get();
    assert.notEqual(r.status, 404, `an unread stop is answered as the feature being off: ${r.raw}`);
    assert.equal(r.status, 503, r.raw);
    const body = JSON.parse(r.raw);
    assert.equal(body.error, "degraded_unavailable");
    assert.equal(body.reason, "stop_unreadable");
    assert.equal(body.items, undefined, "fail-closed: no rows");
  });

  it("KS1b the stop read THROWS → the same 503", async () => {
    serve(); state.stop = "throws";
    const r = await get();
    assert.equal(r.status, 503, r.raw);
    assert.equal(JSON.parse(r.raw).reason, "stop_unreadable");
  });

  it("KS2 CONTROL: the stop READ and engaged → exactly the flag-off 404 bytes", async () => {
    serve(false);
    const off = await get();
    _resetStopConditionsForTest();
    serve(); state.stop = "engaged";
    const stopped = await get();
    assert.equal(off.status, 404);
    assert.equal(stopped.status, 404);
    assert.equal(stopped.raw, off.raw);
  });

  it("KS3 an unread stop is not cached: once the read recovers, the next request serves", async () => {
    serve(); state.stop = "fails";
    assert.equal((await get()).status, 503);
    state.stop = "absent";
    const r = await get();
    assert.equal(r.status, 200, `the unread stop was held after the read recovered: ${r.raw}`);
  });

  it("KS4 the gate: an unread stop is stop_unreadable, and every other reader still halts on it", async () => {
    const sc = serve(); state.stop = "fails";
    assert.equal(await discoveryStopHalt(sc), "stop_unreadable");
    assert.equal(await unlessDiscoveryStopped(sc, true), false, "fail-closed: a rollout flag reads OFF while the stop is unread");
    state.stop = "engaged";
    assert.equal(await discoveryStopHalt(sc), "kill_switch_engaged");
  });
});
