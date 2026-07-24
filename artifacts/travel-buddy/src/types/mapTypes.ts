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
