/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B28, probes SS0/SS1/FS0/FS1): the events
 * tab's lists and the event search never answer a read they could not make as fewer or no events.
 *
 * D-W11X2-165 left these reads "seen, not built": GET /events/search discarded both reads' `error` (and read every
 * public event unbounded, so PostgREST's db-max-rows cut them silently); /following answered a failed follows read as
 * 200 `{ events: [] }`; /me, /saved, /joined and /circles did the same with their own reads. The events tab then said
 * "No events yet". A list's own read (or the viewer's own RSVP state it serves) that fails now answers 503
 * `degraded_unavailable`, which every client already reads as a failed list; an event dropped because a block,
 * friendship, visibility or eligibility read failed, or a search read cut at its pool, makes the answer `truncated: true`.
 *
 *   SS0  CONTROL (the verifier's): both search reads answer → the matching event is listed
 *   SS1  (the verifier's) both search reads FAIL → 503, never a whole empty search
 *   SS2  one search read FAILS → 503 (half a search is not the search)
 *   SS3  a friends-only match whose friendship read FAILS → withheld, and the answer says it is not whole
 *   SS4  the search reads are bounded: a read that fills its pool says the answer is not whole
 *   FS0  CONTROL (the verifier's): the follows read answers → the followed host's event is listed
 *   FS1  (the verifier's) the follows read FAILS → 503, never `{ events: [] }`
 *   FS2  a followed host's event whose block read FAILS → withheld, and the answer says it is not whole
 *   ME1  /events/me: the hosted read FAILS → 503;  ME2: the RSVP read FAILS → 503;  ME0 CONTROL: both answer → listed
 *   SV1  /events/saved: the saves read FAILS → 503;  SV0 CONTROL
 *   JN1  /events/joined: the RSVP read FAILS → 503;  JN0 CONTROL
 *   CI1  /events/circles: the membership read FAILS → 503;  CI0 CONTROL
 *   OW1  /events/following: the viewer's own RSVP read FAILS → 503 (never "not going" on every card)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, HOST, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const searchRead = (c: any) => c.table === "events" && (c.filters ?? []).some((f: any) => f.op === "ilike" && (f.col === "title" || f.col === "city"));
const titleRead = (c: any) => c.table === "events" && (c.filters ?? []).some((f: any) => f.op === "ilike" && f.col === "title");
async function get(path: string) {
  const s = await eventsServer();
  try { return await s.req("t-viewer", "GET", path); } finally { s.close(); }
}
const notWhole = (r: { status: number; body: any }) => r.status >= 500 || r.body?.truncated === true;
const seen = (r: { status: number; body: any }) => JSON.stringify({ status: r.status, events: r.body?.events?.length, keys: Object.keys(r.body ?? {}) });

describe("census-discovery §118 (B28): GET /events/search never answers an unread search as no events", () => {
  after(() => _setTestClient(null as any, false));
  it("SS0 CONTROL: both reads answer → 'Rooftop quiz' found", async () => {
    world({ ev: { state: "open" } });
    const r = await get("/events/search?q=rooftop");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
    assert.equal("truncated" in r.body, false, r.text);
  });
  it("SS1 both search reads FAIL → 503", async () => {
    world({ ev: { state: "open" }, failOn: (c) => (searchRead(c) ? ERR : null) });
    const r = await get("/events/search?q=rooftop");
    assert.equal(r.status, 503, seen(r));
  });
  it("SS2 one search read FAILS → 503", async () => {
    world({ ev: { state: "open" }, failOn: (c) => (titleRead(c) ? ERR : null) });
    const r = await get("/events/search?q=rooftop");
    assert.equal(r.status, 503, seen(r));
  });
  it("SS3 a friends-only match whose friendship read FAILS → withheld, and the answer is not whole", async () => {
    world({ ev: { state: "open", visibility: "friends_only" }, extra: { user_friendships: [] }, failOn: (c) => (c.table === "user_friendships" ? ERR : null) });
    const r = await get("/events/search?q=rooftop");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.events.length, 0, r.text);
    assert.equal(r.body.truncated, true, seen(r));
  });
  it("SS4 a search read that fills its pool → the answer is not whole", async () => {
    const more = Array.from({ length: 501 }, (_, i) => ({ id: `99999999-9999-4999-8999-${String(i).padStart(12, "0")}`, host_id: HOST, title: `Rooftop ${i}`, state: "open", visibility: "public", city: "Lisbon", starts_at: "2030-01-01T00:00:00.000Z", going_count: 0, waitlist_count: 0, verified_only: false }));
    world({ ev: { state: "open" }, moreEvents: more });
    const r = await get("/events/search?q=rooftop&limit=5");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.truncated, true, seen(r));
  });
});

describe("census-discovery §118 (B28): the events tab's own lists never answer an unread list as no events", () => {
  after(() => _setTestClient(null as any, false));
  const follows = { user_follows: [{ follower_id: VIEWER, following_id: HOST }] };
  it("FS0 CONTROL: the follows read answers → the followed host's event is listed", async () => {
    world({ ev: { state: "open" }, extra: follows });
    const r = await get("/events/following");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
    assert.equal("truncated" in r.body, false, r.text);
  });
  it("FS1 the follows read FAILS → 503", async () => {
    world({ ev: { state: "open" }, extra: follows, failOn: (c) => (c.table === "user_follows" ? ERR : null) });
    const r = await get("/events/following");
    assert.equal(r.status, 503, seen(r));
  });
  it("FS2 a followed host's event whose block read FAILS → withheld, and the answer is not whole", async () => {
    world({ ev: { state: "open" }, extra: follows, failOn: (c) => (c.table === "blocks" ? ERR : null) });
    const r = await get("/events/following");
    assert.ok(notWhole(r), seen(r));
    assert.equal((r.body?.events ?? []).length, 0, seen(r));
  });
  it("OW1 the viewer's own RSVP read FAILS → 503, never 'not going' on every card", async () => {
    world({ ev: { state: "open" }, extra: follows, failOn: (c) => (c.table === "event_rsvps" && c.eq("user_id") === VIEWER ? ERR : null) });
    const r = await get("/events/following");
    assert.equal(r.status, 503, seen(r));
  });
  it("ME0 CONTROL: /events/me, both reads answer → the attended event is listed", async () => {
    world({ ev: { state: "open" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }] });
    const r = await get("/events/me");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
  });
  it("ME1 /events/me: the hosted read FAILS → 503", async () => {
    world({ ev: { state: "open" }, failOn: (c) => (c.table === "events" && c.eq("host_id") === VIEWER ? ERR : null) });
    const r = await get("/events/me");
    assert.equal(r.status, 503, seen(r));
  });
  it("ME2 /events/me: the RSVP read FAILS → 503", async () => {
    world({ ev: { state: "open" }, failOn: (c) => (c.table === "event_rsvps" && c.eq("user_id") === VIEWER ? ERR : null) });
    const r = await get("/events/me");
    assert.equal(r.status, 503, seen(r));
  });
  it("SV0 CONTROL: /events/saved → the saved event is listed", async () => {
    world({ ev: { state: "open" }, extra: { event_saves: [{ user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-01T00:00:00.000Z" }] } });
    const r = await get("/events/saved");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
  });
  it("SV1 /events/saved: the saves read FAILS → 503", async () => {
    world({ ev: { state: "open" }, extra: { event_saves: [{ user_id: VIEWER, event_id: EVENT, saved_at: "2026-09-01T00:00:00.000Z" }] }, failOn: (c) => (c.table === "event_saves" ? ERR : null) });
    const r = await get("/events/saved");
    assert.equal(r.status, 503, seen(r));
  });
  it("JN0 CONTROL: /events/joined → the joined event is listed", async () => {
    world({ ev: { state: "open" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }] });
    const r = await get("/events/joined");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
  });
  it("JN1 /events/joined: the RSVP read FAILS → 503", async () => {
    world({ ev: { state: "open" }, rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }], failOn: (c) => (c.table === "event_rsvps" && c.eq("user_id") === VIEWER ? ERR : null) });
    const r = await get("/events/joined");
    assert.equal(r.status, 503, seen(r));
  });
  it("CI0 CONTROL: /events/circles → the circle's event is listed", async () => {
    world({ ev: { state: "open", circle_id: HOST, visibility: "circle" }, extra: { circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "accepted" }] } });
    const r = await get("/events/circles");
    assert.equal(r.status, 200, r.text); assert.equal(r.body.events.length, 1, r.text);
  });
  it("CI1 /events/circles: the membership read FAILS → 503", async () => {
    world({ ev: { state: "open", circle_id: HOST, visibility: "circle" }, extra: { circle_memberships: [{ user_id: HOST, other_id: VIEWER, status: "accepted" }] }, failOn: (c) => (c.table === "circle_memberships" ? ERR : null) });
    const r = await get("/events/circles");
    assert.equal(r.status, 503, seen(r));
  });
});
