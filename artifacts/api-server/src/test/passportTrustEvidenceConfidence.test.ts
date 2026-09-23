/**
 * census-passport P50 / P154 — "an 82 with high evidence is not equivalent to
 * an 82 with little evidence", and the fabricated central NUMBER P154 names.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * `PassportProjectionService.buildTrust` computed
 *
 *     const evidence = stats.stamps + stats.trips * 2 + (verified ? 3 : 0);
 *     const confidence = evidence >= 12 ? "high" : evidence >= 4 ? "medium" : "low";
 *
 * A weighted sum invented in a projection service, over TRAVEL volume, published
 * as a statement about TRUST. Nothing ratified 2, 3, 12 or 4. No trust event,
 * cap or score reached it. A traveller with twenty stamps and zero trust events
 * read `confidence: "high"` over a trust score that was entirely the
 * substituted neutral 50 — and, worse, `confidence === "low"` then OVERRODE the
 * measured public level, so a `trusted_traveler` with few stamps was published
 * to the world as "New Traveler".
 *
 * ── WHAT THIS PINS ──────────────────────────────────────────────────────────
 *  1. The band comes from the trust engine's OWN measure
 *     (`trust_profiles.evidence_weight`, written by `measureEvidence`) and from
 *     nothing else — travel volume cannot move it in either direction.
 *  2. Absence never becomes a band. Unreadable, absent and pre-2371 profiles
 *     produce `confidence: null`, the distinct "not measured" state, never a
 *     word.
 *  3. The only numeric threshold in the derivation is the trust engine's own
 *     `EARN_CONFIDENCE_WEIGHT`, and the DRIFT GUARD below reads
 *     `TrustScoreService.ts` and fails if the mirrored constant ever disagrees
 *     with it. A mirror with a guard is not a second scoring system.
 *  4. The measured verdict now wins over the substituted one on the label.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No band WORD changed, and no band word was invented. `presentationWord`'s
 * five words and the "New Traveler" copy are untouched by THIS pass. The
 * owner's standing `D-WORD` decision (may a substituted neutral 50 keep the
 * word "Established") was not taken here — it was taken separately on
 * 2026-09-22, and §5 below now asserts the decision rather than its absence.
 * None of the five rating words was removed or renamed; a substituted domain
 * simply stops being given one.
 *
 * ── MUTATIONS (census P24: every green claim names the change that reddens it)
 *   M1  restore `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)` as the
 *       band                                   → §1, §2 and §4 go red
 *   M2  `if (state !== "ok") return null;` → `return "low";`
 *                                            → §2 "unreadable" and "absent" red
 *   M3  `if (evidenceWeight == null) return null;` → `const w = Number(evidenceWeight ?? 0)`
 *                                            → §2 "pre-2371" red
 *   M4  `TRUST_EARN_CONFIDENCE_WEIGHT = 5` → `= 1`  → §3 (drift guard) red
 *   M5  `w >= TRUST_EARN_CONFIDENCE_WEIGHT` → `w > 0`   → §1 "partial" red
 *   M6  public label back to `confidence === "low" ? … : badge.label`
 *                                            → §4 red
 *
 * Run: node --import tsx/esm --test src/test/passportTrustEvidenceConfidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildPassportProjection,
  passportTrustConfidence,
  TRUST_EARN_CONFIDENCE_WEIGHT,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";

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
  return {
    ...permsPublic(), relationshipLabel: "self", canViewFullProfile: true,
    canSeeAvailability: true, canSeeTrips: true, canSeeMutuals: true,
    canSeeLocationContext: true, canSeeFriendOnlyPosts: true, canFollow: false,
  };
}
const SELF: ViewerResolution = { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const PUBLIC: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const resolver = (r: ViewerResolution) => async () => r;

/**
 * `stamps` and `trips` are the OLD formula's only inputs. Every fixture below
 * that varies them holds the trust row constant, so a band that moves with them
 * is a band that is still being fabricated.
 */
function db(
  trustRow: Record<string, any> | null,
  opts: { failTrustRead?: boolean; stamps?: number; trips?: number } = {},
) {
  const stamps = Array.from({ length: opts.stamps ?? 0 }, (_, i) => ({
    id: `st-${i}`, user_id: OWNER, city: `City${i}`, country: "PT",
    earned_at: "2024-05-05", is_revoked: false, verification_status: "verified",
  }));
  const trips = Array.from({ length: opts.trips ?? 0 }, (_, i) => ({
    id: `tr-${i}`, user_id: OWNER, status: "completed",
  }));
  return makePassportDb(
    {
      profiles: [{
        id: OWNER, handle: "wanderer", display_name: "Wanderer", name: "Wanderer",
        verified: true, is_official: false, is_private: false,
        passport_visibility: "public", show_profile_picture_publicly: true,
        created_at: "2023-01-01",
      }],
      trust_profiles: trustRow ? [trustRow] : [],
      user_stamps: stamps,
      trips,
    },
    opts.failTrustRead ? { failReads: { trust_profiles: { code: "57014", message: "timeout" } } } : {},
  );
}

/** A measured profile. `evidence_weight` is varied per case; the rest is fixed. */
const scored = (evidenceWeight: number | null, level = "trusted_traveler") => ({
  user_id: OWNER, overall_score: 82, public_level: level,
  plan_attendance: 88, host_quality: 55, communication: 70, respect_safety: 90,
  location_honesty: 84, content_quality: 92, community_value: 90,
  guide_accuracy: 88, passport_authenticity: 80,
  ...(evidenceWeight === null ? {} : { evidence_weight: evidenceWeight, evidence_count: Math.ceil(evidenceWeight) }),
});

// ── §1 — the band is the trust engine's ramp, read at its own three points ────

describe("P50 §1 — the band comes from the trust engine's own evidence measure", () => {
  it("a COMPLETE ramp (weight ≥ the engine's full-credit weight) is 'high'", () => {
    assert.equal(passportTrustConfidence("ok", TRUST_EARN_CONFIDENCE_WEIGHT), "high");
    assert.equal(passportTrustConfidence("ok", TRUST_EARN_CONFIDENCE_WEIGHT + 40), "high");
  });

  it("a PARTIAL ramp is 'medium' — some decayed evidence, not yet full credit", () => {
    // M5: `w >= TRUST_EARN_CONFIDENCE_WEIGHT` → `w > 0` collapses this onto "high".
    assert.equal(passportTrustConfidence("ok", TRUST_EARN_CONFIDENCE_WEIGHT - 0.01), "medium");
    assert.equal(passportTrustConfidence("ok", 0.4), "medium");
  });

  it("MEASURED AND EMPTY is 'low' — a measurement, not an absence", () => {
    // The trust engine writes evidence_count = 0 for a user it has measured and
    // found no events for. That is a different answer from "never measured",
    // and collapsing the two is the conflation the whole row is about.
    assert.equal(passportTrustConfidence("ok", 0), "low");
  });

  it("a CORRUPT weight is not a weak one — NaN and negatives are not measurements", () => {
    assert.equal(passportTrustConfidence("ok", Number.NaN), null);
    assert.equal(passportTrustConfidence("ok", -3), null);
    assert.equal(passportTrustConfidence("ok", Number.POSITIVE_INFINITY), null);
  });

  it("TRAVEL VOLUME CANNOT MOVE THE BAND — the fabricated formula's own inputs", async () => {
    // M1: restoring `stats.stamps + stats.trips * 2 + (verified ? 3 : 0)` makes
    // these two disagree — 0 stamps/0 trips scored "low", 20 stamps "high".
    const quiet = (await buildPassportProjection(db(scored(0), { stamps: 0, trips: 0 }), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const busy  = (await buildPassportProjection(db(scored(0), { stamps: 20, trips: 9 }), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(quiet.trust!.confidence, "low");
    assert.equal(busy.trust!.confidence, "low", "twenty stamps and zero trust events is not high trust confidence");
    assert.equal(busy.stats.stamps, 20, "the fixture really did carry the travel volume");
  });

  it("the band moves ONLY with the engine's measure", async () => {
    const p = (await buildPassportProjection(db(scored(TRUST_EARN_CONFIDENCE_WEIGHT), { stamps: 0, trips: 0 }), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust!.confidence, "high");
    assert.equal(p.trust!.confidenceBasis, "trust_evidence");
    assert.equal(p.trust!.evidenceWeight, TRUST_EARN_CONFIDENCE_WEIGHT);
  });
});

// ── §2 — absence never becomes a band ────────────────────────────────────────

describe("P50 §2 — an unmeasured trust read renders 'not measured', never a number", () => {
  it("UNREADABLE trust_profiles produces a null band, a reason, and `degraded`", async () => {
    // The resolved-{data:null,error} shape supabase-js really returns — it does
    // not throw, so a try/catch would never have seen this.
    const p = (await buildPassportProjection(
      db(scored(9), { failTrustRead: true, stamps: 20, trips: 9 }),
      OWNER, OWNER, { resolveViewerContext: resolver(SELF) },
    ))!;
    // M2: `if (state !== "ok") return null` → `return "low"` reddens here.
    assert.equal(p.trust!.confidence, null, "a database hiccup is not a statement about this person");
    assert.equal(p.trust!.confidenceBasis, "unavailable");
    assert.equal(p.trust!.degraded, true);
    assert.equal(p.trust!.evidenceWeight, null);
  });

  it("an ABSENT profile — the 56-of-58 production case — produces a null band", async () => {
    const p = (await buildPassportProjection(db(null, { stamps: 14, trips: 6 }), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust!.confidence, null);
    assert.equal(passportTrustConfidence("absent", null), null);
  });

  it("a PRE-2371 row — categories measured, evidence never recorded — produces a null band", async () => {
    // M3: `Number(evidenceWeight ?? 0)` turns "never measured" into "measured
    // and empty", which is precisely the conflation this row forbids.
    const p = (await buildPassportProjection(db(scored(null), { stamps: 20, trips: 9 }), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust!.confidence, null);
    assert.equal(p.trust!.confidenceBasis, "travel_proxy");
    assert.equal(passportTrustConfidence("ok", undefined), null);
  });

  it("null is reachable on the PUBLIC path too, not only the owner's own view", async () => {
    const p = (await buildPassportProjection(db(null, { stamps: 20 }), OWNER, "viewer-9", { resolveViewerContext: resolver(PUBLIC) }))!;
    assert.equal(p.trust!.confidence, null);
    assert.equal(p.trust!.score, null, "no numeric score off the self view (§9)");
  });
});

// ── §3 — the only threshold is the trust engine's, and it is guarded ──────────

describe("P50 §3 — no invented weight: the one constant is mirrored under a drift guard", () => {
  it("TRUST_EARN_CONFIDENCE_WEIGHT equals TrustScoreService's EARN_CONFIDENCE_WEIGHT", () => {
    // Read the OWNING module's source. This lane may not modify
    // `services/trust/**` and that module does not export the constant, so the
    // mirror is checked against the real declaration rather than trusted.
    // M4: changing either number reddens this.
    const src = readFileSync(
      fileURLToPath(new URL("../services/trust/TrustScoreService.ts", import.meta.url)),
      "utf8",
    );
    const m = /const\s+EARN_CONFIDENCE_WEIGHT\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*;/.exec(src);
    assert.ok(m, "EARN_CONFIDENCE_WEIGHT must still be declared in TrustScoreService.ts");
    assert.equal(
      Number(m![1]),
      TRUST_EARN_CONFIDENCE_WEIGHT,
      "the Passport mirror has drifted from the trust engine's own full-credit weight",
    );
  });

  it("the projection service declares NO other numeric trust weight", () => {
    // The defect was a sum of hand-picked numbers. Re-introducing one under a
    // different name is the regression this catches.
    // Comment lines are stripped first: the removed formula is QUOTED in this
    // file's and the service's docblocks on purpose, so that the record of what
    // was wrong survives. What must not come back is live code.
    const src = readFileSync(
      fileURLToPath(new URL("../services/passport/PassportProjectionService.ts", import.meta.url)),
      "utf8",
    )
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.equal(
      /stats\.stamps\s*\+\s*stats\.trips/.test(src),
      false,
      "the travel-derived evidence sum is back",
    );
    assert.equal(
      /const\s+evidence\s*=/.test(src),
      false,
      "a locally computed `evidence` quantity is back in the projection service",
    );
  });
});

// ── §4 — the measured verdict outranks the substituted one on the label ──────

describe("P50 §4 — a fabricated band no longer overrides a measured public level", () => {
  it("a TRUSTED traveller with almost no travel is not published as 'New Traveler'", async () => {
    // The old public branch read `confidence === "low"`, and with 0 stamps and
    // 0 trips the fabricated evidence sum was 3 — "low" — so this person's
    // measured `trusted_traveler` was overwritten with "New Traveler" for every
    // stranger who opened their Passport. M6 restores that.
    const p = (await buildPassportProjection(
      db(scored(6, "trusted_traveler"), { stamps: 0, trips: 0 }),
      OWNER, "viewer-9", { resolveViewerContext: resolver(PUBLIC) },
    ))!;
    assert.equal(p.trust!.label, "Trusted Traveler");
    assert.equal(p.trust!.publicLevel, "trusted_traveler");
  });

  it("a genuine new traveller still gets the non-stigmatizing copy, unchanged", async () => {
    const p = (await buildPassportProjection(
      db(scored(0, "new_traveler"), { stamps: 0, trips: 0 }),
      OWNER, "viewer-9", { resolveViewerContext: resolver(PUBLIC) },
    ))!;
    // The fixture profile is `verified: true`, which is what selects the suffix.
    assert.equal(p.trust!.label, "New Traveler · Verified");
  });

  it("an absent profile still reads 'New Traveler' — the default is unchanged", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, "viewer-9", { resolveViewerContext: resolver(PUBLIC) }))!;
    assert.equal(p.trust!.publicLevel, "new_traveler");
    assert.ok(p.trust!.label.startsWith("New Traveler"));
  });
});

// ── §5 — the D-WORD boundary is still un-taken ───────────────────────────────

describe("P50 §5 — D-WORD was DECIDED 2026-09-22; this moved on purpose", () => {
  it("the substituted neutral 50 no longer reads 'Established', and still says why", async () => {
    // This block previously asserted the opposite and said so: the choice of a
    // different WORD for a never-measured domain "is the owner's standing
    // D-WORD decision, and this assertion exists so that taking it is a
    // deliberate diff rather than a side effect". The owner took it (Q3). This
    // is that deliberate diff. The two neighbouring facts the decision
    // preserves — the basis, and applicable staying true — are still pinned.
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const overall = (p.trust!.domains as any[]).find((d) => d.key === "overall")!;
    assert.equal(overall.presentation, "Not yet rated");
    assert.notEqual(overall.presentation, "Established");
    // Unmoved, and asserted here because the decision was word-only: the domain
    // still APPLIES to this person and still reports what its word rests on.
    assert.equal(overall.basis, "substituted");
    assert.equal(overall.applicable, true);
  });

  it("the five band words are unchanged and none was added", async () => {
    const src = readFileSync(
      fileURLToPath(new URL("../services/passport/PassportProjectionService.ts", import.meta.url)),
      "utf8",
    );
    for (const w of ["Excellent", "Strong", "Established", "Building", "New"]) {
      assert.ok(src.includes(`return "${w}"`), `presentationWord lost the word ${w}`);
    }
  });
});
