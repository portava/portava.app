/** L15 owns executable selections; entry permission and all safety terms come from the compiler's canonical inputs. */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { logger } from "../../lib/logger.js";
import { compile, loadCompilationCandidates } from "./LayoverExperienceService.js";
import { recommendationContractSchema, type LayoverRecommendationContract } from "./LayoverRecommendationContract.js";
import { guardContextFromRecord, transition } from "./LayoverLifecycle.js";
import { LAYOVER_STATES, type LayoverState } from "./LayoverConstraints.js";
import { recordProjectedSessionState } from "./LayoverSessionService.js";
import type { RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";

const storedSchema = z.object({
  id: z.string().uuid(), session_id: z.string().uuid(), user_id: z.string().uuid(), version: z.number().int().positive(),
  operation: z.enum(["select", "start"]), phase: z.enum(["selected", "executing", "refused"]),
  previous_plan_id: z.string().uuid().nullable(), snapshot_id: z.string().nullable(),
  stops: z.array(z.object({ id: z.string().uuid() }).passthrough()), contract: recommendationContractSchema.nullable(),
  refusal_reason: z.string().nullable(), created_at: z.string(),
});
type Stored = z.infer<typeof storedSchema>;
export interface ExperiencePlan {
  id: string; version: number; phase: "selected" | "executing";
  contract: LayoverRecommendationContract; stopIds: string[]; createdAt: string;
}
type Refusal = { ok: false; reason: string; actionId?: string };
type MutationResult = { ok: true; plan: ExperiencePlan; duplicate: boolean } | Refusal;
function plan(row: Stored): ExperiencePlan | null {
  return row.phase !== "refused" && row.contract?.state === "READY" ? { id: row.id, version: row.version, phase: row.phase, contract: row.contract, stopIds: row.stops.map(s => s.id), createdAt: row.created_at } : null;
}
async function enabled(db: SupabaseClient): Promise<boolean> {
  if (!(await isFlagEnabled(db, "layover_experience_execution_enabled"))) return false;
  return (await Promise.all([
    isFlagEnabled(db, "layover_plans_enabled"), isFlagEnabled(db, "layover_recommendation_status_enabled"),
    isFlagEnabled(db, "layover_canonical_snapshot_enabled"), isFlagEnabled(db, "layover_decision_persistence_enabled"),
    isFlagEnabled(db, "layover_lifecycle_machine_enabled"),
  ])).every(Boolean);
}
const sessionSchema = z.object({ id: z.string().uuid(), user_id: z.string().uuid(), state: z.string().nullable(), status: z.string(), departure_time: z.string(), updated_at: z.string(), active_snapshot_id: z.string().nullable() });
async function session(db: SupabaseClient, userId: string, sessionId: string) {
  const { data, error } = await db.from("layover_sessions").select("id,user_id,state,status,departure_time,updated_at,active_snapshot_id").eq("id", sessionId).eq("user_id", userId).maybeSingle();
  if (error) { logger.warn({ err: error, sessionId }, "Executable experience session unreadable"); return { ok: false as const, reason: "session_unreadable" }; }
  if (!data) return { ok: false as const, reason: "not_found" };
  const parsed = sessionSchema.safeParse(data);
  return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, reason: "session_unreadable" };
}
const stopSchema = z.object({ id: z.string().uuid(), recommendation_id: z.string().uuid().nullable(), stop_order: z.number().int(), duration_min: z.number(), travel_min: z.number(), inside_airport: z.boolean(), title: z.string(), description: z.string().nullable(), place_id: z.string().nullable(), location_label: z.string().nullable(), lat: z.coerce.number().nullable(), lng: z.coerce.number().nullable() });
type Stop = z.infer<typeof stopSchema>;
function stopState(s: Stop) {
  return { id: s.id, recommendationId: s.recommendation_id, order: s.stop_order, duration: s.duration_min, travel: s.travel_min, insideAirport: s.inside_airport, title: s.title, description: s.description, placeId: s.place_id, locationLabel: s.location_label, lat: s.lat, lng: s.lng };
}
function sameStops(expected: ReturnType<typeof stopState>[], stored: Stored["stops"]): boolean {
  return expected.length === stored.length && expected.every((stop, i) => Object.entries(stop).every(([key, value]) => stored[i]?.[key] === value));
}
async function stops(db: SupabaseClient, sessionId: string) {
  const { data, error } = await db.from("layover_plan_stops").select("id,recommendation_id,stop_order,duration_min,travel_min,inside_airport,title,description,place_id,location_label,lat,lng").eq("session_id", sessionId).order("stop_order").order("id");
  if (error) { logger.warn({ err: error, sessionId }, "Executable experience stops unreadable"); return { ok: false as const, reason: "plan_stops_unreadable" }; }
  const parsed = z.array(stopSchema).safeParse(data);
  return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, reason: "plan_stops_unreadable" };
}
async function latest(db: SupabaseClient, userId: string, sessionId: string) {
  const { data, error } = await db.from("layover_experience_plans").select("*").eq("session_id", sessionId).eq("user_id", userId).in("phase", ["selected", "executing"]).order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) { logger.warn({ err: error, sessionId }, "Executable experience plan unreadable"); return { ok: false as const, reason: "plan_unreadable" }; }
  if (!data) return { ok: true as const, value: null };
  const parsed = storedSchema.safeParse(data);
  return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, reason: "plan_unreadable" };
}
export async function readExperiencePlan(db: SupabaseClient, userId: string, sessionId: string): Promise<{ ok: true; plan: ExperiencePlan | null; usable: boolean; reason: string | null } | Refusal> {
  try {
    if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
    const owned = await session(db, userId, sessionId); if (!owned.ok) return owned;
    const current = await latest(db, userId, sessionId); if (!current.ok) return current;
    const published = current.value ? plan(current.value) : null;
    if (!published) return { ok: true, plan: null, usable: false, reason: null };
    const saved = await stops(db, sessionId); if (!saved.ok) return saved;
    const reason = owned.value.status !== "active" ? "session_not_active"
      : owned.value.active_snapshot_id !== published.contract.snapshotId ? "snapshot_changed"
      : !sameStops(saved.value.map(stopState), current.value!.stops) ? "plan_stops_changed"
      : published.phase === "selected" && Date.parse(published.contract.expiresAt ?? "") <= Date.now() ? "plan_expired" : null;
    return { ok: true, plan: published, usable: reason === null, reason };
  } catch (err) { logger.warn({ err, sessionId }, "Executable experience read failed"); return { ok: false, reason: "plan_unreadable" }; }
}
const riskRank = { LOW: 0, MODERATE: 1, HIGH: 2, UNSAFE: 3 } as const;
function termsWorsened(before: LayoverRecommendationContract, after: LayoverRecommendationContract): boolean {
  const duration = (c: LayoverRecommendationContract) => Math.max(...c.itinerary.map(s => Date.parse(s.endsAt))) - Math.min(...c.itinerary.map(s => Date.parse(s.startsAt)));
  return after.hardReturnBy !== before.hardReturnBy || after.insideAirport !== before.insideAirport
    || riskRank[after.riskBand] > riskRank[before.riskBand] || duration(after) > duration(before) + 1
    || after.confidence !== before.confidence
    || after.minExperienceMinutes !== before.minExperienceMinutes || after.idealExperienceMinutes !== before.idealExperienceMinutes
    || JSON.stringify(after.itinerary.map(s => s.mode)) !== JSON.stringify(before.itinerary.map(s => s.mode))
    || after.fallbackPlan.returnRoute?.transferCount !== before.fallbackPlan.returnRoute?.transferCount
    || JSON.stringify(after.candidateIds) !== JSON.stringify(before.candidateIds);
}
/** A request UUID is retained after network uncertainty, so retry cannot select/start twice. */
export async function mutateExperiencePlan(db: SupabaseClient, userId: string, sessionId: string, input: {
  requestId: string; operation: "select" | "start"; expectedStopIds: string[]; selectedPlanId?: string;
}, opts: { corridorProvider?: RouteCorridorProvider } = {}): Promise<MutationResult> {
  try {
    if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
    let owned = await session(db, userId, sessionId); if (!owned.ok) return owned;
    const { data: replay, error: replayError } = await db.from("layover_experience_plans").select("*").eq("id", input.requestId).eq("user_id", userId).eq("session_id", sessionId).maybeSingle();
    if (replayError) { logger.warn({ err: replayError, sessionId }, "Executable experience replay unreadable"); return { ok: false, reason: "plan_unreadable" }; }
    if (replay) {
      const parsed = storedSchema.safeParse(replay); if (!parsed.success) return { ok: false, reason: "plan_unreadable" };
      const r = parsed.data;
      if (r.operation !== input.operation || r.previous_plan_id !== (input.selectedPlanId ?? null) || JSON.stringify(r.stops.map(s => s.id)) !== JSON.stringify(input.expectedStopIds)) return { ok: false, reason: "idempotency_conflict" };
      const published = plan(r); return published ? { ok: true, plan: published, duplicate: true } : { ok: false, reason: r.refusal_reason ?? "plan_unavailable", actionId: r.id };
    }
    const saved = await stops(db, sessionId); if (!saved.ok) return saved;
    let refusal: string | null = JSON.stringify(saved.value.map(s => s.id)) !== JSON.stringify(input.expectedStopIds) ? "plan_stops_changed" : null;
    if (!refusal && (saved.value.length < 1 || saved.value.length > 6 || saved.value.some(s => s.recommendation_id === null))) refusal = "recommendation_choices_required";
    const prior = await latest(db, userId, sessionId); if (!prior.ok) return prior;
    if (input.operation === "start" && (!prior.value || prior.value.id !== input.selectedPlanId || prior.value.phase !== "selected")) refusal = "selected_plan_changed";
    if (input.operation === "start" && prior.value?.contract && Date.parse(prior.value.contract.expiresAt ?? "") <= Date.now()) refusal = "plan_expired";
    let contract: LayoverRecommendationContract | null = null;
    if (!refusal) {
      const ids = saved.value.map(s => s.recommendation_id!);
      const compiled = await compile(db, userId, sessionId, ids, opts);
      if (!compiled.ok) refusal = compiled.reason;
      else {
        contract = compiled.contract;
        const current = await loadCompilationCandidates(db, userId, sessionId, ids, Date.now());
        if (!current.ok) refusal = current.reason;
        else if (current.snapshotId !== contract.snapshotId) refusal = "snapshot_changed";
        else if (saved.value.some((s, i) => s.duration_min !== current.candidates[i]!.activityTimeMin || s.inside_airport !== current.candidates[i]!.insideAirport)) refusal = "saved_plan_terms_changed";
        else {
          const ctx = { ...guardContextFromRecord(current.record, !contract.insideAirport), executablePlanReady: true, planInsideAirport: contract.insideAirport };
          if (input.operation === "select" && [null, "DETECTED", "NEEDS_INFO", "EVALUATING"].includes(owned.value.state)) {
            const evaluated = transition("EVALUATING", "EVALUATED", ctx);
            if (evaluated.ok) {
              const placed = await recordProjectedSessionState(db, sessionId, evaluated.to);
              if (!placed.ok) refusal = "lifecycle_unavailable";
              owned = await session(db, userId, sessionId); if (!owned.ok) return owned;
            }
          }
          if (!refusal) {
            const state = (LAYOVER_STATES as readonly string[]).includes(owned.value.state ?? "") ? owned.value.state as LayoverState : null;
            const movement = input.operation === "select" && state === "PLAN_SELECTED" ? { ok: true } : transition(state, input.operation === "select" ? "PLAN_CHOSEN" : "EXPERIENCE_STARTED", ctx);
            if (!movement.ok) refusal = "lifecycle_refused";
          }
        }
        if (input.operation === "start" && prior.value?.contract && (contract.snapshotId !== prior.value.contract.snapshotId || termsWorsened(prior.value.contract, contract))) refusal = "plan_terms_changed";
      }
    }
    if (!(await enabled(db))) return { ok: false, reason: "feature_disabled" };
    const { data, error } = await db.rpc("layover_experience_plan_write", {
      p_id: input.requestId, p_session_id: sessionId, p_user_id: userId, p_operation: input.operation,
      p_previous_plan_id: input.selectedPlanId ?? null, p_snapshot_id: contract?.snapshotId ?? owned.value.active_snapshot_id,
      p_session_updated_at: owned.value.updated_at, p_prior_state: owned.value.state, p_stops: saved.value.map(stopState), p_contract: contract, p_refusal: refusal,
    });
    if (error) { logger.warn({ err: error, sessionId }, "Executable experience write unavailable"); return { ok: false, reason: "plan_write_unavailable" }; }
    const parsed = storedSchema.safeParse(data?.plan);
    if (data?.ok !== true) return { ok: false, reason: typeof data?.reason === "string" ? data.reason : "plan_write_unavailable", ...(parsed.success ? { actionId: parsed.data.id } : {}) };
    const published = parsed.success ? plan(parsed.data) : null;
    return published ? { ok: true, plan: published, duplicate: data.duplicate === true } : { ok: false, reason: "plan_result_unreadable" };
  } catch (err) { logger.warn({ err, sessionId }, "Executable experience operation failed"); return { ok: false, reason: "plan_unavailable" }; }
}
