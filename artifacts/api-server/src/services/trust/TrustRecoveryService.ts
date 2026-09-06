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
import { getActiveCapsResult } from "./TrustCapService.js";

const logger = rootLogger.child({ service: "TrustRecoveryService" });
import { getTrustProfile } from "./TrustScoreService.js";

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
  overallProgress: number; // 0–100 % toward 50 (neutral)
  /**
   * True when the probation read FAILED, so `onProbation: false` /
   * `probationEndsAt: null` above are a guess, not an answer.
   *
   * The probation query destructured only `.data` and dropped `error`, and
   * supabase-js RETURNS errors rather than throwing — so an unreadable
   * trust_profiles produced `data: null`, `Boolean(undefined)` produced `false`,
   * and "this user is not on probation" was the literal output of a failed
   * query. That is fail-OPEN on a sanction, reported with the same confidence as
   * a real clean record, and it flows straight through
   * TrustPrivacyGuard.getSafeTrustSummary into the Passport.
   */
  probationUnknown: boolean;
  /**
   * True when the active-cap read failed, so `activeCapsCount: 0` means
   * "could not tell" rather than "no ceilings apply".
   */
  activeCapsUnknown: boolean;
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
  const profile = await getTrustProfile(db, userId);
  if (!profile) return [];

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
  const [profile, capsResult, probation] = await Promise.all([
    getTrustProfile(db, userId),
    getActiveCapsResult(db, userId),
    db.from("trust_profiles").select("on_probation, probation_ends_at").eq("user_id", userId).maybeSingle(),
  ]);

  const caps = capsResult.caps;
  const activeCapsUnknown = capsResult.failed;

  // `error` is READ, not discarded: without this the line below turns any failed
  // read into the confident claim "not on probation".
  const probationUnknown = Boolean((probation as any)?.error);
  if (probationUnknown) {
    logger.warn(
      { err: (probation as any).error, userId },
      "probation read failed — onProbation is unknown, not false",
    );
  }
  const onProbation = probationUnknown ? false : Boolean((probation.data as any)?.on_probation);
  const probationEndsAt = probationUnknown ? null : ((probation.data as any)?.probation_ends_at ?? null);

  if (!profile) {
    return {
      userId, onProbation, probationEndsAt, probationUnknown, activeCapsUnknown,
      activeCapsCount: caps.length,
      lowestCategory: null, lowestScore: null,
      suggestedSteps: [], overallProgress: 50,
    };
  }

  const entries = Object.entries(profile.categories);
  const [lowestCat, lowestScore] = entries.reduce(
    ([ac, as_], [c, s]) => s < as_ ? [c, s] : [ac, as_],
    ["", 100],
  );

  // Progress toward neutral (50) from the overall score
  const overallProgress = Math.min(100, Math.max(0, profile.overall_score));

  const suggestedSteps = await buildRecoverySteps(db, userId);

  return {
    userId, onProbation, probationEndsAt, probationUnknown, activeCapsUnknown,
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
