/**
 * Trips spec §11.1 — `TripTodayProjection`, and §11.2's five questions in
 * order: what is happening now, what is next, who is with me, what can I do,
 * has anything changed that requires action.
 *
 * §11.1, verbatim:
 *
 *   TripTodayProjection { tripId stageId nowState currentPlan? nextCommitment?
 *     freeWindows[] crewSummary opportunities[] risks[] unresolvedActions[]
 *     pulseSignals[] generatedAt sourceTripVersion freshness }
 *
 * WHAT EXISTED
 * ============
 * census-trips TR180: "There is no GET /trips/:id/today endpoint"; TR181-TR183:
 * `nowState`, `currentPlan`, `nextCommitment` DERIVED ON THE CLIENT from the
 * fetched plan list (TripPage.tsx "Today / Next Up") — "the shape §11.1 exists
 * to replace, and it cannot be consumed by Compass, Map or Telegraph". This is
 * the server's answer, and it is COMPOSED from the projections §40.2-§40.4
 * built rather than re-deriving any of them:
 *
 *   nowState          the §3.2 phase, from TripHealthProjection
 *   risks[]           the register plus the §17.1 reasons, from the same
 *   freeWindows[]     the §7.3 windows still open now, from TripFreedomProjection
 *   nextCommitment    the next deadline, with its LEAVE-BY from the window
 *                     that ends at it — the one number a traveller needs
 *   crewSummary       counts from the roster, and the crew map's cards when
 *                     its flag is on
 *
 * §22.4 IS CHECKED LIVE HERE
 * ==========================
 * This builder reads `trips.version` FIRST, then consumes two projections
 * generated moments later, and accepts each through `acceptTripProjection`
 * with that version as the canonical one. A command landing in between makes
 * a sub-projection's `sourceTripVersion` exceed it, and the Today projection
 * is then REFUSED with TRIP_PROJECTION_VERSION_AHEAD (retryable) rather than
 * assembled from two states of the trip. census-trips TR416 was W in §40.2
 * because no live consumer supplied a canonical version; this one does.
 *
 * TWO FIELDS HAVE NO PRODUCER, AND SAY SO
 * =======================================
 * `opportunities[]` (no opportunity object exists — TR252/TR253) and
 * `pulseSignals[]` (no Trip Pulse — §16) are three-valued layers in the
 * `no_source` state, exactly as the map projection states its missing
 * layers. A projection with nine fields must not be read as eleven with two
 * empty.
 */
import { logger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { getCrewMap, CrewMapUnavailableError } from "../tripCrew/TripCrewLocationService.js";
import {
  liveEnvelope, acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION, type TripProjectionEnvelope,
} from "./TripProjectionEnvelope.js";
import { buildTripHealthProjection, type TripHealthProjection } from "./TripHealthProjection.js";
import { buildTripFreedomProjection, type TripFreedomProjection } from "./TripFreedomProjection.js";
import { buildTripPulseProjection } from "./TripPulseProjection.js";
import { buildTripOpportunityProjection } from "./TripOpportunityProjection.js";
import { evaluateRiskTriggers, type RiskTrigger } from "./TripRiskTriggers.js";
import { looksWeatherSensitive } from "./TripSignals.js";
import type { ExecutableTripExperience } from "./TripExperienceCompiler.js";
import type { PulseInterpretation } from "./TripSignals.js";
import type { PrioritySwitch } from "./TripHealth.js";
import { noSource, ok as okLayer, unread, type Layer } from "./TripMapProjection.js";
import type { FreedomWindow } from "./TripFreedomEngine.js";
import type { PhaseDecision } from "./TripOperationalPhase.js";
import type { HealthReason, TripHealthLevel } from "./TripHealth.js";
import { recordTripDecision, persistTripDecision, TRIP_ENGINE_VERSIONS } from "./TripDecisionLedger.js";

const log = logger.child({ mod: "tripTodayProjection" });

export interface TodayCurrentPlan {
  id: string; title: string | null; category: string | null; status: string | null;
  startsAt: string | null; endsAt: string | null; locationName: string | null;
}
export interface TodayNextCommitment {
  id: string; type: string; arriveBy: string; startsAt: string | null; placeId: string | null;
  /** From the §7.3 window that ends at this commitment; null when no window precedes it (or it is in conflict). */
  mustLeaveBy: string | null;
  windowId: string | null;
}
export interface TodayCrewSummary {
  total: number; accepted: number; invited: number;
  /** trip_crew_map_enabled. When false the three counts below are null: not read, not zero. */
  featureEnabled: boolean;
  liveSharing: number | null;
  safeReturnActive: number | null;
  withLocation: number | null;
  detail: string | null;
}
export interface TodayRisk { id: string; likelihood: string; impact: string; status: string }
export const UNRESOLVED_ACTION_KINDS = ["resolve_conflict", "check_on_member", "place_commitment", "review_risk"] as const;
export interface TodayUnresolvedAction {
  kind: (typeof UNRESOLVED_ACTION_KINDS)[number];
  subjectIds: string[];
  detail: string;
  severity: "critical" | "normal";
}

export interface TripTodayProjection extends TripProjectionEnvelope {
  tripId: string;
  /** §21.2 ledger record; explain at GET /trips/:id/decisions/:decisionId/explain. */
  decisionId: string;
  stageId: string | null;
  stageReading: string;
  nowState: PhaseDecision;
  health: TripHealthLevel;
  healthReasons: HealthReason[];
  currentPlan: TodayCurrentPlan | null;
  nextCommitment: TodayNextCommitment | null;
  freeWindows: FreedomWindow[];
  crewSummary: TodayCrewSummary;
  /** §13 — the current-or-next window's EXECUTABLE experiences, from the opportunity projection accepted against the same version. */
  opportunities: Layer<ExecutableTripExperience>;
  risks: TodayRisk[];
  /** §8.4 — the four register triggers, each fired or not with its evidence and the spec's mitigation. */
  riskTriggers: RiskTrigger[];
  unresolvedActions: TodayUnresolvedAction[];
  /** §16 — the Trip Pulse projection's kept signals, accepted against the same version. */
  pulseSignals: Layer<PulseInterpretation>;
  /** §17.2 — the priority switch this trip is under and what it suppresses. */
  attention: PrioritySwitch;
  /** §11.2's five questions, in order, each naming the field that answers it. */
  answers: { now: string; next: string; who: string; canDo: string; changed: string };
  derivedFrom: { healthSourceTripVersion: number | null; freedomSourceTripVersion: number | null };
}

export type TodayProjectionResult =
  | { ok: true; projection: TripTodayProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED" | "TRIP_PROJECTION_VERSION_AHEAD" | "TRIP_PROJECTION_SCHEMA_MISMATCH" | "TRIP_PROJECTION_STALE"; message: string };

export const TODAY_ANSWERS = {
  now: "nowState (§3.2 phase, with the clause that produced it) and currentPlan",
  next: "nextCommitment (arriveBy and mustLeaveBy) and the first of freeWindows",
  who: "crewSummary",
  canDo: "freeWindows (what time is free) — opportunities has no producer and says so",
  changed: "health with healthReasons, risks, and unresolvedActions",
} as const;

/**
 * The crew half of `crewSummary`. Its OWN function because it reads
 * `trip_crew_map_enabled` (ON in production): in prerequisitesCore's terms it
 * is a gate boundary, so the crew map's schema belongs to that flag and the
 * Today builder's kernel-era reads do not.
 */
async function readCrewSummary(sc: any, tripId: string, viewerId: string, memberRows: any[]): Promise<TodayCrewSummary> {
  const crewSummary: TodayCrewSummary = {
    total: memberRows.length,
    accepted: memberRows.filter((m) => m.status == null || m.status === "accepted").length,
    invited: memberRows.filter((m) => m.status === "invited").length,
    featureEnabled: false, liveSharing: null, safeReturnActive: null, withLocation: null, detail: null,
  };
  if (await isFlagEnabled(sc, "trip_crew_map_enabled")) {
    crewSummary.featureEnabled = true;
    try {
      const map = await getCrewMap(sc, tripId, viewerId);
      crewSummary.liveSharing = map.members.filter((m) => m.liveShareActive).length;
      crewSummary.safeReturnActive = map.members.filter((m) => m.safeReturnActive).length;
      crewSummary.withLocation = map.members.filter((m) => m.areaLabel !== null).length;
      if (map.checkInsUnreadable) crewSummary.detail = "check-ins unreadable";
    } catch (err) {
      if (!(err instanceof CrewMapUnavailableError)) throw err;
      // The counts stay null — not read, not zero — and the summary says why.
      crewSummary.detail = `crew map unavailable: ${err.table}`;
    }
  } else {
    crewSummary.detail = "trip_crew_map_enabled is off; presence counts not read";
  }
  return crewSummary;
}

export async function buildTripTodayProjection(
  sc: any,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TodayProjectionResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  // 1. The canonical version, FIRST.
  const { data: trip, error: tripErr } = await sc.from("trips").select("id, version").eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "today: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const canonicalVersion: number | null = typeof (trip as any).version === "number" ? (trip as any).version : null;

  // 2. The projections this composes, each accepted against that version.
  const healthBuilt = await buildTripHealthProjection(sc, tripId, viewerId, { now });
  if (!healthBuilt.ok) return healthBuilt.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Health: ${healthBuilt.message}` } : healthBuilt;
  const health: TripHealthProjection = healthBuilt.projection;
  const hd = acceptTripProjection(health, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric: "TripHealthProjection" });
  if (!hd.accepted) return { ok: false, reason: hd.reason, message: `Health projection refused: ${hd.message}` };

  const freedomBuilt = await buildTripFreedomProjection(sc, tripId, { now });
  if (!freedomBuilt.ok) return freedomBuilt.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Freedom windows: ${freedomBuilt.message}` } : freedomBuilt;
  const freedom: TripFreedomProjection = freedomBuilt.projection;
  const fd = acceptTripProjection(freedom, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric: "TripFreedomProjection" });
  if (!fd.accepted) return { ok: false, reason: fd.reason, message: `Freedom projection refused: ${fd.message}` };

  // §16: the pulse composes the same health, so it is passed in rather than rebuilt.
  const pulseBuilt = await buildTripPulseProjection(sc, tripId, viewerId, { now, health });
  let pulseSignals: Layer<PulseInterpretation>;
  let pulseDecisionId: string | null = null;
  if (!pulseBuilt.ok) {
    if (pulseBuilt.reason === "TRIP_PROJECTION_VERSION_AHEAD" || pulseBuilt.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH" || pulseBuilt.reason === "TRIP_PROJECTION_STALE") {
      return { ok: false, reason: pulseBuilt.reason, message: `Pulse projection refused: ${pulseBuilt.message}` };
    }
    pulseSignals = unread(`Trip Pulse unavailable (${pulseBuilt.reason}): ${pulseBuilt.message}`);
  } else {
    const pd = acceptTripProjection(pulseBuilt.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric: "TripPulseProjection" });
    if (!pd.accepted) return { ok: false, reason: pd.reason, message: `Pulse projection refused: ${pd.message}` };
    pulseSignals = okLayer(pulseBuilt.projection.signals);
    pulseDecisionId = pulseBuilt.projection.decisionId;
  }

  // §13: the opportunity projection composes the same health, freedom and pulse.
  let opportunities: Layer<ExecutableTripExperience>;
  let opportunityDecisionId: string | null = null;
  if (!pulseBuilt.ok) {
    opportunities = unread(`Opportunities need the Trip Pulse, which is unavailable (${pulseBuilt.reason})`);
  } else {
    const oppBuilt = await buildTripOpportunityProjection(sc, tripId, viewerId, { now, health, freedom, pulse: pulseBuilt.projection });
    if (!oppBuilt.ok) {
      if (oppBuilt.reason === "TRIP_PROJECTION_VERSION_AHEAD" || oppBuilt.reason === "TRIP_PROJECTION_SCHEMA_MISMATCH" || oppBuilt.reason === "TRIP_PROJECTION_STALE") {
        return { ok: false, reason: oppBuilt.reason, message: `Opportunity projection refused: ${oppBuilt.message}` };
      }
      opportunities = unread(`Opportunities unavailable (${oppBuilt.reason}): ${oppBuilt.message}`);
    } else {
      const od = acceptTripProjection(oppBuilt.projection, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric: "TripOpportunityProjection" });
      if (!od.accepted) return { ok: false, reason: od.reason, message: `Opportunity projection refused: ${od.message}` };
      opportunities = okLayer(oppBuilt.projection.windows[0]?.executable ?? []);
      opportunityDecisionId = oppBuilt.projection.decisionId;
    }
  }

  // 3. The reads this projection makes itself.
  const { data: stages, error: stErr } = await sc.from("trip_stages").select("id, starts_at, ends_at, sequence").eq("trip_id", tripId);
  if (stErr) {
    log.warn({ err: stErr.message, tripId }, "today: trip_stages unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The stages could not be read" };
  }
  const stageRows = ((stages ?? []) as any[]);
  const stage = stageRows.find((s) => s.starts_at && s.ends_at && Date.parse(s.starts_at) <= nowMs && nowMs < Date.parse(s.ends_at)) ?? null;
  const stageReading = stage ? `stage ${stage.id} (sequence ${stage.sequence}) contains now`
    : stageRows.length === 0 ? "the trip has no stages" : "no stage's interval contains now";

  const { data: items, error: iErr } = await sc
    .from("trip_plan_items")
    .select("id, title, category, status, starts_at, ends_at, day_date, location_name")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (iErr) {
    log.warn({ err: iErr.message, tripId }, "today: trip_plan_items unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The plan could not be read" };
  }
  const active = ((items ?? []) as any[]).find((p) => p.id === health.phase.evidence.activePlanId) ?? null;
  const currentPlan: TodayCurrentPlan | null = active ? {
    id: String(active.id), title: active.title ?? null, category: active.category ?? null, status: active.status ?? null,
    startsAt: active.starts_at ?? null, endsAt: active.ends_at ?? null, locationName: active.location_name ?? null,
  } : null;

  const { data: commitments, error: cErr } = await sc
    .from("trip_commitments")
    .select("id, type, starts_at, required_arrival_at, place_id")
    .eq("trip_id", tripId);
  if (cErr) {
    log.warn({ err: cErr.message, tripId }, "today: trip_commitments unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The commitments could not be read" };
  }
  const upcoming = ((commitments ?? []) as any[])
    .map((c) => ({ c, deadline: Date.parse(c.required_arrival_at ?? c.starts_at ?? "") }))
    .filter((x) => Number.isFinite(x.deadline) && x.deadline > nowMs)
    .sort((a, b) => a.deadline - b.deadline)[0] ?? null;
  let nextCommitment: TodayNextCommitment | null = null;
  if (upcoming) {
    const w = freedom.windows.find((x) => x.beforeCommitmentId === upcoming.c.id) ?? null;
    nextCommitment = {
      id: String(upcoming.c.id), type: String(upcoming.c.type), arriveBy: new Date(upcoming.deadline).toISOString(),
      startsAt: upcoming.c.starts_at ?? null, placeId: upcoming.c.place_id ?? null,
      mustLeaveBy: w ? w.endsAt : null, windowId: w ? w.id : null,
    };
  }

  const { data: members, error: mErr } = await sc.from("trip_members").select("user_id, status").eq("trip_id", tripId);
  if (mErr) {
    log.warn({ err: mErr.message, tripId }, "today: trip_members unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The crew could not be read" };
  }
  const memberRows = ((members ?? []) as any[]);
  const crewSummary = await readCrewSummary(sc, tripId, viewerId, memberRows);

  const { data: riskRows, error: rErr } = await sc.from("trip_risks").select("id, likelihood, impact, status").eq("trip_id", tripId).in("status", ["open", "realised"]);
  if (rErr) {
    log.warn({ err: rErr.message, tripId }, "today: trip_risks unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The risk register could not be read" };
  }
  const risks: TodayRisk[] = ((riskRows ?? []) as any[]).map((r) => ({ id: String(r.id), likelihood: String(r.likelihood), impact: String(r.impact), status: String(r.status) }));

  // §8.4: the four register triggers over what this projection read, plus the
  // transport segments (2782, under the same gate) for the party-size row.
  const { data: segRows, error: segErr } = await sc.from("trip_transport_segments").select("id, mode, state, planned_departure_at, party_size").eq("trip_id", tripId);
  if (segErr) {
    log.warn({ err: segErr.message, tripId }, "today: trip_transport_segments unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The transport segments could not be read" };
  }
  const crewSize = memberRows.filter((m) => m.status == null || m.status === "accepted").length || 1;
  const riskTriggers = evaluateRiskTriggers({
    now: nowMs,
    // §8.4 (TR146): the arrival estimate is the freedom projection's per-hop
    // estimate (previous departure + travel + prep) and a lodging's desk
    // deadline is its required arrival — the two inputs the late-check-in
    // trigger had no producer for. A commitment with no hop keeps null: no
    // estimate is not "on time".
    commitments: ((commitments ?? []) as any[]).map((c) => {
      const est = freedom.arrivalEstimates.find((a) => a.commitmentId === String(c.id));
      const type = String(c.type ?? "");
      return {
        id: String(c.id), type, startsAt: c.starts_at ?? null, requiredArrivalAt: c.required_arrival_at ?? null,
        estimatedArrivalAt: est?.estimatedArrivalAt ?? null,
        checkInDeadlineAt: type === "lodging" ? (c.required_arrival_at ?? null) : null,
      };
    }),
    plans: ((items ?? []) as any[]).map((p) => ({ id: String(p.id), title: p.title ?? null, startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, weatherSensitive: looksWeatherSensitive(p.title, p.category === "activity" ? p.location_name : null), partySize: null })),
    transport: ((segRows ?? []) as any[]).map((t) => ({ id: String(t.id), mode: String(t.mode ?? ""), state: String(t.state ?? ""), plannedDepartureAt: t.planned_departure_at ?? null, partySize: typeof t.party_size === "number" ? t.party_size : null, capacity: null })),
    signals: pulseSignals.status === "ok" ? pulseSignals.items : [],
    crewSize,
  });

  // 4. What requires action — derived from what this projection already knows.
  const unresolvedActions: TodayUnresolvedAction[] = [];
  for (const c of freedom.conflicts) {
    unresolvedActions.push({ kind: "resolve_conflict", subjectIds: [...c.commitmentIds, ...c.planIds], detail: `${c.kind}: ${c.detail}`, severity: "critical" });
  }
  for (const r of health.reasons) {
    if (r.code === "SAFETY_NEEDS_HELP") unresolvedActions.push({ kind: "check_on_member", subjectIds: r.subjectIds, detail: r.detail, severity: "critical" });
    if (r.code === "TRIP_RISK_REALISED" || r.code === "TRIP_RISK_OPEN_HIGH") unresolvedActions.push({ kind: "review_risk", subjectIds: r.subjectIds, detail: r.detail, severity: r.code === "TRIP_RISK_REALISED" ? "critical" : "normal" });
  }
  for (const id of freedom.unplacedCommitmentIds) {
    unresolvedActions.push({ kind: "place_commitment", subjectIds: [id], detail: `commitment ${id} has no start or arrival time and is not on the timeline`, severity: "normal" });
  }

  const envelope = liveEnvelope(canonicalVersion, now);
  const decision = recordTripDecision({
    tripId, type: "today_projection",
    inputs: {
      canonicalVersion, healthDecisionId: health.decisionId, freedomDecisionId: freedom.decisionId, pulseDecisionId, opportunityDecisionId,
      stageId: stage ? String(stage.id) : null, activePlanId: health.phase.evidence.activePlanId,
      nextCommitmentId: nextCommitment?.id ?? null, openWindows: freedom.windows.filter((w) => Date.parse(w.endsAt) > nowMs).length,
      crew: { total: crewSummary.total, featureEnabled: crewSummary.featureEnabled },
    },
    sources: ["trips", "TripHealthProjection", "TripFreedomProjection", "TripPulseProjection", "TripOpportunityProjection", "trip_stages", "trip_transport_segments", "trip_plan_items", "trip_commitments", "trip_members", "trip_risks"],
    assumptions: ["composed from the health and freedom projections accepted against trips.version read first (§22.4)"],
    constraints: [`accepted sub-projections at version ${canonicalVersion ?? "unknown"}`],
    result: { phase: health.phase.phase, health: health.health, unresolvedActions: unresolvedActions.length, freeWindows: freedom.windows.length, firedTriggers: riskTriggers.filter((t) => t.fired).map((t) => t.kind) },
    confidence: "N/A",
    engineVersions: { TripTodayProjection: TRIP_ENGINE_VERSIONS.TripTodayProjection },
    calculatedAt: envelope.generatedAt, sourceTripVersion: canonicalVersion,
  });
  // §5.3 (2781): kept for 90 days by policy where the deployment can; the projection is served either way.
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope,
      tripId,
      decisionId: decision.decisionId,
      stageId: stage ? String(stage.id) : null,
      stageReading,
      nowState: health.phase,
      health: health.health,
      healthReasons: health.reasons,
      currentPlan,
      nextCommitment,
      freeWindows: freedom.windows.filter((w) => Date.parse(w.endsAt) > nowMs),
      crewSummary,
      opportunities,
      risks,
      riskTriggers,
      unresolvedActions,
      pulseSignals,
      attention: health.attention,
      answers: { ...TODAY_ANSWERS },
      derivedFrom: { healthSourceTripVersion: health.sourceTripVersion, freedomSourceTripVersion: freedom.sourceTripVersion },
    },
  };
}
