/**
 * §21 L240 (deterministic replay of recorded sessions), L241 (decision-diff CI
 * over a corpus) and §20 L217 (`decision_replay_mismatch`, target 0).
 *
 * ── THE TRAP THIS FILE IS WRITTEN AGAINST ────────────────────────────────────
 * `LayoverFeasibility.replayFeasibility` is `certifyFeasibility` — deliberately
 * the same code path, because a replay that ran different code would prove
 * nothing. That also means the naive replay test is VACUOUS: feed the inputs
 * back, get the same answer, assert they match, and you have asserted that a
 * pure function is a pure function.
 *
 * A replay is worth running for two reasons that are NOT that, and this file
 * tests those:
 *
 *   1. IT CHECKS THE STORED RESULT, not the recomputation. A ledger row carries
 *      both the inputs and the answer. Replay recomputes the answer from the
 *      inputs and compares it to what was WRITTEN. That catches a row whose
 *      result was edited, a row written by a build whose arithmetic has since
 *      been changed, and a row whose inputs were truncated on the way into
 *      JSONB. `decision_replay_mismatch` counts exactly those.
 *   2. IT REFUSES TO CROSS ENGINE VERSIONS. Replaying a 2026.09.07 record under
 *      2026.09.13 arithmetic and reporting "mismatch" would be a category
 *      error: the answer is SUPPOSED to change, that is what a version bump
 *      means, and it is §21 L241's decision DIFF, whose expected value is not
 *      zero. Conflating the two makes L217's target-0 metric un-hittable on
 *      every deploy and therefore ignored.
 *
 * POSITIVE CONTROLS. Every "matches" assertion below is paired with a tampered
 * or shifted record that MUST report a mismatch. A replay harness that cannot
 * go red is a harness that proves nothing, which is the failure mode this lane
 * exists to avoid.
 *
 * Run: node --import tsx/esm --test src/test/layoverReplayDeterminism.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  replayDecision,
  diffDecisions,
  replayLedger,
  decisionDiffCorpus,
  REPLAY_REFUSAL_REASONS,
} from "../services/airport/layoverReplay.js";
import { decisionRecordFor } from "../services/airport/layoverLedger.js";
import {
  certifySessionFeasibility,
  feasibilityInputs,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-13T02:00:00.000Z");

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: true,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

function session(hours: number, over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: new Date(NOW).toISOString(),
    departureTime: new Date(NOW + hours * HOUR).toISOString(),
    boardingTime: null,
    flightType: "domestic",
    immigrationRequired: false,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

const INTL = { flightType: "international" as const, immigrationRequired: true };

/** One stored ledger entry: the inputs as written, and the decision as written. */
function stored(hours: number, over: Partial<FeasibilitySession> = {}, sessionId = "session-1") {
  const inputs = feasibilityInputs(airport(), session(hours, over), { nowMs: NOW });
  const record = certifySessionFeasibility(airport(), session(hours, over), { nowMs: NOW });
  return { sessionId, inputs, decision: decisionRecordFor(sessionId, record) };
}

// ── L240 — replay of a recorded session ──────────────────────────────────────

describe("§21 L240 — a recorded decision replays to itself", () => {
  it("an untouched ledger entry replays with no mismatch", () => {
    const e = stored(6, INTL);
    const r = replayDecision(e);
    assert.equal(r.status, "match");
    assert.deepEqual(r.mismatchedFields, []);
  });

  it("POSITIVE CONTROL: a tampered RESULT is reported, with the field that differs", () => {
    const e = stored(6, INTL);
    // Assert the pre-state, or a "forgery" that happens to equal the real
    // answer would make this control pass for the wrong reason — which is
    // exactly what the first draft of this case did (it forged "yes" onto a
    // record whose verdict already was "yes", and reported a green match).
    assert.equal(e.decision.result.verdict, "yes");
    const forged = {
      ...e,
      decision: { ...e.decision, result: { ...e.decision.result, verdict: "no" as const } },
    };
    const r = replayDecision(forged);
    assert.equal(r.status, "mismatch");
    assert.deepEqual(r.mismatchedFields, ["result.verdict"]);
  });

  it("POSITIVE CONTROL: a forged DEADLINE is reported — the number a traveller acts on", () => {
    const e = stored(6, INTL);
    const later = new Date(Date.parse(e.decision.result.hardReturnTime) + 45 * 60_000).toISOString();
    const forged = {
      ...e,
      decision: { ...e.decision, result: { ...e.decision.result, hardReturnTime: later } },
    };
    const r = replayDecision(forged);
    assert.equal(r.status, "mismatch");
    assert.ok(r.mismatchedFields.includes("result.hardReturnTime"));
  });

  it("POSITIVE CONTROL: a stored INPUT HASH that does not match its own inputs is reported", () => {
    const e = stored(6, INTL);
    const forged = { ...e, decision: { ...e.decision, inputHash: "sha256:" + "0".repeat(64) } };
    const r = replayDecision(forged);
    assert.equal(r.status, "mismatch");
    assert.ok(r.mismatchedFields.includes("inputHash"));
  });

  it("POSITIVE CONTROL: a rule that stopped firing is reported", () => {
    const e = stored(6, INTL);
    const forged = {
      ...e,
      decision: { ...e.decision, rulesApplied: e.decision.rulesApplied.filter((r) => r !== "buffer.traffic") },
    };
    const r = replayDecision(forged);
    assert.equal(r.status, "mismatch");
    assert.ok(r.mismatchedFields.includes("rulesApplied"));
    assert.deepEqual(r.rulesAdded, ["buffer.traffic"]);
  });

  it("the snapshot id is recomputed, not trusted", () => {
    const e = stored(6, INTL);
    const forged = { ...e, decision: { ...e.decision, snapshotId: "snap:" + "f".repeat(32) } };
    const r = replayDecision(forged);
    assert.equal(r.status, "mismatch");
    assert.ok(r.mismatchedFields.includes("snapshotId"));
  });
});

// ── L217 — replay across engine versions is REFUSED, not counted ─────────────

describe("§20 L217 — a version change is a diff, not a mismatch", () => {
  it("refuses to replay a record whose engine version is not the running one", () => {
    const e = stored(6, INTL);
    const oldEngine = {
      ...e,
      inputs: { ...e.inputs, engineVersion: "2026.01.01-1" },
      decision: { ...e.decision, engineVersion: "2026.01.01-1" },
    };
    const r = replayDecision(oldEngine);
    assert.equal(r.status, "refused");
    assert.equal(r.refusal, "ENGINE_VERSION_CHANGED");
    assert.deepEqual(r.mismatchedFields, []);
  });

  it("POSITIVE CONTROL: a refusal is NOT a match — it never counts toward target 0", () => {
    const e = stored(6, INTL);
    const oldEngine = {
      ...e,
      inputs: { ...e.inputs, engineVersion: "2026.01.01-1" },
      decision: { ...e.decision, engineVersion: "2026.01.01-1" },
    };
    const summary = replayLedger([e, oldEngine]);
    assert.equal(summary.replayed, 1);
    assert.equal(summary.matched, 1);
    assert.equal(summary.mismatched, 0);
    assert.equal(summary.refused, 1);
    // The metric's denominator is what was REPLAYED, not what was read.
    assert.equal(summary.mismatchRate, 0);
  });

  it("every refusal reason is declared, so a new one cannot be spelled freely", () => {
    const e = stored(6, INTL);
    const broken = { ...e, inputs: { ...e.inputs, session: { ...e.inputs.session, arrivalTime: "not-a-date" } } };
    const r = replayDecision(broken);
    assert.equal(r.status, "refused");
    assert.ok((REPLAY_REFUSAL_REASONS as readonly string[]).includes(r.refusal!));
  });

  it("POSITIVE CONTROL: a mismatch rate over a corpus with one bad row is not zero", () => {
    const good = [stored(6, INTL, "s1"), stored(7, INTL, "s2")];
    const bad = stored(8, INTL, "s3");
    const forged = {
      ...bad,
      decision: { ...bad.decision, result: { ...bad.decision.result, usableMinutes: 9999 } },
    };
    const summary = replayLedger([...good, forged]);
    assert.equal(summary.replayed, 3);
    assert.equal(summary.mismatched, 1);
    assert.ok(Math.abs(summary.mismatchRate - 1 / 3) < 1e-9);
  });
});

// ── L241 — decision diff over a corpus ───────────────────────────────────────

describe("§21 L241 — decision diff between two behaviours", () => {
  it("an identical corpus diffs to nothing, and says how many it compared", () => {
    const a = [stored(6, INTL, "s1").decision, stored(7, INTL, "s2").decision];
    const d = decisionDiffCorpus(a, a);
    assert.equal(d.compared, 2);
    assert.equal(d.changed, 0);
    assert.deepEqual(d.verdictFlips, []);
  });

  it("POSITIVE CONTROL: a corpus that compares NOTHING is reported, not called clean", () => {
    const a = [stored(6, INTL, "s1").decision];
    const b = [stored(6, INTL, "s2").decision];
    const d = decisionDiffCorpus(a, b);
    // Different sessions: nothing lines up. A diff that silently reports
    // `changed: 0` here is the "matches nothing, passes anyway" failure.
    assert.equal(d.compared, 0);
    assert.equal(d.unmatchedBaseline, 1);
    assert.equal(d.unmatchedCandidate, 1);
    assert.equal(d.vacuous, true);
  });

  it("a verdict flip is surfaced by name — that is the diff worth reading", () => {
    const base = stored(6, INTL, "s1").decision;
    // Same session, a slower airport: the same traveller gets a different answer.
    const slower = decisionRecordFor(
      "s1",
      certifySessionFeasibility(
        airport({ internationalBufferMin: 260, trafficExtraMin: 40 }),
        session(6, INTL),
        { nowMs: NOW },
      ),
    );
    const d = decisionDiffCorpus([base], [slower]);
    assert.equal(d.compared, 1);
    assert.equal(d.changed, 1);
    assert.equal(d.vacuous, false);
    assert.equal(d.verdictFlips.length, 1);
    assert.equal(d.verdictFlips[0].sessionId, "s1");
    assert.notEqual(d.verdictFlips[0].from, d.verdictFlips[0].to);
  });

  it("POSITIVE CONTROL: a diff that moves a DEADLINE EARLIER is called out separately", () => {
    const base = stored(6, INTL, "s1").decision;
    const slower = decisionRecordFor(
      "s1",
      certifySessionFeasibility(airport({ trafficExtraMin: 55 }), session(6, INTL), { nowMs: NOW }),
    );
    const d = decisionDiffCorpus([base], [slower]);
    assert.equal(d.deadlineMovedEarlier.length, 1);
    assert.equal(d.deadlineMovedLater.length, 0);
    assert.ok(d.deadlineMovedEarlier[0].byMinutes > 0);
    // And the reverse direction is the one a reviewer must never miss: a change
    // that hands travellers MORE time is the one that can strand them.
    const rev = decisionDiffCorpus([slower], [base]);
    assert.equal(rev.deadlineMovedLater.length, 1);
    assert.equal(rev.deadlineMovedEarlier.length, 0);
  });
});

// ── diffDecisions, on its own ────────────────────────────────────────────────

describe("diffDecisions names every field that moved", () => {
  it("reports rule set changes in both directions", () => {
    const a = stored(6, INTL, "s1").decision;
    const b = stored(6, { ...INTL, checkedBags: true }, "s1").decision;
    const d = diffDecisions(a, b);
    assert.ok(d.rulesAdded.includes("buffer.bags"));
    assert.deepEqual(d.rulesRemoved, []);
    assert.ok(d.fields.includes("rulesApplied"));
  });

  it("POSITIVE CONTROL: a diff of a record with itself is empty in every field", () => {
    const a = stored(6, INTL, "s1").decision;
    const d = diffDecisions(a, a);
    assert.deepEqual(d.fields, []);
    assert.deepEqual(d.rulesAdded, []);
    assert.deepEqual(d.rulesRemoved, []);
  });
});
