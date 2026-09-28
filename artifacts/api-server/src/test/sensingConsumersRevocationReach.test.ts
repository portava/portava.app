/**
 * S112 — the session and memory stages, now that a revocation can reach them.
 *
 * The census: *"Five stages are defined and executable … The session and memory
 * stages are prevented only because nothing bridges to them. RED WHEN a session
 * exists (S30) and a memory bridge exists (S54/S92) for a revocation to
 * reach."*
 *
 * This file does not assume the reach; it EXECUTES it. A revocation of two
 * snapshot ids is followed from the claim refs, through a real
 * `ExperienceSession` built by `lib/experienceSession`, into a real memory
 * record built by the S92 bridge, and the stages it touched are read back.
 *
 * It also pins the two things that could make the reach a lie: a stage claimed
 * without being touched, and "retained de-identified" hiding an identifier.
 *
 * The anonymous path's table is asserted UNCHANGED here as well. Its verdicts
 * were and remain `prevented`, for a better reason than the one originally
 * recorded — nothing bridges the anonymous store to anything, and publishing
 * from it is the owner's untaken decision #9.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_REVOCATION_EFFECT,
  REVOCATION_EFFECT_BY_PATH,
  SENSING_LINEAGE_STAGES,
  SENSING_REVOCATION_EFFECT,
  stagesReached,
} from "../lib/sensingRevocationLineage.js";
import {
  closeExperienceSession,
  openExperienceSession,
  type ExperienceSessionEnvelope,
} from "../lib/experienceSession.js";
import { sessionMemorySignal } from "../services/memoryProjections/experienceSessionBridge.js";
import { normalizeEvidence, type NormalizedEvidence } from "../services/memoryProjections/evidence.js";
import {
  REACHABLE_LINEAGE_STAGES,
  memoryReach,
  reachedStageCarriesIdentity,
  revocationReach,
  sessionReach,
} from "../services/memoryProjections/sessionRevocationReach.js";

const NOW = Date.parse("2026-09-20T21:00:00.000Z");
const CLOSE_NOW = NOW + 60 * 60 * 1000;
const OWNER = "11111111-aaaa-4aaa-8aaa-111111111111";
const PLACE = "22222222-bbbb-4bbb-8bbb-222222222222";

function session(sessionId: string, claimRefs: string[]): ExperienceSessionEnvelope {
  const o = openExperienceSession(
    OWNER,
    { sessionId, subjectId: PLACE, opportunityKind: "go_now", claimRefs },
    NOW,
  );
  assert.ok(o.ok, "fixture session must open");
  const c = closeExperienceSession(o.envelope, OWNER, { outcome: "better" }, CLOSE_NOW);
  assert.ok(c.ok, "fixture session must close");
  return c.envelope;
}

/** The memory record the S92 bridge actually produces for a session. */
function memoryOf(envelope: ExperienceSessionEnvelope): NormalizedEvidence {
  const built = sessionMemorySignal(OWNER, envelope, CLOSE_NOW);
  assert.ok(built.ok, "the bridge must speak for a closed, occurred session");
  const norm = normalizeEvidence(built.signal, new Date(CLOSE_NOW));
  assert.ok(norm.ok, `normalization failed: ${JSON.stringify(norm)}`);
  return norm.evidence;
}

const SID_A = "33333333-cccc-4ccc-8ccc-333333333333";
const SID_B = "44444444-dddd-4ddd-8ddd-444444444444";
const SID_C = "55555555-eeee-4eee-8eee-555555555555";

describe("S112 — the definition now distinguishes the two paths", () => {
  it("the ANONYMOUS path is unchanged: session and memory are still prevented", () => {
    assert.equal(SENSING_REVOCATION_EFFECT.session, "prevented");
    assert.equal(SENSING_REVOCATION_EFFECT.memory, "prevented");
    assert.deepEqual(stagesReached("sensing_anonymous"), ["raw", "aggregate", "inference"]);
  });

  it("the CANONICAL path reaches all five stages", () => {
    for (const s of SENSING_LINEAGE_STAGES) assert.ok(CANONICAL_REVOCATION_EFFECT[s], s);
    assert.equal(CANONICAL_REVOCATION_EFFECT.session, "retained_deidentified");
    assert.equal(CANONICAL_REVOCATION_EFFECT.memory, "retained_deidentified");
    assert.deepEqual(stagesReached("canonical_intel"), [...SENSING_LINEAGE_STAGES]);
    assert.ok(Object.isFrozen(CANONICAL_REVOCATION_EFFECT));
    assert.ok(Object.isFrozen(REVOCATION_EFFECT_BY_PATH));
  });

  it("the reach module's restated stage list cannot drift from the definition's", () => {
    // sessionRevocationReach restates the five stages instead of importing them,
    // to avoid tripping §9.1's sensing-stack importer tripwire. This is the
    // assertion that makes the restatement safe; a test file is outside §9.1's
    // walk, so it may import both.
    assert.deepEqual([...REACHABLE_LINEAGE_STAGES], [...SENSING_LINEAGE_STAGES]);
  });

  it("`stagesReached` is DERIVED from the effect table, not restated beside it", () => {
    for (const path of ["sensing_anonymous", "canonical_intel"] as const) {
      const table = REVOCATION_EFFECT_BY_PATH[path];
      assert.deepEqual(stagesReached(path), SENSING_LINEAGE_STAGES.filter((s) => table[s] !== "prevented"));
    }
  });
});

describe("S112 — a revocation followed to the session and memory stages", () => {
  it("reaches exactly the session that rested on a revoked claim", () => {
    const hit = session(SID_A, ["snap-1", "snap-2"]);
    const miss = session(SID_B, ["snap-9"]);

    assert.equal(sessionReach(hit, new Set(["snap-2"])).verdict, "reached");
    assert.deepEqual(sessionReach(hit, new Set(["snap-2"])).revokedClaimRefs, ["snap-2"]);
    assert.equal(sessionReach(miss, new Set(["snap-2"])).verdict, "unaffected");
  });

  it("reaches the MEMORY the bridge derived from that session", () => {
    const hit = memoryOf(session(SID_A, ["snap-1", "snap-2"]));
    const miss = memoryOf(session(SID_B, ["snap-9"]));

    assert.equal(memoryReach(hit, new Set(["snap-1"])).verdict, "reached");
    assert.equal(memoryReach(miss, new Set(["snap-1"])).verdict, "unaffected");
    // The thread is the bridge's own provenance field, and nothing else.
    assert.deepEqual(memoryReach(hit, new Set(["snap-1"])).claimRefs, ["snap-1", "snap-2"]);
  });

  it("END TO END: one revocation, five stages reported", () => {
    const hit = session(SID_A, ["snap-1", "snap-2"]);
    const miss = session(SID_B, ["snap-9"]);
    const report = revocationReach([hit, miss], [memoryOf(hit), memoryOf(miss)], ["snap-2"]);

    assert.deepEqual(report.stagesReached, ["raw", "aggregate", "inference", "session", "memory"]);
    assert.deepEqual(
      report.sessions.map((s) => [s.sessionId, s.verdict]),
      [[SID_A, "reached"], [SID_B, "unaffected"]],
    );
    assert.deepEqual(report.memories.map((m) => m.verdict), ["reached", "unaffected"]);
  });

  it("claims no stage it did not touch", () => {
    const miss = session(SID_B, ["snap-9"]);
    const report = revocationReach([miss], [memoryOf(miss)], ["snap-2"]);
    assert.equal(report.stagesReached.includes("session"), false);
    assert.equal(report.stagesReached.includes("memory"), false);

    // And an empty revocation reaches NOTHING, not everything.
    const none = revocationReach([session(SID_A, ["snap-1"])], [], []);
    assert.deepEqual(none.stagesReached, []);
    assert.equal(none.sessions[0].verdict, "unaffected");
  });

  it("a session with no claim thread is reported as such, never swept in", () => {
    const bare = session(SID_C, []);
    const r = sessionReach(bare, new Set(["snap-1"]));
    assert.equal(r.verdict, "no_claim_thread");
    assert.deepEqual(r.revokedClaimRefs, []);
    assert.equal(revocationReach([bare], [], ["snap-1"]).stagesReached.includes("session"), false);
  });
});

describe("S112 — 'retained, de-identified' is not a euphemism at the new stages", () => {
  it("neither the session nor the memory carries anything a revocation identifies", () => {
    const s = session(SID_A, ["snap-1"]);
    const m = memoryOf(s);
    // The identifiers a revocation is proved against on the anonymous path:
    // a contributor token and a group token. Neither stage may carry one.
    const identifiers = ["contributor-token-abc", "grp-0-yyyyyyyyyyyyyyyy"];
    assert.equal(reachedStageCarriesIdentity(s, identifiers), null);
    assert.equal(reachedStageCarriesIdentity(m, identifiers), null);

    // The detector is not vacuous: it finds one when one is there.
    assert.equal(
      reachedStageCarriesIdentity({ ...s, smuggled: "contributor-token-abc" }, identifiers),
      "contributor-token-abc",
    );
  });

  it("no coordinate survives into either stage", () => {
    const json = JSON.stringify(memoryOf(session(SID_A, ["snap-1"])));
    for (const leak of ["latitude", "longitude", "\"lat\"", "\"lng\"", "coords", "accuracy"]) {
      assert.ok(!json.includes(leak), `memory record leaked ${leak}`);
    }
  });
});
