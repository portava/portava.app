/**
 * S79 — live claims in `/compass/ask`'s context, and a checker that convicts
 * against their band.
 *
 * The census, verbatim: *"RED WHEN live claims are carried into `/compass/ask`'s
 * context and a grounding checker constrains the generated language to the band
 * of its inputs — in that order, because a checker over an empty context is
 * vacuous."*
 *
 * So this file is in that order too.
 *
 *   PART 1  the context really carries the claims, graded through
 *           `lib/liveEnvelopeTruth.truthOfEnvelope`.
 *   PART 2  the checker REFUSES prose that claims a stronger truth band than
 *           those inputs support — including the sentence the OLD checker
 *           published, which is the whole point of the row.
 *   PART 3  it does not over-fire, and the fold can only tighten.
 *
 * THE VACUITY, DEMONSTRATED RATHER THAN ASSERTED. `vacuousBefore()` below runs
 * each rejected sentence through the envelope with the EMPTY evidence a
 * tool-less turn used to carry. Where it returns ok, the old path published
 * that sentence unqualified.
 *
 * IT DRIVES THE PURE CORE WITH REAL ENVELOPES. `liveClaimContextFrom` takes the
 * envelopes already read, so the interesting half is exercised on genuine
 * `LiveClaimEnvelope` values instead of through a stub of five feature flags, a
 * promoted-scope allowlist and a snapshot query. The I/O shell's own contract —
 * fail-soft, and a failed read never widens the band — is tested separately at
 * the bottom.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_LIVE_CLAIM_CONTEXT,
  LIVE_CLAIM_HEADER,
  buildLiveClaimContext,
  liveClaimContextFrom,
} from "../compass/CompassLiveClaimContext.js";
import type { LiveClaimEnvelope } from "../lib/liveClaimRead.js";
import {
  EMPTY_GROUNDING_EVIDENCE,
  enforceCompassGroundingEnvelope,
  mergeGroundingEvidence,
  type GroundingEvidence,
} from "../compass/CompassGroundingEnvelope.js";

const NOW = new Date("2026-09-20T21:00:00.000Z");
const NOW_MS = NOW.getTime();
const BAR = "Bar Luna";
const BAR_ID = "22222222-bbbb-4bbb-8bbb-222222222222";
const CAFE = "Cafe Otto";
const CAFE_ID = "33333333-cccc-4ccc-8ccc-333333333333";

/**
 * A live-rung crowd claim whose reports MATERIALLY DISAGREE.
 *
 * This is the case the row turns on, and it is a real one rather than a
 * contrived band: `lib/liveClaimRead` states that a material conflict means the
 * state is never 'live' and the band is capped, and `deriveWallTruthClass`
 * grades it `conflicting` — a class that may not be rendered as an observation.
 * So there IS a crowd reading, and no sentence may assert a crowd state plainly
 * on the strength of it.
 */
function conflictedCrowdClaim(): LiveClaimEnvelope {
  return {
    id: "snap-1",
    claimType: "crowd.level",
    value: "packed",
    confidence: 0.6,
    band: "likely_current",
    sourceClass: "firsthand_unverified",
    sourceCountBucket: "several",
    observedAt: new Date(NOW_MS - 5 * 60 * 1000).toISOString(),
    validUntil: new Date(NOW_MS + 40 * 60 * 1000).toISOString(),
    state: "emerging",
    conflictState: "material",
    conflict: { state: "material", sidesCount: 2, lastUpdated: new Date(NOW_MS - 5 * 60 * 1000).toISOString() },
  } as LiveClaimEnvelope;
}

const context = () =>
  liveClaimContextFrom(
    [
      { subjectId: BAR_ID, name: BAR },
      // No claim at all — the "unknown is a fact" subject.
      { subjectId: CAFE_ID, name: CAFE },
    ],
    new Map([[BAR_ID, [conflictedCrowdClaim()]]]),
    NOW_MS,
  );

/** Was this sentence published unqualified before the context reached the checker? */
function vacuousBefore(sentence: string): boolean {
  return enforceCompassGroundingEnvelope(sentence, EMPTY_GROUNDING_EVIDENCE).ok;
}

// ── PART 1: the context carries the claims ───────────────────────────────────

describe("S79 part 1 — live claims reach /compass/ask's context", () => {
  it("emits the claim, its §5.1 band, and the name the model will write", () => {
    const { lines } = context();
    assert.equal(lines[0], LIVE_CLAIM_HEADER);
    const barLine = lines.find((l) => l.includes(BAR));
    assert.ok(barLine, `no line named ${BAR}: ${JSON.stringify(lines)}`);
    assert.match(barLine!, /crowd\.level=/);
    assert.match(barLine!, /truth conflicting/);
    assert.match(barLine!, /source firsthand_unverified/);
    assert.match(barLine!, /REPORTS DIFFER/);
    assert.match(barLine!, /\[emerging\]/);
    // And it tells the model what it may not say.
    assert.match(barLine!, /Current but NOT live-verified/);
  });

  it("a subject with no evidence says so — silence would be filled from the weights", () => {
    const { lines } = context();
    const cafeLine = lines.find((l) => l.includes(CAFE));
    assert.ok(cafeLine);
    assert.match(cafeLine!, /no current evidence/);
    assert.match(cafeLine!, /do not say whether it is busy, quiet, open or closed/);
  });

  it("the band travels out of the context, per subject and by name", () => {
    const { evidence } = context();
    const bar = evidence.subjects.find((s) => s.name === BAR);
    assert.ok(bar);
    assert.equal(bar!.truthClass, "conflicting");
    assert.equal(bar!.hasCrowdDatum, true, "a crowd.level pattern IS a crowd reading");
    assert.equal(bar!.hasVerifiedLive, false, "an emerging claim is never live-qualified");
    assert.equal(bar!.hasRouteDatum, false);

    const cafe = evidence.subjects.find((s) => s.name === CAFE);
    assert.equal(cafe!.truthClass, "unknown", "looked and found nothing IS a declared class");

    // Weakest-wins at turn level.
    assert.equal(evidence.truthClass, "unknown");
  });

  it("no contributor, no coordinate and no cohort count reach the prompt", () => {
    const { lines } = context();
    const blob = lines.join("\n");
    for (const leak of ["distinct_contributors", "22", "cohort_size", "40", "lat", "lng", "zone-1"]) {
      assert.ok(!blob.includes(leak), `context leaked ${leak}`);
    }
  });

  it("an unreadable database says UNKNOWN — it never widens the band", async () => {
    // The read path swallows its own errors and returns no envelopes, which is
    // indistinguishable from "nothing is happening here" — so this module must
    // not treat an empty read as quiet. It says "no current evidence" and
    // carries `unknown`, the class that makes the checker STRICTER, not looser.
    const broken = { from() { throw new Error("db down"); } };
    const r = await buildLiveClaimContext(broken, [{ subjectId: BAR_ID, name: BAR }], { now: NOW });
    assert.match(r.lines.join("\n"), /no current evidence/);
    assert.equal(r.evidence.truthClass, "unknown");
    assert.equal(r.evidence.hasVerifiedLive, false);
    assert.equal(r.evidence.hasCrowdDatum, false);
    // And the band it produced convicts rather than excuses.
    assert.equal(enforceCompassGroundingEnvelope(`${BAR} is busy.`, r.evidence).ok, false);
  });

  it("no client and no subjects is the empty band, exactly as before this existed", async () => {
    assert.deepEqual(await buildLiveClaimContext(null, [], { now: NOW }), {
      lines: [], evidence: EMPTY_GROUNDING_EVIDENCE,
    });
    assert.deepEqual(await buildLiveClaimContext({ from: () => { throw new Error("unused"); } }, [], { now: NOW }), {
      lines: [], evidence: EMPTY_GROUNDING_EVIDENCE,
    });
    assert.deepEqual(liveClaimContextFrom([], new Map(), NOW_MS), EMPTY_LIVE_CLAIM_CONTEXT);
  });
});

// ── PART 2: the checker REFUSES ──────────────────────────────────────────────

describe("S79 part 2 — the checker refuses language stronger than its inputs", () => {
  it("REFUSES a flat state claim over a PREDICTED pattern — and this used to publish", () => {
    const { evidence } = context();
    const answer = `${BAR} is packed.`;

    // The sentence the old path published: no now-marker, no progressive crowd
    // phrase, no wait figure, no duration — and with an empty context there was
    // no truth class to judge it against, so nothing fired.
    assert.equal(vacuousBefore(answer), true, "precondition: the old checker published this");

    const r = enforceCompassGroundingEnvelope(answer, evidence);
    assert.equal(r.ok, false, "the checker must refuse it now");
    assert.deepEqual(r.violations.map((v) => v.kind), ["truth_class_not_qualified"]);
    assert.equal(r.violations[0].available, "truth class conflicting");
    assert.match(r.correction ?? "", /not an observation/);
    // Nothing the model wrote is deleted; the correction is appended.
    assert.ok(r.text.startsWith(answer));
  });

  it("REFUSES a state asserted about a subject the context knows NOTHING about", () => {
    const { evidence } = context();
    const answer = `${CAFE} is quiet.`;
    assert.equal(vacuousBefore(answer), true, "precondition: the old checker published this");

    const r = enforceCompassGroundingEnvelope(answer, evidence);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.kind), ["truth_class_not_qualified"]);
    assert.equal(r.violations[0].available, "truth class unknown");
  });

  it("the spec's own example still cannot be said, and now for the accurate reason", () => {
    const { evidence } = context();
    // "everyone is dancing" over a conflicted crowd reading. There WAS a crowd
    // reading, so the crowd trigger correctly stands down — and the truth-class
    // trigger takes over, because the reading was a prediction.
    const r = enforceCompassGroundingEnvelope(`At ${BAR}, everyone is dancing right now.`, evidence);
    assert.equal(r.ok, false);
    const kinds = r.violations.map((v) => v.kind);
    assert.ok(kinds.includes("truth_class_not_qualified"), JSON.stringify(kinds));
    assert.equal(kinds.includes("crowd_claim_without_observation"), false,
      "a reading existed; convicting on absence would be the wrong reason");
  });

  it("a low-confidence pattern cannot become a verified-live sentence", () => {
    const { evidence } = context();
    const r = enforceCompassGroundingEnvelope(`${BAR} is busy right now.`, evidence);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === "live_claim_without_verified_source"));
  });
});

// ── PART 3: it does not over-fire, and the fold only tightens ────────────────

describe("S79 part 3 — the checker still permits honest prose", () => {
  it("a correctly hedged sentence over the same evidence passes", () => {
    const { evidence } = context();
    for (const ok of [
      `${BAR} is typically packed at this hour.`,
      `${BAR} is usually busy, though that is a historical pattern rather than a live reading.`,
      `${BAR} is packed, based on past weeks.`,
    ]) {
      assert.equal(enforceCompassGroundingEnvelope(ok, evidence).ok, true, ok);
    }
  });

  it("a sentence that asserts no state is untouched", () => {
    const { evidence } = context();
    const r = enforceCompassGroundingEnvelope(`${BAR} is a cocktail bar in the old town.`, evidence);
    assert.equal(r.ok, true);
    assert.equal(r.text, `${BAR} is a cocktail bar in the old town.`);
  });
});

describe("S79 — the fold is fail-weak: context can only tighten the checker", () => {
  const toolSide: GroundingEvidence = {
    hasVerifiedLive: true,
    hasWaitDatum: false,
    hasCrowdDatum: true,
    hasRouteDatum: false,
    sourceClasses: ["verified_live"],
    truthClass: "observed",
    subjects: [{
      subjectId: BAR_ID, name: BAR,
      hasVerifiedLive: true, hasWaitDatum: false, hasCrowdDatum: true, hasRouteDatum: false,
      truthClass: "observed",
    }],
  };

  it("the WEAKEST truth class governs when the two halves disagree", () => {
    const { evidence } = context();
    const merged = mergeGroundingEvidence(toolSide, evidence);
    assert.equal(merged.truthClass, "unknown");
    const bar = merged.subjects.find((s) => s.name === BAR);
    assert.equal(bar!.truthClass, "conflicting", "observed + conflicting is a conflicting subject");
    assert.equal(bar!.hasVerifiedLive, false, "one half's contradiction is a veto");
    // And the merged band convicts where the tool-only band would have passed.
    assert.equal(enforceCompassGroundingEnvelope(`${BAR} is packed.`, toolSide).ok, true);
    assert.equal(enforceCompassGroundingEnvelope(`${BAR} is packed.`, merged).ok, false);
  });

  it("merging the empty band changes nothing", () => {
    const merged = mergeGroundingEvidence(toolSide, EMPTY_GROUNDING_EVIDENCE);
    assert.equal(merged.truthClass, toolSide.truthClass);
    assert.equal(merged.hasVerifiedLive, true);
    assert.deepEqual(merged.subjects.map((s) => s.name), [BAR]);
  });

  it("subjects merge by name rather than splitting into two half-evidenced ones", () => {
    const { evidence } = context();
    const merged = mergeGroundingEvidence(toolSide, evidence);
    assert.equal(merged.subjects.filter((s) => s.name === BAR).length, 1);
    assert.equal(merged.subjects.length, 2, "Bar Luna merged, Cafe Otto carried through");
  });
});
