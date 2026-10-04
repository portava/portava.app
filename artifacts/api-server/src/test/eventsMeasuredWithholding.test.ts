/**
 * census-discovery §123 (DV-83 round 24, lane DISC-DV83; the round-23 verifier's survivors Z4, Z4b, Z4c and Z11):
 * `truncated` on an events list says a READ could not be made. It is never said over a withholding the server measured.
 *
 * §122 (SW28) made near-trip, the city alias and /nearby mark their answer `truncated` when an event is withheld over a
 * failed block, friendship or eligibility read; §118 (B28) did the same for /search, /following and /circles. Every
 * test of those marks drove the FAILED read. Nothing pinned the other half of the rule: an event withheld because the
 * read ANSWERED (the host blocked the viewer, the viewer is not the host's friend, the viewer is banned) is the whole
 * list for this viewer, and saying `truncated` over it tells the client to draw "some events could not be loaded" and
 * to keep paging for rows that do not exist. Four mutations that widen the mark from `unread` to any withholding
 * survived the round-23 verifier. These fixtures kill them: each withholds the event over a read that answers and
 * asserts the answer carries no `truncated`.
 *
 *   MB  on each of near-trip, the city alias, /nearby, /search, /following and /circles: the host blocked the viewer
 *       (the blocks read ANSWERS) → the event withheld, no `truncated`
 *   MF  on each of near-trip, the city alias and /nearby: a friends-only event and no friendship (the read ANSWERS)
 *       → the event withheld, no `truncated`
 *   ME  on each of the six: the viewer is banned from the event (the ban read ANSWERS) → the event withheld, no `truncated`
 *   MC  CONTROL on each of the six: nothing withholds the event → listed, no `truncated`
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, HOST, VIEWER } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const TRIP = "99999999-9999-4999-8999-999999999999";
const base = {
  trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }],
  trips: [{ id: TRIP, destination_city: "Lisbon", start_date: "2030-01-01", end_date: "2030-01-10" }],
  user_friendships: [] as Record<string, any>[],
  user_follows: [{ follower_id: VIEWER, following_id: HOST }],
  circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "active" }],
  event_saves: [], collections: [], collection_items: [],
};
function setup(o: { ev?: Record<string, any>; blocks?: Record<string, any>[]; banned?: string[] } = {}) {
  world({
    ev: { state: "open", visibility: "public", city: "Lisbon", circle_id: HOST, title: "Rooftop quiz", starts_at: "2030-01-05T18:00:00.000Z", ...(o.ev ?? {}) },
    extra: { ...base, ...(o.blocks ? { blocks: o.blocks } : {}) }, rsvps: [], banned: o.banned,
  });
}
async function get(path: string) {
  const s = await eventsServer();
  try {
    const r = await s.req("t-viewer", "GET", path);
    return { status: r.status, listed: ((r.body?.events ?? []) as any[]).some((e) => e.id === EVENT), truncated: r.body?.truncated ?? null, text: r.text.slice(0, 300) };
  } finally { s.close(); }
}
const ALIASES = [["near-trip", `/events/near-trip/${TRIP}`], ["city alias", "/events/city/Lisbon"], ["nearby", "/events/nearby?lat=38.72&lng=-9.14&radiusKm=10"]] as const;
const KEYED = [["search", "/events/search?q=Rooftop"], ["following", "/events/following"], ["circles", "/events/circles"]] as const;
const ALL = [...ALIASES, ...KEYED];
const WITHHELD_WHOLE = { status: 200, listed: false, truncated: null };

describe("census-discovery §123 (Z4, Z4b, Z4c, Z11): a measured withholding is the whole list, never `truncated`", () => {
  after(() => _setTestClient(null as any, false));
  for (const [name, path] of ALL) {
    it(`MC CONTROL ${name}: nothing withholds the event → listed, no truncated`, async () => {
      setup(); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.listed, truncated: r.truncated }, { status: 200, listed: true, truncated: null }, r.text);
    });
    it(`MB ${name}: the host blocked the viewer (the read answers) → withheld, no truncated`, async () => {
      setup({ blocks: [{ blocker_id: HOST, blocked_id: VIEWER }] }); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.listed, truncated: r.truncated }, WITHHELD_WHOLE, r.text);
    });
    it(`ME ${name}: the viewer is banned from the event (the read answers) → withheld, no truncated`, async () => {
      setup({ banned: [VIEWER] }); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.listed, truncated: r.truncated }, WITHHELD_WHOLE, r.text);
    });
  }
  for (const [name, path] of ALIASES) {
    it(`MF ${name}: a friends-only event and no friendship (the read answers) → withheld, no truncated`, async () => {
      setup({ ev: { visibility: "friends_only" } }); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.listed, truncated: r.truncated }, WITHHELD_WHOLE, r.text);
    });
  }
});
