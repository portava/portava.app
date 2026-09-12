/**
 * Trips spec §17.1 + §3.2 — one builder for trip HEALTH (the summary
 * projection over concrete reasons) and the active OPERATIONAL PHASE, under
 * the §19.1 envelope. Both derive from the same reads, and Cluster 5's
 * TripTodayProjection (§11.1: `nowState`, `risks[]`) consumes this object
 * rather than re-deriving either.
 *
 * WHAT IT READS, AND WHAT A FAILED READ DOES
 * =========================================
 *   trips                         dates, timezone, status, version — refused when unreadable
 *   §7.3 freedom projection       conflicts, windows and hop verdicts — refused when IT refuses
 *   trip_risks                    the register (2762) — refused when unreadable: a health
 *                                 computed over "no risks" is HEALTHY by construction
 *   safe_return_sessions + prefs  NEEDS_HELP members, opt-in exactly as the safety projection
 *                                 (services/trips/TripSafetyProjection.ts) — refused when unreadable
 *   trip_plan_items               today's plan for ACTIVE_PLAN / NIGHTLIFE — refused when unreadable
 *
 * Readiness (`lib/tripReadiness.ts`) is NOT an input; see TripHealth.ts.
 */
import { logger } from "../../lib/logger.js";
import { computeTripStatus } from "../../lib/tripStatus.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { liveEnvelope, type TripProjectionEnvelope } from "./TripProjectionEnvelope.js";
import { buildTripFreedomProjection, type TripFreedomProjection } from "./TripFreedomProjection.js";
import { operationalState, type SafetySessionRow } from "./TripSafetyProjection.js";
import { deriveTripHealth, surfacePriority, prioritySwitch, type PrioritySwitch, type DisruptionForHealth, type TripHealth, type RiskForHealth, type RegroupForHealth } from "./TripHealth.js";
import { deriveOperationalPhase, localClock, type PhaseDecision, type PhasePlanItem } from "./TripOperationalPhase.js";
import { recordTripDecision, persistTripDecision, TRIP_ENGINE_VERSIONS } from "./TripDecisionLedger.js";

const log = logger.child({ mod: "tripHealthProjection" });

export interface TripHealthProjection extends TripProjectionEnvelope, TripHealth {
  /** §17.2 — the priority switch and what it suppresses, derived from `health` and `reasons`. */
  attention: PrioritySwitch;
  tripId: string;
  /** §21.2 ledger record; explain at GET /trips/:id/decisions/:decisionId/explain. */
  decisionId: string;
  /** §17.2 AT_RISK priority, or [] when health is better than AT_RISK. */
  surfacePriority: readonly string[];
  phase: PhaseDecision;
  tripStatus: string;
  /** How many conflicts / open risks / NEEDS_HELP members were looked at, so an empty reasons list is a count of zero, not an absence of looking. */
  counted: { conflicts: number; openRisks: number; activeDisruptions: number; needsHelp: number; hops: { infeasible: number; unknown: number } };
  /** The §7.3 projection this was derived from, by version, so the two cannot be quoted against each other. */
  derivedFrom: { freedomSourceTripVersion: number | null };
  reading: string;
}

export const HEALTH_READING =
  "§17.1: health is the worst level among concrete reasons (conflicts, the risk register, Safe Return NEEDS_HELP, feasibility hops); readiness is a different question and not an input. §3.2: the phase is derived from dates, the plan, the windows and disruption, first clause wins, reason stated.";

export type HealthProjectionResult =
  | { ok: true; projection: TripHealthProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED"; message: string };

export async function buildTripHealthProjection(
  sc: any,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<HealthProjectionResult> {
  const now = opts.now ?? new Date();

  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  const { data: trip, error: tripErr } = await sc
    .from("trips")
    .select("id, title, destination_city, start_date, end_date, status, timezone, owner_id, version")
    .eq("id", tripId)
    .maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "health: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const t = trip as any;
  const envelope = liveEnvelope(typeof t.version === "number" ? t.version : null, now);
  const tripStatus = computeTripStatus(t.title ?? null, t.destination_city ?? null, t.start_date ?? null, t.end_date ?? null, String(t.status ?? "planning"), t.timezone ?? null);

  const freedom = await buildTripFreedomProjection(sc, tripId, { now });
  if (!freedom.ok) return freedom.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Freedom windows: ${freedom.message}` } : freedom;
  const f: TripFreedomProjection = freedom.projection;

  const { data: risks, error: rErr } = await sc
    .from("trip_risks")
    .select("id, likelihood, impact, status")
    .eq("trip_id", tripId)
    .in("status", ["open", "realised"]);
  if (rErr) {
    log.warn({ err: rErr.message, tripId }, "health: trip_risks unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The risk register could not be read" };
  }

  // Safe Return, with the safety projection's own opt-in rule: self, the
  // standing preference, or the session's notify_trip_crew_enabled.
  const { data: sessions, error: sErr } = await sc
    .from("safe_return_sessions")
    .select("id, user_id, trip_id, status, escalation_level, timer_start_at, timer_end_at, notify_trip_crew_enabled, closed_at, updated_at")
    .eq("trip_id", tripId)
    .in("status", ["active", "missed", "safe"]);
  if (sErr) {
    log.warn({ err: sErr.message, tripId }, "health: safe_return_sessions unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "Safe Return status could not be read" };
  }
  const { data: prefs, error: pErr } = await sc
    .from("trip_crew_location_preferences")
    .select("user_id, share_safe_return_status")
    .eq("trip_id", tripId);
  if (pErr) {
    log.warn({ err: pErr.message, tripId }, "health: trip_crew_location_preferences unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "Sharing preferences could not be read" };
  }
  const share = new Map<string, boolean>();
  for (const p of ((prefs ?? []) as any[])) share.set(String(p.user_id), p.share_safe_return_status === true);
  const crew = new Set<string>(f.participants);
  const needsHelp: string[] = [];
  let viewerSafeReturnActive = false;
  for (const s of ((sessions ?? []) as SafetySessionRow[])) {
    if (!crew.has(s.user_id)) continue;
    const state = operationalState(s, now.getTime());
    if (s.user_id === viewerId && (state === "RETURNING" || state === "NEEDS_HELP")) viewerSafeReturnActive = true;
    const visible = s.user_id === viewerId || share.get(s.user_id) === true || s.notify_trip_crew_enabled === true;
    if (state === "NEEDS_HELP" && visible) needsHelp.push(s.user_id);
  }

  // §17.2 (2785): the disruption register. Under the gate the table exists;
  // an unreadable register is refused like every other input, because a
  // health that silently omits an active disruption is the wrong health.
  const { data: disruptionRows, error: dErr } = await sc
    .from("trip_disruptions")
    .select("id, kind, severity, state")
    .eq("trip_id", tripId)
    .eq("state", "active");
  if (dErr) {
    log.warn({ err: dErr.message, tripId }, "health: trip_disruptions unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The disruption register could not be read" };
  }
  const disruptions: DisruptionForHealth[] = ((disruptionRows ?? []) as any[]).map((d) => ({
    id: String(d.id), kind: String(d.kind), severity: String(d.severity), state: String(d.state),
  }));

  // §11.3 / §10.4 (2794): open regroup and safety checkpoints, with who is still expected.
  const { data: cpRows, error: cpErr } = await sc
    .from("trip_meeting_checkpoints")
    .select("id, label, purpose, status")
    .eq("trip_id", tripId)
    .eq("status", "open");
  if (cpErr) {
    log.warn({ err: cpErr.message, tripId }, "health: trip_meeting_checkpoints unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The meeting checkpoints could not be read" };
  }
  const openRegroups: RegroupForHealth[] = [];
  if (((cpRows ?? []) as any[]).length > 0) {
    const ids = ((cpRows ?? []) as any[]).map((c) => String(c.id));
    const { data: partRows, error: pErr } = await sc
      .from("trip_meeting_checkpoint_participants")
      .select("checkpoint_id, user_id, arrival_state")
      .in("checkpoint_id", ids);
    if (pErr) {
      log.warn({ err: pErr.message, tripId }, "health: trip_meeting_checkpoint_participants unreadable — refusing");
      return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The checkpoint participants could not be read" };
    }
    for (const c of ((cpRows ?? []) as any[])) {
      const parts = ((partRows ?? []) as any[]).filter((p) => String(p.checkpoint_id) === String(c.id));
      openRegroups.push({
        id: String(c.id), label: String(c.label ?? ""), purpose: (c.purpose ?? "regroup") as RegroupForHealth["purpose"],
        pendingIds: parts.filter((p) => p.arrival_state === "pending" || p.arrival_state === "en_route" || p.arrival_state === "late").map((p) => String(p.user_id)),
        expected: parts.length,
      });
    }
  }

  const { data: items, error: iErr } = await sc
    .from("trip_plan_items")
    .select("id, category, status, starts_at, ends_at, day_date")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (iErr) {
    log.warn({ err: iErr.message, tripId }, "health: trip_plan_items unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The plan could not be read" };
  }
  const planItems: PhasePlanItem[] = ((items ?? []) as any[]).map((p) => ({
    id: String(p.id), category: p.category ?? null, status: p.status ?? null,
    startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, dayDate: p.day_date ?? null,
  }));

  // Hop verdicts: the freedom projection's windows/conflicts already encode
  // the hops; INFEASIBLE hops are exactly the NO_TIME_TO_TRAVEL / OVERLAP
  // conflicts, and UNKNOWN hops are windows flagged TRAVEL_UNKNOWN.
  const hops = {
    infeasible: f.conflicts.filter((c) => c.kind !== "PLAN_OVERLAP").length,
    unknown: f.windows.filter((w) => w.position === "between" && w.hardConstraints.some((h) => h.kind === "TRAVEL_UNKNOWN")).length,
  };
  const riskRows = ((risks ?? []) as RiskForHealth[]);
  const health = deriveTripHealth({ conflicts: f.conflicts, risks: riskRows, disruptions, needsHelpMemberIds: needsHelp, hops, openRegroups });
  const attention = prioritySwitch(health);

  const phase = deriveOperationalPhase({
    now, timezone: t.timezone ?? null, tripStartDate: t.start_date ?? null, tripEndDate: t.end_date ?? null, tripStatus,
    planItems, windows: f.windows, disrupted: health.health === "DISRUPTED", safeReturnActive: viewerSafeReturnActive,
  });

  const decision = recordTripDecision({
    tripId, type: "trip_health",
    inputs: {
      sourceTripVersion: envelope.sourceTripVersion, freedomDecisionId: f.decisionId,
      riskIds: riskRows.map((r) => r.id), disruptionIds: disruptions.map((d) => d.id), needsHelpMembers: needsHelp.length, hops, planItems: planItems.length,
      localClock: { date: phase.evidence.localDate, hour: phase.evidence.localHour, timezone: t.timezone ?? "UTC" },
    },
    sources: ["trips", "trip_risks", "trip_disruptions", "safe_return_sessions", "trip_crew_location_preferences", "trip_plan_items", "trip_meeting_checkpoints", "TripFreedomProjection"],
    assumptions: ["health is the worst concrete reason; readiness is not an input", "the phase's first matching clause wins, in the documented order"],
    constraints: health.reasons.map((r) => r.code),
    result: { health: health.health, reasons: health.reasons.length, phase: phase.phase, phaseReason: phase.reason, mode: attention.mode, suppressed: attention.suppression.discovery },
    confidence: "N/A",
    engineVersions: { TripHealth: TRIP_ENGINE_VERSIONS.TripHealth, TripOperationalPhase: TRIP_ENGINE_VERSIONS.TripOperationalPhase },
    calculatedAt: envelope.generatedAt, sourceTripVersion: envelope.sourceTripVersion,
  });
  // §5.3 (2781): kept for 90 days by policy where the deployment can; the projection is served either way.
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope,
      ...health,
      tripId,
      decisionId: decision.decisionId,
      surfacePriority: surfacePriority(health.health),
      attention,
      phase,
      tripStatus,
      counted: { conflicts: f.conflicts.length, openRisks: riskRows.filter((r) => r.status === "open").length, activeDisruptions: disruptions.length, needsHelp: needsHelp.length, hops },
      derivedFrom: { freedomSourceTripVersion: f.sourceTripVersion },
      reading: HEALTH_READING,
    },
  };
}

/** Exposed for tests: the local clock the phase was judged on. */
export { localClock };
