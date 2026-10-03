/**
 * census-discovery §105 sweep (DV-83 round 9, register D-W11X2-65): GET /compass/home never
 * answers an UNREAD flag as "Compass off", and says a failed build.
 *
 * The route read COMPASS_ENABLED with `isCompassEnabled(sc).catch(() => false)`: the fail-safe
 * map answers an unread flag table as "off", so a timed-out read was `{ compassEnabled: false,
 * fallback: true }`, the flag-off bytes — the class §103/§104 closed on the section and
 * recommendations routes and §105 closes on the feed. The build-failure arm answered
 * `{ compassEnabled: true, fallback: true }` with nothing naming it.
 *
 *   HM1  the COMPASS_% read fails → fallbackReason compass_flags_unreadable + refusal (nothing)
 *   HM1c CONTROL: COMPASS_ENABLED READ and off → exactly the old bytes
 *   HM2  the build throws → fallbackReason home_build_failed + refusal (nothing)
 *   HM3  CONTROL: flags read and on, a healthy build → no refusal key
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import pino from "pino";
import compassHomeRouter, { _clearCompassHomeCache } from "../routes/compassHome.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { _setTestClient } from "../lib/http.js";

const VIEWER = "ab000000-0000-4000-a000-000000000009";
const TOKEN = "tok-compass-home";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

function client(opts: { flagsFail?: boolean; compassOff?: boolean; buildThrows?: boolean }) {
  function builder(table: string) {
    const calls: Record<string, unknown[]> = {};
    const answer = (single: boolean) => {
      if (table === "feature_flags" && calls.like) {
        if (opts.flagsFail) return { data: null, error: DB_ERR };
        return { data: [{ flag: "COMPASS_ENABLED", enabled: !opts.compassOff }], error: null };
      }
      if (table === "profiles" && calls.select?.[0] === "account_status") return { data: { account_status: "active" }, error: null };
      return { data: single ? null : [], error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer(false)).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer(true));
        return (...args: unknown[]) => { calls[prop] = args; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (t: string) => (t === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (t: string) => {
      if (opts.buildThrows && t !== "feature_flags" && t !== "profiles") throw new Error(`${t}: socket hang up`);
      return builder(t);
    },
    rpc: () => { if (opts.buildThrows) throw new Error("rpc: socket hang up"); return Promise.resolve({ data: null, error: null }); },
  };
}

let server: Server;
let base = "";
before(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as any).log = pino({ level: "silent" }); next(); });
  app.use("/api", compassHomeRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { invalidateFlagsCache(); _clearCompassHomeCache(); });

async function home() {
  const r = await fetch(`${base}/compass/home?tzOffsetMinutes=0`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}

describe("census-discovery §105 (DV-83, D-W11X2-65): GET /compass/home", () => {
  it("HM1 the COMPASS_% flag read fails → a refusal, never the Compass-off body", async () => {
    _setTestClient(client({ flagsFail: true }) as any, true);
    const { status, body } = await home();
    assert.equal(status, 200);
    assert.equal(body.fallback, true);
    assert.equal(body.fallbackReason, "compass_flags_unreadable");
    assert.equal(body.refusal?.code, "compass_flags_unreadable");
    assert.equal(body.refusal?.coverage, "nothing");
    assert.deepEqual(body.refusal?.failedSources, ["feature_flags"]);
  });

  it("HM1c CONTROL: COMPASS_ENABLED READ and off → exactly the old bytes", async () => {
    _setTestClient(client({ compassOff: true }) as any, true);
    const { text } = await home();
    assert.equal(text, '{"compassEnabled":false,"fallback":true}');
  });

  it("HM2 the build throws → the failure is named, never an unexplained fallback", async () => {
    _setTestClient(client({ buildThrows: true }) as any, true);
    const { status, body } = await home();
    assert.equal(status, 200);
    assert.equal(body.compassEnabled, true);
    assert.equal(body.fallback, true);
    assert.equal(body.fallbackReason, "home_build_failed");
    assert.equal(body.refusal?.coverage, "nothing");
  });

  it("HM3 CONTROL: flags read and on, a healthy build → no refusal key", async () => {
    _setTestClient(client({}) as any, true);
    const { body } = await home();
    assert.equal(body.compassEnabled, true);
    assert.ok(!("refusal" in body), JSON.stringify(body).slice(0, 300));
  });
});
