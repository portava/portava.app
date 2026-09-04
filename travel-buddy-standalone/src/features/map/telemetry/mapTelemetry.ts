/**
 * mapTelemetry — the Portava Map product-telemetry emitter (Map spec §35).
 *
 * WHAT THIS IS
 * ============
 * The single, typed, privacy-scrubbed entry point for the sixteen events §35
 * names. Nothing on the map surface should call `fetch` for analytics directly;
 * everything goes through `emitMapEvent`.
 *
 * WHY IT EXISTS IN THIS SHAPE
 * ===========================
 * §35's closing line is the requirement that shapes the whole module:
 *
 *     "Evaluate whether map interaction produces successful real-world
 *      outcomes, not only screen engagement."
 *
 * A screen-engagement funnel needs no correlation. An OUTCOME funnel does: to
 * answer "did the Compass pick the user accepted actually get them there, and
 * did they contribute once they arrived?" a single decision must be traceable
 * across four separate events fired minutes apart from four different
 * components. So two ids are threaded through the whole event set:
 *
 *   • `mapSessionId` — minted at `map_opened`, carried on EVERY later event.
 *     Answers "what happened in this visit to the map".
 *   • `decisionId`   — minted at `compass_requested`, carried through
 *     `compass_option_selected`, `alternative_requested`,
 *     `recommendation_accepted|declined`, `route_started`, `trip_stop_added`
 *     and `contribution_submitted`. Answers "what did THIS recommendation
 *     cause in the real world".
 *
 * The full loop §38 describes is therefore queryable end to end:
 *
 *     compass_requested → compass_option_selected → recommendation_accepted
 *       → route_started → (arrival) → contribution_submitted
 *
 * all joined on one `decisionId`. A `recommendation_declined` or an
 * `alternative_requested` on the same id is the negative arm of the same
 * experiment.
 *
 * PRIVACY IS THE POINT OF THIS MODULE
 * ===================================
 * Map telemetry is the single most dangerous analytics surface in the product,
 * because every event is about a place a real person physically was or is
 * going. Spec §23/§24 govern what may leave the device:
 *
 *   • NEVER a raw coordinate, and never a `MapObject.geometry`. Location is
 *     reported only as a coarse cell — geohash precision 5, roughly
 *     4.9 km × 4.9 km (see TELEMETRY_CELL_PRECISION). That is deliberately far
 *     coarser than the ~1 km floor: an analytics cell only ever needs to answer
 *     "which part of which city", and a tighter cell around a residence or a
 *     clinic re-creates exactly the disclosure §24 exists to prevent.
 *   • NEVER a contributor id, a crew member's id, or any other user's
 *     identifier. The authenticated viewer is stamped SERVER-side from the
 *     bearer token (the pattern mediaAnalyticsBatch.ts already uses), so the
 *     client never needs to send an actor id at all.
 *   • What IS reported about an object is its `kind`, its `privacyClass`, its
 *     `confidence` and `freshness` — the four axes §7/§18/§23 already treat as
 *     publishable — plus opaque server-minted refs.
 *
 * `scrubPayload()` enforces all of that as a pure function, and `emitMapEvent`
 * is the only path into the queue, so an event cannot reach the transport
 * without having been scrubbed. As a last line of defence an event that still
 * contains a disallowed key AFTER scrubbing is dropped rather than sent, and
 * the drop is counted and reported.
 *
 * TRANSPORT
 * =========
 * This file is pure logic — no React, no `fetch`, no Supabase import — so it is
 * testable under `node --test` and cannot drag a native module into a unit
 * test. The network lives behind a pluggable transport; wire the real one once
 * at app start with `createFetchTelemetryTransport({ ... })`, which produces
 * exactly the batched fire-and-forget POST the app already uses for
 * `POST /api/media/analytics/batch` (see hooks/useMediaAnalytics.ts) and
 * `POST /api/compass/analytics` (services/compass.ts).
 *
 * Until a transport is configured, events stay QUEUED (bounded) rather than
 * being discarded, so telemetry fired during app boot is not lost.
 */

import type { MapMode } from '../vocabulary.ts';
import type { MapContributionKind } from '../truth/liveTruth.ts';
import {
  centroidOf,
  type ConfidenceState,
  type FreshnessState,
  type MapGeometry,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';

// ── Coarse location: geohash cells, never points ──────────────────────────────

/**
 * Geohash precision used for every location in every telemetry payload.
 *
 * Precision 5 ≈ 4.9 km × 4.9 km at the equator (worst case ±2.4 km). Precision
 * 6 is 1.2 km × 0.61 km — its SHORT axis is already under the ~1 km floor, so 5
 * is the tightest standard geohash length that satisfies the constraint on both
 * axes. Analytics questions at map scale ("which district", "which night-life
 * cluster") are answerable at this precision; "which building" is not, and that
 * is the intent.
 */
export const TELEMETRY_CELL_PRECISION = 5;

/** Nominal cell size at TELEMETRY_CELL_PRECISION, for docs and payload self-description. */
export const TELEMETRY_CELL_APPROX_KM = 4.9;

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/**
 * Standard geohash encoder (pure; no dependencies).
 *
 * Returns null for non-finite or out-of-range input rather than encoding
 * garbage — a bad coordinate must not silently become a plausible-looking cell.
 */
export function geohashEncode(
  lat: number,
  lng: number,
  precision: number = TELEMETRY_CELL_PRECISION,
): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const len = Math.max(1, Math.min(12, Math.floor(precision)));

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let hash = '';
  let bit = 0;
  let idx = 0;
  let even = true; // longitude first

  while (hash.length < len) {
    if (even) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        idx = idx * 2 + 1;
        lngMin = mid;
      } else {
        idx *= 2;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        idx = idx * 2 + 1;
        latMin = mid;
      } else {
        idx *= 2;
        latMax = mid;
      }
    }
    even = !even;
    bit += 1;
    if (bit === 5) {
      hash += GEOHASH_BASE32[idx];
      bit = 0;
      idx = 0;
    }
  }
  return hash;
}

/** The only location shape any telemetry payload may carry. */
export interface CoarseCell {
  /** Geohash at TELEMETRY_CELL_PRECISION, or null when location is withheld. */
  cell: string | null;
  cellPrecision: number;
  cellApproxKm: number;
}

function coarseCell(lat: number, lng: number): CoarseCell {
  return {
    cell: geohashEncode(lat, lng, TELEMETRY_CELL_PRECISION),
    cellPrecision: TELEMETRY_CELL_PRECISION,
    cellApproxKm: TELEMETRY_CELL_APPROX_KM,
  };
}

/** A withheld location — the shape is kept so downstream schemas stay uniform. */
export const CELL_WITHHELD: CoarseCell = {
  cell: null,
  cellPrecision: TELEMETRY_CELL_PRECISION,
  cellApproxKm: TELEMETRY_CELL_APPROX_KM,
};

/**
 * Coarsen a raw coordinate to the telemetry cell. This is the ONLY sanctioned
 * way a call site turns a camera centre or a user position into a payload
 * field — pass the returned `cell` string, never the numbers.
 */
export function cellFor(lat: number, lng: number): string | null {
  return geohashEncode(lat, lng, TELEMETRY_CELL_PRECISION);
}

/** Coarsen any MapGeometry to its cell. The geometry itself never leaves. */
export function cellForGeometry(geometry: MapGeometry | null | undefined): CoarseCell {
  if (!geometry) return CELL_WITHHELD;
  const c = centroidOf(geometry);
  if (!c) return CELL_WITHHELD;
  return coarseCell(c.lat, c.lng);
}

// ── The scrubbed object reference ─────────────────────────────────────────────

/**
 * Kinds whose `id` IS a person. Spec §23: the map may not become a people
 * tracker, and telemetry least of all — for these the object id and the cell
 * are both withheld. What survives is that a crew object was interacted with.
 */
export const IDENTITY_BEARING_KINDS: readonly MapObjectKind[] = ['crew_member'];

/**
 * Everything telemetry is allowed to say about a map object.
 *
 * Note what is absent: geometry, title, subtitle, payload, contributor. Title
 * is withheld on purpose — a place name is a precise location by another route,
 * and the server can resolve `objectId` when a name is genuinely needed for an
 * internal report.
 */
export interface MapObjectRef {
  /** Opaque object id — omitted entirely for identity-bearing kinds. */
  objectId?: string;
  kind: MapObjectKind;
  privacyClass: PrivacyClass;
  confidence?: ConfidenceState;
  freshness?: FreshnessState;
  /** Coarse cell, or a withheld cell for identity-bearing / invisible objects. */
  cell: string | null;
  cellPrecision: number;
  /** True when the id/cell were deliberately withheld rather than unavailable. */
  withheld?: true;
  /** Aggregation fan-in, when the projection collapsed several objects. */
  aggregated?: number;
}

/**
 * Build the ONLY representation of a MapObject that may appear in telemetry.
 *
 * Callers pass the real object; this is where it stops being one.
 */
export function describeMapObject(obj: MapObject): MapObjectRef {
  const identityBearing = IDENTITY_BEARING_KINDS.includes(obj.kind);
  // privacyClass 'none' means "not visible to this viewer" — if such an object
  // ever reaches a call site, report the interaction but not the location.
  const withhold = identityBearing || obj.privacyClass === 'none';
  const cell = withhold ? CELL_WITHHELD : cellForGeometry(obj.geometry);

  const ref: MapObjectRef = {
    kind: obj.kind,
    privacyClass: obj.privacyClass,
    cell: cell.cell,
    cellPrecision: cell.cellPrecision,
  };
  if (!identityBearing && typeof obj.id === 'string' && obj.id !== '') ref.objectId = obj.id;
  if (obj.confidence) ref.confidence = obj.confidence;
  if (obj.freshness) ref.freshness = obj.freshness;
  if (withhold) ref.withheld = true;
  if (typeof obj.count === 'number' && obj.count > 1) ref.aggregated = obj.count;
  return ref;
}

// ── Buckets — counts and distances are banded, never raw ──────────────────────

export type CountBucket = '0' | '1' | '2-4' | '5-9' | '10-24' | '25-99' | '100+';

/** Raw group sizes are re-identifying in small cohorts; bands are not. */
export function countBucket(n: number | null | undefined): CountBucket {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0';
  if (n === 1) return '1';
  if (n < 5) return '2-4';
  if (n < 10) return '5-9';
  if (n < 25) return '10-24';
  if (n < 100) return '25-99';
  return '100+';
}

export type DistanceBucket = '<0.5km' | '0.5-1km' | '1-3km' | '3-10km' | '10-50km' | '50km+' | 'unknown';

export function distanceBucket(km: number | null | undefined): DistanceBucket {
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return 'unknown';
  if (km < 0.5) return '<0.5km';
  if (km < 1) return '0.5-1km';
  if (km < 3) return '1-3km';
  if (km < 10) return '3-10km';
  if (km < 50) return '10-50km';
  return '50km+';
}

export type DurationBucket = '<1m' | '1-5m' | '5-15m' | '15-60m' | '1-4h' | '4h+' | 'unknown';

export function durationBucketMs(ms: number | null | undefined): DurationBucket {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'unknown';
  const m = ms / 60_000;
  if (m < 1) return '<1m';
  if (m < 5) return '1-5m';
  if (m < 15) return '5-15m';
  if (m < 60) return '15-60m';
  if (m < 240) return '1-4h';
  return '4h+';
}

// ── The sixteen §35 events, with per-event payloads ───────────────────────────

export type MapSessionId = string;
export type DecisionId = string;

export type MapEntryPoint =
  | 'tab'
  | 'deeplink'
  | 'trip'
  | 'compass'
  | 'notification'
  | 'search'
  | 'place'
  | 'unknown';

// The §30 modes, from features/map/vocabulary.ts. Declared there rather than
// here so telemetry reports the SAME mode value the state machine is actually
// in — a private enum would have silently recorded a mode the map never had.
export type { MapMode };

export type PlaceOpenSource =
  | 'marker'
  | 'preview_card'
  | 'cluster'
  | 'search_result'
  | 'compass_pick'
  | 'trip_list'
  | 'long_press'
  | 'deeplink';

export type TravelMode = 'walk' | 'transit' | 'drive' | 'ride_hail' | 'cycle' | 'unknown';

/**
 * The §22 contribution set, taken from features/map/truth/liveTruth.ts rather
 * than restated. That module owns the capture vocabulary and quotes §22
 * verbatim; a private list here drifted from it immediately (it had
 * 'still_open'/'closed'/'photo' where §22 says entry/access, closure and
 * photo/video), which would have made the telemetry unjoinable to the
 * observations it is supposed to measure.
 */
export type ContributionKind = MapContributionKind;

export type DeclineReason =
  | 'not_interested'
  | 'too_far'
  | 'wrong_vibe'
  | 'already_been'
  | 'too_busy'
  | 'too_expensive'
  | 'closed'
  | 'unspecified';

/** Fields shared by every payload that participates in a Compass decision. */
interface DecisionScoped {
  /**
   * The recommendation this event is an outcome of. Auto-filled from the active
   * decision when omitted, so an outcome fired from a different component still
   * attributes to the recommendation that caused it.
   */
  decisionId?: DecisionId;
}

export interface MapOpenedPayload {
  entry: MapEntryPoint;
  mode: MapMode;
  /** Coarse cell of the initial camera centre. Never the camera coordinate. */
  viewportCell?: string | null;
  zoom?: number;
  hasTripContext: boolean;
  hasCrewContext: boolean;
  offline?: boolean;
  /** Whether the shell rendered from cache before live intelligence arrived (§33). */
  servedFromCache?: boolean;
}

export interface ZoneSelectedPayload {
  ref: MapObjectRef;
  /** How the zone was reached. */
  source: 'marker' | 'cluster' | 'long_press' | 'legend' | 'compass_pick';
  /** Whether the zone was rendered as a forecast rather than an observation (§37). */
  forecast?: boolean;
}

export interface PlaceOpenedPayload {
  ref: MapObjectRef;
  source: PlaceOpenSource;
  /** Rank within the list/cluster it was opened from, when there was one. */
  rank?: number;
  saved?: boolean;
}

export interface LiveStateViewedPayload {
  ref: MapObjectRef;
  /** The §7 axes as displayed — the four things the sheet actually claimed. */
  activity?: string;
  trend?: string;
  /** Sheet detent the live state was read at, for "did they actually see it". */
  detent?: 'peek' | 'half' | 'full';
  /** How long the live state was on screen, banded. */
  dwell?: DurationBucket;
}

export interface WhyShownOpenedPayload {
  ref: MapObjectRef;
  /** How many provenance lines the §9 panel showed. */
  lineCount: number;
  /** Opaque server-minted claim-snapshot refs. Never contributor ids. */
  provenanceRefs?: string[];
}

export interface CompassRequestedPayload extends DecisionScoped {
  /** Where the ask came from. */
  trigger: 'action_rail' | 'long_press' | 'empty_state' | 'place_sheet' | 'zone_sheet' | 'auto';
  /** Coarse cell the question was asked about. */
  contextCell?: string | null;
  /** Free-form intent slug (e.g. 'food_now', 'nightlife'), never free text. */
  intent?: string;
  mode: MapMode;
}

export interface CompassOptionSelectedPayload extends DecisionScoped {
  ref: MapObjectRef;
  /** Position of the chosen option and how many were offered. */
  optionIndex: number;
  optionCount: number;
  /** Banded distance from the user to the chosen option. */
  distance?: DistanceBucket;
}

export interface RouteStartedPayload extends DecisionScoped {
  ref: MapObjectRef;
  travelMode: TravelMode;
  distance: DistanceBucket;
  /** Estimated time to arrival, banded. */
  eta?: DurationBucket;
  /** True when routing was handed to an external app rather than in-app. */
  external?: boolean;
}

export interface TripStopAddedPayload extends DecisionScoped {
  ref: MapObjectRef;
  /** Day index within the trip (0-based), not a date. */
  dayIndex?: number;
  /** Where in the day's order it landed. */
  slotIndex?: number;
  source: 'action_rail' | 'long_press' | 'place_sheet' | 'compass_pick' | 'optimize_today';
}

export interface PlanJoinedPayload extends DecisionScoped {
  ref: MapObjectRef;
  planKind: 'meetup' | 'event' | 'trip' | 'shared_moment';
  participants: CountBucket;
  /** Whether the joiner was invited or found the plan on the map. */
  discovery: 'invited' | 'map' | 'compass' | 'link';
}

export interface MeetHereCreatedPayload extends DecisionScoped {
  ref: MapObjectRef;
  audience: 'crew' | 'friends' | 'group' | 'buddy';
  invitees: CountBucket;
  /** Privacy rung the meeting point's geometry was published at (§23). */
  sharedAs: PrivacyClass;
  /** How long the meeting point stays live, banded. */
  ttl?: DurationBucket;
}

/**
 * A Meet Here the policy refused. Deliberately NOT decision-scoped: a refusal
 * is a property of the subject and the rule, not of a Compass decision, and
 * attaching a decisionId would let a refusal count as an outcome of a
 * recommendation it had nothing to do with.
 */
export interface MeetHereRefusedPayload {
  /** The subject that could not anchor a meeting. Already coarsened. */
  ref: MapObjectRef;
  /** Which rule fired. Mirrors meetHereModel's MeetRefusalReason. */
  reason: 'aggregate_subject' | 'no_geometry' | 'not_visible';
  /** Where the user asked from, so rail and long-press can be told apart. */
  surface: 'action_rail' | 'long_press' | 'place_sheet';
}

export interface CrewLocateStartedPayload {
  crewSize: CountBucket;
  /** Rung requested — §23 requires this be temporary and group-scoped. */
  requestedPrecision: PrivacyClass;
  /** Requested duration of the temporary share, banded. */
  ttl: DurationBucket;
  source: 'trip_map' | 'action_rail' | 'crew_sheet' | 'safety';
}

export interface ContributionSubmittedPayload extends DecisionScoped {
  ref: MapObjectRef;
  contributionKind: ContributionKind;
  /** What put the prompt on screen — the §22 one-tap arrival prompt or a manual tap. */
  prompt: 'arrival' | 'manual' | 'sheet' | 'notification' | 'geofence';
  /** Time between route_started and this contribution, banded. Closes the §38 loop. */
  sinceRouteStart?: DurationBucket;
  /** Whether the user had actually been routed there in this session. */
  followedRoute?: boolean;
}

export interface AlternativeRequestedPayload extends DecisionScoped {
  /** The option being rejected, when there was a specific one. */
  ref?: MapObjectRef;
  reason: DeclineReason;
  /** Which round of alternatives this is (1 = first "show me something else"). */
  round: number;
}

export interface RecommendationAcceptedPayload extends DecisionScoped {
  ref: MapObjectRef;
  /** The action that constituted acceptance. */
  via: 'route' | 'trip_stop' | 'meet_here' | 'save' | 'plan_join' | 'open';
  optionIndex?: number;
  optionCount?: number;
}

export interface RecommendationDeclinedPayload extends DecisionScoped {
  ref?: MapObjectRef;
  reason: DeclineReason;
  /** Explicit dismissal vs. simply never acting on it before the sheet closed. */
  explicit: boolean;
  optionCount?: number;
}

/**
 * The §35 event catalogue. `MapEventName` is derived from this map, so adding an
 * event without a payload type — or emitting a payload that does not match its
 * event — is a compile error.
 */
export interface MapEventPayloads {
  map_opened: MapOpenedPayload;
  zone_selected: ZoneSelectedPayload;
  place_opened: PlaceOpenedPayload;
  live_state_viewed: LiveStateViewedPayload;
  why_shown_opened: WhyShownOpenedPayload;
  compass_requested: CompassRequestedPayload;
  compass_option_selected: CompassOptionSelectedPayload;
  route_started: RouteStartedPayload;
  trip_stop_added: TripStopAddedPayload;
  plan_joined: PlanJoinedPayload;
  meet_here_created: MeetHereCreatedPayload;
  crew_locate_started: CrewLocateStartedPayload;
  contribution_submitted: ContributionSubmittedPayload;
  alternative_requested: AlternativeRequestedPayload;
  recommendation_accepted: RecommendationAcceptedPayload;
  recommendation_declined: RecommendationDeclinedPayload;
  meet_here_refused: MeetHereRefusedPayload;
}

export type MapEventName = keyof MapEventPayloads;

/** Runtime mirror of the union, for validation and for the server's allow-list. */
export const MAP_EVENT_NAMES = [
  'map_opened',
  'zone_selected',
  'place_opened',
  'live_state_viewed',
  'why_shown_opened',
  'compass_requested',
  'compass_option_selected',
  'route_started',
  'trip_stop_added',
  'plan_joined',
  'meet_here_created',
  'crew_locate_started',
  'contribution_submitted',
  'alternative_requested',
  'recommendation_accepted',
  'recommendation_declined',
  // ── Beyond §35's sixteen, deliberately ──────────────────────────────────
  // §35 names sixteen events, all of which describe something the user DID.
  // None describes something the product REFUSED to do. Without this, a Meet
  // Here that policy blocked is indistinguishable from a Meet Here the user
  // never tried — the funnel simply shows a gap, and a §23 refusal rule that
  // fires constantly looks identical to a feature nobody uses.
  //
  // It carries a reason, never a subject's precise geometry: the point is to
  // measure the RULE, not the place it fired on.
  'meet_here_refused',
] as const;

/** Events that may carry a decisionId — the outcome arm of a Compass decision. */
const DECISION_SCOPED_EVENTS: ReadonlySet<string> = new Set([
  'compass_requested',
  'compass_option_selected',
  'route_started',
  'trip_stop_added',
  'plan_joined',
  'meet_here_created',
  'contribution_submitted',
  'alternative_requested',
  'recommendation_accepted',
  'recommendation_declined',
]);

// ── The scrubber ──────────────────────────────────────────────────────────────

/**
 * Keys that may never appear in a telemetry payload at any depth.
 *
 * Deliberately matched as case-insensitive SUBSTRINGS, not exact names: a
 * denylist that only catches `lat` misses `latDeg`, `startLat`, `pickup_lat`.
 * The cost is that an innocent key containing one of these fragments is also
 * stripped — which is why no payload type above uses one. When in doubt the
 * scrubber removes; losing an analytics field is recoverable, leaking a
 * coordinate is not.
 */
const DISALLOWED_LOCATION_KEY_RE =
  /(lat|lng|lon|coord|geometry|geohash|bbox|viewport_bounds|altitude|accuracy|heading|bearing|street|postcode|postal|zipcode|address)/i;

/**
 * Identifiers belonging to a person. The authenticated viewer is stamped
 * server-side from the bearer token, so the client never sends an actor id.
 */
const DISALLOWED_IDENTITY_KEY_RE =
  /(user_?id|userids|contributor|author|owner|profile_?id|member_?id|creator|host_?id|invitee_?id|actor|account_?id|handle|e_?mail|phone|avatar|display_?name|full_?name|username|device_?id|push_?token|ip_?addr|session_?token)/i;

/** True when a key must be removed from a payload wherever it appears. */
export function isDisallowedKey(key: string): boolean {
  return DISALLOWED_LOCATION_KEY_RE.test(key) || DISALLOWED_IDENTITY_KEY_RE.test(key);
}

/** Structural caps — a runaway payload is a denial-of-service on the ingest. */
const MAX_DEPTH = 6;
const MAX_ARRAY_LENGTH = 50;
const MAX_STRING_LENGTH = 200;
const MAX_KEYS = 60;

const GEOMETRY_TYPES = new Set(['Point', 'Polygon', 'LineString', 'MultiPolygon', 'MultiLineString']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function looksLikeGeometry(v: Record<string, unknown>): boolean {
  return typeof v['type'] === 'string' && GEOMETRY_TYPES.has(v['type']) && Array.isArray(v['coordinates']);
}

/** First finite number found in an arbitrarily nested coordinate array. */
function firstPosition(coords: unknown): [number, number] | null {
  if (!Array.isArray(coords)) return null;
  if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
    return [coords[0], coords[1]];
  }
  for (const item of coords) {
    const found = firstPosition(item);
    if (found) return found;
  }
  return null;
}

function numberAt(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function scrubValue(value: unknown, depth: number): unknown {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return s.length > MAX_STRING_LENGTH ? s.slice(0, MAX_STRING_LENGTH) : s;
  }
  if (t === 'number') return Number.isFinite(value as number) ? value : null;
  if (t === 'boolean') return value;
  // Functions, symbols, bigints and undefined never travel.
  if (t !== 'object') return undefined;

  if (value instanceof Date) return value.toISOString();

  if (depth >= MAX_DEPTH) return undefined;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value.slice(0, MAX_ARRAY_LENGTH)) {
      const scrubbed = scrubValue(item, depth + 1);
      if (scrubbed !== undefined) out.push(scrubbed);
    }
    return out;
  }

  if (!isPlainObject(value)) return undefined;

  // A geometry is replaced wholesale by its coarse cell — there is nothing else
  // in a geometry worth keeping, and keeping any of it would keep the point.
  if (looksLikeGeometry(value)) {
    // Prefer the same centroid the renderer anchors on, so a stray geometry
    // scrubbed here lands in the same cell describeMapObject would have used.
    const centre = centroidOf(value as unknown as MapGeometry);
    if (centre) return coarseCell(centre.lat, centre.lng);
    const pos = firstPosition(value['coordinates']);
    if (!pos) return { ...CELL_WITHHELD };
    // Geometry positions are [lng, lat] per RFC 7946.
    return coarseCell(pos[1], pos[0]);
  }

  // A loose { lat, lng } pair anywhere is coarsened in place: the raw numbers
  // are dropped and a cell is attached alongside the object's other fields.
  const lat = numberAt(value, ['lat', 'latitude', 'Lat', 'Latitude']);
  const lng = numberAt(value, ['lng', 'lon', 'long', 'longitude', 'Lng', 'Longitude']);

  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const key of Object.keys(value)) {
    if (kept >= MAX_KEYS) break;
    if (isDisallowedKey(key)) continue;
    const scrubbed = scrubValue(value[key], depth + 1);
    if (scrubbed === undefined) continue;
    out[key] = scrubbed;
    kept += 1;
  }

  if (lat !== null && lng !== null) {
    const cell = coarseCell(lat, lng);
    out['cell'] = cell.cell;
    out['cellPrecision'] = cell.cellPrecision;
  }

  return out;
}

/**
 * The privacy gate. Pure, total, and the only way a payload reaches the queue.
 *
 * Guarantees on the returned object:
 *   • no key matching `isDisallowedKey` at any depth;
 *   • no `MapGeometry` — every one is replaced by a coarse cell;
 *   • no loose lat/lng pair — coarsened to a cell alongside its siblings;
 *   • bounded depth, array length, string length and key count;
 *   • JSON-safe values only.
 */
export function scrubPayload(payload: unknown): Record<string, unknown> {
  const scrubbed = scrubValue(payload, 0);
  return isPlainObject(scrubbed) ? scrubbed : {};
}

/** Post-condition check used as a last line of defence before enqueueing. */
export function containsDisallowedKey(value: unknown, depth = 0): boolean {
  if (depth >= MAX_DEPTH + 2 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsDisallowedKey(v, depth + 1));
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (isDisallowedKey(key)) return true;
    if (containsDisallowedKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

// ── Envelope and batch ────────────────────────────────────────────────────────

export const MAP_TELEMETRY_SCHEMA_VERSION = '1.0';

export interface MapTelemetryEvent {
  name: MapEventName;
  /** Correlation id minted at map_opened; present on every event. */
  mapSessionId: MapSessionId;
  /** Monotonic per-session sequence — lets the server order a late batch. */
  seq: number;
  /** Client epoch ms. */
  ts: number;
  payload: Record<string, unknown>;
  /**
   * Set when the event fired before any `map_opened` and the session id had to
   * be synthesised. Analysis should exclude these from session funnels rather
   * than silently treating them as a real map visit.
   */
  synthesizedSession?: true;
}

export type DropReason = 'queue_overflow' | 'delivery_failed' | 'scrub_violation' | 'unknown_event';

export interface MapTelemetryBatch {
  events: MapTelemetryEvent[];
  meta: {
    schemaVersion: string;
    mapSessionId: MapSessionId | null;
    /** Events dropped since the last batch that reported drops. NEVER silent. */
    dropped: number;
    /** Lifetime drop count for this app run. */
    droppedTotal: number;
    /** Drops broken down by cause, since the last reporting batch. */
    droppedByReason: Partial<Record<DropReason, number>>;
    /** Queue depth at the moment this batch was cut. */
    queueDepth: number;
  };
}

export type MapTelemetryTransport = (batch: MapTelemetryBatch) => Promise<void>;

// ── Emitter configuration ─────────────────────────────────────────────────────

export interface TelemetryScheduler {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface MapTelemetryConfig {
  transport: MapTelemetryTransport | null;
  /** Flush as soon as the queue reaches this many events. */
  batchSize: number;
  /** Flush this long after the first event of an idle queue. */
  flushIntervalMs: number;
  /** Hard cap; beyond it the OLDEST event is dropped and counted. */
  maxQueueSize: number;
  /** Consecutive failed deliveries of the same batch before it is dropped. */
  maxDeliveryAttempts: number;
  scheduler: TelemetryScheduler;
  now: () => number;
  /** Id factory — injected in tests for deterministic ids. */
  newId: (prefix: string) => string;
}

const defaultScheduler: TelemetryScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let idCounter = 0;
function defaultNewId(prefix: string): string {
  idCounter += 1;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

function defaultConfig(): MapTelemetryConfig {
  return {
    transport: null,
    batchSize: 20,
    flushIntervalMs: 15_000,
    maxQueueSize: 200,
    maxDeliveryAttempts: 3,
    scheduler: defaultScheduler,
    now: () => Date.now(),
    newId: defaultNewId,
  };
}

// ── Emitter state (module-private on purpose) ─────────────────────────────────

let config: MapTelemetryConfig = defaultConfig();

/**
 * The queue is module-private and there is no exported way to push onto it
 * other than `emitMapEvent`, which always scrubs. That is what makes "you
 * cannot emit an unscrubbed event" a structural property rather than a
 * convention.
 */
let queue: MapTelemetryEvent[] = [];
let timerHandle: unknown = null;
let flushing = false;
let flushAgain = false;

let sessionId: MapSessionId | null = null;
let sessionSynthetic = false;
let seq = 0;
let activeDecisionId: DecisionId | null = null;

let droppedPending = 0;
let droppedTotal = 0;
let droppedByReason: Partial<Record<DropReason, number>> = {};

function recordDrop(reason: DropReason, n = 1): void {
  droppedPending += n;
  droppedTotal += n;
  droppedByReason[reason] = (droppedByReason[reason] ?? 0) + n;
}

/** Apply overrides. Anything omitted keeps its current value. */
export function configureMapTelemetry(overrides: Partial<MapTelemetryConfig>): void {
  config = { ...config, ...overrides };
}

/** Install (or remove) the network transport. */
export function setMapTelemetryTransport(transport: MapTelemetryTransport | null): void {
  config = { ...config, transport };
}

// ── Correlation ids ───────────────────────────────────────────────────────────

/** The current map session id, or null before the first `map_opened`. */
export function currentMapSessionId(): MapSessionId | null {
  return sessionSynthetic ? null : sessionId;
}

/** The decision outcomes are currently being attributed to, if any. */
export function currentDecisionId(): DecisionId | null {
  return activeDecisionId;
}

/**
 * Mint a decision id without emitting. Rarely needed — `compass_requested`
 * mints one automatically when the payload omits it — but exported so a caller
 * that must know the id before emitting (e.g. to stash it on a card) can.
 */
export function newDecisionId(): DecisionId {
  return config.newId('dec');
}

/**
 * Close the active decision so later, unrelated outcomes are not mis-attributed
 * to it. Call when the Compass sheet is dismissed without a resolution.
 */
export function clearActiveDecision(): void {
  activeDecisionId = null;
}

/**
 * End the map session: flush what is queued and forget the correlation ids.
 * Call from the map screen's unmount.
 */
export function endMapSession(): Promise<void> {
  const p = flushMapTelemetry();
  sessionId = null;
  sessionSynthetic = false;
  activeDecisionId = null;
  seq = 0;
  return p;
}

function ensureSession(name: MapEventName): void {
  if (name === 'map_opened') {
    sessionId = config.newId('mse');
    sessionSynthetic = false;
    seq = 0;
    activeDecisionId = null;
    return;
  }
  if (sessionId === null) {
    // Never drop an event for want of a session — synthesise one and MARK it,
    // so the analysis can tell a real map visit from a stray early event.
    sessionId = config.newId('mse');
    sessionSynthetic = true;
    seq = 0;
  }
}

// ── Emit ──────────────────────────────────────────────────────────────────────

/**
 * The single entry point for §35 telemetry.
 *
 * Typed so that `emitMapEvent('route_started', { … })` accepts only a
 * RouteStartedPayload: a wrong payload for a given name does not compile.
 *
 * Never throws. Telemetry must not be able to break the map.
 */
export function emitMapEvent<N extends MapEventName>(name: N, payload: MapEventPayloads[N]): void {
  try {
    if (!(MAP_EVENT_NAMES as readonly string[]).includes(name)) {
      recordDrop('unknown_event');
      return;
    }

    ensureSession(name);

    // ── decision threading ────────────────────────────────────────────────
    const raw: Record<string, unknown> = { ...(payload as unknown as Record<string, unknown>) };
    if (DECISION_SCOPED_EVENTS.has(name)) {
      const supplied = typeof raw['decisionId'] === 'string' ? (raw['decisionId'] as string) : null;
      if (name === 'compass_requested') {
        activeDecisionId = supplied ?? newDecisionId();
      } else if (supplied) {
        activeDecisionId = supplied;
      }
      const id = supplied ?? activeDecisionId;
      if (id) raw['decisionId'] = id;
      else delete raw['decisionId'];
    } else {
      // A non-decision event must not carry one, even if a caller passed it.
      delete raw['decisionId'];
    }

    const scrubbed = scrubPayload(raw);

    // Belt and braces: if anything disallowed survived, the event is DROPPED,
    // not sent — and the drop is counted so the loss is visible downstream.
    if (containsDisallowedKey(scrubbed)) {
      recordDrop('scrub_violation');
      return;
    }

    seq += 1;
    const event: MapTelemetryEvent = {
      name,
      mapSessionId: sessionId as MapSessionId,
      seq,
      ts: config.now(),
      payload: scrubbed,
    };
    if (sessionSynthetic) event.synthesizedSession = true;

    enqueue(event);
  } catch {
    // Telemetry is never allowed to surface an error to the user.
  }
}

function enqueue(event: MapTelemetryEvent): void {
  queue.push(event);
  if (queue.length > config.maxQueueSize) {
    const overflow = queue.length - config.maxQueueSize;
    queue.splice(0, overflow); // drop OLDEST
    recordDrop('queue_overflow', overflow);
  }
  if (queue.length >= config.batchSize) {
    void flushMapTelemetry();
    return;
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timerHandle !== null) return;
  if (queue.length === 0) return;
  timerHandle = config.scheduler.setTimeout(() => {
    timerHandle = null;
    void flushMapTelemetry();
  }, config.flushIntervalMs);
}

function cancelTimer(): void {
  if (timerHandle !== null) {
    config.scheduler.clearTimeout(timerHandle);
    timerHandle = null;
  }
}

let consecutiveFailures = 0;

/**
 * Send everything queued. Safe to call at any time; never throws.
 *
 * With no transport configured this is a no-op that LEAVES the queue intact,
 * so events fired during boot survive until the transport is installed.
 */
export function flushMapTelemetry(): Promise<void> {
  if (flushing) {
    flushAgain = true;
    return Promise.resolve();
  }
  cancelTimer();
  if (queue.length === 0) return Promise.resolve();

  const transport = config.transport;
  if (!transport) return Promise.resolve();

  const events = queue;
  queue = [];

  const batch: MapTelemetryBatch = {
    events,
    meta: {
      schemaVersion: MAP_TELEMETRY_SCHEMA_VERSION,
      mapSessionId: sessionId,
      dropped: droppedPending,
      droppedTotal,
      droppedByReason: { ...droppedByReason },
      queueDepth: events.length,
    },
  };
  const reportedDrops = droppedPending;
  const reportedByReason = { ...droppedByReason };

  flushing = true;
  return transport(batch)
    .then(() => {
      consecutiveFailures = 0;
      // Only clear the drop counters that this batch actually reported, so a
      // drop occurring during the in-flight request is not swallowed.
      droppedPending -= reportedDrops;
      for (const [reason, n] of Object.entries(reportedByReason)) {
        const key = reason as DropReason;
        const remaining = (droppedByReason[key] ?? 0) - (n ?? 0);
        if (remaining > 0) droppedByReason[key] = remaining;
        else delete droppedByReason[key];
      }
    })
    .catch(() => {
      consecutiveFailures += 1;
      if (consecutiveFailures >= config.maxDeliveryAttempts) {
        consecutiveFailures = 0;
        recordDrop('delivery_failed', events.length);
        return;
      }
      // Re-queue at the FRONT (they are the oldest), then re-apply the bound by
      // dropping the oldest — the same rule as any other overflow.
      queue = events.concat(queue);
      if (queue.length > config.maxQueueSize) {
        const overflow = queue.length - config.maxQueueSize;
        queue.splice(0, overflow);
        recordDrop('queue_overflow', overflow);
      }
    })
    .then(() => {
      flushing = false;
      if (flushAgain) {
        flushAgain = false;
        return flushMapTelemetry();
      }
      scheduleFlush();
      return undefined;
    });
}

/**
 * Wire this to React Native's AppState from the map screen:
 *
 *     AppState.addEventListener('change', notifyMapAppStateChange);
 *
 * Backgrounding is the last moment the queue is guaranteed to be alive, so it
 * flushes unconditionally.
 */
export function notifyMapAppStateChange(state: string): void {
  if (state === 'background' || state === 'inactive') {
    void flushMapTelemetry();
  }
}

export interface MapTelemetryDiagnostics {
  queueDepth: number;
  droppedPending: number;
  droppedTotal: number;
  droppedByReason: Partial<Record<DropReason, number>>;
  mapSessionId: MapSessionId | null;
  sessionSynthetic: boolean;
  decisionId: DecisionId | null;
  seq: number;
  hasTransport: boolean;
  timerScheduled: boolean;
}

/** Observability for tests and for a debug screen. Never used to inject events. */
export function mapTelemetryDiagnostics(): MapTelemetryDiagnostics {
  return {
    queueDepth: queue.length,
    droppedPending,
    droppedTotal,
    droppedByReason: { ...droppedByReason },
    mapSessionId: sessionId,
    sessionSynthetic,
    decisionId: activeDecisionId,
    seq,
    hasTransport: config.transport !== null,
    timerScheduled: timerHandle !== null,
  };
}

/** Full reset — test-only. */
export function _resetMapTelemetryForTests(): void {
  cancelTimer();
  config = defaultConfig();
  queue = [];
  timerHandle = null;
  flushing = false;
  flushAgain = false;
  sessionId = null;
  sessionSynthetic = false;
  seq = 0;
  activeDecisionId = null;
  droppedPending = 0;
  droppedTotal = 0;
  droppedByReason = {};
  consecutiveFailures = 0;
}

// ── The real transport (constructed by the app, injected here) ────────────────

export interface FetchTelemetryTransportOptions {
  /** e.g. process.env.EXPO_PUBLIC_API_BASE_URL */
  baseUrl: string;
  /** e.g. `freshToken` from services/apiToken.ts */
  getToken: () => Promise<string | null>;
  /** Injected so this module imports nothing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to '/api/map/telemetry'. */
  path?: string;
}

/**
 * Builds the batched, authenticated, fire-and-forget POST the rest of the app
 * already uses for analytics (see useMediaAnalytics.ts). The server stamps the
 * viewer id from the bearer token — the client never sends one.
 *
 * Rejects on a non-2xx so the emitter can re-queue and retry.
 */
export function createFetchTelemetryTransport(
  opts: FetchTelemetryTransportOptions,
): MapTelemetryTransport {
  const doFetch = opts.fetchImpl ?? ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
  const path = opts.path ?? '/api/map/telemetry';
  return async (batch: MapTelemetryBatch) => {
    if (!opts.baseUrl || typeof doFetch !== 'function') throw new Error('telemetry_transport_unavailable');
    const token = await opts.getToken();
    if (!token) throw new Error('telemetry_unauthenticated');
    const res = await doFetch(`${opts.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`telemetry_http_${res.status}`);
  };
}
