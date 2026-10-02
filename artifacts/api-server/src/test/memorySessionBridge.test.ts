/**
 * memorySessionBridge — S92, executed.
 *
 * The census: *"Eligibility and decay exist; the bridge is a graph-edge
 * projection … RED WHEN S54 exists and memory eligibility is computed from a
 * session's OUTCOME rather than from a graph edge."*
 *
 * The centre of this file is the FIVE-WAY CASE an edge cannot answer. All five
 * sessions below are the same person and the same place, and a
 * `compass_graph_edges` row would be identical for every one of them. The
 * outcome separates them, and the assertions pin each answer:
 *
 *   better           → a Memory candidate
 *   worse            → a Memory candidate (a bad evening still happened)
 *   did_not_go       → NOT a memory; the gate refuses it as PLANNED
 *   could_not_enter  → NOT a memory; nothing attests the experience occurred
 *   never closed     → NOT a memory; the bridge will not speak for it
 *
 * Watched red against the pre-change tree: the module did not exist, and
 * `grep -ri experiencesession services/memoryProjections/ lib/memoryProjection
 * Scheduler.ts` returned nothing — which is the census's own RED WHEN clause.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeExperienceSession,
  openExperienceSession,
  type ExperienceSessionEnvelope,
} from "../lib/experienceSession.js";
import { INTEL_OUTCOMES, type IntelOutcome } from "../lib/intelOutcomes.js";
import {
  OUTCOME_ASSERTION,
  OUTCOME_CONFIDENCE,
  SESSION_BRIDGE_VERSION,
  sessionMemoryEligibility,
  sessionMemorySignal,
} from "../services/memoryProjections/experienceSessionBridge.js";
import { runSessionMemoryBridge } from "../lib/memoryProjectionScheduler.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-09-20T21:00:00.000Z");
const OWNER = "11111111-aaaa-4aaa-8aaa-111111111111";
const PLACE = "22222222-bbbb-4bbb-8bbb-222222222222";
const SESSION = "33333333-cccc-4ccc-8ccc-333333333333";

function opened(nowMs = NOW): ExperienceSessionEnvelope {
  const r = openExperienceSession(
    OWNER,
    { sessionId: SESSION, subjectId: PLACE, opportunityKind: "go_now", claimRefs: ["snap-1", "snap-2"] },
    nowMs,
  );
  assert.ok(r.ok, "fixture session must open");
  return r.envelope;
}

function closedWith(outcome: IntelOutcome, ratingOrUndef?: number): ExperienceSessionEnvelope {
  const r = closeExperienceSession(
    opened(),
    OWNER,
    ratingOrUndef === undefined ? { outcome } : { outcome, experienceRating: ratingOrUndef },
    NOW + 60 * 60 * 1000,
  );
  assert.ok(r.ok, `fixture session must close with ${outcome}`);
  return r.envelope;
}

const CLOSE_NOW = NOW + 60 * 60 * 1000;

describe("S92 — the five sessions one graph edge cannot tell apart", () => {
  it("`better` is a Memory candidate", () => {
    const v = sessionMemoryEligibility(OWNER, closedWith("better"), CLOSE_NOW);
    assert.equal(v.refusal, null);
    assert.equal(v.evidence?.assertion_type, "OCCURRED");
    assert.equal(v.eligible, true, v.verdict?.detail);
  });

  it("`worse` is EQUALLY a Memory candidate — a bad evening still happened", () => {
    const v = sessionMemoryEligibility(OWNER, closedWith("worse"), CLOSE_NOW);
    assert.equal(v.eligible, true, v.verdict?.detail);
    // And the occurrence is no less certain than a good one: confidence is
    // about whether it happened, never about how it went.
    assert.equal(OUTCOME_CONFIDENCE.worse, OUTCOME_CONFIDENCE.better);
  });

  it("`did_not_go` is REFUSED — the edge's mistake, caught", () => {
    const v = sessionMemoryEligibility(OWNER, closedWith("did_not_go"), CLOSE_NOW);
    assert.equal(v.evidence?.assertion_type, "PLANNED");
    assert.equal(v.eligible, false);
    assert.equal(v.verdict?.reason, "PLANNED_OR_SAVED_ONLY");
  });

  it("`could_not_enter` is REFUSED — presence is not experience", () => {
    const v = sessionMemoryEligibility(OWNER, closedWith("could_not_enter"), CLOSE_NOW);
    assert.equal(v.evidence?.assertion_type, "NEARBY");
    assert.equal(v.eligible, false);
    assert.equal(v.verdict?.reason, "INSUFFICIENT_OCCURRENCE_EVIDENCE");
  });

  it("a session that never closed is REFUSED, and open ≠ expired", () => {
    const open = sessionMemoryEligibility(OWNER, opened(), CLOSE_NOW);
    assert.equal(open.eligible, false);
    assert.equal(open.refusal, "session_open");
    assert.equal(open.verdict, null, "the gate is not even asked — there is no outcome to judge");

    // Past its window with no outcome reported is a DIFFERENT fact, and
    // lib/experienceSession already refuses to close it after the fact.
    const late = sessionMemoryEligibility(OWNER, opened(), NOW + 48 * 60 * 60 * 1000);
    assert.equal(late.refusal, "session_expired_without_outcome");
  });
});

describe("S92 — eligibility comes from the OUTCOME, and the mapping is total", () => {
  it("every outcome in the canonical vocabulary has an assertion and a confidence", () => {
    for (const o of INTEL_OUTCOMES) {
      assert.ok(OUTCOME_ASSERTION[o], `no assertion for ${o}`);
      assert.equal(typeof OUTCOME_CONFIDENCE[o], "number", `no confidence for ${o}`);
    }
    assert.equal(Object.keys(OUTCOME_ASSERTION).length, INTEL_OUTCOMES.length);
  });

  it("the outcome is the ONLY thing that moves the verdict", () => {
    // Same owner, same place, same window, same claims — only the outcome
    // differs, and the verdicts differ. That is the row, in one assertion.
    const verdicts = INTEL_OUTCOMES.map((o) => sessionMemoryEligibility(OWNER, closedWith(o), CLOSE_NOW).eligible);
    assert.deepEqual(verdicts, [true, true, true, true, false, false]);
  });

  it("it reads NO graph edge: the bridge never mentions one", () => {
    const code = readFileSync(
      join(SRC, "services", "memoryProjections", "experienceSessionBridge.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [/compass_graph_edges/, /graphEdge/, /graph_edge/]) {
      assert.doesNotMatch(code, forbidden);
    }
    // And it is pure — the eligibility computation takes its instant.
    assert.doesNotMatch(code, /Date\.now\(/);
    assert.doesNotMatch(code, /getServiceClient|\.from\(/);
  });
});

describe("S92 — what the bridge carries, and what it refuses to carry", () => {
  it("claim_refs travel through, so a revocation can still reach a Memory (S112)", () => {
    const built = sessionMemorySignal(OWNER, closedWith("better"), CLOSE_NOW);
    assert.ok(built.ok);
    assert.deepEqual(built.signal.provenance_json?.claim_refs, ["snap-1", "snap-2"]);
    assert.equal(built.signal.provenance_json?.session_id, SESSION);
    assert.equal(built.signal.provenance_json?.bridge_version, SESSION_BRIDGE_VERSION);
  });

  it("a trail-shaped key is refused rather than normalized away", () => {
    const poisoned = { ...closedWith("better"), visits: ["a", "b"] } as unknown as ExperienceSessionEnvelope;
    const built = sessionMemorySignal(OWNER, poisoned, CLOSE_NOW);
    assert.equal(built.ok, false);
    assert.equal(built.ok === false && built.reason, "forbidden_key");
  });

  it("no rating is invented when the owner left none", () => {
    const without = sessionMemorySignal(OWNER, closedWith("better"), CLOSE_NOW);
    assert.ok(without.ok);
    assert.equal("experience_rating" in (without.signal.assertion_json ?? {}), false);

    const with4 = sessionMemorySignal(OWNER, closedWith("better", 4), CLOSE_NOW);
    assert.ok(with4.ok);
    assert.equal(with4.signal.assertion_json?.experience_rating, 4);
  });

  it("no owner, no memory", () => {
    const built = sessionMemorySignal("", closedWith("better"), CLOSE_NOW);
    assert.equal(built.ok, false);
    assert.equal(built.ok === false && built.reason, "owner_required");
  });

  it("a sensitive place still overrides a good outcome", () => {
    const v = sessionMemoryEligibility(OWNER, closedWith("better"), CLOSE_NOW, {
      ctx: { sensitive_place_ids: new Set([PLACE]) },
    });
    assert.equal(v.eligible, false);
    assert.equal(v.verdict?.reason, "SENSITIVE_CONTEXT");
  });
});

describe("S92 — the driver runs it", () => {
  it("the scheduler's bridge pass judges a handed session through the store", () => {
    // A store stub standing in for the ONE bounded read the seam offers.
    const envelope = closedWith("did_not_go");
    const sc = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: () => ({
              gte: () => ({
                order: () => ({
                  limit: async () => ({
                    data: [{ payload: { experience_session: envelope } }],
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    };
    return runSessionMemoryBridge(sc, [{ ownerId: OWNER, sessionId: SESSION }], CLOSE_NOW).then((out) => {
      assert.equal(out.length, 1);
      assert.equal(out[0].eligible, false);
      assert.equal(out[0].reason, "PLANNED_OR_SAVED_ONLY");
    });
  });

  it("the scheduler names the bridge — the census's grep now hits", () => {
    const code = readFileSync(join(SRC, "lib", "memoryProjectionScheduler.ts"), "utf8");
    assert.match(code, /experienceSessionBridge/);
    assert.match(code, /readSessionById/);
  });
});
