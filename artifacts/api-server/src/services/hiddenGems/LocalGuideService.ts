/**
 * LocalGuideService
 *
 * Guide profile CRUD, contribution recording, and level computation.
 * Guide level (0–5) is derived from: accuracy score + helpful votes + contribution count.
 * No payout logic — level is tracked but monetisation is out of scope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordTrustEvent } from "../trust/TrustEventService.js";

/**
 * Compute guide level 0-5 from stats.
 *
 * NOTE ON helpful_votes: it is read here and weighted 0.4/point, but NOTHING
 * writes it — there is no vote endpoint, no vote table and no trigger — so the
 * term is always 0. That is deliberate for now rather than an oversight to
 * close: every candidate signal inspected (gem saves, GPS check-in visits, guide
 * verifications, upheld reports) is either already spent on another term of this
 * same score, or is a pre-verification popularity proxy that a fabricator earns
 * as easily as an honest guide. A quality metric fed by a signal that does not
 * mean quality is worse than an unused column, because the number would then be
 * believed. Leave it at 0 until a real "another user found this useful" signal
 * exists.
 *
 * accuracy_score, by contrast, IS now derived — see recomputeGuideAccuracy.
 */
function computeGuideLevel(
  contributionCount: number,
  helpfulVotes: number,
  accuracyScore: number,
): number {
  const score = (contributionCount * 0.4) + (helpfulVotes * 0.4) + (accuracyScore * 100 * 0.2);
  if (score >= 200) return 5;
  if (score >= 100) return 4;
  if (score >= 50)  return 3;
  if (score >= 20)  return 2;
  if (score >= 5)   return 1;
  return 0;
}

/** Apply to become a local guide. Idempotent. */
export async function applyForGuide(
  db: SupabaseClient,
  userId: string,
  bio?: string,
  cityExpertise?: string[],
): Promise<any> {
  const { data: existing } = await db
    .from("local_guide_profiles")
    .select("user_id, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await db
    .from("local_guide_profiles")
    .insert({
      user_id: userId,
      guide_level: 0,
      city_expertise: cityExpertise ?? [],
      bio: bio ?? null,
      status: "applicant",
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/** Get a guide's public profile. */
export async function getGuideProfile(
  db: SupabaseClient,
  userId: string,
): Promise<any | null> {
  const { data, error } = await db
    .from("local_guide_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Record a guide contribution and recompute guide level. */
export async function recordContribution(
  db: SupabaseClient,
  guideId: string,
  gemId: string | null,
  contributionType: string,
): Promise<void> {
  // Insert contribution record
  await db.from("local_guide_contributions").insert({
    guide_id: guideId,
    gem_id: gemId,
    contribution_type: contributionType,
  });

  // Reload profile to recompute level
  const { data: profile } = await db
    .from("local_guide_profiles")
    .select("contribution_count, helpful_votes, accuracy_score")
    .eq("user_id", guideId)
    .maybeSingle();

  if (!profile) return;

  const newCount = ((profile as any).contribution_count ?? 0) + 1;
  const newLevel = computeGuideLevel(
    newCount,
    (profile as any).helpful_votes ?? 0,
    (profile as any).accuracy_score ?? 0,
  );

  await db
    .from("local_guide_profiles")
    .update({
      contribution_count: newCount,
      guide_level: newLevel,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", guideId);

  // Feed guide contribution into Trust Engine (fire-and-forget; flag-gated internally)
  void recordTrustEvent(db, {
    userId: guideId,
    eventType: "guide_verification",
    category: "guide_accuracy",
    delta: 3,
    severity: "minor",
    sourceType: "local_guide",
    sourceId: gemId ?? undefined,
    dedupWindowHours: 6,
  });
}

/**
 * Recompute a guide's accuracy score from the actual fate of their submissions.
 *
 * `accuracy_score` and `helpful_votes` are both READ by computeGuideLevel above
 * but were written by nothing, so both were permanently 0 and guide level
 * advanced on `contribution_count` alone — pure volume, with no quality term.
 * A user could reach a high guide level by submitting a large number of gems
 * regardless of whether any of them were true.
 *
 * Accuracy is DERIVED from outcomes rather than drifted by increments, so it is
 * deterministic, auditable, and self-correcting: recomputing always yields the
 * same answer from the same data, and a reversed moderation decision restores
 * the score automatically. A stored counter that we nudged up and down would
 * drift out of agreement with reality the first time a decision was reversed.
 *
 *   verified  = the guide's gems a guide/admin has endorsed (guide_verified_by set)
 *   disputed  = the guide's gems hidden by moderation (an upheld report)
 *   accuracy  = verified / (verified + disputed)
 *
 * Returns 0 when there is no evidence either way, which is also the column
 * default — so a guide with no adjudicated submissions is treated as unproven
 * rather than as accurate. It contributes only 20% of the level score, so an
 * unproven guide is not blocked from levelling on contributions and votes.
 */
export async function recomputeGuideAccuracy(
  db: SupabaseClient,
  guideId: string,
): Promise<number> {
  let verified = 0;
  let disputed = 0;
  try {
    const { data, error } = await db
      .from("hidden_gems")
      .select("status, guide_verified_by")
      .eq("submitted_by", guideId);
    if (error) return 0;
    for (const g of ((data as any[]) ?? [])) {
      if (g.status === "hidden") disputed += 1;
      else if (g.guide_verified_by) verified += 1;
    }
  } catch {
    return 0;
  }

  const total = verified + disputed;
  const accuracy = total > 0 ? verified / total : 0;

  try {
    const { data: profile } = await db
      .from("local_guide_profiles")
      .select("contribution_count, helpful_votes")
      .eq("user_id", guideId)
      .maybeSingle();
    if (!profile) return accuracy; // not a guide — nothing to persist

    const newLevel = computeGuideLevel(
      (profile as any).contribution_count ?? 0,
      (profile as any).helpful_votes ?? 0,
      accuracy,
    );
    await db
      .from("local_guide_profiles")
      .update({
        accuracy_score: accuracy,
        guide_level: newLevel,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", guideId);
  } catch {
    /* non-fatal — the caller's moderation action must still succeed */
  }

  return accuracy;
}

/** Admin: approve or demote a guide. */
export async function setGuideStatus(
  db: SupabaseClient,
  userId: string,
  status: "active" | "suspended" | "demoted",
): Promise<void> {
  const patch: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };
  if (status === "active") patch.verified_at = new Date().toISOString();

  await db.from("local_guide_profiles").update(patch).eq("user_id", userId);
}
