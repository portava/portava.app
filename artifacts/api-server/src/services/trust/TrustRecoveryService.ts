/**
 * TrustRecoveryService
 *
 * Calculates recovery progress, probation tracking, and generates
 * ordered recovery step suggestions for each user.
 *
 * Recovery steps are concrete, actionable, and tailored to the user's
 * current lowest category scores and active caps.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { getActiveCaps } from "./TrustCapService.js";

const logger = rootLogger.child({ service: "TrustRecoveryService" });
import { getTrustProfileResult } from "./TrustScoreService.js";

export interface RecoveryStep {
  category: string;
  action: string;
  targetCount?: number;
  currentProgress?: number;
  priority: number; // 1 = highest
}

export interface RecoveryStatus {
  userId: string;
  onProbation: boolean;
  probationEndsAt: string | null;
  activeCapsCount: number;
  lowestCategory: string | null;
  lowestScore: number | null;
  suggestedSteps: RecoveryStep[];
  /**
   * 0–100 % toward 50 (neutral), or NULL when there is no profile to measure.
   *
   * WAS `number`, and the no-profile branch returned the constant 50 — a
   * measurement-shaped value where no measurement exists, which is the same
   * defect census-passport records as P45 in a larger form ("every user is
   * described as an Established member"). Nothing outside this file reads the
   * field, which is why it could sit there: an unconsumed fabrication is still a
   * fabrication on the API surface, and the next consumer would have inherited
   * it silently.
   */
  overallProgress: number | null;
  /**
   * The trust profile could not be READ — not "the user has none".
   *
   * Same three-state shape `SafeTrustSummary` and `PublicTrustBadge` already
   * use, and deliberately the same field name: a caller that learns to check one
   * has learned to check all three.
   */
  profileUnavailable?: boolean;
}

const STEP_TEMPLATES: Record<string, (count: number) => string> = {
  plan_attendance:       (n) => `Attend ${n} more plans without cancelling`,
  host_quality:          (n) => `Host ${n} successful group plans`,
  communication:         (n) => `Reply to ${n} messages within 24 hours`,
  respect_safety:        (n) => `Complete ${n} safe-return check-ins`,
  location_honesty:      (n) => `Check in with verified GPS for ${n} plans`,
  content_quality:       (n) => `Post ${n} pieces of content with no reports`,
  community_value:       (n) => `Make ${n} positive contributions to your circle`,
  guide_accuracy:        (n) => `Verify ${n} hidden gems in person`,
  passport_authenticity: (n) => `Earn ${n} verified passport stamps`,
};

function stepCountForDeficit(deficit: number): number {
  if (deficit > 30) return 5;
  if (deficit > 15) return 3;
  return 2;
}

/** Generate recovery steps tailored to the user's score profile */
async function buildRecoverySteps(
  db: SupabaseClient,
  userId: string,
): Promise<RecoveryStep[]> {
  // getTrustProfileResult, not getTrustProfile: the lossy wrapper returns null
  // for "absent" and "unreadable" alike, and its own docblock says so. Steps are
  // empty either way -- but a caller that cannot tell an empty list from an
  // unreadable one will render "nothing to do" over an outage.
  const read = await getTrustProfileResult(db, userId);
  if (read.state !== "ok") return [];
  const profile = read.profile;

  const neutral = 50;
  const steps: RecoveryStep[] = [];
  let priority = 1;

  // Sort categories by how far below neutral they are
  const sorted = Object.entries(profile.categories)
    .map(([cat, score]) => ({ cat, score, deficit: Math.max(0, neutral - score) }))
    .filter((x) => x.deficit > 5)
    .sort((a, b) => b.deficit - a.deficit);

  for (const { cat, score, deficit } of sorted.slice(0, 4)) {
    const template = STEP_TEMPLATES[cat];
    if (!template) continue;
    const count = stepCountForDeficit(deficit);
    steps.push({
      category: cat,
      action: template(count),
      targetCount: count,
      currentProgress: 0,
      priority: priority++,
    });
  }

  return steps;
}

/** Get full recovery status for a user */
export async function getRecoveryStatus(
  db: SupabaseClient,
  userId: string,
): Promise<RecoveryStatus> {
  const [profileRead, caps, probation] = await Promise.all([
    getTrustProfileResult(db, userId),
    getActiveCaps(db, userId),
    db.from("trust_profiles").select("on_probation, probation_ends_at").eq("user_id", userId).maybeSingle(),
  ]);

  // The probation read's error was unbound, so an unreadable trust_profiles
  // produced onProbation:false -- "this user is not on probation", asserted
  // about a table nobody could read. It is the SAME table getTrustProfileResult
  // just reported on, so when that read failed this one has too.
  const probationUnreadable = Boolean((probation as any).error);
  if (probationUnreadable) {
    logger.warn(
      { err: (probation as any).error, userId },
      "trust_profiles probation read failed — reporting onProbation as unknown-shaped false alongside profileUnavailable, not as a fact",
    );
  }
  const onProbation = Boolean((probation.data as any)?.on_probation);
  const probationEndsAt = (probation.data as any)?.probation_ends_at ?? null;
  const unavailable = profileRead.state === "unavailable" || probationUnreadable;

  if (profileRead.state !== "ok") {
    return {
      userId, onProbation, probationEndsAt,
      activeCapsCount: caps.length,
      lowestCategory: null, lowestScore: null,
      suggestedSteps: [],
      // NOT 50. There is no profile, so there is no progress toward neutral to
      // report; 50 is exactly the neutral value a real measurement could hold,
      // which makes the fabrication indistinguishable from a reading.
      overallProgress: null,
      ...(unavailable ? { profileUnavailable: true } : {}),
    };
  }
  const profile = profileRead.profile;

  const entries = Object.entries(profile.categories);
  const [lowestCat, lowestScore] = entries.reduce(
    ([ac, as_], [c, s]) => s < as_ ? [c, s] : [ac, as_],
    ["", 100],
  );

  // Progress toward neutral (50) from the overall score
  const overallProgress = Math.min(100, Math.max(0, profile.overall_score));

  const suggestedSteps = await buildRecoverySteps(db, userId);

  return {
    userId, onProbation, probationEndsAt,
    activeCapsCount: caps.length,
    lowestCategory: lowestCat || null,
    lowestScore: lowestCat ? lowestScore : null,
    suggestedSteps,
    overallProgress,
  };
}

/** Set/unset probation (called by admin or after confirmed severe event) */
export async function setProbation(
  db: SupabaseClient,
  userId: string,
  onProbation: boolean,
  probationEndsAt?: string | null,
): Promise<void> {
  // non-fatal
  const { error } = await db.from("trust_profiles").upsert({
    user_id: userId,
    on_probation: onProbation,
    probation_ends_at: probationEndsAt ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) logger.warn({ err: error, userId }, "setProbation upsert failed (non-fatal)");
}
