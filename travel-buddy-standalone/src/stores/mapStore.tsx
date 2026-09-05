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
  MAP_CAPABILITY_KEYS,
  type MapCapabilities,
  type MapMachineEvent,
  type MapMachineState,
} from '../features/map/state/mapMachine.ts';
import { activeIntent, type TemporaryIntent } from '../features/map/intent/intentModel.ts';
import { NOW_OFFSET, type TimeOffset } from '../features/map/time/timeMachine.ts';
import { DEFAULT_HOME_FILTER, type HomeFilterId } from '../features/map/home/homeFilters.ts';

// ── §30 capabilities: what the shell can honestly open ────────────────────────

/**
 * The facts a map session can observe about itself, from which the §30
 * capability record is DERIVED rather than declared.
 *
 * `DEFAULT_MAP_CAPABILITIES` is a fail-closed placeholder, not a feature flag:
 * there is no flag table, env var or admin toggle behind it, and nothing in the
 * app called `setMapCapabilities`, so CROWD_FLOW / LOCATE_FRIENDS / TIME_MACHINE
 * were permanently unreachable. This function is what makes them answerable —
 * and it answers from evidence the caller can actually see, so a surface opens
 * exactly when there is something behind it and closes again when there is not.
 *
 * Pure: no React, no I/O, no clock. The screen gathers the inputs; the rule
 * lives here so it can be reasoned about without rendering a map.
 */
export interface MapCapabilityInputs {
  /**
   * §10 — how many `crowd_flow` objects actually reached the client for this
   * viewport. Presence is the honest test: the server only serves flows when
   * `map_crowd_flow_enabled` is on AND the cohort/privacy gates pass, so a
   * non-zero count means there is genuinely aggregate movement to render.
   * Zero means Crowd Flow mode would open onto an empty layer.
   */
  crowdFlowObjectCount: number;
  /** §12 — the server's `locate_friends_enabled` flag. Fail-closed when unknown. */
  locateFriendsFlagEnabled: boolean;
  /**
   * §12 — the group scope a session could be started for. Locate My Friends is
   * "group-scoped" by definition, so without a scope there is no session to
   * start and the mode has no subject. The shell can only name a trip today.
   */
  locateFriendsScopeId: string | null;
  /**
   * §12 — the viewer's own id. `LocateFriendsPanel` needs a `viewerMemberId`,
   * so a signed-out viewer cannot be a member of the group they would open.
   */
  viewerId: string | null;
  /**
   * §15 — whether the temporal producer answered `enabled` for this session.
   *
   * Time Machine USED to be held permanently closed: nothing produced per-offset
   * state, so `toTemporalObjects` could only RELABEL the NOW map and every offset
   * would have rendered today's map wearing a forecast badge (§37: "Do not make
   * predictions look like observations"). GET /api/map/projection/temporal is now
   * that producer, so the gate becomes a presence check like CROWD_FLOW's — with
   * ONE deliberate difference: reachability turns on the PRODUCER existing, not on
   * any offset being populated. §15's mode is meaningful even for an empty offset,
   * because it shows an honest empty state ("no history yet" / no forecast here)
   * rather than an empty layer. The temporal endpoint rides the gateway flag
   * (map_projection_enabled), so `false` here means the source is unreachable and
   * the mode stays shut — never open onto a source that cannot answer.
   */
  timeMachineProducerEnabled: boolean;
}

export function deriveMapCapabilities(inputs: MapCapabilityInputs): MapCapabilities {
  return {
    // §14 — the Compass pick pipeline and the Ask Compass bar both exist on
    // this screen; unchanged.
    COMPASS: true,
    // §11 — trip objects project and Optimize Today proposes; unchanged.
    TRIP: true,
    CROWD_FLOW: inputs.crowdFlowObjectCount > 0,
    LOCATE_FRIENDS:
      inputs.locateFriendsFlagEnabled &&
      inputs.locateFriendsScopeId != null &&
      inputs.viewerId != null,
    // §15 — open when the per-offset producer is reachable. Unlike CROWD_FLOW,
    // this is NOT gated on data presence: an offset with nothing to show is a
    // legitimate, honestly-empty temporal state, not a reason to close the mode.
    TIME_MACHINE: inputs.timeMachineProducerEnabled,
  };
}

/** Do two capability records say the same thing about every known surface? */
export function sameMapCapabilities(
  a: MapCapabilities | null | undefined,
  b: MapCapabilities | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  return MAP_CAPABILITY_KEYS.every((key) => a[key] === b[key]);
}

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
  /**
   * §3's filter chip. Deliberately NOT persisted: a chip is "what am I looking
   * for right now", while §16's layers are the durable preference. Persisting
   * it would quietly turn a transient lens into a setting.
   */
  homeFilter: HomeFilterId;
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
  homeFilter: DEFAULT_HOME_FILTER,
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
  | { type: 'SET_TIME_OFFSET'; payload: TimeOffset }
  | { type: 'SET_HOME_FILTER'; payload: HomeFilterId };

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
      // Identity bailout, like every other action here — but load-bearing
      // rather than a nicety. `withCapabilities` always allocates a new state,
      // so without this an effect that re-derives capabilities on render would
      // re-render forever. The value is what matters, not the object.
      if (sameMapCapabilities(state.machine.capabilities, action.payload)) return state;
      const next = withCapabilities(state.machine, action.payload);
      return next === state.machine ? state : { ...state, machine: next };
    }
    case 'SET_INTENT':
      return state.intent === action.payload ? state : { ...state, intent: action.payload };
    case 'SET_TIME_OFFSET':
      return state.timeOffset === action.payload
        ? state
        : { ...state, timeOffset: action.payload };
    case 'SET_HOME_FILTER':
      return state.homeFilter === action.payload
        ? state
        : { ...state, homeFilter: action.payload };
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

  // ── §3 filter chips ────────────────────────────────────────────────────────
  setHomeFilter: (filter: HomeFilterId) => void;
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
  const setHomeFilter = useCallback(
    (filter: HomeFilterId) => dispatch({ type: 'SET_HOME_FILTER', payload: filter }),
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
      setHomeFilter,
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
      setHomeFilter,
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
