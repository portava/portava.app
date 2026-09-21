/**
 * Layover §14.1: crew constraint solving, and the disclosure rules that guard
 * the crew feature BEFORE it exists.
 *
 * node:test + node:assert/strict. Pure functions over LayoverFeasibility's
 * certified records — no HTTP, no database, no clock. The verdict is the EXIT CODE.
 *
 * ── WHY THIS SUITE MATTERS MORE THAN THE USUAL "NEW FEATURE" SUITE ──────────
 * The census scores L136 ("no precise stranger location by default") and L138
 * ("traveler pins must not expose an unsafe meet-here action") as `N ∅`: the
 * forbidden thing is absent only because the whole feature is absent, and
 * NOTHING GUARDS ITS ADDITION. These tests are that guard. The important
 * assertions are therefore the NEGATIVE ones — the argument combinations that
 * must never yield `precise`, and the ones that must never yield an allowed
 * meet action — and they are swept exhaustively rather than sampled, so a
 * future edit cannot open a hole in a combination nobody thought to write down.
 *
 * ── WHAT ELSE COULD HAVE MADE THIS PASS ─────────────────────────────────────
 * `sharedReturnBy` returning null for everything would satisfy a test that only
 * checks the uncertified case, so the happy path pins the exact minimum and the
 * binding member. `certifyCrewPlan` returning `feasible: false` for everything
 * would satisfy every infeasibility test, so each one is paired with a
 * feasible control differing in exactly one input.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverCrewConstraints.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { certifySessionFeasibility, type LayoverFeasibilityRecord } from "../services/airport/LayoverFeasibility.js";
import {
  sharedReturnBy,
  certifyCrewPlan,
  unsplitPlan,
  branchNeededMinutes,
  evaluateCrewLocationShare,
  locationPrecisionFor,
  meetActionAvailability,
  sharedRideDisclosure,
  LAYOVER_CREW_VERSION,
  type CrewMember,
  type CrewLocationGrant,
  type MeetActionDenial as MeetDenial,
} from "../services/airport/LayoverCrewService.js";

const NOW = Date.UTC(2026, 8, 8, 6, 0, 0);

const AIRPORT = {
  id: "airport-tpe",
  iataCode: "TPE",
  timezone: "Asia/Taipei",
  verified: false,
  domesticBufferMin: 60,
  internationalBufferMin: 120,
  immigrationExtraMin: 30,
  checkedBagsExtraMin: 15,
  trafficExtraMin: 20,
};

/** A certified member whose flight departs `hours` from NOW. */
function member(userId: string, hours: number, over: Record<string, unknown> = {}): CrewMember {
  const session = {
    id: `session-${userId}`,
    arrivalTime: new Date(NOW - 30 * 60_000).toISOString(),
    departureTime: new Date(NOW + hours * 3_600_000).toISOString(),
    boardingTime: null,
    flightType: "international" as const,
    immigrationRequired: false,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
  const record = certifySessionFeasibility(AIRPORT, session, { nowMs: NOW });
  return { userId, sessionId: session.id, record };
}

function uncertified(userId: string): CrewMember {
  return { userId, sessionId: `session-${userId}`, record: null };
}

function hardReturnOf(m: CrewMember): number {
  return (m.record as LayoverFeasibilityRecord).deadline.hardReturnTime.getTime();
}

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 shared_return_by = min(member.required_return_by)", () => {
  it("takes the MINIMUM and names the member who set it", () => {
    const early = member("a", 6);
    const late = member("b", 12);
    const r = sharedReturnBy([late, early]);
    assert.equal(r.iso, new Date(hardReturnOf(early)).toISOString());
    assert.deepEqual(r.bindingMemberIds, ["a"]);
    assert.ok(hardReturnOf(early) < hardReturnOf(late), "control: the two deadlines really differ");
  });

  it("names every member when two share the earliest deadline", () => {
    const r = sharedReturnBy([member("a", 6), member("b", 6), member("c", 12)]);
    assert.deepEqual(r.bindingMemberIds.sort(), ["a", "b"]);
  });

  it("REFUSES rather than taking a minimum over the readable subset", () => {
    // A minimum over fewer members is LATER than the truth — the one direction
    // a safety deadline must never move.
    const r = sharedReturnBy([member("a", 6), uncertified("b")]);
    assert.equal(r.iso, null);
    assert.deepEqual(r.bindingMemberIds, []);
  });

  it("an empty crew has no shared deadline", () => {
    assert.deepEqual(sharedReturnBy([]), { iso: null, bindingMemberIds: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 the crew plan is certified against EVERY member branch", () => {
  const shortStops = [
    { title: "Coffee", durationMin: 20, travelMin: 10, insideAirport: false },
  ];

  it("POSITIVE CONTROL: a short plan fits a crew with hours to spare", () => {
    const members = [member("a", 10), member("b", 12)];
    const sol = certifyCrewPlan(unsplitPlan(members, shortStops), members, { nowMs: NOW });
    assert.equal(sol.feasible, true, `reasons: ${sol.reasons.join(",")}`);
    assert.equal(sol.split, false);
    assert.equal(sol.crewVersion, LAYOVER_CREW_VERSION);
    assert.equal(sol.branches.length, 1);
    assert.equal(sol.branches[0].feasible, true);
  });

  it("ONE member who cannot make it makes the whole branch infeasible", () => {
    // "a" has a long layover, "b" is nearly at their deadline. The plan fits
    // the crew's average and fits "a" alone; it must still be refused.
    const roomy = member("a", 12);
    const tight = member("b", 3);
    const members = [roomy, tight];
    const long = [{ title: "City", durationMin: 120, travelMin: 30, insideAirport: false }];

    const aloneSol = certifyCrewPlan(unsplitPlan([roomy], long), [roomy], { nowMs: NOW });
    assert.equal(aloneSol.feasible, true, "control: the plan is fine for the roomy member alone");

    const sol = certifyCrewPlan(unsplitPlan(members, long), members, { nowMs: NOW });
    assert.equal(sol.feasible, false, "one member's constraint binds the branch");
    assert.ok(
      sol.reasons.includes("plan_exceeds_usable_minutes") ||
        sol.reasons.includes("plan_ends_after_shared_return"),
      `reasons: ${sol.reasons.join(",")}`,
    );
    const tightSlack = sol.branches[0].perMemberSlackMin.find((s) => s.userId === "b");
    assert.ok(tightSlack && tightSlack.slackMin !== null && tightSlack.slackMin < 0);
  });

  it("the branch folds usable minutes by MINIMUM — isolated from the deadline check", () => {
    // FALSE GREEN CAUGHT IN THIS LANE. The first version of this suite proved
    // "one member binds the branch" with a member who ALSO breached
    // `plan_ends_after_shared_return`, so swapping the usable-minutes fold from
    // Math.min to Math.max left the suite green: the deadline check was doing
    // all the work. This test exercises the usable-minutes rule ALONE.
    //
    // `usableMinutes = hardReturn − max(now, arrival + exitDelay)`, so a member
    // who has only just landed and faces immigration plus bag reclaim has a
    // SMALLER usable window than a member whose deadline is EARLIER. Here the
    // tight usable window and the earliest deadline belong to different people,
    // and the plan is sized to breach only the former.
    // Both land AT `NOW`, so `earliestOutTime` is genuinely ahead of the clock
    // for each of them and the exit delay actually shortens the usable window.
    // (With the helper's default arrival 30 minutes ago, the quicker member's
    // exit delay has already elapsed and `usableMinutes` collapses onto
    // "minutes until the deadline" — which is what made the first draft of this
    // test assert an impossible inequality.)
    const justLanded = { arrivalTime: new Date(NOW).toISOString() };
    const slow = member("slow", 8, { ...justLanded, immigrationRequired: true, checkedBags: true });
    const fast = member("fast", 6, { ...justLanded, immigrationRequired: false, checkedBags: false });
    const members = [slow, fast];

    const usableSlow = slow.record!.envelope.usableMinutes;
    const usableFast = fast.record!.envelope.usableMinutes;
    const minUsable = Math.min(usableSlow, usableFast);
    const maxUsable = Math.max(usableSlow, usableFast);
    assert.ok(maxUsable > minUsable, `control: the two usable windows must differ (${usableSlow} vs ${usableFast})`);

    const earliestHardReturn = Math.min(hardReturnOf(slow), hardReturnOf(fast));
    const minutesToEarliestDeadline = Math.round((earliestHardReturn - NOW) / 60_000);

    // Between the two folds, and comfortably inside the earliest deadline.
    const needed = minUsable + 5;
    assert.ok(needed < maxUsable, `control: the plan must fit the LOOSER member (${needed} < ${maxUsable})`);
    assert.ok(
      needed < minutesToEarliestDeadline,
      `control: the plan must end before the earliest deadline (${needed} < ${minutesToEarliestDeadline}) ` +
        "so the deadline check cannot be what refuses it",
    );

    const plan = unsplitPlan(members, [
      { title: "Walk", durationMin: needed, travelMin: 0, insideAirport: false },
    ]);
    const sol = certifyCrewPlan(plan, members, { nowMs: NOW });

    assert.equal(sol.feasible, false, "the tightest member's usable window must bind the branch");
    assert.deepEqual(
      sol.branches[0].reasons,
      ["plan_exceeds_usable_minutes"],
      "ONLY the usable-minutes rule may fire here; if the deadline rule also fired, this test proves nothing",
    );
    assert.equal(sol.branches[0].usableMinutes, minUsable, "the branch reports the MINIMUM, not the maximum");

    // And the same plan one minute shorter than the tightest window is fine.
    const okSol = certifyCrewPlan(
      unsplitPlan(members, [{ title: "Walk", durationMin: minUsable - 1, travelMin: 0, insideAirport: false }]),
      members,
      { nowMs: NOW },
    );
    assert.equal(okSol.feasible, true, `control: reasons ${okSol.reasons.join(",")}`);
  });

  it("an explicit split lets B/C continue past the crew's shared return-by", () => {
    const leaver = member("a", 3);
    const stayer1 = member("b", 12);
    const stayer2 = member("c", 10);
    const members = [leaver, stayer1, stayer2];

    const long = [{ title: "Museum", durationMin: 150, travelMin: 30, insideAirport: false }];
    const together = certifyCrewPlan(unsplitPlan(members, long), members, { nowMs: NOW });
    assert.equal(together.feasible, false, "control: undivided, the earliest deadline binds everyone");

    const split = certifyCrewPlan(
      {
        branches: [
          { branchId: "A", memberIds: ["a"], stops: [{ title: "Coffee", durationMin: 15, travelMin: 5, insideAirport: true }] },
          { branchId: "BC", memberIds: ["b", "c"], stops: long },
        ],
      },
      members,
      { nowMs: NOW },
    );
    assert.equal(split.split, true);
    assert.equal(split.feasible, true, `reasons: ${split.reasons.join(",")}`);
    // The CREW-WIDE shared return-by is still the earliest member's — the split
    // is the exception that lets a branch run past it, not a redefinition of it.
    assert.equal(split.sharedReturnBy, new Date(hardReturnOf(leaver)).toISOString());
    assert.deepEqual(split.bindingMemberIds, ["a"]);
    const bc = split.branches.find((b) => b.branchId === "BC")!;
    assert.ok(
      new Date(bc.branchReturnBy!).getTime() > new Date(split.sharedReturnBy!).getTime(),
      "the continuing branch has a later branch return-by than the crew's",
    );
    // SECOND FALSE GREEN CAUGHT IN THIS LANE. `plan_ends_after_shared_return`
    // can never fire without `plan_exceeds_usable_minutes` also firing — for a
    // member, `usableMinutes <= minutes-to-deadline` by construction — so
    // swapping the branch-return-by fold from min to MAX changed no verdict and
    // no test noticed. The fold is observable in the REPORTED field, so that is
    // what is pinned: the two stayers now have DIFFERENT deadlines and the
    // branch must report the earlier one.
    assert.ok(
      hardReturnOf(stayer2) < hardReturnOf(stayer1),
      "control: the two continuing members must have different deadlines",
    );
    assert.equal(
      bc.branchReturnBy,
      new Date(hardReturnOf(stayer2)).toISOString(),
      "a branch's return-by is the MINIMUM over its own members",
    );
    assert.deepEqual(bc.bindingMemberIds, ["c"]);
  });

  it("a member assigned to NO branch is refused, not silently unconstrained", () => {
    const members = [member("a", 10), member("b", 10)];
    const sol = certifyCrewPlan(
      { branches: [{ branchId: "A", memberIds: ["a"], stops: shortStops }] },
      members,
      { nowMs: NOW },
    );
    assert.equal(sol.feasible, false);
    assert.ok(sol.reasons.includes("member_unassigned"));
  });

  it("a member assigned TWICE is refused (two contradictory constraints)", () => {
    const members = [member("a", 10)];
    const sol = certifyCrewPlan(
      {
        branches: [
          { branchId: "A", memberIds: ["a"], stops: shortStops },
          { branchId: "B", memberIds: ["a"], stops: shortStops },
        ],
      },
      members,
      { nowMs: NOW },
    );
    assert.equal(sol.feasible, false);
    assert.ok(sol.reasons.includes("member_assigned_twice"));
  });

  it("an UNCERTIFIED member is not assumed fine", () => {
    const members = [member("a", 10), uncertified("b")];
    const sol = certifyCrewPlan(unsplitPlan(members, shortStops), members, { nowMs: NOW });
    assert.equal(sol.feasible, false);
    assert.ok(sol.reasons.includes("member_without_certified_feasibility"));
    assert.equal(sol.sharedReturnBy, null);
    assert.equal(sol.branches[0].branchReturnBy, null);
  });

  it("an empty crew is not a feasible crew", () => {
    const sol = certifyCrewPlan({ branches: [] }, [], { nowMs: NOW });
    assert.equal(sol.feasible, false);
    assert.ok(sol.reasons.includes("no_members"));
  });

  it("needed minutes count the ride back from the last landside stop", () => {
    assert.equal(
      branchNeededMinutes([
        { title: "A", durationMin: 30, travelMin: 10, insideAirport: false },
        { title: "B", durationMin: 20, travelMin: 5, insideAirport: false },
      ]),
      // 30+10 + 20+5 + 5 back
      70,
    );
    // Airside only: nothing to come back from.
    assert.equal(
      branchNeededMinutes([{ title: "Lounge", durationMin: 45, travelMin: 0, insideAirport: true }]),
      45,
    );
  });

  it("the solution carries the certification identity of every member record", () => {
    const members = [member("a", 10), member("b", 12)];
    const sol = certifyCrewPlan(unsplitPlan(members, shortStops), members, { nowMs: NOW });
    assert.equal(sol.certifiedOver.length, 2);
    for (const c of sol.certifiedOver) {
      assert.ok(c.inputHash?.startsWith("sha256:"));
      assert.ok(c.engineVersion);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 crew location sharing expires — five terminators plus a TTL", () => {
  const grant: CrewLocationGrant = {
    grantedByUserId: "b", crewId: "crew-1",
    grantedAtMs: NOW, expiresAtMs: NOW + 2 * 3_600_000,
  };

  it("POSITIVE CONTROL: a fresh grant with no terminator is live", () => {
    const r = evaluateCrewLocationShare(grant, {}, NOW + 60_000);
    assert.deepEqual(r, { active: true, endedBy: null, endedAtMs: null });
  });

  it("an absent grant is never_granted, NOT expired", () => {
    assert.equal(evaluateCrewLocationShare(null, {}, NOW).endedBy, "never_granted");
    assert.equal(evaluateCrewLocationShare(undefined, {}, NOW).active, false);
  });

  for (const [signal, reason] of [
    ["crewDissolvedAtMs", "crew_dissolved"],
    ["airportReentryAtMs", "airport_reentry"],
    ["boardingAtMs", "boarding"],
    ["sessionExpiredAtMs", "session_expired"],
    ["revokedAtMs", "user_revoked"],
  ] as const) {
    it(`${reason} ends the share`, () => {
      const r = evaluateCrewLocationShare(grant, { [signal]: NOW + 600_000 }, NOW + 900_000);
      assert.equal(r.active, false);
      assert.equal(r.endedBy, reason);
      // Control: the same share is still live one minute BEFORE the signal.
      assert.equal(evaluateCrewLocationShare(grant, { [signal]: NOW + 600_000 }, NOW + 540_000).active, true);
    });
  }

  it("the TTL ends it with nothing else happening", () => {
    const r = evaluateCrewLocationShare(grant, {}, grant.expiresAtMs + 1);
    assert.equal(r.active, false);
    assert.equal(r.endedBy, "ttl_elapsed");
  });

  it("reports the FIRST cause, not whichever branch ran first", () => {
    const r = evaluateCrewLocationShare(
      grant,
      { boardingAtMs: NOW + 300_000, crewDissolvedAtMs: NOW + 900_000 },
      NOW + 3_600_000,
    );
    assert.equal(r.endedBy, "boarding");
    assert.equal(r.endedAtMs, NOW + 300_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 no precise stranger location by default — swept, not sampled", () => {
  const grant: CrewLocationGrant = {
    grantedByUserId: "target", crewId: "crew-1",
    grantedAtMs: NOW, expiresAtMs: NOW + 3_600_000,
  };

  it("POSITIVE CONTROL: a live, correctly-scoped grant from the target IS precise", () => {
    const r = locationPrecisionFor({
      viewerUserId: "viewer", targetUserId: "target", sameCrewId: "crew-1",
      blocked: false, grant, signals: {}, nowMs: NOW + 60_000,
    });
    assert.equal(r.precision, "precise");
  });

  it("a stranger gets NOTHING", () => {
    const r = locationPrecisionFor({
      viewerUserId: "viewer", targetUserId: "target", sameCrewId: null,
      blocked: false, grant, signals: {}, nowMs: NOW + 60_000,
    });
    assert.equal(r.precision, "none");
    assert.equal(r.reason, "not_in_a_crew_together");
  });

  it("a crew mate WITHOUT a live grant gets the meeting point, never the person", () => {
    const r = locationPrecisionFor({
      viewerUserId: "viewer", targetUserId: "target", sameCrewId: "crew-1",
      blocked: false, grant: null, signals: {}, nowMs: NOW + 60_000,
    });
    assert.equal(r.precision, "meeting_point");
  });

  it("a grant scoped to ANOTHER crew does not carry over", () => {
    const r = locationPrecisionFor({
      viewerUserId: "viewer", targetUserId: "target", sameCrewId: "crew-2",
      blocked: false, grant, signals: {}, nowMs: NOW + 60_000,
    });
    assert.notEqual(r.precision, "precise");
    assert.equal(r.reason, "grant_scoped_to_another_crew");
  });

  it("a grant from SOMEONE ELSE does not reveal the target", () => {
    const r = locationPrecisionFor({
      viewerUserId: "viewer", targetUserId: "target", sameCrewId: "crew-1",
      blocked: false,
      grant: { ...grant, grantedByUserId: "third-party" },
      signals: {}, nowMs: NOW + 60_000,
    });
    assert.notEqual(r.precision, "precise");
    assert.equal(r.reason, "grant_not_from_target");
  });

  it("EXHAUSTIVE: nothing but a live, target-issued, crew-scoped grant yields precise", () => {
    const crews: Array<string | null> = [null, "crew-1", "crew-2"];
    const grants: Array<CrewLocationGrant | null> = [
      null,
      grant,
      { ...grant, grantedByUserId: "third-party" },
      { ...grant, crewId: "crew-9" },
      { ...grant, expiresAtMs: NOW - 1 },
    ];
    const signalSets = [
      {}, { boardingAtMs: NOW }, { revokedAtMs: NOW }, { crewDissolvedAtMs: NOW },
      { airportReentryAtMs: NOW }, { sessionExpiredAtMs: NOW },
    ];
    let preciseCount = 0;
    for (const blocked of [true, false]) {
      for (const sameCrewId of crews) {
        for (const g of grants) {
          for (const signals of signalSets) {
            const r = locationPrecisionFor({
              viewerUserId: "viewer", targetUserId: "target",
              sameCrewId, blocked, grant: g, signals, nowMs: NOW + 60_000,
            });
            const legitimate =
              !blocked && sameCrewId === "crew-1" && g !== null &&
              g.grantedByUserId === "target" && g.crewId === "crew-1" &&
              g.expiresAtMs > NOW + 60_000 &&
              Object.keys(signals).length === 0;
            if (r.precision === "precise") {
              preciseCount++;
              assert.ok(legitimate, `precise leaked: crew=${sameCrewId} blocked=${blocked} signals=${JSON.stringify(signals)}`);
            }
            if (blocked) assert.equal(r.precision, "none", "a block outranks every grant");
          }
        }
      }
    }
    assert.ok(preciseCount > 0, "vacuity guard: at least one combination must legitimately be precise");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 meet-here needs the social/safety gate, and §15 outranks it", () => {
  type MeetInput = Parameters<typeof meetActionAvailability>[0];
  const allGood: MeetInput = {
    blocked: false, mutualConnection: true, sameCrewId: "crew-1",
    meetingPointIsPublicVenue: true, safetyGateCleared: true,
    viewerReturnState: "NORMAL", targetReturnState: "NORMAL",
  };

  it("POSITIVE CONTROL: everything cleared allows the action", () => {
    assert.deepEqual(meetActionAvailability(allGood), { allowed: true, denials: [] });
  });

  it("each gate refuses on its own", () => {
    const cases: Array<[Partial<MeetInput>, MeetDenial]> = [
      [{ blocked: true }, "blocked"],
      [{ mutualConnection: false }, "not_mutual"],
      [{ sameCrewId: null }, "no_crew"],
      [{ meetingPointIsPublicVenue: false }, "meeting_point_not_public"],
      [{ safetyGateCleared: false }, "safety_gate_not_cleared"],
      [{ viewerReturnState: "RETURN_NOW" }, "return_state_escalated"],
      [{ targetReturnState: "CONNECTION_AT_RISK" }, "return_state_escalated"],
      [{ viewerReturnState: null }, "return_state_escalated"],
    ];
    for (const [patch, expected] of cases) {
      const r = meetActionAvailability({ ...allGood, ...patch });
      assert.equal(r.allowed, false, `${expected} must refuse`);
      assert.ok(r.denials.includes(expected), `${expected} not in ${r.denials.join(",")}`);
    }
  });

  it("reports ALL failures so the gate can be explained, not just closed", () => {
    const r = meetActionAvailability({
      ...allGood, mutualConnection: false, meetingPointIsPublicVenue: false,
    });
    assert.deepEqual(r.denials.sort(), ["meeting_point_not_public", "not_mutual"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("§14.1 shared rides — opt-in, and one leg at most", () => {
  const leg = { fromLabel: "Ximending", toLabel: "TPE", departsAtIso: new Date(NOW).toISOString() };
  const itinerary = [
    { fromLabel: "TPE", toLabel: "Taipei 101", departsAtIso: new Date(NOW - 7_200_000).toISOString() },
    { fromLabel: "Taipei 101", toLabel: "Ximending", departsAtIso: new Date(NOW - 3_600_000).toISOString() },
    leg,
  ];

  it("POSITIVE CONTROL: an opted-in offer to a co-rider shows exactly the shared leg", () => {
    const r = sharedRideDisclosure({
      offererOptedIn: true, viewerIsCoRider: true, blocked: false,
      sharedLeg: leg, fullItinerary: itinerary,
    });
    assert.equal(r.offered, true);
    assert.deepEqual(r.leg, leg);
    assert.equal(r.withheldLegs, 2);
    assert.equal(JSON.stringify(r).includes("Taipei 101"), false, "the rest of the itinerary must not travel");
  });

  it("no opt-in means no offer and no itinerary at all", () => {
    const r = sharedRideDisclosure({
      offererOptedIn: false, viewerIsCoRider: true, blocked: false,
      sharedLeg: leg, fullItinerary: itinerary,
    });
    assert.equal(r.offered, false);
    assert.equal(r.leg, null);
    assert.equal(JSON.stringify(r).includes("Ximending"), false);
  });

  it("an unrelated viewer, and a blocked one, get nothing", () => {
    for (const patch of [{ viewerIsCoRider: false }, { blocked: true }]) {
      const r = sharedRideDisclosure({
        offererOptedIn: true, viewerIsCoRider: true, blocked: false,
        sharedLeg: leg, fullItinerary: itinerary, ...patch,
      });
      assert.equal(r.offered, false);
      assert.equal(r.leg, null);
    }
  });
});
