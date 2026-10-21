/**
 * LayoverCrewPlanStore — §14.1 explicit split plans (census-layover L134, L135), storage half.
 *
 * Migration 3872: `layover_crew_plans` (one PROPOSED plan per crew) and `layover_crew_plan_branches` (immutable
 * branches: members, the branch's T — `return_by`, back at the airport by — and stops). Service role only; the
 * routes are the only door (routes/airport.ts, `/airport/sessions/:id/crew/plan`).
 *
 * WHAT THIS FILE DOES NOT DO: certify. Feasibility is a function of every member's CURRENT certified record and of
 * the clock, so the route certifies the plan on every read (`certifyTimedCrewPlan`, LayoverCrewService.ts) and
 * nothing here stores a verdict.
 *
 * THE GATE: `layover_crew_split_plans_enabled` (seeded FALSE by 3872), spelled as a literal at the one read so
 * check:flag-polarity can see it. OFF / absent / unreadable: nothing is read or written. A failed read is a refusal
 * (`ok: false`), never "no plan" — a traveller told there is no split would follow the crew's shared deadline while
 * a crewmate follows a different one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import type { CrewPlanStop } from "../airport/LayoverCrewService.js";

const logger = rootLogger.child({ service: "LayoverCrewPlanStore" });

export const CREW_SPLIT_PLANS_FLAG = "layover_crew_split_plans_enabled";

/** 3872's CHECK: 1..4 branches per plan (position 0..3), 1..12 members, at most 12 stops. */
export const CREW_PLAN_MAX_BRANCHES = 4;
export const CREW_PLAN_MAX_STOPS = 12;
/** The branch that holds every member the proposer did not place explicitly. */
export const CREW_PLAN_REST_BRANCH = "rest";

export interface StoredCrewBranch {
  key: string;
  position: number;
  memberUserIds: string[];
  /** ISO instant the branch is back at the airport (the spec's T1 / T2). */
  returnBy: string;
  stops: CrewPlanStop[];
}

export interface StoredCrewPlan {
  id: string;
  crewId: string;
  proposedBy: string;
  proposedSessionId: string;
  crewVersion: string;
  createdAt: string;
  branches: StoredCrewBranch[];
}

export type CrewPlanRead = { ok: true; plan: StoredCrewPlan | null } | { ok: false; reason: "plans_disabled" | "read_failed" };

/** True only when the split-plan feature is on. Unreadable = off (the shared fail-closed reader). */
export async function crewSplitPlansEnabled(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, "layover_crew_split_plans_enabled");
}

/** A stop as stored: the four fields `planFitTotals` reads, and nothing that could carry a position. */
export function normaliseCrewPlanStop(raw: unknown): CrewPlanStop | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const title = typeof s.title === "string" ? s.title.trim() : "";
  const durationMin = s.durationMin;
  const travelMin = s.travelMin;
  if (!title || title.length > 120) return null;
  if (typeof durationMin !== "number" || !Number.isInteger(durationMin) || durationMin < 0 || durationMin > 24 * 60) return null;
  if (typeof travelMin !== "number" || !Number.isInteger(travelMin) || travelMin < 0 || travelMin > 12 * 60) return null;
  if (typeof s.insideAirport !== "boolean") return null;
  return { title, durationMin, travelMin, insideAirport: s.insideAirport };
}

function toBranch(r: Record<string, any>): StoredCrewBranch | null {
  const stopsRaw = Array.isArray(r.stops_json) ? r.stops_json : [];
  const stops: CrewPlanStop[] = [];
  for (const s of stopsRaw) {
    const n = normaliseCrewPlanStop(s);
    // A stored stop that no longer parses is not silently dropped: a branch with a stop missing would certify
    // against fewer minutes than were proposed. The read refuses instead.
    if (!n) return null;
    stops.push(n);
  }
  if (!Array.isArray(r.member_user_ids) || typeof r.branch_key !== "string" || typeof r.return_by !== "string") return null;
  return {
    key: r.branch_key,
    position: Number(r.position),
    memberUserIds: (r.member_user_ids as unknown[]).map(String),
    returnBy: new Date(r.return_by).toISOString(),
    stops,
  };
}

/**
 * The crew's live (proposed) plan with its branches, or null when there is none. Behind the flag: OFF answers
 * `plans_disabled` and reads nothing.
 */
export async function readLiveCrewPlan(db: SupabaseClient, crewId: string): Promise<CrewPlanRead> {
  if (!(await crewSplitPlansEnabled(db))) return { ok: false, reason: "plans_disabled" };
  const { data: plans, error } = await db
    .from("layover_crew_plans")
    .select("id, crew_id, proposed_by, proposed_session_id, crew_version, created_at")
    .eq("crew_id", crewId)
    .eq("status", "proposed")
    .limit(2);
  if (error) {
    logger.warn({ err: error.message, crewId }, "crew plan read failed — refusing rather than reporting no plan");
    return { ok: false, reason: "read_failed" };
  }
  const rows = (plans ?? []) as Array<Record<string, any>>;
  if (rows.length === 0) return { ok: true, plan: null };
  if (rows.length > 1) {
    // 3872's partial unique index makes this impossible; if it ever happens the plan is ambiguous, not "the first".
    logger.error({ crewId, count: rows.length }, "crew plan read: more than one live plan — refusing");
    return { ok: false, reason: "read_failed" };
  }
  const p = rows[0]!;
  const { data: branchRows, error: bErr } = await db
    .from("layover_crew_plan_branches")
    .select("branch_key, position, member_user_ids, return_by, stops_json")
    .eq("plan_id", p.id)
    .order("position", { ascending: true })
    .limit(CREW_PLAN_MAX_BRANCHES);
  if (bErr) {
    logger.warn({ err: bErr.message, crewId }, "crew plan branches unreadable — refusing rather than serving a plan without them");
    return { ok: false, reason: "read_failed" };
  }
  const branches: StoredCrewBranch[] = [];
  for (const r of (branchRows ?? []) as Array<Record<string, any>>) {
    const b = toBranch(r);
    if (!b) {
      logger.error({ crewId, planId: p.id }, "crew plan branch unparseable — refusing rather than certifying a partial plan");
      return { ok: false, reason: "read_failed" };
    }
    branches.push(b);
  }
  if (branches.length === 0) {
    logger.error({ crewId, planId: p.id }, "crew plan has no branches — refusing");
    return { ok: false, reason: "read_failed" };
  }
  return {
    ok: true,
    plan: {
      id: String(p.id),
      crewId: String(p.crew_id),
      proposedBy: String(p.proposed_by),
      proposedSessionId: String(p.proposed_session_id),
      crewVersion: String(p.crew_version),
      createdAt: new Date(p.created_at).toISOString(),
      branches,
    },
  };
}

export type CrewPlanWrite =
  | { ok: true; planId: string }
  | { ok: false; reason: "plans_disabled" | "conflict" | "refused" | "write_failed"; detail?: string };

/**
 * Store a proposal: supersede the crew's live plan and write this one with all of its branches, in ONE database
 * transaction (3872's `layover_propose_crew_plan`). The caller has already CERTIFIED it; this stores nothing it
 * was not shown.
 */
export async function proposeCrewPlan(
  db: SupabaseClient,
  input: { crewId: string; userId: string; sessionId: string; crewVersion: string; branches: StoredCrewBranch[] },
): Promise<CrewPlanWrite> {
  if (!(await crewSplitPlansEnabled(db))) return { ok: false, reason: "plans_disabled" };
  const payload = input.branches.map((b) => ({ key: b.key, memberUserIds: b.memberUserIds, returnBy: b.returnBy, stops: b.stops }));
  const { data, error } = await db.rpc("layover_propose_crew_plan", {
    p_crew_id: input.crewId,
    p_user_id: input.userId,
    p_session_id: input.sessionId,
    p_crew_version: input.crewVersion,
    p_branches: payload,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23505") return { ok: false, reason: "conflict" };
    if (code === "23514") {
      logger.warn({ err: error.message, crewId: input.crewId }, "crew plan refused by 3872's guard");
      return { ok: false, reason: "refused", detail: error.message };
    }
    logger.warn({ err: error.message, crewId: input.crewId }, "crew plan write failed");
    return { ok: false, reason: "write_failed" };
  }
  if (typeof data !== "string" || data.length === 0) {
    logger.warn({ crewId: input.crewId }, "crew plan write returned no id — treated as failed");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, planId: data };
}

export type CrewPlanWithdraw = { ok: true; withdrawn: number } | { ok: false; reason: "plans_disabled" | "write_failed" };

/** Withdraw the crew's live plan (any live member may). Idempotent: no live plan is `withdrawn: 0`. */
export async function withdrawCrewPlan(db: SupabaseClient, crewId: string, nowIso: string): Promise<CrewPlanWithdraw> {
  if (!(await crewSplitPlansEnabled(db))) return { ok: false, reason: "plans_disabled" };
  const { data, error } = await db
    .from("layover_crew_plans")
    .update({ status: "withdrawn", ended_at: nowIso })
    .eq("crew_id", crewId)
    .eq("status", "proposed")
    .select("id");
  if (error) {
    logger.warn({ err: error.message, crewId }, "crew plan withdraw failed");
    return { ok: false, reason: "write_failed" };
  }
  return { ok: true, withdrawn: Array.isArray(data) ? data.length : 0 };
}
