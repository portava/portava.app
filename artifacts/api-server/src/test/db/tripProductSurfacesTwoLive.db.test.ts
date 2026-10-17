/**
 * The trip screen's second set of product surfaces, executed on the real
 * chain: the client's OWN command builders run through `trip_kernel_execute`,
 * so what is asserted is the row and the event each tap leaves, not a payload
 * this suite re-typed by hand. Every builder module is pure (imports only pure
 * modules), so it loads here without the app's network or React Native layers.
 *
 *   TripStructureComposer   ADD_STAGE with boundaries; ADD_COMMITMENT with
 *                           §7.1's start, required arrival, both buffers and
 *                           confidence (tripStructureDetails.ts)
 *                           census-trips TR13, TR15, TR78, TR122–TR125, TR127
 *   TripStageControls       UPDATE_STAGE (changed boundaries only),
 *                           START_STAGE, COMPLETE_STAGE (tripStagePayloads.ts)
 *                           TR13, TR65
 *   TripPlanAttendanceCard  JOIN_PLAN / SET_PLAN_ATTENDANCE / LEAVE_PLAN
 *                           (tripAttendancePayloads.ts)       TR149, TR83
 *   TripProposalComposer    CREATE_PROPOSAL with the chosen decision_rule
 *                           (tripProposalPayloads.ts)          TR154, TR88
 *
 * The HTTP door between the two (POST /trips/:tripId/commands, unflagged) is
 * pinned separately by tripProductSurfacesDoor.test.ts; this suite stands in
 * for it the way localDb.ts's `kernel()` stands in for the service client.
 *
 * Runs in CI's kernel-SQL job (scripts/local-db/run-tests.sh). It skips without
 * LOCAL_DB_URL, and run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";
import { boundedStageCommand, detailedCommitmentCommand } from "../../../../../travel-buddy-standalone/src/features/trips/planning/tripStructureDetails.ts";
import { stageBoundsCommand, stageTransitionCommand } from "../../../../../travel-buddy-standalone/src/features/trips/stages/tripStagePayloads.ts";
import { attendanceCommand } from "../../../../../travel-buddy-standalone/src/features/trips/plans/tripAttendancePayloads.ts";
import { proposalCommand } from "../../../../../travel-buddy-standalone/src/features/trips/planning/tripProposalPayloads.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

type KernelAnswer = { ok: boolean; duplicate?: boolean; reason?: string; result?: Record<string, unknown> };
type Built = { ok: true; type: string; payload: Record<string, unknown> } | { ok: false; reason: string };

describe("the trip screen's stage controls, commitment fields, attendance and proposals on the real chain (TR13, TR15, TR65, TR122–TR127, TR149, TR154)", { skip: SKIP }, () => {
  let owner = ""; let alice = ""; let stranger = ""; let tripId = ""; let planId = ""; let otherPlanId = "";
  const cityLisbon = randomUUID();

  /** One tap: the client's command, as the acting user, with the tap's key. */
  function tap(actor: string, cmd: Built, key: string = randomUUID()): KernelAnswer {
    assert.equal(cmd.ok, true, `the client refused its own input: ${JSON.stringify(cmd)}`);
    if (!cmd.ok) return { ok: false };
    return kernel(command({ actor_user_id: actor, trip_id: tripId, type: cmd.type, payload: cmd.payload, idempotency_key: key })) as KernelAnswer;
  }
  function accepted(r: KernelAnswer): KernelAnswer {
    assert.equal(r.ok, true, JSON.stringify(r));
    return r;
  }
  function refused(reason: string, r: KernelAnswer) {
    assert.equal(r.ok, false, `ACCEPTED: ${JSON.stringify(r)}`);
    assert.equal(r.reason, reason, JSON.stringify(r));
  }
  const version = () => Number(scalar(`SELECT version FROM public.trips WHERE id = '${tripId}'`));
  const lastEvent = () => rows<{ type: string; family: string; aggregate_version: number }>(
    `SELECT type, payload_json->>'family' AS family, aggregate_version FROM public.trip_events WHERE trip_id = '${tripId}' ORDER BY aggregate_version DESC LIMIT 1`,
  )[0]!;
  const truth = (q: string) => scalar(q) === "t";

  before(() => {
    owner = seedUser("ps2_owner"); alice = seedUser("ps2_alice"); stranger = seedUser("ps2_stranger");
    tripId = randomUUID();
    const ok = (a: string, over: Record<string, unknown>) => accepted(kernel(command({ actor_user_id: a, trip_id: tripId, ...over })) as KernelAnswer);
    ok(owner, { type: "CREATE_TRIP", payload: { title: "surfaces two", destination_city: "Lisboa", destination_country: "Portugal", visibility: "private" } });
    ok(owner, { type: "ADD_PARTICIPANT", payload: { user_id: alice, role: "member" } });
    // A plan to attend. ADD_PLAN is cutover-gated at the HTTP door; here it is fixture.
    planId = String(ok(owner, { type: "ADD_PLAN", payload: { title: "Fado night", day_date: "2026-10-24" } }).result?.id);
    otherPlanId = String(ok(owner, { type: "ADD_PLAN", payload: { title: "Tram 28", day_date: "2026-10-25" } }).result?.id);
  });
  after(() => { for (const u of [owner, alice, stranger]) if (u) deleteUser(u); });

  let stageId = "";

  it("ADD_STAGE as the composer builds it carries the typed boundaries as instants (TR13, TR78)", () => {
    const before = version();
    const r = accepted(tap(alice, boundedStageCommand({
      stageType: "city", cityId: cityLisbon, timezone: "Europe/Lisbon", sequence: 1,
      startsAt: "2026-10-24T15:00:00+01:00", endsAt: "2026-10-27T11:00:00+00:00",
    })));
    stageId = String(r.result?.id);
    assert.equal(truth(`SELECT starts_at = '2026-10-24T14:00:00Z'::timestamptz AND ends_at = '2026-10-27T11:00:00Z'::timestamptz AND state = 'planned' FROM public.trip_stages WHERE id = '${stageId}' AND trip_id = '${tripId}'`), true);
    assert.deepEqual(lastEvent(), { type: "trip.stage_added", family: "stage", aggregate_version: before + 1 });
  });

  it("UPDATE_STAGE as the stage controls build it changes only the boundary that changed; a backwards stage is the CHECK's refusal", () => {
    const current = { startsAt: "2026-10-24T14:00:00+00:00", endsAt: "2026-10-27T11:00:00+00:00" };
    const before = version();
    accepted(tap(alice, stageBoundsCommand(stageId, current, { startsAt: current.startsAt, endsAt: "2026-10-28T10:00:00+00:00" })));
    assert.equal(truth(`SELECT starts_at = '2026-10-24T14:00:00Z'::timestamptz AND ends_at = '2026-10-28T10:00:00Z'::timestamptz FROM public.trip_stages WHERE id = '${stageId}'`), true);
    assert.deepEqual(lastEvent(), { type: "trip.stage_updated", family: "stage", aggregate_version: before + 1 });
    // The client refuses a backwards stage before sending; sent anyway, the database refuses it too.
    const backwards = kernel(command({ actor_user_id: alice, trip_id: tripId, type: "UPDATE_STAGE", payload: { stage_id: stageId, patch: { ends_at: "2026-10-01T00:00:00Z" } } })) as KernelAnswer;
    refused("TRIP_COMMAND_MALFORMED", backwards);
  });

  it("START_STAGE then COMPLETE_STAGE move the stage planned -> active -> completed and emit §4.2's events; a wrong arrow is refused (TR65)", () => {
    const v0 = version();
    accepted(tap(alice, stageTransitionCommand(stageId, "planned", "start")));
    assert.equal(scalar(`SELECT state FROM public.trip_stages WHERE id = '${stageId}'`), "active");
    assert.deepEqual(lastEvent(), { type: "trip.stage_started", family: "stage", aggregate_version: v0 + 1 });
    // The screen's state was stale: a second start is the kernel's refusal, not a second event.
    refused("TRIP_STAGE_INVALID_TRANSITION", kernel(command({ actor_user_id: alice, trip_id: tripId, type: "START_STAGE", payload: { stage_id: stageId } })) as KernelAnswer);
    accepted(tap(owner, stageTransitionCommand(stageId, "active", "complete")));
    assert.equal(scalar(`SELECT state FROM public.trip_stages WHERE id = '${stageId}'`), "completed");
    assert.deepEqual(lastEvent(), { type: "trip.stage_completed", family: "stage", aggregate_version: v0 + 2 });
  });

  it("ADD_COMMITMENT as the composer builds it lands every §7.1 field it sends (TR15, TR122–TR125, TR127)", () => {
    const r = accepted(tap(alice, detailedCommitmentCommand({
      type: "event", flexibility: "fixed", stageId,
      startsAt: "2026-10-24T19:00:00+01:00", requiredArrivalAt: "2026-10-24T18:45:00+01:00",
      latenessMinutes: 5, prepMinutes: 20, confidence: 0.75,
    })));
    const id = String(r.result?.id);
    assert.equal(truth(`SELECT starts_at = '2026-10-24T18:00:00Z'::timestamptz AND required_arrival_at = '2026-10-24T17:45:00Z'::timestamptz
      AND lateness_tolerance = interval '5 minutes' AND prep_duration = interval '20 minutes' AND confidence = 0.75 AND flexibility = 'fixed'
      AND stage_id = '${stageId}' FROM public.trip_commitments WHERE id = '${id}' AND trip_id = '${tripId}'`), true);
    // what the unflagged /structure reader selects, read back
    assert.deepEqual(rows(`SELECT lateness_tolerance::text AS l, prep_duration::text AS p, confidence::text AS c FROM public.trip_commitments WHERE id = '${id}'`)[0], { l: "00:05:00", p: "00:20:00", c: "0.75" });
  });

  it("attendance as the card builds it: JOIN_PLAN with a state, SET_PLAN_ATTENDANCE to another, LEAVE_PLAN to left — self only (TR149, TR83)", () => {
    const state = (u: string) => scalar(`SELECT attendance_state FROM public.trip_plan_participants WHERE plan_id = '${planId}' AND user_id = '${u}'`);
    accepted(tap(alice, attendanceCommand(planId, null, "maybe")));
    assert.equal(state(alice), "maybe");
    assert.equal(lastEvent().type, "trip.plan_joined");
    accepted(tap(alice, attendanceCommand(planId, "maybe", "going")));
    assert.equal(state(alice), "going");
    assert.equal(lastEvent().type, "trip.plan_attendance_set");
    accepted(tap(owner, attendanceCommand(planId, null, "going")));
    assert.equal(state(owner), "going");
    accepted(tap(alice, attendanceCommand(planId, "going", "leave")));
    assert.equal(state(alice), "left", "leaving is remembered, not deleted");
    assert.equal(lastEvent().type, "trip.plan_left");
    // the party the /structure reader computes is the `going` rows only
    assert.deepEqual(rows(`SELECT user_id::text AS u FROM public.trip_plan_participants WHERE plan_id = '${planId}' AND attendance_state = 'going'`), [{ u: owner }]);
    // a stale screen that believes it holds an answer it does not is refused by name, and nothing is written
    refused("TRIP_PLAN_ATTENDANCE_NOT_FOUND", tap(alice, attendanceCommand(otherPlanId, "maybe", "going")));
    assert.equal(Number(scalar(`SELECT count(*) FROM public.trip_plan_participants WHERE plan_id = '${otherPlanId}'`)), 0);
  });

  it("a proposal as the composer builds it records the CHOSEN rule and the ballot's title; the rule decides who may accept (TR154, TR88)", () => {
    const r = accepted(tap(alice, proposalCommand({ proposalType: "stage_change", decisionRule: "majority", title: "Leave a day early", rationale: "the storm", impactSummary: "one night less" })));
    const id = String(r.result?.id);
    assert.deepEqual(rows(`SELECT proposal_type, decision_rule, status, proposed_by::text AS by, payload_json FROM public.trip_proposals WHERE id = '${id}' AND trip_id = '${tripId}'`)[0], {
      proposal_type: "stage_change", decision_rule: "majority", status: "pending", by: alice,
      payload_json: { title: "Leave a day early", rationale: "the storm", impact_summary: "one night less" },
    });
    assert.equal(lastEvent().type, "trip.proposal_created");
    // Under majority the vote decides: not met, the accept is refused; met, it is accepted and changes nothing by itself.
    refused("TRIP_PROPOSAL_VOTE_NOT_MET", kernel(command({ actor_user_id: alice, trip_id: tripId, type: "ACCEPT_PROPOSAL", payload: { proposal_id: id } })) as KernelAnswer);
    for (const u of [owner, alice]) accepted(kernel(command({ actor_user_id: u, trip_id: tripId, type: "VOTE_ON_PROPOSAL", payload: { proposal_id: id, vote: "yes" } })) as KernelAnswer);
    accepted(kernel(command({ actor_user_id: alice, trip_id: tripId, type: "ACCEPT_PROPOSAL", payload: { proposal_id: id } })) as KernelAnswer);
    assert.equal(scalar(`SELECT status FROM public.trip_proposals WHERE id = '${id}'`), "accepted");
    // Under the host's rule a crew member may not accept.
    const hosts = String(accepted(tap(alice, proposalCommand({ proposalType: "other", decisionRule: "host", title: "Pool day" }))).result?.id);
    refused("TRIP_AUTH_NOT_HOST", kernel(command({ actor_user_id: alice, trip_id: tripId, type: "ACCEPT_PROPOSAL", payload: { proposal_id: hosts } })) as KernelAnswer);
  });

  it("a non-member's taps are refused TRIP_AUTH_NOT_CREW and nothing is written", () => {
    const n = Number(scalar(`SELECT (SELECT count(*) FROM public.trip_proposals WHERE trip_id = '${tripId}') + (SELECT count(*) FROM public.trip_commitments WHERE trip_id = '${tripId}')`));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, proposalCommand({ proposalType: "other", decisionRule: "anyone", title: "x" })));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, detailedCommitmentCommand({ type: "other", flexibility: "flexible", stageId: null, confidence: 1 })));
    refused("TRIP_AUTH_NOT_CREW", tap(stranger, attendanceCommand(planId, null, "going")));
    assert.equal(Number(scalar(`SELECT (SELECT count(*) FROM public.trip_proposals WHERE trip_id = '${tripId}') + (SELECT count(*) FROM public.trip_commitments WHERE trip_id = '${tripId}')`)), n);
  });
});
