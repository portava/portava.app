/**
 * census-discovery §108 (DV-83 round 11, lane W11-X2; D-W11X2-77). §108.1 BK3: GET /compass/telegraph
 * resolves a thread with no trip city from the viewer's own Compass profile city, and only then from
 * the other participants' home cities. When the viewer's `user_location_state` read failed, the
 * profile's city was null (with `locationUnread`) and the route fell through to a participant's city;
 * the cards were then drawn for that city as a complete answer, and the hydrator's
 * `user_location_state` marker was masked because the effective profile now had a city.
 *
 * V10-* cases are the round-10 verifier's probes (scratchpad v10-probes/zz-v10-presenceTelegraphCity),
 * copied in unchanged apart from the harness they share.
 *
 *   V10-TC0  CONTROL: the viewer's city is readable (Paris) → the cards are for Paris
 *   V10-TC1  the viewer's user_location_state read fails, a participant lives in Lisbon → never Lisbon's cards as complete
 *   TC1b     ... and the refusal names user_location_state, with no cards and no city
 *   TC2      the viewer's profile cannot be built the first time (a safety list unread) and can the second →
 *            a refusal naming compass_profile, never the participant's city
 *   TC3      CONTROL: the viewer shares no location (read, no row) → the participant's city, as before
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy node --import tsx/esm --test src/test/compassTelegraphCityUnread.test.ts
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
import { compassWorld, TOKEN, VIEWER, THREAD, DB_ERR, type WorldOpts } from "./helpers/compassReadWorld.js";

const OTHER = "a3000000-0000-4000-a000-000000000003";

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

/** A group thread (no trip) of the viewer and OTHER, who lives in Lisbon. */
function tgWorld(loc: "readable" | "fails" | "none", extra?: WorldOpts["answer"]): WorldOpts {
  return {
    city: loc === "none" ? null : "Paris",
    answer: (table, calls, single) => {
      const hasIn = (col: string) => calls.some(([k, a]) => k === "in" && a[0] === col);
      const custom = extra?.(table, calls, single);
      if (custom) return custom;
      if (table === "user_location_state" && loc === "fails") return { data: null, error: DB_ERR };
      if (table === "message_thread_members" && !single) return { data: [{ user_id: VIEWER }, { user_id: OTHER }], error: null };
      if (table === "message_threads") return { data: { thread_type: "group", trip_id: null }, error: null };
      if (table === "profiles" && hasIn("id") && calls.some(([k, a]) => k === "select" && a[0] === "home_city")) return { data: [{ home_city: "Lisbon" }], error: null };
      return undefined;
    },
  };
}

describe("§108 (BK3) Telegraph's city over an unread viewer location", () => {
  it("V10-TC0 CONTROL: viewer city readable → the cards are for Paris", async () => {
    serve(tgWorld("readable"));
    const { status, body } = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(status, 200);
    assert.equal(body.city, "Paris", JSON.stringify(body));
  });
  it("V10-TC1 viewer's user_location_state read fails, a participant lives in Lisbon → must not be Lisbon's cards as complete", async () => {
    serve(tgWorld("fails"));
    const { status, body } = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(status, 200);
    assert.ok(body.refusal || body.city !== "Lisbon", `served city=${body.city} cards=${body.cards?.length} refusal=${JSON.stringify(body.refusal)}`);
  });
  it("TC1b ... the refusal is `nothing`, names user_location_state, and carries no cards and no city", async () => {
    serve(tgWorld("fails"));
    const { body } = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["user_location_state"]);
    assert.deepEqual(body.cards, []);
    assert.equal(body.city, null);
  });
  it("TC2 the profile cannot be built the first time and can the second → a refusal naming compass_profile, never Lisbon", async () => {
    let homeCityRead = false;
    serve(tgWorld("readable", (table, calls) => {
      if (table === "profiles" && calls.some(([k, a]) => k === "select" && a[0] === "home_city")) homeCityRead = true;
      if (table === "blocks" && !homeCityRead) return { data: null, error: DB_ERR };
      return undefined;
    }));
    const { status, body } = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(status, 200);
    assert.notEqual(body.city, "Lisbon", JSON.stringify(body));
    assert.equal(body.refusal?.coverage, "nothing", JSON.stringify(body));
    assert.deepEqual(body.refusal?.failedSources, ["compass_profile"]);
  });
  it("TC3 CONTROL: the viewer shares no location (read, no row) → the participant's city, no refusal", async () => {
    serve(tgWorld("none"));
    const { status, body } = await get(`/compass/telegraph?threadId=${THREAD}`);
    assert.equal(status, 200);
    assert.equal(body.city, "Lisbon", JSON.stringify(body));
    assert.equal(body.refusal, undefined, JSON.stringify(body));
  });
});
