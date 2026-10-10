/**
 * census-telegraph F5 (verification of 54ddc1de45) — the HUMAN plan door obeys lead ruling D-24 too.
 *
 * A meetup on a trip is the conversation plan `canCreatePlan` projects. After D-24 the projection refused
 * a hosting-restricted member on a GROUP trip's thread while `POST /meetups` admitted them — a projection
 * announcing a refusal no door performed (the OD-TRUST-5 class). The door now asks lane C's
 * `refuseTripActionIfRestricted(…, "change_shared_plan")` (lib/tripTrustGate.ts, on main through #650),
 * the same gate every Trips door uses, so D-24a's ONE solo/group test (`readTripShape`) decides.
 *
 * WHAT IS EXERCISED: the real meetups router over the certification harness (express on 127.0.0.1).
 *
 * Run: node --import tsx/esm --test src/test/telegraphMeetupPlanRestriction.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import meetupsRouter from "../routes/meetups.js";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { RESTRICTION_SENTENCES, RESTRICTION_UNVERIFIABLE_MESSAGE } from "../lib/discoveryTrustGate.js";
import { makeFakeClient, startRouter, call, type FakeClient, type FakeDbOptions, type RouterHarness } from "./telegraphCertificationHarness.js";

const ORGANIZER = "11111111-0000-4000-8000-000000000001";
const ANA = "22222222-0000-4000-8000-000000000002";
const BEN = "33333333-0000-4000-8000-000000000003";
const TRIP = "aaaaaaaa-0000-4000-8000-00000000000a";
const SOLO = "aaaaaaaa-0000-4000-8000-0000000000b0";
const day = new Date().toISOString().slice(0, 10);

type Rows = Array<Record<string, unknown>>;
function seed(restriction: "hosting" | "messaging" | null): Record<string, Rows> {
  return {
    feature_flags: [],
    profiles: [ORGANIZER, ANA, BEN].map((id) => ({ id, handle: id.slice(0, 4), name: id.slice(0, 4), role: "user", date_of_birth: "1990-01-01" })),
    trust_restrictions: restriction ? [{ user_id: ANA, restriction_type: restriction, lifted_at: null, expires_at: null }] : [],
    trips: [
      { id: TRIP, owner_id: ORGANIZER, status: "active", start_date: day, end_date: day, title: "Group" },
      { id: SOLO, owner_id: ANA, status: "active", start_date: day, end_date: day, title: "Solo" },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: ORGANIZER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: ANA, role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BEN, role: "member", status: "accepted" },
      { trip_id: SOLO, user_id: ANA, role: "owner", status: "accepted" },
    ],
    meetups: [],
    meetup_invites: [],
    message_threads: [],
    message_thread_members: [],
  };
}
const UNREADABLE: FakeDbOptions = { errors: { trust_restrictions: { message: "restrictions unavailable", code: "57P01", ops: ["select"] } } };

let harness: RouterHarness;
before(async () => { harness = await startRouter(meetupsRouter); });
after(async () => {
  _setTestClient(null, false);
  _setTestServiceClient(null as never);
  await harness.close();
});

function use(s: Record<string, Rows>, opts: FakeDbOptions = {}): FakeClient {
  const c = makeFakeClient(s, opts);
  _setTestClient(c as never, true);
  _setTestServiceClient(c as never);
  return c;
}
const meetupWrites = (c: FakeClient) => c._observed.inserts.filter((i) => i.table === "meetups").length;
const gateRefused = (r: { status: number; body: any }) =>
  (r.status === 403 && r.body?.error === "trust_restriction") || (r.status === 503 && r.body?.message === RESTRICTION_UNVERIFIABLE_MESSAGE);
const body = (over: Record<string, unknown> = {}) => ({ title: "Dinner", startsAt: new Date(Date.now() + 3_600_000).toISOString(), ...over });

describe("F5 / D-24 — POST /meetups on a trip is a change to that trip's shared plan", () => {
  it("THE POINT: hosting-restricted, GROUP trip → 403 in the restriction's own words; no meetup written", async () => {
    const c = use(seed("hosting"));
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ tripId: TRIP, visibility: "trip" }));
    assert.equal(r.status, 403, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.error, "trust_restriction");
    assert.equal(r.body.message, RESTRICTION_SENTENCES.hosting);
    assert.deepEqual(r.body.restrictionTypes, ["hosting"]);
    assert.equal(meetupWrites(c), 0);
  });

  it("an unreadable restriction state on a GROUP trip → 503 'try again', never 'restricted'; nothing written", async () => {
    const c = use(seed(null), UNREADABLE);
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ tripId: TRIP, visibility: "trip" }));
    assert.equal(r.status, 503, JSON.stringify(r.body).slice(0, 300));
    assert.equal(r.body.message, RESTRICTION_UNVERIFIABLE_MESSAGE);
    assert.doesNotMatch(JSON.stringify(r.body), /restrict/i);
    assert.equal(meetupWrites(c), 0);
  });

  it("D-24a: a SOLO trip is the person's alone — not refused under hosting", async () => {
    use(seed("hosting"));
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ tripId: SOLO, visibility: "trip" }));
    assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
  });

  it("not more than told: a MESSAGING restriction does not refuse a trip plan (D-24: the messaging sentence does not name it)", async () => {
    use(seed("messaging"));
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ tripId: TRIP, visibility: "trip" }));
    assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
  });

  it("a meetup on no trip is not a trip's shared plan: not refused, and no restriction is read for it", async () => {
    const c = use(seed("hosting"), UNREADABLE);
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ inviteeIds: [BEN] }));
    assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
    assert.equal(c._observed.selects.filter((s) => s.table === "trust_restrictions").length, 0);
  });

  it("CONTROL: unrestricted on the GROUP trip → the gate passes", async () => {
    use(seed(null));
    const r = await call(harness.base, "POST", "/meetups", ANA, body({ tripId: TRIP, visibility: "trip" }));
    assert.equal(gateRefused(r), false, JSON.stringify(r.body).slice(0, 300));
  });
});
