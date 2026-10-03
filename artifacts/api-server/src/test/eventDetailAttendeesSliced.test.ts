/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B24, probes AS0/AS1, and the reach WD1):
 * GET /events/:id says when its attendee list is a slice, and serves the live going count as `goingCount`.
 *
 * The route builds `goingAttendees` from the first four going travellers (the avatar strip) and served it with nothing
 * saying it is a slice. The host's Attendees tab listed those four as the attendees, and the co-host picker said
 * "Everyone going is already a co-host, or nobody else is going yet." over them. A participant's body now carries
 * `goingAttendeesTruncated: true` and `goingAttendeesTotal` (the live going count) whenever fewer travellers are listed
 * than are going; a whole list gains no key. The event's own `goingCount` field was the cached counter, never recounted,
 * beside the live `counts.going`; it is now the same count (the cached one only over a failed read, which is named).
 *
 *   AS0  CONTROL (the verifier's): the host's view, 4 going → all 4 listed, no mark
 *   AS1  (the verifier's) the host's view, 6 going → the body says the list is a slice of 6
 *   AS2  a going viewer's view, 6 going → the same mark (the strip is the same slice)
 *   AS3  a viewer who is not a participant → no list and no mark (the list is participant-scoped)
 *   AS4  the going read FAILS → no slice mark (the list is named unread instead: failedSources event_rsvps)
 *   GC1  cached going_count 9, 6 going → goingCount 6 (the live count), counts.going 6
 *   WD1  REACH (the verifier's): the waitlist read FAILS, cached 3 → waitlistCount 3 beside failedSources [event_waitlist]
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, HOST, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const goer = (i: number) => `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
function setup(n: number, o: { goingCount?: number; viewerGoing?: boolean; failGoing?: boolean } = {}) {
  const going = Array.from({ length: n }, (_, i) => ({ event_id: EVENT, user_id: goer(i + 1), status: "going" }));
  if (o.viewerGoing) going[0] = { event_id: EVENT, user_id: VIEWER, status: "going" };
  const profiles = [...new Set([HOST, VIEWER, ...going.map((g) => g.user_id)])].map((id) => ({ id, handle: `h${id.slice(-4)}`, name: `N${id.slice(-2)}`, avatar_url: null, date_of_birth: "1990-06-15", location_country: "US", verified: true }));
  world({ ev: { state: "open", going_count: o.goingCount ?? n, max_attendees: 20, capacity: 20 }, rsvps: going, extra: { profiles },
    failOn: o.failGoing ? (c) => (c.table === "event_rsvps" && c.eq("user_id") === undefined ? ERR : null) : undefined });
}
async function detail(token: string) {
  const s = await eventsServer();
  try { return await s.req(token, "GET", `/events/${EVENT}`); } finally { s.close(); }
}

describe("census-discovery §118 (B24): GET /events/:id says when its attendee list is a slice", () => {
  after(() => _setTestClient(null as any, false));
  it("AS0 CONTROL: the host's view, 4 going → all 4 listed, no mark", async () => {
    setup(4); const r = await detail("t-host");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.goingAttendees.length, 4);
    assert.equal("goingAttendeesTruncated" in r.body, false, r.text);
    assert.equal("goingAttendeesTotal" in r.body, false, r.text);
  });
  it("AS1 the host's view, 6 going → the body says the list is a slice of 6", async () => {
    setup(6); const r = await detail("t-host");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ listed: r.body.goingAttendees.length, cut: r.body.goingAttendeesTruncated, total: r.body.goingAttendeesTotal }, { listed: 4, cut: true, total: 6 });
  });
  it("AS2 a going viewer's view, 6 going → the same mark", async () => {
    setup(6, { viewerGoing: true }); const r = await detail("t-viewer");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual({ cut: r.body.goingAttendeesTruncated, total: r.body.goingAttendeesTotal }, { cut: true, total: 6 });
  });
  it("AS3 a viewer who is not a participant → no list and no mark", async () => {
    setup(6); const r = await detail("t-viewer");
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.body.goingAttendees, []);
    assert.equal("goingAttendeesTruncated" in r.body, false, r.text);
  });
  it("AS4 the going read FAILS → no slice mark; the read is named", async () => {
    setup(6, { failGoing: true }); const r = await detail("t-host");
    assert.equal(r.status, 200, r.text);
    assert.equal("goingAttendeesTruncated" in r.body, false, r.text);
    assert.ok((r.body.failedSources ?? []).includes("event_rsvps"), r.text);
  });
  it("GC1 cached going_count 9, 6 going → goingCount 6 beside counts.going 6", async () => {
    setup(6, { goingCount: 9 }); const r = await detail("t-host");
    assert.deepEqual({ goingCount: r.body.goingCount, counts: r.body.counts.going }, { goingCount: 6, counts: 6 });
  });
});

describe("census-discovery §118 (B25 reach): GET /events/:id over a failed waitlist read", () => {
  after(() => _setTestClient(null as any, false));
  it("WD1 REACH: the waitlist read FAILS, cached 3 → waitlistCount 3 beside failedSources [event_waitlist]", async () => {
    world({ ev: { state: "open", waitlist_count: 3 }, rsvps: [], failOn: (c) => (c.table === "event_waitlist" && c.eq("user_id") === undefined ? ERR : null) });
    const r = await detail("t-viewer");
    assert.equal(r.status, 200); assert.equal(r.body.waitlistCount, 3); assert.deepEqual(r.body.failedSources, ["event_waitlist"]);
  });
});
