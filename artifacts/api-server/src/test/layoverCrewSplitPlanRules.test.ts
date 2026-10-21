/**
 * LAYOVER 165, lane B2-CREW — the pure rules behind four rows, swept without a database:
 *
 *   L134/L135  `certifyTimedCrewPlan` (LayoverCrewService.ts): a split plan with T1/T2 is certified against EVERY
 *              member of EVERY branch — each member's own hard return, the branch's stops before its T, no landside
 *              branch for a member already told to head back.
 *   L144       `crewAbortNoticeAuthorization` (LayoverCrewAbortNotice.ts): exactly three bases (explicit tick, a
 *              live crew location share, an active Safe Return emergency contact); blocks always win; the flag first.
 *   L139       `sharedRideCapability` / `sharedRideOffer` (LayoverSharedRides.ts): no mechanism → unavailable for
 *              every airport; every contract term is checked; a co-rider sees one leg, an unrelated viewer nothing.
 *   L130       the consent predicates (LayoverDiscoveryConsent.ts): a consent names its viewer ON A SESSION; only
 *              accepted + unexpired shows the pair; the ending transition each side may take.
 *
 * Run: node --import tsx/esm --test src/test/layoverCrewSplitPlanRules.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility } from "../services/airport/LayoverFeasibility.js";
import { certifyTimedCrewPlan, type CrewMember, type TimedCrewBranch } from "../services/airport/LayoverCrewService.js";
import { crewAbortNoticeAuthorization, type CrewAbortAuthorizationInput } from "../services/layover/LayoverCrewAbortNotice.js";
import { SHARED_RIDE_MECHANISMS, sharedRideCapability, sharedRideOffer, type SharedRideOfferInput } from "../services/layover/LayoverSharedRides.js";
import { consentShowsPair, consentSide, endingTransition, normaliseHandle, type ConsentRow } from "../services/layover/LayoverDiscoveryConsent.js";

const NOW = Date.UTC(2026, 9, 18, 6, 0, 0);
const H = 3_600_000;
const AIRPORT = {
  id: "airport-sin", iataCode: "SIN", timezone: "Asia/Singapore", verified: false,
  domesticBufferMin: 60, internationalBufferMin: 120, immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
};

function member(userId: string, departsInH: number): CrewMember {
  const session = {
    id: `s-${userId}`,
    arrivalTime: new Date(NOW - 30 * 60_000).toISOString(),
    departureTime: new Date(NOW + departsInH * H).toISOString(),
    boardingTime: null, flightType: "international" as const, immigrationRequired: false, checkedBags: false, wantsToLeave: true,
  };
  return { userId, sessionId: session.id, record: certifySessionFeasibility(AIRPORT, session, { nowMs: NOW }) };
}
const hard = (m: CrewMember) => m.record!.deadline.hardReturnTime.getTime();
const branch = (id: string, memberIds: string[], returnByMs: number, stops: TimedCrewBranch["stops"] = []): TimedCrewBranch => ({ branchId: id, memberIds, stops, returnByMs });

describe("L134/L135 certifyTimedCrewPlan — a split is certified against every member branch", () => {
  const a = member("a", 4), b = member("b", 10), c = member("c", 10);
  const members = [a, b, c];

  it("S1 the spec's shape certifies: A back by T1 (inside A's own deadline), B/C until T2 (inside theirs)", () => {
    const s = certifyTimedCrewPlan({ branches: [branch("a", ["a"], hard(a) - 10 * 60_000), branch("rest", ["b", "c"], hard(b) - 10 * 60_000)] }, members, { nowMs: NOW });
    assert.equal(s.feasible, true, JSON.stringify(s.reasons));
    assert.equal(s.split, true);
    assert.deepEqual(s.branches.map((x) => x.feasible), [true, true]);
    assert.ok(s.branches[1]!.returnBy && Date.parse(s.branches[1]!.returnBy) > hard(a), "T2 runs past the crew minimum, which a split is allowed to do");
  });

  it("S2 a branch whose T is past ONE of its members' deadlines is refused — certified per member, not per crew best", () => {
    const s = certifyTimedCrewPlan({ branches: [branch("all", ["a", "b", "c"], hard(b) - 60_000)] }, members, { nowMs: NOW });
    assert.equal(s.feasible, false);
    assert.ok(s.branches[0]!.reasons.includes("branch_returns_after_member_deadline"), JSON.stringify(s.branches[0]!.reasons));
  });

  it("S3 moving A into the late branch makes only THAT branch infeasible, and names why", () => {
    const s = certifyTimedCrewPlan({ branches: [branch("early", ["c"], hard(c) - H), branch("late", ["a", "b"], hard(b) - H)] }, members, { nowMs: NOW });
    assert.deepEqual(s.branches.map((x) => x.feasible), [true, false]);
    assert.equal(s.feasible, false);
  });

  it("S4 stops that do not fit before the branch's T are refused, even when the T is inside every deadline", () => {
    const stops = [{ title: "Gardens", durationMin: 180, travelMin: 40, insideAirport: false }];
    const s = certifyTimedCrewPlan({ branches: [branch("a", ["a"], NOW + 2 * H, stops), branch("rest", ["b", "c"], NOW + 6 * H)] }, members, { nowMs: NOW });
    assert.ok(s.branches[0]!.reasons.includes("stops_do_not_fit_before_branch_return"), JSON.stringify(s.branches[0]!.reasons));
    assert.equal(s.branches[1]!.feasible, true);
  });

  it("S5 a T in the past is refused", () => {
    const s = certifyTimedCrewPlan({ branches: [branch("all", ["a", "b", "c"], NOW - 60_000)] }, members, { nowMs: NOW });
    assert.ok(s.reasons.includes("branch_return_time_passed"));
  });

  it("S6 an uncertified member makes their branch infeasible (never assumed fine), and the base solver's reasons survive", () => {
    const s = certifyTimedCrewPlan({ branches: [branch("all", ["a", "x"], NOW + H)] }, [a, { userId: "x", sessionId: "s-x", record: null }], { nowMs: NOW });
    assert.equal(s.feasible, false);
    assert.ok(s.reasons.includes("member_without_certified_feasibility"));
  });

  it("S7 a member left out of every branch, or put in two, is refused (the base solver's assignment rule)", () => {
    const left = certifyTimedCrewPlan({ branches: [branch("ab", ["a", "b"], NOW + H)] }, members, { nowMs: NOW });
    assert.ok(left.reasons.includes("member_unassigned"));
    const twice = certifyTimedCrewPlan({ branches: [branch("ab", ["a", "b"], NOW + H), branch("bc", ["b", "c"], NOW + H)] }, members, { nowMs: NOW });
    assert.ok(twice.reasons.includes("member_assigned_twice"));
  });

  it("S8 a member already told to head back (RETURN_NOW) cannot be put on a branch that leaves the airport", () => {
    const late = member("late", 2.2);
    assert.ok(["RETURN_NOW", "CONNECTION_AT_RISK"].includes(late.record!.envelope.returnState), `fixture: ${late.record!.envelope.returnState}`);
    const out = [{ title: "Market", durationMin: 0, travelMin: 0, insideAirport: false }];
    const inside = [{ title: "Lounge", durationMin: 0, travelMin: 0, insideAirport: true }];
    const leaves = certifyTimedCrewPlan({ branches: [branch("l", ["late"], NOW + 10 * 60_000, out)] }, [late], { nowMs: NOW });
    assert.ok(leaves.reasons.includes("member_must_return_now"), JSON.stringify(leaves.reasons));
    const stays = certifyTimedCrewPlan({ branches: [branch("l", ["late"], NOW + 10 * 60_000, inside)] }, [late], { nowMs: NOW });
    assert.ok(!stays.reasons.includes("member_must_return_now"));
  });
});

describe("L135 (solver level) a landside branch is judged against EACH member's own gate — shown with records that carry their owner's entry fact; the route itself reads no crewmate's corridor (pinned, layoverEntryGate.test.ts)", () => {
  const session = (id: string) => ({
    id, arrivalTime: new Date(NOW - 30 * 60_000).toISOString(), departureTime: new Date(NOW + 10 * H).toISOString(),
    boardingTime: null, flightType: "international" as const, immigrationRequired: true, checkedBags: false, wantsToLeave: true,
  });
  const corridor = { passportCountry: "US", destinationCountry: "SG" };
  const permitted = { state: "permitted", corridor, status: "visa_free" } as const;
  const refused = { state: "refused", corridor: { passportCountry: "XK", destinationCountry: "SG" }, status: "visa_required" } as const;
  const withEntry = (userId: string, entry: unknown): CrewMember => ({ userId, sessionId: `s-${userId}`, record: certifySessionFeasibility(AIRPORT, session(`s-${userId}`), { nowMs: NOW, entry: entry as never }) });
  const out = [{ title: "Gardens", durationMin: 60, travelMin: 30, insideAirport: false }];

  it("S9 one refused border closes the shared landside branch; the same outing for the permitted member alone does not close", () => {
    const a = withEntry("a", permitted), b = withEntry("b", refused);
    const t = NOW + 4 * H;
    const together = certifyTimedCrewPlan({ branches: [branch("ab", ["a", "b"], t, out)] }, [a, b], { nowMs: NOW });
    assert.equal(together.branches[0]!.landside, "closed");
    assert.ok(together.reasons.includes("landside_closed_for_member"));
    const apart = certifyTimedCrewPlan({ branches: [branch("a", ["a"], t, out), branch("b", ["b"], t, [{ title: "Jewel", durationMin: 30, travelMin: 0, insideAirport: true }])] }, [a, b], { nowMs: NOW });
    assert.notEqual(apart.branches[0]!.landside, "closed", JSON.stringify(apart.branches[0]));
    assert.ok(!apart.reasons.includes("landside_closed_for_member"), JSON.stringify(apart.reasons));
  });
});

describe("L144 crewAbortNoticeAuthorization — the explicit rule", () => {
  const base: CrewAbortAuthorizationInput = {
    flagEnabled: true, requested: false, travellerSharingAllowed: true, liveCrewShare: false,
    recipient: { blocked: false, publishable: true, emergencyContact: false },
  };
  const at = (over: Partial<CrewAbortAuthorizationInput>, rec: Partial<CrewAbortAuthorizationInput["recipient"]> = {}) =>
    crewAbortNoticeAuthorization({ ...base, ...over, recipient: { ...base.recipient, ...rec } });

  it("U1 ALLOW: the explicit tick on this abort", () => { assert.deepEqual(at({ requested: true }), { allowed: true, basis: "explicit_request" }); });
  it("U2 ALLOW: a live crew location share to this crew (established authorization), no tick", () => {
    assert.deepEqual(at({ liveCrewShare: true }), { allowed: true, basis: "standing_crew_location_share" });
  });
  it("U3 ALLOW: an emergency contact of an active Safe Return session, even with the traveller's sharing paused", () => {
    assert.deepEqual(at({ travellerSharingAllowed: false }, { emergencyContact: true, publishable: false }), { allowed: true, basis: "emergency_contact" });
  });
  it("U4 DENY: no tick, no live share, no emergency rule", () => { assert.deepEqual(at({}), { allowed: false, denial: "not_requested" }); });
  it("U5 DENY: the standing refusal wins over the tick and over the share", () => {
    assert.deepEqual(at({ requested: true, travellerSharingAllowed: false }), { allowed: false, denial: "sharing_not_allowed" });
    assert.deepEqual(at({ liveCrewShare: true, travellerSharingAllowed: false }), { allowed: false, denial: "sharing_not_allowed" });
  });
  it("U6 DENY: a crewmate whose own sharing does not publish them is not told on a user basis", () => {
    assert.deepEqual(at({ requested: true }, { publishable: false }), { allowed: false, denial: "recipient_not_publishable" });
  });
  it("U7 DENY: a block wins over EVERY basis, the emergency one included", () => {
    for (const over of [{ requested: true }, { liveCrewShare: true }, {}]) {
      assert.deepEqual(at(over, { blocked: true, emergencyContact: true }), { allowed: false, denial: "blocked" });
    }
  });
  it("U8 DENY: flag off decides first, on every basis", () => {
    assert.deepEqual(at({ flagEnabled: false, requested: true, liveCrewShare: true }, { emergencyContact: true }), { allowed: false, denial: "crew_notify_not_enabled" });
  });
});

describe("L139 shared rides — the explicit product contract", () => {
  it("R1 the mechanism registry is empty, so every airport answers unavailable with a reason", () => {
    assert.equal(SHARED_RIDE_MECHANISMS.length, 0);
    for (const iata of ["SIN", "NRT", "BKK", "MIA"]) {
      const c = sharedRideCapability(iata);
      assert.equal(c.available, false);
      if (!c.available) assert.equal(c.reason, "no_shared_ride_mechanism");
    }
    const u = sharedRideCapability(null);
    assert.equal(u.available, false);
    if (!u.available) assert.equal(u.reason, "airport_unknown");
  });

  const leg = { fromLabel: "SIN T3", toLabel: "Marina Bay", departsAtIso: new Date(NOW + H).toISOString() };
  const itinerary = [{ fromLabel: "SIN T1", toLabel: "SIN T3", departsAtIso: new Date(NOW).toISOString() }, leg, { fromLabel: "Marina Bay", toLabel: "SIN T3", departsAtIso: new Date(NOW + 3 * H).toISOString() }];
  const ok: SharedRideOfferInput = {
    capability: sharedRideCapability("SIN", [{ id: "test-mechanism", airports: ["SIN"], requiresVerifiedIdentity: true }]),
    offererOptedIn: true, viewerOptedIn: true, offererVerified: true, viewerVerified: true, blocked: false,
    landsideClosedForEither: false, offererReturnState: "NORMAL", viewerReturnState: "NORMAL", sharedLeg: leg, fullItinerary: itinerary,
  };

  it("R2 with a mechanism and every term met, a co-rider sees ONE leg and never the rest of the itinerary", () => {
    const o = sharedRideOffer(ok);
    assert.equal(o.allowed, true, JSON.stringify(o.denials));
    assert.deepEqual(o.disclosure.leg, leg);
    assert.equal(o.disclosure.withheldLegs, 2);
  });
  it("R3 today (no mechanism) nothing is offered and nothing is disclosed, even to an opted-in co-rider", () => {
    const o = sharedRideOffer({ ...ok, capability: sharedRideCapability("SIN") });
    assert.equal(o.allowed, false);
    assert.deepEqual(o.denials, ["no_shared_ride_mechanism"]);
    assert.equal(o.disclosure.offered, false);
    assert.equal(o.disclosure.leg, null);
  });
  it("R4 each term alone refuses: opt-in both sides, verification, block, landside gate, escalation", () => {
    const cases: Array<[Partial<SharedRideOfferInput>, string]> = [
      [{ offererOptedIn: false }, "offerer_not_opted_in"], [{ viewerOptedIn: false }, "viewer_not_opted_in"],
      [{ viewerVerified: false }, "identity_not_verified"], [{ blocked: true }, "blocked"],
      [{ landsideClosedForEither: true }, "landside_closed"], [{ viewerReturnState: "RETURN_NOW" }, "return_state_escalated"],
      [{ offererReturnState: null }, "return_state_escalated"],
    ];
    for (const [over, denial] of cases) {
      const o = sharedRideOffer({ ...ok, ...over });
      assert.equal(o.allowed, false, denial);
      assert.ok(o.denials.includes(denial as never), `${denial}: ${JSON.stringify(o.denials)}`);
      assert.equal(o.disclosure.leg, null, `${denial}: a refused offer disclosed a leg`);
    }
  });
});

describe("L130 the consent predicates", () => {
  const row = (over: Partial<ConsentRow> = {}): ConsentRow => ({
    id: "c1", requesterSessionId: "sA", targetSessionId: "sB", requesterUserId: "A", targetUserId: "B",
    status: "accepted", requestedAt: new Date(NOW - H).toISOString(), respondedAt: new Date(NOW - H / 2).toISOString(),
    expiresAt: new Date(NOW + H).toISOString(), ...over,
  });

  it("C1 a consent names its viewer ON A SESSION: the same person on another layover is not a party (cross-session)", () => {
    assert.equal(consentSide(row(), "A", "sA"), "requester");
    assert.equal(consentSide(row(), "B", "sB"), "target");
    assert.equal(consentSide(row(), "A", "sA2"), null);
    assert.equal(consentSide(row(), "X", "sB"), null, "a session id alone is not identity");
  });
  it("C2 only ACCEPTED and UNEXPIRED shows the pair — both orders", () => {
    assert.equal(consentShowsPair(row(), "A", "sA", NOW), true);
    assert.equal(consentShowsPair(row(), "B", "sB", NOW), true);
    for (const status of ["requested", "declined", "withdrawn", "revoked"] as const) assert.equal(consentShowsPair(row({ status }), "A", "sA", NOW), false, status);
    assert.equal(consentShowsPair(row({ expiresAt: new Date(NOW).toISOString() }), "A", "sA", NOW), false, "expired at the instant");
  });
  it("C3 ending: accepted → revoked by either side; requested → withdrawn (requester) / declined (target); final states end nothing", () => {
    assert.equal(endingTransition(row(), "requester"), "revoked");
    assert.equal(endingTransition(row(), "target"), "revoked");
    assert.equal(endingTransition(row({ status: "requested" }), "requester"), "withdrawn");
    assert.equal(endingTransition(row({ status: "requested" }), "target"), "declined");
    for (const status of ["declined", "withdrawn", "revoked"] as const) assert.equal(endingTransition(row({ status }), "requester"), null);
  });
  it("C4 handles are normalised and anything else refused", () => {
    assert.equal(normaliseHandle(" @Ana_01 "), "ana_01");
    for (const bad of ["", "@", "a b", "x".repeat(65), 7, null]) assert.equal(normaliseHandle(bad), null, String(bad));
  });
});
