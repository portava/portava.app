/**
 * census-discovery §105 (DV-83 round 9, register D-W11X2-62): GET /compass/feed never answers
 * an UNREAD flag as "Compass off".
 *
 * Before §105 the route read COMPASS_ENABLED through `isCompassEnabled` (the fail-safe map, in
 * which an unread table is "off") and COMPASS_FEED_ENABLED with its `error` ignored and its
 * catch degrading to the off body, so both unread flags answered the flag-off bytes
 * `{"sections":[],"nextCursor":null,"fallback":true}` with no refusal. D-W11X2-50/55 had fixed
 * the section route and /compass/recommendations only. An unread flag is now the refusal
 * `compass_flags_unreadable`; a flag that was READ and is off keeps its old bytes exactly.
 *
 * CF0..CF2 are the independent round-8 verifier's probe (V8-CF0..2), copied in.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "ab000000-0000-4000-a000-000000000001";
const TOKEN = "tok-compass-viewer";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };

const readsSeen: string[] = [];
const SOURCES = new Set(["posts", "rent_buddy_profiles", "events", "discovery_places", "hidden_gems"]);
function fakeClient(opts: { failSources: boolean; failTables?: string[]; flagsFail?: boolean; feedFlagFails?: boolean; feedFlagThrows?: boolean; compassOff?: boolean; feedOff?: boolean }) {
  function builder(table: string) {
    const named: Record<string, unknown> = {};
    const answer = (): { data: unknown; error: unknown } => {
      if (table === "feature_flags" && named.like !== undefined) {
        if (opts.flagsFail) return { data: null, error: DB_ERR };
        return { data: [{ flag: "COMPASS_ENABLED", enabled: !opts.compassOff }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }, { flag: "COMPASS_FEED_ENABLED", enabled: true }], error: null };
      }
      if (table === "feature_flags" && named.eq === "flag") {
        if (opts.feedFlagThrows) throw new Error("socket hang up");
        return opts.feedFlagFails ? { data: null, error: DB_ERR } : { data: { enabled: !opts.feedOff }, error: null };
      }
      if (table === "feature_flags") return { data: null, error: null };
      if (table === "profiles" && named.select === "account_status") return { data: { account_status: "active" }, error: null };
      readsSeen.push(table);
      if (table === "user_location_state") return { data: { city: "Paris" }, error: null };
      if (table === "profiles") return { data: { id: VIEWER, account_status: "active" }, error: null };
      if (opts.failSources && SOURCES.has(table)) return { data: null, error: DB_ERR };
      if (opts.failTables?.includes(table)) return { data: null, error: DB_ERR };
      if (table === "discovery_places") return { data: [{ id: "11111111-1111-4111-a111-111111111111", city: "Paris", name: "Le Place", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: null, lat: 48.85, lng: 2.35 }], error: null };
      return { data: null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => { try { return Promise.resolve(answer()).then(f, r); } catch (e) { return Promise.reject(e).then(f, r); } };
        if (prop === "maybeSingle" || prop === "single") return () => { try { return Promise.resolve(answer()); } catch (e) { return Promise.reject(e); } };
        return (...args: unknown[]) => { named[prop] = args[0]; return b; };
      },
    });
    return b;
  }
  return {
    auth: { getUser: async (tok: string) => (tok === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    from: (table: string) => builder(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

let base = "";
let server: Server;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); readsSeen.length = 0; });

async function get(path: string): Promise<{ status: number; body: any; text: string }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), text };
}
const OFF_BYTES = '{"sections":[],"nextCursor":null,"fallback":true}';
function assertFlagsRefusal(body: any): void {
  assert.equal(body.fallbackReason, "compass_flags_unreadable");
  assert.deepEqual(body.sections, []);
  assert.equal(body.refusal?.class, "transient_db");
  assert.equal(body.refusal?.code, "compass_flags_unreadable");
  assert.equal(body.refusal?.route, "GET /compass/feed");
  assert.equal(body.refusal?.coverage, "nothing");
  assert.deepEqual(body.refusal?.failedSources, ["feature_flags"]);
}

describe("census-discovery §105 (DV-83, D-W11X2-62): GET /compass/feed when a flag read fails", () => {
  it("CF0 (V8-CF0) CONTROL: flags read, sources read → the feed serves the place", async () => {
    _setTestClient(fakeClient({ failSources: false }) as any, true);
    const { status, body } = await get("/compass/feed?city=Paris");
    const items = (body.sections ?? []).flatMap((s: any) => s.items ?? []);
    assert.equal(status, 200);
    assert.ok(items.length > 0);
  });

  it("CF1 (V8-CF1) the COMPASS_% flag table read fails → the refusal, never the 'Compass is off' body", async () => {
    _setTestClient(fakeClient({ failSources: false, flagsFail: true }) as any, true);
    const { status, body } = await get("/compass/feed?city=Paris");
    assert.ok(!(status === 200 && (body.sections ?? []).length === 0 && body.refusal == null && body.fallbackReason == null), "an unread flag table is answered as Compass switched off");
    assert.equal(status, 200);
    assertFlagsRefusal(body);
  });

  it("CF2 (V8-CF2) the COMPASS_FEED_ENABLED read fails → the refusal, never the 'feed off' body", async () => {
    _setTestClient(fakeClient({ failSources: false, feedFlagFails: true }) as any, true);
    const { status, body } = await get("/compass/feed?city=Paris");
    assert.ok(!(status === 200 && (body.sections ?? []).length === 0 && body.refusal == null && body.fallbackReason == null), "an unread feed flag is answered as the feed switched off");
    assertFlagsRefusal(body);
  });

  it("CF3 the COMPASS_FEED_ENABLED read THROWS → the refusal too, never the off body", async () => {
    _setTestClient(fakeClient({ failSources: false, feedFlagThrows: true }) as any, true);
    const { body } = await get("/compass/feed?city=Paris");
    assertFlagsRefusal(body);
  });

  it("CF4 CONTROL: COMPASS_ENABLED READ and off → exactly the old off bytes", async () => {
    _setTestClient(fakeClient({ failSources: false, compassOff: true }) as any, true);
    const { status, text } = await get("/compass/feed?city=Paris");
    assert.equal(status, 200);
    assert.equal(text, OFF_BYTES);
  });

  it("CF5 CONTROL: COMPASS_FEED_ENABLED READ and off → exactly the old off bytes", async () => {
    _setTestClient(fakeClient({ failSources: false, feedOff: true }) as any, true);
    const { status, text } = await get("/compass/feed?city=Paris");
    assert.equal(status, 200);
    assert.equal(text, OFF_BYTES);
  });
});
