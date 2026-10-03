/**
 * census-discovery §119 (DV-83 round 22, lane W11-X2; the round-21 verifier's B33): GET /events, its city alias and
 * GET /events/nearby never serve the viewer's OWN state over a read that failed as measured.
 *
 * Each list reads the viewer's own RSVPs and waitlist places for the events it serves, and GET /events also reads the
 * viewer's saved events (collections → collection_items). Every one of those reads discarded its `error`, so a failed
 * read was served at 200 as `myRsvp: null` ("not going"), `myWaitlistPosition: null` ("not waitlisted") and
 * `isSaved: false` on every card, with nothing named. Round 21 ruled exactly this a break on /following, /circles and
 * /saved (D-W11X2-170, OW1: "never 'not going' on every card"), and round 19 on GET /events/:id (B19). Each now answers
 * 503 `degraded_unavailable`, as those lists do (every client already reads that as a failed list).
 *
 *   OS0 CONTROL: GET /events, the viewer is going and 2nd on the waitlist → myRsvp "going", myWaitlistPosition 2
 *   OS1 GET /events, the own RSVP read FAILS → 503 (the verifier's OS1)
 *   OS2 GET /events, the own waitlist read FAILS → 503 (the verifier's OS2)
 *   OS3 CONTROL: GET /events, a saved event → isSaved true
 *   OS4 GET /events, the collections read FAILS → 503 (the verifier's OS4)
 *   OS5 GET /events, the collection_items read FAILS → 503
 *   OC0 CONTROL / OC1 / OC2: GET /events/city/Lisbon, the own RSVP / waitlist read FAILS → 503
 *   ON0 CONTROL / ON1 / ON2: GET /events/nearby, the own RSVP / waitlist read FAILS → 503 (the verifier's near arm)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { world, eventsServer, EVENT, VIEWER, ERR } from "./helpers/eventsWorld.js";
import { _setTestClient } from "../lib/http.js";

const ownRead = (table: string) => (c: any) => (c.table === table && c.eq("user_id") === VIEWER && c.filters.some((f: any) => f.col === "event_id" && f.op === "in") ? ERR : null);
const COLLECTION = "c0000000-0000-4000-8000-000000000001";
function setup(failOn?: (c: any) => any) {
  world({
    extra: { collections: [{ id: COLLECTION, owner_id: VIEWER }], collection_items: [{ collection_id: COLLECTION, entity_type: "event", entity_id: EVENT }] },
    ev: { state: "open", going_count: 1, max_attendees: 20, capacity: 20 },
    rsvps: [{ event_id: EVENT, user_id: VIEWER, status: "going" }],
    waitlist: [{ event_id: EVENT, user_id: VIEWER, position: 2, offer_expires_at: null }],
    failOn,
  });
}
async function get(path: string, failOn?: (c: any) => any) {
  setup(failOn); const s = await eventsServer();
  try {
    const r = await s.req("t-viewer", "GET", path);
    const e = (r.body?.events ?? []).find((x: any) => x.id === EVENT);
    return { status: r.status, code: r.body?.error?.code ?? r.body?.code ?? null, listed: Boolean(e), myRsvp: e?.myRsvp, pos: e?.myWaitlistPosition, isSaved: e?.isSaved, body: r.body };
  } finally { s.close(); }
}
const LISTS = [["", "/events?limit=10"], ["C", "/events/city/Lisbon"], ["N", "/events/nearby?lat=38.72&lng=-9.14&radiusKm=5"]] as const;

describe("census-discovery §119 (B33): the events lists never serve the viewer's own state over a failed read", () => {
  after(() => _setTestClient(null as any, false));
  for (const [k, path] of LISTS) {
    const id = k === "" ? "OS" : `O${k}`;
    it(`${id}0 CONTROL (${path.split("?")[0]}): going, 2nd on the waitlist → both served`, async () => {
      const seen = await get(path);
      assert.equal(seen.status, 200, JSON.stringify(seen.body));
      assert.deepEqual({ listed: seen.listed, myRsvp: seen.myRsvp, pos: seen.pos }, { listed: true, myRsvp: "going", pos: 2 });
    });
    it(`${id}1 (${path.split("?")[0]}): the own RSVP read FAILS → 503, never "not going"`, async () => {
      const seen = await get(path, ownRead("event_rsvps"));
      assert.equal(seen.status, 503, JSON.stringify({ ...seen, body: undefined }));
    });
    it(`${id}2 (${path.split("?")[0]}): the own waitlist read FAILS → 503, never "not waitlisted"`, async () => {
      const seen = await get(path, ownRead("event_waitlist"));
      assert.equal(seen.status, 503, JSON.stringify({ ...seen, body: undefined }));
    });
  }
  it("OS3 CONTROL: a saved event → isSaved true", async () => {
    const seen = await get("/events?limit=10");
    assert.equal(seen.isSaved, true);
  });
  it("OS4 the collections read FAILS → 503, never isSaved false", async () => {
    const seen = await get("/events?limit=10", (c: any) => (c.table === "collections" ? ERR : null));
    assert.equal(seen.status, 503, JSON.stringify({ ...seen, body: undefined }));
  });
  it("OS5 the collection_items read FAILS → 503, never isSaved false", async () => {
    const seen = await get("/events?limit=10", (c: any) => (c.table === "collection_items" ? ERR : null));
    assert.equal(seen.status, 503, JSON.stringify({ ...seen, body: undefined }));
  });
});
