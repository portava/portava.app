/**
 * Trips spec §14.2 and §25 — the trip's ROUTE CHAIN as a projection of the
 * trip's OWN plan. census-trips TR437 (no second itinerary system), TR266
 * (route chains carry expected departure / arrival), TR267–TR271 (the
 * assumption, cost, party size, reliability and fallback references).
 *
 * WHY THIS IS A PROJECTION AND NOT A TABLE
 * ========================================
 * Until §62 the only route chain in the tree was `route_plans` /
 * `route_stops` / `route_legs` (0058): its own stop ordering, its own
 * optimizer, its own checkpoint state, attached to a trip through a
 * nullable `trip_id` and reading nothing the trip knows — the exact
 * "isolated itinerary feature" §25 forbids. A trip's route chain is not a
 * second list of places; it is the trip's placed plan items in time order,
 * with what §14.2 says a chain carries computed BETWEEN them: the departure
 * the previous item implies, the travel term (the same bound and the same
 * departure-time assumption the freedom projection uses — §40.3, §60), the
 * arrival that follows, the crew's size, and — where 2782's transport
 * segments exist for the hop — cost, reliability and the fallback reference.
 * Nothing here is stored; a change to a plan item changes the chain on the
 * next read, and the read is recorded as a §21.2 decision.
 *
 * WHAT IS NOT CLAIMED
 * ===================
 * `route_plans` still exists for routes that are not a trip's (a circle's,
 * a standalone one). §62 also makes a route plan that names a trip a VIEW
 * over that trip's plan items (routes/routePlan.ts, under the gate); the
 * table's own optimizer and checkpoint state are untouched, which is why
 * TR437 holds W and not C.
 */
import { logger } from "../../../lib/logger.js";
import { tripOperationalProjectionsGate, refusalForGate } from "../policies/tripOperationalProjections.js";
import { liveEnvelope, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";
import { straightLineTravelTimeProvider, estimateTravel, type GeoPoint } from "../contracts/TravelTimeProvider.js";
import { travelMinutesAt, FEASIBILITY_PERCENTILE, isRoutedSourceClass } from "../../../lib/travelEstimate.js";
import { withDepartureAssumptions } from "../services/TripDepartureAssumptions.js";
import { estimateTransportReliability } from "../services/tripTransportReliability.js";
import { recordTripDecision, persistTripDecision, TRIP_ENGINE_VERSIONS } from "../services/TripDecisionLedger.js";
import type { ArrivalAssumption } from "./TripFreedomProjection.js";

const log = logger.child({ mod: "tripRouteChainProjection" });
const BOUND_PROVIDER = straightLineTravelTimeProvider;

export interface RouteChainStop {
  planItemId: string;
  title: string | null;
  category: string | null;
  status: string | null;
  startsAt: string | null;
  endsAt: string | null;
  dayDate: string | null;
  locationName: string | null;
  point: GeoPoint | null;
}

export interface RouteChainHop {
  fromPlanItemId: string;
  toPlanItemId: string;
  /** When the traveller leaves the previous item: its end, else its start. ISO. */
  departAt: string;
  travel: {
    /** The free-flow LOWER BOUND, minutes — what feasibility is judged on. null: unknown. */
    boundMinutes: number | null;
    /** The bound under the departure-time assumption (§60). null: unknown. */
    expectedMinutes: number | null;
    unknownReason: string | null;
    assumption: ArrivalAssumption | null;
    sourceClass: string | null;
    routed: boolean;
  };
  /** Arrival at the bound and under the assumption. ISO or null. */
  arrivalAtBound: string | null;
  expectedArrivalAt: string | null;
  partySize: number;
  /** 2782's segment for this hop, matched by label or by planned departure; null when none. */
  segment: {
    id: string; mode: string; state: string;
    costMinor: number | null; currency: string | null; fallbackOf: string | null;
    reliability: { value: number; basis: "stated" | "estimated"; reading: string };
  } | null;
}

export interface TripRouteChainProjection extends TripProjectionEnvelope {
  tripId: string;
  decisionId: string;
  stops: RouteChainStop[];
  hops: RouteChainHop[];
  /** Plan items that could not be placed on the chain: no start time, or no point. */
  unplaced: Array<{ planItemId: string; reason: "NO_TIME" | "NO_POINT" }>;
  partySize: number;
  segments: { status: "ok" | "unread"; reason: string | null; count: number };
  provider: { id: string; routed: boolean; assumptionsModel: string };
  disclosure: string;
  reading: string;
}

export const ROUTE_CHAIN_READING =
  "§14.2: the trip's placed plan items in time order, with the travel term between them the same LOWER BOUND and the same departure-time assumption the freedom projection uses; cost, reliability and fallback come from 2782's segment for the hop where one exists, and are null where none does. Not a route_plan: nothing here is stored, and no stop exists that is not a plan item.";

export type RouteChainProjectionResult =
  | { ok: true; projection: TripRouteChainProjection }
  | { ok: false; reason: "TRIP_NOT_FOUND" | "TRIP_PROJECTION_UNAVAILABLE" | "FEATURE_DISABLED"; message: string };

const point = (lat: unknown, lng: unknown): GeoPoint | null =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
const ms = (iso: string | null): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isFinite(t) ? t : null; };

export async function buildTripRouteChainProjection(
  sc: any,
  tripId: string,
  opts: { now?: Date } = {},
): Promise<RouteChainProjectionResult> {
  const now = opts.now ?? new Date();
  const gate = await tripOperationalProjectionsGate(sc);
  if (!gate.enabled) return refusalForGate(gate);

  const { data: trip, error: tripErr } = await sc.from("trips").select("owner_id, version, timezone").eq("id", tripId).maybeSingle();
  if (tripErr) { log.warn({ err: tripErr.message, tripId }, "route chain: trip unreadable"); return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The trip could not be read" }; }
  if (!trip) return { ok: false, reason: "TRIP_NOT_FOUND", message: "Trip not found" };
  const t = trip as any;
  const envelope = liveEnvelope(typeof t.version === "number" ? t.version : null, now);
  const provider = withDepartureAssumptions(BOUND_PROVIDER, typeof t.timezone === "string" ? t.timezone : null);

  const { data: items, error: iErr } = await sc
    .from("trip_plan_items")
    .select("id, title, category, status, starts_at, ends_at, day_date, lat, lng, location_name")
    .eq("trip_id", tripId)
    .is("removed_at", null);
  if (iErr) { log.warn({ err: iErr.message, tripId }, "route chain: trip_plan_items unreadable — refusing"); return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The plan could not be read" }; }

  const { data: members, error: mErr } = await sc
    .from("trip_members").select("user_id, status").eq("trip_id", tripId).in("role", ["owner", "co_host", "member", "viewer"]);
  if (mErr) { log.warn({ err: mErr.message, tripId }, "route chain: trip_members unreadable — refusing"); return { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE", message: "The crew could not be read" }; }
  const party = new Set<string>(t.owner_id ? [String(t.owner_id)] : []);
  for (const m of ((members ?? []) as any[])) if (m.status == null || m.status === "accepted") party.add(String(m.user_id));
  const partySize = party.size;

  // 2782's segments: read softly. Where the deployment has no such table the
  // chain still exists — cost, reliability and fallback are then null and
  // the projection says why, rather than the whole chain being refused.
  let segments: { status: "ok" | "unread"; reason: string | null; count: number } = { status: "ok", reason: null, count: 0 };
  let segRows: any[] = [];
  const { data: segData, error: segErr } = await sc
    .from("trip_transport_segments")
    .select("id, mode, state, from_label, to_label, planned_departure_at, planned_arrival_at, party_size, reliability, cost_minor, currency, fallback_of")
    .eq("trip_id", tripId);
  if (segErr) segments = { status: "unread", reason: `trip_transport_segments could not be read (${segErr.message ?? "unknown"}) — 2782 may not be applied here`, count: 0 };
  else { segRows = (segData ?? []) as any[]; segments = { status: "ok", reason: null, count: segRows.length }; }

  const stops: RouteChainStop[] = ((items ?? []) as any[])
    .filter((p) => p.status !== "cancelled" && p.status !== "removed")
    .map((p) => ({
      planItemId: String(p.id), title: p.title ?? null, category: p.category ?? null, status: p.status ?? null,
      startsAt: p.starts_at ?? null, endsAt: p.ends_at ?? null, dayDate: p.day_date ?? null,
      locationName: p.location_name ?? null, point: point(p.lat, p.lng),
    }));
  const unplaced: TripRouteChainProjection["unplaced"] = [];
  const placed = stops.filter((s) => {
    if (ms(s.startsAt) === null) { unplaced.push({ planItemId: s.planItemId, reason: "NO_TIME" }); return false; }
    if (!s.point) { unplaced.push({ planItemId: s.planItemId, reason: "NO_POINT" }); return false; }
    return true;
  }).sort((a, b) => ms(a.startsAt)! - ms(b.startsAt)!);

  const hops: RouteChainHop[] = [];
  for (let i = 1; i < placed.length; i += 1) {
    const prev = placed[i - 1]!; const next = placed[i]!;
    const departMs = ms(prev.endsAt) ?? ms(prev.startsAt)!;
    const departAt = new Date(departMs);
    const travel = await estimateTravel(provider, { from: prev.point, to: next.point, departAt }, now);
    const bound = travel.kind === "estimate" ? travelMinutesAt(travel.estimate, FEASIBILITY_PERCENTILE) : null;
    const expected = travel.kind === "estimate" && typeof travel.expectedMinutes === "number" ? Math.max(bound ?? 0, travel.expectedMinutes) : null;
    const a = travel.kind === "estimate" ? (travel.assumption ?? null) : null;
    const seg = segRows.find((s) =>
      (s.from_label && s.to_label && s.from_label === prev.locationName && s.to_label === next.locationName)
      || (s.planned_departure_at && ms(s.planned_departure_at) === departMs));
    const rel = seg ? estimateTransportReliability(
      { id: String(seg.id), mode: String(seg.mode ?? "unknown"), state: String(seg.state ?? "planned"), plannedDepartureAt: seg.planned_departure_at ?? null, reliability: typeof seg.reliability === "number" ? seg.reliability : null },
      [], now.getTime(),
    ) : null;
    hops.push({
      fromPlanItemId: prev.planItemId, toPlanItemId: next.planItemId, departAt: departAt.toISOString(),
      travel: {
        boundMinutes: bound, expectedMinutes: expected,
        unknownReason: travel.kind === "unknown" ? travel.reason : null,
        assumption: a ? { band: a.band, factor: a.factor, localHour: a.localHour, weekend: a.weekend, timezone: a.timezone, timezoneAssumed: a.timezoneAssumed, mode: a.mode, transitServiceLikely: a.transitServiceLikely, sourceClass: a.sourceClass, confidence: a.confidence, detail: a.detail } : null,
        sourceClass: travel.kind === "estimate" ? travel.estimate.sourceClass : null,
        routed: travel.kind === "estimate" ? isRoutedSourceClass(travel.estimate.sourceClass) : false,
      },
      arrivalAtBound: bound === null ? null : new Date(departMs + bound * 60_000).toISOString(),
      expectedArrivalAt: expected === null ? null : new Date(departMs + expected * 60_000).toISOString(),
      partySize: typeof seg?.party_size === "number" ? seg.party_size : partySize,
      segment: seg && rel ? {
        id: String(seg.id), mode: String(seg.mode ?? "unknown"), state: String(seg.state ?? "planned"),
        costMinor: typeof seg.cost_minor === "number" ? seg.cost_minor : null, currency: seg.currency ?? null,
        fallbackOf: seg.fallback_of ?? null,
        reliability: { value: rel.value, basis: rel.basis, reading: rel.reading },
      } : null,
    });
  }

  const decision = recordTripDecision({
    tripId, type: "route_chain",
    inputs: { sourceTripVersion: envelope.sourceTripVersion, planItemIds: placed.map((s) => s.planItemId), unplaced: unplaced.length, partySize, segments: segments.count, segmentsStatus: segments.status },
    sources: ["trips", "trip_plan_items", "trip_members", "trip_transport_segments"],
    assumptions: [
      "the chain is the trip's placed plan items in start order; a plan item is not a route stop and no stop exists that is not a plan item",
      `travel term is ${provider.id}'s fastest-mode straight-line LOWER BOUND at the feasibility percentile; expected arrival applies ${provider.assumptionsModel}'s factor over it (§14.2)`,
      "a hop's segment is matched by from/to label or by planned departure; cost, reliability and fallback are null where no segment matches",
    ],
    constraints: hops.filter((h) => h.travel.unknownReason).map((h) => `TRAVEL_UNKNOWN:${h.travel.unknownReason}`),
    result: { stops: placed.length, hops: hops.length, withSegment: hops.filter((h) => h.segment).length, unplaced: unplaced.length },
    confidence: hops.length === 0 ? "N/A" : hops.every((h) => h.travel.boundMinutes !== null) ? "LOW" : "INSUFFICIENT",
    engineVersions: { TripFeasibilityEngine: TRIP_ENGINE_VERSIONS.TripFeasibilityEngine, TravelTimeProvider: TRIP_ENGINE_VERSIONS.TravelTimeProvider, TripDepartureAssumptions: TRIP_ENGINE_VERSIONS.TripDepartureAssumptions },
    calculatedAt: envelope.generatedAt, sourceTripVersion: envelope.sourceTripVersion,
  });
  void persistTripDecision(sc, decision);

  return {
    ok: true,
    projection: {
      ...envelope, tripId, decisionId: decision.decisionId,
      stops: placed, hops, unplaced, partySize, segments,
      provider: { id: provider.id, routed: provider.routed, assumptionsModel: provider.assumptionsModel },
      disclosure: "Every travel term is a straight-line lower bound and every expected arrival a static assumption over it; no routed provider exists on this tree (TR128).",
      reading: ROUTE_CHAIN_READING,
    },
  };
}
