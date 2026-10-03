/**
 * census-discovery §110 (DV-83 round 13, lane W11-X2, D-W11X2-100): the round-13 sweep of `runPipeline`'s
 * other consumers. `buildFeed` (GET /compass/feed, and the front-load's first feed page) dropped
 * `runFeedPipeline`'s `flagsUnreadable`, the marker §103 added for exactly this case.
 *
 * GET /compass/feed reads COMPASS_ENABLED through the 30 s flag cache, while `runPipeline` re-reads the
 * COMPASS_% table UNCACHED; a blip between the two answers the fail-safe map, which engages every
 * `COMPASS_<TYPE>_SAFETY_BLOCK`, so every candidate is blocked and every section is empty. The route
 * served that as the feed (`sections: []`, no refusal) and WROTE IT TO THE FEED CACHE as complete, and
 * the front-load engine preloaded it as the first page. `buildFeed` now throws
 * `CompassFlagsUnreadableError` on the marker, as `buildSection` and `rankItemsForDiscovery` already did:
 * the route answers the §105 flags refusal (and caches nothing), and the front-load hands the client no
 * first page, so it asks the feed itself.
 *
 *   (The static safety tools are served whatever the flags say, so "the place is served" is the test of a real answer.)
 *   FB0  CONTROL: every read healthy → the feed serves the place
 *   FB1  the pipeline's own COMPASS_% read fails after the route's succeeded → the flags refusal, never `sections: []` alone
 *   FB2  ... and nothing was cached: the next healthy request serves the place
 *   FL1  the front-load's first feed page over a failed pipeline flag read → no page, never an empty feed
 *   FLc  CONTROL: the front-load over healthy reads → the first page carries the place
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import compassRouter from "../routes/compass.js";
import { buildFrontLoadPayload } from "../compass/CompassFrontLoadEngine.js";
import { invalidateFlagsCache } from "../compass/flags.js";
import { clearL1Cache } from "../compass/CompassCacheEngine.js";
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { _setTestClient } from "../lib/http.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import type { CompassProfile } from "../compass/types.js";

const VIEWER = "ab000000-0000-4000-a000-000000000031";
const TOKEN = "tok-r13-feed";
const DB_ERR = { code: "57014", message: "canceling statement due to statement timeout" };
const PLACE = { id: "11111111-1111-4111-a111-111111111111", city: "Paris", name: "Le Place", category: "food", status: "active", rating: 4, created_at: new Date().toISOString(), submitted_by: null, lat: 48.85, lng: 2.35 };

/** `flagReadsOk`: how many COMPASS_% reads succeed before the rest fail (Infinity = all succeed). */
function fakeClient(flagReadsOk = Infinity) {
  let flagReads = 0;
  function builder(table: string) {
    const named: Record<string, unknown> = {}; let eqValue: unknown;
    const answer = (): { data: unknown; error: unknown } => {
      if (table === "feature_flags" && named.like !== undefined) {
        flagReads++;
        if (flagReads > flagReadsOk) return { data: null, error: DB_ERR };
        return { data: [{ flag: "COMPASS_ENABLED", enabled: true }, { flag: "COMPASS_V1_RULE_BASED_ENABLED", enabled: true }, { flag: "COMPASS_FEED_ENABLED", enabled: true }], error: null };
      }
      if (table === "feature_flags" && named.eq === "flag") return { data: { enabled: eqValue === "COMPASS_FEED_ENABLED" }, error: null };  // the feed on; fallback mode (and any other) off
      if (table === "feature_flags") return { data: null, error: null };
      if (table === "profiles" && named.select === "account_status") return { data: { account_status: "active" }, error: null };
      if (table === "user_location_state") return { data: { city: "Paris" }, error: null };
      if (table === "profiles") return { data: { id: VIEWER, account_status: "active" }, error: null };
      if (table === "discovery_places") return { data: [PLACE], error: null };
      return { data: null, error: null };
    };
    const b: any = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (f: any, r: any) => Promise.resolve(answer()).then(f, r);
        if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(answer());
        return (...args: unknown[]) => { named[prop] = args[0]; if (prop === "eq" && args[0] === "flag") eqValue = args[1]; return b; };
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

let base = ""; let server: Server;
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app); await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => server.close());
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); clearCompassProfileCache(); _resetRateLimit(); });
async function feed(client: ReturnType<typeof fakeClient>) {
  _setTestClient(client as any, true);
  const r = await fetch(`${base}/compass/feed?city=Paris`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() as any };
}
const items = (body: any) => (body.sections ?? []).flatMap((s: any) => s.items ?? []);
/** The catalog place is among the items (the static safety tools are served whatever the flags say). */
const hasPlace = (body: any) => JSON.stringify(items(body)).includes("Le Place");

describe("GET /compass/feed over a pipeline flag read that failed after the route's (§110, D-W11X2-100)", () => {
  it("FB0 CONTROL: every read healthy → the feed serves the place", async () => {
    const { status, body } = await feed(fakeClient());
    assert.equal(status, 200);
    assert.ok(hasPlace(body), JSON.stringify(body).slice(0, 300));
  });
  it("FB1 the pipeline's COMPASS_% read fails after the route's succeeded → the flags refusal, never sections: [] alone", async () => {
    const { status, body } = await feed(fakeClient(1));
    assert.equal(status, 200);
    assert.ok(!(!hasPlace(body) && body.refusal == null), `the fail-safe map's feed (every candidate withheld) was served as the feed: ${JSON.stringify(body).slice(0, 300)}`);
    assert.equal(body.refusal?.code, "compass_flags_unreadable", JSON.stringify(body).slice(0, 300));
  });
  it("FB2 ... and nothing was cached: the next healthy request serves the place", async () => {
    await feed(fakeClient(1));
    invalidateFlagsCache(); clearCompassProfileCache(); _resetRateLimit();
    const { body } = await feed(fakeClient());
    assert.ok(hasPlace(body), `a refused feed was cached as complete: ${JSON.stringify(body).slice(0, 300)}`);
  });
});

describe("the front-load's first feed page over a failed pipeline flag read (§110, D-W11X2-100)", () => {
  const profile = { userId: VIEWER, currentCity: "Paris", blockedUserIds: [], blockerUserIds: [], mutedUserIds: [], interests: ["food"], ignoredItemIds: [] } as unknown as CompassProfile;
  const firstPage = (p: any) => (p.tier1 ?? p.items ?? []).concat(p.tier0 ?? []).find?.((i: any) => i.type === "first_feed_page") ?? (JSON.stringify(p).includes("first_feed_page") ? p : null);
  it("FL1 → no first page, never an empty feed preloaded as the first page", async () => {
    const payload: any = await buildFrontLoadPayload(fakeClient(0) as any, VIEWER, profile);
    const page = firstPage(payload);
    assert.ok(page, "the first_feed_page item is present");
    const data = page.data;
    assert.ok(data === null || hasPlace(data), `an empty fail-safe feed was preloaded as the first page: ${JSON.stringify(data).slice(0, 300)}`);
  });
  it("FLc CONTROL: healthy reads → the first page carries the place", async () => {
    const payload: any = await buildFrontLoadPayload(fakeClient() as any, VIEWER, profile);
    const page = firstPage(payload);
    assert.ok(page && page.data && hasPlace(page.data), JSON.stringify(page).slice(0, 300));
  });
});
