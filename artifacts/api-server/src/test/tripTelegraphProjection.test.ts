/**
 * Trips spec §1 / §19.1 — the Trip context a conversation consumes
 * (census-trips TR5).
 *
 *   1. the builder on the health fixture's Paris trip: the trip, the people in
 *      THIS conversation who are on it, the rest counted and not named, what
 *      is running now and what is next, and §17.2's mode;
 *   2. a viewer who is not an accepted member refused; an unreadable crew
 *      refused rather than answered without checking who is asking;
 *   3. the §17.2 term read SOFTLY — a deployment without the operational batch
 *      still gets a trip, with the mode `unread` and the reason;
 *   4. GET /trips/:tripId/telegraph-context through the real app, including
 *      what `?with=` accepts and refuses.
 *
 * Run: node --import tsx/esm --test src/test/tripTelegraphProjection.test.ts
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import app from "../app.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import {
  buildTripTelegraphProjection, TELEGRAPH_PARTICIPANT_CAP, TELEGRAPH_CONTEXT_READING,
} from "../domain/trips/projections/TripTelegraphProjection.js";
import { makeClient, base } from "./tripHealthProjection.test.js";
import { createServer, type Server } from "node:http";

const OWNER_ID  = "11111111-1111-1111-1111-111111111111";
const MEMBER_ID = "22222222-2222-2222-2222-222222222222";
const STRANGER  = "33333333-3333-3333-3333-333333333333";
const TRIP_ID   = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-13T12:30:00.000Z");
const A = "cccccccc-cccc-cccc-cccc-ccccccccccc1";
const B = "cccccccc-cccc-cccc-cccc-ccccccccccc2";

const item = (id: string, o: Record<string, any>) => ({
  id, trip_id: TRIP_ID, title: id, category: "activity", status: "planned",
  starts_at: null, ends_at: null, day_date: "2026-09-13", lat: null, lng: null, location_name: null, removed_at: null, ...o,
});

function tables(opts: { gate?: boolean } = {}) {
  const t = base();
  t.feature_flags = [{ flag: "trip_operational_projections_enabled", enabled: opts.gate ?? true }];
  t.trip_plan_items = [
    item(A, { title: "Louvre", starts_at: "2026-09-13T12:00:00.000Z", ends_at: "2026-09-13T13:00:00.000Z", location_name: "Musée du Louvre" }),
    item(B, { title: "Seine walk", starts_at: "2026-09-13T15:00:00.000Z" }),
  ];
  return t;
}

describe("TR5 — the trip context a conversation may consume", () => {
  it("carries the trip, the people in THIS conversation who are on it, what is running and what is next", async () => {
    const r = await buildTripTelegraphProjection(makeClient(tables()) as any, TRIP_ID, OWNER_ID, [OWNER_ID, MEMBER_ID, STRANGER], { now: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    const p = r.projection;
    assert.equal(p.tripId, TRIP_ID);
    assert.equal(p.trip.id, TRIP_ID);
    assert.equal(typeof p.projectionSchemaVersion, "number", "§19.1's envelope");
    assert.ok(p.generatedAt);
    assert.deepEqual(p.participants.map((x) => x.userId).sort(), [OWNER_ID, MEMBER_ID].sort());
    assert.equal(p.nonParticipantCount, 1, "the stranger is counted, never named back");
    assert.ok(!JSON.stringify(p.participants).includes(STRANGER));
    assert.equal(p.currentPlan?.id, A, "the plan whose window contains now");
    assert.equal(p.currentPlan?.locationName, "Musée du Louvre");
    assert.equal(p.nextPlan?.id, B);
    assert.equal(p.reading, TELEGRAPH_CONTEXT_READING);
  });

  it("names nobody when the caller named nobody — a thread whose membership was not stated has no participants", async () => {
    const r = await buildTripTelegraphProjection(makeClient(tables()) as any, TRIP_ID, OWNER_ID, [], { now: NOW });
    assert.ok(r.ok);
    assert.deepEqual(r.projection.participants, []);
    assert.equal(r.projection.nonParticipantCount, 0);
  });

  it("carries no coordinates and no presence, whatever the trip holds", async () => {
    const r = await buildTripTelegraphProjection(makeClient(tables()) as any, TRIP_ID, OWNER_ID, [OWNER_ID], { now: NOW });
    assert.ok(r.ok);
    const flat = JSON.stringify(r.projection);
    for (const forbidden of ['"lat"', '"lng"', '"latitude"', '"longitude"', '"presence"', '"freshnessClass"']) {
      assert.ok(!flat.includes(forbidden), `${forbidden} must not be in a conversation's context`);
    }
  });

  it("§17.2 is read softly: with the gate closed the conversation still gets a trip, and the mode says why it is unread", async () => {
    const r = await buildTripTelegraphProjection(makeClient(tables({ gate: false })) as any, TRIP_ID, OWNER_ID, [OWNER_ID], { now: NOW });
    assert.ok(r.ok, "a closed gate must not cost the conversation its trip");
    assert.equal(r.projection.attention.status, "unread");
    assert.equal(r.projection.trip.id, TRIP_ID);
    assert.equal(r.projection.currentPlan?.id, A, "the plan is a deployed table and is still read");
  });

  it("with the gate open the mode is on the wire", async () => {
    const r = await buildTripTelegraphProjection(makeClient(tables()) as any, TRIP_ID, OWNER_ID, [OWNER_ID], { now: NOW });
    assert.ok(r.ok);
    assert.equal(r.projection.attention.status, "ok");
    if (r.projection.attention.status === "ok") {
      assert.equal(typeof r.projection.attention.items[0]!.mode, "string");
      assert.equal(typeof r.projection.attention.items[0]!.suppressed, "boolean");
    }
  });

  it("a viewer who is not an accepted member is refused, and an unreadable crew is refused rather than answered", async () => {
    const denied = await buildTripTelegraphProjection(makeClient(tables()) as any, TRIP_ID, STRANGER, [STRANGER], { now: NOW });
    assert.equal(denied.ok, false);
    assert.equal(denied.ok === false ? denied.reason : null, "TRIP_AUTH_NOT_CREW");

    const blind = await buildTripTelegraphProjection(makeClient(tables(), ["trip_members"]) as any, TRIP_ID, OWNER_ID, [OWNER_ID], { now: NOW });
    assert.equal(blind.ok, false);
    assert.equal(blind.ok === false ? blind.reason : null, "TRIP_PROJECTION_UNAVAILABLE");
    assert.match(blind.ok === false ? blind.message : "", /viewer could not be checked/);
  });

  it("an unreadable plan refuses rather than reporting an empty day, and a missing trip is not found", async () => {
    const noPlan = await buildTripTelegraphProjection(makeClient(tables(), ["trip_plan_items"]) as any, TRIP_ID, OWNER_ID, [OWNER_ID], { now: NOW });
    assert.equal(noPlan.ok, false);
    assert.equal(noPlan.ok === false ? noPlan.reason : null, "TRIP_PROJECTION_UNAVAILABLE");

    const gone = await buildTripTelegraphProjection(makeClient(tables()) as any, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", OWNER_ID, [], { now: NOW });
    assert.equal(gone.ok, false);
    assert.equal(gone.ok === false ? gone.reason : null, "TRIP_NOT_FOUND");
  });
});

describe("TR5 — GET /trips/:tripId/telegraph-context", () => {
  let server: Server; let port = 0;
  after(() => { server?.close(); _setTestClient(null as any, false); _setTestServiceClient(null as any); });

  function withAuth(c: any) {
    c.auth = { getUser: async (token: string) => {
      const id = token === "owner-token" ? OWNER_ID : token === "stranger-token" ? STRANGER : null;
      return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid" } };
    } };
    return c;
  }
  async function get(path: string, token: string) {
    if (!server) {
      await new Promise<void>((r) => { server = createServer(app); server.listen(0, "127.0.0.1", () => { server.unref(); port = (server.address() as any).port; r(); }); });
    }
    const res = await fetch(`http://127.0.0.1:${port}/api${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }

  it("serves the context to a member, with the conversation's people named through ?with=", async () => {
    const c = withAuth(makeClient(tables())); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const r = await get(`/trips/${TRIP_ID}/telegraph-context?with=${OWNER_ID},${MEMBER_ID}`, "owner-token");
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.equal(r.body.tripId, TRIP_ID);
    assert.equal(r.body.participants.length, 2);
    // The route uses the real clock, so which of the two plans is "current"
    // depends on when this runs; what must hold is that the plan was READ —
    // one of the two is placed, and neither is invented.
    assert.ok(r.body.currentPlan || r.body.nextPlan, "the plan was read");
    for (const p of [r.body.currentPlan, r.body.nextPlan]) {
      if (p) assert.ok([A, B].includes(p.id), p.id);
    }
    assert.equal(r.body.attention.status, "ok", "the gate is open in this fixture");
  });

  it("refuses a non-member with TRIP_AUTH_NOT_CREW, and a malformed or oversized ?with= with 400", async () => {
    const c = withAuth(makeClient(tables())); _setTestClient(c as any, true); _setTestServiceClient(c as any);
    const denied = await get(`/trips/${TRIP_ID}/telegraph-context`, "stranger-token");
    assert.equal(denied.body.reason, "TRIP_AUTH_NOT_CREW");

    const bad = await get(`/trips/${TRIP_ID}/telegraph-context?with=not-a-uuid`, "owner-token");
    assert.equal(bad.status, 400);
    assert.match(JSON.stringify(bad.body), /not one/);

    const many = Array.from({ length: TELEGRAPH_PARTICIPANT_CAP + 1 }, () => OWNER_ID).join(",");
    const over = await get(`/trips/${TRIP_ID}/telegraph-context?with=${many}`, "owner-token");
    assert.equal(over.status, 400);
    assert.match(JSON.stringify(over.body), /cap is/);
  });
});
