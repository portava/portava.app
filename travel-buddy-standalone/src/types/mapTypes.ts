/**
 * mapTypes.ts — shared type definitions for the multi-entity map layer system.
 *
 * Each entity type has a visual config (colour + label) and maps to a
 * `MapEntity` envelope that normalises lat/lng + payload for clustering
 * and the unified preview card.
 */

// ── Entity type union ──────────────────────────────────────────────────────────

export type MapEntityType =
  | 'places'
  | 'travelers'
  | 'buddies'
  | 'events'
  | 'gems'
  | 'trips'
  | 'friends'
  | 'stamps';

/**
 * Payload for a passport-mode country pin in the map carousel.
 * One entity per visited country, positioned at the country centroid.
 */
export interface PassportCountryPayload {
  country: string;
  stampCount: number;
  /** Distinct cities visited in this country. */
  cities: string[];
}

/** Toggleable layers — excludes 'places' and 'travelers' (Discovery UI controls)
 * and 'stamps' (passport-only mode, not a user-togglable layer). */
export type ToggleableEntityType = Exclude<MapEntityType, 'places' | 'travelers' | 'stamps'>;

export const TOGGLEABLE_LAYERS: ToggleableEntityType[] = [
  'buddies',
  'events',
  'gems',
  'trips',
  'friends',
];

// ── Per-layer visual config ───────────────────────────────────────────────────

export interface MapLayerConfig {
  /** Hex accent colour used for markers, cluster bubbles, and filter pill. */
  color: string;
  /** Human-readable layer label shown in the filter sheet. */
  label: string;
}

export const MAP_LAYER_CONFIG: Record<MapEntityType, MapLayerConfig> = {
  places:   { color: '#F59E0B', label: 'Places' },
  travelers:{ color: '#0A3D4A', label: 'Travelers' },
  buddies:  { color: '#0D9488', label: 'Buddies' },
  events:   { color: '#F97316', label: 'Events' },
  gems:     { color: '#7C3AED', label: 'Hidden Gems' },
  trips:    { color: '#2563EB', label: 'Trips' },
  friends:  { color: '#16A34A', label: 'Friends' },
  stamps:   { color: '#DC2626', label: 'Passport Stamps' },
};

// ── Action capabilities ───────────────────────────────────────────────────────

/**
 * Actions a preview card can offer for this entity.
 * Phase 2A renders the actual buttons; Phase 1 only populates the field.
 */
export type MapActionCapability =
  | 'save'
  | 'share'
  | 'directions'
  | 'add_to_trip'
  | 'join'
  | 'follow'
  | 'book'
  | 'message'
  | 'report'
  | 'block';

/**
 * Viewer-relative permissions for an entity.
 * Used by Phase 2 action row to decide which buttons to show/disable.
 */
export interface MapEntityPermissions {
  canMessage: boolean;
  canFollow: boolean;
  canBlock: boolean;
  canReport: boolean;
}

// ── Normalised entity envelope ────────────────────────────────────────────────

/**
 * Common envelope for all mappable entities.
 * `payload` is the raw service object (BuddyProfile, EventListItem, etc.)
 * so the preview card can render entity-specific fields without a union type.
 */
export interface MapEntity<T = unknown> {
  id: string;
  type: MapEntityType;
  lat: number;
  lng: number;
  payload: T;
  /**
   * Actions this entity supports in the preview card action row.
   * Populated by entity producers (useMapEntities, buildPassportEntities, etc.).
   * Phase 2A renders the buttons; Phase 1 only populates this field.
   */
  actionCapabilities?: MapActionCapability[];
  /**
   * Expo Router href the "View →" CTA navigates to.
   * Populated by entity producers so preview cards don't need to reconstruct it.
   */
  detailRoute?: string;
  /**
   * Viewer permissions — determines which action buttons are enabled.
   * Optional; absence means the action row should derive defaults from the type.
   */
  permissions?: MapEntityPermissions;
}

// ── MapObject → MapEntity view (Map spec §18, §19) ────────────────────────────
//
// `MapObject` (src/types/mapObjects.ts) is the canonical contract the Map
// Intelligence Gateway produces. `MapEntity` predates it and is what the
// existing renderer chain — EntityMarkers, MapCarousel, MapEntityPreviewCard,
// MapEntityActionRow — consumes today.
//
// Rather than rewrite four components in the same change that introduces the
// contract, `MapEntity` becomes a VIEW over `MapObject`: one lossy-but-honest
// downcast, in one place. New surfaces read `MapObject` directly and get
// freshness, confidence, privacy class and rendering priority; old surfaces keep
// working unchanged. When the last consumer is migrated, this section and the
// `MapEntity` type go together.

import {
  centroidOf,
  type MapObject,
  type MapAction,
  type MapObjectKind,
} from './mapObjects.ts';

/**
 * Which legacy layer a contract kind belongs to. Total over `MapObjectKind` so
 * a kind added to the contract is a compile error here rather than a silent
 * fallback to the wrong layer.
 */
export const KIND_TO_ENTITY_TYPE: Record<MapObjectKind, MapEntityType> = {
  place: 'places',
  hidden_gem: 'gems',
  event: 'events',
  trip_stop: 'trips',
  crew_member: 'friends',
  buddy_zone: 'buddies',
  // Travelers are projected as aggregate social presence (spec §23), and the
  // legacy 'travelers' layer is where the renderer already draws them.
  social_zone: 'travelers',
  meeting_point: 'trips',
  // Zone-like and forecast kinds have no legacy layer of their own. They map to
  // 'places' only so the old renderer does not crash on them; the NEW zone
  // renderer reads MapObject directly and never goes through this view.
  activity_zone: 'places',
  crowd_flow: 'places',
  prediction: 'places',
  safety_notice: 'places',
  memory: 'places',
};

/** The legacy action slugs, keyed by contract action. Unmapped actions drop. */
const ACTION_TO_CAPABILITY: Partial<Record<MapAction, MapActionCapability>> = {
  save: 'save',
  share: 'share',
  navigate: 'directions',
  add_to_trip: 'add_to_trip',
  join: 'join',
  follow: 'follow',
  book: 'book',
  message: 'message',
  report: 'report',
  block: 'block',
};

/**
 * Downcast one `MapObject` to the legacy envelope. Returns null when the object
 * has no renderable centroid — the old envelope requires a single lat/lng, so a
 * geometry it cannot represent must be dropped here rather than rendered at
 * coordinates nobody chose.
 *
 * The full object is kept on `payload`, so a migrated component can recover
 * everything this view drops (freshness, confidence, privacyClass, provenance,
 * renderingPriority) without a second fetch.
 */
export function mapObjectToEntity(obj: MapObject): MapEntity<MapObject> | null {
  const c = centroidOf(obj.geometry);
  if (!c) return null;

  const capabilities = (obj.interaction?.actions ?? [])
    .map((a) => ACTION_TO_CAPABILITY[a])
    .filter((a): a is MapActionCapability => a != null);

  return {
    id: obj.id,
    type: KIND_TO_ENTITY_TYPE[obj.kind],
    lat: c.lat,
    lng: c.lng,
    payload: obj,
    actionCapabilities: capabilities.length > 0 ? capabilities : undefined,
    detailRoute: obj.interaction?.detailRoute,
  };
}

/** Map a list, dropping anything without a renderable centroid. */
export function mapObjectsToEntities(objects: readonly MapObject[]): MapEntity<MapObject>[] {
  const out: MapEntity<MapObject>[] = [];
  for (const o of objects) {
    const e = mapObjectToEntity(o);
    if (e) out.push(e);
  }
  return out;
}
