/**
 * trustScore — compute a user's TrustScore (0–100) from real DB inputs.
 *
 * Formula (weighted, deterministic, auditable):
 *   Baseline                         +20   (every account starts here)
 *   Identity verified (ID doc)       +20   (canonical predicate: verification_level
 *                                          != none, verification_status = verified,
 *                                          or id_verified_at set)
 *   Passport stamp count (capped 20) 0–15  (linear, 1 stamp ≈ 0.75 pts)
 *   Account age (capped 1 yr)        0–15  (linear, 1 year → full 15)
 *   Buddy review average             0–30  (5-star avg × confidence curve)
 *   Safety flag penalties             −5 per confirmed flag, max −20
 *
 * Total max: 100 (baseline 20 + 20 + 15 + 15 + 30 = 100).
 * New accounts with no inputs sit at 20, never null.
 *
 * Labels (for UI display):
 *   80–100  Trusted Traveler
 *   60–79   Community Member
 *   40–59   Growing Traveler
 *   20–39   New Explorer
 *   0–19    Getting Started
 */

/** One factor contributing to (or deducting from) the trust score. */
import { travelerIdentityFromProfile } from "./travelerVerification.js";

export interface TrustScoreFactor {
  /** Machine-readable key, e.g. "baseline", "identity", "stamps", "age", "reviews", "safety_flags". */
  key: string;
  /** Human-readable factor name shown in the UI. */
  label: string;
  /** Points actually awarded/deducted for this user (rounded). May be 0. */
  points: number;
  /** Maximum points this factor can ever contribute (positive) or maximum deduction (negative). */
  maxPoints: number;
  /** Whether this factor is currently at its maximum positive contribution. */
  maxed: boolean;
  /** Short actionable hint shown to the owner when the factor is not maxed and not a penalty. */
  hint: string | null;
}

export interface TrustScoreBreakdown {
  factors: TrustScoreFactor[];
}

export interface TrustScoreResult {
  /** Rounded integer 0–100. Always present; new accounts start at 20. */
  score: number;
  /** Human-readable label for the score tier. */
  label: string;
  /** Itemized factor breakdown — always present so clients can render an explanation. */
  breakdown: TrustScoreBreakdown;
}

/**
 * Core computation — accepts a pre-loaded profile row to avoid a redundant
 * DB round-trip when the caller already has the profiles data.
 *
 * @param profileRow  Object with at least { verified, id_verified_at, created_at, safety_flags_count }.
 *                    May contain extra columns — only the listed ones are read.
 * @param stampCount  Passport stamp count (pass 0 when unknown).
 * @param buddyRow    Optional rent_buddy_profiles row with { average_rating, review_count }.
 */
export function computeTrustScoreFromData(
  profileRow: Record<string, any>,
  stampCount: number,
  buddyRow: Record<string, any> | null | undefined,
): TrustScoreResult {
  const factors: TrustScoreFactor[] = [];

  // ── Baseline (+20) ───────────────────────────────────────────────────────
  const baselinePoints = 20;
  factors.push({
    key: "baseline",
    label: "Account created",
    points: baselinePoints,
    maxPoints: 20,
    maxed: true,
    hint: null,
  });

  // ── Identity verification (+20) ──────────────────────────────────────────
  // Identity uses the app's canonical predicate, not the bare `verified` boolean.
  //
  // The previous comment here claimed "profiles has no id_verified_at column".
  // That is false — the column exists — and the fallback it justified is a real
  // user-facing bug: the ID-verification flow (routes/verification.ts) writes
  // verification_level and verified_at and NEVER touches `verified`, so a user
  // who genuinely completes verification scored 0 of these 20 points. The only
  // writer of `verified` is the audited admin endpoint.
  //
  // travelerIdentityFromProfile is the same predicate the booking gates use, and
  // it deliberately refuses the bare `verified` boolean because that doubles as a
  // display badge and is set directly by seed scripts.
  const isVerified = travelerIdentityFromProfile(profileRow).idVerified;
  const identityPoints = isVerified ? 20 : 0;
  factors.push({
    key: "identity",
    label: "ID verification",
    points: identityPoints,
    maxPoints: 20,
    maxed: isVerified,
    hint: isVerified ? null : "Verify your identity to unlock +20 points",
  });

  // ── Account age (0–15, capped at 1 year) ─────────────────────────────────
  let agePoints = 0;
  if (profileRow.created_at) {
    const ageMs = Date.now() - new Date(profileRow.created_at as string).getTime();
    if (Number.isFinite(ageMs) && ageMs > 0) {
      const ageDays = ageMs / 86_400_000;
      agePoints = Math.min(15, (Math.min(ageDays, 365) / 365) * 15);
    }
  }
  const ageMaxed = agePoints >= 14.9; // ≥1 year
  factors.push({
    key: "age",
    label: "Account age",
    points: Math.round(agePoints),
    maxPoints: 15,
    maxed: ageMaxed,
    hint: ageMaxed ? null : "Score increases automatically as your account ages (full +15 after 1 year)",
  });

  // ── Passport stamp count (0–15, capped at 20 stamps) ─────────────────────
  const stampPoints = stampCount > 0
    ? Math.min(15, (Math.min(stampCount, 20) / 20) * 15)
    : 0;
  const stampMaxed = stampCount >= 20;
  factors.push({
    key: "stamps",
    label: "Passport stamps",
    points: Math.round(stampPoints),
    maxPoints: 15,
    maxed: stampMaxed,
    hint: stampMaxed
      ? null
      : stampCount === 0
        ? "Earn stamps by visiting places to unlock up to +15 points"
        : `${stampCount} of 20 stamps collected — keep exploring for +${Math.round(15 - stampPoints)} more points`,
  });

  // ── Buddy review average (0–30) ──────────────────────────────────────────
  // Scale: 5-star avg maps to 30 pts at full confidence (10+ reviews).
  // Confidence curve: confidence = min(1, reviewCount / 10) so a single
  // 5-star review contributes only 3 pts (not 30), and 10 reviews → full trust.
  let reviewPoints = 0;
  let reviewMaxed = false;
  if (buddyRow) {
    const avgRating = Number(buddyRow.average_rating ?? 0);
    const reviewCount = Number(buddyRow.review_count ?? 0);
    if (reviewCount > 0 && avgRating > 0) {
      const ratingComponent = ((avgRating - 1) / 4) * 30; // 1-star→0, 5-star→30
      const confidence = Math.min(1, reviewCount / 10);
      reviewPoints = ratingComponent * confidence;
      reviewMaxed = reviewPoints >= 29;
    }
  }
  factors.push({
    key: "reviews",
    label: "Buddy reviews",
    points: Math.round(reviewPoints),
    maxPoints: 30,
    maxed: reviewMaxed,
    hint: reviewMaxed
      ? null
      : reviewPoints === 0
        ? "Register as a Portava and collect reviews to earn up to +30 points"
        : "Higher ratings and more reviews increase your score (up to +30 at 5★ avg with 10+ reviews)",
  });

  // ── Safety flag penalty (−5 each, max −20) ───────────────────────────────
  // safety_flags_count DOES exist on profiles (integer, NOT NULL DEFAULT 0). The
  // previous comment claimed it did not.
  //
  // Correcting that must not swing to the opposite error: nothing in the codebase
  // WRITES this column — no route, service, RPC, trigger or migration — so every
  // row is 0 and this penalty is worth 0 points for every user today. Selecting
  // it changes no score; it makes the three callers agree, which they previously
  // did not (see the select below).
  const flagCount = Number(profileRow.safety_flags_count ?? 0);
  const flagPenalty = flagCount > 0 ? -Math.min(20, flagCount * 5) : 0;
  if (flagCount > 0) {
    factors.push({
      key: "safety_flags",
      label: "Safety flags",
      points: flagPenalty,
      maxPoints: -20,
      maxed: false,
      hint: "Resolve outstanding safety flags to restore your score",
    });
  }

  const rawScore =
    baselinePoints + identityPoints + agePoints + stampPoints + reviewPoints + flagPenalty;
  const finalScore = Math.round(Math.min(100, Math.max(0, rawScore)));

  return {
    score: finalScore,
    label: labelForScore(finalScore),
    breakdown: { factors },
  };
}

/**
 * Compute a TrustScore for `userId` from live DB data.
 *
 * All sub-queries run in parallel and are fail-open: if any query errors,
 * that component contributes 0 rather than failing the whole call.
 *
 * @param userId  The profiles.id (UUID) of the user being scored.
 * @param sc      A Supabase service-role client.
 * @param preloadedProfileRow  Optional already-fetched profiles row. When
 *   provided the extra profiles DB query is skipped (avoids a redundant
 *   round-trip when the caller already has the data).
 */
export async function computeTrustScore(
  userId: string,
  sc: any,
  preloadedProfileRow?: Record<string, any> | null,
): Promise<TrustScoreResult> {
  // Only fetch the profile row when not already supplied.
  const [profileRes, stampRes, buddyRes] = await Promise.allSettled([
    preloadedProfileRow
      ? Promise.resolve({ data: preloadedProfileRow })
      : sc
          .from("profiles")
          // Must match what the PRELOADED callers already pass. GET /me/profile
          // hands in a full profiles row (which includes safety_flags_count and
          // the verification columns), while /passport and the buddy card pass
          // nothing and fell back to this two-column select — so the SAME user
          // scored differently depending on which endpoint was asked. Selecting
          // the same columns here closes that split.
          .select("verified, created_at, id_verified_at, safety_flags_count, verification_level, verification_status")
          .eq("id", userId)
          .maybeSingle(),
    sc
      .from("passport_stamps")
      .select("user_id", { count: "exact", head: true })
      .eq("user_id", userId),
    sc
      .from("rent_buddy_profiles")
      .select("average_rating, review_count")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);

  const profileData =
    profileRes.status === "fulfilled" ? (profileRes.value as any).data : null;
  const stampCount =
    stampRes.status === "fulfilled"
      ? Number((stampRes.value as any).count ?? 0)
      : 0;
  const buddyData =
    buddyRes.status === "fulfilled" ? (buddyRes.value as any).data : null;

  return computeTrustScoreFromData(profileData ?? {}, stampCount, buddyData);
}

function labelForScore(score: number): string {
  if (score >= 80) return "Trusted Traveler";
  if (score >= 60) return "Community Member";
  if (score >= 40) return "Growing Traveler";
  if (score >= 20) return "New Explorer";
  return "Getting Started";
}
