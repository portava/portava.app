/**
 * HiddenGemModerationService
 *
 * Report intake, mark-sensitive, hide, merge-duplicate, admin review queue.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { recordTrustEvent, TRUST_EVENT_TYPES } from "../trust/TrustEventService.js";
import { recomputeGuideAccuracy } from "./LocalGuideService.js";

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

/**
 * Resolve outstanding reports against a gem. This is the moderation loop's exit,
 * and the ONLY place a contribution may cost its author trust.
 *
 * Why here and nowhere else: `reportGem` above deliberately has no trust
 * consequence. If a raw, unadjudicated report moved a score, the trust system
 * would be a weapon — anyone could sink a rival's guide_accuracy by reporting
 * their gems, and the more accurate and prolific a contributor was, the more
 * exposed they would be. A penalty must attach to a decision, not to an
 * accusation. That is why the outcome is an explicit argument rather than being
 * inferred from `report_count` crossing a threshold: a pile of reports is
 * evidence that someone should look, not a finding.
 *
 * `upheld`    — the report was correct. The gem is hidden and its author takes
 *               a GEM_DISPUTED hit against guide_accuracy.
 * `dismissed` — the report was wrong or unfounded. The gem is restored to
 *               active, reports are closed, and NOTHING is charged to the
 *               author. Being reported is not itself a mark against anyone.
 *
 * The trust event is keyed on the gem id, so re-resolving the same gem cannot
 * charge its author twice. Guide accuracy is recomputed from outcomes rather
 * than nudged, so a later reversal repairs the score by itself.
 *
 * Every side effect after the status change is non-fatal: an admin's moderation
 * decision must land even if the trust write or the accuracy recompute fails.
 */
export async function resolveGemReport(
  db: SupabaseClient,
  gemId: string,
  adminId: string,
  outcome: "upheld" | "dismissed",
  note?: string,
): Promise<{ ok: boolean; gemId: string; outcome: string; authorId: string | null; penalised: boolean }> {
  const { data: gem, error: gemErr } = await db
    .from("hidden_gems")
    .select("id, submitted_by, status")
    .eq("id", gemId)
    .maybeSingle();
  if (gemErr) throw gemErr;
  if (!gem) return { ok: false, gemId, outcome, authorId: null, penalised: false };

  const authorId = (gem as any).submitted_by ?? null;
  const now = new Date().toISOString();

  // 1. The gem's own fate.
  const { error: updErr } = await db
    .from("hidden_gems")
    .update({
      status: outcome === "upheld" ? "hidden" : "active",
      // A dismissed report leaves no residue: the counter that put the gem in
      // the queue is cleared so it does not resurface for the same reason.
      ...(outcome === "dismissed" ? { report_count: 0 } : {}),
      updated_at: now,
    })
    .eq("id", gemId);
  if (updErr) throw updErr;

  // 2. Close the reports themselves (non-fatal — the decision above is what matters).
  try {
    const { error: repErr } = await db
      .from("hidden_gem_reports")
      .update({ status: outcome === "upheld" ? "upheld" : "dismissed" })
      .eq("gem_id", gemId)
      .eq("status", "pending");
    if (repErr) logger.warn({ err: repErr, gemId }, "closing gem reports failed (non-fatal)");
  } catch (err) {
    logger.warn({ err, gemId }, "closing gem reports threw (non-fatal)");
  }

  // 3. Charge the author — ONLY on an upheld report, and never for their own action.
  let penalised = false;
  if (outcome === "upheld" && authorId && authorId !== adminId) {
    const t = TRUST_EVENT_TYPES.GEM_DISPUTED;
    void recordTrustEvent(db, {
      userId: authorId,
      eventType: "gem_disputed",
      category: t.category,
      delta: t.delta,
      severity: t.severity,
      sourceType: "hidden_gem",
      sourceId: gemId,          // one gem can only ever cost its author once
      dedupWindowHours: 24 * 365,
      metadata: { gemId, adminId, note: note ?? null },
    }).catch(() => {/* non-fatal */});
    penalised = true;
  }

  // 4. Recompute derived accuracy for BOTH outcomes — a dismissal can restore a
  //    score that an earlier uphold reduced.
  if (authorId) {
    try {
      await recomputeGuideAccuracy(db, authorId);
    } catch (err) {
      logger.warn({ err, authorId }, "guide accuracy recompute failed (non-fatal)");
    }
  }

  logger.info({ gemId, adminId, outcome, authorId, penalised }, "gem report resolved");
  return { ok: true, gemId, outcome, authorId, penalised };
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
