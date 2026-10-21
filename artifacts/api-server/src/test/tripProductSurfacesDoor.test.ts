/**
 * POST /trips/:tripId/commands issues the trip screen's second set of product
 * commands with BOTH Trips flags FALSE — and it issues THE CLIENT'S OWN
 * payloads verbatim. census-trips TR13, TR15, TR65, TR122–TR127, TR149, TR154.
 *
 * The payloads are not re-typed here: each one is built by the app's pure
 * builder module (travel-buddy-standalone/src/features/trips/…), exactly as the
 * tap builds it, and posted through the real route. So a key renamed on either
 * side, a command moved behind the cutover, or a door that rewrites a proposal
 * the client already wrote canonically turns this file red.
 *
 * Fakes only: the kernel RPC is a recorder. What the kernel does with these
 * payloads is pinned on the real chain by
 * src/test/db/tripProductSurfacesTwoLive.db.test.ts (CI's kernel-SQL job).
 *
 * The route's own refusals, before the kernel, are pinned too: their bodies
 * carry an `error` code and no `reason`, which is what the client's
 * issueTripCommand now reads as a refusal (not as "couldn't reach the trip").
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { proposalCommandPayload } from "../domain/trips/contracts/TripProposalContract.js";
import { boundedStageCommand, detailedCommitmentCommand } from "../../../../travel-buddy-standalone/src/features/trips/planning/tripStructureDetails.ts";
import { stageBoundsCommand, stageTransitionCommand } from "../../../../travel-buddy-standalone/src/features/trips/stages/tripStagePayloads.ts";
import { attendanceCommand } from "../../../../travel-buddy-standalone/src/features/trips/plans/tripAttendancePayloads.ts";
import { proposalCommand } from "../../../../travel-buddy-standalone/src/features/trips/planning/tripProposalPayloads.ts";

const OWNER = "11111111-0000-4000-8000-0000000000b1";
const STRANGER = "11111111-0000-4000-8000-0000000000b9";
const TRIP = "aaaaaaaa-0000-4000-8000-0000000000b2";
const STAGE = "44444444-4444-4444-8444-444444444444";
const PLAN = "55555555-5555-4555-8555-555555555555";
const CITY = "33333333-3333-4333-8333-333333333333";

type Built = { ok: true; type: string; payload: Record<string, unknown> } | { ok: false; reason: string };
function built(cmd: Built): { type: string; payload: Record<string, unknown> } {
  assert.equal(cmd.ok, true, `the client refused its own input: ${JSON.stringify(cmd)}`);
  if (!cmd.ok) throw new Error("unreachable");
  return { type: cmd.type, payload: cmd.payload };
}

/** Every command the new surfaces send, as the surfaces build them. */
const TAPS: Array<[string, { type: string; payload: Record<string, unknown> }]> = [
  ["the composer's dated stage", built(boundedStageCommand({ stageType: "city", cityId: CITY, timezone: "Europe/Lisbon", sequence: 1, startsAt: "2026-10-24T15:00:00+01:00", endsAt: "2026-10-27T11:00:00+00:00" }))],
  ["the composer's commitment with every §7.1 field it offers", built(detailedCommitmentCommand({ type: "event", flexibility: "fixed", stageId: STAGE, startsAt: "2026-10-24T19:00:00+01:00", requiredArrivalAt: "2026-10-24T18:45:00+01:00", latenessMinutes: 5, prepMinutes: 20, confidence: 0.75 }))],
  ["the stage controls' new end date", built(stageBoundsCommand(STAGE, { startsAt: "2026-10-24T14:00:00+00:00", endsAt: null }, { startsAt: "2026-10-24T14:00:00+00:00", endsAt: "2026-10-28T10:00:00+00:00" }))],
  ["Start stage", built(stageTransitionCommand(STAGE, "planned", "start"))],
  ["Complete stage", built(stageTransitionCommand(STAGE, "active", "complete"))],
  ["a first answer on a plan", built(attendanceCommand(PLAN, null, "maybe"))],
  ["a changed answer on a plan", built(attendanceCommand(PLAN, "maybe", "going"))],
  ["leaving a plan", built(attendanceCommand(PLAN, "going", "leave"))],
  ["a proposal under the majority rule", built(proposalCommand({ proposalType: "stage_change", decisionRule: "majority", title: "Leave a day early", rationale: "the storm", impactSummary: "one night less" }))],
];

describe("the new product commands at POST /trips/:tripId/commands, both Trips flags FALSE", () => {
  type Harness = { base: string; close(): Promise<void> };
  let h: Harness;
  let call: (base: string, m: "POST", p: string, u: string, b?: unknown) => Promise<{ status: number; body: any }>;
  let kernelCalls: Array<{ name: string; args: any }> = [];

  async function setup() {
    const harness = await import("./telegraphCertificationHarness.js");
    const { _setTestClient } = await import("../lib/http.js");
    const { _setTestServiceClient } = await import("../lib/supabase.js");
    const router = (await import("../server/trips/commandRoute.js")).default;
    const c = harness.makeFakeClient({
      trips: [{ id: TRIP, owner_id: OWNER }],
      trip_members: [{ trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted", permissions: null }],
      feature_flags: [
        { flag: "trip_kernel_enabled", enabled: false },
        { flag: "trip_operational_projections_enabled", enabled: false },
      ],
    });
    (c as any).rpc = async (name: string, args: any) => {
      kernelCalls.push({ name, args });
      return { data: { ok: true, duplicate: false, version: kernelCalls.length, event_id: `e${kernelCalls.length}`, sequence: kernelCalls.length, result: { id: "r1" }, contract_version: 2 }, error: null };
    };
    _setTestClient(c as never, true);
    _setTestServiceClient(c as never);
    if (!h) h = await harness.startRouter(router);
    call = harness.call as typeof call;
  }
  const post = async (actor: string, body: unknown) => { await setup(); kernelCalls = []; return call(h.base, "POST", `/trips/${TRIP}/commands`, actor, body); };
  after(async () => { if (h) await h.close(); });

  for (const [label, cmd] of TAPS) {
    it(`${label} (${cmd.type}) reaches trip_kernel_execute verbatim, as the token's user`, async () => {
      const r = await post(OWNER, { type: cmd.type, idempotency_key: `k-${cmd.type}-${label.length}`, payload: cmd.payload });
      assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300));
      assert.equal(kernelCalls.length, 1);
      assert.equal(kernelCalls[0]!.name, "trip_kernel_execute");
      assert.equal(kernelCalls[0]!.args.p_command.type, cmd.type);
      assert.deepEqual(kernelCalls[0]!.args.p_command.payload, cmd.payload);
      assert.equal(kernelCalls[0]!.args.p_command.actor_user_id, OWNER);
    });
  }

  it("the proposal door leaves the client's proposal as it is: its §9.3 fields are already under the one canonical key each", () => {
    const proposal = TAPS.find(([, c]) => c.type === "CREATE_PROPOSAL")![1];
    assert.deepEqual(proposalCommandPayload(proposal.payload), { ok: true, payload: proposal.payload });
  });

  it("a refusal the route makes before the kernel carries an `error` code and no `reason` — the shape the client reads as a refusal", async () => {
    const notMember = await post(STRANGER, { type: "START_STAGE", idempotency_key: "k-s", payload: { stage_id: STAGE } });
    assert.equal(notMember.status, 403);
    assert.equal(notMember.body.error, "forbidden");
    assert.equal("reason" in notMember.body, false);
    const malformed = await post(OWNER, { type: "CREATE_PROPOSAL", idempotency_key: "k-p", payload: { proposal_type: "other", decision_rule: "host", payload_json: { title: "x", rationale: 7 } } });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, "invalid_payload");
    assert.equal("reason" in malformed.body, false);
    assert.equal(kernelCalls.length, 0, "neither reached the kernel");
  });
});
