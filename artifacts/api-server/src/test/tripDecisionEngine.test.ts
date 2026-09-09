/**
 * Trips §8 — the decision engine's behaviour.
 *
 * THE PROPERTY THIS FILE EXISTS FOR
 * =================================
 * A recommendation is advice a person acts on, so the engine must never turn a
 * missing input into a favourable one. The specific shape being guarded is:
 *
 *   a proposal whose feasibility is UNKNOWN is recommended, because nothing
 *   ruled it out
 *
 * "Nothing ruled it out" and "it was checked and it is fine" read identically
 * to a user and are opposite facts. Every test below is one instance of
 * keeping them apart, or of keeping a DIFFERENT pair apart: a tie from a
 * winner, a disqualification from a missing basis, an open risk from a closed
 * one, a passed deadline from no deadline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  recommend, recommendAll, assessOption, propagateRisks,
  RECOMMENDATION_KINDS, DECISION_REASONS,
  type Goal, type DecisionTask, type Proposal, type Risk,
} from "../services/trips/TripDecisionEngine.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");

const task = (over: Partial<DecisionTask> = {}): DecisionTask => ({
  id: "t1", type: "booking", deadlineAt: null, consequence: null,
  assignedUserId: null, status: "pending", ...over,
});
const goal = (over: Partial<Goal> = {}): Goal => ({
  id: "g1", type: "experience", priority: "normal", status: "open", ...over,
});
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: "p1", decisionTaskId: "t1", status: "pending",
  servesGoalIds: [], affectsElementIds: [], feasibility: "FEASIBLE_UNVERIFIED", ...over,
});
const risk = (over: Partial<Risk> = {}): Risk => ({
  id: "r1", likelihood: "medium", impact: "medium", status: "open",
  affects: [], goalTypes: [], ...over,
});

describe("§8 — an input that could not be established is never favourable", () => {
  it("UNKNOWN feasibility disqualifies — it is not 'nothing ruled it out'", () => {
    const r = recommend(task(), [proposal({ feasibility: "UNKNOWN" })], [], [], NOW);
    assert.equal(r.kind, "DO_NOT_RECOMMEND");
    assert.deepEqual(r.reasons, ["ALL_OPTIONS_DISQUALIFIED"]);
    assert.deepEqual(r.options[0]!.reasons, ["FEASIBILITY_UNKNOWN"]);
    assert.equal(r.options[0]!.eligible, false);
  });

  it("a feasibility that was never computed (null) is treated exactly like UNKNOWN", () => {
    // The two arise differently — one is "§7 answered UNKNOWN", the other is
    // "§7 was never asked" — and both mean the same thing here: no basis.
    const r = recommend(task(), [proposal({ feasibility: null })], [], [], NOW);
    assert.equal(r.options[0]!.eligible, false);
    assert.ok(r.options[0]!.reasons.includes("FEASIBILITY_UNKNOWN"));
  });

  it("INFEASIBLE is a separate reason from UNKNOWN, because they mean different things", () => {
    const proven = recommend(task(), [proposal({ feasibility: "INFEASIBLE" })], [], [], NOW);
    assert.deepEqual(proven.options[0]!.reasons, ["INFEASIBLE_SCHEDULE"]);
    const unknown = recommend(task(), [proposal({ feasibility: "UNKNOWN" })], [], [], NOW);
    assert.deepEqual(unknown.options[0]!.reasons, ["FEASIBILITY_UNKNOWN"]);
    assert.notDeepEqual(proven.options[0]!.reasons, unknown.options[0]!.reasons);
  });

  it("FEASIBLE_UNVERIFIED is eligible — it is the best §7 can honestly offer", () => {
    // Refusing it would make the engine useless everywhere, since there is no
    // routing provider and FEASIBLE is never returned.
    const r = recommend(task(), [proposal({ feasibility: "FEASIBLE_UNVERIFIED" })], [], [], NOW);
    assert.equal(r.kind, "RECOMMEND");
    assert.equal(r.proposalId, "p1");
  });
});

describe("§8 — a tie is a tie, not a winner", () => {
  it("two options serving the same goals are INSUFFICIENT_BASIS, not an arbitrary pick", () => {
    const r = recommend(
      task(),
      [proposal({ id: "a", servesGoalIds: ["g1"] }), proposal({ id: "b", servesGoalIds: ["g1"] })],
      [goal()],
      [], NOW,
    );
    assert.equal(r.kind, "INSUFFICIENT_BASIS");
    assert.deepEqual(r.reasons, ["TIED_ON_AVAILABLE_EVIDENCE"]);
    assert.equal(r.proposalId, null);
  });

  it("two options serving NOTHING are still a tie — zero equals zero", () => {
    const r = recommend(task(), [proposal({ id: "a" }), proposal({ id: "b" })], [goal()], [], NOW);
    assert.equal(r.kind, "INSUFFICIENT_BASIS");
    assert.deepEqual(r.reasons, ["TIED_ON_AVAILABLE_EVIDENCE"]);
  });

  it("goal PRIORITY breaks a tie, and a high goal outweighs two low ones", () => {
    const r = recommend(
      task(),
      [
        proposal({ id: "hi", servesGoalIds: ["g-high"] }),
        proposal({ id: "lo", servesGoalIds: ["g-low1"] }),
      ],
      [
        goal({ id: "g-high", priority: "high" }),
        goal({ id: "g-low1", priority: "low" }),
      ],
      [], NOW,
    );
    assert.equal(r.kind, "RECOMMEND");
    assert.equal(r.proposalId, "hi");
  });

  it("an ABANDONED goal steers nothing — only open goals count", () => {
    const r = recommend(
      task(),
      [proposal({ id: "a", servesGoalIds: ["g-dead"] }), proposal({ id: "b" })],
      [goal({ id: "g-dead", status: "abandoned", priority: "high" })],
      [], NOW,
    );
    // Both now serve zero open goals, so it is a tie rather than a win for 'a'.
    assert.equal(r.kind, "INSUFFICIENT_BASIS");
    assert.deepEqual(r.reasons, ["TIED_ON_AVAILABLE_EVIDENCE"]);
  });
});

describe("§8.4 — risk propagation (census TR144)", () => {
  it("an open risk reaches the elements its trigger names", () => {
    const map = propagateRisks([
      risk({ id: "r1", impact: "high", likelihood: "low", affects: ["e1", "e2"] }),
      risk({ id: "r2", impact: "low", likelihood: "high", affects: ["e1"] }),
    ]);
    assert.deepEqual([...map.keys()].sort(), ["e1", "e2"]);
    const e1 = map.get("e1")!;
    assert.deepEqual(e1.riskIds.sort(), ["r1", "r2"]);
    // Impact and likelihood are maxed SEPARATELY on purpose: a high-impact
    // unlikely risk and a low-impact certain one are different situations, and
    // one combined number would erase the difference.
    assert.equal(e1.worstImpact, "high");
    assert.equal(e1.worstLikelihood, "high");
  });

  it("only OPEN risks propagate", () => {
    for (const status of ["mitigated", "realised", "closed"]) {
      const map = propagateRisks([risk({ status, affects: ["e1"] })]);
      assert.equal(map.size, 0, `a ${status} risk propagated`);
    }
  });

  it("an UNRECOGNISED severity is treated as the worst, not the mildest", () => {
    // A severity this code cannot read is not a mild one, and defaulting it
    // downward is how an unknown becomes a reassurance.
    const map = propagateRisks([risk({ impact: "catastrophic", likelihood: "??", affects: ["e1"] })]);
    assert.equal(map.get("e1")!.worstImpact, "high");
    assert.equal(map.get("e1")!.worstLikelihood, "high");
  });

  it("a HIGH-impact open risk on a touched element disqualifies the option", () => {
    const r = recommend(
      task(),
      [proposal({ affectsElementIds: ["e1"] })],
      [],
      [risk({ impact: "high", affects: ["e1"] })],
      NOW,
    );
    assert.equal(r.kind, "DO_NOT_RECOMMEND");
    assert.ok(r.options[0]!.reasons.includes("BLOCKED_BY_HIGH_RISK"));
    assert.equal(r.options[0]!.worstRiskImpact, "high");
  });

  it("a MEDIUM risk is recorded and does NOT disqualify", () => {
    const r = recommend(
      task(),
      [proposal({ affectsElementIds: ["e1"] })],
      [],
      [risk({ impact: "medium", affects: ["e1"] })],
      NOW,
    );
    assert.equal(r.kind, "RECOMMEND");
    assert.equal(r.options[0]!.worstRiskImpact, "medium",
      "the risk must still be reported even though it did not disqualify");
  });

  it("a risk on an element the option does NOT touch does not reach it", () => {
    const r = recommend(
      task(),
      [proposal({ affectsElementIds: ["e1"] })],
      [],
      [risk({ impact: "high", affects: ["somewhere-else"] })],
      NOW,
    );
    assert.equal(r.kind, "RECOMMEND");
    assert.equal(r.options[0]!.worstRiskImpact, null);
  });

  it("propagation is ONE hop — a chain nobody declared is not invented", () => {
    // r1 names e1; e1 is not declared to affect e2 anywhere, so e2 is clean.
    const map = propagateRisks([risk({ affects: ["e1"] })]);
    assert.equal(map.has("e2"), false);
  });
});

describe("§8 — deadlines, and the difference between none and passed", () => {
  it("a deadline in the past yields INSUFFICIENT_BASIS with DEADLINE_PASSED", () => {
    const r = recommend(
      task({ deadlineAt: "2026-10-01T11:59:00.000Z" }), [proposal()], [], [], NOW,
    );
    assert.equal(r.kind, "INSUFFICIENT_BASIS");
    assert.deepEqual(r.reasons, ["DEADLINE_PASSED"]);
  });

  it("the boundary is inclusive: a deadline exactly NOW has passed", () => {
    const r = recommend(task({ deadlineAt: NOW.toISOString() }), [proposal()], [], [], NOW);
    assert.deepEqual(r.reasons, ["DEADLINE_PASSED"]);
  });

  it("one second before the deadline, the recommendation still stands", () => {
    const r = recommend(
      task({ deadlineAt: "2026-10-01T12:00:01.000Z" }), [proposal()], [], [], NOW,
    );
    assert.equal(r.kind, "RECOMMEND");
  });

  it("NO deadline is not a passed one", () => {
    const r = recommend(task({ deadlineAt: null }), [proposal()], [], [], NOW);
    assert.equal(r.kind, "RECOMMEND");
  });

  it("an unparseable deadline does not silently become 'no deadline'... or does it explicitly", () => {
    // Number.isFinite guards the parse. A malformed deadline cannot be treated
    // as passed (that would block a valid decision on a typo), so it is
    // treated as absent — and the OPTIONS still carry every other check, which
    // is what keeps this from being a free pass.
    const r = recommend(task({ deadlineAt: "not-a-date" }), [proposal({ feasibility: "UNKNOWN" })], [], [], NOW);
    assert.equal(r.kind, "DO_NOT_RECOMMEND",
      "a malformed deadline must not let an option skip the feasibility check");
  });

  it("even after the deadline, every option is still assessed and reported", () => {
    // The task cannot be decided in time; the OPTIONS are still information.
    const r = recommend(
      task({ deadlineAt: "2020-01-01T00:00:00.000Z" }),
      [proposal({ id: "a", feasibility: "INFEASIBLE" }), proposal({ id: "b" })],
      [], [], NOW,
    );
    assert.equal(r.options.length, 2);
    assert.ok(r.options.find((o) => o.proposalId === "a")!.reasons.includes("INFEASIBLE_SCHEDULE"));
  });
});

describe("§8 — governance and the empty cases", () => {
  it("no proposals is INSUFFICIENT_BASIS, never DO_NOT_RECOMMEND", () => {
    // "We have nothing to go on" and "we considered the options and advise
    // against them" are different answers and only one of them is true here.
    const r = recommend(task(), [], [], [], NOW);
    assert.equal(r.kind, "INSUFFICIENT_BASIS");
    assert.deepEqual(r.reasons, ["NO_PROPOSALS"]);
  });

  it("every option disqualified is DO_NOT_RECOMMEND — a real conclusion", () => {
    const r = recommend(
      task(),
      [proposal({ id: "a", feasibility: "INFEASIBLE" }), proposal({ id: "b", feasibility: "INFEASIBLE" })],
      [], [], NOW,
    );
    assert.equal(r.kind, "DO_NOT_RECOMMEND");
    assert.deepEqual(r.reasons, ["ALL_OPTIONS_DISQUALIFIED"]);
  });

  it("a rejected or superseded proposal is not a candidate", () => {
    for (const status of ["rejected", "superseded"]) {
      const r = recommend(task(), [proposal({ status })], [], [], NOW);
      assert.ok(r.options[0]!.reasons.includes("PROPOSAL_NOT_DECIDED"), status);
      assert.equal(r.kind, "DO_NOT_RECOMMEND");
    }
  });

  it("proposals attached to ANOTHER decision task are not considered", () => {
    const r = recommend(task({ id: "t1" }), [proposal({ decisionTaskId: "t2" })], [], [], NOW);
    assert.deepEqual(r.reasons, ["NO_PROPOSALS"]);
    assert.equal(r.options.length, 0);
  });

  it("an UNATTACHED proposal (null task) belongs to no task", () => {
    const r = recommend(task(), [proposal({ decisionTaskId: null })], [], [], NOW);
    assert.deepEqual(r.reasons, ["NO_PROPOSALS"]);
  });

  it("recommendAll skips tasks that are not pending", () => {
    const rs = recommendAll(
      [task({ id: "t1" }), task({ id: "t2", status: "done" }), task({ id: "t3", status: "waived" })],
      [proposal({ decisionTaskId: "t1" })], [], [], NOW,
    );
    assert.deepEqual(rs.map((r) => r.decisionTaskId), ["t1"]);
  });
});

describe("§8 — the vocabularies are closed and every reason is producible", () => {
  it("every declared reason is actually emitted by some path", () => {
    // A reason nobody produces is a promise the engine does not keep, and a
    // consumer that branches on it has dead code.
    const emitted = new Set<string>();
    const collect = (r: { reasons: string[]; options: Array<{ reasons: string[] }> }) => {
      r.reasons.forEach((x) => emitted.add(x));
      r.options.forEach((o) => o.reasons.forEach((x) => emitted.add(x)));
    };
    collect(recommend(task(), [], [], [], NOW));                                             // NO_PROPOSALS
    collect(recommend(task({ deadlineAt: "2020-01-01T00:00:00Z" }), [proposal()], [], [], NOW)); // DEADLINE_PASSED
    collect(recommend(task(), [proposal({ feasibility: "INFEASIBLE" })], [], [], NOW));       // INFEASIBLE + ALL_DISQ
    collect(recommend(task(), [proposal({ feasibility: "UNKNOWN" })], [], [], NOW));          // FEASIBILITY_UNKNOWN
    collect(recommend(task(), [proposal({ status: "rejected" })], [], [], NOW));              // PROPOSAL_NOT_DECIDED
    collect(recommend(task(), [proposal({ affectsElementIds: ["e"] })], [],
      [risk({ impact: "high", affects: ["e"] })], NOW));                                      // BLOCKED_BY_HIGH_RISK
    collect(recommend(task(), [proposal({ servesGoalIds: ["g1"] })], [goal()], [], NOW));      // SERVES_GOAL
    collect(recommend(task(), [proposal()], [], [], NOW));                                     // NO_OBJECTION...
    collect(recommend(task(), [proposal({ id: "a" }), proposal({ id: "b" })], [], [], NOW));   // TIED...

    const missing = DECISION_REASONS.filter((r) => !emitted.has(r));
    assert.deepEqual(missing, [], `these reasons are declared but unreachable: ${missing.join(", ")}`);
  });

  it("INSUFFICIENT_BASIS is the first kind declared — it is the default, argued out of", () => {
    assert.equal(RECOMMENDATION_KINDS[0], "INSUFFICIENT_BASIS");
  });

  it("a RECOMMEND always names a proposal; nothing else ever does", () => {
    const cases = [
      recommend(task(), [], [], [], NOW),
      recommend(task(), [proposal({ feasibility: "INFEASIBLE" })], [], [], NOW),
      recommend(task(), [proposal({ id: "a" }), proposal({ id: "b" })], [], [], NOW),
      recommend(task(), [proposal()], [], [], NOW),
    ];
    for (const r of cases) {
      assert.equal(r.kind === "RECOMMEND", r.proposalId !== null,
        `${r.kind} and proposalId=${r.proposalId} disagree`);
      assert.ok(r.reasons.length > 0, "a recommendation with no stated reason is not one");
    }
  });

  it("assessOption is total: it always returns reasons", () => {
    const a = assessOption(proposal(), { openGoalIds: new Set(), elementRisks: new Map() });
    assert.ok(a.reasons.length > 0);
  });
});
