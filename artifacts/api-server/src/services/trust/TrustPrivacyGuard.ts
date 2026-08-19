/**
 * TrustPrivacyGuard
 *
 * Produces safe public-facing trust summaries.
 * Rules:
 *  - Reporter identity is NEVER exposed
 *  - Raw event deltas and internal scores are NOT returned to users
 *  - Restrictions are surfaced as human-readable messages only
 *  - pending_review events are invisible to the subject user
 *  - Admin can receive full internal data via a separate path
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTrustProfile, type PublicTrustLevel } from "./TrustScoreService.js";
import { getRestrictionState, type RestrictionType } from "./TrustRestrictionService.js";
import { getRecoveryStatus } from "./TrustRecoveryService.js";

export interface SafeTrustSummary {
  userId: string;
  publicLevel: PublicTrustLevel;
  /** Highlights: top 2 strongest categories */
  strengths: string[];
  /** Active restrictions in human-readable form */
  restrictions: string[];
  /** Whether the user is on probation (no detail exposed) */
  onProbation: boolean;
  /** Ordered recovery hints (no category scores exposed) */
  recoveryHints: string[];
  /**
   * True when `restrictions` is a guess, not an authoritative read — the
   * empty-vs-actually-empty distinction getRestrictionState's `degraded`
   * flag exists to carry, otherwise lost the moment this summary flattens
   * activeRestrictions into a message list. Not a UI trigger by itself:
   * this is a passive summary, not an action being attempted, so it does
   * not show the "try again" message that a blocked hosting/messaging
   * action shows — a future caller decides what, if anything, to do with
   * it (e.g. a "some info may be temporarily unavailable" indicator).
   */
  restrictionsDegraded?: boolean;
  /** Which way the degraded read failed — see RestrictionState.degradedReason. */
  restrictionsDegradedReason?: "fail_open" | "fail_closed";
}

const LEVEL_LABELS: Record<PublicTrustLevel, string> = {
  new_traveler:      "New Traveler",
  building_trust:    "Building Trust",
  reliable_traveler: "Reliable Traveler",
  trusted_traveler:  "Trusted Traveler",
  highly_trusted:    "Highly Trusted",
  city_trusted:      "City Trusted",
};

const RESTRICTION_MESSAGES: Record<RestrictionType, string> = {
  hosting:             "You cannot host group trips at this time.",
  private_plan_access: "You cannot join private plans at this time.",
  messaging:           "You cannot initiate new conversations at this time.",
  location_plan_join:  "You cannot join location-based plans at this time.",
};

const CATEGORY_LABELS: Record<string, string> = {
  plan_attendance:       "Plan Attendance",
  host_quality:          "Hosting",
  communication:         "Communication",
  respect_safety:        "Respect & Safety",
  location_honesty:      "Location Honesty",
  content_quality:       "Content Quality",
  community_value:       "Community Value",
  guide_accuracy:        "Guide Accuracy",
  passport_authenticity: "Passport Authenticity",
};

/** Build a safe public summary for a user — never exposes reporter or raw scores */
export async function getSafeTrustSummary(
  db: SupabaseClient,
  userId: string,
): Promise<SafeTrustSummary> {
  const [profile, restrictions, recovery] = await Promise.all([
    getTrustProfile(db, userId),
    getRestrictionState(db, userId),
    getRecoveryStatus(db, userId),
  ]);

  const publicLevel: PublicTrustLevel = profile?.public_level ?? "new_traveler";

  // Top 2 strongest categories (above 60)
  const strengths = profile
    ? Object.entries(profile.categories)
        .filter(([, s]) => s >= 60)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([cat]) => CATEGORY_LABELS[cat] ?? cat)
    : [];

  const restrictionMessages = restrictions.activeRestrictions.map(
    (r) => RESTRICTION_MESSAGES[r] ?? r,
  );

  const recoveryHints = recovery.suggestedSteps
    .slice(0, 3)
    .map((s) => s.action);

  return {
    userId,
    publicLevel,
    strengths,
    restrictions: restrictionMessages,
    onProbation: recovery.onProbation,
    recoveryHints,
    ...(restrictions.degraded
      ? { restrictionsDegraded: true, restrictionsDegradedReason: restrictions.degradedReason }
      : {}),
  };
}

/** Safe public badge for display on another user's profile */
export interface PublicTrustBadge {
  userId: string;
  level: PublicTrustLevel;
  label: string;
  strengths: string[];
}

export async function getPublicTrustBadge(
  db: SupabaseClient,
  userId: string,
): Promise<PublicTrustBadge> {
  const profile = await getTrustProfile(db, userId);
  const level: PublicTrustLevel = profile?.public_level ?? "new_traveler";

  const strengths = profile
    ? Object.entries(profile.categories)
        .filter(([, s]) => s >= 65)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 2)
        .map(([cat]) => CATEGORY_LABELS[cat] ?? cat)
    : [];

  return { userId, level, label: LEVEL_LABELS[level], strengths };
}

/** Strip internal fields before any LLM or external exposure */
export function isEventLlmSafe(event: any): boolean {
  // Never pass pending_review events or reporter IDs to AI
  if (event?.status === "pending_review") return false;
  if (event?.reporter_id) return false;
  if (event?.reviewed_by) return false;
  return true;
}
