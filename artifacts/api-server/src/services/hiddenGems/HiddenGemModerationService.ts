/**
 * HiddenGemModerationService
 *
 * Report intake, mark-sensitive, hide, merge-duplicate, admin review queue.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** Submit a report for a gem. */
export async function reportGem(
  db: SupabaseClient,
  gemId: string,
  reporterId: string,
  reason: string,
  notes?: string,
): Promise<{ ok: boolean; alreadyReported: boolean }> {
  const { data: existing } = await db
    .from("hidden_gem_reports")
    .select("id")
    .eq("gem_id", gemId)
    .eq("reporter_id", reporterId)
    .maybeSingle();

  if (existing) return { ok: true, alreadyReported: true };

  const { error } = await db
    .from("hidden_gem_reports")
    .insert({
      gem_id: gemId,
      reporter_id: reporterId,
      reason,
      notes: notes ?? null,
    });

  if (error) throw error;

  // Increment report_count
  try {
    await db.rpc("increment_hidden_gem_report_count" as any, { gem_id: gemId });
  } catch { /* ignore */ }

  return { ok: true, alreadyReported: false };
}

/** Mark a gem as sensitive (admin only). */
export async function markSensitive(
  db: SupabaseClient,
  gemId: string,
  sensitivityLevel: string,
): Promise<void> {
  await db
    .from("hidden_gems")
    .update({ sensitivity_level: sensitivityLevel, updated_at: new Date().toISOString() })
    .eq("id", gemId);
}

/** Hide a gem (admin action). */
export async function hideGem(db: SupabaseClient, gemId: string): Promise<void> {
  await db
    .from("hidden_gems")
    .update({ status: "hidden", updated_at: new Date().toISOString() })
    .eq("id", gemId);
}

/** Merge a duplicate into a canonical gem. */
export async function mergeDuplicate(
  db: SupabaseClient,
  duplicateGemId: string,
  canonicalGemId: string,
): Promise<void> {
  await db
    .from("hidden_gems")
    .update({
      status: "merged",
      merged_into: canonicalGemId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", duplicateGemId);
}

/** Admin queue: pending gems awaiting review. */
export async function getPendingQueue(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("hidden_gems")
    .select("id, name, category, city, country, sensitivity_level, submitted_by, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/** Admin queue: reported gems. */
export async function getReportedGems(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("hidden_gems")
    .select("id, name, category, city, country, report_count, status, updated_at")
    .gt("report_count", 0)
    .neq("status", "hidden")
    .order("report_count", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/** Admin queue: pending guide applications. */
export async function getGuideApplications(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("local_guide_profiles")
    .select("user_id, guide_level, city_expertise, contribution_count, status, created_at")
    .eq("status", "applicant")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}
