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
import type { MapObjectKind } from '../types/mapObjects.ts';
import {
  createInitialMapMachineState,
  mapMachineReducer,
  withCapabilities,
  DEFAULT_MAP_CAPABILITIES,
  type MapCapabilities,
  type MapMachineEvent,
  type MapMachineState,
} from '../features/map/state/mapMachine.ts';
import { activeIntent, type TemporaryIntent } from '../features/map/intent/intentModel.ts';
import { NOW_OFFSET, type TimeOffset } from '../features/map/time/timeMachine.ts';

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
  /**
   * The §30 state machine — mode, overlays, camera, selection, navigation.
   * Nested as its OWN slice so every identity bailout above stays untouched and
   * the machine's bailouts compose: when mapMachineReducer returns the same
   * reference, this reducer returns `state` unchanged too.
   */
  machine: MapMachineState;
  /**
   * §13 temporary intent. TEMPORARY is the whole point: it carries a TTL and is
   * never merged into stored user preferences. Read it through `activeIntent`
   * (the `intent` field below is already gated) so an expired intent can never
   * reach ranking.
   */
  intent: TemporaryIntent | null;
  /** §15 Time Machine offset. NOW unless the user scrubbed. */
  timeOffset: TimeOffset;
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
  machine: createInitialMapMachineState(),
  intent: null,
  timeOffset: NOW_OFFSET,
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
  | { type: 'SET_ENTITY_FOLLOW_STATE'; payload: { entityId: string; isFollowing: boolean } }
  // ONE action forwards to the machine. Adding a second entry point is how a
  // state machine stops being one.
  | { type: 'MAP_EVENT'; payload: MapMachineEvent }
  | { type: 'SET_MAP_CAPABILITIES'; payload: MapCapabilities }
  | { type: 'SET_INTENT'; payload: TemporaryIntent | null }
  | { type: 'SET_TIME_OFFSET'; payload: TimeOffset };

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
    case 'MAP_EVENT': {
      const next = mapMachineReducer(state.machine, action.payload);
      // The machine already bails out on no-ops; propagate that upward so a
      // pan that changes nothing does not re-render the whole map.
      return next === state.machine ? state : { ...state, machine: next };
    }
    case 'SET_MAP_CAPABILITIES': {
      const next = withCapabilities(state.machine, action.payload);
      return next === state.machine ? state : { ...state, machine: next };
    }
    case 'SET_INTENT':
      return state.intent === action.payload ? state : { ...state, intent: action.payload };
    case 'SET_TIME_OFFSET':
      return state.timeOffset === action.payload
        ? state
        : { ...state, timeOffset: action.payload };
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

  // ── §30 state machine ──────────────────────────────────────────────────────
  /** Dispatch a machine event. The ONLY way mode/camera/selection change. */
  dispatchMapEvent: (event: MapMachineEvent) => void;
  /** Feature flags gating the surfaces that are not built yet. Fails closed. */
  setMapCapabilities: (capabilities: MapCapabilities) => void;

  // ── §13 intent ─────────────────────────────────────────────────────────────
  /**
   * Set the temporary intent. Persisting it is the CALLER's job, and it must
   * use its own storage key — never the user's preference record (§13).
   */
  setIntent: (intent: TemporaryIntent | null) => void;
  clearIntent: () => void;

  // ── §15 time machine ───────────────────────────────────────────────────────
  setTimeOffset: (offset: TimeOffset) => void;
}

const MapStoreContext = createContext<MapStoreContextValue | null>(null);

// ── Provider ──────────────────────────────────────────────────────────────────

export function MapStoreProvider({
  children,
  initialEnabledLayers,
  capabilities,
}: {
  children: React.ReactNode;
  /** Override the default enabled layers (e.g. circle mode pre-selects friends). */
  initialEnabledLayers?: ToggleableEntityType[];
  /**
   * Which §30 surfaces are built/flagged on. Omitted means
   * DEFAULT_MAP_CAPABILITIES, which fails CLOSED — an unbuilt surface cannot be
   * routed into.
   */
  capabilities?: MapCapabilities;
}) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    enabledLayers: initialEnabledLayers ?? [...TOGGLEABLE_LAYERS],
    machine: createInitialMapMachineState(capabilities ?? DEFAULT_MAP_CAPABILITIES),
  });

  /**
   * Selection has ONE writer: the machine. `selectedEntityId` below is derived
   * from `machine.selection`, so this adapter dispatches a machine event rather
   * than writing a second copy of the same fact — two writers for one fact is
   * how a selection and a camera end up disagreeing.
   *
   * `kind` defaults to 'place', which the machine maps to FOCUS_PLACE — the
   * behaviour every existing caller already expected.
   */
  const setSelectedEntityId = useCallback(
    (id: string | null, kind: MapObjectKind = 'place') =>
      dispatch(
        id === null
          ? { type: 'MAP_EVENT', payload: { type: 'CLEAR_SELECTION' } }
          : { type: 'MAP_EVENT', payload: { type: 'SELECT_OBJECT', objectId: id, objectKind: kind } },
      ),
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
  const dispatchMapEvent = useCallback(
    (event: MapMachineEvent) => dispatch({ type: 'MAP_EVENT', payload: event }),
    [],
  );
  const setMapCapabilities = useCallback(
    (capabilities: MapCapabilities) =>
      dispatch({ type: 'SET_MAP_CAPABILITIES', payload: capabilities }),
    [],
  );
  const setIntent = useCallback(
    (intent: TemporaryIntent | null) => dispatch({ type: 'SET_INTENT', payload: intent }),
    [],
  );
  const clearIntent = useCallback(() => dispatch({ type: 'SET_INTENT', payload: null }), []);
  const setTimeOffset = useCallback(
    (offset: TimeOffset) => dispatch({ type: 'SET_TIME_OFFSET', payload: offset }),
    [],
  );

  const value = useMemo(
    (): MapStoreContextValue => ({
      ...state,
      // Derived, not stored: the machine owns selection.
      selectedEntityId: state.machine.selection?.objectId ?? null,
      // Gated on read, so an expired intent is indistinguishable from none.
      intent: activeIntent(state.intent),
      setSelectedEntityId,
      setPreviewDetent,
      setCameraCenter,
      setCameraZoom,
      setEnabledLayers,
      setCarouselIndex,
      updateEntityCapabilities,
      setEntityFollowState,
      dispatchMapEvent,
      setMapCapabilities,
      setIntent,
      clearIntent,
      setTimeOffset,
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
      dispatchMapEvent,
      setMapCapabilities,
      setIntent,
      clearIntent,
      setTimeOffset,
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
