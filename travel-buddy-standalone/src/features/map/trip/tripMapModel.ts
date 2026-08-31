/**
 * tripMapModel — Trip Map Mode (Map spec §11).
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ==========================================
 * Spec §11 says it twice, in two different registers:
 *
 *     "Trip Map renders the current Trip geographically WITHOUT DUPLICATING OR
 *      REPLACING Trip ownership."
 *     "Proposed changes require user acceptance; the map should not silently
 *      rewrite the canonical Trip."
 *
 * So this module is a projection and a proposal generator, and nothing else.
 * It performs no writes, holds no state, and returns no value that a caller can
 * mistake for a persisted fact:
 *
 *  - `tripToMapObjects()` reads a Trip snapshot and returns `MapObject[]`. The
 *    Trip is still owned by the Trips system; these are pins, not rows.
 *  - `optimizeToday()` returns a `{ proposed, rationale, unchanged }` PROPOSAL.
 *    It never touches its input — the test suite asserts deep equality of the
 *    caller's array afterwards, which is what makes "does not silently rewrite"
 *    a property rather than a promise.
 *  - `acceptProposal()` / `dismissProposal()` return a `TripOrderingChange`
 *    whose `persisted` field is the literal `false`. Acceptance is a decision
 *    the user makes and the CALLER persists; the type says so, so a caller
 *    cannot read "accepted" as "saved".
 *
 * §11's optimizer factors are enumerated in the spec and mirrored exactly in
 * `OPTIMIZE_FACTORS`: "distance, reservation times, event schedules, live
 * conditions, closing times, crew position, saved ideas and weather".
 * `rationale` cites only the factors that ACTUALLY moved something — a
 * boilerplate list of all eight would be a worse explanation than none.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No network, no React, no storage, and no clock of
 * its own: `now` is always passed in, so behaviour at a reservation boundary is
 * testable rather than flaky. Live conditions are consumed exactly as supplied
 * by the projection and never derived here (spec §19).
 */

import {
  RENDERING_PRIORITY,
  mayRenderAsLive,
  narrowestPrivacyClass,
  point,
} from '../../../types/mapObjects.ts';
import type {
  ActivityLevel,
  ConfidenceState,
  FreshnessState,
  LineStringGeometry,
  MapAction,
  MapObject,
  MapObjectKind,
  MapProvenance,
  PrivacyClass,
  TrendState,
} from '../../../types/mapObjects.ts';
import { carryLiveState } from '../compass/compassMapModel.ts';
import type { LatLng } from '../pulse/pulseMapBridge.ts';

// ── Shared shapes ──────────────────────────────────────────────────────────────

/**
 * Live state attached to a trip object, exactly as the projection supplied it.
 * Never computed here — §19: the client does not reconstruct intelligence.
 */
export interface StopLiveState {
  activity?: ActivityLevel;
  trend?: TrendState;
  freshness?: FreshnessState;
  confidence?: ConfidenceState;
  observedAt?: string;
  expiresAt?: string;
}

export type TripStopStatus = 'pending' | 'arrived' | 'skipped' | 'cancelled';

/** One itinerary stop, as projected from the canonical Trip / Route Plan. */
export interface TripStop {
  id: string;
  title: string;
  subtitle?: string;
  lat: number;
  lng: number;
  /** Position in the CANONICAL ordering. This module never renumbers it. */
  orderIndex: number;
  status?: TripStopStatus;

  /** Hard anchor: a booking that cannot be moved. ISO 8601. */
  reservationAt?: string | null;
  /** Hard anchor: a scheduled event. ISO 8601. */
  eventStartsAt?: string | null;
  eventEndsAt?: string | null;
  /** Soft plan the optimizer is allowed to revise. ISO 8601. */
  plannedArrivalTime?: string | null;
  /** When the venue stops accepting arrivals. ISO 8601. */
  closesAt?: string | null;

  /** Whether the stop is exposed to weather (drives the §11 weather factor). */
  outdoor?: boolean;

  live?: StopLiveState;
  privacyClass?: PrivacyClass;
  detailRoute?: string;
  provenance?: MapProvenance;

  /** Set when the stop originated from a saved idea. */
  savedIdeaId?: string | null;
  /**
   * TRUE ONLY on stops this module proposed adding. Canonical stops never carry
   * it, so a caller can always tell a proposal apart from the Trip.
   */
  proposedInsertion?: boolean;
}

/** Lodging / home base. §11 lists it first. */
export interface TripLodging {
  id: string;
  title: string;
  lat: number;
  lng: number;
  subtitle?: string;
  privacyClass?: PrivacyClass;
}

/** A saved idea: a candidate the user kept but never scheduled. */
export interface TripSavedIdea {
  id: string;
  title: string;
  lat: number;
  lng: number;
  subtitle?: string;
  closesAt?: string | null;
  outdoor?: boolean;
  live?: StopLiveState;
  privacyClass?: PrivacyClass;
  detailRoute?: string;
}

/**
 * A crew member's permitted position.
 *
 * `privacyClass` defaults to `approximate` (§6: "Ring — approximate location";
 * §37: "do not create permanent exact-location sharing"). Nothing here sharpens
 * it, and `tripToMapObjects` narrows it further against any ceiling the caller
 * passes.
 */
export interface TripCrewMember {
  id: string;
  displayName: string;
  lat: number;
  lng: number;
  privacyClass?: PrivacyClass;
  freshness?: FreshnessState;
  observedAt?: string;
  /** e.g. "Nearby ~40-80m" or "Last seen 3m ago" (§12). */
  presenceLabel?: string;
}

/** An explicit meeting point (§6: "Checkpoint pin"). */
export interface TripMeetingPoint {
  id: string;
  title: string;
  lat: number;
  lng: number;
  subtitle?: string;
  startsAt?: string | null;
  /** Stop this meeting point belongs to, when it was created from one. */
  atStopId?: string | null;
}

/** A planned or active route line between stops. */
export interface TripRouteLine {
  id: string;
  title?: string;
  path: readonly LatLng[];
  /** Whether the user is currently navigating this route (§5 precedence). */
  active?: boolean;
  /** True when legs were straight-line estimated rather than routed. */
  isApproximated?: boolean;
  mode?: string;
}

/** Safe Return context (§11) — how the user gets back, and to what. */
export interface SafeReturnContext {
  id: string;
  title: string;
  lat: number;
  lng: number;
  subtitle?: string;
  /** What the anchor is: the stay, a checkpoint, or a transport node. */
  anchor?: 'lodging' | 'checkpoint' | 'transport';
  /** Last safe departure time, when the projection computed one. */
  lastDepartureAt?: string | null;
}

/** A Compass alternative offered against the trip (§11, §14). */
export interface TripCompassAlternative {
  id: string;
  title: string;
  lat: number;
  lng: number;
  subtitle?: string;
  /** The stop this is an alternative TO, when it replaces one. */
  forStopId?: string | null;
  live?: StopLiveState;
  privacyClass?: PrivacyClass;
  detailRoute?: string;
  provenance?: MapProvenance;
}

/** The full read-only Trip snapshot the map projects. */
export interface TripMapSource {
  tripId: string;
  lodging?: TripLodging | null;
  stops?: readonly TripStop[];
  /** Which stop is "next". When omitted, `nextStopOf` decides. */
  nextStopId?: string | null;
  savedIdeas?: readonly TripSavedIdea[];
  crew?: readonly TripCrewMember[];
  meetingPoints?: readonly TripMeetingPoint[];
  routes?: readonly TripRouteLine[];
  safeReturn?: SafeReturnContext | null;
  compassAlternatives?: readonly TripCompassAlternative[];
}

// ── Distance ───────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371.0088;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in km. Pure; returns Infinity for unusable input. */
export function haversineKm(a: LatLng | null, b: LatLng | null): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(b.lat) || !Number.isFinite(b.lng)) return Number.POSITIVE_INFINITY;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Total path length of a stop sequence, optionally from an origin. */
export function routeLengthKm(
  sequence: readonly { lat: number; lng: number }[],
  origin: LatLng | null = null,
): number {
  let total = 0;
  let prev: LatLng | null = origin;
  for (const s of sequence) {
    const here: LatLng = { lat: s.lat, lng: s.lng };
    if (prev) {
      const d = haversineKm(prev, here);
      if (Number.isFinite(d)) total += d;
    }
    prev = here;
  }
  return total;
}

// ── Time helpers ───────────────────────────────────────────────────────────────

function ms(iso: string | null | undefined): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * The stop's HARD time anchor, if it has one.
 * A reservation outranks an event start; a planned arrival is NOT an anchor —
 * it is exactly the thing Optimize Today is allowed to revise.
 */
export function anchorTimeOf(stop: TripStop): number | null {
  return ms(stop.reservationAt) ?? ms(stop.eventStartsAt);
}

/** Stops that still lie ahead. */
function isOpenStop(s: TripStop): boolean {
  return s.status !== 'skipped' && s.status !== 'cancelled';
}

/**
 * The trip's next stop: the earliest open, not-yet-arrived stop by hard anchor,
 * falling back to planned arrival, falling back to canonical order.
 * Returns null when nothing is left.
 */
export function nextStopOf(stops: readonly TripStop[], now: string): TripStop | null {
  const nowMs = ms(now) ?? 0;
  const open = (stops ?? []).filter((s) => isOpenStop(s) && s.status !== 'arrived');
  if (open.length === 0) return null;

  const timed = open
    .map((s) => ({ s, t: anchorTimeOf(s) ?? ms(s.plannedArrivalTime) }))
    .filter((r): r is { s: TripStop; t: number } => r.t != null && r.t >= nowMs)
    .sort((a, b) => a.t - b.t || a.s.orderIndex - b.s.orderIndex || (a.s.id < b.s.id ? -1 : 1));
  if (timed.length > 0) return timed[0].s;

  return [...open].sort(
    (a, b) => a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

// ── Optimize Today (§11) ───────────────────────────────────────────────────────

/** The eight factors §11 names, verbatim and in the spec's own order. */
export const OPTIMIZE_FACTORS = [
  'distance',
  'reservation_times',
  'event_schedules',
  'live_conditions',
  'closing_times',
  'crew_position',
  'saved_ideas',
  'weather',
] as const;
export type OptimizeFactor = (typeof OPTIMIZE_FACTORS)[number];

export interface TripWeather {
  /** How hostile the day is to being outdoors. */
  outdoorRisk: 'none' | 'moderate' | 'high';
  /** Short human line, e.g. "Heavy rain until 4pm". */
  summary?: string;
}

export interface OptimizeContext {
  /** ISO timestamp. Required — this module owns no clock. */
  now: string;
  /** Where the day starts. Falls back to the last arrived stop, then lodging. */
  origin?: LatLng | null;
  lodging?: TripLodging | null;
  crew?: readonly TripCrewMember[];
  savedIdeas?: readonly TripSavedIdea[];
  weather?: TripWeather | null;

  /** Max detour (km) that justifies slotting in a saved idea. Default 0.8. */
  savedIdeaDetourKm?: number;
  /** Max saved ideas a single proposal may add. Default 1. */
  maxSavedIdeaInsertions?: number;
  /** How close to the crew counts as "near the crew", km. Default 1.5. */
  crewNearKm?: number;
  /**
   * Price, in km, of moving a stop one slot against its bias. Larger values
   * make live conditions / crew / weather outweigh raw walking distance.
   * Default 0.35.
   */
  biasKmPerSlot?: number;
}

export interface OptimizeRationaleLine {
  factor: OptimizeFactor;
  text: string;
  /** Stops this line is about, so the sheet can highlight them. */
  stopIds: string[];
}

export interface OptimizeProposal {
  /**
   * The proposed ordering. A fresh array of fresh objects — mutating it cannot
   * reach the caller's stops. Canonical `orderIndex` values are preserved
   * as-is; the ORDER of the array is the proposal.
   */
  proposed: TripStop[];
  /** Why, citing only §11 factors that actually influenced the result. */
  rationale: OptimizeRationaleLine[];
  /** True when the proposal is identical to the current plan. */
  unchanged: boolean;
  /** The current ordering, for a side-by-side diff. */
  current: TripStop[];
  /** Stops excluded from the day (skipped / cancelled), untouched. */
  excluded: TripStop[];
  /** Saved ideas the proposal suggests ADDING. Subset of `proposed`. */
  insertions: TripStop[];
  /** Walking distance of the current vs proposed order, km. */
  distanceKm: { current: number; proposed: number };
}

function cloneStop(s: TripStop): TripStop {
  const out: TripStop = { ...s };
  if (s.live) out.live = { ...s.live };
  return out;
}

/**
 * Whether a stop's live state may influence the plan at all.
 *
 * §14/§37's "do not invent live conditions" has a quieter sibling here: do not
 * ACT on conditions that are not live. A trend observed an hour ago says
 * nothing about tonight, so an aging or stale observation gets zero weight
 * rather than a discounted one.
 */
function liveIsActionable(live: StopLiveState | undefined): boolean {
  if (!live) return false;
  if (!mayRenderAsLive(live.freshness)) return false;
  return live.confidence === 'likely_current' || live.confidence === 'live' || live.confidence === 'strong';
}

const BUSIER: readonly TrendState[] = ['increasing_quickly', 'getting_busier'];
const QUIETER: readonly TrendState[] = ['cooling', 'getting_quieter', 'rapidly_dispersing'];

/** Mean position of the crew, or null when no crew position is available. */
export function crewCentroid(crew: readonly TripCrewMember[] | undefined): LatLng | null {
  let lat = 0;
  let lng = 0;
  let n = 0;
  for (const c of crew ?? []) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    lat += c.lat;
    lng += c.lng;
    n += 1;
  }
  return n === 0 ? null : { lat: lat / n, lng: lng / n };
}

interface StopBias {
  /** Net positional bias. Positive pulls EARLIER, negative pushes LATER. */
  net: number;
  live: number;
  crew: number;
  weather: number;
}

function biasFor(stop: TripStop, ctx: OptimizeContext, crewAt: LatLng | null): StopBias {
  let live = 0;
  if (liveIsActionable(stop.live) && stop.live?.trend) {
    if (BUSIER.includes(stop.live.trend)) live = 1; // go before it fills up
    else if (QUIETER.includes(stop.live.trend)) live = -1; // it is emptying; later is calmer
  }

  let crew = 0;
  const nearKm = ctx.crewNearKm ?? 1.5;
  if (crewAt && haversineKm(crewAt, { lat: stop.lat, lng: stop.lng }) <= nearKm) crew = 1;

  let weather = 0;
  if (stop.outdoor && ctx.weather) {
    if (ctx.weather.outdoorRisk === 'high') weather = -2;
    else if (ctx.weather.outdoorRisk === 'moderate') weather = -1;
  }

  return { net: live + crew + weather, live, crew, weather };
}

/**
 * Optimize Today (§11).
 *
 * PROPOSES a re-ordering of the remaining day. Never mutates, never persists,
 * never returns anything the caller can mistake for the canonical Trip.
 *
 * How it works:
 *  1. Arrived stops are a frozen prefix — the past is not reorderable.
 *  2. Stops with a HARD anchor (reservation or event start) are laid out in
 *     time order and never moved relative to one another.
 *  3. Every other stop is placed by cheapest insertion (the detour it adds to
 *     the walking route), offset by a positional bias built from the live,
 *     crew and weather factors, and constrained by closing times.
 *  4. Saved ideas within `savedIdeaDetourKm` of the resulting path may be
 *     PROPOSED as additions, capped by `maxSavedIdeaInsertions`.
 *
 * Determinism: candidates are processed in a total order (closing time, then
 * canonical order, then id) and insertion ties break toward the earlier slot,
 * so the same input always yields the same proposal.
 */
export function optimizeToday(
  stops: readonly TripStop[],
  ctx: OptimizeContext,
): OptimizeProposal {
  const biasKm = ctx.biasKmPerSlot ?? 0.35;
  const all = (stops ?? []).filter((s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lng));

  const canonical = [...all].sort(
    (a, b) => a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const excluded = canonical.filter((s) => !isOpenStop(s)).map(cloneStop);
  const open = canonical.filter(isOpenStop);
  const done = open.filter((s) => s.status === 'arrived').map(cloneStop);
  const remaining = open.filter((s) => s.status !== 'arrived');

  const crewAt = crewCentroid(ctx.crew);
  const lastDone = done.length > 0 ? done[done.length - 1] : null;
  const origin: LatLng | null =
    ctx.origin ??
    (lastDone ? { lat: lastDone.lat, lng: lastDone.lng } : null) ??
    (ctx.lodging ? { lat: ctx.lodging.lat, lng: ctx.lodging.lng } : null);

  // 2. Anchored stops, in time order.
  const anchored = remaining
    .filter((s) => anchorTimeOf(s) != null)
    .sort(
      (a, b) =>
        (anchorTimeOf(a) as number) - (anchorTimeOf(b) as number) ||
        a.orderIndex - b.orderIndex ||
        (a.id < b.id ? -1 : 1),
    );
  const anchoredIds = new Set(anchored.map((s) => s.id));

  // 3. Flexible stops, in a total processing order.
  const flexible = remaining
    .filter((s) => !anchoredIds.has(s.id))
    .sort((a, b) => {
      const ca = ms(a.closesAt) ?? Number.POSITIVE_INFINITY;
      const cb = ms(b.closesAt) ?? Number.POSITIVE_INFINITY;
      if (ca !== cb) return ca - cb;
      return a.orderIndex - b.orderIndex || (a.id < b.id ? -1 : 1);
    });

  const seq: TripStop[] = anchored.map(cloneStop);

  const usedFactors = new Map<OptimizeFactor, Set<string>>();
  const noteFactor = (f: OptimizeFactor, id: string) => {
    const set = usedFactors.get(f) ?? new Set<string>();
    set.add(id);
    usedFactors.set(f, set);
  };

  for (const s of remaining) {
    if (s.reservationAt) noteFactor('reservation_times', s.id);
    if (s.eventStartsAt) noteFactor('event_schedules', s.id);
  }

  /**
   * Latest index a stop may occupy without landing after an anchor it would
   * already be closed for.
   */
  const maxIndexFor = (closesAtMs: number | null): number => {
    if (closesAtMs == null) return seq.length;
    for (let i = 0; i < seq.length; i += 1) {
      const t = anchorTimeOf(seq[i]);
      if (t != null && t >= closesAtMs) return i;
    }
    return seq.length;
  };

  const insertOne = (candidate: TripStop, bias: StopBias): number => {
    const closesAtMs = ms(candidate.closesAt);
    const limit = maxIndexFor(closesAtMs);
    const here: LatLng = { lat: candidate.lat, lng: candidate.lng };

    let bestIndex = 0;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= Math.min(limit, seq.length); i += 1) {
      const prev: LatLng | null =
        i === 0 ? origin : { lat: seq[i - 1].lat, lng: seq[i - 1].lng };
      const next: LatLng | null =
        i < seq.length ? { lat: seq[i].lat, lng: seq[i].lng } : null;

      const inLeg = prev ? haversineKm(prev, here) : 0;
      const outLeg = next ? haversineKm(here, next) : 0;
      const removed = prev && next ? haversineKm(prev, next) : 0;
      const detour = (Number.isFinite(inLeg) ? inLeg : 0) + (Number.isFinite(outLeg) ? outLeg : 0) - (Number.isFinite(removed) ? removed : 0);

      // Positive bias pulls earlier: later slots cost more.
      const cost = detour + biasKm * bias.net * i;
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestIndex = i;
      }
    }

    seq.splice(bestIndex, 0, candidate);
    if (closesAtMs != null && limit < seq.length) noteFactor('closing_times', candidate.id);
    if (bias.live !== 0) noteFactor('live_conditions', candidate.id);
    if (bias.crew !== 0) noteFactor('crew_position', candidate.id);
    if (bias.weather !== 0) noteFactor('weather', candidate.id);
    return bestIndex;
  };

  for (const s of flexible) {
    insertOne(cloneStop(s), biasFor(s, ctx, crewAt));
  }

  // 4. Saved ideas — proposed additions, bounded and only when they barely cost
  //    anything. The map may SUGGEST content; only the user may add it.
  const insertions: TripStop[] = [];
  const maxInsertions = ctx.maxSavedIdeaInsertions ?? 1;
  const detourBudget = ctx.savedIdeaDetourKm ?? 0.8;
  if (maxInsertions > 0 && (ctx.savedIdeas?.length ?? 0) > 0 && seq.length > 0) {
    const existingIds = new Set(seq.map((s) => s.id));
    const ideas = [...(ctx.savedIdeas ?? [])]
      .filter((i) => i && Number.isFinite(i.lat) && Number.isFinite(i.lng))
      .filter((i) => !existingIds.has(i.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const idea of ideas) {
      if (insertions.length >= maxInsertions) break;
      const asStop: TripStop = {
        id: idea.id,
        title: idea.title,
        lat: idea.lat,
        lng: idea.lng,
        orderIndex: Number.MAX_SAFE_INTEGER,
        status: 'pending',
        savedIdeaId: idea.id,
        proposedInsertion: true,
      };
      if (idea.subtitle != null) asStop.subtitle = idea.subtitle;
      if (idea.closesAt != null) asStop.closesAt = idea.closesAt;
      if (idea.outdoor != null) asStop.outdoor = idea.outdoor;
      if (idea.live) asStop.live = { ...idea.live };
      if (idea.privacyClass != null) asStop.privacyClass = idea.privacyClass;
      if (idea.detailRoute != null) asStop.detailRoute = idea.detailRoute;

      const before = routeLengthKm(seq, origin);
      const index = insertOne(asStop, biasFor(asStop, ctx, crewAt));
      const after = routeLengthKm(seq, origin);
      if (after - before > detourBudget) {
        seq.splice(index, 1); // too expensive — withdraw the suggestion
        continue;
      }
      insertions.push(asStop);
      noteFactor('saved_ideas', asStop.id);
    }
  }

  const proposedTail = seq;
  const proposed = [...done, ...proposedTail];
  const current = [...done, ...remaining.map(cloneStop)];

  const currentKm = routeLengthKm([...done, ...remaining], origin);
  const proposedKm = routeLengthKm(proposed, origin);
  if (proposedKm < currentKm - 1e-6) {
    for (const s of proposedTail) noteFactor('distance', s.id);
  }

  const sameOrder =
    current.length === proposed.length &&
    current.every((s, i) => s.id === proposed[i].id);
  const unchanged = sameOrder && insertions.length === 0;

  return {
    proposed,
    rationale: buildRationale(usedFactors, {
      currentKm,
      proposedKm,
      weather: ctx.weather ?? null,
      insertions,
      unchanged,
    }),
    unchanged,
    current,
    excluded,
    insertions,
    distanceKm: { current: currentKm, proposed: proposedKm },
  };
}

function buildRationale(
  used: Map<OptimizeFactor, Set<string>>,
  info: {
    currentKm: number;
    proposedKm: number;
    weather: TripWeather | null;
    insertions: TripStop[];
    unchanged: boolean;
  },
): OptimizeRationaleLine[] {
  if (info.unchanged) {
    return [
      {
        factor: 'distance',
        text: 'Today already reads as the best order — nothing to change.',
        stopIds: [],
      },
    ];
  }

  const lines: OptimizeRationaleLine[] = [];
  const ids = (f: OptimizeFactor) => [...(used.get(f) ?? [])].sort();

  for (const factor of OPTIMIZE_FACTORS) {
    const stopIds = ids(factor);
    if (stopIds.length === 0 && factor !== 'distance') continue;

    switch (factor) {
      case 'distance': {
        const saved = info.currentKm - info.proposedKm;
        if (saved <= 1e-6) break;
        lines.push({
          factor,
          text: `Saves about ${saved.toFixed(1)} km of moving around.`,
          stopIds,
        });
        break;
      }
      case 'reservation_times':
        lines.push({
          factor,
          text: `Keeps ${stopIds.length} booked time${stopIds.length === 1 ? '' : 's'} exactly where ${stopIds.length === 1 ? 'it is' : 'they are'}.`,
          stopIds,
        });
        break;
      case 'event_schedules':
        lines.push({
          factor,
          text: `Works around ${stopIds.length} scheduled event${stopIds.length === 1 ? '' : 's'}.`,
          stopIds,
        });
        break;
      case 'live_conditions':
        lines.push({
          factor,
          text: 'Moves around what is busy right now, based on current observations.',
          stopIds,
        });
        break;
      case 'closing_times':
        lines.push({
          factor,
          text: 'Puts places that close earlier before the ones that stay open.',
          stopIds,
        });
        break;
      case 'crew_position':
        lines.push({
          factor,
          text: 'Brings stops near your crew forward.',
          stopIds,
        });
        break;
      case 'saved_ideas':
        lines.push({
          factor,
          text: `Suggests adding ${info.insertions.length} saved idea${info.insertions.length === 1 ? '' : 's'} that is barely a detour.`,
          stopIds,
        });
        break;
      case 'weather':
        lines.push({
          factor,
          text: info.weather?.summary
            ? `Shifts outdoor stops later — ${info.weather.summary}.`
            : 'Shifts outdoor stops away from the worst of the weather.',
          stopIds,
        });
        break;
    }
  }

  if (lines.length === 0) {
    lines.push({
      factor: 'distance',
      text: 'Reorders the day without changing any fixed time.',
      stopIds: [],
    });
  }
  return lines;
}

// ── Acceptance (§11) ───────────────────────────────────────────────────────────

export type ProposalDecision =
  | { kind: 'accepted'; at: string }
  | { kind: 'dismissed'; at: string };

/**
 * The result of a user decision on a proposal.
 *
 * `persisted` is the LITERAL `false`. This module cannot write, and the type
 * refuses to let a caller read "the user accepted" as "the Trip changed".
 * Persisting `orderedStopIds` (and creating `insertions` as real trip items) is
 * the caller's job, against the canonical Trips API.
 */
export interface TripOrderingChange {
  decision: ProposalDecision;
  /** The ordering to persist. On dismissal, identical to the current order. */
  orderedStopIds: string[];
  /** Saved ideas the user accepted onto the trip. Empty on dismissal. */
  insertions: TripStop[];
  /** Always `false`. Nothing in this module writes. */
  persisted: false;
}

/**
 * The user accepted. Returns the new ordering for the caller to persist.
 * Note that this returns data, not an effect — calling it changes nothing.
 */
export function acceptProposal(proposal: OptimizeProposal, at: string): TripOrderingChange {
  return {
    decision: { kind: 'accepted', at },
    orderedStopIds: proposal.proposed.map((s) => s.id),
    insertions: proposal.insertions.map(cloneStop),
    persisted: false,
  };
}

/** The user dismissed. The canonical ordering stands, unchanged. */
export function dismissProposal(proposal: OptimizeProposal, at: string): TripOrderingChange {
  return {
    decision: { kind: 'dismissed', at },
    orderedStopIds: proposal.current.map((s) => s.id),
    insertions: [],
    persisted: false,
  };
}

/** Per-stop move summary, for rendering the proposal as a diff. */
export interface ProposalMove {
  stopId: string;
  title: string;
  from: number | null;
  to: number;
  delta: number | null;
  added: boolean;
}

export function proposalMoves(proposal: OptimizeProposal): ProposalMove[] {
  const fromIndex = new Map(proposal.current.map((s, i) => [s.id, i] as const));
  return proposal.proposed.map((s, to) => {
    const from = fromIndex.has(s.id) ? (fromIndex.get(s.id) as number) : null;
    return {
      stopId: s.id,
      title: s.title,
      from,
      to,
      delta: from == null ? null : to - from,
      added: from == null,
    };
  });
}

// ── Projection onto the map (§11) ──────────────────────────────────────────────

/**
 * The kind a route line is carried as.
 *
 * The §18 contract enumerates thirteen kinds and none of them is a route, so a
 * planned route rides as a `trip_stop` with LineString geometry — the renderer
 * keys the line style off `geometry.type`. This constant is the ONE line to
 * change if the contract later gains a dedicated route kind.
 */
export const TRIP_ROUTE_MAP_KIND: MapObjectKind = 'trip_stop';

const STOP_ACTIONS: MapAction[] = ['navigate', 'meet_here', 'save', 'share', 'ask_compass', 'view'];
const CREW_ACTIONS: MapAction[] = ['message', 'meet_here', 'view'];
const MEETING_ACTIONS: MapAction[] = ['navigate', 'share', 'create_checkpoint', 'view'];
const IDEA_ACTIONS: MapAction[] = ['add_to_trip', 'navigate', 'save', 'ask_compass', 'view'];
const ALT_ACTIONS: MapAction[] = ['add_to_trip', 'navigate', 'save', 'ask_compass', 'view'];

export interface TripMapPayload {
  tripId: string;
  /** Canonical entity id, so the §26 Pulse bridge can match subjects. */
  sourceId: string;
  role:
    | 'lodging'
    | 'stop'
    | 'next_stop'
    | 'saved_idea'
    | 'crew'
    | 'meeting_point'
    | 'route'
    | 'safe_return'
    | 'compass_alternative';
  /** Position in the itinerary, for stops. */
  orderIndex?: number;
  presenceLabel?: string;
  isApproximated?: boolean;
  /** Stop this alternative replaces, for compass_alternative. */
  forStopId?: string | null;
}

export interface TripProjectionOptions {
  /** ISO timestamp used only to decide the next stop when one is not given. */
  now?: string;
  /**
   * A privacy ceiling applied to EVERY object. Combined with
   * `narrowestPrivacyClass`, so it can only ever tighten precision.
   */
  privacyCeiling?: PrivacyClass;
}

function applyLive(obj: MapObject<TripMapPayload>, live: StopLiveState | undefined): void {
  if (!live) return;
  // Route through the Compass clamp so a trip object cannot present live state
  // that outruns what the projection supplied either (§14, §37).
  const state = carryLiveState(live);
  if (state.freshness != null) obj.freshness = state.freshness;
  if (state.confidence != null) obj.confidence = state.confidence;
  if (state.activity != null) obj.activity = state.activity;
  if (state.trend != null) obj.trend = state.trend;
  if (state.observedAt != null) obj.observedAt = state.observedAt;
  if (state.expiresAt != null) obj.expiresAt = state.expiresAt;
}

/**
 * Project a Trip snapshot onto the map (§11).
 *
 * Produces one `MapObject` per §11 element: lodging/home base, itinerary stops,
 * the next stop (promoted to `active_navigation`), saved ideas, crew, routes,
 * meeting points, Safe Return context and Compass alternatives.
 *
 * The Trip is NOT copied into these objects — each carries only its canonical
 * id in `payload.sourceId`, so every action re-reads and re-authorizes against
 * the Trips system. Nothing here writes, and nothing here sharpens geometry:
 * `privacyClass` is narrowed against the caller's ceiling and never widened.
 */
export function tripToMapObjects(
  source: TripMapSource,
  opts: TripProjectionOptions = {},
): MapObject<TripMapPayload>[] {
  const out: MapObject<TripMapPayload>[] = [];
  const ceiling = opts.privacyCeiling ?? 'precise_temporary';
  const narrow = (cls: PrivacyClass | undefined, fallback: PrivacyClass): PrivacyClass =>
    narrowestPrivacyClass(cls ?? fallback, ceiling);

  const stops = (source.stops ?? []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const nextId =
    source.nextStopId ?? (opts.now ? (nextStopOf(stops, opts.now)?.id ?? null) : null);

  // Lodging / home base.
  if (source.lodging && Number.isFinite(source.lodging.lat) && Number.isFinite(source.lodging.lng)) {
    const l = source.lodging;
    out.push({
      id: `trip_stop:${l.id}`,
      kind: 'trip_stop',
      geometry: point(l.lat, l.lng),
      title: l.title,
      subtitle: l.subtitle ?? 'Home base',
      privacyClass: narrow(l.privacyClass, 'place_level'),
      renderingPriority: RENDERING_PRIORITY.selected_destination,
      interaction: { actions: ['navigate', 'share', 'meet_here'], opensSheet: true },
      payload: { tripId: source.tripId, sourceId: l.id, role: 'lodging' },
    });
  }

  // Itinerary stops.
  for (const s of stops) {
    const isNext = s.id === nextId;
    const obj: MapObject<TripMapPayload> = {
      id: `trip_stop:${s.id}`,
      kind: 'trip_stop',
      geometry: point(s.lat, s.lng),
      title: s.title,
      privacyClass: narrow(s.privacyClass, 'place_level'),
      renderingPriority: isNext
        ? RENDERING_PRIORITY.active_navigation
        : RENDERING_PRIORITY.selected_destination,
      interaction: {
        actions: STOP_ACTIONS,
        detailRoute: s.detailRoute,
        opensSheet: true,
        contributable: true,
      },
      payload: {
        tripId: source.tripId,
        sourceId: s.id,
        role: isNext ? 'next_stop' : 'stop',
        orderIndex: s.orderIndex,
      },
    };
    if (s.subtitle != null) obj.subtitle = s.subtitle;
    if (s.provenance != null) obj.provenance = s.provenance;
    applyLive(obj, s.live);
    out.push(obj);
  }

  // Saved ideas — kept visibly below scheduled stops (§31 saved_place rung).
  for (const idea of source.savedIdeas ?? []) {
    if (!Number.isFinite(idea.lat) || !Number.isFinite(idea.lng)) continue;
    const obj: MapObject<TripMapPayload> = {
      id: `place:${idea.id}`,
      kind: 'place',
      geometry: point(idea.lat, idea.lng),
      title: idea.title,
      privacyClass: narrow(idea.privacyClass, 'place_level'),
      renderingPriority: RENDERING_PRIORITY.saved_place,
      interaction: {
        actions: IDEA_ACTIONS,
        detailRoute: idea.detailRoute,
        opensSheet: true,
        contributable: true,
      },
      payload: { tripId: source.tripId, sourceId: idea.id, role: 'saved_idea' },
    };
    if (idea.subtitle != null) obj.subtitle = idea.subtitle;
    applyLive(obj, idea.live);
    out.push(obj);
  }

  // Crew. Default privacy is `approximate` — a ring, never a precise pin.
  for (const c of source.crew ?? []) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lng)) continue;
    const obj: MapObject<TripMapPayload> = {
      id: `crew_member:${c.id}`,
      kind: 'crew_member',
      geometry: point(c.lat, c.lng),
      title: c.displayName,
      privacyClass: narrow(c.privacyClass, 'approximate'),
      renderingPriority: RENDERING_PRIORITY.trip_crew,
      interaction: { actions: CREW_ACTIONS },
      payload: {
        tripId: source.tripId,
        sourceId: c.id,
        role: 'crew',
        presenceLabel: c.presenceLabel,
      },
    };
    if (c.presenceLabel != null) obj.subtitle = c.presenceLabel;
    if (c.freshness != null) obj.freshness = c.freshness;
    if (c.observedAt != null) obj.observedAt = c.observedAt;
    out.push(obj);
  }

  // Meeting points.
  for (const m of source.meetingPoints ?? []) {
    if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
    const obj: MapObject<TripMapPayload> = {
      id: `meeting_point:${m.id}`,
      kind: 'meeting_point',
      geometry: point(m.lat, m.lng),
      title: m.title,
      privacyClass: narrow(undefined, 'place_level'),
      renderingPriority: RENDERING_PRIORITY.trip_crew,
      interaction: { actions: MEETING_ACTIONS, opensSheet: true },
      payload: {
        tripId: source.tripId,
        sourceId: m.id,
        role: 'meeting_point',
      },
    };
    if (m.subtitle != null) obj.subtitle = m.subtitle;
    out.push(obj);
  }

  // Routes.
  for (const r of source.routes ?? []) {
    const coords = (r.path ?? [])
      .filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))
      .map((p) => [p.lng, p.lat] as [number, number]);
    if (coords.length < 2) continue;
    const geometry: LineStringGeometry = { type: 'LineString', coordinates: coords };
    out.push({
      id: `route:${r.id}`,
      kind: TRIP_ROUTE_MAP_KIND,
      geometry,
      title: r.title ?? 'Route',
      subtitle: r.isApproximated ? 'Estimated route' : undefined,
      privacyClass: narrow(undefined, 'place_level'),
      renderingPriority: r.active
        ? RENDERING_PRIORITY.active_navigation
        : RENDERING_PRIORITY.relevant_place,
      interaction: { actions: ['navigate', 'share'] },
      payload: {
        tripId: source.tripId,
        sourceId: r.id,
        role: 'route',
        isApproximated: r.isApproximated,
      },
    });
  }

  // Safe Return — §5: safety always takes visual precedence.
  const sr = source.safeReturn;
  if (sr && Number.isFinite(sr.lat) && Number.isFinite(sr.lng)) {
    out.push({
      id: `safety_notice:${sr.id}`,
      kind: 'safety_notice',
      geometry: point(sr.lat, sr.lng),
      title: sr.title,
      subtitle: sr.subtitle,
      privacyClass: narrow(undefined, 'place_level'),
      renderingPriority: RENDERING_PRIORITY.safety,
      interaction: { actions: ['navigate', 'share', 'view'], opensSheet: true },
      payload: { tripId: source.tripId, sourceId: sr.id, role: 'safe_return' },
    });
  }

  // Compass alternatives — §14 star treatment sits with the Compass model; here
  // they only take the Compass rung of the §31 ladder.
  for (const a of source.compassAlternatives ?? []) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;
    const obj: MapObject<TripMapPayload> = {
      id: `place:${a.id}`,
      kind: 'place',
      geometry: point(a.lat, a.lng),
      title: a.title,
      privacyClass: narrow(a.privacyClass, 'place_level'),
      renderingPriority: RENDERING_PRIORITY.compass_recommendation,
      interaction: { actions: ALT_ACTIONS, detailRoute: a.detailRoute, opensSheet: true },
      payload: {
        tripId: source.tripId,
        sourceId: a.id,
        role: 'compass_alternative',
        forStopId: a.forStopId ?? null,
      },
    };
    if (a.subtitle != null) obj.subtitle = a.subtitle;
    if (a.provenance != null) obj.provenance = a.provenance;
    applyLive(obj, a.live);
    out.push(obj);
  }

  return out;
}
