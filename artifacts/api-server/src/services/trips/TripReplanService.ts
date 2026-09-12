/**
 * The replan and the meeting point over the trip — one computation each,
 * shared by the routes (routes/tripProjections.ts) and the Compass tools
 * (§12.1 replanDay, findMeetingPoint). Reads through loadImpactState and
 * the projections; writes nothing. Creating the proposals a replan calls
 * for is the route's decision, made only when asked.
 */
import { loadImpactState } from "./TripImpactState.js";
import { replanDay, type ReplanConstraints, type ReplanDiff } from "./TripReplan.js";
import { buildTripFreedomProjection } from "./TripFreedomProjection.js";
import { buildTripPulseProjection } from "./TripPulseProjection.js";
import { buildTripOpportunityProjection, straightLineEstimator } from "./TripOpportunityProjection.js";
import { evaluateRiskTriggers } from "./TripRiskTriggers.js";
import { looksWeatherSensitive } from "./TripSignals.js";
import { findMeetingPoint, type MeetingPointResult, type MeetingCandidate } from "./TripMeetingPoint.js";
import { getCrewMap, CrewMapUnavailableError } from "../tripCrew/TripCrewLocationService.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";

export type ReplanResult =
  | { ok: true; day: string; diff: ReplanDiff; sourceTripVersion: number | null; unread: string[] }
  | { ok: false; reason: string; message: string };

export async function computeReplan(sc: any, tripId: string, userId: string, opts: { day?: string | null; constraints?: ReplanConstraints; now?: Date } = {}): Promise<ReplanResult> {
  const now = opts.now ?? new Date();
  const day = opts.day && /^\d{4}-\d{2}-\d{2}$/.test(opts.day) ? opts.day : now.toISOString().slice(0, 10);
  const loaded = await loadImpactState(sc, tripId, { now });
  if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
  const freedom = await buildTripFreedomProjection(sc, tripId, { now });
  if (!freedom.ok) return { ok: false, reason: freedom.reason, message: freedom.message };
  const pulse = await buildTripPulseProjection(sc, tripId, userId, { now });
  const signals = pulse.ok ? pulse.projection.signals : [];
  const opp = await buildTripOpportunityProjection(sc, tripId, userId, { now, freedom: freedom.projection, pulse: pulse.ok ? pulse.projection : undefined });
  const opportunities = opp.ok ? opp.projection.windows.flatMap((w) => w.executable) : [];
  const st = loaded.state;
  const triggers = evaluateRiskTriggers({
    now: now.getTime(), crewSize: st.crewIds.length || 1, signals,
    commitments: st.commitments.map((c) => ({ id: c.id, type: c.type, startsAt: c.startsAt, requiredArrivalAt: c.requiredArrivalAt })),
    plans: st.plans.map((p) => ({ id: p.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, weatherSensitive: looksWeatherSensitive(p.title), partySize: p.participantIds.length || null })),
    transport: st.transport.map((t) => ({ id: t.id, mode: t.mode, state: t.state, plannedDepartureAt: t.plannedDepartureAt, partySize: t.partySize, capacity: null })),
  });
  const diff = replanDay({ now: now.getTime(), day, plans: st.plans, state: st, conflicts: freedom.projection.conflicts, signals, triggers, windows: freedom.projection.windows, opportunities, actorUserId: userId, constraints: opts.constraints });
  return { ok: true, day, diff, sourceTripVersion: loaded.sourceTripVersion, unread: loaded.unread };
}

export type MeetingPointComputation =
  | { ok: true; result: MeetingPointResult; candidatesConsidered: number; sourceTripVersion: number | null }
  | { ok: false; reason: string; message: string };

export async function computeMeetingPoint(sc: any, tripId: string, userId: string, opts: { participantIds?: string[]; candidateIds?: string[]; now?: Date } = {}): Promise<MeetingPointComputation> {
  const now = opts.now ?? new Date();
  const loaded = await loadImpactState(sc, tripId, { now });
  if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
  const wanted = opts.participantIds && opts.participantIds.length > 0 ? opts.participantIds : loaded.state.crewIds;
  const positions = new Map<string, { lat: number; lng: number } | null>();
  let positionReason = "trip_crew_map_enabled is off; no position is read";
  if (await isFlagEnabled(sc, "trip_crew_map_enabled")) {
    try {
      const map = await getCrewMap(sc, tripId, userId);
      for (const m of map.members) positions.set(m.userId, m.exactCoords ?? null);
      positionReason = "no shared position visible to the viewer (§10)";
    } catch (err) { if (!(err instanceof CrewMapUnavailableError)) throw err; positionReason = `crew map unavailable: ${err.table}`; }
  }
  const nextFor = (id: string) => {
    const soon = loaded.state.commitments.filter((c) => c.participantIds.includes(id)).map((c) => ({ c, at: Date.parse(c.requiredArrivalAt ?? c.startsAt ?? "") })).filter((x) => Number.isFinite(x.at) && x.at > now.getTime()).sort((a, b) => a.at - b.at)[0];
    return soon ? { id: soon.c.id, arriveBy: new Date(soon.at).toISOString(), point: null } : null;
  };
  const { data: savedRows } = await sc.from("trip_saved_places").select("id, place_name, place_type, lat, lng").eq("trip_id", tripId);
  const { data: planRows } = await sc.from("trip_plan_items").select("id, title, category, lat, lng, location_is_private").eq("trip_id", tripId).is("removed_at", null);
  const candidates: MeetingCandidate[] = [
    ...((savedRows ?? []) as any[]).filter((s) => typeof s.lat === "number" && typeof s.lng === "number").map((s) => ({ id: `saved:${s.id}`, name: String(s.place_name ?? ""), point: { lat: s.lat, lng: s.lng }, placeType: s.place_type ?? null })),
    ...((planRows ?? []) as any[]).filter((p) => typeof p.lat === "number" && typeof p.lng === "number").map((p) => ({ id: `plan:${p.id}`, name: String(p.title ?? ""), point: { lat: p.lat, lng: p.lng }, placeType: p.category === "meeting_point" ? "meeting_point" : p.category ?? null, privateAnchor: p.location_is_private === true })),
  ];
  const chosen = opts.candidateIds && opts.candidateIds.length > 0 ? candidates.filter((c) => opts.candidateIds!.includes(c.id)) : candidates;
  const result = findMeetingPoint({
    now: now.getTime(),
    participants: wanted.map((id) => ({ userId: id, point: positions.get(id) ?? null, positionReason: positions.get(id) ? null : positionReason, nextCommitment: nextFor(id) })),
    candidates: chosen, partySize: wanted.length, travel: (a, b) => straightLineEstimator.minutes(a, b),
  });
  return { ok: true, result, candidatesConsidered: chosen.length, sourceTripVersion: loaded.sourceTripVersion };
}
