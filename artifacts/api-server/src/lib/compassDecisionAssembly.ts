/**
 * Assemble the inputs of a Compass decision and run the engine — ONCE, for the
 * two surfaces that emit decisions.
 *
 * Until census-compass CCL-09 was built, this lived inline in
 * routes/compassDecision.ts, and the decision reached exactly one surface:
 * `GET /compass/decision`. `/compass/ask`, where a person actually asks
 * "should I go now?", could not call it without importing a route. So the
 * gathering moved here and the route became one caller of two; the other is
 * the `get_decision` tool in compass/CompassTools.ts.
 *
 * Nothing here computes world truth. The candidate's and the current place's
 * live claims come through lib/liveClaimRead — the ONE read path every
 * surface consumes, gated and fail-closed there — the place's coordinates give
 * a walking ETA when the caller sends none, and lib/compassDecision (pure)
 * decides. Writes nothing.
 *
 * The flag is NOT read here. Each caller gates itself on
 * `compass_decision_enabled` first, because the flag's literal name has to sit
 * beside the read for check-flag-polarity to resolve it, and because a caller
 * that forgot would otherwise be handed a decision it had no right to serve.
 */
import { liveLabelsServable, readLiveClaimEnvelopes, type LiveClaimEnvelope } from "./liveClaimRead.js";
import { haversineKm } from "./mapSearch.js";
import { WALKING_SPEED_KMH } from "../compass/CompassLiveConstraints.js";
import { decideCompass, type CompassDecisionResult, type DecisionIntent, type DecisionSubject } from "./compassDecision.js";

/** Literal name so check-flag-polarity resolves the read at each caller. `*_enabled` ⇒ capability, fail-closed. */
export const COMPASS_DECISION_FLAG = "compass_decision_enabled";

export interface DecisionQuery {
  subjectId: string;
  currentSubjectId?: string | null;
  currentSinceMinutes?: number | null;
  returnSubjectId?: string | null;
  intent?: DecisionIntent | null;
  etaMinutes?: number | null;
  queueToleranceMinutes?: number | null;
  lat?: number | null;
  lng?: number | null;
}

export interface PlaceRow {
  id: string;
  name?: string | null;
  latitude: number | null;
  longitude: number | null;
  status: string | null;
}

export type AssembledDecision =
  | { ok: true; result: CompassDecisionResult; place: PlaceRow; liveIntelligenceReadable: boolean; etaMinutes: number | null }
  | { ok: false; reason: "db_error" | "not_found" };

async function readPlace(sc: any, id: string): Promise<{ ok: true; row: PlaceRow | null } | { ok: false }> {
  const { data, error } = await sc.from("places").select("id, name, latitude, longitude, status").eq("id", id).maybeSingle();
  if (error) return { ok: false };
  return { ok: true, row: (data as PlaceRow | null) ?? null };
}

async function subjectState(sc: any, subjectId: string, readable: boolean, now: Date): Promise<DecisionSubject> {
  const envelopes: LiveClaimEnvelope[] = readable ? await readLiveClaimEnvelopes(sc, subjectId, { now }) : [];
  return { subjectId, envelopes, readable };
}

/**
 * ETA: the caller's own estimate wins; otherwise a straight-line walking
 * estimate from the viewer's position, if it sent one; otherwise unknown —
 * and an unknown ETA is an unknown interception, stated by the engine.
 */
export function walkingEtaMinutes(q: DecisionQuery, place: PlaceRow): number | null {
  if (q.etaMinutes !== undefined && q.etaMinutes !== null) return q.etaMinutes;
  if (q.lat !== undefined && q.lat !== null && q.lng !== undefined && q.lng !== null) {
    const { latitude, longitude } = place;
    if (typeof latitude === "number" && typeof longitude === "number") {
      const km = haversineKm(q.lat, q.lng, latitude, longitude);
      return Math.ceil((km / WALKING_SPEED_KMH) * 60);
    }
  }
  return null;
}

export async function assembleCompassDecision(sc: any, q: DecisionQuery, now: Date): Promise<AssembledDecision> {
  const place = await readPlace(sc, q.subjectId);
  if (!place.ok) return { ok: false, reason: "db_error" };
  if (!place.row) return { ok: false, reason: "not_found" };

  const etaMinutes = walkingEtaMinutes(q, place.row);
  const readable = await liveLabelsServable(sc);
  const candidate = await subjectState(sc, q.subjectId, readable, now);
  const current = q.currentSubjectId
    ? { ...(await subjectState(sc, q.currentSubjectId, readable, now)), sinceMinutes: q.currentSinceMinutes ?? null }
    : null;

  const result = decideCompass(
    {
      candidate,
      current,
      returnSubjectId: q.returnSubjectId ?? null,
      intent: q.intent ?? null,
      etaMinutes,
      queueToleranceMinutes: q.queueToleranceMinutes ?? null,
    },
    now.getTime(),
  );
  return { ok: true, result, place: place.row, liveIntelligenceReadable: readable, etaMinutes };
}
