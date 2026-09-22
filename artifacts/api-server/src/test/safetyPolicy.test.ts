/**
 * safetyPolicy.test.ts
 *
 * Certifies the publication policy for safety assertions.
 *
 * BACKGROUND. `unsafe_density` has been in the crowd vocabulary since
 * intelContracts was written, carved out as SPECIALIST_ONLY_CROWD_LEVELS —
 * "a safety claim, not a vibe: specialist review only" — and the Map's
 * safetyNoticeProducer has always read exactly that value. But the specialist
 * never existed. The only enforcement was a client-side refusal in quickSignal's
 * validator, and no server path could produce the value. The layer was built,
 * mounted, reachable from eight surfaces, and structurally incapable of showing
 * anything. This module is the missing half.
 *
 * These tests are the invariants, not examples. Each one is a property the
 * product contract states, expressed so it fails if the property stops holding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSafetyPublication,
  isSafetyAssertion,
  isSafetyClaimType,
  isSafetyServableStatus,
  authorityLaneAvailable,
  SAFETY_REVIEWED_THRESHOLD,
  SAFETY_COMMUNITY_THRESHOLD,
  SAFETY_CLAIM_VALUES,
  type SafetyPublicationInput,
} from "../lib/safetyPolicy.js";
import { PRIVACY_THRESHOLD_V1 } from "../lib/intelContracts.js";
import { SPECIALIST_ONLY_CROWD_LEVELS, CROWD_LEVELS } from "../lib/intelContracts.js";

const PLACE = "11111111-1111-4111-8111-111111111111";

const base = (over: Partial<SafetyPublicationInput> = {}): SafetyPublicationInput => ({
  claimType: "crowd.level",
  value: { level: "unsafe_density" },
  status: "active",
  authority: "admin_review",
  subjectPlaceId: PLACE,
  distinctActors: 1,
  ...over,
});

// ── INVARIANT 1: CROWDED IS NOT UNSAFE ───────────────────────────────────────

describe("CROWDED != UNSAFE", () => {
  it("no ordinary crowd level is a safety assertion, however high", () => {
    const ordinary = CROWD_LEVELS.filter((l) => !SPECIALIST_ONLY_CROWD_LEVELS.includes(l));
    assert.ok(ordinary.length >= 4, "sanity: the ordinary vocabulary is non-trivial");
    for (const level of ordinary) {
      assert.equal(
        isSafetyAssertion("crowd.level", { level }), false,
        `'${level}' must never be a safety assertion. It describes a room; it does not ` +
        `claim anyone is in danger. Promoting a high number into a hazard is the exact ` +
        `substitution this whole module exists to prevent.`,
      );
    }
  });

  it("an ordinary crowd level cannot be published as safety no matter its authority", () => {
    for (const level of ["busy", "packed"]) {
      const d = evaluateSafetyPublication(base({ value: { level }, authority: "admin_review" }));
      assert.equal(d.publishable, false);
      assert.equal((d as any).reason, "not_a_safety_assertion",
        "even an admin cannot turn 'packed' into a hazard warning");
    }
  });

  it("the safety values track intelContracts and are not re-declared", () => {
    assert.deepEqual(
      [...SAFETY_CLAIM_VALUES], [...SPECIALIST_ONLY_CROWD_LEVELS],
      "re-declaring the vocabulary would let the two drift, and a drift here means either a " +
      "safety value that is silently ordinary, or an ordinary value silently treated as safety",
    );
  });

  it("a non-safety claim type is never a safety assertion", () => {
    assert.equal(isSafetyClaimType("vibe.state"), false);
    assert.equal(isSafetyClaimType("queue.wait"), false);
    assert.equal(isSafetyAssertion("vibe.state", { level: "unsafe_density" }), false,
      "the LEVEL alone does not make it safety — the claim type must be one that carries safety");
  });
});

// ── INVARIANT 2: AI IS NEVER AUTHORITATIVE ───────────────────────────────────

describe("AI is never authoritative safety truth", () => {
  it("refuses ai_classification explicitly, even for a valid assertion", () => {
    const d = evaluateSafetyPublication(base({ authority: "ai_classification" }));
    assert.equal(d.publishable, false);
    assert.equal((d as any).reason, "ai_is_never_authoritative",
      "a model may cluster, triage or suggest; it may never be the reason a warning appears");
  });
});

// ── INVARIANT 3: A STRING IS NOT AUTHORITY ───────────────────────────────────

describe("authenticated authority lane", () => {
  it("is CLOSED, because nothing in the repo can authenticate a source", () => {
    assert.equal(
      authorityLaneAvailable(), false,
      "official_signed has no writer, disclosureSourceClass yields only " +
      "sponsored|firsthand_unverified, and public.sources is place-origin provenance. " +
      "Opening this lane without a credential primitive would make the string itself the credential.",
    );
  });

  it("refuses a claim asserting official provenance while the lane is closed", () => {
    const d = evaluateSafetyPublication(base({ authority: "authenticated_official" }));
    assert.equal(d.publishable, false);
    assert.equal((d as any).reason, "authority_lane_unavailable",
      "and the refusal reason must say WHY — 'unauthenticated' is not 'no hazard'");
  });
});

// ── INVARIANT 4: REVIEW IS THE LANE THAT WORKS ───────────────────────────────

describe("admin review", () => {
  it("publishes a valid place-anchored assertion", () => {
    const d = evaluateSafetyPublication(base());
    assert.equal(d.publishable, true);
    assert.equal((d as any).authority, "admin_review");
  });

  it("uses a threshold that does not demand a crowd cohort", () => {
    assert.equal(SAFETY_REVIEWED_THRESHOLD.minUniqueActors, 1,
      "the reviewer IS the actor; requiring 15 strangers to corroborate an evacuation " +
      "would be a privacy control doing safety harm");
    assert.equal(SAFETY_REVIEWED_THRESHOLD.publicationDelayMinutes, 0,
      "a delay on a hazard warning is a defect, not a safeguard");
  });

  it("still refuses an unreviewed claim with no authority at all", () => {
    const d = evaluateSafetyPublication(base({ authority: null }));
    assert.equal(d.publishable, false);
    assert.equal((d as any).reason, "no_authority");
  });
});

// ── INVARIANT 5: SEVERITY BUYS NO SHORTCUT ───────────────────────────────────

describe("community corroboration", () => {
  it("is never weaker than the ordinary intel threshold", () => {
    assert.ok(
      SAFETY_COMMUNITY_THRESHOLD.minUniqueActors >= PRIVACY_THRESHOLD_V1.minUniqueActors &&
      SAFETY_COMMUNITY_THRESHOLD.minIndependentGroups >= PRIVACY_THRESHOLD_V1.minIndependentGroups &&
      SAFETY_COMMUNITY_THRESHOLD.maxSingleGroupShare <= PRIVACY_THRESHOLD_V1.maxSingleGroupShare,
      "claiming danger must not buy a shortcut past the bar a claim about a queue has to clear",
    );
  });

  it("refuses a single ordinary report", () => {
    const d = evaluateSafetyPublication(base({
      authority: "community_corroboration", distinctActors: 1, distinctGroups: 1, maxGroupShare: 1,
    }));
    assert.equal(d.publishable, false);
    assert.equal((d as any).reason, "below_community_threshold",
      "one report is evidence, not an assertion");
  });

  it("refuses many reports that are not independent", () => {
    // Twenty people, but one group — the copied-from-one-social-post shape.
    const d = evaluateSafetyPublication(base({
      authority: "community_corroboration", distinctActors: 20, distinctGroups: 1, maxGroupShare: 1,
    }));
    assert.equal(d.publishable, false,
      "ten reports derived from one source are not ten confirmations");
  });

  it("accepts genuinely independent corroboration", () => {
    const d = evaluateSafetyPublication(base({
      authority: "community_corroboration", distinctActors: 20, distinctGroups: 8, maxGroupShare: 0.15,
    }));
    assert.equal(d.publishable, true);
  });
});

// ── INVARIANT 6: LIFECYCLE AND ANCHORING ─────────────────────────────────────

describe("lifecycle and anchoring", () => {
  for (const status of ["candidate", "rejected", "retracted", "expired", "superseded"]) {
    it(`refuses to publish a '${status}' claim`, () => {
      const d = evaluateSafetyPublication(base({ status }));
      assert.equal(d.publishable, false);
      assert.equal((d as any).reason, "not_servable_status");
    });
  }

  it("refuses 'conflicting', UNLIKE ordinary intel which serves it at a lowered band", () => {
    assert.equal(isSafetyServableStatus("conflicting"), false,
      "a disagreement about how busy a bar is degrades gracefully; a disagreement about " +
      "whether people are in danger does not. 'Some say dangerous, others disagree' is not a warning.");
  });

  it("refuses an assertion with no honest canonical place", () => {
    const d = evaluateSafetyPublication(base({ subjectPlaceId: null }));
    assert.equal(d.publishable, false);
    assert.equal((d as any).reason, "no_canonical_place",
      "v1 is place-anchored. A hazard that cannot be honestly anchored stays evidence — " +
      "it is never coerced onto a nearby venue just to make it drawable.");
  });
});

// ── INVARIANT 7: A REFUSAL IS NOT AN ABSENCE ─────────────────────────────────

describe("refusal reasons are distinguishable", () => {
  it("every refusal names its own cause", () => {
    const seen = new Set<string>();
    for (const input of [
      base({ value: { level: "busy" } }),
      base({ status: "candidate" }),
      base({ subjectPlaceId: null }),
      base({ authority: null }),
      base({ authority: "ai_classification" }),
      base({ authority: "authenticated_official" }),
      base({ authority: "community_corroboration", distinctActors: 1 }),
    ]) {
      const d = evaluateSafetyPublication(input);
      assert.equal(d.publishable, false);
      seen.add((d as any).reason);
    }
    assert.equal(
      seen.size, 7,
      `expected seven distinct refusal reasons, got ${seen.size}: ${[...seen].join(", ")}. ` +
      `A caller that cannot tell "no hazard here" from "could not establish authority" will ` +
      `eventually render the second as the first, and that substitution is the danger.`,
    );
  });
});
