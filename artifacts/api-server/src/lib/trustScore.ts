/**
 * trustScore — the Passport-facing adapter over the ONE canonical trust engine.
 *
 * There used to be two trust engines that could disagree for the same user:
 *   1. this file's own 0–100 heuristic (baseline + identity + age + stamps +
 *      reviews − flags), read by the owner Home identity card (GET /me/profile,
 *      GET /passport) and the Rent-a-Buddy card; and
 *   2. services/trust — the evidence/event-sourced engine that persists nine
 *      category scores and a weighted `overall_score` to `trust_profiles`, read
 *      by TrustScreen (PassportProjectionService.buildTrust).
 *
 * Two engines meant the SAME traveller could show one number on their identity
 * card and a different number on TrustScreen. §9 requires one internally
 * replayable 0–100 score; §30 requires the server to own it. So this file no
 * longer computes anything — `computeTrustScore` now DELEGATES to services/trust
 * and returns exactly the canonical `trust_profiles.overall_score` (via
 * getDisplayTrustScore) as the display number, with the label derived from the
 * canonical `public_level`. Every surface reads the same source; the number is
 * identical everywhere by construction.
 *
 * The breakdown is projected from the canonical nine category scores so the
 * owner still gets an explainable, non-stigmatizing factor list (§9/§10) rather
 * than a bare number — but it, too, is a view of the one source, never a
 * second computation.
 */
import {
  getDisplayTrustScore,
  getTrustProfile,
  type TrustScoreResult as CanonicalTrustResult,
} from "../services/trust/TrustScoreService.js";
import { publicTrustLabel } from "../services/trust/TrustPrivacyGuard.js";

/** One factor contributing to the trust score (a view of a canonical category). */
export interface TrustScoreFactor {
  /** Machine-readable key, e.g. "respect_safety". */
  key: string;
  /** Human-readable factor name shown in the UI. */
  label: string;
  /** The category's current 0–100 score (rounded). */
  points: number;
  /** Maximum a category can reach (always 100). */
  maxPoints: number;
  /** Whether this category is at/near its ceiling. */
  maxed: boolean;
  /** Short actionable hint shown to the owner when the category is low; else null. */
  hint: string | null;
}

export interface TrustScoreBreakdown {
  factors: TrustScoreFactor[];
}

export interface TrustScoreResult {
  /**
   * Rounded integer 0–100 — the canonical `trust_profiles.overall_score`. `null`
   * when the user has no trust profile yet (rendered as the non-stigmatizing
   * "New Traveler" label rather than a fabricated number).
   */
  score: number | null;
  /** Human-readable label for the canonical public trust level. */
  label: string;
  /** Itemized factor breakdown projected from the nine canonical categories. */
  breakdown: TrustScoreBreakdown;
}

/**
 * Per-category display metadata. Labels match the TrustScreen wording
 * (TrustPrivacyGuard.CATEGORY_LABELS) so the owner sees the same names on the
 * identity-card breakdown and on TrustScreen. Hints are shown only when a
 * category sits below neutral.
 */
const CATEGORY_META: Record<string, { label: string; hint: string }> = {
  plan_attendance:       { label: "Plan Attendance",  hint: "Show up to the plans you join to raise this" },
  host_quality:          { label: "Hosting",          hint: "Host well-run trips to raise this" },
  communication:         { label: "Communication",    hint: "Reply and coordinate reliably to raise this" },
  respect_safety:        { label: "Respect & Safety",  hint: "Keep interactions respectful and safe to raise this" },
  location_honesty:      { label: "Location Honesty",  hint: "Keep your check-ins and location honest to raise this" },
  content_quality:       { label: "Content Quality",   hint: "Share useful, accurate contributions to raise this" },
  community_value:       { label: "Community Value",   hint: "Help other travelers to raise this" },
  guide_accuracy:        { label: "Guide Accuracy",    hint: "Keep your guide contributions accurate to raise this" },
  passport_authenticity: { label: "Passport Authenticity", hint: "Keep your travel record authentic to raise this" },
};

/**
 * Project the canonical nine category scores into an explainable factor list.
 * A category at/above 65 is "strong" (no hint); below neutral (< 50) surfaces an
 * improvement hint. Never exposes raw event deltas or reporter data (§10).
 */
function breakdownFromCategories(categories: Record<string, number> | null | undefined): TrustScoreBreakdown {
  const factors: TrustScoreFactor[] = [];
  if (!categories) return { factors };
  for (const [key, meta] of Object.entries(CATEGORY_META)) {
    const raw = Number((categories as Record<string, number>)[key]);
    if (!Number.isFinite(raw)) continue;
    const points = Math.round(raw);
    factors.push({
      key,
      label: meta.label,
      points,
      maxPoints: 100,
      maxed: points >= 65,
      hint: points < 50 ? meta.hint : null,
    });
  }
  return { factors };
}

/**
 * The canonical trust result for `userId`, adapted to the Passport display shape.
 *
 * DELEGATES to services/trust:
 *   - `score` is `getDisplayTrustScore` — the rounded canonical overall_score,
 *     the exact number TrustScreen shows, or null when there is no profile.
 *   - `label` is `publicTrustLabel(public_level)` — the exact wording TrustScreen
 *     and the buddy card use for that level.
 *   - `breakdown` is a view of the nine canonical categories.
 *
 * @param userId  The profiles.id (UUID) of the user being scored.
 * @param sc      A Supabase service-role client.
 * @param _preloadedProfileRow  Accepted for call-site compatibility; the score
 *   no longer derives from the profiles row (it comes from trust_profiles), so
 *   this argument is ignored.
 */
export async function computeTrustScore(
  userId: string,
  sc: any,
  _preloadedProfileRow?: Record<string, any> | null,
): Promise<TrustScoreResult> {
  let profile: CanonicalTrustResult | null = null;
  try {
    profile = await getTrustProfile(sc, userId);
  } catch {
    profile = null;
  }

  // Score is the SAME helper TrustScreen reads — identical rounding, identical
  // source — so the identity card, TrustScreen and the buddy card cannot drift.
  let score: number | null;
  try {
    score = await getDisplayTrustScore(sc, userId);
  } catch {
    score = profile ? Math.round(Number(profile.overall_score)) : null;
  }

  const label = publicTrustLabel(profile?.public_level);
  const breakdown = breakdownFromCategories(profile?.categories as Record<string, number> | undefined);

  return { score, label, breakdown };
}
