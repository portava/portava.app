/**
 * Sensing §16 — lib/safetyCandidate: the anomaly shapes that make a SAFETY
 * CANDIDATE, the row it is filed as into the existing review queue, and what
 * a candidate must never carry.
 *
 * Pins: each of the three shapes fires on its evidence and on nothing else;
 * the assertion itself (unsafe_density) is never a candidate; a
 * non-observational envelope evidences nothing; the evidence carries claim
 * refs and values and no count, cohort or actor; the filed row is a place /
 * safety_concern report with no reporter; the details round-trip and a
 * foreign details string is not the detector's.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ASSERTED_CROWD_LEVEL,
  CANDIDATE_CROWD_LEVEL,
  CANDIDATE_FORBIDDEN_KEYS,
  CANDIDATE_TRAJECTORIES,
  RAPID_RISE_FROM_LEVELS,
  RAPID_RISE_WINDOW_MINUTES,
  SAFETY_CANDIDATE_CATEGORY,
  SAFETY_CANDIDATE_DETAILS_PREFIX,
  SAFETY_CANDIDATE_REASONS,
  SAFETY_CANDIDATE_SUBJECT_TYPE,
  candidateDetails,
  candidateReportRow,
  detectSafetyCandidates,
  parseCandidateDetails,
  rapidRiseFrom,
} from "../lib/safetyCandidate.js";
import { SAFETY_CLAIM_LEVEL, SAFETY_CLAIM_TYPE } from "../lib/mapProducers/safetyNoticeProducer.js";
import { SPECIALIST_ONLY_CROWD_LEVELS } from "../lib/intelContracts.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import type { PreviousReading } from "../lib/wallMoments.js";

const NOW = Date.parse("2026-09-12T10:00:00.000Z");
const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();
const PLACE = "88888888-bbbb-4bbb-8bbb-888888888888";

function env(claimType: string, value: unknown, over: Partial<LiveClaimEnvelope> = {}): LiveClaimEnvelope {
  return {
    id: `snap-${claimType}`,
    claimType,
    value,
    confidence: 0.85,
    band: "live",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "many",
    observedAt: iso(-3),
    validUntil: iso(27),
    state: "live",
    conflictState: "none",
    conflict: null,
    ...over,
  };
}
function reading(level: string, generatedMinutes: number): PreviousReading {
  return { claimType: "crowd.level", value: { level }, observedAt: iso(generatedMinutes - 1), generatedAt: iso(generatedMinutes) };
}

const PACKED = env("crowd.level", { level: "packed" });
const BUILDING = env("crowd.trajectory", { trajectory: "building" }, { validUntil: iso(12) });
const STABLE = env("crowd.trajectory", { trajectory: "stable" });

describe("lib/safetyCandidate — the vocabulary", () => {
  it("names three reasons; the candidate level is the top of the contributor vocabulary; the assertion is the map producer's", () => {
    assert.deepEqual([...SAFETY_CANDIDATE_REASONS], ["density_rising_past_capacity", "material_conflict_at_capacity", "rapid_density_rise"]);
    assert.equal(CANDIDATE_CROWD_LEVEL, "packed");
    assert.equal(ASSERTED_CROWD_LEVEL, SAFETY_CLAIM_LEVEL);
    assert.equal("crowd.level", SAFETY_CLAIM_TYPE);
    assert.ok((SPECIALIST_ONLY_CROWD_LEVELS as readonly string[]).includes(ASSERTED_CROWD_LEVEL));
    assert.deepEqual([...CANDIDATE_TRAJECTORIES], ["building", "peaking"]);
    assert.deepEqual([...RAPID_RISE_FROM_LEVELS], ["dead", "quiet", "moderate"]);
    assert.equal(RAPID_RISE_WINDOW_MINUTES, 30);
  });
  it("files into the existing queue: a place / safety_concern report", () => {
    assert.equal(SAFETY_CANDIDATE_SUBJECT_TYPE, "place");
    assert.equal(SAFETY_CANDIDATE_CATEGORY, "safety_concern");
  });
});

describe("lib/safetyCandidate — the three shapes", () => {
  it("density rising past capacity: packed AND building/peaking; not packed AND stable", () => {
    const rising = detectSafetyCandidates(PLACE, [PACKED, BUILDING], [], NOW);
    assert.deepEqual(rising.map((c) => c.reason), ["density_rising_past_capacity"]);
    assert.deepEqual(rising[0]!.evidence.claimRefs, [PACKED.id, BUILDING.id]);
    assert.equal(rising[0]!.evidence.trajectory, "building");
    assert.equal(rising[0]!.expiresAt, BUILDING.validUntil, "the evidence's earliest horizon");
    assert.equal(rising[0]!.detectedAt, new Date(NOW).toISOString());
    assert.deepEqual(detectSafetyCandidates(PLACE, [PACKED, STABLE], [], NOW), []);
    assert.deepEqual(detectSafetyCandidates(PLACE, [PACKED, env("crowd.trajectory", { trajectory: "peaking" })], [], NOW).map((c) => c.reason), ["density_rising_past_capacity"]);
  });

  it("material conflict at capacity: packed AND material; minor or none is not a candidate", () => {
    const c = detectSafetyCandidates(PLACE, [{ ...PACKED, conflictState: "material", band: "likely_current", state: "emerging" }], [], NOW);
    assert.deepEqual(c.map((x) => x.reason), ["material_conflict_at_capacity"]);
    assert.equal(c[0]!.evidence.conflictState, "material");
    assert.deepEqual(detectSafetyCandidates(PLACE, [{ ...PACKED, conflictState: "minor" }], [], NOW), []);
  });

  it("rapid density rise: packed with a reading at most moderate inside the window; outside it is not", () => {
    const inside = detectSafetyCandidates(PLACE, [PACKED], [reading("quiet", -20)], NOW);
    assert.deepEqual(inside.map((c) => c.reason), ["rapid_density_rise"]);
    assert.equal(inside[0]!.evidence.previousLevel, "quiet");
    assert.equal(inside[0]!.evidence.previousGeneratedAt, iso(-20));
    assert.deepEqual(detectSafetyCandidates(PLACE, [PACKED], [reading("quiet", -3 - RAPID_RISE_WINDOW_MINUTES - 1)], NOW), []);
    assert.deepEqual(detectSafetyCandidates(PLACE, [PACKED], [reading("busy", -10)], NOW), [], "busy → packed is one rung, not a rapid rise");
    assert.equal(rapidRiseFrom(PACKED, [reading("dead", -25), reading("moderate", -10)])?.generatedAt, iso(-10), "the most recent qualifying reading");
    assert.equal(rapidRiseFrom(PACKED, [reading("quiet", 5)]), null, "a reading after the observation is not before it");
  });

  it("at most one candidate per reason, and all three together when all three hold", () => {
    const all = detectSafetyCandidates(PLACE, [{ ...PACKED, conflictState: "material" }, BUILDING], [reading("dead", -15)], NOW);
    assert.deepEqual(all.map((c) => c.reason), ["density_rising_past_capacity", "material_conflict_at_capacity", "rapid_density_rise"]);
    assert.equal(new Set(all.map((c) => c.reason)).size, 3);
  });
});

describe("lib/safetyCandidate — what is never a candidate", () => {
  it("the assertion itself: unsafe_density is the end of the pipeline, not an entry", () => {
    const asserted = env("crowd.level", { level: ASSERTED_CROWD_LEVEL }, { conflictState: "material" });
    assert.deepEqual(detectSafetyCandidates(PLACE, [asserted, BUILDING], [reading("quiet", -10)], NOW), []);
  });
  it("anything below packed", () => {
    assert.deepEqual(detectSafetyCandidates(PLACE, [env("crowd.level", { level: "busy" }), BUILDING], [reading("quiet", -10)], NOW), []);
  });
  it("a non-observational crowd claim evidences nothing; a non-observational trajectory does not count", () => {
    for (const sourceClass of ["historical_pattern", "portava_prediction", "sponsored"] as const) {
      assert.deepEqual(detectSafetyCandidates(PLACE, [{ ...PACKED, sourceClass }, BUILDING], [reading("quiet", -10)], NOW), [], sourceClass);
    }
    assert.deepEqual(detectSafetyCandidates(PLACE, [PACKED, { ...BUILDING, sourceClass: "portava_prediction" }], [], NOW), []);
  });
  it("no crowd claim at all", () => {
    assert.deepEqual(detectSafetyCandidates(PLACE, [BUILDING], [reading("quiet", -10)], NOW), []);
  });
});

describe("lib/safetyCandidate — the filed row", () => {
  it("is a place / safety_concern report with no reporter, open, whose details carry the candidate", () => {
    const [c] = detectSafetyCandidates(PLACE, [PACKED, BUILDING], [], NOW);
    const row = candidateReportRow(c!);
    assert.equal(row.reporter_id, null);
    assert.equal(row.subject_type, "place");
    assert.equal(row.subject_id, PLACE);
    assert.equal(row.subject_user_id, null);
    assert.equal(row.category, "safety_concern");
    assert.equal(row.status, "open");
    assert.ok(row.details.startsWith(SAFETY_CANDIDATE_DETAILS_PREFIX));
    const back = parseCandidateDetails(row.details);
    assert.ok(back);
    assert.equal(back.reason, "density_rising_past_capacity");
    assert.deepEqual(back.evidence, c!.evidence);
    assert.deepEqual(back.truth, c!.truth);
    assert.equal(back.expiresAt, c!.expiresAt);
  });

  it("carries claim refs and values and never a count, cohort, contributor or actor", () => {
    const [c] = detectSafetyCandidates(PLACE, [{ ...PACKED, conflictState: "material" }, BUILDING], [reading("quiet", -10)], NOW);
    const details = candidateDetails(c!);
    for (const k of CANDIDATE_FORBIDDEN_KEYS) assert.equal(details.includes(`"${k}"`), false, `details must not carry ${k}`);
    assert.ok(details.includes(`"claimRefs":["${PACKED.id}"`));
    assert.throws(
      () => candidateDetails({ ...c!, evidence: { ...c!.evidence, distinct_actors: 12 } as never }),
      /must not carry distinct_actors/,
      "a count smuggled into the evidence is refused at write",
    );
  });

  it("does not read what it did not write", () => {
    assert.equal(parseCandidateDetails("A person's own report about this place"), null);
    assert.equal(parseCandidateDetails(null), null);
    assert.equal(parseCandidateDetails(`${SAFETY_CANDIDATE_DETAILS_PREFIX}not json`), null);
    assert.equal(parseCandidateDetails(`${SAFETY_CANDIDATE_DETAILS_PREFIX}{"version":1,"reason":"made_up","evidence":{"claimRefs":[]},"truth":{},"detectedAt":"x","expiresAt":"y"}`), null);
    assert.equal(parseCandidateDetails(`${SAFETY_CANDIDATE_DETAILS_PREFIX}{"version":2,"reason":"rapid_density_rise","evidence":{"claimRefs":[]},"truth":{},"detectedAt":"x","expiresAt":"y"}`), null);
  });
});
