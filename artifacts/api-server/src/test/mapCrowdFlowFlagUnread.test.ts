/**
 * census-discovery §116 (DV-83 round 19, lane W11-X2; sweep SW15): the NOW gateway's crowd-flow report never states an
 * unread flag as off.
 *
 * Round 18 (§115.4, B10; D-W11X2-146) made the Time Machine's plan layer read `map_crowd_flow_enabled` three-state, so an
 * unread flag refuses as `flag_unreadable`. The NOW gateway read the same flag two-state (`isFlagEnabled`, false on a
 * failed read) and served `crowdFlow.refusal: "flag_off"` over a flag nobody read. The client already names the layer
 * unread (it is absent from `sources`); the served report now says what happened too.
 *
 *   CF1  the flag read FAILS → `crowdFlow.refusal: "flag_unreadable"`, and `crowd_flow` is not named in `sources`
 *   CF0  CONTROL: the flag read and off → `flag_off`, as before
 *   CF0b CONTROL: the flag row absent → `flag_off`, as before
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, { _clearProtectedZoneCache, _clearFlowZoneCache } from "../routes/mapProjection.js";
import { makeFakeMapDb, mountRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";
import { _resetRateLimit } from "../lib/rateLimit.js";

const VIEWER = "aaaa1111-0000-0000-0000-0000000000f9";
const TOKEN = "r19-cf-token";
const DISTRICT = "bbox=108.15,16.00,108.25,16.10&zoom=13";
const TIMEOUT = { code: "57014", message: "canceling statement due to statement timeout" };

function world(flowFlag: boolean | null): FakeState {
  return {
    feature_flags: [{ flag: "map_projection_enabled", enabled: true }, ...(flowFlag === null ? [] : [{ flag: "map_crowd_flow_enabled", enabled: flowFlag }])],
    blocks: [], protected_zones: [], places: [],
  };
}

function failFlag(client: any, flag: string): void {
  const from = client.from;
  client.from = (t: string) => {
    const q = from(t);
    if (t !== "feature_flags") return q;
    const eq = q.eq;
    q.eq = (col: string, val: unknown) => {
      if (col === "flag" && val === flag) {
        const fail: any = { select: () => fail, eq: () => fail, limit: () => fail, maybeSingle: () => Promise.resolve({ data: null, error: TIMEOUT }), single: () => fail.maybeSingle(), then: (r: any, j: any) => fail.maybeSingle().then(r, j) };
        return fail;
      }
      return eq(col, val);
    };
    return q;
  };
}

let app: ProjectionApp | null = null;
beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _resetRateLimit(); });
afterEach(async () => { if (app) await app.close(); app = null; });

async function flow(flowFlag: boolean | null, fail = false) {
  const client: any = makeFakeMapDb(world(flowFlag), { token: TOKEN, userId: VIEWER });
  if (fail) failFlag(client, "map_crowd_flow_enabled");
  app = await mountRouterApp(mapProjectionRouter, client, { token: TOKEN, userId: VIEWER });
  const r = await app.projection(`${DISTRICT}&kinds=crowd_flow`);
  return { status: r.status, crowdFlow: r.body.crowdFlow, sources: r.body.sources, seen: JSON.stringify({ status: r.status, crowdFlow: r.body.crowdFlow?.refusal, sources: r.body.sources }) };
}

describe("census-discovery §116 (SW15): the NOW gateway's crowd-flow report over an unread flag", () => {
  it("CF0 CONTROL: the flag read and off → flag_off", async () => {
    const r = await flow(false);
    assert.equal(r.crowdFlow?.refusal, "flag_off", r.seen);
  });
  it("CF0b CONTROL: the flag row absent → flag_off", async () => {
    const r = await flow(null);
    assert.equal(r.crowdFlow?.refusal, "flag_off", r.seen);
  });
  it("CF1 the flag read FAILS → flag_unreadable, and crowd_flow is not named in sources", async () => {
    const r = await flow(true, true);
    assert.equal(r.status, 200, r.seen);
    assert.equal(r.crowdFlow?.refusal, "flag_unreadable", `an unread flag stated as off: ${r.seen}`);
    assert.equal((r.sources ?? []).includes("crowd_flow"), false, r.seen);
  });
});
