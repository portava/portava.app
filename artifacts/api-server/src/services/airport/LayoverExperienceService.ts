/** §18 session-scoped experience discovery and compilation. Every entry point checks ownership. */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { getSession, layoverSessionIsLiveAt, type LayoverSession } from "./LayoverSessionService.js";
import { resolveSessionAirport } from "./LayoverSnapshot.js";
import { evaluate } from "./LayoverFeasibilityService.js";
import { generateRecommendations, getRecommendations, type GenerateRecommendationsOptions, type CertifiedRecommendation } from "./LayoverRecommendationService.js";
import { airportPoint, placePoint } from "./LayoverTravelTime.js";
import { landsideStatusOf } from "./LayoverConstraints.js";
import type { AirportProfile } from "./AirportProfileService.js";
import type { GeoPoint } from "../../domain/trips/contracts/TravelTimeProvider.js";
import type { LayoverFeasibilityRecord } from "./LayoverFeasibility.js";
import type { LayoverRecommendationContract } from "./LayoverRecommendationContract.js";
import { recommendationStatusEnabled } from "../layover/LayoverRecommendationStatus.js";
import { routeSelectedExperiences } from "./LayoverExperienceRouting.js";
import { LAYOVER_ROUTED_POLICY } from "./LayoverRoutedFeasibility.js";
import type { RouteCorridorProvider } from "../../lib/providers/routeCorridorProvider.js";
import { readActivityCommitments } from './layoverActivityCommitment.js';

const logger = rootLogger.child({ service: "LayoverExperienceService" });
type Refusal = { ok: false; reason: string };
type Owned = { ok: true; session: LayoverSession; airport: AirportProfile };
async function loadOwned(db: SupabaseClient, userId: string, sessionId: string, nowMs: number): Promise<Owned | Refusal> {
  const read = await getSession(db, sessionId, userId);
  if (!read.ok) return { ok: false, reason: "session_unreadable" };
  if (!read.session) return { ok: false, reason: "not_found" };
  if (!layoverSessionIsLiveAt(read.session, nowMs)) return { ok: false, reason: "session_ended" };
  const resolved = await resolveSessionAirport(db, read.session);
  return resolved.ok ? { ok: true, session: read.session, airport: resolved.airport } : { ok: false, reason: "airport_unreadable" };
}

/** Get the owner's certified candidates through the existing authoritative recommendation pipeline. */
export async function getCandidates(db: SupabaseClient, userId: string, sessionId: string, nowMs = Date.now(), opts: GenerateRecommendationsOptions = {}) {
  try {
    if (!(await recommendationStatusEnabled(db))) return { ok: false as const, reason: "feature_disabled" };
    const loaded = await loadOwned(db, userId, sessionId, nowMs);
    if (!loaded.ok) return loaded;
    return await generateRecommendations(db, loaded.airport, loaded.session, nowMs, { ...opts, stableIds: true });
  } catch (err) {
    logger.warn({ err, sessionId }, "experience candidates unavailable");
    return { ok: false as const, reason: "candidates_unreadable" };
  }
}

export interface CompilationCandidate {
  key: string; point: GeoPoint | null; activityTimeMin: number; insideAirport: boolean; activityCommitment?: import('./layoverActivityCommitment.js').ActivityCommitment | null;
  contract: LayoverRecommendationContract;
}
export type CompilationInputs = { ok: true; session: LayoverSession; airport: AirportProfile; record: LayoverFeasibilityRecord; snapshotId: string; candidates: CompilationCandidate[] } | Refusal;

/** The exact inputs a compiled timetable was routed over, in order. Saved stops carry no position, so this is the only binding to it. */
export function routeInputHashOf(candidates: readonly CompilationCandidate[]): string {
  return createHash("sha256").update(JSON.stringify(candidates.map(c => ({ key: c.key, insideAirport: c.insideAirport, point: c.point ? { lat: c.point.lat, lng: c.point.lng } : null, activityTimeMin: c.activityTimeMin, activityCommitment: c.activityCommitment ?? null })))).digest("hex");
}

/** No arbitrary place IDs: a compile can only select current, visible cards certified for this owned session. */
export async function loadCompilationCandidates(db: SupabaseClient, userId: string, sessionId: string, candidateIds: readonly string[], nowMs: number): Promise<CompilationInputs> {
  if (!(await recommendationStatusEnabled(db))) return { ok: false, reason: "feature_disabled" };
  if (candidateIds.length < 1 || candidateIds.length > 6 || new Set(candidateIds).size !== candidateIds.length) return { ok: false, reason: "invalid_candidates" };
  const loaded = await loadOwned(db, userId, sessionId, nowMs);
  if (!loaded.ok) return loaded;
  const evaluation = await evaluate(db, userId, sessionId, { nowMs, loaded });
  if (!evaluation.ok) return evaluation;
  if (!evaluation.storage.stored) return { ok: false, reason: "snapshot_unavailable" };
  const stored = await getRecommendations(db, sessionId);
  if (!stored.ok) return { ok: false, reason: "candidates_unreadable" };
  const selected: CertifiedRecommendation[] = [];
  for (const id of candidateIds) {
    const c = stored.recommendations.find(c => c.id === id || c.contract?.candidateIds.length === 1 && c.contract.candidateIds[0] === id);
    if (!c?.contract || c.contract.state !== "READY" || c.available !== true) return { ok: false, reason: "candidate_unavailable" };
    if (c.contract.snapshotId !== evaluation.storage.snapshotId) return { ok: false, reason: "snapshot_changed" };
    if (c.contract.expiresAt === null || Date.parse(c.contract.expiresAt) <= nowMs) return { ok: false, reason: "candidate_expired" };
    if (!c.insideAirport && landsideStatusOf(evaluation.record) !== "open") return { ok: false, reason: "landside_closed" };
    selected.push(c);
  }
  // Alias IDs must not cause the same experience to be added twice.
  if (new Set(selected.map(c => c.contract!.candidateIds[0])).size !== selected.length) return { ok: false, reason: "invalid_candidates" };
  const points = new Map<string, GeoPoint | null>();
  const placeIds = selected.flatMap(c => !c.insideAirport && c.placeId ? [c.placeId] : []);
  if (placeIds.length) {
    const { data, error } = await db.from("discovery_places").select("id,lat,lng").in("id", placeIds).eq("status", "active");
    if (error) { logger.warn({ err: error, sessionId }, "experience positions unreadable"); return { ok: false, reason: "candidate_positions_unreadable" }; }
    for (const row of data ?? []) points.set(row.id, placePoint(row));
  }
  const commitments=await readActivityCommitments(db,loaded.airport.id,placeIds,nowMs); if(commitments.state==='unavailable')return {ok:false,reason:commitments.reason}; const candidates = selected.map(c => ({ key: c.contract!.candidateIds[0]!, point: c.insideAirport ? airportPoint(loaded.airport) : c.placeId ? points.get(c.placeId) ?? null : null, activityTimeMin: c.contract!.minExperienceMinutes!, insideAirport: c.insideAirport, contract: c.contract!, ...(commitments.state==='disabled'||c.insideAirport?{}:{activityCommitment:commitments.byPlace.get(c.placeId??'')??null}) }));
  if (candidates.some(c=>c.activityCommitment===null||c.activityCommitment&&c.activityTimeMin<c.activityCommitment.minimumCommitmentMinutes+c.activityCommitment.exitDelayMinutes)) return {ok:false,reason:'activity_commitment_unavailable'}; if (candidates.some(c => c.activityTimeMin === null || !Number.isFinite(c.activityTimeMin) || c.activityTimeMin <= 0 || !c.insideAirport && c.point === null)) return { ok: false, reason: "candidate_terms_unavailable" };
  return { ...loaded, record: evaluation.record, snapshotId: evaluation.storage.snapshotId, candidates };
}

/** Compile the selected order with freshly forecast inter-stop hops, then recheck the authoritative snapshot. */
export async function compile(db: SupabaseClient, userId: string, sessionId: string, candidateIds: readonly string[], opts: { nowMs?: number; corridorProvider?: RouteCorridorProvider } = {}): Promise<{ ok: true; contract: LayoverRecommendationContract } | Refusal> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const loaded = await loadCompilationCandidates(db, userId, sessionId, candidateIds, nowMs);
    if (!loaded.ok) return loaded;
    const routed = await routeSelectedExperiences({ session: loaded.session, record: loaded.record, airportPoint: airportPoint(loaded.airport), stops: loaded.candidates, nowMs, corridorProvider: opts.corridorProvider });
    if (!routed.ok) return { ok: false, reason: routed.reason };
    const finalNow = Math.max(nowMs, Date.now());
    if (routed.expiresAt !== null && Date.parse(routed.expiresAt) <= finalNow) return { ok: false, reason: "route_expired" };
    const current = await loadCompilationCandidates(db, userId, sessionId, candidateIds, finalNow);
    if (!current.ok) return current;
    if (current.snapshotId !== loaded.snapshotId) return { ok: false, reason: "snapshot_changed" };
    if (current.candidates.some((c, i) => c.key !== loaded.candidates[i]!.key || c.activityTimeMin !== loaded.candidates[i]!.activityTimeMin || c.point?.lat !== loaded.candidates[i]!.point?.lat || c.point?.lng !== loaded.candidates[i]!.point?.lng || JSON.stringify(c.activityCommitment)!==JSON.stringify(loaded.candidates[i]!.activityCommitment))) return { ok: false, reason: "candidate_changed" };
    const allAirside = loaded.candidates.every(c => c.insideAirport);
    const back = routed.returnLeg;
    const expected = back?.expectedAirportReturnAt ?? routed.finishedAt;
    const usedMs = Date.parse(routed.finishedAt) - Date.parse(routed.departAt);
    const departBy = new Date(Math.min(Date.parse(routed.hardReturnBy) - (Date.parse(expected) - Date.parse(routed.departAt)), loaded.record.deadline.cutoffMs - usedMs, ...loaded.candidates.map(c=>Date.parse(c.contract.departBy??'')))).toISOString();
    const slack = (Date.parse(routed.hardReturnBy) - Date.parse(expected)) / 60_000;
    if (slack < 0 || Date.parse(departBy) < finalNow) return { ok: false, reason: "insufficient_time" };
    const bands = loaded.candidates.map(c => c.contract.riskBand);
    const riskBand = bands.includes("HIGH") ? "HIGH" : bands.includes("MODERATE") || loaded.candidates.some(c=>c.activityCommitment?.interruptibility==='committed') || !allAirside && (slack < LAYOVER_ROUTED_POLICY.tightSlackMinutes || (back?.independentRoutes ?? 0) < 2 || routed.confidence === "LOW") ? "MODERATE" : "LOW";
    const itinerary: LayoverRecommendationContract["itinerary"] = [
      ...routed.hops.map(h => ({ kind: back && h.departAt === back.departAt && h.toKey === back.toKey ? "return" as const : "outbound" as const, startsAt: h.departAt, endsAt: h.arrivesAt, mode: h.mode, candidateId: h.toKey })),
      ...routed.activities.map(a => ({ kind: "experience" as const, startsAt: a.arrivesAt, endsAt: a.leavesAt, mode: null, candidateId: a.key })),
    ].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
    const dwell = loaded.candidates.reduce((sum, c) => sum + c.activityTimeMin, 0);
    const expiresAt = new Date(Math.min(Date.parse(departBy), routed.expiresAt ? Date.parse(routed.expiresAt) : Infinity, ...loaded.candidates.map(c=>c.activityCommitment?Date.parse(c.activityCommitment.expiresAt):Infinity))).toISOString();
    const contract: LayoverRecommendationContract = {
      contractVersion: "2026.10.19-1", state: "READY", snapshotId: loaded.snapshotId, candidateIds: loaded.candidates.map(c => c.key), insideAirport: allAirside,
      departBy, estimatedArrival: routed.activities[0]?.arrivesAt ?? null, minExperienceMinutes: dwell, idealExperienceMinutes: dwell,
      leaveActivityBy: back?.leaveBy ?? routed.hardReturnBy, expectedAirportReturn: expected, hardReturnBy: routed.hardReturnBy,
      returnBufferMinutes: allAirside ? 0 : loaded.record.deadline.breakdown.totalBuffer, riskBand, confidence: routed.confidence, expiresAt,
      fallbackPlan: { beforeDeparture: "stay_airside", duringExperience: allAirside ? "remain_airside" : "return_to_airport", returnBy: routed.hardReturnBy, returnRoute: back ? { mode: back.mode, departAt: back.departAt, minutes: back.minutes, conservativeMinutes: back.conservativeMinutes, forecast: true, transferCount: back.transferCount } : null },
      abortThreshold: { leaveBy: back?.leaveBy ?? routed.hardReturnBy, returnDeadline: routed.hardReturnBy, conditions: ["snapshot_changed", "route_expired", "return_deadline_at_risk", "entry_closed", "live_access_refused"] },
      failureModes: [], reasonCodes: [...new Set(loaded.candidates.flatMap(c => c.contract.reasonCodes))], itinerary,
      routeInputHash: routeInputHashOf(loaded.candidates),
    };
    return { ok: true, contract };
  } catch (err) {
    logger.warn({ err, sessionId }, "experience compilation unavailable");
    return { ok: false, reason: "compilation_unavailable" };
  }
}
