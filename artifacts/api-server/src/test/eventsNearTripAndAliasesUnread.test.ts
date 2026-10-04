/**
 * census-discovery §122 (DV-83 round 23, lane W11-X2; §119.16 B38, sweep SW28): GET /events/near-trip/:tripId never
 * answers its own failed reads as facts, and the three events lists that still withheld an event over a failed read
 * unsaid — near-trip, the city alias and /nearby — say so.
 *
 * B38. Near-trip read `trip_members` and `trips` with no error bound: a failed membership read was 403 "Must be a trip
 * member to see nearby events", a failed trip read 200 `{ events: [] }`. Both now answer 503 `degraded_unavailable`.
 * SW28. Round 21 (B28) made /search, /following and /circles say an event withheld over a failed block, friendship or
 * eligibility read (`truncated: true`); GET /events/city/:city, /events/nearby and /events/near-trip/:tripId kept the
 * unbound friendship read and the bare block check, and dropped an eligibility verdict that could not be read, so their
 * answer was the whole list with the event missing. Each now marks the answer `truncated`.
 *
 *   NT0 CONTROL: a member, a Lisbon trip → the Lisbon event listed, nothing said
 *   NT1 the trips read FAILS → 503 degraded_unavailable, never `events: []`
 *   NT2 the trip_members read FAILS → 503 degraded_unavailable, never 403
 *   NT3 CONTROL: not a member (the read answers) → 403, as before
 *   WB/WF/WE  on each of near-trip, the city alias and /nearby: the block (WB), friendship (WF, a friends-only event) or
 *             ban (WE) read FAILS → the event withheld and the answer `truncated`
 *   WC CONTROL on each: every read answers → the event listed, no `truncated`
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const TRIP = "99999999-9999-4999-8999-999999999999";
const tripRows = { trip_members: [{ trip_id: TRIP, user_id: VIEWER, role: "member" }], trips: [{ id: TRIP, destination_city: "Lisbon", start_date: "2030-01-01", end_date: "2030-01-10" }], user_friendships: [] };
function setup(failOn?: (c: any) => any, ev: Record<string, any> = {}, extra: Record<string, any[]> = tripRows) {
  world({ ev: { state: "open", visibility: "public", city: "Lisbon", starts_at: "2030-01-05T18:00:00.000Z", ...ev }, extra, rsvps: [], failOn });
}
async function get(path: string) {
  const s = await eventsServer();
  try { const r = await s.req("t-viewer", "GET", path); return { status: r.status, code: r.body?.code ?? r.body?.error ?? null, events: (r.body?.events ?? []).map((e: any) => e.id), truncated: r.body?.truncated ?? null, text: r.text }; } finally { s.close(); }
}
const blocksRead = (c: any) => (c.table === "blocks" ? ERR : null);
const friendsRead = (c: any) => (c.table === "user_friendships" ? ERR : null);
const banRead = (c: any) => (c.table === "event_roles" && c.filters.some((f: any) => f.col === "role" && f.val === "banned") ? ERR : null);
const PATHS = [["near-trip", `/events/near-trip/${TRIP}`], ["city alias", "/events/city/Lisbon"], ["nearby", "/events/nearby?lat=38.72&lng=-9.14&radiusKm=10"]] as const;

describe("census-discovery §122 (B38): GET /events/near-trip never answers its own failed reads as facts", () => {
  after(() => _setTestClient(null as any, false));
  it("NT0 CONTROL: member, Lisbon trip → the event listed, nothing said", async () => {
    setup(); const r = await get(`/events/near-trip/${TRIP}`);
    assert.deepEqual({ status: r.status, events: r.events, truncated: r.truncated }, { status: 200, events: [EVENT], truncated: null }, r.text);
  });
  it("NT1 the trips read FAILS → 503 degraded_unavailable", async () => {
    setup((c) => (c.table === "trips" ? ERR : null)); const r = await get(`/events/near-trip/${TRIP}`);
    assert.equal(r.status, 503, r.text); assert.match(r.text, /degraded_unavailable/);
  });
  it("NT2 the trip_members read FAILS → 503 degraded_unavailable, never 403", async () => {
    setup((c) => (c.table === "trip_members" ? ERR : null)); const r = await get(`/events/near-trip/${TRIP}`);
    assert.equal(r.status, 503, r.text); assert.match(r.text, /degraded_unavailable/);
  });
  it("NT3 CONTROL: not a member → 403", async () => {
    setup(undefined, {}, { ...tripRows, trip_members: [] }); const r = await get(`/events/near-trip/${TRIP}`);
    assert.equal(r.status, 403, r.text);
  });
});

describe("census-discovery §122 (SW28): near-trip, the city alias and /nearby say an event withheld over a failed read", () => {
  after(() => _setTestClient(null as any, false));
  for (const [name, path] of PATHS) {
    it(`WC CONTROL ${name}: every read answers → listed, no truncated`, async () => {
      setup(); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.events.includes(EVENT), truncated: r.truncated }, { status: 200, listed: true, truncated: null }, r.text);
    });
    it(`WB ${name}: the block read FAILS → withheld, truncated`, async () => {
      setup(blocksRead); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.events.includes(EVENT), truncated: r.truncated }, { status: 200, listed: false, truncated: true }, r.text);
    });
    it(`WF ${name}: a friends-only event, the friendship read FAILS → withheld, truncated`, async () => {
      setup(friendsRead, { visibility: "friends_only" }); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.events.includes(EVENT), truncated: r.truncated }, { status: 200, listed: false, truncated: true }, r.text);
    });
    it(`WE ${name}: the ban read FAILS → withheld, truncated`, async () => {
      setup(banRead); const r = await get(path);
      assert.deepEqual({ status: r.status, listed: r.events.includes(EVENT), truncated: r.truncated }, { status: 200, listed: false, truncated: true }, r.text);
    });
  }
});
