/**
 * census-discovery §107 (DV-83 round 10, lane W11-X2, register D-W11X2-68): GET /compass/telegraph
 * — the cards behind Telegraph's "Ask Compass" chip — never answers a failed read as "no
 * suggestions", and never answers an unread flag table as "Compass Telegraph is off".
 *
 * §107.1 BK2: the route served the hydrated pool without reading `compassHydrationFailedSources`
 * (D-W11X2-54's contract for every caller that serves the pool), its catch answered
 * `{ cards: [], city: null }`, a failed profile read answered `{ cards: [] }`, and COMPASS_TELEGRAPH
 * was read through the fail-safe map, so an unread table was the flag-off `404 feature_disabled`.
 * The tray drew all of them as "Compass couldn't find relevant recommendations for this chat".
 *
 *   TG0  CONTROL (V9-TG0): healthy reads → the public event is a card, no refusal
 *   TG1  (V9-TG1) every candidate read fails → refusal `nothing`, never 200 { cards: [] } alone
 *   TG1b a card source fails while another serves → the cards AND a `partial` refusal
 *   TG1c CONTROL: a source that can never be a Telegraph card (posts) fails → no refusal
 *   TG2  (V9-TG2) the COMPASS_% table is unread → a refusal, never `feature_disabled`
 *   TG2c CONTROL: COMPASS_TELEGRAPH READ and off → exactly the old 404
 *   TG3  the build throws → a refusal, never `{ cards: [], city: null }` alone
 *   TG4  the viewer's Compass profile cannot be built → a refusal
 *   TG5  the thread's context read fails → a refusal (the city the cards are for is unknown)
 *   TG5b a trip thread's trip read fails → a refusal (never the viewer's own city instead)
 *   TG5c no city anywhere else and the participants' city read fails → a refusal
 *   TG5d no city anywhere else and the participant list read fails → a refusal
 *   TG6  the membership read fails → a refusal, never 403 "Not a member of this thread"
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
import { compassWorld, THREAD, TOKEN, EVENT_ID, DB_ERR, CANDIDATE_SOURCES, type WorldOpts } from "./helpers/compassReadWorld.js";

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

async function get(): Promise<{ status: number; text: string; body: any }> {
  const r = await fetch(`${base}/compass/telegraph?threadId=${THREAD}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
}
function assertRefused(r: { status: number; body: any }, coverage: "nothing" | "partial", sources: string[]) {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.refusal, `no refusal: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.refusal.coverage, coverage);
  assert.deepEqual(r.body.refusal.failedSources, sources);
  assert.equal(r.body.refusal.route, "GET /compass/telegraph");
}

describe("census-discovery §107 (DV-83, D-W11X2-68): GET /compass/telegraph over a failed read", () => {
  it("TG0 (V9-TG0) CONTROL: healthy reads → the public event is a card, no refusal", async () => {
    serve();
    const r = await get();
    assert.equal(r.status, 200);
    assert.ok(r.body.cards.some((c: any) => c.id === EVENT_ID), r.text);
    assert.equal(r.body.refusal, undefined);
    assert.equal(r.body.city, "Paris");
  });

  it("TG1 (V9-TG1) every candidate read fails → refusal nothing, never 200 { cards: [] } alone", async () => {
    serve({ failTables: CANDIDATE_SOURCES });
    const r = await get();
    assert.deepEqual(r.body.cards, []);
    assertRefused(r, "nothing", ["discovery_places", "events", "hidden_gems"]);
  });

  it("TG1b a card source fails while another serves → the cards AND a partial refusal", async () => {
    serve({ failTables: ["discovery_places"] });
    const r = await get();
    assert.ok(r.body.cards.some((c: any) => c.id === EVENT_ID), r.text);
    assertRefused(r, "partial", ["discovery_places"]);
  });

  it("TG1c CONTROL: a source that is never a Telegraph card (posts) fails → no refusal", async () => {
    serve({ failTables: ["posts", "rent_buddy_profiles"] });
    const r = await get();
    assert.ok(r.body.cards.some((c: any) => c.id === EVENT_ID), r.text);
    assert.equal(r.body.refusal, undefined);
  });

  it("TG2 (V9-TG2) the COMPASS_% table is unread → a refusal, never feature_disabled", async () => {
    serve({ flagsFail: true });
    const r = await get();
    assert.notEqual(r.body.error, "feature_disabled", r.text);
    assertRefused(r, "nothing", ["feature_flags"]);
    assert.deepEqual(r.body.cards, []);
  });

  it("TG2c CONTROL: COMPASS_TELEGRAPH READ and off → exactly the old 404", async () => {
    serve({ flags: { COMPASS_ENABLED: true, COMPASS_TELEGRAPH: false } });
    const r = await get();
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
    assert.equal(r.body.refusal, undefined);
  });

  it("TG3 the build throws → a refusal, never { cards: [], city: null } alone", async () => {
    serve({ answer: (table) => { if (table === "message_threads") throw new Error("boom"); return undefined; } });
    const r = await get();
    assertRefused(r, "nothing", ["compass_telegraph"]);
  });

  it("TG4 the viewer's Compass profile cannot be built (a safety list is unread) → a refusal", async () => {
    serve({ failTables: ["blocks"] });
    const r = await get();
    assertRefused(r, "nothing", ["compass_profile"]);
  });

  it("TG5 the thread's context read fails → a refusal (the cards' city is unknown)", async () => {
    serve({ failTables: ["message_threads"] });
    const r = await get();
    assertRefused(r, "nothing", ["message_threads"]);
  });

  it("TG5b a trip thread's trip read fails → a refusal (never the viewer's own city instead)", async () => {
    serve({ answer: (table, _c, single) => (table === "message_threads" && single ? { data: { thread_type: "trip", trip_id: "a1000000-0000-4000-a000-000000000001" }, error: null } : table === "trips" ? { data: null, error: DB_ERR } : undefined) });
    const r = await get();
    assertRefused(r, "nothing", ["trips"]);
  });

  const OTHER = "a3000000-0000-4000-a000-000000000003";
  it("TG5c no city anywhere else and the participants' city read fails → a refusal", async () => {
    serve({ city: null, answer: (table, calls, single) => (table === "message_thread_members" && !single ? { data: [{ user_id: OTHER }], error: null } : table === "profiles" && calls.some(([k]) => k === "in") ? { data: null, error: DB_ERR } : undefined) });
    const r = await get();
    assertRefused(r, "nothing", ["profiles"]);
  });

  it("TG5d no city anywhere else and the participant list read fails → a refusal", async () => {
    serve({ city: null, answer: (table, _c, single) => (table === "message_thread_members" && !single ? { data: null, error: DB_ERR } : undefined) });
    const r = await get();
    assertRefused(r, "nothing", ["message_thread_members"]);
  });

  it("TG5e CONTROL: no city anywhere and every read answered → cards for no city, no refusal", async () => {
    serve({ city: null, answer: (table, _c, single) => (table === "message_thread_members" && !single ? { data: [{ user_id: OTHER }], error: null } : undefined) });
    const r = await get();
    assert.equal(r.status, 200);
    assert.equal(r.body.refusal, undefined, r.text);
  });

  it("TG6 the membership read fails → a refusal, never 403 'Not a member of this thread'", async () => {
    serve({ answer: (table, _calls, single) => (table === "message_thread_members" && single ? { data: null, error: DB_ERR } : undefined) });
    const r = await get();
    assert.notEqual(r.status, 403, r.text);
    assertRefused(r, "nothing", ["message_thread_members"]);
  });
});
