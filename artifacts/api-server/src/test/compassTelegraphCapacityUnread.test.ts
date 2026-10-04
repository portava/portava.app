/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B37): GET /compass/telegraph says it withheld an event
 * over an unread going count.
 *
 * Round 22 (B34, D-W11X2-174) holds a capped event whose live going read failed back as `capacity_could_not_be_checked`
 * and has the hydrator name `event_rsvps`. The route's `telegraphCoverage` kept only TELEGRAPH_CARD_SOURCES (`events`,
 * `discovery_places`, `hidden_gems`, `user_location_state`), so the name was dropped: the tray was answered `cards: []`
 * with no refusal and said "Compass couldn't find relevant recommendations for this chat". A regression made by B34's own
 * fix. `event_rsvps` can withhold an event card, so it is a card source.
 *
 *   TE0 CONTROL: healthy reads → the capped event (max 50, 3 going) is a card, no refusal
 *   TE1 the live going read (event_rsvps) FAILS → no card for it, and a refusal naming `event_rsvps` (coverage nothing)
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
import { compassWorld, THREAD, TOKEN, EVENT_ID, type WorldOpts } from "./helpers/compassReadWorld.js";

let base = ""; let server: Server;
function serve(opts: WorldOpts = {}) { _setTestClient(compassWorld(opts).client as any, true); }
before(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }; next(); });
  app.use("/api", compassRouter);
  server = createServer(app);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});
after(() => { _setTestClient(null as any, false); server.close(); });
beforeEach(() => { clearL1Cache(); invalidateFlagsCache(); _resetRateLimit(); clearCompassProfileCache(); });
async function get() {
  const r = await fetch(`${base}/compass/telegraph?threadId=${THREAD}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const text = await r.text(); const body = JSON.parse(text);
  return { status: r.status, cards: (body.cards ?? []).map((c: any) => c.id), refusal: body.refusal ?? null, text };
}

describe("census-discovery §122 (B37): GET /compass/telegraph names an unread going count", () => {
  it("TE0 CONTROL: healthy → the event is a card, no refusal", async () => {
    serve(); const r = await get();
    assert.equal(r.status, 200, r.text);
    assert.ok(r.cards.includes(EVENT_ID), r.text); assert.equal(r.refusal, null);
  });
  it("TE1 event_rsvps FAILS → the event withheld and said: a refusal naming event_rsvps", async () => {
    serve({ failTables: ["event_rsvps"] }); const r = await get();
    assert.equal(r.status, 200, r.text);
    assert.equal(r.cards.includes(EVENT_ID), false, r.text);
    assert.ok(r.refusal, r.text);
    assert.ok((r.refusal.failedSources ?? []).includes("event_rsvps"), r.text);
    assert.equal(r.refusal.coverage, r.cards.length > 0 ? "partial" : "nothing", r.text);
  });
});
