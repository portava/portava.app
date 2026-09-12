/**
 * Trips spec §16 — Trip Pulse, the projection (census-trips TR299–TR311).
 *
 * "Trip Pulse is not a generic city feed. It projects world intelligence
 * through the active Trip context: stage, current location band, goals, saved
 * ideas, commitments, crew, and attention state."
 *
 * THE SHAPE OF THE READ
 * =====================
 * 1. The canonical version and the health projection first (§22.4: nothing
 *    served here may be ahead of trips.version). Health supplies §17.2's
 *    attention state — the seventh filter axis.
 * 2. The trip context: the current stage, saved ideas, plan items,
 *    commitments, transport segments, goals, crew.
 * 3. Three signal SOURCES, each reported by name with its status, so a pulse
 *    with no signals says whether that is "nothing is happening" or "nothing
 *    could be read":
 *      intel_state_snapshots — crowd.level / crowd.trajectory / event.status /
 *                              transit.condition for the trip's saved places
 *      weather_cache         — the destination's cached forecast; READ, never
 *                              fetched: a projection must not make an HTTP
 *                              call (lib/weatherCache.getWeatherContext does)
 *      crew presence         — TripCrewLocationService.getCrewMap, which
 *                              applies every §10 privacy rule before this
 *                              file sees a coordinate
 * 4. services/trips/TripSignals: observations → SignalEstimate (§16.2), then
 *    signals → interpretations through the context filter (§16.1).
 *
 * WHAT IT DOES NOT DO
 * ===================
 * It does not notify. A kept signal's effects are inputs to the opportunity
 * engine (§13.3) and the attention policy (§11.4); this projection only says
 * what is true and why it matters to THIS trip. It reads places by the ids
 * the trip already holds; it does not search the city.
 */
import { logger } from "../../lib/logger.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { readCrewPresenceForPulse } from "./TripPulseCrewPresence.js";
import {
  liveEnvelope, acceptTripProjection, TRIP_PROJECTION_SCHEMA_VERSION, type TripProjectionEnvelope,
} from "./TripProjectionEnvelope.js";
import { buildTripHealthProjection, type TripHealthProjection } from "./TripHealthProjection.js";
import type { PrioritySwitch } from "./TripHealth.js";
import {
  estimateFromObservations, projectSignals, looksWeatherSensitive,
  type SignalObservation, type TripSignal, type PulseContext, type PulseInterpretation, type DroppedSignal,
  type CrowdRisingValue, type RainArrivingValue, type TaxiDemandValue, type EventDelayedValue, type FriendNearbyValue,
  type GeoPoint, type AttentionState,
} from "./TripSignals.js";
import { recordTripDecision, persistTripDecision, TRIP_ENGINE_VERSIONS } from "./TripDecisionLedger.js";

const log = logger.child({ mod: "tripPulseProjection" });

export const PULSE_SOURCES = ["intel_state_snapshots", "weather_cache", "crew_presence"] as const;
export type PulseSourceName = (typeof PULSE_SOURCES)[number];

export interface PulseSourceReport {
  name: PulseSourceName;
  status: "ok" | "unread" | "no_source";
  /** Observations taken from it (before estimation). */
  observations: number;
  detail: string | null;
}

export interface TripPulseProjection extends TripProjectionEnvelope {
  tripId: string;
  decisionId: string;
  /** §17.2 — from the health projection; SAFETY_EVENT / AT_RISK suppress discovery signals here. */
  attention: PrioritySwitch;
  /** Kept, ordered by confidence. Each carries §16.2's estimate and §16.1's interpretation. */
  signals: PulseInterpretation[];
  /** Filtered out, each with the reason — the city feed this is not. */
  dropped: DroppedSignal[];
  sources: PulseSourceReport[];
  context: {
    stageId: string | null;
    locationBand: { centre: GeoPoint; radiusM: number; from: "viewer_presence" | "active_plan" | "stage_anchor" } | null;
    goals: number; savedIdeas: number; commitments: number; plans: number; transport: number; crew: number;
  };
  derivedFrom: { healthDecisionId: string; healthSourceTripVersion: number | null };
  reading: string;
}

export type PulseProjectionResult =
  | { ok: true; projection: TripPulseProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED" | "TRIP_PROJECTION_VERSION_AHEAD" | "TRIP_PROJECTION_SCHEMA_MISMATCH" | "TRIP_PROJECTION_STALE"; message: string };

export const PULSE_READING =
  "Signals are world intelligence the trip already touches, filtered by stage, location band, goals, saved ideas, commitments, crew and attention state (§16.1). " +
  "Each estimate lists its source class, freshness and every contradicting source (§16.2); confidence falls with disagreement and is never raised by it. " +
  "A dropped signal names why it was dropped. A source marked unread was not empty — it could not be read.";

/** The intel claim types this projection turns into signals. */
export const PULSE_CLAIM_TYPES = ["crowd.level", "crowd.trajectory", "event.status", "transit.condition"] as const;

export const LOCATION_BAND_RADIUS_M = 2_000;
export { FRIEND_NEARBY_BANDS } from "./TripPulseCrewPresence.js";
const WEATHER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function point(lat: unknown, lng: unknown): GeoPoint | null {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function scalar(value: unknown, keys: string[]): string | null {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  for (const k of keys) if (typeof v[k] === "string") return v[k] as string;
  return null;
}

export async function buildTripPulseProjection(
  sc: any,
  tripId: string,
  viewerId: string,
  opts: { now?: Date; health?: TripHealthProjection } = {},
): Promise<PulseProjectionResult> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  // 1. The canonical version, then health accepted against it.
  const { data: trip, error: tripErr } = await sc.from("trips").select("id, version, destination_city").eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "pulse: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const canonicalVersion: number | null = typeof (trip as any).version === "number" ? (trip as any).version : null;

  let health: TripHealthProjection;
  if (opts.health) {
    health = opts.health;
  } else {
    const built = await buildTripHealthProjection(sc, tripId, viewerId, { now });
    if (!built.ok) return built.reason === "TRIP_PROJECTION_UNAVAILABLE" ? { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `Health: ${built.message}` } : built;
    health = built.projection;
  }
  const hd = acceptTripProjection(health, { acceptedSchemaVersion: TRIP_PROJECTION_SCHEMA_VERSION, canonicalVersion, now: nowMs, metric: "TripHealthProjection" });
  if (!hd.accepted) return { ok: false, reason: hd.reason, message: `Health projection refused: ${hd.message}` };
  const attentionState: AttentionState = health.attention.mode;

  // 2. The trip context.
  // Takes a BUILT query rather than a table name: `.from(variable)` is invisible
  // to check:write-path-columns, and these seven reads are exactly what it exists
  // to hold against the live schema.
  const read = async <T,>(table: string, q: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<{ rows: T[] } | { refused: PulseProjectionResult }> => {
    const { data, error } = await q;
    if (error) {
      log.warn({ err: error.message, tripId, table }, "pulse: context unreadable — refusing");
      return { refused: { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: `${table} could not be read` } };
    }
    return { rows: ((data ?? []) as T[]) };
  };
  const stagesR = await read<any>("trip_stages", sc.from("trip_stages").select("id, place_id, starts_at, ends_at, sequence").eq("trip_id", tripId));
  if ("refused" in stagesR) return stagesR.refused;
  const savedR = await read<any>("trip_saved_places", sc.from("trip_saved_places").select("id, place_id, place_name, place_type, lat, lng").eq("trip_id", tripId));
  if ("refused" in savedR) return savedR.refused;
  const plansR = await read<any>("trip_plan_items", sc.from("trip_plan_items").select("id, title, category, status, starts_at, ends_at, lat, lng, location_name").eq("trip_id", tripId).is("removed_at", null));
  if ("refused" in plansR) return plansR.refused;
  const commitmentsR = await read<any>("trip_commitments", sc.from("trip_commitments").select("id, type, starts_at, required_arrival_at, place_id, source_ref").eq("trip_id", tripId));
  if ("refused" in commitmentsR) return commitmentsR.refused;
  const transportR = await read<any>("trip_transport_segments", sc.from("trip_transport_segments").select("id, mode, state, planned_departure_at").eq("trip_id", tripId));
  if ("refused" in transportR) return transportR.refused;
  const goalsR = await read<any>("trip_goals", sc.from("trip_goals").select("type, scope, status").eq("trip_id", tripId));
  if ("refused" in goalsR) return goalsR.refused;
  const membersR = await read<any>("trip_members", sc.from("trip_members").select("user_id, status").eq("trip_id", tripId));
  if ("refused" in membersR) return membersR.refused;

  const stage = stagesR.rows.find((s) => s.starts_at && s.ends_at && Date.parse(s.starts_at) <= nowMs && nowMs < Date.parse(s.ends_at)) ?? null;
  const savedIdeas = savedR.rows.map((s) => ({
    id: String(s.id), placeId: s.place_id ? String(s.place_id) : null, placeType: s.place_type ?? null, name: String(s.place_name ?? ""), point: point(s.lat, s.lng),
  }));
  const plans = plansR.rows.filter((p) => p.status !== "cancelled" && p.status !== "removed").map((p) => ({
    id: String(p.id), title: p.title ?? null, category: p.category ?? null, startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null,
    weatherSensitive: looksWeatherSensitive(p.title, p.category === "activity" ? p.location_name : null), point: point(p.lat, p.lng),
  }));
  const commitments = commitmentsR.rows.map((c) => ({
    id: String(c.id), type: String(c.type ?? ""), startsAt: c.starts_at ?? null, requiredArrivalAt: c.required_arrival_at ?? null,
    placeId: c.place_id ? String(c.place_id) : null, eventId: c.source_ref ? String(c.source_ref) : null,
  }));
  const transport = transportR.rows.map((t) => ({ id: String(t.id), mode: String(t.mode ?? ""), state: String(t.state ?? ""), plannedDepartureAt: t.planned_departure_at ?? null }));
  const goals = goalsR.rows.map((g) => ({ type: String(g.type ?? ""), scope: String(g.scope ?? "shared"), status: String(g.status ?? "open") }));
  const memberIds = membersR.rows.filter((m) => m.status == null || m.status === "accepted").map((m) => String(m.user_id));

  // 3. Sources.
  const sources: PulseSourceReport[] = [];
  const signals: TripSignal[] = [];

  // 3a. Crew presence — through the crew map, which applies §10's privacy
  //     rules; this file never reads a position row itself. Also the viewer's
  //     own position, which is the best location band there is.
  // The crew half lives in TripPulseCrewPresence.ts (the one Pulse source
  // behind trip_crew_map_enabled); see that file's header for why it is apart.
  const crew = await readCrewPresenceForPulse(sc, tripId, viewerId, nowMs);
  const viewerPoint: GeoPoint | null = crew.viewerPoint;
  const friendObs = crew.observations;
  sources.push(crew.source);
  for (const [userId, obs] of friendObs) {
    const est = estimateFromObservations(obs, { now: nowMs });
    if (est) signals.push({ kind: "friend_nearby", subjectId: userId, estimate: est });
  }

  // 3b. Intel snapshots for the trip's saved places.
  const subjectIds = [...new Set(savedIdeas.map((s) => s.placeId).filter((id): id is string => !!id && UUID_RE.test(id)))];
  if (subjectIds.length === 0) {
    sources.push({ name: "intel_state_snapshots", status: "ok", observations: 0, detail: "no saved idea names a canonical place; nothing to look up" });
  } else {
    const { data: snaps, error: snapErr } = await sc
      .from("intel_state_snapshots")
      .select("subject_id, zone_id, claim_type, value, confidence, observed_at, expires_at, conflict_state, source_count")
      .in("subject_id", subjectIds)
      .in("claim_type", [...PULSE_CLAIM_TYPES])
      .gt("expires_at", nowIso);
    if (snapErr) {
      sources.push({ name: "intel_state_snapshots", status: "unread", observations: 0, detail: snapErr.message });
    } else {
      const rows = ((snaps ?? []) as any[]);
      sources.push({ name: "intel_state_snapshots", status: "ok", observations: rows.length, detail: null });
      const obsOf = (r: any) => ({
        confidence: (typeof r.confidence === "number" ? r.confidence : 0.5) * (r.conflict_state ? 0.5 : 1),
        sourceClass: "firsthand_unverified" as const, observedAt: String(r.observed_at), expiresAt: String(r.expires_at),
      });
      // crowd: level and trajectory are two claim types about one subject; one signal per subject.
      const bySubject = new Map<string, any[]>();
      for (const r of rows) { const l = bySubject.get(String(r.subject_id)) ?? []; l.push(r); bySubject.set(String(r.subject_id), l); }
      for (const [subjectId, rs] of bySubject) {
        const levels = rs.filter((r) => r.claim_type === "crowd.level");
        const trajectories = rs.filter((r) => r.claim_type === "crowd.trajectory");
        if (levels.length > 0 || trajectories.length > 0) {
          const level = estimateFromObservations(levels.map((r) => ({ value: scalar(r.value, ["level"]) ?? "unknown", ...obsOf(r) })), { now: nowMs });
          const traj = estimateFromObservations(trajectories.map((r) => ({ value: scalar(r.value, ["trajectory"]) ?? "unknown", ...obsOf(r) })), { now: nowMs });
          const base = level ?? traj!;
          const value: CrowdRisingValue = { placeId: subjectId, level: level?.value ?? "unknown", trajectory: traj?.value ?? "unknown" };
          signals.push({ kind: "crowd_rising", subjectId, estimate: {
            ...base, value,
            confidence: Math.min(level?.confidence ?? 1, traj?.confidence ?? 1),
            contradictorySources: [...(level?.contradictorySources ?? []), ...(traj?.contradictorySources ?? [])],
            fallbackUsed: (level?.fallbackUsed ?? false) || (traj?.fallbackUsed ?? false),
          } });
        }
        const events = rs.filter((r) => r.claim_type === "event.status");
        if (events.length > 0) {
          const est = estimateFromObservations(events.map((r) => ({
            value: { eventId: subjectId, status: scalar(r.value, ["status", "state"]) ?? "unknown",
              delayMinutes: typeof r.value?.delay_minutes === "number" ? r.value.delay_minutes : null,
              newStartsAt: typeof r.value?.new_starts_at === "string" ? r.value.new_starts_at : null } as EventDelayedValue,
            ...obsOf(r),
          })), { now: nowMs });
          if (est) signals.push({ kind: "event_delayed", subjectId, estimate: est });
        }
        const transit = rs.filter((r) => r.claim_type === "transit.condition");
        if (transit.length > 0) {
          const est = estimateFromObservations(transit.map((r) => ({
            value: { zone: String(r.zone_id ?? subjectId), condition: scalar(r.value, ["condition", "state", "status"]) ?? "unknown" } as TaxiDemandValue,
            ...obsOf(r),
          })), { now: nowMs });
          if (est) signals.push({ kind: "taxi_demand_high", subjectId, estimate: est });
        }
      }
    }
  }

  // 3c. The destination's cached forecast. Read, not fetched.
  const destination = (trip as any).destination_city ? String((trip as any).destination_city) : null;
  if (!destination) {
    sources.push({ name: "weather_cache", status: "no_source", observations: 0, detail: "the trip has no destination city to look up" });
  } else {
    const { data: wx, error: wxErr } = await sc
      .from("weather_cache")
      .select("destination, date_key, forecasts_json, fetched_at")
      .eq("destination", destination)
      .order("fetched_at", { ascending: false })
      .limit(3);
    if (wxErr) {
      sources.push({ name: "weather_cache", status: "unread", observations: 0, detail: wxErr.message });
    } else {
      const rows = ((wx ?? []) as any[]);
      const today = nowIso.slice(0, 10);
      const byDate = new Map<string, SignalObservation<RainArrivingValue>[]>();
      for (const r of rows) {
        const fetchedAt = String(r.fetched_at ?? nowIso);
        const expiresAt = new Date(Date.parse(fetchedAt) + WEATHER_CACHE_TTL_MS).toISOString();
        for (const f of (Array.isArray(r.forecasts_json) ? r.forecasts_json : [])) {
          if (typeof f?.date !== "string" || f.date < today) continue;
          const daysOut = Math.round((Date.parse(f.date) - Date.parse(today)) / 86_400_000);
          const l = byDate.get(f.date) ?? [];
          l.push({
            value: { date: f.date, precipMm: Number(f.precipMm ?? 0), weatherCode: Number(f.weatherCode ?? 0), summary: f.summary ?? null },
            confidence: daysOut <= 0 ? 0.7 : daysOut === 1 ? 0.5 : 0.35, sourceClass: "imported_owned", observedAt: fetchedAt, expiresAt,
          });
          byDate.set(f.date, l);
        }
      }
      let n = 0;
      for (const [date, obs] of byDate) {
        n += obs.length;
        const est = estimateFromObservations(obs, { now: nowMs });
        if (est) signals.push({ kind: "rain_arriving", subjectId: date, estimate: est });
      }
      sources.push({ name: "weather_cache", status: "ok", observations: n, detail: rows.length === 0 ? `no cached forecast for ${destination}` : null });
    }
  }

  // 4. The location band: the viewer's own position, else the active plan's, else the stage anchor (which has no coordinates here — stated).
  const activePlan = plans.find((p) => p.id === health.phase.evidence.activePlanId) ?? null;
  const locationBand = viewerPoint ? { centre: viewerPoint, radiusM: LOCATION_BAND_RADIUS_M, from: "viewer_presence" as const }
    : activePlan?.point ? { centre: activePlan.point, radiusM: LOCATION_BAND_RADIUS_M, from: "active_plan" as const }
    : null;

  const ctx: PulseContext = {
    now: nowMs,
    stage: stage ? { id: String(stage.id), startsAt: stage.starts_at ?? null, endsAt: stage.ends_at ?? null, anchor: null } : null,
    locationBand: locationBand ? { centre: locationBand.centre, radiusM: locationBand.radiusM } : null,
    goals, savedIdeas, commitments, plans, transport,
    crew: { viewerId, memberIds },
    attention: attentionState,
  };
  const projected = projectSignals(signals, ctx);

  const envelope = liveEnvelope(canonicalVersion, now);
  const decision = recordTripDecision({
    tripId, type: "pulse_projection",
    inputs: {
      canonicalVersion, healthDecisionId: health.decisionId, attention: attentionState, stageId: ctx.stage?.id ?? null,
      locationBand: locationBand ? { from: locationBand.from, radiusM: locationBand.radiusM } : null,
      sources: sources.map((s) => ({ name: s.name, status: s.status, observations: s.observations })),
      signals: signals.map((s) => ({ kind: s.kind, subjectId: s.subjectId, confidence: s.estimate.confidence, contradictions: s.estimate.contradictorySources.length })),
    },
    sources: ["trips", "TripHealthProjection", "trip_stages", "trip_saved_places", "trip_plan_items", "trip_commitments", "trip_transport_segments", "trip_goals", "trip_members", ...sources.filter((s) => s.status === "ok").map((s) => s.name)],
    assumptions: [
      "an estimate's value is the best-supported one; every disagreeing source is listed and lowers confidence (§16.2)",
      "a signal that touches no saved idea, plan, commitment, transport segment or crew member is dropped (§16.1)",
      `attention state ${attentionState} from the health projection (§17.2)`,
    ],
    constraints: projected.dropped.map((d) => `${d.kind}:${d.subjectId}: ${d.reason}`),
    result: { kept: projected.kept.length, dropped: projected.dropped.length, effects: projected.kept.flatMap((k) => k.effects.map((e) => e.kind)) },
    confidence: "N/A",
    engineVersions: { TripSignals: TRIP_ENGINE_VERSIONS.TripSignals, TripPulseProjection: TRIP_ENGINE_VERSIONS.TripPulseProjection },
    calculatedAt: envelope.generatedAt, sourceTripVersion: canonicalVersion,
  });
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope,
      tripId,
      decisionId: decision.decisionId,
      attention: health.attention,
      signals: projected.kept,
      dropped: projected.dropped,
      sources,
      context: {
        stageId: ctx.stage?.id ?? null, locationBand,
        goals: goals.length, savedIdeas: savedIdeas.length, commitments: commitments.length, plans: plans.length, transport: transport.length, crew: memberIds.length,
      },
      derivedFrom: { healthDecisionId: health.decisionId, healthSourceTripVersion: health.sourceTripVersion },
      reading: PULSE_READING,
    },
  };
}
