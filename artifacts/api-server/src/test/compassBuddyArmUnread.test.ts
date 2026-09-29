/**
 * census-discovery §108 sweep (DV-83 round 11, lane W11-X2; D-W11X2-84). GET /compass/recommendations
 * `surface=buddy` — Rent-a-Buddy's "Compass Picks" (CompassBuddyRow) — bypasses the hydrator, so
 * none of the hydrator's failure naming reached it:
 *   - the `rent_buddy_availability` read ignored its `.error`: every buddy became "not available",
 *     which decides the ranking (and so which four are shown) and each card's availability badge;
 *   - the `rent_buddy_profiles` and availability reads had no bound: at db-max-rows (1000) PostgREST
 *     cuts them silently, and the picks were ranked over the subset as complete;
 *   - with no city asked for and the viewer's location UNREAD, the arm answered `[]`, the body of a
 *     viewer who shares no city — "no buddies" over a failed read.
 *
 *   BA0  CONTROL: two buddies, every read answered → both, no refusal
 *   BA1  the availability read fails → the buddies, refusal `partial` naming rent_buddy_availability
 *   BA2  the buddy read is cut at db-max-rows (count > rows) → refusal `partial` naming rent_buddy_profiles
 *   BA3  the availability read is cut (count > rows) → refusal `partial` naming rent_buddy_availability
 *   BA4  no city asked, the location read fails → refusal `nothing` naming user_location_state, never `[]` alone
 *   BA4c CONTROL: no city asked, no location row (read, none shared) → `[]`, no refusal
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/compassBuddyArmUnread.test.ts
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
import { clearCompassProfileCache } from "../compass/CompassProfileService.js";
import { compassWorld, TOKEN, DB_ERR, type WorldOpts } from "./helpers/compassReadWorld.js";

let base = "";
let server: Server;
function serve(opts: WorldOpts = {}) { _setTestClient(compassWorld(opts).client as any, true); }

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
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); clearCompassProfileCache(); });

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: await r.json() };
}

const buddy = (n: number) => ({ id: `bd000000-0000-4000-a000-00000000000${n}`, user_id: `bu000000-0000-4000-a000-00000000000${n}`, display_name: `Buddy ${n}`, city: "Paris", country: "FR", categories: ["food"], languages: ["English"], hourly_rate_usd: 20, status: "active", verified: true, average_rating: 4.5, review_count: 3, cover_photo_url: null, admin_status: "active", risk_hold: false });
const today = () => new Date().toISOString().slice(0, 10);

function buddyWorld(o: { availFails?: boolean; buddyCount?: number; availCount?: number; loc?: "readable" | "fails" | "none" } = {}): WorldOpts {
  return {
    city: o.loc === "none" ? null : "Paris",
    answer: (table) => {
      if (table === "user_location_state" && o.loc === "fails") return { data: null, error: DB_ERR };
      if (table === "rent_buddy_profiles") return { data: [buddy(1), buddy(2)], error: null, ...(o.buddyCount !== undefined ? { count: o.buddyCount } : {}) } as any;
      if (table === "rent_buddy_availability") return o.availFails ? { data: null, error: DB_ERR } : ({ data: [{ buddy_id: buddy(2).id, date: today() }], error: null, ...(o.availCount !== undefined ? { count: o.availCount } : {}) } as any);
      return undefined;
    },
  };
}

describe("§108 sweep: surface=buddy over a failed, truncated or unread read", () => {
  it("BA0 CONTROL: every read answered → both buddies, the available one first, no refusal", async () => {
    serve(buddyWorld());
    const { status, body } = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(status, 200);
    assert.deepEqual(body.recommendations.map((r: any) => r.title), ["Buddy 2", "Buddy 1"], JSON.stringify(body));
    assert.equal(body.refusal, undefined);
  });
  it("BA1 the availability read fails → the buddies, refusal `partial` naming rent_buddy_availability", async () => {
    serve(buddyWorld({ availFails: true }));
    const { body } = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(body.recommendations.length, 2, JSON.stringify(body));
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["rent_buddy_availability"]);
  });
  it("BA2 the buddy read is cut at db-max-rows (count > rows) → refusal `partial` naming rent_buddy_profiles", async () => {
    serve(buddyWorld({ buddyCount: 2500 }));
    const { body } = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["rent_buddy_profiles"]);
  });
  it("BA3 the availability read is cut (count > rows) → refusal `partial` naming rent_buddy_availability", async () => {
    serve(buddyWorld({ availCount: 1400 }));
    const { body } = await get("/compass/recommendations?surface=buddy&city=Paris&limit=4");
    assert.equal(body.refusal?.coverage, "partial", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["rent_buddy_availability"]);
  });
  it("BA4 no city asked, the location read fails → refusal `nothing` naming user_location_state", async () => {
    serve(buddyWorld({ loc: "fails" }));
    const { body } = await get("/compass/recommendations?surface=buddy&limit=4");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["user_location_state"]);
  });
  it("BA4c CONTROL: no city asked, no location row (read, none shared) → [] and no refusal", async () => {
    serve(buddyWorld({ loc: "none" }));
    const { body } = await get("/compass/recommendations?surface=buddy&limit=4");
    assert.deepEqual(body.recommendations, []);
    assert.equal(body.refusal, undefined, JSON.stringify(body));
  });
});
