/**
 * Section 6 - evidence normalization and eligibility.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *       section 6 (:227), section 4 truth precedence (:178), 28.2.
 * CENSUS: H54, H55, H56, H57 - all NOT-BUILT before this suite.
 *
 * WHAT THIS SUITE IS DEFENDING AGAINST, stated so a later reader can check that
 * the assertions actually do it:
 *
 *   * A gate that says yes to everything. Every rejection case below is PAIRED
 *     with a fixture that differs in exactly the field under test and is
 *     ELIGIBLE. A blanket-reject gate fails the pairs; a blanket-accept gate
 *     fails the rejections.
 *   * A gate whose reason code is whatever ran last. The order assertions pin
 *     which reason a caller is given when two rules trip at once.
 *   * A normalizer that repairs bad input. An unparseable timestamp must be a
 *     rejection, not `now`: a Memory dated by the moment its signal was
 *     processed is a fabricated historical fact.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryProjectionEvidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ELIGIBILITY_REJECTION_REASONS,
  EVIDENCE_SOURCE_STRENGTH,
  confidenceBandOf,
  dedupeEvidence,
  evaluateEligibility,
  mergeByPrecedence,
  normalizeEvidence,
  precedenceRank,
  type NormalizedEvidence,
  type RawSignal,
} from "../services/memoryProjections/evidence.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-05-10T12:00:00.000Z");

function raw(over: Partial<RawSignal> = {}): RawSignal {
  return {
    owner_id: OWNER,
    source_type: "CAMERA_CAPTURE",
    source_id: "media-1",
    assertion_type: "CAPTURED_MEDIA",
    observed_at: "2026-05-09T18:30:00.000Z",
    assertion_json: { place_id: "place-a", capture_provenance: "camera" },
    ...over,
  };
}

function norm(over: Partial<RawSignal> = {}): NormalizedEvidence {
  const r = normalizeEvidence(raw(over), NOW);
  assert.ok(r.ok, `fixture failed to normalize: ${JSON.stringify(r)}`);
  return r.evidence;
}

describe("section 6: normalization refuses rather than repairs", () => {
  it("PAIRED CONTROL - a well-formed signal normalizes", () => {
    const r = normalizeEvidence(raw(), NOW);
    assert.ok(r.ok);
    assert.equal(r.evidence.observed_at, "2026-05-09T18:30:00.000Z");
    assert.equal(r.evidence.truth_level, "SYSTEM_OBSERVED");
    assert.equal(r.evidence.normalizer_version, "memory-evidence-normalizer@1");
  });

  const rejections: Array<[string, Partial<RawSignal>, string]> = [
    ["an unparseable time is not silently replaced by now", { observed_at: "last tuesday" }, "UNPARSEABLE_OBSERVED_AT"],
    ["a missing time is not silently replaced by now", { observed_at: undefined }, "UNPARSEABLE_OBSERVED_AT"],
    ["a future observation beyond skew", { observed_at: "2026-06-01T00:00:00.000Z" }, "OBSERVED_AT_IN_FUTURE"],
    ["an unknown source type", { source_type: "TAROT_READING" }, "UNKNOWN_SOURCE_TYPE"],
    ["an unknown assertion type", { assertion_type: "VIBED" }, "UNKNOWN_ASSERTION_TYPE"],
    ["no owner", { owner_id: undefined }, "MISSING_OWNER"],
    ["no source id", { source_id: "" }, "MISSING_SOURCE_ID"],
  ];
  for (const [name, over, reason] of rejections) {
    it(name, () => {
      const r = normalizeEvidence(raw(over), NOW);
      assert.equal(r.ok, false, `expected rejection, got ${JSON.stringify(r)}`);
      if (!r.ok) assert.equal(r.reason, reason);
    });
  }

  it("clock skew inside the tolerance is accepted, so the future check is a boundary not a wall", () => {
    const r = normalizeEvidence(raw({ observed_at: new Date(NOW.getTime() + 60_000).toISOString() }), NOW);
    assert.ok(r.ok, "a signal one minute ahead is ordinary clock skew");
  });

  it("a producer cannot inflate its source above the section 6 ceiling", () => {
    const e = norm({ source_type: "GPS_PROXIMITY", assertion_type: "NEARBY", confidence: 0.99 });
    assert.equal(e.confidence, EVIDENCE_SOURCE_STRENGTH.GPS_PROXIMITY.max_confidence);
    assert.equal(e.provenance_json.declared_confidence, 0.99, "the claim is kept in provenance, not thrown away");
  });

  it("the same claim delivered twice with jittered timestamps has one fingerprint", () => {
    const a = norm({ observed_at: "2026-05-09T18:30:10.000Z" });
    const b = norm({ observed_at: "2026-05-09T18:30:50.000Z" });
    assert.equal(a.fingerprint, b.fingerprint);
    const c = norm({ observed_at: "2026-05-09T19:30:00.000Z" });
    assert.notEqual(a.fingerprint, c.fingerprint, "an hour later is a different claim");
  });
});

describe("section 4: truth precedence", () => {
  it("orders correction > assertion > mutual > observed > inferred > unknown", () => {
    const rank = (truth: NormalizedEvidence["truth_level"], corr = false) =>
      precedenceRank({ truth_level: truth, is_correction: corr });
    assert.ok(rank("USER_ASSERTED", true) > rank("USER_ASSERTED"));
    assert.ok(rank("USER_ASSERTED") > rank("MUTUALLY_CONFIRMED"));
    assert.ok(rank("MUTUALLY_CONFIRMED") > rank("SYSTEM_OBSERVED"));
    assert.ok(rank("SYSTEM_OBSERVED") > rank("INFERRED"));
    assert.ok(rank("INFERRED") > rank("UNKNOWN"));
  });

  it("an inference may not overwrite a user correction, and says which fields it refused", () => {
    const correction = norm({ source_type: "USER_CORRECTION", source_id: "c1", assertion_type: "CORRECTION" });
    const inference = norm({ source_type: "GPS_PROXIMITY", source_id: "g1", assertion_type: "NEARBY" });
    const r = mergeByPrecedence(
      { place_id: "place-corrected", title: "Dinner" },
      { place_id: "place-guessed" },
      { base: correction, incoming: inference },
    );
    assert.equal(r.merged.place_id, "place-corrected");
    assert.deepEqual(r.refused, ["place_id"]);
  });

  it("PAIRED CONTROL - the same merge in the other direction DOES apply", () => {
    const correction = norm({ source_type: "USER_CORRECTION", source_id: "c1", assertion_type: "CORRECTION" });
    const inference = norm({ source_type: "GPS_PROXIMITY", source_id: "g1", assertion_type: "NEARBY" });
    const r = mergeByPrecedence(
      { place_id: "place-guessed" },
      { place_id: "place-corrected" },
      { base: inference, incoming: correction },
    );
    assert.equal(r.merged.place_id, "place-corrected");
    assert.deepEqual(r.refused, []);
  });

  it("dedupe keeps the higher-precedence record and is stable under input reordering", () => {
    const weak = norm({ source_type: "GPS_PROXIMITY", source_id: "s", assertion_type: "NEARBY" });
    const strong: NormalizedEvidence = { ...weak, source_type: "EXPLICIT_REMEMBER", truth_level: "USER_ASSERTED", confidence: 0.95 };
    const forward = dedupeEvidence([weak, strong]);
    const backward = dedupeEvidence([strong, weak]);
    assert.equal(forward.kept.length, 1);
    assert.equal(forward.kept[0].source_type, "EXPLICIT_REMEMBER");
    assert.deepEqual(forward.kept, backward.kept, "dedupe must not depend on arrival order");
  });
});

describe("section 6: the eligibility gate", () => {
  const eligibleSet = () => [norm()];

  it("PAIRED CONTROL - a camera capture at a place is eligible", () => {
    const v = evaluateEligibility(eligibleSet());
    assert.equal(v.eligible, true, JSON.stringify(v));
    assert.equal(v.reason, null);
    assert.equal(v.policy_version, "memory-eligibility@1");
  });

  it("28.2 - saved and planned alone never become 'visited'", () => {
    const v = evaluateEligibility([
      norm({ source_type: "TRIP_OUTCOME", source_id: "p1", assertion_type: "PLANNED" }),
      norm({ source_type: "TRIP_OUTCOME", source_id: "p2", assertion_type: "SAVED" }),
    ]);
    assert.equal(v.eligible, false);
    assert.equal(v.reason, "PLANNED_OR_SAVED_ONLY");
  });

  it("PAIRED - the same set plus one completed trip outcome IS eligible", () => {
    const v = evaluateEligibility([
      norm({ source_type: "TRIP_OUTCOME", source_id: "p1", assertion_type: "PLANNED" }),
      norm({ source_type: "TRIP_OUTCOME", source_id: "p2", assertion_type: "OCCURRED" }),
    ]);
    assert.equal(v.eligible, true, JSON.stringify(v));
  });

  it("a pass-by is not a visit - and the dwell threshold is a boundary, tested on both sides", () => {
    const passBy = evaluateEligibility([
      norm({ source_type: "GPS_PROXIMITY", source_id: "g1", assertion_type: "NEARBY", assertion_json: { place_id: "p", dwell_seconds: 599 } }),
      norm({ source_type: "GPS_PROXIMITY", source_id: "g2", assertion_type: "NEARBY", assertion_json: { place_id: "p", dwell_seconds: 120 } }),
    ]);
    assert.equal(passBy.eligible, false);
    assert.equal(passBy.reason, "PASS_BY_NOT_VISIT");

    const dwelt = evaluateEligibility([
      norm({ source_type: "GPS_PROXIMITY", source_id: "g1", assertion_type: "NEARBY", assertion_json: { place_id: "p", dwell_seconds: 600 } }),
      norm({ source_type: "TELEGRAPH_MESSAGE", source_id: "t1", assertion_type: "CO_PRESENT", assertion_json: { place_id: "p" } }),
    ]);
    assert.notEqual(dwelt.reason, "PASS_BY_NOT_VISIT", `600s is at the floor, not below it: ${JSON.stringify(dwelt)}`);
  });

  it("a screenshot is not a captured experience; a photo taken alongside it rescues the candidate", () => {
    const screenshotOnly = evaluateEligibility([
      norm({ source_id: "m1", assertion_json: { place_id: "p", capture_provenance: "screenshot" } }),
      norm({ source_id: "m2", assertion_json: { place_id: "p", capture_provenance: "downloaded" } }),
    ]);
    assert.equal(screenshotOnly.eligible, false);
    assert.equal(screenshotOnly.reason, "MEDIA_NOT_CAPTURED");

    const mixed = evaluateEligibility([
      norm({ source_id: "m1", assertion_json: { place_id: "p", capture_provenance: "screenshot" } }),
      norm({ source_id: "m2", assertion_json: { place_id: "p", capture_provenance: "camera" } }),
    ]);
    assert.equal(mixed.eligible, true, JSON.stringify(mixed));
  });

  it("sensitive context blocks AUTOMATIC candidacy but not the owner's own hand", () => {
    const ev = [norm({ assertion_json: { place_id: "clinic-1", capture_provenance: "camera" } })];
    const auto = evaluateEligibility(ev, { sensitive_place_ids: new Set(["clinic-1"]) });
    assert.equal(auto.eligible, false);
    assert.equal(auto.reason, "SENSITIVE_CONTEXT");

    const byOwner = evaluateEligibility(ev, { sensitive_place_ids: new Set(["clinic-1"]), mode: "USER_INITIATED" });
    assert.equal(byOwner.eligible, true, JSON.stringify(byOwner));
  });

  it("suppression silences inference, never the owner's explicit assertion", () => {
    const inferred = evaluateEligibility(
      [norm({ source_type: "CAMERA_CAPTURE", source_id: "m1", assertion_json: { place_id: "p", capture_provenance: "camera", inference_class: "nightlife" } })],
      { suppressed_classes: new Set(["nightlife"]) },
    );
    assert.equal(inferred.eligible, false);
    assert.equal(inferred.reason, "INFERENCE_SUPPRESSED_BY_POLICY");

    const asserted = evaluateEligibility(
      [
        norm({ source_type: "EXPLICIT_REMEMBER", source_id: "r1", assertion_type: "OCCURRED", assertion_json: { place_id: "p", inference_class: "nightlife" } }),
      ],
      { suppressed_classes: new Set(["nightlife"]) },
    );
    assert.equal(asserted.eligible, true, JSON.stringify(asserted));
  });

  it("a candidate every record of which already backs a Memory is a duplicate; one new record is not", () => {
    const a = norm({ source_id: "m1" });
    const b = norm({ source_id: "m2" });
    const dupe = evaluateEligibility([a, b], { existing_fingerprints: new Set([a.fingerprint, b.fingerprint]) });
    assert.equal(dupe.reason, "DUPLICATE_OF_EXISTING");
    const partial = evaluateEligibility([a, b], { existing_fingerprints: new Set([a.fingerprint]) });
    assert.equal(partial.eligible, true, JSON.stringify(partial));
  });

  it("two weak sources may corroborate; one weak source alone may not", () => {
    const alone = evaluateEligibility([
      norm({ source_type: "TELEGRAPH_MESSAGE", source_id: "t1", assertion_type: "CO_PRESENT", assertion_json: { place_id: "p" } }),
    ]);
    assert.equal(alone.eligible, false);
    assert.equal(alone.reason, "INSUFFICIENT_OCCURRENCE_EVIDENCE");

    const corroborated = evaluateEligibility([
      norm({ source_type: "TELEGRAPH_MESSAGE", source_id: "t1", assertion_type: "CO_PRESENT", assertion_json: { place_id: "p" } }),
      norm({ source_type: "CREW_OVERLAP", source_id: "c1", assertion_type: "CO_PRESENT", assertion_json: { place_id: "p" } }),
      norm({ source_type: "GPS_PROXIMITY", source_id: "g1", assertion_type: "NEARBY", assertion_json: { place_id: "p", dwell_seconds: 3600 } }),
    ]);
    assert.equal(corroborated.eligible, true, JSON.stringify(corroborated));
  });

  it("an empty evidence set is refused, not quietly accepted", () => {
    const v = evaluateEligibility([]);
    assert.equal(v.eligible, false);
    assert.equal(v.reason, "INSUFFICIENT_OCCURRENCE_EVIDENCE");
  });

  it("section 8's NO_CANDIDATE tier surfaces as the triviality reason, and SUGGESTED does not", () => {
    assert.equal(evaluateEligibility(eligibleSet(), { significance_tier: "NO_CANDIDATE" }).reason, "BELOW_TRIVIALITY_THRESHOLD");
    assert.equal(evaluateEligibility(eligibleSet(), { significance_tier: "SUGGESTED" }).eligible, true);
  });

  it("when two rules trip, the reason returned is the first in the documented order", () => {
    // Planned-only AND suppressed. PLANNED_OR_SAVED_ONLY is checked first.
    const v = evaluateEligibility(
      [norm({ source_type: "TRIP_OUTCOME", source_id: "p1", assertion_type: "PLANNED", assertion_json: { inference_class: "nightlife" } })],
      { suppressed_classes: new Set(["nightlife"]) },
    );
    assert.equal(v.reason, "PLANNED_OR_SAVED_ONLY");
    const tripped = v.checks.filter((c) => c.tripped).map((c) => c.reason);
    assert.ok(tripped.includes("INFERENCE_SUPPRESSED_BY_POLICY"), "the other rule is still reported in checks");
  });

  it("every verdict explains itself: one check row per registered reason code", () => {
    const v = evaluateEligibility(eligibleSet());
    assert.deepEqual(
      [...v.checks.map((c) => c.reason)].sort(),
      [...ELIGIBILITY_REJECTION_REASONS].sort(),
      "a reason that is never checked is a reason nobody can be given",
    );
    for (const c of v.checks) assert.ok(c.detail.length > 0, `${c.reason} explained nothing`);
  });
});

describe("section 4: confidence bands", () => {
  it("weak inference alone is INSUFFICIENT, not LOW-but-usable", () => {
    assert.equal(confidenceBandOf([{ confidence: 0.35, source_type: "GPS_PROXIMITY" }]), "INSUFFICIENT");
  });
  it("an explicit remember is HIGH", () => {
    assert.equal(confidenceBandOf([{ confidence: 0.95, source_type: "EXPLICIT_REMEMBER" }]), "HIGH");
  });
  it("a single camera capture is MEDIUM - real but not certain", () => {
    assert.equal(confidenceBandOf([{ confidence: 0.7, source_type: "CAMERA_CAPTURE" }]), "MEDIUM");
  });
  it("no evidence is INSUFFICIENT, never HIGH by vacuity", () => {
    assert.equal(confidenceBandOf([]), "INSUFFICIENT");
  });
});
