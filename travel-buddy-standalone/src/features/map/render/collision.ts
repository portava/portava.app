/**
 * collision — the §31 rendering ladder, in pure functions.
 *
 * WHAT THIS IS
 * ============
 * Three related decisions the renderer has to make before it draws anything,
 * kept together because they are the same decision at three scales:
 *
 *   1. `zoomRenderBand` / `kindsVisibleAtBand` — §17: WHICH KINDS may exist at
 *      all at this camera altitude. "World: … no POI pins."
 *   2. `promotePriority` — §31 + §5: WHERE a single object sits on the ladder
 *      once selection, Compass, navigation, confidence and freshness are known.
 *   3. `resolveCollisions` — §31: when two objects overlap in screen space,
 *      "Hide lower-priority objects when collisions occur."
 *
 * It is deliberately pure and SDK-free. `@maplibre/maplibre-react-native` is
 * jest-mocked in this repo, so anything expressed as a map component is
 * untestable; everything decidable is decided here instead.
 *
 * WHAT THIS IS NOT
 * ================
 * This is not the projection layer. It never invents confidence, freshness or
 * privacy — it only reads the bands the Map Intelligence Gateway already
 * stamped onto the `MapObject` (§19: "The mobile client should not
 * independently reconstruct Portava intelligence rules"). The one judgement it
 * does make is a NEGATIVE one — demoting a claim that no longer qualifies —
 * which is safe in the direction §37 requires: "Do not let stale claims remain
 * visually live."
 *
 * COORDINATE CONTRACT
 * ===================
 * Screen space here is unrotated, unpitched Web Mercator at TILE_SIZE = 512,
 * matching MapLibre's own tile size. A rotated or pitched camera changes where
 * a marker lands but not, materially, whether two 44 px boxes collide, so the
 * simplification is stated rather than hidden. Antimeridian-spanning viewports
 * are NOT handled: an object 180° away is projected to a far-off world pixel
 * and simply never collides, which is the safe failure (it is kept, not
 * silently dropped).
 */

import {
  ZOOM_BANDS,
  isZoomBand,
  zoomBandRank,
  type ZoomBand,
} from '../vocabulary.ts';
import {
  CONFIDENCE_STATES,
  KIND_DEFAULT_PRIORITY,
  MAP_OBJECT_KINDS,
  RENDERING_PRIORITY,
  centroidOf,
  compareByRenderingPriority,
  isRenderable,
  mayRenderAsLive,
} from '../../../types/mapObjects.ts';
import type {
  ConfidenceState,
  MapObject,
  MapObjectKind,
  PolygonGeometry,
  Position,
} from '../../../types/mapObjects.ts';

// ── Web Mercator ──────────────────────────────────────────────────────────────

/**
 * MapLibre's default tile size. World width in pixels at zoom z is
 * TILE_SIZE * 2^z, so zoom 0 is one 512 px tile covering the whole world.
 */
export const TILE_SIZE = 512;

/**
 * The latitude at which the Mercator projection is truncated to a square world.
 *
 *   φ_max = 2·atan(e^π) − π/2  ≈ 85.0511287798066°
 *
 * Beyond it y runs to infinity. Latitudes are clamped, never wrapped: clamping
 * moves a pole-adjacent object to the edge of the world, wrapping would move it
 * to the wrong hemisphere.
 */
export const MAX_MERCATOR_LATITUDE = 85.0511287798066;

const DEG = Math.PI / 180;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** World width/height in pixels at `zoom`. */
export function worldSize(zoom: number): number {
  return TILE_SIZE * Math.pow(2, zoom);
}

/**
 * lat/lng → absolute world pixel, origin at the top-left of the world square
 * (north-west), y increasing southwards.
 *
 *   x = (λ + 180) / 360 · S
 *   y = (0.5 − ln((1 + sin φ) / (1 − sin φ)) / 4π) · S
 *
 * The y term is the Gudermannian inverse written with sines rather than
 * tan(π/4 + φ/2) so it stays finite and symmetric at the equator.
 */
export function projectToWorld(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const size = worldSize(zoom);
  const phi = clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE) * DEG;
  const sin = Math.sin(phi);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

/**
 * Inverse of `projectToWorld`.
 *
 *   λ = x / S · 360 − 180
 *   φ = atan(sinh(π · (1 − 2y / S)))
 */
export function unprojectFromWorld(x: number, y: number, zoom: number): { lat: number; lng: number } {
  const size = worldSize(zoom);
  const n = Math.PI * (1 - (2 * y) / size);
  return {
    lat: Math.atan(Math.sinh(n)) / DEG,
    lng: (x / size) * 360 - 180,
  };
}

/** An unrotated, unpitched camera: what the device is currently showing. */
export interface ScreenViewport {
  center: { lat: number; lng: number };
  zoom: number;
  /** Viewport width in points (not physical pixels). */
  width: number;
  /** Viewport height in points. */
  height: number;
}

/** lat/lng → viewport-relative point, origin at the viewport's top-left. */
export function toScreen(
  lat: number,
  lng: number,
  viewport: ScreenViewport,
): { x: number; y: number } {
  const world = projectToWorld(lat, lng, viewport.zoom);
  const centre = projectToWorld(viewport.center.lat, viewport.center.lng, viewport.zoom);
  return {
    x: world.x - centre.x + viewport.width / 2,
    y: world.y - centre.y + viewport.height / 2,
  };
}

/** Inverse of `toScreen`. */
export function fromScreen(
  x: number,
  y: number,
  viewport: ScreenViewport,
): { lat: number; lng: number } {
  const centre = projectToWorld(viewport.center.lat, viewport.center.lng, viewport.zoom);
  return unprojectFromWorld(
    x - viewport.width / 2 + centre.x,
    y - viewport.height / 2 + centre.y,
    viewport.zoom,
  );
}

/** Ground resolution in metres per screen point at a given latitude and zoom. */
export function metresPerPixel(lat: number, zoom: number): number {
  const EARTH_CIRCUMFERENCE_M = 40075016.686;
  return (EARTH_CIRCUMFERENCE_M * Math.cos(clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE) * DEG)) / worldSize(zoom);
}

/**
 * A closed ring approximating a circle of `radiusMetres` around a point.
 *
 * Zones are frequently projected as a centroid plus a radius rather than a
 * traced boundary. §6 is explicit that a zone "should not imply scientifically
 * exact borders", so a smooth circle is not a loss of fidelity here — it is the
 * honest shape for an aggregate.
 *
 * The ring is generated in geographic space with the longitude step divided by
 * cos(φ) so the result is round on screen rather than an ellipse squashed by
 * the latitude scale factor.
 */
export function circlePolygon(
  lat: number,
  lng: number,
  radiusMetres: number,
  steps = 48,
): PolygonGeometry {
  const METRES_PER_DEGREE_LAT = 111320;
  const n = Math.max(8, Math.floor(steps));
  const dLat = radiusMetres / METRES_PER_DEGREE_LAT;
  const cosLat = Math.cos(clamp(lat, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE) * DEG);
  // Guard the pole: cos φ → 0 would blow the longitude step up to a full turn.
  const dLng = dLat / Math.max(cosLat, 1e-6);
  const ring: Position[] = [];
  for (let i = 0; i < n; i += 1) {
    const theta = (i / n) * 2 * Math.PI;
    ring.push([lng + dLng * Math.cos(theta), lat + dLat * Math.sin(theta)]);
  }
  // GeoJSON linear rings must be closed: first position repeated last.
  ring.push([ring[0][0], ring[0][1]]);
  return { type: 'Polygon', coordinates: [ring] };
}

// ── §17 zoom model ────────────────────────────────────────────────────────────

/** The five render bands of §17's zoom table, widest first. */
// The band NAMES live in features/map/vocabulary.ts (a leaf module) so the
// layer model and this module cannot drift apart on spelling. The numeric
// thresholds below stay here: those are a rendering policy, not vocabulary.
export { ZOOM_BANDS, isZoomBand, zoomBandRank, type ZoomBand };

/**
 * Lower bound (inclusive) of each band. `world` is everything below `city`.
 *
 * The breaks are chosen against what the band is *for*, not against round
 * numbers: 5 is where a country stops fitting the screen, 12 is where street
 * geometry appears and an individual place becomes tappable, 15 is where
 * entrances and building footprints resolve, 17.5 is inside a single venue.
 */
export const ZOOM_BAND_MIN: Record<ZoomBand, number> = {
  world: -Infinity,
  city: 5,
  district: 12,
  street: 15,
  venue: 17.5,
};

export function zoomRenderBand(zoom: number): ZoomBand {
  if (!Number.isFinite(zoom)) return 'world'; // fail closed: fewest kinds
  if (zoom >= ZOOM_BAND_MIN.venue) return 'venue';
  if (zoom >= ZOOM_BAND_MIN.street) return 'street';
  if (zoom >= ZOOM_BAND_MIN.district) return 'district';
  if (zoom >= ZOOM_BAND_MIN.city) return 'city';
  return 'world';
}

/**
 * What each band ADDS to the band above it, straight from §17's table.
 *
 * Written as increments rather than five full lists so a kind cannot be
 * accidentally visible at `district` and invisible at `street` — the model is
 * strictly cumulative as you zoom in, which is what §16's "rendering detail
 * changes based on zoom" means.
 *
 * `safety_notice` is in the `world` row on purpose. §5: "Safety and active
 * navigation always take visual precedence over popularity or activity" — a
 * safety notice that a zoom-out silently removes is the one failure this whole
 * module exists to prevent.
 */
const BAND_INTRODUCES: Record<ZoomBand, readonly MapObjectKind[]> = {
  // "Countries visited, upcoming Trips, Passport, major destinations; no POI pins."
  world: ['safety_notice', 'trip_stop', 'memory'],
  // "Neighborhoods, activity zones, major events, major flow, key Compass recommendations."
  city: ['activity_zone', 'crowd_flow', 'prediction', 'event'],
  // "Live places, events, gems, social opportunities, Trip objects."
  district: ['place', 'hidden_gem', 'social_zone', 'buddy_zone'],
  // "Individual places, entrances, authorized crew, meeting points, route context."
  street: ['crew_member', 'meeting_point'],
  // "Stages, entrances, checkpoints, food, toilets…, group members, meeting zones."
  venue: [],
};

const VISIBLE_BY_BAND: Record<ZoomBand, readonly MapObjectKind[]> = (() => {
  const out = {} as Record<ZoomBand, MapObjectKind[]>;
  const seen: MapObjectKind[] = [];
  for (const band of ZOOM_BANDS) {
    for (const kind of BAND_INTRODUCES[band]) if (!seen.includes(kind)) seen.push(kind);
    out[band] = [...seen];
  }
  return out;
})();

/** Every kind renderable at `band`, in `MAP_OBJECT_KINDS` order. */
export function kindsVisibleAtBand(band: ZoomBand): readonly MapObjectKind[] {
  const set = VISIBLE_BY_BAND[band] ?? VISIBLE_BY_BAND.world;
  return MAP_OBJECT_KINDS.filter((k) => set.includes(k));
}

export function isKindVisibleAtBand(kind: MapObjectKind, band: ZoomBand): boolean {
  return (VISIBLE_BY_BAND[band] ?? VISIBLE_BY_BAND.world).includes(kind);
}

// ── §31 priority promotion ────────────────────────────────────────────────────

/** Position of a confidence band in `CONFIDENCE_STATES`; -1 when absent. */
export function confidenceRank(state: ConfidenceState | null | undefined): number {
  return state == null ? -1 : CONFIDENCE_STATES.indexOf(state);
}

export function confidenceAtLeast(
  state: ConfidenceState | null | undefined,
  floor: ConfidenceState,
): boolean {
  return confidenceRank(state) >= confidenceRank(floor);
}

/**
 * The confidence floor for the `high_confidence_live_zone` tier.
 *
 * The tier's own name sets the bar: only §7's "Confirmed" (`strong`) and
 * "Strong signal" (`live`) are high confidence. "Reports indicate"
 * (`likely_current`) is a real claim but not one that should outrank a place
 * the user actually saved.
 */
export const LIVE_ZONE_CONFIDENCE_FLOOR: ConfidenceState = 'live';

/** Kinds whose default tier is `high_confidence_live_zone` and can lose it. */
const LIVE_ZONE_KINDS: readonly MapObjectKind[] = ['activity_zone', 'crowd_flow', 'prediction'];

/**
 * Where a zone lands when it no longer earns its tier.
 *
 * Two rungs, because there are two different failures. A zone whose evidence is
 * thin is still a current observation (`uncertain` → below relevant places,
 * above saved ones). A zone whose evidence has EXPIRED is not an observation at
 * all any more — §37: "Do not let stale claims remain visually live" — so it
 * falls to the bottom of the ladder, where a collision with almost anything
 * hides it.
 */
export const DEMOTED_ZONE_PRIORITY = {
  uncertain: RENDERING_PRIORITY.social_opportunity,
  stale: RENDERING_PRIORITY.generic_poi,
} as const;

export interface PromotionContext {
  /** The object the bottom sheet / carousel is currently showing (§30 PLACE_SELECTED). */
  selectedId?: string | null;
  /** Objects Compass surfaced this session (§14). */
  compassRecommendationIds?: readonly string[] | ReadonlySet<string>;
  /** The object an active route is heading to (§30 camera FOCUS_ROUTE). */
  navigationTargetId?: string | null;
  /** Clock injection point. Defaults to `Date.now()`. */
  now?: number | Date;
}

export type PriorityReason =
  | 'kind_default'
  | 'expired'
  | 'stale_freshness'
  | 'low_confidence'
  | 'compass_recommendation'
  | 'selected'
  | 'active_navigation';

export interface PriorityExplanation {
  priority: number;
  /** Ladder rung the final number corresponds to, when it names one exactly. */
  tier: keyof typeof RENDERING_PRIORITY | null;
  /** Every rule that fired, in the order it was applied. Ordered for display. */
  reasons: PriorityReason[];
}

function nowMs(ctx: PromotionContext | undefined): number {
  const n = ctx?.now;
  if (n == null) return Date.now();
  return n instanceof Date ? n.getTime() : n;
}

function hasId(
  ids: readonly string[] | ReadonlySet<string> | undefined,
  id: string,
): boolean {
  if (!ids) return false;
  return ids instanceof Set ? ids.has(id) : (ids as readonly string[]).includes(id);
}

function tierFor(priority: number): keyof typeof RENDERING_PRIORITY | null {
  for (const [name, value] of Object.entries(RENDERING_PRIORITY)) {
    if (value === priority) return name as keyof typeof RENDERING_PRIORITY;
  }
  return null;
}

/**
 * The full priority decision for one object, with its reasoning.
 *
 * Order matters and is one-directional: demote first, then promote, then take
 * the maximum. That means a user-driven promotion (selection, navigation)
 * always wins over an evidence-driven demotion — the user asked for that object
 * to be on screen — while a stale zone nobody asked for quietly falls away.
 */
export function explainPriority(obj: MapObject, ctx: PromotionContext = {}): PriorityExplanation {
  const reasons: PriorityReason[] = ['kind_default'];
  let priority = KIND_DEFAULT_PRIORITY[obj.kind] ?? RENDERING_PRIORITY.generic_poi;

  if (LIVE_ZONE_KINDS.includes(obj.kind)) {
    const expired =
      typeof obj.expiresAt === 'string' &&
      Number.isFinite(Date.parse(obj.expiresAt)) &&
      Date.parse(obj.expiresAt) <= nowMs(ctx);

    if (expired) {
      priority = DEMOTED_ZONE_PRIORITY.stale;
      reasons.push('expired');
    } else if (!mayRenderAsLive(obj.freshness)) {
      priority = DEMOTED_ZONE_PRIORITY.stale;
      reasons.push('stale_freshness');
    } else if (!confidenceAtLeast(obj.confidence, LIVE_ZONE_CONFIDENCE_FLOOR)) {
      priority = DEMOTED_ZONE_PRIORITY.uncertain;
      reasons.push('low_confidence');
    }
  }

  if (hasId(ctx.compassRecommendationIds, obj.id) && RENDERING_PRIORITY.compass_recommendation > priority) {
    priority = RENDERING_PRIORITY.compass_recommendation;
    reasons.push('compass_recommendation');
  }
  if (ctx.selectedId === obj.id && RENDERING_PRIORITY.selected_destination > priority) {
    priority = RENDERING_PRIORITY.selected_destination;
    reasons.push('selected');
  }
  if (ctx.navigationTargetId === obj.id && RENDERING_PRIORITY.active_navigation > priority) {
    priority = RENDERING_PRIORITY.active_navigation;
    reasons.push('active_navigation');
  }

  return { priority, tier: tierFor(priority), reasons };
}

/** The §31 ladder position for one object under the current context. */
export function promotePriority(obj: MapObject, ctx: PromotionContext = {}): number {
  return explainPriority(obj, ctx).priority;
}

/**
 * `objects` with `renderingPriority` recomputed. Returns new objects; the
 * inputs are never mutated, so the projection's cached payload stays canonical.
 */
export function promoteAll(objects: readonly MapObject[], ctx: PromotionContext = {}): MapObject[] {
  return objects.map((o) => {
    const priority = promotePriority(o, ctx);
    return priority === o.renderingPriority ? o : { ...o, renderingPriority: priority };
  });
}

/**
 * The ids a producer already stamped with the §14 Compass rung.
 *
 * `explainPriority` seeds from `KIND_DEFAULT_PRIORITY[obj.kind]` and never
 * looks at the object's own `renderingPriority`, so a rung a producer set —
 * `compassMapModel.toMapObjects` on every pick, `tripMapModel` on every Compass
 * alternative — is DISCARDED by `promoteAll` unless the id is also named in
 * `PromotionContext.compassRecommendationIds`. A pick of kind `place` silently
 * fell from `compass_recommendation` (70) to `relevant_place` (40), losing
 * collisions to ordinary events (60) and live zones (50) that §31 says it
 * outranks; picks of different kinds ended up on different rungs, so "these are
 * the N picks" stopped being one tier.
 *
 * This re-declares that producer intent through the documented channel rather
 * than teaching the ladder about Compass payload shapes.
 */
export function compassRecommendationIdsOf(objects: readonly MapObject[]): string[] {
  return objects
    .filter((o) => o.renderingPriority === RENDERING_PRIORITY.compass_recommendation)
    .map((o) => o.id);
}

// ── §31 collision resolution ──────────────────────────────────────────────────

export interface HitBox {
  width: number;
  height: number;
  /**
   * Vertical offset of the box centre from the anchor point, in points.
   * Negative is upward. A teardrop pin's body sits ABOVE its coordinate, so its
   * box has to sit there too or every pin appears to collide with the label of
   * whatever is directly below it.
   */
  offsetY?: number;
}

/**
 * Default marker footprint. 44 pt is the platform minimum touch target, and a
 * collision rule looser than the touch target produces markers that overlap
 * each other's tap areas — visually resolved, functionally still colliding.
 */
export const DEFAULT_HIT_BOX: HitBox = { width: 44, height: 44, offsetY: -8 };

/**
 * Extra breathing room around each box, in points. Two markers exactly 44 pt
 * apart are technically not overlapping and still read as one smudge.
 */
export const DEFAULT_COLLISION_PADDING = 4;

export type DropReason = 'not_renderable' | 'zoom_band' | 'collision';

export interface DroppedMapObject {
  object: MapObject;
  reason: DropReason;
  /** For `collision`, the id of the higher-priority object that won. */
  occludedBy?: string;
}

export interface CollisionResult {
  kept: MapObject[];
  /** Every input not in `kept`, with the rule that removed it. Never truncated. */
  dropped: DroppedMapObject[];
  /** `dropped.length`, for the §31 "N more" affordance. */
  droppedCount: number;
  /** Only the collision drops — what a "N more here" chip should actually count. */
  collisionDroppedCount: number;
  band: ZoomBand;
}

export interface CollisionOptions {
  viewport: ScreenViewport;
  /** Overrides the band derived from `viewport.zoom`. */
  band?: ZoomBand;
  /** Set false to skip §17 gating (e.g. a layer the user explicitly enabled). */
  applyZoomBands?: boolean;
  /** Per-object footprint. Defaults to `DEFAULT_HIT_BOX` for every kind. */
  hitBoxFor?: (obj: MapObject) => HitBox;
  padding?: number;
  /**
   * Kinds exempt from collision entirely — they are drawn on a lower level of
   * §5's hierarchy and cannot occlude, or be occluded by, a marker.
   * Defaults to `AREA_GEOMETRY_EXEMPT` semantics (see `collides`).
   */
  alwaysKeepKinds?: readonly MapObjectKind[];
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxFor(obj: MapObject, viewport: ScreenViewport, hitBox: HitBox, padding: number): Box | null {
  const c = centroidOf(obj.geometry);
  if (!c) return null;
  const { x, y } = toScreen(c.lat, c.lng, viewport);
  const cy = y + (hitBox.offsetY ?? 0);
  const halfW = hitBox.width / 2 + padding;
  const halfH = hitBox.height / 2 + padding;
  return { minX: x - halfW, minY: cy - halfH, maxX: x + halfW, maxY: cy + halfH };
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/**
 * Whether an object participates in collision at all.
 *
 * §5 stacks the map in levels: activity zones sit at Level 2, crowd flow at
 * Level 3, markers at Level 4 and above. A soft filled zone underneath a pin is
 * not a collision — it is the design. So only POINT geometry collides;
 * Polygons and LineStrings are area/route objects rendered on their own layers
 * and are always kept.
 */
export function participatesInCollision(obj: MapObject): boolean {
  return obj.geometry?.type === 'Point';
}

/**
 * §31: "Hide lower-priority objects when collisions occur."
 *
 * Deterministic by construction: the input is sorted with the contract's own
 * `compareByRenderingPriority` (priority, then distance, then id), and the
 * winner of any overlap is whichever object that total order reached first. The
 * same input always yields the same kept/dropped split, which is what makes the
 * "N more" count stable across a re-render.
 *
 * Nothing is ever silently truncated: `kept.length + dropped.length` always
 * equals `objects.length`, and every input appears in exactly one of them.
 */
export function resolveCollisions(
  objects: readonly MapObject[],
  opts: CollisionOptions,
): CollisionResult {
  const band = opts.band ?? zoomRenderBand(opts.viewport.zoom);
  const applyBands = opts.applyZoomBands !== false;
  const padding = opts.padding ?? DEFAULT_COLLISION_PADDING;
  const hitBoxFor = opts.hitBoxFor ?? (() => DEFAULT_HIT_BOX);

  const ordered = [...objects].sort(compareByRenderingPriority);

  const kept: MapObject[] = [];
  const dropped: DroppedMapObject[] = [];
  const placed: { id: string; box: Box }[] = [];

  for (const obj of ordered) {
    if (!isRenderable(obj)) {
      dropped.push({ object: obj, reason: 'not_renderable' });
      continue;
    }
    if (applyBands && !isKindVisibleAtBand(obj.kind, band)) {
      dropped.push({ object: obj, reason: 'zoom_band' });
      continue;
    }
    const exempt =
      !participatesInCollision(obj) ||
      (opts.alwaysKeepKinds?.includes(obj.kind) ?? false);
    if (exempt) {
      kept.push(obj);
      continue;
    }
    const box = boxFor(obj, opts.viewport, hitBoxFor(obj), padding);
    if (!box) {
      // isRenderable already proved a centroid exists, so this is unreachable
      // in practice — but a null box must never become a silent keep.
      dropped.push({ object: obj, reason: 'not_renderable' });
      continue;
    }
    const hit = placed.find((p) => overlaps(p.box, box));
    if (hit) {
      dropped.push({ object: obj, reason: 'collision', occludedBy: hit.id });
      continue;
    }
    placed.push({ id: obj.id, box });
    kept.push(obj);
  }

  return {
    kept,
    dropped,
    droppedCount: dropped.length,
    collisionDroppedCount: dropped.filter((d) => d.reason === 'collision').length,
    band,
  };
}

/**
 * The whole client-side pipeline in one call: promote, then resolve.
 * `MapScreen` should use this rather than sequencing the two itself, so the
 * ladder is applied before collisions are judged — the opposite order would let
 * a generic POI hide the place the user is navigating to.
 */
export function prepareForRender(
  objects: readonly MapObject[],
  opts: CollisionOptions & { promotion?: PromotionContext },
): CollisionResult {
  return resolveCollisions(promoteAll(objects, opts.promotion ?? {}), opts);
}
