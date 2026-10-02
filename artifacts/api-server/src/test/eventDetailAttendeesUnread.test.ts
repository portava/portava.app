/**
 * census-discovery §117 (DV-83 round 20, lane W11-X2; the round-19 verifier's B19, probes DA0–DA3): GET /events/:id
 * never serves a failed read of who is going, or of the viewer's own state, as a measured empty answer.
 *
 * Round 19 (SW10) named a failed going/maybe read in `failedSources: ["event_rsvps"]` but built `goingAttendees` from
 * the same failed read, and no client read `failedSources`, so the host's Attendees tab said "No attendees yet". Two
 * sibling reads failed unnamed: the going travellers' profiles (`goingAttendees: []`, nothing named) and the viewer's own
 * RSVP (`myRsvp: null`, "not RSVP'd"). The viewer's other own-state reads (role, waitlist place, join request, check-in)
 * had the same shape: a failed role read made a co-host a non-participant, and the attendee list went with it.
 *
 *   DA0  CONTROL: the host's view, every read answers → the two going travellers, no `failedSources` key
 *   DA1  the going/maybe read FAILS → `goingAttendees: []` beside the cached count and `failedSources: ["event_rsvps"]`
 *        (the contract the client now reads)
 *   DA3  the going travellers' profile read FAILS → `failedSources` names `profiles`, never an unnamed []
 *   DA8  the host's profile read FAILS → `host: null` and `failedSources` names `profiles`
 *   DA2  a going traveller's own RSVP read FAILS → 503 degraded_unavailable, never `myRsvp: null` ("not RSVP'd")
 *   DA4  the viewer's own role read FAILS → 503, never a co-host served as a non-participant
 *   DA5  the viewer's own waitlist read FAILS → 503, never `myWaitlistPosition: null` ("not queued")
 *   DA6  the viewer's own join-request read FAILS → 503, never `myJoinRequestStatus: null` ("never asked")
 *   DA7  the viewer's own check-in read FAILS → 503, never `myAttendanceState: null`
 *   DA0b CONTROL: a viewer who is not going, every read answers → 200, `myRsvp: null`, no `failedSources`
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FakeReadContext } from "./helpers/failClosedSupabase.js";
import { world, eventsServer, ERR, EVENT, HOST, VIEWER, W1, W2 } from "./helpers/eventsWorld.js";

const rsvps = [{ event_id: EVENT, user_id: W1, status: "going" }, { event_id: EVENT, user_id: W2, status: "going" }];
const goingMaybeFails = (c: FakeReadContext) => (c.table === "event_rsvps" && c.filters.some((f) => f.op === "in" && f.col === "status") && c.eq("user_id") === undefined ? ERR : null);
const goingProfilesFail = (c: FakeReadContext) => (c.table === "profiles" && c.filters.some((f) => f.op === "in" && f.col === "id") ? ERR : null);
const hostProfileFails = (c: FakeReadContext) => (c.table === "profiles" && c.eq("id") === HOST ? ERR : null);
const ownReadFails = (table: string, user: string) => (c: FakeReadContext) => (c.table === table && c.eq("event_id") === EVENT && c.eq("user_id") === user ? ERR : null);

describe("census-discovery §117 (B19): GET /events/:id never serves a failed attendee or own-state read as empty", () => {
  let srv: Awaited<ReturnType<typeof eventsServer>>;
  before(async () => { srv = await eventsServer(); });
  after(() => srv.close());

  const detail = async (token: string, failOn?: (c: FakeReadContext) => any, ev: Record<string, any> = { state: "open", going_count: 7 }) => {
    world({ ev, rsvps, failOn });
    const r = await srv.req(token, "GET", `/events/${EVENT}`);
    const b = r.body ?? {};
    return { r, b, seen: JSON.stringify({ status: r.status, error: b.error, counts: b.counts, host: b.host?.id ?? null, myRsvp: b.myRsvp, goingAttendees: (b.goingAttendees ?? []).length, failedSources: b.failedSources }) };
  };

  it("DA0 CONTROL: the host's view, every read answers → the two going travellers, no failedSources key", async () => {
    const d = await detail("t-host");
    assert.equal(d.r.status, 200, d.r.text);
    assert.equal(d.b.goingAttendees.length, 2, d.seen);
    assert.equal(d.b.host?.id, HOST, d.seen);
    assert.equal("failedSources" in d.b, false, d.seen);
  });
  it("DA0b CONTROL: a viewer who is not going, every read answers → 200, myRsvp null, no failedSources", async () => {
    const d = await detail("t-viewer");
    assert.equal(d.r.status, 200, d.r.text);
    assert.equal(d.b.myRsvp, null, d.seen);
    assert.deepEqual(d.b.goingAttendees, [], d.seen);
    assert.equal("failedSources" in d.b, false, d.seen);
  });
  it("DA1 the going/maybe read FAILS → goingAttendees [] beside the cached count, and event_rsvps is named", async () => {
    const d = await detail("t-host", goingMaybeFails);
    assert.equal(d.r.status, 200, d.r.text);
    assert.deepEqual(d.b.goingAttendees, [], d.seen);
    assert.equal(d.b.counts.going, 7, d.seen);
    assert.deepEqual(d.b.failedSources, ["event_rsvps"], d.seen);
  });
  it("DA3 the going travellers' profile read FAILS → profiles is named, never an unnamed []", async () => {
    const d = await detail("t-host", goingProfilesFail);
    assert.equal(d.r.status, 200, d.r.text);
    assert.deepEqual(d.b.goingAttendees, [], d.seen);
    assert.deepEqual(d.b.failedSources, ["profiles"], d.seen);
    assert.equal(d.b.counts.going, 2, d.seen);
  });
  it("DA8 the host's profile read FAILS → host null, and profiles is named", async () => {
    const d = await detail("t-viewer", hostProfileFails);
    assert.equal(d.r.status, 200, d.r.text);
    assert.equal(d.b.host, null, d.seen);
    assert.deepEqual(d.b.failedSources, ["profiles"], d.seen);
  });
  it("DA2 a going traveller's own RSVP read FAILS → 503, never myRsvp null (\"not RSVP'd\")", async () => {
    const d = await detail("t-w1", ownReadFails("event_rsvps", W1), { state: "open", going_count: 2 });
    assert.equal(d.r.status, 503, d.seen);
    assert.equal(d.b.error, "degraded_unavailable", d.seen);
  });
  it("DA4 the viewer's own role read FAILS → 503, never a co-host served as a non-participant", async () => {
    // The role is read twice with these filters: by the visibility gate (fail-closed since §111) and by the detail
    // body. Only the detail body's read fails here, so the gate passes and the body's own read is what is tested.
    let seenRoleReads = 0; const own = ownReadFails("event_roles", VIEWER);
    const d = await detail("t-viewer", (c) => (own(c) && c.filters.length === 2 && ++seenRoleReads === 2 ? ERR : null));
    assert.equal(d.r.status, 503, d.seen);
    assert.equal(d.b.error, "degraded_unavailable", d.seen);
  });
  it("DA5 the viewer's own waitlist read FAILS → 503, never myWaitlistPosition null", async () => {
    const d = await detail("t-viewer", ownReadFails("event_waitlist", VIEWER));
    assert.equal(d.r.status, 503, d.seen);
    assert.equal(d.b.error, "degraded_unavailable", d.seen);
  });
  it("DA6 the viewer's own join-request read FAILS → 503, never myJoinRequestStatus null", async () => {
    const d = await detail("t-viewer", ownReadFails("event_join_requests", VIEWER));
    assert.equal(d.r.status, 503, d.seen);
    assert.equal(d.b.error, "degraded_unavailable", d.seen);
  });
  it("DA7 the viewer's own check-in read FAILS → 503, never myAttendanceState null", async () => {
    const d = await detail("t-viewer", ownReadFails("event_attendee_states", VIEWER));
    assert.equal(d.r.status, 503, d.seen);
    assert.equal(d.b.error, "degraded_unavailable", d.seen);
  });
});
