/**
 * pulseMapBridge — Pulse ⇄ Map deep-link bridge (Map spec §26).
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE
 * ==========================================
 * Spec §26, in full:
 *
 *     "Pulse and Map must be two presentations of the same underlying
 *      intelligence. Pulse is narrative; Map is geographic. A Pulse item
 *      should deep-link to the corresponding map state, and map states should
 *      never contradict Pulse because of separately implemented truth logic."
 *
 * The failure mode named in that last clause is *silent*. Two surfaces, each
 * with its own perfectly reasonable local rule for "is this busy?", drift
 * apart; nothing errors, and the product simply starts telling the user two
 * different things about the same bar. `assertNoContradiction()` at the bottom
 * of this file IS the §26 guarantee: it is the place where that drift stops
 * being invisible. Everything above it is the deep-link plumbing §26 also asks
 * for, in both directions.
 *
 * WHAT THIS IS NOT
 * ================
 * Pure data + pure functions. No network, no React, no storage, no clock.
 * It computes NO intelligence of its own — it only translates between two
 * representations of intelligence computed server-side. Per spec §19, "the
 * mobile client should not independently reconstruct Portava intelligence
 * rules", and re-deriving activity/confidence here would be exactly the
 * "separately implemented truth logic" §26 forbids.
 *
 * WHY THE §30 VOCABULARY LIVES HERE
 * =================================
 * `MAP_MODES`, `MAP_CAMERA_STATES` and `MAP_LAYERS` transcribe spec §30 and
 * §16. They are declared in this file because the Pulse bridge is the first
 * module that needs to *name* a map state rather than merely render one. If a
 * canonical `features/map/state/mapState.ts` lands later, these constants
 * should be re-homed there and re-exported from here — they are transcriptions
 * of the spec, not a competing definition.
 */

import type { LivePulseItem, LivePulseItemType, LivePulseContext } from '../../../services/livePulse.ts';
import type {
  ActivityLevel,
  ConfidenceState,
  FreshnessState,
  MapObject,
  MapObjectKind,
  TrendState,
} from '../../../types/mapObjects.ts';
import { MAP_MODES, type MapMode } from '../vocabulary.ts';
import { CAMERA_STATES as MAP_CAMERA_STATES, type CameraState as MapCameraState } from '../state/mapMachine.ts';
import { CORE_LAYER_IDS as MAP_LAYERS, type CoreLayerId as MapLayer } from '../layers/layerModel.ts';
import { centroidOf } from '../../../types/mapObjects.ts';

// ── Geometry primitives ────────────────────────────────────────────────────────

export interface LatLng {
  lat: number;
  lng: number;
}

/** An axis-aligned viewport box. Longitudes are NOT normalised across ±180. */
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** The box containing every supplied point, or null when none are finite. */
export function boundsOfPoints(points: readonly LatLng[]): MapBounds | null {
  let south = Number.POSITIVE_INFINITY;
  let west = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let n = 0;
  for (const p of points) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
    n += 1;
  }
  return n === 0 ? null : { south, west, north, east };
}

/** The geometric centre of a box. */
export function centerOfBounds(b: MapBounds): LatLng {
  return { lat: (b.south + b.north) / 2, lng: (b.west + b.east) / 2 };
}

/** Grow a box by a fractional margin so framing does not clip the subject. */
export function padBounds(b: MapBounds, fraction = 0.15): MapBounds {
  const dLat = Math.max((b.north - b.south) * fraction, 1e-4);
  const dLng = Math.max((b.east - b.west) * fraction, 1e-4);
  return {
    south: b.south - dLat,
    west: b.west - dLng,
    north: b.north + dLat,
    east: b.east + dLng,
  };
}

// ── §30 state machine vocabulary ───────────────────────────────────────────────

/** Spec §30 primary modes. */
// §26's whole point is that Pulse and Map cannot disagree, so this module must
// not hold its own copy of the map's vocabulary — a private enum here is
// precisely the "separately implemented truth logic" the section forbids.
// Modes come from the leaf vocabulary, camera states from the state machine
// that owns them, and layers from the layer model. All three already matched
// character-for-character; this makes that structural instead of coincidental.
export { MAP_MODES, MAP_CAMERA_STATES, MAP_LAYERS };
export type { MapMode, MapCameraState, MapLayer };

/**
 * Spec §16 suggested defaults: "Live Activity on, Events on, Relevant Places
 * on, Saved on". ("Relevant Places" is not a toggleable layer — relevant places
 * are the map's baseline content, governed by ranking rather than a switch.)
 */
export const DEFAULT_MAP_LAYERS: readonly MapLayer[] = ['live_activity', 'events', 'saved'];

/** Deterministic layer ordering + de-duplication, so state objects compare equal. */
export function normaliseLayers(layers: readonly MapLayer[]): MapLayer[] {
  const seen = new Set<MapLayer>();
  for (const l of layers) if (MAP_LAYERS.includes(l)) seen.add(l);
  return MAP_LAYERS.filter((l) => seen.has(l));
}

// ── The deep-link state ────────────────────────────────────────────────────────

/** What the camera is looking at, and why. */
export interface MapCameraTarget {
  state: MapCameraState;
  /** Point to centre on. Null when the Pulse item had no resolved geography. */
  center: LatLng | null;
  /** Box to frame. Takes precedence over `center` when present. */
  bounds: MapBounds | null;
  /** Suggested zoom for a point target; null when framing bounds. */
  zoom: number | null;
  /** The subject the camera is following, for telemetry and back-navigation. */
  subject: { kind: MapObjectKind | null; id: string | null };
}

/** The complete map state a Pulse item deep-links into. */
export interface MapDeepLinkState {
  mode: MapMode;
  cameraTarget: MapCameraTarget;
  /** Map object to open/select on arrival, or null to land in the mode itself. */
  selectedObjectId: string | null;
  layers: MapLayer[];
}

/**
 * Geography for a Pulse item, resolved by the caller.
 *
 * `LivePulseItem` is a narrative payload — it carries no coordinates. Rather
 * than have this module guess (or worse, centre on the user and imply the
 * subject is where they are), the caller passes whatever the projection
 * already resolved. Absent geography yields a state with `center: null`, which
 * the renderer treats as "enter this mode without moving the camera".
 */
export interface PulseSubjectGeo {
  center?: LatLng | null;
  bounds?: MapBounds | null;
  /** Points to frame when the subject spans several places (a trip, a crew). */
  points?: readonly LatLng[] | null;
}

/** Per-Pulse-type routing table. One row per §26 deep-link destination. */
interface PulseRoute {
  mode: MapMode;
  camera: MapCameraState;
  kind: MapObjectKind | null;
  layers: readonly MapLayer[];
  zoom: number;
  /** Whether arriving should open the object's sheet, or just enter the mode. */
  selects: boolean;
}

const PULSE_ROUTES: Record<LivePulseItemType, PulseRoute> = {
  event: {
    mode: 'PLACE_SELECTED',
    camera: 'FOCUS_PLACE',
    kind: 'event',
    layers: ['events', 'live_activity'],
    zoom: 16,
    selects: true,
  },
  trip: {
    mode: 'TRIP',
    camera: 'FOCUS_TRIP',
    kind: 'trip_stop',
    layers: ['trip', 'saved', 'live_activity'],
    zoom: 12,
    selects: false,
  },
  trip_request: {
    mode: 'TRIP',
    camera: 'FOCUS_TRIP',
    kind: 'trip_stop',
    layers: ['trip'],
    zoom: 12,
    selects: false,
  },
  buddy_request: {
    mode: 'LIVE',
    camera: 'FOCUS_AREA',
    kind: 'buddy_zone',
    layers: ['buddies', 'people'],
    zoom: 13,
    selects: false,
  },
  available_buddy: {
    mode: 'LIVE',
    camera: 'FOCUS_AREA',
    kind: 'buddy_zone',
    layers: ['buddies', 'people'],
    zoom: 13,
    selects: false,
  },
  hidden_gem: {
    mode: 'PLACE_SELECTED',
    camera: 'FOCUS_PLACE',
    kind: 'hidden_gem',
    layers: ['hidden_gems'],
    zoom: 16,
    selects: true,
  },
  compass: {
    mode: 'COMPASS',
    camera: 'COMPASS_RECOMMENDATIONS',
    kind: 'place',
    layers: ['live_activity', 'events'],
    zoom: 14,
    selects: true,
  },
  circle: {
    mode: 'LOCATE_FRIENDS',
    camera: 'FOCUS_GROUP',
    kind: 'crew_member',
    layers: ['people', 'trip'],
    zoom: 14,
    selects: false,
  },
  safe_return: {
    mode: 'LIVE',
    camera: 'FOCUS_ROUTE',
    kind: 'safety_notice',
    layers: ['safety', 'transport'],
    zoom: 15,
    selects: true,
  },
};

/** The map-object id convention: `<kind>:<canonical entity id>`. */
export function mapObjectIdFor(kind: MapObjectKind, entityId: string): string {
  return `${kind}:${entityId}`;
}

/**
 * The canonical entity id behind a map object.
 *
 * Prefers an explicit `payload.sourceId` when the projection supplied one, and
 * otherwise strips the `<kind>:` prefix from the object id. Objects whose id is
 * already bare come back unchanged.
 */
export function entityIdOfMapObject(obj: MapObject): string {
  const payload = obj.payload as { sourceId?: unknown } | undefined;
  if (payload && typeof payload.sourceId === 'string' && payload.sourceId !== '') {
    return payload.sourceId;
  }
  const prefix = `${obj.kind}:`;
  return obj.id.startsWith(prefix) ? obj.id.slice(prefix.length) : obj.id;
}

/**
 * §26 forward direction: a Pulse item → the map state that shows the same
 * thing geographically.
 *
 * Deterministic and total: every `LivePulseItemType` has a route, and an
 * unknown type (an older/newer server build) falls back to LIVE + default
 * layers rather than throwing at a user who just tapped a card.
 */
export function pulseItemToMapState(
  item: LivePulseItem,
  geo: PulseSubjectGeo | null = null,
): MapDeepLinkState {
  const route = PULSE_ROUTES[item.item_type] ?? {
    mode: 'LIVE' as MapMode,
    camera: 'FREE_EXPLORE' as MapCameraState,
    kind: null,
    layers: DEFAULT_MAP_LAYERS,
    zoom: 13,
    selects: false,
  };

  const framed =
    geo?.bounds ??
    (geo?.points && geo.points.length > 1 ? boundsOfPoints(geo.points) : null);
  const center =
    geo?.center ??
    (framed ? centerOfBounds(framed) : null) ??
    (geo?.points && geo.points.length === 1 ? geo.points[0] : null);

  const selectedObjectId =
    route.selects && route.kind && item.item_id
      ? mapObjectIdFor(route.kind, item.item_id)
      : null;

  return {
    mode: route.mode,
    cameraTarget: {
      state: route.camera,
      center: center ?? null,
      bounds: framed ?? null,
      zoom: framed ? null : route.zoom,
      subject: { kind: route.kind, id: item.item_id || null },
    },
    selectedObjectId,
    layers: normaliseLayers([...route.layers]),
  };
}

/**
 * The single "most important nearby change" the §3 Live Pulse card shows.
 *
 * Pure and deterministic, so the card cannot flicker between two equally-ranked
 * items across renders. The ladder mirrors §5's precedence rule — safety first,
 * then things the user must act on, then things that are about to happen:
 *
 *   safe_return  →  Action Needed  →  time pressure  →  crowd size  →  id
 *
 * `exclude` lets the caller drop session-dismissed cards without this function
 * needing to know about the dismiss store (which is stateful, and lives in
 * services/livePulse.ts).
 */
const STATUS_URGENCY: Record<string, number> = {
  'Action Needed': 0,
  'Starting Soon': 1,
  'Ends Soon': 2,
  Ongoing: 3,
  Tonight: 4,
  Tomorrow: 5,
  Upcoming: 6,
  'My Plan': 7,
};

export function selectHeadlinePulseItem<T extends LivePulseItem>(
  items: readonly T[],
  exclude: (item: T) => boolean = () => false,
): T | null {
  let best: T | null = null;
  let bestKey: [number, number, number, string] | null = null;

  for (const item of items ?? []) {
    if (!item || exclude(item)) continue;
    const key: [number, number, number, string] = [
      item.item_type === 'safe_return' ? 0 : 1,
      STATUS_URGENCY[item.status_label] ?? 99,
      -(item.people_count ?? 0),
      item.id ?? '',
    ];
    if (
      bestKey == null ||
      key[0] < bestKey[0] ||
      (key[0] === bestKey[0] &&
        (key[1] < bestKey[1] ||
          (key[1] === bestKey[1] &&
            (key[2] < bestKey[2] || (key[2] === bestKey[2] && key[3] < bestKey[3])))))
    ) {
      best = item;
      bestKey = key;
    }
  }
  return best;
}

// ── Reverse direction ──────────────────────────────────────────────────────────

/** Parameters for GET /api/pulse/live that correspond to a given map state. */
export interface PulseQuery {
  context: LivePulseContext;
  lat: number | null;
  lng: number | null;
  citySlug: string | null;
  /** Pulse item types worth showing for this map state, in §26 relevance order. */
  itemTypes: LivePulseItemType[];
  /** The map's current subject, so the matching card can be scrolled to. */
  focusItemId: string | null;
}

const MODE_ITEM_TYPES: Record<MapMode, readonly LivePulseItemType[]> = {
  LIVE: ['event', 'hidden_gem', 'compass', 'available_buddy', 'safe_return'],
  PLACE_SELECTED: ['event', 'hidden_gem', 'compass'],
  COMPASS: ['compass', 'event', 'hidden_gem'],
  TRIP: ['trip', 'trip_request', 'event', 'safe_return'],
  CROWD_FLOW: ['event', 'compass'],
  LOCATE_FRIENDS: ['circle', 'available_buddy', 'buddy_request', 'safe_return'],
  TIME_MACHINE: ['event'],
};

/**
 * §26 reverse direction: the current map state → the Pulse query whose
 * narrative covers the same ground.
 *
 * `context` is chosen from the CAMERA rather than the mode wherever the camera
 * is more specific: a user following their own dot wants `nearMe` regardless of
 * which mode they are in, and a trip focus wants `specificTrip`.
 */
export function mapStateToPulseQuery(
  state: MapDeepLinkState,
  opts: { citySlug?: string | null } = {},
): PulseQuery {
  const cam = state.cameraTarget;
  const citySlug = opts.citySlug ?? null;

  let context: LivePulseContext;
  if (cam.state === 'FOCUS_TRIP' && cam.subject.id) context = 'specificTrip';
  else if (state.mode === 'TRIP') context = 'tripCity';
  else if (cam.state === 'FOLLOW_USER' || cam.state === 'FOCUS_GROUP') context = 'nearMe';
  else if (cam.center) context = 'nearMe';
  else if (citySlug) context = 'currentCity';
  else context = 'myPlans';

  return {
    context,
    lat: cam.center?.lat ?? null,
    lng: cam.center?.lng ?? null,
    citySlug,
    itemTypes: [...(MODE_ITEM_TYPES[state.mode] ?? MODE_ITEM_TYPES.LIVE)],
    focusItemId: cam.subject.id,
  };
}

/**
 * The map screen's convenience over `mapStateToPulseQuery`: it holds primitives
 * (a mode, a camera centre, maybe a selected object and a city) rather than a
 * `MapDeepLinkState`, so this assembles the minimal state and reverses it into a
 * Pulse query. It exists so the Map → Pulse direction is a ONE-LINE call at the
 * fetch site and the state-assembly rule is testable on its own — a screen that
 * hand-rolled the `MapDeepLinkState` inline would be re-deriving §26's mapping
 * where no test could see it.
 *
 * `cameraState` defaults from the centre: a fix means the user is looking at a
 * place (FOLLOW_USER → `nearMe`), no fix means a free/city view. Callers that
 * know the real camera state (following the user, focused on a trip) should pass
 * it so `mapStateToPulseQuery` can pick the more specific context.
 */
export function pulseQueryForMap(input: {
  mode: MapMode;
  cameraState?: MapCameraState;
  center?: LatLng | null;
  subjectKind?: MapObjectKind | null;
  subjectId?: string | null;
  citySlug?: string | null;
  layers?: readonly MapLayer[];
}): PulseQuery {
  const center = input.center ?? null;
  const state: MapDeepLinkState = {
    mode: input.mode,
    cameraTarget: {
      state: input.cameraState ?? (center ? "FOLLOW_USER" : "FREE_EXPLORE"),
      center,
      bounds: null,
      zoom: null,
      subject: { kind: input.subjectKind ?? null, id: input.subjectId ?? null },
    },
    selectedObjectId: input.subjectId ?? null,
    layers: normaliseLayers(input.layers ? [...input.layers] : [...DEFAULT_MAP_LAYERS]),
  };
  return mapStateToPulseQuery(state, { citySlug: input.citySlug ?? null });
}

// ── §26 guarantee: no contradiction ────────────────────────────────────────────

/**
 * The intelligence axes a Pulse card may carry about its subject.
 *
 * `LivePulseItem` does not declare these fields today — the Pulse payload is
 * narrative. They are declared here as an OPTIONAL extension because the whole
 * point of §26 is that when Pulse does start stating "Very Busy · Getting
 * busier", it must be stating the same thing the map is. An absent axis means
 * "Pulse makes no claim on this axis", which cannot contradict anything.
 */
export type PulseIntelItem = LivePulseItem & {
  activity?: ActivityLevel | null;
  trend?: TrendState | null;
  confidence?: ConfidenceState | null;
  freshness?: FreshnessState | null;
};

export type IntelAxis = 'activity' | 'trend' | 'confidence' | 'freshness';

export interface IntelDivergence {
  axis: IntelAxis | 'subject';
  pulse: string | null;
  map: string | null;
}

export class MapPulseContradictionError extends Error {
  readonly subjectId: string;
  readonly divergences: IntelDivergence[];

  constructor(subjectId: string, divergences: IntelDivergence[]) {
    const detail = divergences
      .map((d) => `${d.axis}: pulse=${d.pulse ?? '∅'} map=${d.map ?? '∅'}`)
      .join('; ');
    super(
      `Map contradicts Pulse for subject "${subjectId}" — ${detail}. ` +
        'Spec §26: Pulse and Map must be two presentations of the SAME underlying ' +
        'intelligence; a divergence here means one of the two surfaces is deriving ' +
        'state locally instead of rendering the projection.',
    );
    this.name = 'MapPulseContradictionError';
    this.subjectId = subjectId;
    this.divergences = divergences;
  }
}

/**
 * Compare the two surfaces' claims about one subject WITHOUT throwing.
 *
 * Returns every axis on which the two disagree. An axis where either side is
 * silent (null/undefined) is not a disagreement — only two *stated* and
 * different values are. A subject mismatch is reported as its own divergence,
 * because comparing two different entities is itself a §26 bug (it means the
 * deep link pointed at the wrong object) and would otherwise silently "pass".
 */
export function findContradictions(
  pulseItem: PulseIntelItem,
  mapObject: MapObject,
): IntelDivergence[] {
  const out: IntelDivergence[] = [];

  const pulseSubject = pulseItem.item_id ?? null;
  const mapSubject = entityIdOfMapObject(mapObject);
  if (pulseSubject !== mapSubject) {
    out.push({ axis: 'subject', pulse: pulseSubject, map: mapSubject });
    // Different subjects: the axis comparison below would be meaningless.
    return out;
  }

  const axes: Array<[IntelAxis, string | null | undefined, string | null | undefined]> = [
    ['activity', pulseItem.activity, mapObject.activity],
    ['trend', pulseItem.trend, mapObject.trend],
    ['confidence', pulseItem.confidence, mapObject.confidence],
    ['freshness', pulseItem.freshness, mapObject.freshness],
  ];

  for (const [axis, p, m] of axes) {
    if (p == null || m == null) continue; // silence is not contradiction
    if (p !== m) out.push({ axis, pulse: p, map: m });
  }

  return out;
}

/**
 * THE §26 GUARANTEE.
 *
 * Throws `MapPulseContradictionError` when the same subject carries different
 * activity / trend / confidence / freshness on Pulse and on the Map. Call it
 * wherever the two surfaces meet — most importantly on the deep-link handoff,
 * where a card the user just read becomes a marker they are about to read.
 *
 * It is deliberately loud. A quiet fallback ("prefer the map value") would
 * paper over exactly the class of bug §26 names: two implementations of the
 * same truth. There is nothing to reconcile at render time; there is a
 * projection to fix.
 */
export function assertNoContradiction(
  pulseItem: PulseIntelItem,
  mapObject: MapObject,
): void {
  const divergences = findContradictions(pulseItem, mapObject);
  if (divergences.length > 0) {
    throw new MapPulseContradictionError(pulseItem.item_id ?? '(unknown)', divergences);
  }
}

/**
 * Non-throwing variant for render paths that must not crash the map.
 *
 * Returns the divergences so the caller can report them (telemetry, dev
 * overlay) and drop the offending object rather than displaying two different
 * truths. Dropping is the fail-closed choice: spec §37, "do not let stale
 * claims remain visually live".
 */
export function reconcileOrDrop(
  pulseItem: PulseIntelItem,
  mapObject: MapObject,
): { ok: true; object: MapObject } | { ok: false; divergences: IntelDivergence[] } {
  const divergences = findContradictions(pulseItem, mapObject);
  return divergences.length === 0 ? { ok: true, object: mapObject } : { ok: false, divergences };
}

/**
 * Convenience for the Live Pulse card: the point the card should fly to.
 * Returns null when the object has no usable geometry, so the caller can
 * disable the deep-link affordance rather than flying somewhere arbitrary.
 */
export function cameraPointForObject(obj: MapObject): LatLng | null {
  return centroidOf(obj.geometry);
}
