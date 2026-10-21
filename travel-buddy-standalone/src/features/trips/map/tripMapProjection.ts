/**
 * §14.1 — the client for `GET /trips/:tripId/map-projection`.
 *
 * WHY A CLIENT AND NOT A DIRECT FETCH IN A COMPONENT
 * ==================================================
 * Because there are three rules a component would get wrong, and each of them
 * is the difference between drawing a trip and drawing a claim about a trip:
 *
 *   1. A layer is NEVER an array. `{status:'unread'}` and `{status:'ok',
 *      items:[]}` are opposite facts, and the second is the one a map is
 *      allowed to render as an absence. `layerPoints` returns [] for both and
 *      is deliberately NOT the only accessor — `layerIsUnread` exists so a
 *      caller that draws must ask.
 *   2. A private anchor is in its own layer for a reason (§14.4). `allPoints`
 *      exists and EXCLUDES it, so the convenient thing to call is also the
 *      safe thing; a caller that genuinely wants anchors has to name them.
 *   3. `sourceTripVersion: null` means the projection is unattributable — it
 *      must not be cached, compared, or used to decide nothing has changed.
 *      `isAttributable` says so rather than leaving a null to be `?? 0`'d.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import { acceptProjection, type TripProjectionEnvelope } from '../../../services/tripProjectionEnvelope.ts';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

export const LAYER_STATUSES = ['ok', 'unread', 'no_source'] as const;
export type LayerStatus = (typeof LAYER_STATUSES)[number];

export type Layer<T> =
  | { status: 'ok'; items: T[] }
  /** The read FAILED. A retry may work. Never render as an empty layer. */
  | { status: 'unread'; reason: string }
  /** Nothing produces this layer. A retry will not help. */
  | { status: 'no_source'; reason: string };

export interface MapPoint {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  label: string | null;
  /** Present only on points in the privateAnchors layer. */
  privateAnchor?: true;
  meta?: Record<string, unknown>;
}

/** §14.1's ten layers, in the spec's own order. */
export const PROJECTION_LAYERS = [
  'stage', 'privateAnchors', 'activePlans', 'confirmedCommitments',
  'savedIdeas', 'crewPresenceSummaries', 'routeChains', 'meetupPoints',
  'liveOpportunities', 'safetyPoints',
] as const;
export type ProjectionLayer = (typeof PROJECTION_LAYERS)[number];

export type TripMapProjection = TripProjectionEnvelope & {
  tripId: string;
  census: { ok: number; unread: number; noSource: number; totalPoints: number };
  activePlanReading: string;
} & Record<ProjectionLayer, Layer<MapPoint>>;

export type ProjectionRead =
  | { state: 'ok'; projection: TripMapProjection }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string };

export async function fetchTripMapProjection(tripId: string): Promise<ProjectionRead> {
  if (!isSupabaseConfigured || !apiBase()) return { state: 'off' };
  const token = await freshToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/map-projection`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null) as { error?: string } | null;
      if (res.status === 404 && err?.error === 'feature_disabled') return { state: 'off' };
      return { state: 'unavailable', detail: `HTTP ${res.status}` };
    }
    const body = await res.json().catch(() => null) as TripMapProjection | null;
    // A body missing any of the ten layers is not a partial projection — it is
    // one this client cannot interpret, and drawing eight layers from it while
    // believing it drew ten is the failure the envelope exists to prevent.
    if (!body || PROJECTION_LAYERS.some((k) => !body[k] || typeof body[k].status !== 'string')) {
      return { state: 'unavailable', detail: 'unreadable response' };
    }
    // §19.1: the envelope decides before the layers are read. A schema this
    // client does not read, or a projection that says it is stale, is refused
    // by name — never drawn.
    const decision = acceptProjection(body);
    if (!decision.accepted) return { state: 'unavailable', detail: decision.reason };
    return { state: 'ok', projection: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/** The points in a layer, or [] when there are none OR it could not be read.
 *  Pair with `layerIsUnread` before drawing an absence. */
export function layerPoints(layer: Layer<MapPoint>): MapPoint[] {
  return layer.status === 'ok' ? layer.items : [];
}

/** Did this layer FAIL to load? The question a renderer must ask before
 *  drawing an empty layer as "there is nothing here". */
export function layerIsUnread(layer: Layer<MapPoint>): boolean {
  return layer.status === 'unread';
}

/**
 * Every point EXCEPT the private anchors.
 *
 * The convenient accessor is the safe one on purpose. §14.4 says sensitive
 * anchors must never enter a broad projection, and a caller that merges layers
 * by iterating them all would undo the separation the server built. A caller
 * that genuinely wants anchors reads `projection.privateAnchors` by name.
 */
export function allPoints(p: TripMapProjection): MapPoint[] {
  return PROJECTION_LAYERS
    .filter((k) => k !== 'privateAnchors')
    .flatMap((k) => layerPoints(p[k]));
}

/** Which layers failed to load. Non-empty means the map is showing less than
 *  the trip has, and the user has to be told. */
export function unreadLayers(p: TripMapProjection): ProjectionLayer[] {
  return PROJECTION_LAYERS.filter((k) => layerIsUnread(p[k]));
}

/**
 * May this projection be cached, compared, or used to conclude nothing has
 * changed? Only when it names the trip version it was built from.
 */
export function isAttributable(p: TripMapProjection): boolean {
  return typeof p.sourceTripVersion === 'number';
}

/** Layer keys in words, for a message naming what is missing. */
export const LAYER_LABEL: Record<ProjectionLayer, string> = {
  stage: 'stages',
  privateAnchors: 'private locations',
  activePlans: 'plans',
  confirmedCommitments: 'commitments',
  savedIdeas: 'saved places',
  crewPresenceSummaries: 'crew presence',
  routeChains: 'routes',
  meetupPoints: 'meeting points',
  liveOpportunities: 'opportunities',
  safetyPoints: 'safety points',
};

// ── §14.1 stage: what the layer did NOT draw, and what it drew coarsely (census-trips wave-5 follow-up) ──
//
// A stage anchored to a CITY is drawn at that city's centre (`meta.precision:
// 'city_centre'`), never at an invented spot; one whose anchor has no position
// is not drawn at all, and the server lists it in `stagesNotDrawn` so the
// legend can say so. Both are read here rather than in the card, for the same
// reason as the three rules above: an absent field is not an empty list.

export interface StageNotDrawn {
  id: string;
  stageType: string | null;
  sequence: number | null;
  /** 'place_has_no_position' | 'city_has_no_position' | 'anchor_is_not_a_city' | 'no_anchor', or a newer reason passed through. */
  reason: string;
}

/**
 * The stages the server says are NOT on the map, or null when this projection
 * does not say (a server from before the field). Null is not "none": a caller
 * must not tell the user every stage is drawn on the strength of it.
 */
export function stagesNotDrawn(p: TripMapProjection): StageNotDrawn[] | null {
  const raw = (p as { stagesNotDrawn?: unknown }).stagesNotDrawn;
  if (!Array.isArray(raw)) return null;
  return raw.filter((s): s is StageNotDrawn => !!s && typeof s === 'object'
    && typeof (s as StageNotDrawn).id === 'string' && typeof (s as StageNotDrawn).reason === 'string');
}

/** Stage points drawn at their CITY's centre — a coarse position, not an exact spot. */
export function coarseStagePoints(p: TripMapProjection): MapPoint[] {
  return layerPoints(p.stage).filter((pt) => pt.meta?.precision === 'city_centre');
}
