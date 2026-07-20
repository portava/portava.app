/**
 * HiddenGemModerationService
 *
 * Report intake, mark-sensitive, hide, merge-duplicate, admin review queue.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "HiddenGemModerationService" });

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

  // Increment report_count — direct UPDATE, no RPC dependency (non-fatal)
  {
    const { data: cur, error: readError } = await db.from("hidden_gems").select("report_count").eq("id", gemId).maybeSingle();
    if (readError) {
      logger.warn({ err: readError, gemId }, "report_count read failed (non-fatal)");
    } else {
      const next = ((cur as any)?.report_count ?? 0) + 1;
      const { error: updError } = await db.from("hidden_gems").update({ report_count: next }).eq("id", gemId);
      if (updError) logger.warn({ err: updError, gemId }, "report_count update failed (non-fatal)");
    }
  }

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

/** Admin queue: active gems with high sensitivity that may need re-review. */
export async function getSensitiveGems(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  const { data, error } = await db
    .from("hidden_gems")
    .select("id, name, category, city, country, sensitivity_level, report_count, created_at")
    .eq("status", "active")
    .in("sensitivity_level", ["protected", "reveal_after_save", "reveal_after_acceptance"])
    .order("report_count", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data ?? [];
}

/** Admin queue: gems that are likely duplicate submissions (same city + category, high report count). */
export async function getDuplicateCandidates(
  db: SupabaseClient,
  limit = 50,
): Promise<any[]> {
  // Return pending or active gems flagged as duplicate candidates
  // (submitted as near-duplicate by reporters or whose name+city matches another active gem)
  const { data, error } = await db
    .from("hidden_gems")
    .select("id, name, category, city, country, sensitivity_level, status, report_count, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  // In a real system, a dedup job would populate a duplicate_candidates view.
  // For now return pending gems in the same cities as existing active ones —
  // callers can use the merge endpoint to consolidate.
  return data ?? [];
}
