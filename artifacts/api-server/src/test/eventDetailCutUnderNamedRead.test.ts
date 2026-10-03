/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B29 reach, AU0–AU2): GET /events/:id
 * marks its four-row attendee slice (`goingAttendeesTruncated`, `goingAttendeesTotal`) whenever the going/maybe read
 * answered, also when ANOTHER read failed and is named beside it: the full-RSVP count read (`event_rsvps`) or the host's
 * profile read (`profiles`). These are the bodies the client's attendeesListCut must read as a slice
 * (travel-buddy-standalone HostDashboardPanel.attendeesCutUnderNamedRead AN0–AN2 hold the same bodies).
 *
 *   AU0 CONTROL: host's view, 6 going, every read answers → 4 of 6 marked truncated, nothing named
 *   AU1 the full-RSVP read FAILS (the going/maybe read answers) → 4 of 6 marked, `event_rsvps` named, counts.maybe read
 *   AU2 a co-host's view, the host's profile read FAILS → 4 of 6 marked, `profiles` named
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, HOST, W1, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const goer = (i: number) => `88888888-8888-4888-8888-${String(i).padStart(12, "0")}`;
function setup(n: number, failOn?: (c: any) => any, cohost = false) {
  const going = Array.from({ length: n }, (_, i) => ({ event_id: EVENT, user_id: goer(i + 1), status: "going" }));
  const profiles = [HOST, ...going.map((g) => g.user_id)].map((id) => ({ id, handle: `h${id.slice(-4)}`, name: `N${id.slice(-2)}`, avatar_url: null, date_of_birth: "1990-06-15", location_country: "US", verified: true }));
  world({ ev: { state: "open", going_count: n, max_attendees: 20, capacity: 20 }, rsvps: going, extra: { profiles: cohost ? [...profiles, { id: W1, handle: "hw1", name: "W1", avatar_url: null, date_of_birth: "1990-06-15", location_country: "US", verified: true }] : profiles, ...(cohost ? { event_roles: [{ event_id: EVENT, user_id: W1, role: "co_host" }] } : {}) }, failOn });
}
const fullRsvpRead = (c: any) => c.table === "event_rsvps" && c.eq("user_id") === undefined && !c.filters.some((f: any) => f.col === "status");
const hostProfileRead = (c: any) => c.table === "profiles" && c.eq("id") === HOST;
describe("census-discovery §119 (B29 reach): GET /events/:id marks the attendee slice beside a different named read", () => {
  after(() => _setTestClient(null as any, false));
  it("AU0 CONTROL: 6 going, every read answers → truncated, nothing named", async () => {
    setup(6); const s = await eventsServer();
    try { const r = await s.req("t-host", "GET", `/events/${EVENT}`);
      assert.equal(r.status, 200, r.text); assert.equal(r.body.goingAttendeesTruncated, true); assert.equal(r.body.failedSources, undefined); } finally { s.close(); }
  });
  it("AU1 REACH: the full-RSVP read FAILS → 4 of 6 marked, event_rsvps named, counts.maybe read", async () => {
    setup(6, (c) => (fullRsvpRead(c) ? ERR : null)); const s = await eventsServer();
    try { const r = await s.req("t-host", "GET", `/events/${EVENT}`);
      const seen = { status: r.status, counts: r.body.counts, listed: r.body.goingAttendees?.length, truncated: r.body.goingAttendeesTruncated, total: r.body.goingAttendeesTotal, failedSources: r.body.failedSources };
      assert.equal(r.status, 200, JSON.stringify(seen)); assert.equal(seen.listed, 4); assert.equal(seen.truncated, true); assert.deepEqual(seen.failedSources, ["event_rsvps"]); assert.equal(r.body.counts.maybe, 0); } finally { s.close(); }
  });
  it("AU2 REACH: a co-host's view, the host's profile read FAILS → 4 of 6 marked, profiles named", async () => {
    setup(6, (c) => (hostProfileRead(c) ? ERR : null), true); const s = await eventsServer();
    try { const r = await s.req("t-w1", "GET", `/events/${EVENT}`);
      const seen = { status: r.status, host: r.body.host, listed: r.body.goingAttendees?.length, truncated: r.body.goingAttendeesTruncated, failedSources: r.body.failedSources };
      assert.equal(r.status, 200, JSON.stringify(seen)); assert.equal(seen.listed, 4); assert.equal(seen.truncated, true); assert.deepEqual(seen.failedSources, ["profiles"]); } finally { s.close(); }
  });
});
