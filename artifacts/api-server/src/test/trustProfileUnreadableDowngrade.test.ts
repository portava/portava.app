/**
 * trustProfileUnreadableDowngrade — "Highly Trusted" must not become
 * "New Traveler" because the database blinked.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `getTrustProfile` was a TWO-state read:
 *
 *     const { data } = await db.from("trust_profiles").select("*")…   // no error
 *     if (!data) return null;
 *
 * supabase-js RESOLVES on a database error, so an unreadable `trust_profiles`
 * arrived as `null` — byte-identical to a brand-new account with no profile
 * yet. Every consumer then applied the new-account default:
 *
 *   • TrustPrivacyGuard.getSafeTrustSummary  → publicLevel "new_traveler", no strengths
 *   • TrustPrivacyGuard.getPublicTrustBadge  → the same, on OTHER people's view of you
 *   • lib/trustScore.computeTrustScore       → label "New Traveler", empty breakdown
 *                                              (identity card + Rent-a-Buddy card)
 *   • PassportProjectionService.buildTrust   → the above PLUS per-domain words
 *                                              derived from a fabricated 50
 *
 * So a traveller who had earned "Highly Trusted" was presented to their peers
 * as a newcomer — a claim about a PERSON assembled from a hiccup — and the
 * `try/catch` wrapped around the read never fired, because nothing was thrown.
 *
 * This is the same shape the session found in verification.ts, where a verified
 * user was shown a verification wall built from a failed read.
 *
 * `lib/http.ts` and CreatorActivityScoreService BOTH cite
 * `TrustProfileRead` / `getTrustProfileResult` in TrustScoreService as the
 * canonical `ok | absent | unavailable` union for exactly this distinction, and
 * copy it. It did not exist until this suite. It does now.
 *
 * ── HOW THIS IS MEASURED, NOT ASSUMED ───────────────────────────────────────
 * WHAT ELSE COULD MAKE "the level is new_traveler" PASS? A seed with no profile
 * row, which is the very state being distinguished. So EVERY degraded case is
 * paired with two controls on the SAME seed: a HEALTHY read that returns
 * "highly_trusted" (proving the fixture can produce a real level) and an
 * ABSENT-row read that returns "new_traveler" with NO degraded marker (proving
 * the marker is not simply always on). The failure is injected only on
 * `trust_profiles`, keyed to this user, so the sibling restriction/recovery
 * reads stay healthy and cannot be what changed the answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { getTrustProfileResult, getTrustProfile } from "../services/trust/TrustScoreService.js";
import { getSafeTrustSummary, getPublicTrustBadge } from "../services/trust/TrustPrivacyGuard.js";
import { computeTrustScore } from "../lib/trustScore.js";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TRUSTED_ROW = {
  user_id: USER,
  overall_score: 88,
  public_level: "highly_trusted",
  evidence_weight: 12,
  evidence_count: 30,
  plan_attendance: 90, host_quality: 85, communication: 92, respect_safety: 95,
  location_honesty: 80, content_quality: 70, community_value: 75,
  guide_accuracy: 66, passport_authenticity: 91,
};

/**
 * @param mode "trusted" = the row exists and says Highly Trusted;
 *             "absent"  = no row at all (a genuinely new account);
 *             "broken"  = the row exists but the read RESOLVES an error.
 */
function client(mode: "trusted" | "absent" | "broken") {
  return makeFailClosedClient({
    rows: {
      trust_profiles: mode === "absent" ? [] : [TRUSTED_ROW],
      trust_restrictions: [],
      trust_caps: [],
      trust_events: [],
      profiles: [{ id: USER, username: "t", account_status: "active" }],
    },
    failOn: (c) =>
      mode === "broken" && c.table === "trust_profiles" && c.eq("user_id") === USER
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null,
  });
}

test("1. getTrustProfileResult separates 'no profile yet' from 'could not read'", async () => {
  const ok = await getTrustProfileResult(client("trusted"), USER);
  assert.equal(ok.state, "ok");
  assert.equal(ok.state === "ok" && ok.profile.public_level, "highly_trusted",
    "the fixture WOULD have produced a real, non-default level");

  const absent = await getTrustProfileResult(client("absent"), USER);
  assert.equal(absent.state, "absent", "a genuinely new account is still 'absent', not a failure");

  const broken = await getTrustProfileResult(client("broken"), USER);
  assert.equal(broken.state, "unavailable", "an unreadable row is its own answer");
  assert.ok(
    broken.state === "unavailable" && broken.reason.length > 0,
    "…and the failure carries its own reason, as lib/http.ts documents this union doing",
  );

  // The legacy signature is preserved for callers that cannot express the
  // difference: BOTH non-ok states still collapse to null.
  assert.equal(await getTrustProfile(client("absent"), USER), null);
  assert.equal(await getTrustProfile(client("broken"), USER), null);
});

test("2. getSafeTrustSummary does not present a Highly Trusted user as new, silently", async () => {
  const ok = await getSafeTrustSummary(client("trusted"), USER);
  assert.equal(ok.publicLevel, "highly_trusted");
  assert.ok(ok.strengths.length > 0, "the fixture produces real strengths");
  assert.equal(ok.profileUnavailable, undefined);

  const absent = await getSafeTrustSummary(client("absent"), USER);
  assert.equal(absent.publicLevel, "new_traveler", "a real new account is really a new traveller");
  assert.equal(
    absent.profileUnavailable, undefined,
    "…and is NOT marked degraded — the marker must not be simply always on",
  );

  const broken = await getSafeTrustSummary(client("broken"), USER);
  // The level still defaults — there is no honest level to invent — but the
  // two are no longer the same statement.
  assert.equal(broken.publicLevel, "new_traveler");
  assert.equal(
    broken.profileUnavailable, true,
    "an unreadable profile must not be indistinguishable from a new account",
  );
});

test("3. getPublicTrustBadge — the same, on how OTHER people see you", async () => {
  const ok = await getPublicTrustBadge(client("trusted"), USER);
  assert.equal(ok.level, "highly_trusted");
  assert.equal(ok.label, "Highly Trusted", "the fixture produces the real label");
  assert.equal(ok.profileUnavailable, undefined);

  const broken = await getPublicTrustBadge(client("broken"), USER);
  assert.equal(broken.label, "New Traveler");
  assert.equal(broken.profileUnavailable, true, "…and that downgrade is now labelled a read failure");

  assert.notEqual(ok.label, broken.label, "the two labels must differ or this test proves nothing");
});

test("4. computeTrustScore — the identity card and the Rent-a-Buddy card", async () => {
  const ok = await computeTrustScore(USER, client("trusted"));
  assert.equal(ok.score, 88, "the fixture produces the canonical score");
  assert.equal(ok.label, "Highly Trusted");
  assert.ok(ok.breakdown.factors.length > 0);
  assert.equal(ok.degraded, undefined);

  const absent = await computeTrustScore(USER, client("absent"));
  assert.equal(absent.score, null);
  assert.equal(absent.label, "New Traveler");
  assert.equal(absent.degraded, undefined, "a real new account is not degraded");

  const broken = await computeTrustScore(USER, client("broken"));
  assert.equal(broken.label, "New Traveler");
  assert.deepEqual(
    broken.breakdown.factors, [],
    "the breakdown collapses exactly like a new account's — which is why the flag has to exist",
  );
  assert.equal(broken.degraded, true);
});

test("5. the §29 projection names 'trust' among the sections it could not read", async () => {
  const { buildPassportProjection, buildProjectionCachePolicy, PASSPORT_DYNAMIC_MAX_AGE } =
    await import("../services/passport/PassportProjectionService.js");

  const PROFILE = { id: USER, handle: "t", username: "t", verified: true };
  const resolution: any = {
    context: "self",
    permissions: {
      relationshipLabel: "self", isBlocked: false, isUnavailable: false,
      canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
      canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
      canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
      canFollow: false, canInviteToTripCrew: false,
    },
    sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null,
  };
  const opts: any = {
    profileRow: PROFILE,
    resolveViewerContext: async () => resolution,
    crewSignal: "excluded",
  };
  const withProfiles = (mode: "trusted" | "broken") =>
    makeFailClosedClient({
      rows: {
        profiles: [PROFILE],
        trust_profiles: [TRUSTED_ROW],
        trust_restrictions: [], trust_caps: [], trust_events: [],
        user_stamps: [], passport_stamps: [], passport_memories: [],
        passport_visibility_preferences: [],
      },
      failOn: (c) =>
        mode === "broken" && c.table === "trust_profiles" && c.eq("user_id") === USER
          ? { message: "connection terminated unexpectedly", code: "57P01" }
          : null,
    });

  // Control: the same seed, healthy — a real level, no marker anywhere.
  const healthy = await buildPassportProjection(withProfiles("trusted"), USER, USER, opts);
  assert.ok(healthy, "the projection built");
  assert.equal(healthy!.trust?.publicLevel, "highly_trusted", "the fixture produces a real level");
  assert.equal(healthy!.trust?.degraded, undefined);
  assert.equal(healthy!.unreadable, undefined);

  const degraded = await buildPassportProjection(withProfiles("broken"), USER, USER, opts);
  assert.ok(degraded, "the projection still builds — degraded, not absent");
  assert.equal(degraded!.trust?.publicLevel, "new_traveler", "the level collapses to the default…");
  assert.equal(degraded!.trust?.degraded, true, "…and the trust block says the default is a failure");
  assert.ok(degraded!.unreadable?.includes("trust"), "the aggregate names the section too");

  // And the consequence: an hour of "New Traveler" cached from a blip is the
  // transient failure turned into a sustained one.
  const policy = buildProjectionCachePolicy(degraded!);
  assert.equal(policy.sections.trust, PASSPORT_DYNAMIC_MAX_AGE);
});
