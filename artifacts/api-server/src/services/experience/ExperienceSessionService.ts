/**
 * Purpose-limited ExperienceSession boundary.
 *
 * A session records the lifecycle of one recommendation exposure, not a
 * person's movement, presence, or sensor history.  All writes are scoped to
 * the authenticated owner; anonymous contributors and social-presence rows
 * are intentionally not accepted by this API.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EXPERIENCE_OUTCOMES,
  type ExperienceOutcomeKind,
  type ExperienceSessionPurpose,
  type ExperienceSessionStatus,
} from "../../lib/worldExperienceContracts.js";

export const EXPERIENCE_SESSION_VERSION = "experience-session-v1";
export const EXPERIENCE_OUTCOME_VERSION = "experience-outcome-v1";
export const CALIBRATION_VERSION = "calibration-v1";

export const SIGNIFICANT_OUTCOMES = EXPERIENCE_OUTCOMES;
export type SignificantOutcome = ExperienceOutcomeKind;
export type SessionStatus = ExperienceSessionStatus;

export interface StartExperienceSessionInput {
  recommendationId: string;
  purpose?: ExperienceSessionPurpose;
}

export interface RecordExperienceOutcomeInput {
  sessionId: string;
  outcome: ExperienceOutcomeKind;
  occurredAt?: string;
  /** Explicit confirmation is required before an outcome can become significant. */
  confirmMemory?: boolean;
}

export interface ExperienceResult {
  ok: boolean;
  reason?: "invalid_input" | "db_unavailable" | "not_found" | "forbidden" | "duplicate" | "error";
  sessionId?: string;
  outcomeId?: string;
  memoryEligible?: boolean;
  calibrationVersion?: string;
}

function validId(value: unknown, max = 240): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function safeIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

async function findOwnedSession(db: SupabaseClient, userId: string, sessionId: string): Promise<any | null> {
  const { data, error } = await db.from("experience_sessions")
    .select("id, user_id, status, expires_at, recommendation_id, item_id, item_type, projection_version")
    .eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) return null;
  return data ?? null;
}

export async function startExperienceSession(
  db: SupabaseClient | null,
  userId: string,
  input: StartExperienceSessionInput,
): Promise<ExperienceResult> {
  if (!db) return { ok: false, reason: "db_unavailable" };
  if (!validId(userId) || !validId(input?.recommendationId)) {
    return { ok: false, reason: "invalid_input" };
  }
  try {
    const served = await db.from("compass_served_recommendations")
      .select("recommendation_id, item_id, item_type, created_at")
      .eq("recommendation_id", input.recommendationId).eq("user_id", userId).maybeSingle();
    if (served.error) return { ok: false, reason: "error" };
    if (!served.data) return { ok: false, reason: "not_found" };
    const existing = await db.from("experience_sessions").select("id").eq("user_id", userId)
      .eq("recommendation_id", input.recommendationId).maybeSingle();
    if (existing.error) return { ok: false, reason: "error" };
    if (existing.data?.id) return { ok: true, sessionId: String(existing.data.id) };
    // The unique owner/recommendation key makes retries idempotent. Values are
    // server-derived from the served registry; clients cannot rebind or reopen.
    const { data, error } = await db.from("experience_sessions").insert({
      user_id: userId,
      recommendation_id: input.recommendationId,
      item_id: served.data.item_id,
      item_type: served.data.item_type,
      purpose: input.purpose ?? "recommendation",
      status: "open",
      projection_version: EXPERIENCE_SESSION_VERSION,
      expires_at: new Date(Date.parse(served.data.created_at) + 24 * 60 * 60 * 1000).toISOString(),
    }).select("id").single();
    if (error && String((error as any).code) === "23505") {
      const retry = await db.from("experience_sessions").select("id").eq("user_id", userId)
        .eq("recommendation_id", input.recommendationId).single();
      return retry.data?.id ? { ok: true, sessionId: String(retry.data.id) } : { ok: false, reason: "error" };
    }
    if (error || !data?.id) return { ok: false, reason: "error" };
    return { ok: true, sessionId: String(data.id) };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function closeExperienceSession(
  db: SupabaseClient | null,
  userId: string,
  sessionId: string,
  status: Exclude<SessionStatus, "open" | "expired"> = "completed",
): Promise<ExperienceResult> {
  if (!db) return { ok: false, reason: "db_unavailable" };
  if (!validId(userId) || !validId(sessionId) || !["completed", "abandoned"].includes(status)) {
    return { ok: false, reason: "invalid_input" };
  }
  try {
    const owned = await findOwnedSession(db, userId, sessionId);
    if (!owned) return { ok: false, reason: "not_found" };
    const { error } = await db.from("experience_sessions").update({
      status, closed_at: new Date().toISOString(),
    }).eq("id", sessionId).eq("user_id", userId);
    return error ? { ok: false, reason: "error" } : { ok: true, sessionId };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export async function recordExperienceOutcome(
  db: SupabaseClient | null,
  userId: string,
  input: RecordExperienceOutcomeInput,
): Promise<ExperienceResult> {
  if (!db) return { ok: false, reason: "db_unavailable" };
  if (!validId(userId) || !validId(input?.sessionId) || !SIGNIFICANT_OUTCOMES.includes(input.outcome)) {
    return { ok: false, reason: "invalid_input" };
  }
  try {
    const nowMs = Date.now();
    const session = await findOwnedSession(db, userId, input.sessionId);
    if (!session) return { ok: false, reason: "not_found" };
    if (session.status !== "open" || (session.expires_at && Date.parse(session.expires_at) <= nowMs)) {
      return { ok: false, reason: "not_found" };
    }
    const significant = new Set<SignificantOutcome>(["liked", "invited", "made_memory", "returned"]);
    const significance = significant.has(input.outcome) && input.confirmMemory === true ? "significant" : "routine";
    const memoryEligible = significance === "significant";
    const calibrationVersion = CALIBRATION_VERSION;
    const occurredAt = safeIso(input.occurredAt) ?? new Date(nowMs).toISOString();
    const { data, error } = await db.from("experience_outcomes").insert({
      session_id: input.sessionId,
      user_id: userId,
      recommendation_id: session.recommendation_id,
      item_id: session.item_id,
      item_type: session.item_type,
      outcome: input.outcome,
      occurred_at: occurredAt,
      memory_eligible: memoryEligible,
      significance,
      calibration_version: calibrationVersion,
      projection_version: session.projection_version ?? EXPERIENCE_SESSION_VERSION,
    }).select("id").single();
    if (error) {
      // Unique (session, outcome) is the authoritative idempotency boundary.
       if (String((error as any).code) === "23505") {
         const existing = await db.from("experience_outcomes").select("id, memory_eligible, calibration_version")
           .eq("session_id", input.sessionId).eq("outcome", input.outcome).maybeSingle();
         return existing.data?.id ? { ok: true, sessionId: input.sessionId, outcomeId: String(existing.data.id),
           memoryEligible: existing.data.memory_eligible === true, calibrationVersion: String(existing.data.calibration_version ?? CALIBRATION_VERSION) } : { ok: false, reason: "error" };
       }
      return { ok: false, reason: "error" };
    }
    return {
      ok: true, sessionId: input.sessionId, outcomeId: data?.id ? String(data.id) : undefined,
      memoryEligible, calibrationVersion,
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Read-only calibration aggregate; no movement/session-time proxies are used. */
export async function computeExperienceCalibration(
  db: SupabaseClient | null,
  opts: { days?: number } = {},
): Promise<{ calibrationVersion: string; outcomes: number; eligibleOutcomes: number; byOutcome: Record<string, number> }> {
  const empty = { calibrationVersion: CALIBRATION_VERSION, outcomes: 0, eligibleOutcomes: 0, byOutcome: {} as Record<string, number> };
  if (!db) return empty;
  const days = Math.max(1, Math.min(90, opts.days ?? 30));
  try {
    const { data, error } = await db.from("experience_outcomes")
      .select("outcome, memory_eligible, significance, calibration_version, projection_version")
      .gte("occurred_at", new Date(Date.now() - days * 86400000).toISOString());
    if (error || !data) return empty;
    const byOutcome: Record<string, number> = {};
    const allowed = new Set<string>(SIGNIFICANT_OUTCOMES);
    const valid = (data as any[]).filter((row) => allowed.has(String(row.outcome)) && String(row.calibration_version) === CALIBRATION_VERSION && String(row.projection_version) === EXPERIENCE_SESSION_VERSION);
    for (const row of valid) byOutcome[String(row.outcome)] = (byOutcome[String(row.outcome)] ?? 0) + 1;
    return {
      calibrationVersion: CALIBRATION_VERSION,
      outcomes: valid.length,
      eligibleOutcomes: valid.filter((r) => r.memory_eligible === true && r.significance === "significant").length,
      byOutcome,
    };
  } catch {
    return empty;
  }
}