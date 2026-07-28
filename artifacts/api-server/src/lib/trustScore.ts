/**
 * trustScore — compute a user's TrustScore (0–100) from real DB inputs.
 *
 * Formula (weighted, deterministic, auditable):
 *   Baseline                         +20   (every account starts here)
 *   Identity verified (ID doc)       +20   (id_verified_at not null)
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

export interface TrustScoreResult {
  /** Rounded integer 0–100. Always present; new accounts start at 20. */
  score: number;
  /** Human-readable label for the score tier. */
  label: string;
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
  let score = 20; // baseline — every account starts here

  // ── Identity verification (+20) ──────────────────────────────────────────
  if (profileRow.id_verified_at || profileRow.verified) score += 20;

  // ── Account age (0–15, capped at 1 year) ─────────────────────────────────
  if (profileRow.created_at) {
    const ageMs = Date.now() - new Date(profileRow.created_at as string).getTime();
    if (Number.isFinite(ageMs) && ageMs > 0) {
      const ageDays = ageMs / 86_400_000;
      score += Math.min(15, (Math.min(ageDays, 365) / 365) * 15);
    }
  }

  // ── Safety flag penalty (−5 each, max −20) ───────────────────────────────
  const flagCount = Number(profileRow.safety_flags_count ?? 0);
  if (flagCount > 0) {
    score -= Math.min(20, flagCount * 5);
  }

  // ── Passport stamp count (0–15, capped at 20 stamps) ─────────────────────
  if (stampCount > 0) {
    score += Math.min(15, (Math.min(stampCount, 20) / 20) * 15);
  }

  // ── Buddy review average (0–30) ──────────────────────────────────────────
  // Scale: 5-star avg maps to 30 pts at full confidence (10+ reviews).
  // Confidence curve: confidence = min(1, reviewCount / 10) so a single
  // 5-star review contributes only 3 pts (not 30), and 10 reviews → full trust.
  if (buddyRow) {
    const avgRating = Number(buddyRow.average_rating ?? 0);
    const reviewCount = Number(buddyRow.review_count ?? 0);
    if (reviewCount > 0 && avgRating > 0) {
      const ratingComponent = ((avgRating - 1) / 4) * 30; // 1-star→0, 5-star→30
      const confidence = Math.min(1, reviewCount / 10);
      score += ratingComponent * confidence;
    }
  }

  const finalScore = Math.round(Math.min(100, Math.max(0, score)));
  return { score: finalScore, label: labelForScore(finalScore) };
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
          .select("verified, id_verified_at, created_at, safety_flags_count")
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
