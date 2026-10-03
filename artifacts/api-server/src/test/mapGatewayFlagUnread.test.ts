/**
 * census-discovery §115 (DV-83 round 18, lane W11-X2; the round-17 verifier's B9, safety-relevant): an UNREAD
 * `map_projection_enabled` is never served as the flag-off body.
 *
 * Both gateways read the rollout flag three-state (`readFlagState`). A flag that was read and is off answers the
 * flag-off body (`enabled: false`, no refusal) — the client rolls back to its legacy fetchers, and that is "off", not
 * "unread" (NU8c). A flag whose read FAILED answers `enabled: false` with `refusal: "flag_unreadable"`: the NOW map then
 * names every optional layer only the gateway serves as unread, safety first, and the Time Machine says the time could
 * not be loaded. Before the fix the unread flag was byte-identical to the off flag, so the safety layer vanished unsaid.
 *
 *   GF0  CONTROL: the flag read and off → the flag-off body, no refusal (both gateways)
 *   GF1  NOW: the flag read fails → `refusal: "flag_unreadable"`, not the flag-off body
 *   GF2  temporal: the flag read fails → `refusal: "flag_unreadable"`, not the flag-off body
 *   GF3  CONTROL: an absent flag row is off, not unread (both gateways)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, { _clearProtectedZoneCache, _clearFlowZoneCache } from "../routes/mapProjection.js";
import mapProjectionTemporalRouter from "../routes/mapProjectionTemporal.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "aaaa1111-0000-0000-0000-0000000000e8";
const TOKEN = "r18-gf-token";
const NOW_PATH = "/map/projection?bbox=108.15,16.00,108.25,16.10&zoom=13";
const TEMPORAL_PATH = "/map/projection/temporal?bbox=108.0,15.9,108.4,16.2&offsetMinutes=60";
const world = (flags: Array<{ flag: string; enabled: boolean }>): FakeState => ({ feature_flags: flags, blocks: [], protected_zones: [], places: [] });
const ON = [{ flag: "map_projection_enabled", enabled: true }];
const OFF = [{ flag: "map_projection_enabled", enabled: false }];

let app: ProjectionApp | null = null;
beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _resetRateLimit(); });
afterEach(async () => { if (app) await app.close(); app = null; });

/** A client whose read of ONE flag row fails (a statement timeout), every other read healthy. */
function failingFlag(client: any, failFlag: string): any {
  const from = client.from;
  client.from = (t: string) => {
    const q = from(t);
    if (t !== "feature_flags") return q;
    const eq = q.eq;
    q.eq = (col: string, val: unknown) => {
      if (col === "flag" && val === failFlag) {
        const fail: any = {
          select: () => fail, eq: () => fail, limit: () => fail,
          maybeSingle: () => Promise.resolve({ data: null, error: { code: "57014", message: "statement timeout" } }),
          single: () => fail.maybeSingle(), then: (r: any, j: any) => fail.maybeSingle().then(r, j),
        };
        return fail;
      }
      return eq(col, val);
    };
    return q;
  };
  return client;
}

/** The fields of either gateway's answer these cases read. */
interface GatewayBody { enabled: boolean; refusal?: string | null; objects: unknown[]; sources: string[]; generatedAt?: string; [key: string]: unknown }

async function call(router: any, path: string, state: FakeState, failFlag: string | null) {
  let client: any = makeFakeMapDb(state, { token: TOKEN, userId: VIEWER });
  if (failFlag) client = failingFlag(client, failFlag);
  app = await mountRouterApp(router, client, { token: TOKEN, userId: VIEWER });
  const res = await fetch(`${app.baseUrl}/api${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = (await res.json()) as GatewayBody;
  await app.close(); app = null;
  const { generatedAt: _g, ...stable } = body;
  return { status: res.status, body, stable, seen: JSON.stringify(stable) };
}

describe("census-discovery §115 (B9): an unread map_projection_enabled is not the flag-off body", () => {
  it("GF0 CONTROL: the flag read and off → the flag-off body, no refusal (NOW and temporal)", async () => {
    for (const [router, path] of [[mapProjectionRouter, NOW_PATH], [mapProjectionTemporalRouter, TEMPORAL_PATH]] as const) {
      const r = await call(router, path, world(OFF), null);
      assert.equal(r.status, 200, r.seen);
      assert.equal(r.body.enabled, false, r.seen);
      assert.equal(r.body.refusal ?? null, null, r.seen);
      assert.equal("refusal" in r.body, false, `the flag-off body is byte-identical to before: ${r.seen}`);
    }
  });

  it("GF1 NOW: the flag read FAILS → refusal flag_unreadable, never the flag-off body", async () => {
    const off = await call(mapProjectionRouter, NOW_PATH, world(OFF), null);
    const unread = await call(mapProjectionRouter, NOW_PATH, world(ON), "map_projection_enabled");
    assert.equal(unread.status, 200, unread.seen);
    assert.equal(unread.body.enabled, false, unread.seen);
    assert.equal(unread.body.refusal, "flag_unreadable", `an unread gateway flag answered as off: ${unread.seen}`);
    assert.notDeepEqual(unread.stable, off.stable, unread.seen);
    assert.deepEqual(unread.body.objects, [], unread.seen);
    assert.deepEqual(unread.body.sources, [], unread.seen);
  });

  it("GF2 temporal: the flag read FAILS → refusal flag_unreadable, never the flag-off body", async () => {
    const off = await call(mapProjectionTemporalRouter, TEMPORAL_PATH, world(OFF), null);
    const unread = await call(mapProjectionTemporalRouter, TEMPORAL_PATH, world(ON), "map_projection_enabled");
    assert.equal(unread.status, 200, unread.seen);
    assert.equal(unread.body.enabled, false, unread.seen);
    assert.equal(unread.body.refusal, "flag_unreadable", `an unread gateway flag answered as off: ${unread.seen}`);
    assert.notDeepEqual(unread.stable, off.stable, unread.seen);
    assert.deepEqual(unread.body.objects, [], unread.seen);
  });

  it("GF3 CONTROL: an absent flag row is off, not unread (NOW and temporal)", async () => {
    for (const [router, path] of [[mapProjectionRouter, NOW_PATH], [mapProjectionTemporalRouter, TEMPORAL_PATH]] as const) {
      const r = await call(router, path, world([]), null);
      assert.equal(r.body.enabled, false, r.seen);
      assert.equal("refusal" in r.body, false, r.seen);
    }
  });
});
