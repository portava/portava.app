/**
 * census-passport P45 — §9/§10 "domain-specific, confidence-aware and
 * EXPLAINABLE", at the level the words are actually shown: the domain.
 *
 * WHAT WAS STILL WRONG. `confidenceBasis` already told a consumer what the
 * OVERALL confidence rested on. The six TABLE 12 domain rows told it nothing:
 * every one of them shipped `applicable: true` and a presentation word, whether
 * its categories had been measured or had been silently replaced by the neutral
 * 50 that `buildDomainTrust`'s `c()` substitutes for an absent category. A
 * traveller with a full `trust_profiles` row and a traveller with none produced
 * SIX IDENTICAL DOMAIN ROWS — the exact equivalence §10 forbids, one level down
 * from where the last pass closed it.
 *
 * WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT. The presentation WORD is
 * unchanged. Whether a substituted 50 may keep the word "Established" is the
 * owner decision the census records as D-WORD, and recalibrating it here — by
 * flipping `applicable`, or by renaming the word — would be taking that decision
 * under cover of a defect fix. `applicable` keeps its ONE meaning ("this domain
 * does not apply to this person", the Buddy case) and is asserted UNCHANGED
 * below, so a later recalibration is a deliberate diff rather than a side
 * effect. What is added is the domain saying what its word rests on.
 *
 * IT TESTS THE SHIPPED PREDICATE, NOT A COPY. `domainTrustBasis` is imported and
 * called directly, and the second block runs the whole projection so the value
 * is asserted where a consumer reads it — the failure mode a local
 * reimplementation of the same branches would hide.
 *
 * Run: node --import tsx/esm --test src/test/passportDomainTrustBasis.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildPassportProjection,
  domainTrustBasis,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { buildConsumerProjection } from "../services/passport/PassportConsumerProjections.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";

const OWNER = "owner-1";

describe("P45 — domainTrustBasis maps a domain's inputs to what its word rests on", () => {
  it("an UNREADABLE trust_profiles reports 'unavailable' for every domain", () => {
    // The projection already flags `degraded`; the domain says the same about
    // its own word, so a consumer holding one row is not misled by it. The
    // input counts are passed as a fully-measured domain to prove the read
    // state wins.
    assert.equal(domainTrustBasis("unavailable", 4, 4), "unavailable");
  });

  it("every input measured reports 'measured'", () => {
    assert.equal(domainTrustBasis("ok", 4, 4), "measured");
    assert.equal(domainTrustBasis("ok", 1, 1), "measured");
  });

  it("NO input measured reports 'substituted' — the neutral 50's own word", () => {
    assert.equal(domainTrustBasis("ok", 0, 4), "substituted");
    // The 56-of-58 production case: the profile row does not exist at all.
    assert.equal(domainTrustBasis("absent", 0, 4), "substituted");
  });

  it("SOME inputs measured reports 'partial' — a mean of three reals and one default is neither", () => {
    assert.equal(domainTrustBasis("ok", 1, 4), "partial");
    assert.equal(domainTrustBasis("ok", 3, 4), "partial");
  });

  it("a domain with no inputs at all is 'not_applicable', never 'measured'", () => {
    // Zero of zero is vacuously "all measured". Reporting that as `measured`
    // would say a domain nobody scored had been scored.
    assert.equal(domainTrustBasis("ok", 0, 0), "not_applicable");
  });
});

// ── The wiring, not the predicate ───────────────────────────────────────────

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
    failTrustRead ? { failReads: { trust_profiles: { code: "57014", message: "timeout" } } } : {},
  );
}

const SELF: ViewerResolution = { context: "self", permissions: permsSelf(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const PUBLIC: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
const resolver = (r: ViewerResolution) => async () => r;

const fullyScored = {
  user_id: OWNER, overall_score: 82, public_level: "highly_trusted",
  plan_attendance: 88, host_quality: 55, communication: 70, respect_safety: 90,
  location_honesty: 84, content_quality: 92, community_value: 90,
  guide_accuracy: 88, passport_authenticity: 80,
};

function domainMap(domains: Array<{ key: string; basis: string; presentation: string; applicable: boolean }>) {
  return new Map(domains.map((d) => [d.key, d]));
}

describe("P45 — the basis reaches every domain row on every trust path", () => {
  it("a fully measured profile reports 'measured' on all five scored domains", async () => {
    const p = (await buildPassportProjection(db(fullyScored), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const d = domainMap(p.trust!.domains as any);
    for (const key of ["overall", "traveler", "trip_guest", "trip_host", "contributor"]) {
      assert.equal(d.get(key)!.basis, "measured", `${key} should be measured`);
    }
  });

  it("THE DEFECT CASE: NO trust profile — every domain reports 'substituted'", async () => {
    // Before this, these six rows were byte-identical to the measured ones
    // above. Now the word is the same and the row says where it came from.
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const d = domainMap(p.trust!.domains as any);
    for (const key of ["overall", "traveler", "trip_guest", "trip_host", "contributor"]) {
      assert.equal(d.get(key)!.basis, "substituted", `${key} should be substituted`);
    }
  });

  it("a PARTIAL profile separates the measured domains from the substituted ones", async () => {
    // Only `host_quality` and `communication` are present. Trip Host reads
    // entirely from host_quality → measured. Trip Guest averages
    // plan_attendance + respect_safety + communication, and has ONE of the
    // three → partial. Contributor's three inputs are all absent →
    // substituted. One profile, three different honest answers.
    const p = (await buildPassportProjection(
      db({ user_id: OWNER, overall_score: 61, public_level: "trusted", host_quality: 61, communication: 70 }),
      OWNER, OWNER, { resolveViewerContext: resolver(SELF) },
    ))!;
    const d = domainMap(p.trust!.domains as any);
    assert.equal(d.get("trip_host")!.basis, "measured");
    assert.equal(d.get("trip_guest")!.basis, "partial");
    assert.equal(d.get("traveler")!.basis, "partial", "one of four is partial, not measured");
    assert.equal(d.get("contributor")!.basis, "substituted");
    assert.equal(d.get("overall")!.basis, "measured", "overall_score was read");
  });

  it("an overall_score that is absent is 'substituted' even when categories are measured", async () => {
    const p = (await buildPassportProjection(
      db({ user_id: OWNER, public_level: "trusted", host_quality: 61 }),
      OWNER, OWNER, { resolveViewerContext: resolver(SELF) },
    ))!;
    const d = domainMap(p.trust!.domains as any);
    assert.equal(d.get("overall")!.basis, "substituted");
    assert.equal(d.get("trip_host")!.basis, "measured");
  });

  it("an UNREADABLE trust_profiles reports 'unavailable' on every domain, degraded too", async () => {
    const p = (await buildPassportProjection(db(null, true), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust?.degraded, true);
    for (const row of p.trust!.domains as any[]) {
      assert.equal(row.basis, "unavailable", `${row.key} should be unavailable`);
    }
  });

  it("the PUBLIC branch carries it too — it is a separate return statement", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, null, { resolveViewerContext: resolver(PUBLIC) }))!;
    const d = domainMap(p.trust!.domains as any);
    assert.equal(d.get("traveler")!.basis, "substituted");
  });

  it("Buddy for a non-buddy is 'not_applicable' and keeps applicable:false", async () => {
    const p = (await buildPassportProjection(db(fullyScored), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const buddy = domainMap(p.trust!.domains as any).get("buddy")!;
    assert.equal(buddy.applicable, false);
    assert.equal(buddy.presentation, "Not applicable");
    assert.equal(buddy.basis, "not_applicable");
  });
});

describe("D-WORD — DECIDED 2026-09-22, and this assertion moved on purpose", () => {
  /**
   * The block below used to assert the opposite: that a substituted domain
   * still reads "Established". Its own comment said why it existed — "If a
   * later pass takes that decision, this assertion is the thing it must change
   * on purpose." The owner took the decision (Q3): a substituted score must not
   * produce "Established". So this is a deliberate re-pin to the decided
   * behaviour, not a weakened assertion — the same case is still covered, with
   * the opposite expected value, and the three neighbouring guarantees the
   * decision preserves are pinned alongside it.
   */
  it("a SUBSTITUTED domain no longer prints a rating word", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const d = domainMap(p.trust!.domains as any);
    for (const key of ["overall", "traveler", "trip_guest", "trip_host", "contributor"]) {
      const row = d.get(key)!;
      assert.equal(row.basis, "substituted", `${key} precondition: this row IS substituted`);
      assert.equal(row.presentation, "Not yet rated", `${key} must not word a substitution`);
      assert.notEqual(row.presentation, "Established", `${key} must not claim a standing`);
    }
  });

  it("a substituted domain stays APPLICABLE — unmeasured is not inapplicable", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    const d = domainMap(p.trust!.domains as any);
    for (const key of ["overall", "traveler", "trip_guest", "trip_host", "contributor"]) {
      assert.equal(d.get(key)!.applicable, true, `${key}: applicable must not absorb "unmeasured"`);
    }
    // ... and the one genuinely inapplicable domain still says so, differently.
    const buddy = d.get("buddy")!;
    assert.equal(buddy.applicable, false);
    assert.equal(buddy.basis, "not_applicable");
    assert.equal(buddy.presentation, "Not applicable");
    assert.notEqual(buddy.presentation, "Not yet rated", "not applicable != not yet rated");
  });

  it("CONTROL — MEASURED and PARTIAL domains keep their real word", async () => {
    // Without this, the Q3 fix could "pass" by blanking every domain, which
    // would be the opposite failure: refusing to report what WAS observed.
    const measured = (await buildPassportProjection(db(fullyScored), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    for (const row of measured.trust!.domains as any[]) {
      if (row.basis === "measured" || row.basis === "partial") {
        assert.notEqual(row.presentation, "Not yet rated", `${row.key}: evidence must still be worded`);
        assert.ok(
          ["Excellent", "Strong", "Established", "Building", "New"].includes(row.presentation),
          `${row.key}: expected a real rating word, got ${row.presentation}`,
        );
      }
    }

    const partial = (await buildPassportProjection(
      db({ user_id: OWNER, overall_score: 61, public_level: "trusted", host_quality: 61, communication: 70 }),
      OWNER, OWNER, { resolveViewerContext: resolver(SELF) },
    ))!;
    const pd = domainMap(partial.trust!.domains as any);
    const host = pd.get("trip_host")!;
    assert.equal(host.basis, "measured", "trip_host averages host_quality alone, which IS present");
    assert.notEqual(host.presentation, "Not yet rated", "a measured domain must keep its word");
  });

  it("basis is untouched by the wording change — the note still explains", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    for (const row of p.trust!.domains as any[]) {
      assert.ok(
        ["measured", "partial", "substituted", "unavailable", "not_applicable"].includes(row.basis),
        `basis vocabulary intact for ${row.key}`,
      );
    }
  });

  it("`applicable` still means ONLY 'this domain does not apply', never 'unmeasured'", async () => {
    const p = (await buildPassportProjection(db(null), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    for (const row of p.trust!.domains as any[]) {
      if (row.key === "buddy") continue;
      assert.equal(row.applicable, true, `${row.key}: applicable must not be repurposed as an evidence flag`);
    }
  });

  it("THE ONLY CONSUMER THAT GETS THE WORDS ALSO GETS THE BASIS", async () => {
    // `trustDomains` on the trips variant is the one place `presentation`
    // leaves this service. A word without its basis there would put the
    // substitution back beyond reach of the consumer that reads it — which is
    // the whole failure this field exists to end.
    const t = (await buildConsumerProjection(db(null), "trips", OWNER, "viewer-9", {
      resolveViewerContext: async () => ({ ...SELF, context: "trip_crew" as any, permissions: { ...permsSelf(), relationshipLabel: "trip_crew" } }),
    }))!;
    assert.ok(t.trustDomains.length > 0, "the fixture carries trip trust domains");
    for (const d of t.trustDomains) {
      assert.equal(d.basis, "substituted", `${d.key}: the word's basis must travel with the word`);
      assert.equal(typeof d.presentation, "string");
    }
  });

  it("`confidence` no longer bands a profile that carries NO evidence measure (P50)", async () => {
    // CHANGED DELIBERATELY, 2026-09-14, census-passport P50. This assertion
    // used to read `["low","medium","high"].includes(...)` and it was written
    // to make exactly this diff visible rather than silent — see the census's
    // *"this census's own tests are written to catch"* note.
    //
    // `fullyScored` is a pre-2371 row: nine measured CATEGORIES and no
    // `evidence_weight`. The old band still produced "high" for it, out of
    // stamps and trips. There is no evidence measurement to band, so the band
    // is now `null`, and `confidenceBasis` says which absence it was. No WORD
    // was chosen here: a word was withheld.
    const p = (await buildPassportProjection(db(fullyScored), OWNER, OWNER, { resolveViewerContext: resolver(SELF) }))!;
    assert.equal(p.trust?.confidence, null);
    assert.equal(p.trust?.confidenceBasis, "travel_proxy");
    // The measured domain words are UNTOUCHED — D-WORD is still the owner's.
    assert.equal(domainMap(p.trust!.domains as any).get("overall")!.basis, "measured");
  });
});
