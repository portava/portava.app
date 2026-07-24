/**
 * mapStore.ts — canonical map state for all map surfaces.
 *
 * Owns:
 *   selectedEntityId  — which entity marker / carousel card is active
 *   previewDetent     — bottom sheet height tier (Phase 2C controls the UI)
 *   cameraCenter      — last known camera lat/lng (captured before detail push)
 *   cameraZoom        — last known camera zoom
 *   enabledLayers     — which toggleable layers are visible
 *   carouselIndex     — current carousel scroll position
 *
 * All map surfaces (FullScreenMapScreen, entity layers, carousel) read/write
 * from here instead of scattering useState calls across the component tree.
 *
 * Pattern: Context + useReducer (matches AttachmentStore / AvailabilityStore).
 * No provider is needed at the app root — MapStoreProvider is rendered by
 * FullScreenMapScreen so the store is scoped to the map session.
 */
import React, { createContext, useContext, useReducer, useCallback, useMemo } from 'react';
import { TOGGLEABLE_LAYERS } from '../types/mapTypes.ts';
import type { ToggleableEntityType, MapActionCapability } from '../types/mapTypes.ts';

// ── State shape ───────────────────────────────────────────────────────────────

export type PreviewDetent = 'collapsed' | 'medium' | 'full';

export interface MapStoreState {
  selectedEntityId: string | null;
  previewDetent: PreviewDetent;
  cameraCenter: { lat: number; lng: number } | null;
  cameraZoom: number | null;
  enabledLayers: ToggleableEntityType[];
  carouselIndex: number;
  /**
   * Per-entity capability overrides written by MapEntityActionRow after a
   * mutating action (save, follow, join).  Keyed by `MapEntity.id`.
   * When present, the action row uses this instead of `entity.actionCapabilities`
   * so the updated state survives card unmount/remount (e.g. camera pan).
   */
  entityCapabilityPatches: Record<string, MapActionCapability[]>;
  /**
   * Per-entity follow state written by MapEntityActionRow after a successful
   * follow/unfollow toggle.  Keyed by `MapEntity.id`.
   * When present, useFollow uses this as the initial `isFollowing` value so
   * the icon is correct immediately on remount — before the getFollowStatus
   * round-trip completes.
   */
  entityFollowState: Record<string, boolean>;
}

const initialState: MapStoreState = {
  selectedEntityId: null,
  previewDetent: 'medium',
  cameraCenter: null,
  cameraZoom: null,
  enabledLayers: [...TOGGLEABLE_LAYERS],
  carouselIndex: 0,
  entityCapabilityPatches: {},
  entityFollowState: {},
};

// ── Actions ───────────────────────────────────────────────────────────────────

type Action =
  | { type: 'SET_SELECTED_ENTITY_ID'; payload: string | null }
  | { type: 'SET_PREVIEW_DETENT'; payload: PreviewDetent }
  | { type: 'SET_CAMERA_CENTER'; payload: { lat: number; lng: number } | null }
  | { type: 'SET_CAMERA_ZOOM'; payload: number | null }
  | { type: 'SET_ENABLED_LAYERS'; payload: ToggleableEntityType[] }
  | { type: 'SET_CAROUSEL_INDEX'; payload: number }
  | { type: 'UPDATE_ENTITY_CAPABILITIES'; payload: { entityId: string; caps: MapActionCapability[] } }
  | { type: 'SET_ENTITY_FOLLOW_STATE'; payload: { entityId: string; isFollowing: boolean } };

function reducer(state: MapStoreState, action: Action): MapStoreState {
  switch (action.type) {
    case 'SET_SELECTED_ENTITY_ID':
      // Identity bailout: same value → same state reference → React skips re-render.
      return state.selectedEntityId === action.payload
        ? state
        : { ...state, selectedEntityId: action.payload };
    case 'SET_PREVIEW_DETENT':
      return state.previewDetent === action.payload
        ? state
        : { ...state, previewDetent: action.payload };
    case 'SET_CAMERA_CENTER':
      // Objects: shallow-compare lat/lng so stable coords don't thrash children.
      if (action.payload === null && state.cameraCenter === null) return state;
      if (
        action.payload !== null &&
        state.cameraCenter !== null &&
        state.cameraCenter.lat === action.payload.lat &&
        state.cameraCenter.lng === action.payload.lng
      ) return state;
      return { ...state, cameraCenter: action.payload };
    case 'SET_CAMERA_ZOOM':
      return state.cameraZoom === action.payload
        ? state
        : { ...state, cameraZoom: action.payload };
    case 'SET_ENABLED_LAYERS':
      // Array: compare by length + each element (layers are short string lists).
      if (
        state.enabledLayers.length === action.payload.length &&
        state.enabledLayers.every((l, i) => l === action.payload[i])
      ) return state;
      return { ...state, enabledLayers: action.payload };
    case 'SET_CAROUSEL_INDEX':
      return state.carouselIndex === action.payload
        ? state
        : { ...state, carouselIndex: action.payload };
    case 'UPDATE_ENTITY_CAPABILITIES': {
      const { entityId, caps } = action.payload;
      const prev = state.entityCapabilityPatches[entityId];
      // Identity bailout: same length + same elements in order → no change.
      if (
        prev !== undefined &&
        prev.length === caps.length &&
        prev.every((c, i) => c === caps[i])
      ) return state;
      return {
        ...state,
        entityCapabilityPatches: { ...state.entityCapabilityPatches, [entityId]: caps },
      };
    }
    case 'SET_ENTITY_FOLLOW_STATE': {
      const { entityId, isFollowing } = action.payload;
      // Identity bailout: same value → no change.
      if (state.entityFollowState[entityId] === isFollowing) return state;
      return {
        ...state,
        entityFollowState: { ...state.entityFollowState, [entityId]: isFollowing },
      };
    }
    default:
      return state;
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface MapStoreContextValue extends MapStoreState {
  setSelectedEntityId: (id: string | null) => void;
  setPreviewDetent: (detent: PreviewDetent) => void;
  setCameraCenter: (center: { lat: number; lng: number } | null) => void;
  setCameraZoom: (zoom: number | null) => void;
  setEnabledLayers: (layers: ToggleableEntityType[]) => void;
  setCarouselIndex: (index: number) => void;
  /**
   * Patch the action capabilities for a single entity so the action row
   * reflects the post-mutation state on remount (e.g. after a camera pan).
   * Called by MapEntityActionRow after save / follow / join succeeds.
   */
  updateEntityCapabilities: (entityId: string, caps: MapActionCapability[]) => void;
  /**
   * Persist the follow state for a single entity so the follow icon is correct
   * immediately on remount — before the getFollowStatus round-trip completes.
   * Called by MapEntityActionRow after a successful follow/unfollow toggle.
   */
  setEntityFollowState: (entityId: string, isFollowing: boolean) => void;
}

const MapStoreContext = createContext<MapStoreContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function MapStoreProvider({
  children,
  initialEnabledLayers,
}: {
  children: React.ReactNode;
  /** Override the default enabled layers (e.g. circle mode pre-selects friends). */
  initialEnabledLayers?: ToggleableEntityType[];
}) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    enabledLayers: initialEnabledLayers ?? [...TOGGLEABLE_LAYERS],
  });

  const setSelectedEntityId = useCallback(
    (id: string | null) => dispatch({ type: 'SET_SELECTED_ENTITY_ID', payload: id }),
    [],
  );
  const setPreviewDetent = useCallback(
    (detent: PreviewDetent) => dispatch({ type: 'SET_PREVIEW_DETENT', payload: detent }),
    [],
  );
  const setCameraCenter = useCallback(
    (center: { lat: number; lng: number } | null) =>
      dispatch({ type: 'SET_CAMERA_CENTER', payload: center }),
    [],
  );
  const setCameraZoom = useCallback(
    (zoom: number | null) => dispatch({ type: 'SET_CAMERA_ZOOM', payload: zoom }),
    [],
  );
  const setEnabledLayers = useCallback(
    (layers: ToggleableEntityType[]) =>
      dispatch({ type: 'SET_ENABLED_LAYERS', payload: layers }),
    [],
  );
  const setCarouselIndex = useCallback(
    (index: number) => dispatch({ type: 'SET_CAROUSEL_INDEX', payload: index }),
    [],
  );
  const updateEntityCapabilities = useCallback(
    (entityId: string, caps: MapActionCapability[]) =>
      dispatch({ type: 'UPDATE_ENTITY_CAPABILITIES', payload: { entityId, caps } }),
    [],
  );
  const setEntityFollowState = useCallback(
    (entityId: string, isFollowing: boolean) =>
      dispatch({ type: 'SET_ENTITY_FOLLOW_STATE', payload: { entityId, isFollowing } }),
    [],
  );

  const value = useMemo(
    (): MapStoreContextValue => ({
      ...state,
      setSelectedEntityId,
      setPreviewDetent,
      setCameraCenter,
      setCameraZoom,
      setEnabledLayers,
      setCarouselIndex,
      updateEntityCapabilities,
      setEntityFollowState,
    }),
    [
      state,
      setSelectedEntityId,
      setPreviewDetent,
      setCameraCenter,
      setCameraZoom,
      setEnabledLayers,
      setCarouselIndex,
      updateEntityCapabilities,
      setEntityFollowState,
    ],
  );

  return <MapStoreContext.Provider value={value}>{children}</MapStoreContext.Provider>;
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

export function useMapStore(): MapStoreContextValue {
  const ctx = useContext(MapStoreContext);
  if (!ctx) {
    throw new Error('useMapStore must be called inside a <MapStoreProvider>');
  }
  return ctx;
}

/**
 * Like `useMapStore` but returns `null` when called outside a
 * `<MapStoreProvider>`.  Use in components that may be rendered both inside
 * and outside the map session (e.g. MapEntityActionRow in tests or in a
 * non-map context) so they degrade gracefully instead of crashing.
 */
export function useOptionalMapStore(): MapStoreContextValue | null {
  return useContext(MapStoreContext);
}
