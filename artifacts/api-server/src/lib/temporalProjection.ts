/**
 * temporalProjection — the PRODUCER half of Map spec §15 Time Machine.
 *
 * THE DEFECT THIS CLOSES (audit HIGH)
 * ===================================
 * §15 gives the map temporal intelligence — "historical observation and future
 * prediction, with unmistakably different visual treatment" — but NO route,
 * service or projection ever emitted a `prediction` object or any per-offset
 * historical state. The client's `toTemporalObjects` could only RELABEL the
 * objects on screen NOW, so every future offset (+30m/+60m/+120m) would have
 * rendered today's map wearing a forecast badge, and the mode was deliberately
 * held CLOSED (`mapStore.TIME_MACHINE_HAS_NO_SOURCE`) rather than ship that.
 * This module is the source that lets the mode open.
 *
 * WHAT IT PRODUCES, AND FROM WHAT — DETERMINISTIC SOURCES ONLY
 * ===========================================================
 * §37: "Do not make predictions look like observations." So every forecast
 * object this module emits is `kind: 'prediction'` (which the client's
 * `isForecastKind` and `toTemporalObject` turn into the §6 dashed-boundary
 * treatment) and NEVER carries a live freshness. Nothing here invents a live
 * condition (§37 again): a forecast is built only from a scheduled fact that is
 * already recorded, and its confidence describes the SCHEDULE, not a sighting.
 *
 *   FUTURE (forecast) offsets are built from three schedule sources whose
 *   windows cover the target instant t+offset:
 *
 *     events     — a scheduled event whose [starts_at, ends_at] window covers
 *                  the target window. Public, place-level, one object per event.
 *     itinerary  — the VIEWER'S OWN route_stop whose planned arrival/departure
 *                  covers the target. A self-planned intention, place-level,
 *                  never another person's plan (the route reads only the
 *                  viewer's own plans).
 *     accepted_plan — the crowd-flow accepted_plan family, AGGREGATED to zones.
 *                  A single accepted plan is one person's future position, so it
 *                  is NEVER emitted individually (§23/§37). It is folded into a
 *                  zone cohort and published only when the cohort clears
 *                  PRIVACY_THRESHOLD_V1 exactly as crowd flow does — k distinct
 *                  actors, independent groups, no dominant party, and a
 *                  publication delay measured from the (past) acceptance time.
 *                  Today the consent table is empty and the flag is off, so this
 *                  source publishes nothing; the route reports the refusal so
 *                  "no predicted crowds" is never ambiguous with broken wiring.
 *
 *   HISTORICAL offsets (Yesterday / Last Friday) are NOT reconstructed here from
 *   live data — that would fabricate a past. They are read from
 *   `intel_state_snapshot_versions` (migration 2273), the append-only record of
 *   every projection pass, selecting the version that was LIVE at the target
 *   instant. That table is empty until the projection scheduler runs (its flag
 *   is off), so the honest answer today is "no history yet" — `projectHistory`
 *   returns an empty set and the route says `history.available = false`. It
 *   never invents a historical claim.
 *
 * PURITY
 * ======
 * Everything here is pure: rows in, MapObjects out, `now` injected. No I/O, no
 * clock of its own, no zone geometry queries — the route resolves plan-stop
 * coordinates to zones through the SAME `buildFlowZoneModel` crowd flow uses and
 * hands the resolved arrivals here. That keeps the §24 protection gate and §31
 * aggregation (which the route applies to this module's output) the single
 * privacy authority, exactly as routes/mapProjection does.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type ActivityLevel,
  type ConfidenceState,
  type MapObject,
  type TrendState,
} from "./mapObjects.js";
import { crowdValueToActivity, crowdValueToTrend, type LiveClaimLike } from "./mapProjection.js";
import { evaluatePrivacy, type PrivacyThreshold } from "./privacyGate.js";
import { PRIVACY_THRESHOLD_V1 } from "./intelContracts.js";

// ── Temporal target (mirrors the client's timeMachine.resolveOffset) ──────────

export const TEMPORAL_MODES = ["forecast", "historical", "now"] as const;
export type TemporalMode = (typeof TEMPORAL_MODES)[number];

/**
 * How far either side of `now` still reads as "now" rather than past/future.
 * Mirrors the client's NOW_TOLERANCE_MS so the two ends of the wire cannot
 * disagree about which side of the present an instant sits on.
 */
export const TEMPORAL_NOW_TOLERANCE_MS = 60_000;

/**
 * Half-width of the window a relative forecast covers. "+60m" is a claim about
 * a PERIOD around t+60, not one instant of it — mirrors the client's
 * RELATIVE_WINDOW_HALF_WIDTH_MINUTES so both ends draw the same band.
 */
export const RELATIVE_WINDOW_HALF_WIDTH_MINUTES = 15;

/** Widest offset the endpoint will resolve, either direction. 14 days. */
export const MAX_OFFSET_MINUTES = 14 * 24 * 60;

const MS_PER_MINUTE = 60_000;

export interface TemporalTarget {
  /** The instant the map is being asked about, in ms. */
  at: number;
  /** The period that instant stands for. */
  windowStart: number;
  windowEnd: number;
  mode: TemporalMode;
}

/**
 * Which side of the present an instant sits on. Identical rule to the client's
 * `classify`, so a forecast is a forecast on both ends of the wire.
 */
export function classifyTemporalMode(atMs: number, nowMs: number): TemporalMode {
  const delta = atMs - nowMs;
  if (delta > TEMPORAL_NOW_TOLERANCE_MS) return "forecast";
  if (delta < -TEMPORAL_NOW_TOLERANCE_MS) return "historical";
  return "now";
}

function toMs(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Resolve the request's target from raw query values. Two forms, and only two:
 *
 *   offsetMinutes=N                    the §15 primary/relative control. The
 *                                      window is ±RELATIVE_WINDOW_HALF_WIDTH.
 *   windowStartsAt & windowEndsAt      the §15 named calendar controls, which
 *                                      the CLIENT resolves (it owns the timezone
 *                                      and calendar arithmetic — the server must
 *                                      not re-derive "Last Friday" in a second,
 *                                      possibly-divergent place). `at` defaults
 *                                      to the window midpoint.
 *
 * Returns null for anything malformed, out of range or inverted — a bad target
 * must be an error, never a silently-substituted one. The MODE is always
 * decided here from the resolved instant vs `now`, so the client cannot ask the
 * server to treat a past instant as a forecast or vice-versa.
 */
export function parseTemporalTarget(
  q: { offsetMinutes?: unknown; at?: unknown; windowStartsAt?: unknown; windowEndsAt?: unknown },
  nowMs: number,
): TemporalTarget | null {
  const hasOffset = q.offsetMinutes !== undefined && q.offsetMinutes !== null && q.offsetMinutes !== "";
  const hasWindow = q.windowStartsAt !== undefined && q.windowEndsAt !== undefined;

  if (hasOffset && !hasWindow) {
    const n = Number(q.offsetMinutes);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (Math.abs(n) > MAX_OFFSET_MINUTES) return null;
    const at = nowMs + n * MS_PER_MINUTE;
    const half = RELATIVE_WINDOW_HALF_WIDTH_MINUTES * MS_PER_MINUTE;
    return { at, windowStart: at - half, windowEnd: at + half, mode: classifyTemporalMode(at, nowMs) };
  }

  if (hasWindow) {
    const ws = toMs(q.windowStartsAt);
    const we = toMs(q.windowEndsAt);
    if (ws === null || we === null || ws >= we) return null;
    const atRaw = q.at !== undefined ? toMs(q.at) : null;
    const at = atRaw !== null && atRaw >= ws && atRaw <= we ? atRaw : Math.round((ws + we) / 2);
    // A named window can be days wide; bound it so a request cannot ask the
    // producer to sweep an unbounded span of the schedule.
    if (Math.abs(at - nowMs) > MAX_OFFSET_MINUTES * MS_PER_MINUTE) return null;
    return { at, windowStart: ws, windowEnd: we, mode: classifyTemporalMode(at, nowMs) };
  }

  return null;
}

/** Two closed intervals overlap? Inclusive, so a touch at an endpoint counts. */
function windowsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

// ── Source 1: scheduled events (forecast) ─────────────────────────────────────

/** Confidence a scheduled event's forecast carries, by its lifecycle state. */
export function eventForecastConfidence(state: unknown): ConfidenceState {
  // A published/confirmed event with a schedule covering the window is a strong
  // forecast (the schedule is a recorded fact). A draft/tentative one is weaker.
  const s = typeof state === "string" ? state.toLowerCase() : "";
  if (s === "published" || s === "confirmed" || s === "active" || s === "live") return "strong";
  return "likely_current";
}

/**
 * A scheduled event whose active window covers the target → one `prediction`.
 *
 * Only in forecast mode: an event that already happened is history, and history
 * comes from the snapshot table, never from re-reading a schedule as if it were
 * an observation. `ends_at` absent means the event is treated as an instant at
 * `starts_at`; present means the [starts, ends] interval must overlap the target
 * window.
 */
export function projectEventForecast(
  ev: any,
  target: TemporalTarget,
): MapObject | null {
  if (target.mode !== "forecast") return null;
  if (ev?.location_lat == null || ev?.location_lng == null) return null;
  const starts = toMs(ev.starts_at);
  if (starts === null) return null;
  const ends = toMs(ev.ends_at);
  const activeStart = starts;
  const activeEnd = ends !== null && ends >= starts ? ends : starts;
  if (!windowsOverlap(activeStart, activeEnd, target.windowStart, target.windowEnd)) return null;

  const predictedFor = new Date(target.at).toISOString();
  return {
    id: `prediction:event:${ev.id}`,
    kind: "prediction",
    geometry: point(Number(ev.location_lat), Number(ev.location_lng)),
    title: ev.title ?? "Event",
    subtitle: ev.location_name ?? undefined,
    // No observedAt: a prediction was never observed (§37). expiresAt is the
    // event's own end, so the forecast object cannot outlive the thing it
    // predicts.
    expiresAt: ends !== null ? new Date(ends).toISOString() : undefined,
    confidence: eventForecastConfidence(ev.state),
    privacyClass: "place_level",
    renderingPriority: KIND_DEFAULT_PRIORITY.prediction,
    interaction: {
      actions: ["view", "navigate", "add_to_trip"],
      detailRoute: `/event/${ev.id}`,
      opensSheet: true,
    },
    payload: {
      source: "event",
      eventId: ev.id,
      startsAt: ev.starts_at ?? null,
      endsAt: ev.ends_at ?? null,
      locationName: ev.location_name ?? null,
      predictedFor,
    },
  };
}

// ── Source 2: the viewer's own itinerary stops (forecast) ─────────────────────

/** Confidence a self-planned itinerary stop carries. */
export const ITINERARY_FORECAST_CONFIDENCE: ConfidenceState = "likely_current";

/**
 * The viewer's OWN route stop whose planned window covers the target → one
 * `prediction` at the stop. `planned_departure_time` absent means the stop is
 * treated as an instant at `planned_arrival_time`.
 *
 * The caller MUST pass only stops from the viewer's own route plans (the route
 * scopes them through route_plans.owner_user_id). This is the viewer's own
 * intention, so it is place-level and needs no aggregation — exactly like a
 * `trip_stop`.
 */
export function projectItineraryStopForecast(stop: any, target: TemporalTarget): MapObject | null {
  if (target.mode !== "forecast") return null;
  const loc = stop?.structured_location;
  const lat = loc && typeof loc === "object" ? Number((loc as any).lat) : NaN;
  const lng = loc && typeof loc === "object" ? Number((loc as any).lng) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const arrive = toMs(stop.planned_arrival_time);
  if (arrive === null) return null;
  const departRaw = toMs(stop.planned_departure_time);
  const depart = departRaw !== null && departRaw >= arrive ? departRaw : arrive;
  if (!windowsOverlap(arrive, depart, target.windowStart, target.windowEnd)) return null;

  const predictedFor = new Date(target.at).toISOString();
  return {
    id: `prediction:itinerary:${stop.id}`,
    kind: "prediction",
    geometry: point(lat, lng),
    title: stop.title ?? (loc as any)?.label ?? "Planned stop",
    subtitle: (loc as any)?.label ?? undefined,
    expiresAt: new Date(depart).toISOString(),
    confidence: ITINERARY_FORECAST_CONFIDENCE,
    privacyClass: "place_level",
    renderingPriority: KIND_DEFAULT_PRIORITY.prediction,
    interaction: { actions: ["view", "navigate"], opensSheet: true },
    payload: {
      source: "itinerary",
      stopId: stop.id,
      plannedArrivalTime: stop.planned_arrival_time ?? null,
      plannedDepartureTime: stop.planned_departure_time ?? null,
      predictedFor,
    },
  };
}

// ── Source 3: accepted-plan arrivals, AGGREGATED to zones (forecast) ──────────

/**
 * One accepted plan's stop that is scheduled to be reached within the target
 * window, already resolved to a zone by the caller (the route uses the SAME
 * `buildFlowZoneModel` crowd flow uses; a stop that resolves to no zone is
 * dropped, never approximated to its coordinate). No coordinate survives onto
 * this type — only the zone id and the zone's published centroid.
 */
export interface PlanArrival {
  zoneId: string;
  zoneCentroid: { lat: number; lng: number };
  /** The accepter — a person. Counted in a Set, never emitted. */
  actorId: string;
  /**
   * The party's group token. Follows lib/intelGroupKey's ruling: a trip-linked
   * plan yields a crew token keyed on the trip (so five friends on one trip
   * collapse to ONE party — the leak the gate must catch); a plan with no trip
   * yields a solo token, since "a solo visitor counts as its own independent
   * group". Null earns zero group credit.
   */
  groupKey: string | null;
  /** The (past) acceptance instant — the evidence's age, for the publication delay. */
  acceptedAtMs: number;
}

export interface PlanArrivalAggregationResult {
  objects: MapObject[];
  /** Per-zone suppression reason (privacy gate), for honest reporting. */
  refusals: Record<string, string>;
  published: number;
  withheld: number;
}

/**
 * Fold accepted-plan arrivals into per-zone predicted-presence objects,
 * publishing a zone ONLY when its cohort clears the privacy gate.
 *
 * This is the one place a single traveller's future position could leak, so it
 * never does: an arrival enters a zone accumulator, its actor id enters a Set
 * for counting and never leaves it, and a zone is emitted only when
 * `evaluatePrivacy` says the cohort is large and diverse enough. The delay
 * clause is satisfied by the PAST acceptance time, not the future arrival time —
 * the prediction is "based on plans accepted ≥ delay ago, N groups are due
 * here", which is an aggregate about recorded intent, not a live tracker.
 */
export function aggregatePlanArrivals(
  arrivals: readonly PlanArrival[],
  target: TemporalTarget,
  nowMs: number,
  threshold: PrivacyThreshold = PRIVACY_THRESHOLD_V1,
): PlanArrivalAggregationResult {
  const result: PlanArrivalAggregationResult = { objects: [], refusals: {}, published: 0, withheld: 0 };
  if (target.mode !== "forecast") return result;
  if (!Array.isArray(arrivals) || arrivals.length === 0) return result;

  interface ZoneAcc {
    centroid: { lat: number; lng: number };
    actors: Set<string>;
    /** group key → distinct actors in that group. */
    groups: Map<string, Set<string>>;
    /** actors that carry ANY group, for the maxGroupShare denominator. */
    groupedActors: Set<string>;
    earliestAccepted: number;
  }
  const byZone = new Map<string, ZoneAcc>();

  for (const a of arrivals) {
    if (!a || typeof a.zoneId !== "string" || a.zoneId === "" || !a.actorId) continue;
    let z = byZone.get(a.zoneId);
    if (!z) {
      z = {
        centroid: a.zoneCentroid,
        actors: new Set(),
        groups: new Map(),
        groupedActors: new Set(),
        earliestAccepted: a.acceptedAtMs,
      };
      byZone.set(a.zoneId, z);
    }
    z.actors.add(a.actorId);
    if (Number.isFinite(a.acceptedAtMs)) z.earliestAccepted = Math.min(z.earliestAccepted, a.acceptedAtMs);
    if (a.groupKey) {
      let g = z.groups.get(a.groupKey);
      if (!g) { g = new Set(); z.groups.set(a.groupKey, g); }
      g.add(a.actorId);
      z.groupedActors.add(a.actorId);
    }
  }

  const predictedFor = new Date(target.at).toISOString();
  // Deterministic zone order so pagination/tests are stable.
  for (const zoneId of [...byZone.keys()].sort()) {
    const z = byZone.get(zoneId)!;
    const distinctActors = z.actors.size;
    const distinctGroups = z.groups.size;
    // Union denominator: an actor in several parties cannot dilute the dominant
    // group's share (matches lib/intelProjectionAggregator / crowd flow).
    const largest = [...z.groups.values()].reduce((m, s) => Math.max(m, s.size), 0);
    const maxGroupShare = z.groupedActors.size > 0 ? largest / z.groupedActors.size : 1;

    const decision = evaluatePrivacy(
      {
        distinctActors,
        distinctGroups,
        maxGroupShare,
        observedAt: z.earliestAccepted,
        now: nowMs,
      },
      threshold,
    );
    if (!decision.publishable) {
      result.refusals[zoneId] = decision.reason ?? "suppressed";
      result.withheld += 1;
      continue;
    }

    result.objects.push({
      id: `prediction:zone:${zoneId}`,
      kind: "prediction",
      geometry: point(z.centroid.lat, z.centroid.lng),
      title: "Busier soon",
      subtitle: "Expected arrivals",
      confidence: "provisional", // single self-reported-intent family (§10 cap)
      // AGGREGATE ONLY — a predicted zone cohort is never a place or a person.
      privacyClass: "aggregate_only",
      count: distinctActors,
      renderingPriority: KIND_DEFAULT_PRIORITY.prediction,
      interaction: { actions: ["view"], opensSheet: true },
      payload: { source: "accepted_plan", zoneId, predictedFor, cohort: distinctActors },
    });
    result.published += 1;
  }

  return result;
}

// ── Historical: read, never reconstruct (Yesterday / Last Friday) ─────────────

/**
 * The subset of an `intel_state_snapshot_versions` row this module reads, plus
 * the place geometry the route joins in. Field names mirror the columns
 * (migration 2273) so a rename shows up here as a type error.
 */
export interface SnapshotVersionRow {
  subject_id: string;
  claim_type: string;
  value: unknown;
  confidence_band: string | null;
  privacy_eligible: boolean;
  observed_at: string;
  expires_at: string;
}

/** A place's geometry, keyed by id — resolved by the route from `places`. */
export interface HistoricalPlaceGeometry {
  lat: number;
  lng: number;
  name?: string | null;
}

const CONFIDENCE_BAND_SET: ReadonlySet<string> = new Set<ConfidenceState>([
  "unverified",
  "provisional",
  "likely_current",
  "live",
  "strong",
]);

/**
 * Reconstruct §7's Activity/Trend axes for a historical snapshot from its stored
 * claim value, reusing the SAME mappers the live projection uses (so the map
 * says the same word for the same value at every offset). The snapshot version
 * row is shaped into the minimal `LiveClaimLike` those mappers read; the fields
 * they ignore are filled from the row rather than faked.
 */
function historicalAxes(row: SnapshotVersionRow): { activity?: ActivityLevel; trend?: TrendState } {
  const band: ConfidenceState =
    row.confidence_band && CONFIDENCE_BAND_SET.has(row.confidence_band)
      ? (row.confidence_band as ConfidenceState)
      : "provisional";
  const claimLike: LiveClaimLike = {
    id: `${row.subject_id}:${row.claim_type}`,
    claimType: row.claim_type,
    value: row.value,
    confidence: null,
    band,
    sourceCountBucket: null,
    // A reconstructed past state is exactly a historical_pattern — the mappers
    // ignore this field, but naming it honestly keeps the shape truthful.
    sourceClass: "historical_pattern",
    observedAt: row.observed_at,
    validUntil: row.expires_at,
    state: "historical",
  };
  return { activity: crowdValueToActivity(claimLike), trend: crowdValueToTrend(claimLike) };
}

export interface HistoryProjectionResult {
  objects: MapObject[];
  /**
   * FALSE means there is no recorded history for this viewport/instant yet —
   * the append-only versions table is empty (its projection scheduler has never
   * run) or nothing covers the target. The route surfaces this so the client
   * shows an honest "no history yet" state rather than an empty map that reads
   * as "nothing was happening".
   */
  available: boolean;
  /** How many version rows covered the target instant before the place join. */
  covering: number;
}

/**
 * Project the state that was LIVE at the target instant from recorded snapshot
 * versions. NOTHING is reconstructed from live data — a row is used only if its
 * own [observed_at, expires_at] validity window covers the target, it was
 * privacy-eligible when recorded, and its subject place still has geometry. When
 * several versions of one (subject, claim_type) cover the instant, the one whose
 * `observed_at` is closest to the target wins (the freshest view as of then).
 *
 * Historical objects are OBSERVED (never `kind: 'prediction'`) and carry
 * `freshness: 'historical'`, so the client can never mistake a past view for a
 * live one (§37: "Do not let stale claims remain visually live").
 */
export function projectHistory(
  rows: readonly SnapshotVersionRow[] | null | undefined,
  placesById: ReadonlyMap<string, HistoricalPlaceGeometry>,
  target: TemporalTarget,
): HistoryProjectionResult {
  if (rows === null || rows === undefined) {
    // A READ FAILURE is not an empty history: the route passes null here only
    // when it could not read, and the caller must not claim "no history".
    return { objects: [], available: false, covering: 0 };
  }
  if (target.mode !== "historical") return { objects: [], available: true, covering: 0 };

  // Keep, per (subject, claim_type), the covering version closest to the target.
  const best = new Map<string, { row: SnapshotVersionRow; dist: number }>();
  let covering = 0;
  for (const row of rows) {
    if (!row || row.privacy_eligible !== true) continue;
    const obs = toMs(row.observed_at);
    const exp = toMs(row.expires_at);
    if (obs === null || exp === null) continue;
    if (!(obs <= target.at && target.at <= exp)) continue;
    covering += 1;
    const key = `${row.subject_id}:${row.claim_type}`;
    const dist = Math.abs(obs - target.at);
    const prev = best.get(key);
    if (!prev || dist < prev.dist) best.set(key, { row, dist });
  }

  const objects: MapObject[] = [];
  // One object per subject place, merging its claim types' axes.
  const bySubject = new Map<
    string,
    { band: ConfidenceState; activity?: ActivityLevel; trend?: TrendState; observedAt: string; expiresAt: string }
  >();
  for (const { row } of best.values()) {
    const geom = placesById.get(row.subject_id);
    if (!geom) continue;
    const axes = historicalAxes(row);
    const band: ConfidenceState =
      row.confidence_band && CONFIDENCE_BAND_SET.has(row.confidence_band)
        ? (row.confidence_band as ConfidenceState)
        : "provisional";
    const cur = bySubject.get(row.subject_id);
    if (!cur) {
      bySubject.set(row.subject_id, {
        band,
        activity: axes.activity,
        trend: axes.trend,
        observedAt: row.observed_at,
        expiresAt: row.expires_at,
      });
    } else {
      cur.activity = cur.activity ?? axes.activity;
      cur.trend = cur.trend ?? axes.trend;
    }
  }

  for (const [subjectId, sState] of bySubject) {
    const geom = placesById.get(subjectId)!;
    objects.push({
      id: `history:${subjectId}`,
      kind: "place",
      geometry: point(geom.lat, geom.lng),
      title: geom.name ?? "Place",
      observedAt: sState.observedAt,
      expiresAt: sState.expiresAt,
      // The one label a historical view must wear — never live (§37).
      freshness: "historical",
      confidence: sState.band,
      activity: sState.activity,
      trend: sState.trend,
      privacyClass: "place_level",
      renderingPriority: KIND_DEFAULT_PRIORITY.place,
      interaction: { actions: ["view"], opensSheet: true },
      payload: { source: "history", subjectId },
    });
  }

  return { objects, available: true, covering };
}

// ── shared: the whole forecast side, folded ───────────────────────────────────

/**
 * Combine the three forecast sources. Kept here (not in the route) so the
 * merge is unit-testable without a database; the route supplies the already-read
 * rows and the resolved plan arrivals.
 */
export interface ForecastInputs {
  events: readonly any[];
  itineraryStops: readonly any[];
  planArrivals: readonly PlanArrival[];
}

export interface ForecastProjectionResult {
  objects: MapObject[];
  plan: PlanArrivalAggregationResult;
  events: number;
  itinerary: number;
}

export function projectForecast(
  inputs: ForecastInputs,
  target: TemporalTarget,
  nowMs: number,
  threshold: PrivacyThreshold = PRIVACY_THRESHOLD_V1,
): ForecastProjectionResult {
  const objects: MapObject[] = [];
  let events = 0;
  let itinerary = 0;
  for (const ev of inputs.events ?? []) {
    const o = projectEventForecast(ev, target);
    if (o) { objects.push(o); events += 1; }
  }
  for (const stop of inputs.itineraryStops ?? []) {
    const o = projectItineraryStopForecast(stop, target);
    if (o) { objects.push(o); itinerary += 1; }
  }
  const plan = aggregatePlanArrivals(inputs.planArrivals ?? [], target, nowMs, threshold);
  objects.push(...plan.objects);
  return { objects, plan, events, itinerary };
}
