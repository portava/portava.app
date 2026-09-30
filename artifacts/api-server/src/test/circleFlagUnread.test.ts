/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, sweep, D-W11X2-118): an unread `find_your_circle_enabled` is
 * a failed read — 503 `degraded_unavailable` with `reason: "flag_unreadable"` — never `404 feature_disabled`.
 *
 * `requireFeatureEnabled` (routes/circle.ts) gates every circle route, GET /circle/compass-suggestions among them,
 * and read the flag through `isFlagEnabled`, which answers `false` for a failed read: an outage was "Find Your Circle
 * is not available yet" (the class D-W11X2-56, -71 and -111 closed at other serve points).
 *
 *   CF1  the flag read fails → 503 degraded_unavailable / flag_unreadable, never 404 feature_disabled
 *   CFc  CONTROL: the flag read succeeds and is off → 404 feature_disabled; on → 200
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import circleRouter from "../routes/circle.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-0000000000d1";
const TOKEN = "tok-r14-circle-flag";
const ERR = { code: "57014", message: "canceling statement due to statement timeout" };

function client(flag: "on" | "off" | "fails" | "absent") {
  const b = (table: string): any => {
    const answer = (single: boolean) => {
      if (table === "feature_flags") return flag === "fails" ? { data: null, error: ERR } : flag === "absent" ? { data: null, error: null } : { data: { enabled: flag === "on" }, error: null };
      return { data: single ? null : [], error: null };
    };
    const p: any = new Proxy({}, { get(_t, k: string) {
      if (k === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
      if (k === "maybeSingle" || k === "single") return () => Promise.resolve(answer(true));
      return () => p;
    } });
    return p;
  };
  return { auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad" } }) }, from: b, rpc: () => Promise.resolve({ data: null, error: null }) };
}

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info() {}, warn() {}, error() {}, debug() {} }; next(); });
  app.use("/api", circleRouter);
  server = createServer(app); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => _resetRateLimit());
const suggestions = async (flag: "on" | "off" | "fails" | "absent") => {
  _setTestClient(client(flag) as any, true);
  const r = await fetch(`${base}/circle/compass-suggestions`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
};

describe("find_your_circle_enabled over a failed read (§111, D-W11X2-118)", () => {
  it("CF1 the flag read fails → 503 degraded_unavailable / flag_unreadable, never 404 feature_disabled", async () => {
    const { status, body } = await suggestions("fails");
    assert.notEqual(body.error, "feature_disabled", `an unread flag was answered as the feature being off: ${status} ${JSON.stringify(body)}`);
    assert.equal(status, 503, JSON.stringify(body));
    assert.equal(body.reason, "flag_unreadable", JSON.stringify(body));
  });
  it("CFc CONTROL: off → 404 feature_disabled; no flag row → 404 feature_disabled; on → 200", async () => {
    const absent = await suggestions("absent");
    assert.equal(absent.status, 404, JSON.stringify(absent.body));
    const off = await suggestions("off");
    assert.equal(off.status, 404, JSON.stringify(off.body));
    assert.equal(off.body.error, "feature_disabled");
    const on = await suggestions("on");
    assert.equal(on.status, 200, JSON.stringify(on.body));
  });
});
