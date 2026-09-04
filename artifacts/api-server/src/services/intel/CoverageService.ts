/**
 * Intelligence Gathering — Coverage service (IG-08).
 *
 * The impure half of coverage/mission: it reads gap inputs, ranks coverage
 * cells, and drives the mission lifecycle (generate → dispatch → accept) over
 * public.intel_mission_candidates. Pure math lives in lib/coverageScore.ts and
 * lib/missionGeneration.ts.
 *
 * GATING (spec §26 intel_missions = "Stop dispatch; honor accepted commitments"):
 *   • computeCoverage      — UNGATED (read-only derivation for the gap dashboard)
 *   • generateMissions     — gated: flag off ⇒ generates nothing
 *   • commitAndDispatch    — gated: flag off ⇒ no dispatch; atomic budget commit
 *   • acceptMission        — UNGATED: an already-dispatched commitment is honored
 *                             even after the flag is turned off
 *
 * NON-CASH: every candidate carries cash_amount 0 (the table CHECK enforces it).
 */
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { computeCoverageScore, type CoverageInputs, type CoverageBreakdown } from "../../lib/coverageScore.js";
import {
  buildMissionCandidate, shouldGenerateMission,
  type MissionTriggerContext, type BuildMissionInput,
} from "../../lib/missionGeneration.js";

const MISSIONS_FLAG = "intel_missions";

export interface CoverageCell extends CoverageInputs {
  zoneId: string | null;
}
export interface RankedCoverageCell extends CoverageBreakdown {
  claimFamily: string;
  zoneId: string | null;
}

/**
 * Rank coverage cells by priority, highest gap first. Read-only and ungated:
 * the gap dashboard may always see where coverage is thin. Input assembly
 * (demand counts, claim freshness) is the caller's concern; this ranks what it
 * is given so it stays pure and testable.
 */
export function computeCoverage(cells: readonly CoverageCell[]): RankedCoverageCell[] {
  return cells
    .map((c) => ({ ...computeCoverageScore(c), claimFamily: c.claimFamily, zoneId: c.zoneId }))
    .sort((a, b) => b.score - a.score);
}

export interface MissionGenSpec {
  ctx: MissionTriggerContext;
  mission: BuildMissionInput;
}

/**
 * Generate mission candidates for the specs whose triggers fire. Flag off ⇒ no
 * generation (returns []). Each candidate is written non-cash and uncommitted.
 */
export async function generateMissions(sc: any, specs: readonly MissionGenSpec[]): Promise<{ ok: boolean; created: any[]; reason?: string }> {
  if (!(await isFlagEnabled(sc, MISSIONS_FLAG))) return { ok: false, created: [], reason: "disabled" };
  const created: any[] = [];
  for (const spec of specs) {
    if (!shouldGenerateMission(spec.ctx)) continue;
    const trigger = spec.mission.trigger;
    const cand = buildMissionCandidate(spec.mission);
    const row = {
      city: cand.city,
      zone_id: cand.zoneId,
      claim_family: cand.claimFamily,
      trigger,
      coverage_score: cand.coverageScore,
      question: cand.question,
      budget_units: cand.budgetUnits,
      budget_committed: cand.budgetCommitted,
      cash_amount: cand.cashAmount, // 0
      status: cand.status,
    };
    const { data, error } = await sc.from("intel_mission_candidates").insert(row).select().single();
    if (error) return { ok: false, created, reason: String((error as any).message ?? "db_error") };
    created.push(data);
  }
  return { ok: true, created };
}

/**
 * §16 "Mission budget is committed atomically before dispatch." Commit the
 * (non-cash) budget AND move to dispatched in ONE statement, guarded on the
 * candidate still being a candidate — so a half-committed mission can never
 * dispatch, and a double-dispatch is a no-op. Flag off ⇒ refused.
 */
export async function commitAndDispatch(sc: any, missionId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!(await isFlagEnabled(sc, MISSIONS_FLAG))) return { ok: false, reason: "disabled" };
  const { data, error } = await sc
    .from("intel_mission_candidates")
    .update({ budget_committed: true, status: "dispatched", updated_at: new Date().toISOString() })
    .eq("id", missionId)
    .eq("status", "candidate")
    .select()
    .maybeSingle();
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  if (!data) return { ok: false, reason: "not_dispatchable" }; // gone, already dispatched, or missing
  return { ok: true };
}

/**
 * Accept a dispatched mission. UNGATED: honoring a commitment must survive the
 * flag being switched off. Guarded on status='dispatched' so nothing that was
 * never dispatched can be accepted.
 */
export async function acceptMission(sc: any, missionId: string, actorId: string): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await sc
    .from("intel_mission_candidates")
    .update({ status: "accepted", accepted_by: actorId, updated_at: new Date().toISOString() })
    .eq("id", missionId)
    .eq("status", "dispatched")
    .select()
    .maybeSingle();
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  if (!data) return { ok: false, reason: "not_acceptable" };
  return { ok: true };
}

/** A mission outcome (§16). 'negative' is a fully VALID completion, never a failure. */
export type MissionResult = "positive" | "negative" | "inconclusive";
export const MISSION_RESULTS: readonly MissionResult[] = ["positive", "negative", "inconclusive"];

/**
 * Complete an accepted mission (§16, AT-13). UNGATED — like accept, honoring a
 * commitment must survive the flag being off. Guarded on status='accepted'. A
 * `negative` result is accepted exactly like any other: the DB CHECK requires a
 * result on completion but never forbids negative. The evidence_contract's
 * required shape is enforced at the DB (a mission cannot reach 'completed' without
 * `required_evidence`), so a contributor who satisfied a negative-result contract
 * is completed and (once funded) paid.
 *
 * Reads the mission NONCE if the column exists (unit I3 owns it), but never writes
 * it — this only advances the lifecycle state.
 */
export async function completeMission(
  sc: any, missionId: string, result: MissionResult,
): Promise<{ ok: boolean; reason?: string }> {
  if (!MISSION_RESULTS.includes(result)) return { ok: false, reason: "invalid_result" };
  const { data, error } = await sc
    .from("intel_mission_candidates")
    .update({ status: "completed", result, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", missionId)
    .eq("status", "accepted")
    .select()
    .maybeSingle();
  if (error) {
    // A DB CHECK rejection (e.g. evidence_contract missing required_evidence) is a
    // contract failure, surfaced distinctly from an infra error so the caller can
    // tell "your mission is not completable yet" from "the write broke".
    return { ok: false, reason: String((error as any).message ?? "db_error") };
  }
  if (!data) return { ok: false, reason: "not_completable" };
  return { ok: true };
}

/**
 * Decline (or abort) a mission WITHOUT PENALTY (§22 "Contributors may decline or
 * abort unsafe work without conduct penalty"). Allowed from 'dispatched' or
 * 'accepted'. There is no conduct/penalty side effect anywhere — the absence of
 * one is the guarantee; this only records the terminal state + optional reason.
 */
export async function declineMission(
  sc: any, missionId: string, reason?: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { data, error } = await sc
    .from("intel_mission_candidates")
    .update({ status: "declined", declined_at: new Date().toISOString(), decline_reason: reason ?? null, updated_at: new Date().toISOString() })
    .eq("id", missionId)
    .in("status", ["dispatched", "accepted"])
    .select()
    .maybeSingle();
  if (error) return { ok: false, reason: String((error as any).message ?? "db_error") };
  if (!data) return { ok: false, reason: "not_declinable" };
  return { ok: true };
}
