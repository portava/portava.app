/** L112: a model can offer this recheck; only the owner's explicit action endpoint can execute it. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import { getSession, layoverSessionIsLiveAt } from "./LayoverSessionService.js";
import { evaluate } from "./LayoverFeasibilityService.js";
import { resolveSessionAirport } from "./LayoverSnapshot.js";
import { generateRecommendations, type GenerateRecommendationsOptions } from "./LayoverRecommendationService.js";
import { readActiveSnapshot } from "../layover/layoverActiveSnapshotRead.js";
import { supersedeCards } from "../layover/LayoverRecommendationStatus.js";

export interface CompassReplanAction {
  id: string; kind: "recheck_current_facts"; label: string; description: string;
  snapshotId: string; expiresAt: string;
}
const resultSchema = z.object({
  state: z.enum(["applied", "partial", "failed"]), reason: z.string().nullable(), snapshotId: z.string().nullable(),
  recommendationsUpdated: z.boolean(), supersededCount: z.number().int().nonnegative(), completedAt: z.string().datetime(),
});
export type CompassReplanOutcome = z.infer<typeof resultSchema>;
type Refusal = { ok: false; reason: string };
export type CompassReplanExecution = { ok: true; duplicate: boolean; result: CompassReplanOutcome } | Refusal;

async function enabled(db: SupabaseClient): Promise<boolean> {
  if (!(await isFlagEnabled(db, "layover_compass_replan_enabled"))) return false;
  const dependencies = await Promise.all([
    isFlagEnabled(db, "layover_compass_assistant_enabled"), isFlagEnabled(db, "layover_canonical_snapshot_enabled"),
    isFlagEnabled(db, "layover_decision_persistence_enabled"), isFlagEnabled(db, "layover_recommendation_status_enabled"), isFlagEnabled(db, "layover_stable_recommendation_ids_enabled"), // stableIds: true below sweeps unkeyed legacy cards: only after 2411 and the cutover
  ]);
  return dependencies.every(Boolean);
}

/** Proposal contains a fixed operation, never the model's hypothetical event or payload. */
export async function proposeCompassReplan(db: SupabaseClient, userId: string, sessionId: string, expectedSnapshotId: string, nowMs = Date.now()): Promise<{ ok: true; action: CompassReplanAction } | Refusal> {
  try {
    if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
    const owned = await getSession(db, sessionId, userId);
    if (!owned.ok) return { ok: false, reason: "session_unreadable" };
    if (!owned.session) return { ok: false, reason: "not_found" };
    if (!layoverSessionIsLiveAt(owned.session, nowMs)) return { ok: false, reason: "session_ended" };
    const active = await readActiveSnapshot(db, sessionId);
    if (!active.ok) return { ok: false, reason: active.reason };
    if (active.active?.snapshotId !== expectedSnapshotId) return { ok: false, reason: "action_stale" };
    const id = randomUUID(), createdAt = new Date(nowMs).toISOString(), expiresAt = new Date(nowMs + 300_000).toISOString();
    const { error } = await db.from("layover_compass_actions").insert({
      id, session_id: sessionId, user_id: userId, kind: "recheck_current_facts", expected_snapshot_id: expectedSnapshotId,
      expected_session_updated_at: owned.session.updatedAt, created_at: createdAt, expires_at: expiresAt,
    });
    if (error) { logger.warn({ err: error, sessionId }, "Compass replan proposal unavailable"); return { ok: false, reason: "action_unavailable" }; }
    return { ok: true, action: { id, kind: "recheck_current_facts", label: "Recheck plan with saved details", description: "Refresh recommendations using your saved flight details and current verified conditions. Report changed flight details before rechecking.", snapshotId: expectedSnapshotId, expiresAt } };
  } catch (err) {
    logger.warn({ err, sessionId }, "Compass replan proposal failed"); return { ok: false, reason: "action_unavailable" };
  }
}

/** Called only by the authenticated explicit-approval route; no model invocation calls this function. */
export async function executeCompassReplan(db: SupabaseClient, userId: string, sessionId: string, actionId: string, opts: GenerateRecommendationsOptions = {}): Promise<CompassReplanExecution> {
  if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
  const { data: claim, error: claimError } = await db.rpc("claim_layover_compass_replan", { p_action_id: actionId, p_session_id: sessionId, p_user_id: userId });
  if (claimError) { logger.warn({ err: claimError, sessionId }, "Compass replan claim unavailable"); return { ok: false, reason: "action_claim_unavailable" }; }
  if (claim?.claimed !== true) {
    if (claim?.reason === "completed") {
      const parsed = resultSchema.safeParse(claim.result);
      return parsed.success ? { ok: true, duplicate: true, result: parsed.data } : { ok: false, reason: "action_result_unreadable" };
    }
    return { ok: false, reason: typeof claim?.reason === "string" ? claim.reason : "action_claim_unavailable" };
  }
  let snapshotId: string | null = null, supersededCount = 0, recommendationsUpdated = false;
  const finish = async (state: CompassReplanOutcome["state"], reason: string | null): Promise<CompassReplanExecution> => {
    const result: CompassReplanOutcome = { state, reason, snapshotId, supersededCount, recommendationsUpdated, completedAt: new Date().toISOString() };
    const { data, error } = await db.from("layover_compass_actions").update({ status: state === "applied" ? "applied" : "failed", result, completed_at: result.completedAt })
      .eq("id", actionId).eq("session_id", sessionId).eq("user_id", userId).eq("status", "running").select("id");
    if (error || data?.length !== 1) {
      logger.warn({ err: error, sessionId, actionId }, "Compass replan outcome was not recorded; action remains claimed");
      return { ok: true, duplicate: false, result: { ...result, state: snapshotId || recommendationsUpdated ? "partial" : "failed", reason: "action_result_not_recorded" } };
    }
    return { ok: true, duplicate: false, result };
  };
  try {
    const nowMs = Date.now();
    const evaluated = await evaluate(db, userId, sessionId, { nowMs });
    if (!evaluated.ok) return finish("failed", evaluated.reason);
    if (!evaluated.storage.stored) return finish("failed", "snapshot_unavailable");
    snapshotId = evaluated.storage.snapshotId;
    if (!(await enabled(db))) return finish("partial", "feature_disabled_during_replan");
    const supersession = await supersedeCards(db, { sessionId, currentSnapshotId: snapshotId, cause: "regeneration" });
    if (!supersession.applied) return finish("partial", `supersession_${supersession.reason}`);
    supersededCount = supersession.superseded.length;
    const owned = await getSession(db, sessionId, userId);
    if (!owned.ok || !owned.session) return finish("partial", "session_unreadable");
    const airport = await resolveSessionAirport(db, owned.session);
    if (!airport.ok) return finish("partial", "airport_unreadable");
    if (!(await enabled(db))) return finish("partial", "feature_disabled_during_replan");
    const generated = await generateRecommendations(db, airport.airport, owned.session, nowMs, { ...opts, stableIds: true });
    if (!generated.ok) return finish("partial", "recommendations_unavailable");
    recommendationsUpdated = true;
    const active = await readActiveSnapshot(db, sessionId);
    if (!active.ok || !generated.snapshotId || active.active?.snapshotId !== generated.snapshotId) return finish("partial", "snapshot_changed_during_replan");
    snapshotId = generated.snapshotId;
    return finish("applied", null);
  } catch (err) {
    logger.warn({ err, sessionId, actionId }, "Compass replan failed after authorization");
    return finish(snapshotId ? "partial" : "failed", "replan_unavailable");
  }
}
