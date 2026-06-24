/**
 * LocalGuideService
 *
 * Guide profile CRUD, contribution recording, and level computation.
 * Guide level (0–5) is derived from: accuracy score + helpful votes + contribution count.
 * No payout logic — level is tracked but monetisation is out of scope.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Compute guide level 0–5 from stats. */
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
