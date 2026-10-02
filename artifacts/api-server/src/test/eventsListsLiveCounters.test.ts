/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; sweep SW18): every events read that serves `goingCount` and
 * `waitlistCount` recounts them live, as GET /events, its city alias and GET /events/nearby do since B20.
 *
 * `events.going_count` and `events.waitlist_count` are cached counters that drift: round 19 (SW11) made every write
 * leave a counter alone when its recount read failed, by design, so a counter can be stale after any write. B20 made the
 * three Discovery lists recount both live. Eleven more reads served the cached columns as measured: the viewer's own
 * lists (`/events/me`, `/hosting`, `/joined`, `/saved`), the social ones (`/following`, `/circles`), `/search`,
 * `/near-trip/:tripId`, the event an invite or a join request names, and the share-link preview. They now go through
 * the same `liveEventCounters` (lib/eventRowReads.ts): a live read that fails or is cut keeps the cached count and is
 * named in `failedSources` (`event_rsvps`, `event_waitlist`); a healthy body gains no key.
 *
 * The state every case starts from: the counters say 5 going and 3 waiting, the rows say 1 and 1.
 *   LS-<route>  every read answers → goingCount 1 and waitlistCount 1, the live rows
 *   LF-<route>  the live reads FAIL → the cached 5 and 3, and both reads are named
 *   LC-<route>  CONTROL: every read answers → no failedSources key
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FakeReadContext } from "./helpers/failClosedSupabase.js";
import { world, eventsServer, offerRow, ERR, EVENT, HOST, VIEWER, W2 } from "./helpers/eventsWorld.js";

const TRIP = "77777777-7777-4777-8777-777777777777";
const TOKEN = "share-token-0001";

/** The live recount reads: one event set at once (`in event_id`), no viewer filter. */
const liveReadsFail = (c: FakeReadContext) =>
  (c.table === "event_rsvps" || c.table === "event_waitlist") && c.filters.some((f) => f.op === "in" && f.col === "event_id") && c.eq("user_id") === undefined ? ERR : null;

const extra = {
  user_follows: [{ follower_id: VIEWER, following_id: HOST }],
  circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "accepted", created_at: "2026-09-01T00:00:00.000Z" }],
  event_saves: [{ user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-02T00:00:00.000Z" }],
  trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }],
  trips: [{ id: TRIP, destination_city: "Lisbon", start_date: null, end_date: null }],
  event_invites: [{ id: "i1", event_id: EVENT, invitee_id: VIEWER, inviter_id: HOST, status: "pending", created_at: "2026-09-03T00:00:00.000Z" }],
  event_join_requests: [{ id: "r1", event_id: EVENT, user_id: VIEWER, status: "pending", message: null, created_at: "2026-09-03T00:00:00.000Z" }],
  event_share_links: [{ id: "s1", token: TOKEN, event_id: EVENT, expires_at: null, max_uses: null, use_count: 0 }],
};
const stale = (failOn?: (c: FakeReadContext) => any) => world({
  ev: { state: "open", going_count: 5, waitlist_count: 3, circle_id: HOST },
  rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }],
  waitlist: [offerRow(W2, 1, null)],
  extra, failOn,
});

type Pick = (b: any) => any;
const first: Pick = (b) => (b?.events ?? [])[0];
const ROUTES: Array<[string, string, string, Pick]> = [
  ["me", "t-viewer", "/events/me", first],
  ["hosting", "t-host", "/events/hosting", first],
  ["joined", "t-viewer", "/events/joined", first],
  ["saved", "t-viewer", "/events/saved", first],
  ["following", "t-viewer", "/events/following", first],
  ["circles", "t-viewer", "/events/circles", first],
  ["search", "t-viewer", "/events/search?q=Rooftop", first],
  ["near-trip", "t-viewer", `/events/near-trip/${TRIP}`, first],
  ["invites", "t-viewer", "/events/invites", (b) => (b?.invites ?? [])[0]?.event],
  ["requests", "t-viewer", "/events/requests", (b) => (b?.requests ?? [])[0]?.event],
  ["preview", "t-viewer", `/events/share-link/${TOKEN}/preview`, (b) => b?.event],
];

describe("census-discovery §117 (SW18): every events read recounts the cached counters live", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());

  const read = async (token: string, path: string, pick: Pick) => {
    const r = await srv.req(token, "GET", path);
    const ev = pick(r.body) ?? {};
    return { r, ev, seen: JSON.stringify({ status: r.status, id: ev.id, goingCount: ev.goingCount, waitlistCount: ev.waitlistCount, failedSources: r.body?.failedSources }).slice(0, 400) };
  };

  for (const [name, token, path, pick] of ROUTES) {
    it(`LS-${name} ${path}: every read answers → the live 1 going and 1 waiting, never the cached 5 and 3`, async () => {
      stale(); const l = await read(token, path, pick);
      assert.equal(l.r.status, 200, l.r.text.slice(0, 300));
      assert.equal(l.ev.id, EVENT, l.seen);
      assert.equal(l.ev.goingCount, 1, l.seen);
      assert.equal(l.ev.waitlistCount, 1, l.seen);
    });
    it(`LF-${name} ${path}: the live reads FAIL → the cached counts, and event_rsvps and event_waitlist are named`, async () => {
      stale(liveReadsFail); const l = await read(token, path, pick);
      assert.equal(l.r.status, 200, l.r.text.slice(0, 300));
      assert.equal(l.ev.goingCount, 5, l.seen);
      assert.equal(l.ev.waitlistCount, 3, l.seen);
      assert.deepEqual([...(l.r.body.failedSources ?? [])].sort(), ["event_rsvps", "event_waitlist"], l.seen);
    });
    it(`LC-${name} ${path}: CONTROL, every read answers → no failedSources key`, async () => {
      stale(); const l = await read(token, path, pick);
      assert.equal(l.r.status, 200, l.r.text.slice(0, 300));
      assert.equal(l.ev.id, EVENT, l.seen);
      assert.equal("failedSources" in (l.r.body ?? {}), false, l.seen);
    });
  }
});
