/**
 * WP-10 TRIP-F15 (census-trips §77): the ballot path the app now issues —
 * VOTE_ON_PROPOSAL / ACCEPT_PROPOSAL / REJECT_PROPOSAL through
 * trip_kernel_execute — EXECUTED against the functions 2768/2775 define.
 *
 * The client (travel-buddy-standalone src/features/trips/planning/
 * tripBallots.ts) mints ONE idempotency key per tap. That is only right if
 * the kernel does what this suite pins:
 *
 *   - a changed vote under a NEW key is applied: one row per member, the
 *     latest vote, a new event;
 *   - replaying an OLD key is a duplicate receipt and does NOT resurrect the
 *     old vote (a key derived from (proposal, vote) alone would therefore
 *     silently drop "yes → no → yes");
 *   - ACCEPT applies the proposal's own rule: a MAJORITY proposal the
 *     electorate voted down is refused TRIP_PROPOSAL_VOTE_NOT_MET, and a
 *     REJECT closes it, after which a vote is TRIP_PROPOSAL_NOT_PENDING.
 *
 * Skips without LOCAL_DB_URL, exactly as tripKernelPipeline.db.test.ts does;
 * scripts/local-db/run-tests.sh refuses a run with skipped > 0.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { HAVE_DB, command, deleteUser, kernel, rows, scalar, seedUser } from "./localDb.ts";

const SKIP = HAVE_DB ? false : "LOCAL_DB_URL not set — scripts/local-db/up.sh provides one";

describe("WP-10 ballots through the kernel", { skip: SKIP }, () => {
  let owner = "";
  let tripId = "";
  let proposalId = "";

  function run(over: Record<string, unknown>) {
    return kernel(command({ actor_user_id: owner, trip_id: tripId, ...over }));
  }
  function ok(over: Record<string, unknown>) {
    const r = run(over);
    assert.equal(r.ok, true, `${String(over["type"])} was rejected: ${JSON.stringify(r)}`);
    return r;
  }
  const myVote = () => rows<{ vote: string }>(
    `SELECT vote FROM public.trip_proposal_votes WHERE proposal_id = '${proposalId}' AND user_id = '${owner}'`,
  );
  const events = () => Number(scalar(`SELECT count(*) FROM public.trip_events WHERE trip_id = '${tripId}'`));

  before(() => {
    owner = seedUser("ballot_owner");
    tripId = randomUUID();
    ok({ type: "CREATE_TRIP", payload: { title: "ballot slice", destination_city: "Porto", destination_country: "Portugal", visibility: "private" } });
    proposalId = ok({
      type: "CREATE_PROPOSAL",
      payload: { proposal_type: "stage_change", payload_json: { title: "Dinner at 8pm" }, decision_rule: "majority" },
    }).result?.id;
    assert.ok(proposalId, "CREATE_PROPOSAL returned no id");
  });

  after(() => { if (owner) deleteUser(owner); });

  it("a vote is recorded, and a CHANGED vote under a new key replaces it: one row, the latest vote, a new event", () => {
    const k1 = `ballot:${proposalId}:yes:a`;
    const first = ok({ type: "VOTE_ON_PROPOSAL", idempotency_key: k1, payload: { proposal_id: proposalId, vote: "yes" } });
    assert.equal(first.duplicate ?? false, false);
    assert.deepEqual(myVote(), [{ vote: "yes" }]);
    const before = events();
    const changed = ok({ type: "VOTE_ON_PROPOSAL", idempotency_key: `ballot:${proposalId}:no:b`, payload: { proposal_id: proposalId, vote: "no" } });
    assert.equal(changed.duplicate ?? false, false);
    assert.ok(changed.version > first.version, "the change is a transition");
    assert.equal(events(), before + 1);
    assert.deepEqual(myVote(), [{ vote: "no" }]);
  });

  it("replaying the FIRST vote's key is a duplicate and does not resurrect it", () => {
    const before = events();
    const replay = ok({ type: "VOTE_ON_PROPOSAL", idempotency_key: `ballot:${proposalId}:yes:a`, payload: { proposal_id: proposalId, vote: "yes" } });
    assert.equal(replay.duplicate, true);
    assert.equal(events(), before, "a duplicate appends nothing");
    assert.deepEqual(myVote(), [{ vote: "no" }], "the old intent did not come back");
  });

  it("ACCEPT applies the MAJORITY rule: voted down, it is refused TRIP_PROPOSAL_VOTE_NOT_MET and stays pending", () => {
    const r = run({ type: "ACCEPT_PROPOSAL", payload: { proposal_id: proposalId } });
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, "TRIP_PROPOSAL_VOTE_NOT_MET");
    assert.equal(scalar(`SELECT status FROM public.trip_proposals WHERE id = '${proposalId}'`), "pending");
  });

  it("REJECT closes it, and a vote after that is TRIP_PROPOSAL_NOT_PENDING", () => {
    ok({ type: "REJECT_PROPOSAL", payload: { proposal_id: proposalId } });
    assert.equal(scalar(`SELECT status FROM public.trip_proposals WHERE id = '${proposalId}'`), "rejected");
    const late = run({ type: "VOTE_ON_PROPOSAL", payload: { proposal_id: proposalId, vote: "yes" } });
    assert.equal(late.ok, false);
    assert.equal(late.reason, "TRIP_PROPOSAL_NOT_PENDING");
    assert.deepEqual(myVote(), [{ vote: "no" }]);
  });
});
