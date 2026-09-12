/**
 * Trips spec §7.3 — "Trips queries the Temporal Freedom Engine for gaps
 * between commitments", as ONE builder that the §12.1 `getFreedomWindows`
 * read (`GET /trips/:tripId/freedom-windows`) and Compass's
 * `get_freedom_windows` tool both call. Two consumers, one object, one
 * envelope (§19.1) — the same shape as TripCompassProjection.
 *
 * WHAT IT READS, AND WHAT A FAILED READ DOES
 * =========================================
 *   trips             dates and version — the envelope; refused when unreadable
 *   trip_commitments  the fixed points — refused when unreadable: a window
 *                     computed over "no commitments" is the whole trip, which
 *                     is the most confident wrong answer this file could give
 *   places            coordinates for the travel term — refused when the READ
 *                     fails; a place with no coordinates is a fact (NO_ORIGIN /
 *                     TRAVEL_UNKNOWN), not a failure
 *   trip_members      the participants — refused when unreadable
 *
 * The travel term per hop comes from services/trips/TripFeasibilityEngine.ts
 * with the same straight-line provider routes/tripFeasibility.ts uses, so the
 * feasibility verdict and the window between the same two commitments cannot
 * disagree about the travel term. `resolvePlaces` and `intervalToMinutes` are
 * imported from that route module rather than copied; the module registers a
 * router on import, which routes/index.ts does anyway.
 *
 * §21.1 `temporal_conflict_total` is incremented here, at detection, by kind.
 */
import { logger } from "../../lib/logger.js";
import { incrementTripMetric } from "../../lib/tripMetrics.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../../lib/tripOperationalProjections.js";
import { resolvePlaces, intervalToMinutes, FEASIBILITY_UNVERIFIED_DISCLOSURE } from "../../routes/tripFeasibility.js";
import { checkFeasibility } from "./TripFeasibilityEngine.js";
import { straightLineTravelTimeProvider, type GeoPoint } from "./TravelTimeProvider.js";
import { liveEnvelope, type TripProjectionEnvelope } from "./TripProjectionEnvelope.js";
import { recordTripDecision, persistTripDecision, TRIP_ENGINE_VERSIONS } from "./TripDecisionLedger.js";
import { recordDerivedEvents, type DerivedEventsReport } from "../../lib/tripDerivedEvents.js";
import {
  computeFreedomWindows, type EngineCommitment, type FreedomWindow, type HopTravel, type TemporalConflict,
} from "./TripFreedomEngine.js";

const log = logger.child({ mod: "tripFreedomProjection" });
const PROVIDER = straightLineTravelTimeProvider;

export interface TripFreedomProjection extends TripProjectionEnvelope {
  tripId: string;
  /** §21.2: the ledger record this projection was computed as; explain it at GET /trips/:id/decisions/:decisionId/explain. */
  decisionId: string;
  windows: FreedomWindow[];
  /** §4.2: what the engine recorded as domain events for this read (2785), or why nothing was. */
  derivedEvents: DerivedEventsReport;
  conflicts: TemporalConflict[];
  commitmentCount: number;
  unplacedCommitmentIds: string[];
  /** Commitment place ids that resolved to no `places` row. */
  unresolvedPlaceIds: string[];
  participants: string[];
  provider: { id: string; routed: boolean };
  disclosure: string;
  reading: string;
}

export const FREEDOM_READING =
  "§7.3: gaps between commitments, each a LOWER BOUND on free time (window ends when the traveller must leave to make the next commitment against a straight-line travel term). No window is certified without a routed provider. Conflicts are returned beside the windows, never dropped; no override path exists.";

export type FreedomProjectionResult =
  | { ok: true; projection: TripFreedomProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED"; message: string };

interface CommitmentRow {
  id: string; type: string; starts_at: string | null; required_arrival_at: string | null;
  place_id: string | null; lateness_tolerance: string | null; prep_duration: string | null; flexibility: string | null;
}

function dateOrNull(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** `YYYY-MM-DD` → the first instant of that day (start) or the last (end), UTC. */
function dayBound(iso: string | null, edge: "start" | "end"): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const d = new Date(`${iso}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function buildTripFreedomProjection(
  sc: any,
  tripId: string,
  opts: { now?: Date } = {},
): Promise<FreedomProjectionResult> {
  const now = opts.now ?? new Date();

  // The capability gate, FIRST — see lib/tripOperationalProjections.ts. Every
  // read below belongs to that flag's closure, not to a caller's.
  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  const { data: trip, error: tripErr } = await sc.from("trips").select("start_date, end_date, owner_id, version").eq("id", tripId).maybeSingle();
  if (tripErr) {
    log.warn({ err: tripErr.message, tripId }, "freedom: trip unreadable");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" };
  }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const t = trip as any;
  const envelope = liveEnvelope(typeof t.version === "number" ? t.version : null, now);

  const { data: rows, error: cErr } = await sc
    .from("trip_commitments")
    .select("id, type, starts_at, required_arrival_at, place_id, lateness_tolerance, prep_duration, flexibility")
    .eq("trip_id", tripId)
    .order("starts_at", { ascending: true, nullsFirst: false });
  if (cErr) {
    log.warn({ err: cErr.message, tripId }, "freedom: commitments unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "This trip's commitments could not be read" };
  }
  const commitments = ((rows ?? []) as CommitmentRow[]);

  const places = await resolvePlaces(sc, commitments.map((r) => r.place_id ?? ""));
  if (!places) {
    log.warn({ tripId }, "freedom: places unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The places these commitments are at could not be read" };
  }
  const pointOf = (id: string | null): GeoPoint | null => (id ? places.coords.get(id) ?? null : null);

  const { data: members, error: mErr } = await sc
    .from("trip_members")
    .select("user_id, status")
    .eq("trip_id", tripId)
    .in("role", ["owner", "co_host", "member", "viewer"]);
  if (mErr) {
    log.warn({ err: mErr.message, tripId }, "freedom: trip_members unreadable — refusing");
    return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The crew could not be read" };
  }
  const participants = new Set<string>(t.owner_id ? [String(t.owner_id)] : []);
  for (const m of ((members ?? []) as any[])) if (m.status == null || m.status === "accepted") participants.add(String(m.user_id));

  const engineCommitments: EngineCommitment[] = commitments.map((r) => ({
    id: r.id, type: r.type,
    startsAt: dateOrNull(r.starts_at), requiredArrivalAt: dateOrNull(r.required_arrival_at),
    endsAt: null, // 2761: no end column
    place: { placeId: r.place_id ?? null, point: pointOf(r.place_id) },
    flexibility: r.flexibility ?? "flexible",
    prepMinutes: intervalToMinutes(r.prep_duration) ?? 0,
    latenessToleranceMinutes: intervalToMinutes(r.lateness_tolerance) ?? 0,
  }));

  // The travel term per hop, from the feasibility engine, in the engine's
  // own order (by deadline). One hop per adjacent placed pair.
  const placed = engineCommitments
    .filter((c) => (c.requiredArrivalAt ?? c.startsAt) !== null)
    .sort((a, b) => (a.requiredArrivalAt ?? a.startsAt)!.getTime() - (b.requiredArrivalAt ?? b.startsAt)!.getTime());
  const hops: HopTravel[] = [];
  for (let i = 1; i < placed.length; i += 1) {
    const prev = placed[i - 1]!; const next = placed[i]!;
    const departFrom = prev.endsAt ?? prev.startsAt ?? prev.requiredArrivalAt!;
    const r = await checkFeasibility(PROVIDER, { departFrom, fromPlace: prev.place.point }, {
      toPlace: next.place.point, requiredArrivalAt: next.requiredArrivalAt, startsAt: next.startsAt,
      prepMinutes: next.prepMinutes, latenessToleranceMinutes: next.latenessToleranceMinutes,
    }, now);
    hops.push({ travelMinutes: r.travelMinutes, confidence: r.confidence, routed: r.routed, unknownReason: r.unknownReason });
  }

  const result = computeFreedomWindows({
    commitments: engineCommitments, hops, participants: [...participants],
    tripStart: dayBound(t.start_date ?? null, "start"), tripEnd: dayBound(t.end_date ?? null, "end"),
  });
  for (const c of result.conflicts) incrementTripMetric("temporal_conflict_total", { kind: c.kind });

  // §4.2: the engine's judgement becomes domain events — commitment_at_risk
  // per conflicting commitment, free_window_created per window — through the
  // kernel's 'engine' capability (2785), keyed by the fact's identity so a
  // re-read is a duplicate. Skipped, and said so, while trip_kernel_enabled
  // is false.
  const derivedEvents = await recordDerivedEvents(sc, tripId, { windows: result.windows, conflicts: result.conflicts }, { now });

  // §21.2: ids, versions and counts — never a coordinate or a name.
  const decision = recordTripDecision({
    tripId, type: "freedom_windows",
    inputs: {
      sourceTripVersion: envelope.sourceTripVersion,
      commitmentIds: placed.map((c) => c.id),
      hopTravelMinutes: hops.map((h) => h.travelMinutes),
      unresolvedPlaceIds: places.unresolved,
      participants: participants.size,
      tripDates: { start: t.start_date ?? null, end: t.end_date ?? null },
    },
    sources: ["trips", "trip_commitments", "places", "trip_members"],
    assumptions: [
      "a commitment has no end column (2761); a window begins at the commitment's start, never before its latest allowed arrival",
      `travel term is ${PROVIDER.id}'s fastest-mode straight-line LOWER BOUND at the feasibility percentile; no window is certified`,
    ],
    constraints: [...new Set(result.windows.flatMap((w) => w.hardConstraints.map((h) => h.kind)))],
    result: { windows: result.windows.length, conflicts: result.conflicts.map((c) => c.kind), unplaced: result.unplacedCommitmentIds.length },
    confidence: result.windows.reduce<"HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT">((worst, w) => {
      const order = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"]; return order.indexOf(w.confidence) < order.indexOf(worst) ? w.confidence : worst;
    }, "HIGH"),
    engineVersions: { TripFreedomEngine: TRIP_ENGINE_VERSIONS.TripFreedomEngine, TripFeasibilityEngine: TRIP_ENGINE_VERSIONS.TripFeasibilityEngine, TravelTimeProvider: TRIP_ENGINE_VERSIONS.TravelTimeProvider },
    calculatedAt: envelope.generatedAt, sourceTripVersion: envelope.sourceTripVersion,
  });
  // §5.3 (2781): kept for 90 days by policy where the deployment can; the projection is served either way.
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope,
      tripId,
      decisionId: decision.decisionId,
      windows: result.windows,
      conflicts: result.conflicts,
      derivedEvents,
      commitmentCount: commitments.length,
      unplacedCommitmentIds: result.unplacedCommitmentIds,
      unresolvedPlaceIds: places.unresolved,
      participants: [...participants],
      provider: { id: PROVIDER.id, routed: PROVIDER.routed },
      disclosure: FEASIBILITY_UNVERIFIED_DISCLOSURE,
      reading: FREEDOM_READING,
    },
  };
}
