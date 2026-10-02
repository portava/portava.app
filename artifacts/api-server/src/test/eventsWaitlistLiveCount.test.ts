/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B20, probes WL0/WL1): a list never serves
 * a cached `waitlist_count` that a failed recount left stale as a measured count.
 *
 * Round 19 (SW11) made every waitlist write leave `events.waitlist_count` alone when its recount read failed, rather
 * than stamp 0. That is right for the write, but it leaves the counter at its value from BEFORE the write, and GET
 * /events, its city alias and GET /events/nearby served the column as `waitlistCount` without ever recounting it, so
 * the stale count reached the cards ("· 2 waiting" over a one-person queue) as measured.
 *
 * The honest option, of the three the verifier named: the lists recount the waitlist live, as GET /events already
 * recounts `going_count` (BUG AY). A stamped staleness mark would need a column (a migration) and is only as good as
 * every write remembering to set it; an atomic delta would need an RPC and still trusts a counter that may already have
 * drifted. A live recount is right whatever left the column stale. A live read that fails keeps the cached count and is
 * named in `failedSources: ["event_waitlist"]` (the B14 contract); a healthy body gains no key.
 *
 *   WL0  CONTROL: W1 leaves, the recount answers → waitlist_count is re-stamped
 *   WL1  W1 leaves, the recount FAILS → no stamp (SW11); GET /events over the rows that leaves (queue [W2], counter 2)
 *        serves waitlistCount 1, the live queue
 *   WL2  the same state on GET /events/city/:city → 1
 *   WL3  the same state on GET /events/nearby → 1
 *   WL4  GET /events, the live waitlist read FAILS → the cached 2, and `event_waitlist` is named
 *   WL4b the same on GET /events/city/:city
 *   WL4c the same on GET /events/nearby
 *   WL0c CONTROL: GET /events, every read answers → the live count, no failedSources key
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FakeReadContext } from "./helpers/failClosedSupabase.js";
import { world, eventsServer, stamps, eventsUpdates, offerRow, ERR, EVENT, W1, W2 } from "./helpers/eventsWorld.js";

const onlyEventFilter = (c: FakeReadContext) => c.filters.length === 1 && c.eq("event_id") === EVENT;
const waitlistRecountFails = (c: FakeReadContext) => (c.table === "event_waitlist" && onlyEventFilter(c) ? ERR : null);
/** The lists' live waitlist read: every pool event at once, no user filter. */
const listWaitlistReadFails = (c: FakeReadContext) => (c.table === "event_waitlist" && c.filters.some((f) => f.op === "in" && f.col === "event_id") && c.eq("user_id") === undefined ? ERR : null);

describe("census-discovery §117 (B20): the lists recount the waitlist live", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());

  const queue = [offerRow(W1, 1, null), offerRow(W2, 2, null)];
  const leave = () => srv.req("t-w1", "DELETE", `/events/${EVENT}/waitlist`);
  /** The rows a leave whose recount failed leaves behind: the queue is [W2], the counter still says 2. */
  const staleState = (failOn?: (c: FakeReadContext) => any) => world({ waitlist: [offerRow(W2, 1, null)], ev: { state: "open", waitlist_count: 2 }, failOn });
  const listed = async (path: string) => {
    const r = await srv.req("t-viewer", "GET", path);
    const ev = (r.body?.events ?? [])[0] ?? {};
    return { r, ev, seen: JSON.stringify({ status: r.status, n: (r.body?.events ?? []).length, waitlistCount: ev.waitlistCount, failedSources: r.body?.failedSources, keys: Object.keys(r.body ?? {}) }) };
  };
  const PATHS = { list: "/events?limit=50", city: "/events/city/Lisbon?limit=50", nearby: "/events/nearby?lat=38.72&lng=-9.14&radiusKm=10" };

  it("WL0 CONTROL: W1 leaves, the recount answers → waitlist_count is re-stamped", async () => {
    const w = world({ waitlist: queue, ev: { waitlist_count: 2 } }); const r = await leave();
    assert.equal(r.status, 200, r.text);
    assert.equal(stamps(w.writes, "waitlist_count").length, 1, JSON.stringify(eventsUpdates(w.writes)));
  });
  it("WL1 W1 leaves, the recount FAILS → no stamp; GET /events then serves the live queue, never the stale 2", async () => {
    const w = world({ waitlist: queue, ev: { waitlist_count: 2 }, failOn: waitlistRecountFails }); const r = await leave();
    assert.equal(r.status, 200, r.text);
    assert.ok(w.writes.some((x) => x.table === "event_waitlist" && x.kind === "delete"), "W1's row was deleted");
    assert.deepEqual(stamps(w.writes, "waitlist_count"), [], "SW11: no stamp over a failed recount");
    staleState();
    const l = await listed(PATHS.list);
    assert.equal(l.r.status, 200, l.r.text);
    assert.equal(l.ev.waitlistCount, 1, `a counter left stale by a failed recount served as measured: ${l.seen}`);
  });
  it("WL2 the same state on GET /events/city/:city → the live queue", async () => {
    staleState(); const l = await listed(PATHS.city);
    assert.equal(l.r.status, 200, l.r.text);
    assert.equal(l.ev.waitlistCount, 1, l.seen);
  });
  it("WL3 the same state on GET /events/nearby → the live queue", async () => {
    staleState(); const l = await listed(PATHS.nearby);
    assert.equal(l.r.status, 200, l.r.text);
    assert.equal(l.ev.waitlistCount, 1, l.seen);
  });
  for (const [id, key] of [["WL4", "list"], ["WL4b", "city"], ["WL4c", "nearby"]] as const) {
    it(`${id} ${PATHS[key]}: the live waitlist read FAILS → the cached count, and event_waitlist is named`, async () => {
      staleState(listWaitlistReadFails); const l = await listed(PATHS[key]);
      assert.equal(l.r.status, 200, l.r.text);
      assert.equal(l.ev.waitlistCount, 2, l.seen);
      assert.ok((l.r.body.failedSources ?? []).includes("event_waitlist"), l.seen);
    });
  }
  it("WL0c CONTROL: GET /events, every read answers → the live count, no failedSources key", async () => {
    staleState(); const l = await listed(PATHS.list);
    assert.equal(l.ev.waitlistCount, 1, l.seen);
    assert.equal("failedSources" in l.r.body, false, l.seen);
  });
});
