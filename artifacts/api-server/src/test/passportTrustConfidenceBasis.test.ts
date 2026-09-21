/**
 * census-trust P45 / P50 — a measured trust score must be distinguishable from
 * the substituted neutral 50.
 *
 * THE DEFECT. `buildTrust` derives `confidence` from TRAVEL statistics —
 * `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)` — and the comment above
 * it calls that "evidence-aware (§9/§10)". It is aware of evidence about
 * travel, not about trust. A traveller with twenty stamps and ZERO trust events
 * reads `confidence: "high"` over a trust number that is entirely the neutral
 * 50 `buildDomainTrust` substitutes for every absent category. P50 states the
 * requirement as "an 82 with high evidence is not an 82 with little"; nothing in
 * the response could tell the two apart.
 *
 * Migration 2371 added the trust engine's OWN measure — `evidence_weight` (sum
 * of decay weights) and `evidence_count` (raw undecayed count), both written by
 * `measureEvidence` — and this projection read neither.
 *
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT. `confidence` itself is
 * unchanged: recalibrating that scale against trust evidence is a product
 * judgement about how a person is labelled, not a defect fix, and this file
 * asserts the existing value is untouched so a later recalibration is a
 * deliberate diff rather than a side effect. What is pinned is that the
 * response now SAYS what the number rests on.
 *
 * IT TESTS THE SHIPPED PREDICATE, NOT A COPY OF IT. `trustConfidenceBasis` is
 * imported from the service and called directly. An earlier draft of this file
 * carried a local `basisOf` that reimplemented the same three branches — the
 * fixture-pinning-a-fiction shape this codebase has repaired repeatedly: it
 * would have gone on passing with the field deleted from the response. The
 * second describe block closes the remaining gap, running the whole projection
 * so the value is asserted where a consumer actually reads it.
 *
 * Run: node --import tsx/esm --test src/test/passportTrustConfidenceBasis.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPassportProjection,
  trustConfidenceBasis,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";

describe("P45/P50 — trustConfidenceBasis maps a read to what the number rests on", () => {
  it("an UNREADABLE trust_profiles reports 'unavailable', never a trust claim", () => {
    // The failure is already flagged by `degraded`; the basis says the same
    // thing about the confidence number specifically, so a consumer holding
    // only the confidence value is not misled by it. Evidence arguments are
    // irrelevant on this branch and are passed non-null to prove it.
    assert.equal(trustConfidenceBasis("unavailable", 9.5, 40), "unavailable");
  });

  it("a profile carrying 2371 evidence reports 'trust_evidence'", () => {
    assert.equal(trustConfidenceBasis("ok", 3.25, 7), "trust_evidence");
    // Weight alone is enough — a decayed-to-nothing history is still a history.
    assert.equal(trustConfidenceBasis("ok", 0.004, null), "trust_evidence");
    // Count alone is enough — a pre-decay row still evidences events.
    assert.equal(trustConfidenceBasis("ok", null, 2), "trust_evidence");
  });

  it("THE DEFECT CASE: no trust evidence reports 'travel_proxy', however high confidence reads", () => {
    // A pre-2371 row, or a profile whose columns were never written.
    assert.equal(trustConfidenceBasis("ok", null, null), "travel_proxy");
    // `undefined` is the shape TrustScoreResult actually uses for an unselected
    // column, and it must not be mistaken for a measurement.
    assert.equal(trustConfidenceBasis("ok", undefined, undefined), "travel_proxy");
    // And an ABSENT profile — the 56-of-58 production case census-trust §3
    // measured, where the constant reaches the user because the emitters are
    // silent, not because the engine is off.
    assert.equal(trustConfidenceBasis("absent", null, null), "travel_proxy");
  });

  it("evidence 0 is 'trust_evidence', not 'travel_proxy' — measured-nothing is not not-measured", () => {
    // The distinction migration 2371's own comment draws, and the one this
    // whole field exists to preserve: a profile that was read and holds zero
    // evidence HAS been measured. Collapsing it into the proxy bucket would
    // reintroduce the exact conflation.
    assert.equal(trustConfidenceBasis("ok", 0, 0), "trust_evidence");
  });
});

// ── The wiring, not the predicate ───────────────────────────────────────────
// A correct predicate nobody calls closes nothing. These run the real
// projection over the real service, so the assertions fail if the field is
// dropped from either return statement, if the evidence columns stop being
// read off the profile, or if the predicate is called with the wrong arguments.

function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}
function permsSelf(): ViewerPermissions {
  return { ...permsPublic(), relationshipLabel: "self", canViewFullProfile: true, canSeeAvailability: true, canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true, canSeeFriendOnlyPosts: true, canFollow: false };
}

/** Enough of a passport for the projection to build; trust is the subject. */
function db(trustRow: Record<string, any> | null, failTrustRead = false) {
  return makePassportDb(
    {
      profiles: [{
        id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
        verified: true, is_official: false, is_private: false,
        passport_visibility: "public", show_profile_picture_publicly: true,
        created_at: "2023-01-01",
      }],
      trust_profiles: trustRow ? [trustRow] : [],
    },
    failTrustRead ? { failReads: { trust_profiles: { code: "57014", message: "canceling statement due to statement timeout" } } } : {},
  );
}

const SELF: ViewerResolution = { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const PUBLIC: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const resolver = (r: ViewerResolution) => async () => r;

const scored = (extra: Record<string, any>) => ({
  user_id: OWNER, overall_score: 82, public_level: "highly_trusted",
  plan_attendance: 88, host_quality: 55, communication: 70, respect_safety: 90,
  location_honesty: 84, content_quality: 92, community_value: 90,
  guide_accuracy: 88, passport_authenticity: 80, ...extra,
});

describe("P45/P50 — the basis reaches the response on every trust path", () => {
  it("self view: a measured 82 carries basis 'trust_evidence' and its 2371 numbers", async () => {
    const p = (await buildPassportProjection(db(scored({ evidence_weight: 6.5, evidence_count: 14 })), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust?.confidenceBasis, "trust_evidence");
    assert.equal(p.trust?.evidenceWeight, 6.5);
    assert.equal(p.trust?.evidenceCount, 14);
  });

  it("public view: the SAME 82 with no 2371 evidence is distinguishable — basis 'travel_proxy'", async () => {
    // P50 in one assertion. Both users read score 82 / the same public level;
    // only `confidenceBasis` separates the measured one from the substituted
    // one. The public branch is a SEPARATE return statement in buildTrust, so
    // this also fails if only the self branch was wired.
    const p = (await buildPassportProjection(db(scored({})), OWNER, null, { resolveViewerContext: resolver(PUBLIC) }))!;
    assert.equal(p.trust?.confidenceBasis, "travel_proxy");
    assert.equal(p.trust?.evidenceWeight, null);
    assert.equal(p.trust?.evidenceCount, null);
  });

  it("an ABSENT profile — the neutral-50 substitution — reports 'travel_proxy', not silence", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust?.confidenceBasis, "travel_proxy");
    // Every applicable domain reads the word presentationWord(50) produces, so
    // the whole card is the substitution and nothing in it says so. That is
    // exactly the P45 finding, and `confidenceBasis` is now the one field that
    // distinguishes this card from a measured one that happens to score 50.
    const applicable = p.trust!.domains.filter((d) => d.applicable);
    assert.equal(applicable.length, 5);
    assert.ok(applicable.every((d) => d.presentation === "Established"),
      `all applicable domains are the neutral substitution, got ${applicable.map((d) => d.presentation).join(",")}`);
  });

  it("an UNREADABLE trust_profiles reports 'unavailable' AND degraded, and no evidence numbers", async () => {
    const p = (await buildPassportProjection(db(scored({ evidence_weight: 6.5, evidence_count: 14 }), true), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust?.confidenceBasis, "unavailable");
    assert.equal(p.trust?.degraded, true);
    // The staged row HAS evidence; the read failed, so the response must not
    // report it. A basis of 'unavailable' beside a weight of 6.5 would be the
    // fabricated fact this whole three-state read exists to prevent.
    assert.equal(p.trust?.evidenceWeight, null);
    assert.equal(p.trust?.evidenceCount, null);
  });
});
