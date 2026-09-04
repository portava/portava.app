/**
 * mapObjects — the canonical Map Object contract (Map spec §18).
 *
 * WHAT THIS IS
 * ============
 * One envelope for every object the map can render, produced by the Map
 * Intelligence Gateway (server: lib/mapProjection.ts, route
 * GET /api/map/projection) and consumed by the mobile renderer.
 *
 * Spec §19 is the rule this file exists to enforce:
 *
 *     "Never place raw database rows directly on the map. Use a dedicated
 *      projection layer."
 *
 * so `MapObject` carries the four things a raw row cannot: how FRESH the claim
 * is, how CONFIDENT the system is in it, what PRIVACY CLASS its geometry was
 * already reduced to, and where it sits in the RENDERING PRIORITY ladder.
 *
 * WHAT THIS IS NOT
 * ================
 * This module is pure types + pure helpers. It computes no confidence, decides
 * no privacy, and performs no I/O. Confidence is scored server-side by
 * lib/confidenceScore.ts and banded by lib/intelContracts.ts; freshness is
 * governed by lib/freshnessPolicy.ts; privacy is decided by each source's
 * existing privacy-complete guard. The client never re-derives any of them —
 * spec §19: "The mobile client should not independently reconstruct Portava
 * intelligence rules."
 *
 * COORDINATE CONTRACT
 * ===================
 * `geometry` is whatever precision the source already decided to expose
 * (coarsened traveler pins, gems per sensitivity, area-level friend rings).
 * Nothing downstream of the projection may ever SHARPEN it. `privacyClass`
 * records which rung of the §23 ladder that geometry sits on, so the renderer
 * can label approximation honestly instead of implying precision it wasn't given.
 *
 * The server mirrors this file at artifacts/api-server/src/lib/mapObjects.ts.
 * The two are kept in sync by a guard test on both sides; they are separate
 * files because the app and the API server are separate packages with no
 * shared build.
 */

// ── Geometry (spec §18) ────────────────────────────────────────────────────────

/** GeoJSON-style position: [lng, lat] — longitude FIRST, per RFC 7946. */
export type Position = [number, number];

export interface PointGeometry {
  type: 'Point';
  coordinates: Position;
}

export interface PolygonGeometry {
  type: 'Polygon';
  /** Linear rings; ring[0] is the exterior. First and last position must match. */
  coordinates: Position[][];
}

export interface LineStringGeometry {
  type: 'LineString';
  coordinates: Position[];
}

export type MapGeometry = PointGeometry | PolygonGeometry | LineStringGeometry;

// ── Object kinds (spec §18) ────────────────────────────────────────────────────

/**
 * The thirteen kinds the spec enumerates. This is deliberately WIDER than what
 * the projection emits today: `crowd_flow`, `prediction` and `buddy_zone` are
 * declared here so the renderer, the priority ladder and the aggregation layer
 * are written against the full contract from the start, rather than being
 * retrofitted when Phases 4-5 land.
 *
 * `saved_place` (fourteenth): §16's "Saved" layer, §31's "Saved Place" tier and
 * §6's gold marker all name a saved place; the thirteen spec kinds gave it none
 * (`memory` is the separately-toggled Memories layer, `place` the generic POI).
 * Mirrors the server contract; the drift test compares the two lists in order.
 * KEEP THIS ARRAY LITERAL COMMENT-FREE: the server's mirror test extracts it
 * textually, and a quoted word inside a comment reads as a kind.
 */
export const MAP_OBJECT_KINDS = [
  'place',
  'event',
  'activity_zone',
  'crowd_flow',
  'social_zone',
  'hidden_gem',
  'trip_stop',
  'crew_member',
  'meeting_point',
  'buddy_zone',
  'safety_notice',
  'memory',
  'prediction',
  'saved_place',
] as const;

export type MapObjectKind = (typeof MAP_OBJECT_KINDS)[number];

/**
 * Kinds that represent a FORECAST rather than an observation.
 * Spec §37 non-goal: "Do not make predictions look like observations." The
 * renderer must give these a visually distinct treatment (spec §6: dashed
 * boundary; §15: "unmistakably different visual treatment").
 */
export const FORECAST_KINDS: readonly MapObjectKind[] = ['prediction'];

export function isForecastKind(kind: MapObjectKind): boolean {
  return FORECAST_KINDS.includes(kind);
}

// ── Freshness (spec §7) ────────────────────────────────────────────────────────

/**
 * How current an observation is. Spec §7 requires the UI to distinguish
 * observation, confidence, trend and freshness rather than collapsing them
 * into one label, so freshness is its own axis with its own vocabulary.
 *
 * Ordered most- to least-current. `historical` means "observed, but in the
 * past and no longer presented as current"; `unknown` means the projection had
 * no observation timestamp at all and is the FAIL-CLOSED default — spec §37:
 * "Do not let stale claims remain visually live."
 */
export const FRESHNESS_STATES = ['live', 'recent', 'aging', 'stale', 'historical', 'unknown'] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** Only these two may be rendered with a live/pulsing treatment. */
export const LIVE_FRESHNESS_STATES: readonly FreshnessState[] = ['live', 'recent'];

/**
 * Age buckets for the §7 freshness column, in SECONDS.
 *
 * These mirror the server's `FRESHNESS_THRESHOLDS_SECONDS`
 * (api-server/src/lib/mapObjects.ts) and the contract drift test pins them
 * equal. They must agree, because the server stamps `freshness` on the wire
 * while the client recomputes it for cached objects — two different tables
 * would mean the SAME object at the SAME age reads "Live" from the network and
 * "aging" from the cache.
 *
 * They are display buckets, not a TTL: authoritative expiry is `expiresAt`,
 * which the server derives per claim_type from lib/freshnessPolicy. Expiry
 * always wins over the bucket.
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

/** The same buckets in milliseconds, for callers working in epoch ms. */
export const FRESHNESS_THRESHOLDS_MS: Readonly<Record<Exclude<FreshnessState, 'unknown'>, number>> = {
  live: FRESHNESS_THRESHOLDS_SECONDS.live * 1000,
  recent: FRESHNESS_THRESHOLDS_SECONDS.recent * 1000,
  aging: FRESHNESS_THRESHOLDS_SECONDS.aging * 1000,
  stale: FRESHNESS_THRESHOLDS_SECONDS.stale * 1000,
  historical: Number.POSITIVE_INFINITY,
};

export function mayRenderAsLive(freshness: FreshnessState | null | undefined): boolean {
  return freshness != null && LIVE_FRESHNESS_STATES.includes(freshness);
}

// ── Confidence (spec §7, §9) ───────────────────────────────────────────────────

/**
 * The certainty band. These are the EXACT bands the server already computes
 * (api-server lib/intelContracts.ts CONFIDENCE_BANDS) — mirrored, never
 * recomputed. Keeping the wire value identical to the server's band means the
 * client cannot drift into its own definition of "confirmed".
 */
export const CONFIDENCE_STATES = [
  'unverified',
  'provisional',
  'likely_current',
  'live',
  'strong',
] as const;
export type ConfidenceState = (typeof CONFIDENCE_STATES)[number];

/**
 * Spec §7's "Certainty" column, in the product's own words. The band is the
 * wire truth; this is only how it reads to a human.
 */
export const CONFIDENCE_LABELS: Record<ConfidenceState, string> = {
  strong: 'Confirmed',
  live: 'Strong signal',
  likely_current: 'Reports indicate',
  provisional: 'Limited data',
  unverified: 'Unconfirmed',
};

// ── Source class (spec §9, §37) ────────────────────────────────────────────────

/**
 * WHO IS SPEAKING. Mirrors api-server lib/intelContracts.ts SOURCE_CLASSES,
 * which lib/mapObjects.ts re-exports as the map's wire vocabulary.
 *
 * The §9 provenance panel already carries the attribution as PROSE
 * ("Sponsored · crowd.level"). This is the same fact as a value, so the §8
 * Live Place sheet can badge a paid claim by switching on a field instead of
 * regexing a sentence. Spec §37: "Do not let paid businesses buy factual
 * confidence" — a renderer that has to parse English to find out whether a
 * claim was paid for will eventually get it wrong in that direction.
 *
 * The server sets this ONLY from a live claim, and only to a value in this
 * list; an unrecognised class arrives as an absent field, never as a string
 * outside the vocabulary. So `SOURCE_CLASS_LABELS[obj.sourceClass]` is safe,
 * and an absent `sourceClass` means "no live claim, or no attributable one" —
 * it must never be defaulted to a traveler report.
 */
export const SOURCE_CLASSES = [
  'verified_firsthand',
  'firsthand_unverified',
  'official_signed',
  'sponsored',
  'imported_owned',
  'historical_pattern',
  'portava_prediction',
  'hearsay',
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

/**
 * The canonical user-facing label per class. These are the SERVER's strings
 * (intelContracts SOURCE_CLASS_LABELS), not new copy: the same claim has to
 * read the same way on the map, in Compass and on the place sheet, and
 * mapObjectsContract.test.ts fails if this table drifts from the server's.
 */
export const SOURCE_CLASS_LABELS: Record<SourceClass, string> = {
  verified_firsthand: 'Live from verified visitor',
  firsthand_unverified: 'Traveler report — unverified',
  official_signed: 'Official update',
  sponsored: 'Sponsored',
  imported_owned: 'Imported source',
  historical_pattern: 'Typical pattern',
  portava_prediction: 'Portava prediction',
  hearsay: 'Unverified tip',
};

/**
 * Classes that are one party talking about themselves. A claim in one of these
 * carries NO cohort bucket (the server withholds it) and must never be rendered
 * as independent community consensus — no "several travelers say", no crowd
 * icon, no confidence borrowed from a headcount that does not exist.
 */
export const NON_INDEPENDENT_SOURCE_CLASSES = [
  'official_signed',
  'sponsored',
  'imported_owned',
] as const;

/** Compile-time pin: every member above must be a declared source class. */
const _nonIndependentAreSourceClasses: readonly SourceClass[] = NON_INDEPENDENT_SOURCE_CLASSES;
void _nonIndependentAreSourceClasses;

/** True when this class may be counted toward independent community consensus. */
export function mayCountAsConsensus(cls: SourceClass): boolean {
  return !(NON_INDEPENDENT_SOURCE_CLASSES as readonly string[]).includes(cls);
}

// ── Trend (spec §7) ────────────────────────────────────────────────────────────

/** Spec §7's "Trend" column — the direction of change, separate from level. */
export const TREND_STATES = [
  'increasing_quickly',
  'getting_busier',
  'stable',
  'cooling',
  'getting_quieter',
  'rapidly_dispersing',
] as const;
export type TrendState = (typeof TREND_STATES)[number];

export const TREND_LABELS: Record<TrendState, string> = {
  increasing_quickly: 'Increasing quickly',
  getting_busier: 'Getting busier',
  stable: 'Stable',
  cooling: 'Cooling',
  getting_quieter: 'Getting quieter',
  rapidly_dispersing: 'Rapidly dispersing',
};

/** Spec §7's "Activity" column — the observed level, separate from trend. */
export const ACTIVITY_LEVELS = [
  'very_quiet',
  'quiet',
  'moderate',
  'busy',
  'very_busy',
  'peak',
] as const;
export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number];

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  very_quiet: 'Very Quiet',
  quiet: 'Quiet',
  moderate: 'Moderate',
  busy: 'Busy',
  very_busy: 'Very Busy',
  peak: 'Peak',
};

// ── Privacy class (spec §23) ───────────────────────────────────────────────────

/**
 * Which rung of spec §23's LocationVisibility ladder the geometry on this
 * object already sits on. This is a RECORD of a decision the source made, not
 * a decision this layer makes — and it is the reason nothing downstream may
 * sharpen `geometry`.
 *
 * Ordered widest-exposure last, so `precisionRank` can compare rungs.
 */
export const PRIVACY_CLASSES = [
  'none',
  'aggregate_only',
  'approximate',
  'place_level',
  'precise_temporary',
] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

/** Higher = more precise. `none` (0) must never be rendered at all. */
export function precisionRank(cls: PrivacyClass): number {
  return PRIVACY_CLASSES.indexOf(cls);
}

/**
 * The narrower (more private) of two classes. Used when an object inherits a
 * ceiling from its context — the result is always the MORE restrictive rung,
 * so combining can only ever tighten precision, never widen it.
 */
export function narrowestPrivacyClass(a: PrivacyClass, b: PrivacyClass): PrivacyClass {
  return precisionRank(a) <= precisionRank(b) ? a : b;
}

/**
 * Spec §23: "Default public rendering should aggregate social presence" — a
 * field of identifiable stranger avatars is a non-goal (§37: "Do not build a
 * public real-time people tracker"). An object at `aggregate_only` or below
 * must never render an identifiable avatar.
 */
export function mayRenderIdentity(cls: PrivacyClass): boolean {
  return precisionRank(cls) >= precisionRank('approximate');
}

// ── Rendering priority (spec §31) ──────────────────────────────────────────────

/**
 * The §31 collision ladder, highest first. When two objects collide in screen
 * space the lower-priority one is hidden — spec §5: "Safety and active
 * navigation always take visual precedence over popularity or activity."
 *
 * Numbers are spaced by 10 so a future tier can slot between two rungs without
 * renumbering everything that reads these constants.
 */
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

/**
 * The default priority tier for a kind, before any per-object promotion
 * (selection, Compass pick, active navigation) is applied.
 */
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
  saved_place: RENDERING_PRIORITY.saved_place,
};

// ── Interaction (spec §18, §25) ────────────────────────────────────────────────

/**
 * Spec §25's persistent action rail plus the long-press actions. These slugs
 * are CAPABILITY HINTS the card renders affordances from; every action
 * re-authorizes on the server when invoked. A client-only gate is not a gate.
 */
export const MAP_ACTIONS = [
  'ask_compass',
  'meet_here',
  'add_to_trip',
  'navigate',
  'save',
  'share',
  'report',
  'view',
  'join',
  'follow',
  'book',
  'message',
  'block',
  'create_checkpoint',
  'contribute',
] as const;
export type MapAction = (typeof MAP_ACTIONS)[number];

export interface MapInteractionConfig {
  /** Actions the preview card / long-press menu may offer. */
  actions: MapAction[];
  /** Expo Router href for the "View →" CTA, when the object has a detail screen. */
  detailRoute?: string;
  /** Whether tapping opens the Live Place sheet (§8) rather than only selecting. */
  opensSheet?: boolean;
  /** Whether the object supports the §22 one-tap contribution prompt. */
  contributable?: boolean;
}

// ── Provenance (spec §9) ───────────────────────────────────────────────────────

/**
 * One line of the "WHY PORTAVA SAYS THIS" panel (spec §9). Every meaningful
 * live claim must support a Why? interaction — this is the payload behind it.
 *
 * `ref` is an opaque server-side reference (a claim snapshot id), never a
 * contributor id, coordinate, or raw evidence row. Spec §23 and the intel
 * envelope contract both forbid exposing the cohort internals.
 */
export interface MapProvenanceLine {
  /** Human-readable evidence line, e.g. "Several recent traveler reports". */
  text: string;
  /** Opaque snapshot reference for replay/audit. Never a user identifier. */
  ref?: string;
}

export interface MapProvenance {
  lines: MapProvenanceLine[];
  /** Mirrors the object's confidence band; shown as "Confidence: Strong". */
  confidence: ConfidenceState;
  /** ISO timestamp the underlying evidence was last updated. */
  updatedAt?: string;
}

// ── The object (spec §18) ──────────────────────────────────────────────────────

export interface MapObject<T = unknown> {
  id: string;
  kind: MapObjectKind;
  geometry: MapGeometry;
  title: string;
  subtitle?: string;

  /** When the underlying observation was made. Absent => freshness 'unknown'. */
  observedAt?: string;
  /** When it stops being presentable as current (freshnessPolicy TTL). */
  expiresAt?: string;

  freshness?: FreshnessState;
  confidence?: ConfidenceState;
  /** Spec §7 activity level and trend, kept as separate axes. */
  activity?: ActivityLevel;
  trend?: TrendState;

  /**
   * WHO the live claim came from, as a value the renderer can switch on.
   *
   * OPTIONAL, and absent is meaningful: an object with no live claim has no
   * speaker, so there is no honest default — never fall back to a traveler
   * report. Absent also means "attribution withheld", which is what a
   * coarsened protected object looks like: spec §24 strips this field server
   * side, because `verified_firsthand` on its own still says "a
   * presence-verified person observed this place".
   *
   * Never widen this to a bare `string`. The server only ever sends a member of
   * SOURCE_CLASSES, and that guarantee is what lets a badge be exhaustive.
   */
  sourceClass?: SourceClass;

  /** Opaque provenance refs backing the §9 Why? panel. Never user identifiers. */
  sourceRefs?: string[];
  /** The pre-built Why? panel, when the source could supply one. */
  provenance?: MapProvenance;

  /** REQUIRED. Which §23 rung this geometry already sits on. */
  privacyClass: PrivacyClass;

  interaction?: MapInteractionConfig;

  /** REQUIRED. §31 collision ladder position; higher wins. */
  renderingPriority: number;

  /**
   * How many underlying objects this one stands for. >1 means the projection
   * aggregated them server-side (spec §31: "At wide zoom, many places should
   * collapse into an area summary or activity zone").
   */
  count?: number;

  /** Distance from the viewport centre in km, when the projection computed it. */
  distanceKm?: number | null;

  /**
   * The source payload, for cards that render type-specific fields.
   * Optional by design: an aggregated zone has no single underlying row.
   */
  payload?: T;
}

// ── Pure helpers ───────────────────────────────────────────────────────────────

/** The representative point for any geometry — a marker/label anchor. */
export function centroidOf(geometry: MapGeometry): { lat: number; lng: number } | null {
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates;
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLat = 0;
  let sumLng = 0;
  let n = 0;
  for (const pos of ring) {
    if (!Array.isArray(pos) || pos.length < 2) continue;
    const [lng, lat] = pos;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    sumLat += lat;
    sumLng += lng;
    n += 1;
  }
  return n === 0 ? null : { lat: sumLat / n, lng: sumLng / n };
}

/** Convenience constructor — keeps [lng, lat] ordering in one place. */
export function point(lat: number, lng: number): PointGeometry {
  return { type: 'Point', coordinates: [lng, lat] };
}

/**
 * §31 collision resolution: sort highest-priority first, then nearest, then by
 * id for a total order so paging and render output are deterministic.
 */
export function compareByRenderingPriority(a: MapObject, b: MapObject): number {
  if (b.renderingPriority !== a.renderingPriority) return b.renderingPriority - a.renderingPriority;
  const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
  const db = b.distanceKm ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Spec §39: every object on the map must answer at least one of seven
 * questions. An object with no title and no geometry answers none of them and
 * is dropped rather than rendered as an anonymous dot.
 */
export function isRenderable(obj: MapObject | null | undefined): boolean {
  if (!obj) return false;
  if (!obj.geometry || !centroidOf(obj.geometry)) return false;
  if (typeof obj.title !== 'string' || obj.title.trim() === '') return false;
  // `none` is the "not visible to this viewer" rung — it must never render.
  if (obj.privacyClass === 'none') return false;
  return true;
}
