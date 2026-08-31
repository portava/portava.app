/**
 * mapObjects — server mirror of the Map Object contract (Map spec §18).
 *
 * The app declares the same contract at
 * travel-buddy-standalone/src/types/mapObjects.ts. They are two files because
 * the API server and the Expo app are separate packages with no shared build;
 * src/test/mapObjectsContract.test.ts reads BOTH and fails if the wire-visible
 * vocabularies drift apart.
 *
 * This side is the authority for the values that already exist elsewhere in the
 * server: `CONFIDENCE_STATES` is derived from intelContracts.CONFIDENCE_BANDS
 * rather than retyped, so a band added there can never silently fail to reach
 * the map. Freshness, privacy class and the priority ladder are declared here
 * because the map is the first surface that needs them.
 *
 * PURE. No I/O, no DB, no privacy decisions, no confidence computation.
 * Confidence is scored by lib/confidenceScore.ts and banded by
 * lib/intelContracts.ts; freshness TTLs come from lib/freshnessPolicy.ts;
 * each entity's own guard decides visibility. This module only shapes.
 */
import { CONFIDENCE_BANDS, type ConfidenceBand } from "./intelContracts.js";

// ── Geometry ───────────────────────────────────────────────────────────────────

/** GeoJSON position: [lng, lat] — longitude FIRST, per RFC 7946. */
export type Position = [number, number];

export interface PointGeometry { type: "Point"; coordinates: Position }
export interface PolygonGeometry { type: "Polygon"; coordinates: Position[][] }
export interface LineStringGeometry { type: "LineString"; coordinates: Position[] }

export type MapGeometry = PointGeometry | PolygonGeometry | LineStringGeometry;

export function point(lat: number, lng: number): PointGeometry {
  return { type: "Point", coordinates: [lng, lat] };
}

/** Axis-aligned rectangle as a closed Polygon ring (w,s,e,n). */
export function bboxPolygon(w: number, s: number, e: number, n: number): PolygonGeometry {
  return {
    type: "Polygon",
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

// ── Object kinds (spec §18) ────────────────────────────────────────────────────

export const MAP_OBJECT_KINDS = [
  "place",
  "event",
  "activity_zone",
  "crowd_flow",
  "social_zone",
  "hidden_gem",
  "trip_stop",
  "crew_member",
  "meeting_point",
  "buddy_zone",
  "safety_notice",
  "memory",
  "prediction",
] as const;

export type MapObjectKind = (typeof MAP_OBJECT_KINDS)[number];

/** Spec §37: "Do not make predictions look like observations." */
export const FORECAST_KINDS: readonly MapObjectKind[] = ["prediction"];

export function isForecastKind(kind: MapObjectKind): boolean {
  return FORECAST_KINDS.includes(kind);
}

// ── Freshness (spec §7) ────────────────────────────────────────────────────────

export const FRESHNESS_STATES = ["live", "recent", "aging", "stale", "historical", "unknown"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

export const LIVE_FRESHNESS_STATES: readonly FreshnessState[] = ["live", "recent"];

export function mayRenderAsLive(freshness: FreshnessState | null | undefined): boolean {
  return freshness != null && LIVE_FRESHNESS_STATES.includes(freshness);
}

/**
 * Freshness thresholds, in seconds since `observedAt`. These are DISPLAY
 * buckets for spec §7's freshness column, not a TTL: authoritative expiry is
 * `expiresAt`, which lib/freshnessPolicy.ts derives per claim_type. When an
 * object carries an expiry, expiry always wins over the bucket — a claim past
 * its policy TTL can never read as `live` just because it is only 3 minutes old
 * under a 1-minute policy.
 */
export const FRESHNESS_THRESHOLDS_SECONDS = {
  /** ≤ 5 min: "Live". */
  live: 300,
  /** ≤ 30 min: "12m ago". */
  recent: 1800,
  /** ≤ 3 h: "Recently". */
  aging: 10800,
  /** ≤ 24 h: "Last confirmed 6h ago". Beyond this, 'historical'. */
  stale: 86400,
} as const;

/**
 * Derive the display freshness for an observation. FAIL-CLOSED at every step:
 * a missing/unparseable `observedAt` is 'unknown'; a future timestamp is
 * 'unknown' (a clock we cannot trust must not buy a live label); an object
 * whose `expiresAt` has passed is 'historical' regardless of age.
 *
 * Pure — `now` is injected so this is testable without freezing time.
 */
export function deriveFreshness(
  observedAt: string | number | Date | null | undefined,
  expiresAt: string | number | Date | null | undefined,
  now: string | number | Date = Date.now(),
): FreshnessState {
  const t = toMs(observedAt);
  if (t === null) return "unknown";
  const nowMs = toMs(now);
  if (nowMs === null) return "unknown";

  // A clock skew that puts the observation in the future is not evidence of
  // freshness — refuse rather than award the strongest label.
  if (t > nowMs + 60_000) return "unknown";

  const exp = toMs(expiresAt);
  if (exp !== null && nowMs >= exp) return "historical";

  const ageSeconds = Math.max(0, (nowMs - t) / 1000);
  if (ageSeconds <= FRESHNESS_THRESHOLDS_SECONDS.live) return "live";
  if (ageSeconds <= FRESHNESS_THRESHOLDS_SECONDS.recent) return "recent";
  if (ageSeconds <= FRESHNESS_THRESHOLDS_SECONDS.aging) return "aging";
  if (ageSeconds <= FRESHNESS_THRESHOLDS_SECONDS.stale) return "stale";
  return "historical";
}

function toMs(t: string | number | Date | null | undefined): number | null {
  if (t == null) return null;
  if (t instanceof Date) return Number.isFinite(t.getTime()) ? t.getTime() : null;
  if (typeof t === "number") return Number.isFinite(t) ? t : null;
  const ms = new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ── Confidence (spec §7, §9) ───────────────────────────────────────────────────

/**
 * Derived from the server's own bands so the two can never diverge. A band
 * added to intelContracts automatically becomes a valid map confidence state.
 */
export const CONFIDENCE_STATES = CONFIDENCE_BANDS;
export type ConfidenceState = ConfidenceBand;

// ── Trend + activity (spec §7) ─────────────────────────────────────────────────

export const TREND_STATES = [
  "increasing_quickly",
  "getting_busier",
  "stable",
  "cooling",
  "getting_quieter",
  "rapidly_dispersing",
] as const;
export type TrendState = (typeof TREND_STATES)[number];

export const ACTIVITY_LEVELS = [
  "very_quiet",
  "quiet",
  "moderate",
  "busy",
  "very_busy",
  "peak",
] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

// ── Privacy class (spec §23) ───────────────────────────────────────────────────

export const PRIVACY_CLASSES = [
  "none",
  "aggregate_only",
  "approximate",
  "place_level",
  "precise_temporary",
] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

/** Higher = more precise. `none` (0) must never be serialized to a client. */
export function precisionRank(cls: PrivacyClass): number {
  return PRIVACY_CLASSES.indexOf(cls);
}

/** The MORE restrictive of two rungs — combining can only ever tighten. */
export function narrowestPrivacyClass(a: PrivacyClass, b: PrivacyClass): PrivacyClass {
  return precisionRank(a) <= precisionRank(b) ? a : b;
}

export function mayRenderIdentity(cls: PrivacyClass): boolean {
  return precisionRank(cls) >= precisionRank("approximate");
}

// ── Rendering priority (spec §31) ──────────────────────────────────────────────

export const RENDERING_PRIORITY = {
  safety: 120,
  user: 110,
  active_navigation: 100,
  trip_crew: 90,
  selected_destination: 80,
  compass_recommendation: 70,
  active_event: 60,
  high_confidence_live_zone: 50,
  relevant_place: 40,
  social_opportunity: 30,
  saved_place: 20,
  generic_poi: 10,
} as const;

export type RenderingPriorityTier = keyof typeof RENDERING_PRIORITY;

export const KIND_DEFAULT_PRIORITY: Record<MapObjectKind, number> = {
  safety_notice: RENDERING_PRIORITY.safety,
  crew_member: RENDERING_PRIORITY.trip_crew,
  meeting_point: RENDERING_PRIORITY.trip_crew,
  trip_stop: RENDERING_PRIORITY.selected_destination,
  event: RENDERING_PRIORITY.active_event,
  activity_zone: RENDERING_PRIORITY.high_confidence_live_zone,
  crowd_flow: RENDERING_PRIORITY.high_confidence_live_zone,
  prediction: RENDERING_PRIORITY.high_confidence_live_zone,
  hidden_gem: RENDERING_PRIORITY.relevant_place,
  place: RENDERING_PRIORITY.relevant_place,
  social_zone: RENDERING_PRIORITY.social_opportunity,
  buddy_zone: RENDERING_PRIORITY.social_opportunity,
  memory: RENDERING_PRIORITY.saved_place,
};

// ── Interaction (spec §18, §25) ────────────────────────────────────────────────

export const MAP_ACTIONS = [
  "ask_compass",
  "meet_here",
  "add_to_trip",
  "navigate",
  "save",
  "share",
  "report",
  "view",
  "join",
  "follow",
  "book",
  "message",
  "block",
  "create_checkpoint",
  "contribute",
] as const;
export type MapAction = (typeof MAP_ACTIONS)[number];

export interface MapInteractionConfig {
  actions: MapAction[];
  detailRoute?: string;
  opensSheet?: boolean;
  contributable?: boolean;
}

// ── Provenance (spec §9) ───────────────────────────────────────────────────────

export interface MapProvenanceLine {
  text: string;
  /** Opaque snapshot reference. NEVER a contributor id or coordinate. */
  ref?: string;
}

export interface MapProvenance {
  lines: MapProvenanceLine[];
  confidence: ConfidenceState;
  updatedAt?: string;
}

// ── The object (spec §18) ──────────────────────────────────────────────────────

export interface MapObject<T = unknown> {
  id: string;
  kind: MapObjectKind;
  geometry: MapGeometry;
  title: string;
  subtitle?: string;
  observedAt?: string;
  expiresAt?: string;
  freshness?: FreshnessState;
  confidence?: ConfidenceState;
  activity?: ActivityLevel;
  trend?: TrendState;
  sourceRefs?: string[];
  provenance?: MapProvenance;
  privacyClass: PrivacyClass;
  interaction?: MapInteractionConfig;
  renderingPriority: number;
  count?: number;
  distanceKm?: number | null;
  payload?: T;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

export function centroidOf(geometry: MapGeometry): { lat: number; lng: number } | null {
  if (!geometry) return null;
  if (geometry.type === "Point") {
    const [lng, lat] = geometry.coordinates ?? [];
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const ring = geometry.type === "Polygon" ? geometry.coordinates?.[0] : geometry.coordinates;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLat = 0, sumLng = 0, n = 0;
  for (const pos of ring) {
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const [lng, lat] = pos;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    sumLat += lat; sumLng += lng; n += 1;
  }
  return n === 0 ? null : { lat: sumLat / n, lng: sumLng / n };
}

export function compareByRenderingPriority(a: MapObject, b: MapObject): number {
  if (b.renderingPriority !== a.renderingPriority) return b.renderingPriority - a.renderingPriority;
  const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The last gate before serialization. Spec §39: an object that answers none of
 * the seven questions has no business on the map. Also the enforcement point
 * for `privacyClass: 'none'` — the "not visible to this viewer" rung must never
 * cross the wire, whatever produced it.
 */
export function isServable(obj: MapObject | null | undefined): boolean {
  if (!obj) return false;
  if (!obj.geometry || !centroidOf(obj.geometry)) return false;
  if (typeof obj.title !== "string" || obj.title.trim() === "") return false;
  if (obj.privacyClass === "none") return false;
  if (!MAP_OBJECT_KINDS.includes(obj.kind)) return false;
  return true;
}
