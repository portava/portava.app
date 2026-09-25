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
 *   PART 1  the context really carries the claims, read through
 *           `lib/liveClaimRead.resolvePlaceIntelState` and graded through
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
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveClaimContext,
  LIVE_CLAIM_HEADER,
} from "../compass/CompassLiveClaimContext.js";
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
 * A Supabase stand-in. Every flag read fails, so the LIVE rung is refused and
 * `resolvePlaceIntelState` degrades to the TYPICAL rung — which is exactly the
 * interesting case: a real, current, k-gated historical pattern that must never
 * be spoken as an observation.
 */
function stubClient(patternsBySubject: Record<string, unknown[]>) {
  const chain = (resolve: () => { data: unknown; error: unknown }) => {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "gt", "gte", "lt", "order", "limit", "is", "neq"]) {
      self[m] = () => self;
    }
    self.maybeSingle = async () => resolve();
    self.single = async () => resolve();
    self.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onOk, onErr);
    return self;
  };

  return {
    from(table: string) {
      if (table !== "intel_historical_patterns") {
        // Flags, promoted scopes, snapshots: all unreadable ⇒ fail closed.
        return chain(() => ({ data: null, error: { message: "unavailable in this test" } }));
      }
      let subject: string | null = null;
      const self: Record<string, unknown> = {};
      for (const m of ["select", "in", "gt", "gte", "order", "limit"]) self[m] = () => self;
      self.eq = (col: string, val: unknown) => {
        if (col === "subject_id") subject = String(val);
        return self;
      };
      const resolve = () => ({ data: patternsBySubject[subject ?? ""] ?? [], error: null });
      self.maybeSingle = async () => resolve();
      self.single = async () => resolve();
      self.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(onOk, onErr);
      return self;
    },
  };
}

/** One k-cleared typical crowd pattern for the current weekday/hour. */
function crowdPattern(id: string, value: unknown) {
  return {
    id,
    zone_id: "zone-1",
    claim_family: "crowd.level",
    pattern_kind: "typical_crowd_by_weekday_hour",
    time_band: `hour_${String(NOW.getUTCHours()).padStart(2, "0")}`,
    dow: NOW.getUTCDay(),
    value_json: value,
    confidence: 0.7,
    cohort_size: 40,
    // Above PRIVACY_THRESHOLD_V1.minUniqueActors (15) so the rung serves at all.
    distinct_contributors: 22,
    window_days: 30,
    is_invalidation: false,
    computed_at: new Date(NOW_MS - 60 * 60 * 1000).toISOString(),
  };
}

const context = () =>
  buildLiveClaimContext(
    stubClient({ [BAR_ID]: [crowdPattern("pat-1", "packed")] }),
    [
      { subjectId: BAR_ID, name: BAR },
      // No pattern at all — the "unknown is a fact" subject.
      { subjectId: CAFE_ID, name: CAFE },
    ],
    { now: NOW },
  );

/** Was this sentence published unqualified before the context reached the checker? */
function vacuousBefore(sentence: string): boolean {
  return enforceCompassGroundingEnvelope(sentence, EMPTY_GROUNDING_EVIDENCE).ok;
}

// ── PART 1: the context carries the claims ───────────────────────────────────

describe("S79 part 1 — live claims reach /compass/ask's context", () => {
  it("emits the claim, its §5.1 band, and the name the model will write", async () => {
    const { lines } = await context();
    assert.equal(lines[0], LIVE_CLAIM_HEADER);
    const barLine = lines.find((l) => l.includes(BAR));
    assert.ok(barLine, `no line named ${BAR}: ${JSON.stringify(lines)}`);
    assert.match(barLine!, /crowd\.level=/);
    assert.match(barLine!, /truth predicted/);
    assert.match(barLine!, /source historical_pattern/);
    assert.match(barLine!, /\[typical\]/);
    // And it tells the model what it may not say.
    assert.match(barLine!, /TYPICAL pattern, not an observation/);
  });

  it("a subject with no evidence says so — silence would be filled from the weights", async () => {
    const { lines } = await context();
    const cafeLine = lines.find((l) => l.includes(CAFE));
    assert.ok(cafeLine);
    assert.match(cafeLine!, /no current evidence/);
    assert.match(cafeLine!, /do not say whether it is busy, quiet, open or closed/);
  });

  it("the band travels out of the context, per subject and by name", async () => {
    const { evidence } = await context();
    const bar = evidence.subjects.find((s) => s.name === BAR);
    assert.ok(bar);
    assert.equal(bar!.truthClass, "predicted");
    assert.equal(bar!.hasCrowdDatum, true, "a crowd.level pattern IS a crowd reading");
    assert.equal(bar!.hasVerifiedLive, false, "a typical pattern is never live-qualified");
    assert.equal(bar!.hasRouteDatum, false);

    const cafe = evidence.subjects.find((s) => s.name === CAFE);
    assert.equal(cafe!.truthClass, "unknown", "looked and found nothing IS a declared class");

    // Weakest-wins at turn level.
    assert.equal(evidence.truthClass, "unknown");
  });

  it("no contributor, no coordinate and no cohort count reach the prompt", async () => {
    const { lines } = await context();
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
    assert.deepEqual(await buildLiveClaimContext(stubClient({}), [], { now: NOW }), {
      lines: [], evidence: EMPTY_GROUNDING_EVIDENCE,
    });
  });
});

// ── PART 2: the checker REFUSES ──────────────────────────────────────────────

describe("S79 part 2 — the checker refuses language stronger than its inputs", () => {
  it("REFUSES a flat state claim over a PREDICTED pattern — and this used to publish", async () => {
    const { evidence } = await context();
    const answer = `${BAR} is packed.`;

    // The sentence the old path published: no now-marker, no progressive crowd
    // phrase, no wait figure, no duration — and with an empty context there was
    // no truth class to judge it against, so nothing fired.
    assert.equal(vacuousBefore(answer), true, "precondition: the old checker published this");

    const r = enforceCompassGroundingEnvelope(answer, evidence);
    assert.equal(r.ok, false, "the checker must refuse it now");
    assert.deepEqual(r.violations.map((v) => v.kind), ["truth_class_not_qualified"]);
    assert.equal(r.violations[0].available, "truth class predicted");
    assert.match(r.correction ?? "", /not an observation/);
    // Nothing the model wrote is deleted; the correction is appended.
    assert.ok(r.text.startsWith(answer));
  });

  it("REFUSES a state asserted about a subject the context knows NOTHING about", async () => {
    const { evidence } = await context();
    const answer = `${CAFE} is quiet.`;
    assert.equal(vacuousBefore(answer), true, "precondition: the old checker published this");

    const r = enforceCompassGroundingEnvelope(answer, evidence);
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.kind), ["truth_class_not_qualified"]);
    assert.equal(r.violations[0].available, "truth class unknown");
  });

  it("the spec's own example still cannot be said, and now for the accurate reason", async () => {
    const { evidence } = await context();
    // "everyone is dancing" over a typical crowd pattern. There WAS a crowd
    // reading, so the crowd trigger correctly stands down — and the truth-class
    // trigger takes over, because the reading was a prediction.
    const r = enforceCompassGroundingEnvelope(`At ${BAR}, everyone is dancing right now.`, evidence);
    assert.equal(r.ok, false);
    const kinds = r.violations.map((v) => v.kind);
    assert.ok(kinds.includes("truth_class_not_qualified"), JSON.stringify(kinds));
    assert.equal(kinds.includes("crowd_claim_without_observation"), false,
      "a reading existed; convicting on absence would be the wrong reason");
  });

  it("a low-confidence pattern cannot become a verified-live sentence", async () => {
    const { evidence } = await context();
    const r = enforceCompassGroundingEnvelope(`${BAR} is busy right now.`, evidence);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === "live_claim_without_verified_source"));
  });
});

// ── PART 3: it does not over-fire, and the fold only tightens ────────────────

describe("S79 part 3 — the checker still permits honest prose", () => {
  it("a correctly hedged sentence over the same evidence passes", async () => {
    const { evidence } = await context();
    for (const ok of [
      `${BAR} is typically packed at this hour.`,
      `${BAR} is usually busy, though that is a historical pattern rather than a live reading.`,
      `${BAR} is packed, based on past weeks.`,
    ]) {
      assert.equal(enforceCompassGroundingEnvelope(ok, evidence).ok, true, ok);
    }
  });

  it("a sentence that asserts no state is untouched", async () => {
    const { evidence } = await context();
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

  it("the WEAKEST truth class governs when the two halves disagree", async () => {
    const { evidence } = await context();
    const merged = mergeGroundingEvidence(toolSide, evidence);
    assert.equal(merged.truthClass, "unknown");
    const bar = merged.subjects.find((s) => s.name === BAR);
    assert.equal(bar!.truthClass, "predicted", "observed + predicted is a predicted subject");
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

  it("subjects merge by name rather than splitting into two half-evidenced ones", async () => {
    const { evidence } = await context();
    const merged = mergeGroundingEvidence(toolSide, evidence);
    assert.equal(merged.subjects.filter((s) => s.name === BAR).length, 1);
    assert.equal(merged.subjects.length, 2, "Bar Luna merged, Cafe Otto carried through");
  });
});
