/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; B21): `recountEventWaitlist` reads the whole queue, never a page
 * PostgREST's db-max-rows cut.
 *
 * POST /events/:id/join at capacity seats the viewer on the waitlist and restamps `waitlist_count` through
 * `recountEventWaitlist`. Its read was one unbounded `event_waitlist` read, so past 1000 queued travellers the counter
 * was stamped 1000. GW1 (eventsGoingPaged) pins the leave's inline recount; this pins the helper.
 *
 *   GW2  an open event at capacity with 1250 queued, every answer capped at 1000 → the stamp equals the uncapped one
 *   GW2c CONTROL: the same with 3 queued → the stamp equals the uncapped one
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, stamps, EVENT, HOST, W2 } from "./helpers/eventsWorld.js";

const queue = (n: number) => Array.from({ length: n }, (_, i) => ({ event_id: EVENT, user_id: `q-${String(i).padStart(5, "0")}`, position: i + 1, offer_expires_at: null }));

describe("census-discovery §117 (B21): the join's waitlist recount reads the whole queue", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());

  const stamped = async (n: number, dbMaxRows?: number) => {
    const w = world({
      ev: { state: "open", visibility: "public", max_attendees: 2, capacity: 2, going_count: 2, waitlist_enabled: true, waitlist_count: n },
      rsvps: [{ event_id: EVENT, user_id: HOST, status: "going" }, { event_id: EVENT, user_id: W2, status: "going" }],
      waitlist: queue(n), dbMaxRows,
    });
    const r = await srv.req("t-w1", "POST", `/events/${EVENT}/join`, {});
    assert.equal(r.status, 202, r.text);
    return stamps(w.writes, "waitlist_count");
  };

  it("GW2 1250 queued, capped at 1000 → the uncapped stamp", async () => {
    const whole = await stamped(1250);
    assert.equal(whole.length, 1, JSON.stringify(whole));
    assert.ok((whole[0] as number) >= 1250, JSON.stringify(whole));
    assert.deepEqual(await stamped(1250, 1000), whole);
  });
  it("GW2c CONTROL: 3 queued, capped at 1000 → the uncapped stamp", async () => {
    const whole = await stamped(3);
    assert.equal(whole.length, 1, JSON.stringify(whole));
    assert.deepEqual(await stamped(3, 1000), whole);
  });
});
