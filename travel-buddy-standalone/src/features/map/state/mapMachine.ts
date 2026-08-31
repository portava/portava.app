/**
 * mapMachine — the Map Shell state machine (Map spec §30).
 *
 * WHAT THIS IS
 * ============
 * Spec §2 is the load-bearing sentence:
 *
 *     "The map should be implemented as one persistent Map Shell with nine
 *      primary experiences. These are not nine unrelated tabs; they are
 *      coordinated states of one geographic system."
 *
 * This module is that coordination, expressed as a pure reducer over three
 * orthogonal axes named by §30:
 *
 *   1. MODE     — which of the primary experiences the shell is in.
 *   2. OVERLAY  — a sheet opened OVER a mode (Intent, Layers, Filters, Search).
 *                 Closing an overlay returns to the very same mode.
 *   3. CAMERA   — what the camera is framing, and whether the user has taken
 *                 manual control of it.
 *
 * Mode and camera are COUPLED, and that coupling is the reason this file
 * exists: without it every surface reinvents "what should the camera do when
 * I open Trip mode?" and they all answer differently. The coupling is encoded
 * as data (`MODE_CAMERA`, `OBJECT_KIND_CAMERA`, `MODE_LAYER_POLICY`) rather
 * than as branches, so it can be read, diffed and exhaustively tested.
 *
 * WHAT THIS IS NOT
 * ================
 * No React, no I/O, no map SDK. It holds no map objects, performs no fetching
 * and decides no privacy — spec §19: "The mobile client should not
 * independently reconstruct Portava intelligence rules." It is only the
 * *navigational* state of the shell.
 *
 * It also deliberately does NOT own concerns the existing `src/stores/mapStore`
 * already owns (`previewDetent`, `cameraCenter`, `cameraZoom`, `enabledLayers`,
 * `carouselIndex`, per-entity capability patches). The one overlap is
 * `selection`, because selection is a MODE transition (§30 lists
 * PLACE_SELECTED as a primary mode) and cannot be modelled outside the
 * machine. See "FOLDING INTO mapStore" at the bottom of this file.
 *
 * DESIGN DECISIONS (each one is load-bearing and tested)
 * ======================================================
 *
 * D1. AT MOST ONE OVERLAY IS OPEN.
 *     Overlays are modelled as a set (`overlays`) because §30 names them as a
 *     group orthogonal to mode — but the reducer enforces cardinality <= 1:
 *     opening one closes the others. A sheet stack is not a spec surface, and
 *     §32 gives a single sheet three snap points, not three stacked sheets.
 *     The set representation is kept so BACK, "is anything open?" and future
 *     non-modal overlays stay expressible without a shape change.
 *
 * D2. AN OVERLAY NEVER CHANGES THE MODE OR THE CAMERA.
 *     Opening Layers over Trip mode and closing it again must leave you in
 *     Trip mode looking at the same thing. This is the whole point of calling
 *     them orthogonal.
 *
 * D3. SELECTING AN OBJECT INSIDE A SECONDARY MODE DOES NOT LEAVE THAT MODE.
 *     Tapping a stop while in TRIP mode must not silently drop you out of the
 *     trip (§2 again — coordinated states, not tabs). So SELECT_OBJECT
 *     promotes LIVE -> PLACE_SELECTED, but from TRIP / CROWD_FLOW /
 *     LOCATE_FRIENDS / COMPASS / TIME_MACHINE it only sets the selection and
 *     focuses the camera. BACK then unwinds in that order: selection first,
 *     mode second.
 *
 * D4. A USER PAN IS SACRED.
 *     USER_PANNED drops the camera to FREE_EXPLORE and changes NOTHING else —
 *     not the mode, not the selection, not the overlay. Once in FREE_EXPLORE
 *     the camera is only reclaimed by an event that expresses camera intent
 *     (RECENTER, SELECT_OBJECT, FOCUS_OBJECT, START_NAVIGATION) or by a mode
 *     change (ENTER_MODE / EXIT_MODE / BACK's exit rung). Incidental events —
 *     CLEAR_SELECTION and END_NAVIGATION — leave FREE_EXPLORE alone rather
 *     than yanking the viewport back under the user's thumb.
 *
 * D5. GATING FAILS CLOSED.
 *     CROWD_FLOW, LOCATE_FRIENDS and TIME_MACHINE are spec surfaces that are
 *     not built yet. `canEnterMode` requires the capability flag to be
 *     literally `true`; missing, undefined, null or a truthy non-boolean all
 *     mean "no". An unknown mode string is also "no". The machine can
 *     therefore never route the shell into a dead surface.
 *
 * D6. LAYER POLICY IS A PROJECTION, NEVER A WRITE.
 *     §16 asks for "explicit layers plus automatic relevance". `visibleLayersFor`
 *     computes the EFFECTIVE layer set for a mode from the user's stored
 *     preferences without touching them, so a CROWD_FLOW round-trip returns
 *     the user's own toggles intact. Precedence:
 *         always-on  >  mode suppress  >  mode force  >  user preference
 *     `safety` is always-on because §5 says safety always takes visual
 *     precedence — no mode may suppress it.
 */

import { MAP_MODES, isMapMode, type MapMode } from '../vocabulary.ts';
import {
  ALWAYS_ON_LAYER_IDS,
  MAP_LAYER_IDS,
  isMapLayerId,
  type MapLayerId,
} from '../layers/layerModel.ts';
import { MAP_OBJECT_KINDS } from '../../../types/mapObjects.ts';
import type { MapObjectKind } from '../../../types/mapObjects.ts';
import { TOGGLEABLE_LAYERS } from '../../../types/mapTypes.ts';
import type { ToggleableEntityType } from '../../../types/mapTypes.ts';

// ── Modes (spec §30) ───────────────────────────────────────────────────────────

/**
 * The primary modes of the Map Shell. §2 lists nine experiences; two of them
 * are not modes: "Layers / Legend" is an overlay (see `MapOverlay`) and
 * "Intent Mode" is likewise a sheet opened over whatever mode you are in
 * (§13: "temporary context, not a permanent preference rewrite"). What is
 * left is exactly the seven §30 names.
 */
// Declared in features/map/vocabulary.ts, a leaf module, because
// features/map/layers/layerModel.ts keys its policies BY MODE while this module
// needs its LAYERS — importing each other directly would be a runtime cycle.
// Re-exported here so `MapMode` still reads as part of the machine's API.
export { MAP_MODES, isMapMode, type MapMode };

/** LIVE is the home state — §3: "This is the default map state." */
export const HOME_MODE: MapMode = 'LIVE';

/**
 * Modes that BACK collapses straight to LIVE. PLACE_SELECTED is excluded
 * because it unwinds through its selection first (D3).
 */
export const SECONDARY_MODES: readonly MapMode[] = [
  'COMPASS',
  'TRIP',
  'CROWD_FLOW',
  'LOCATE_FRIENDS',
  'TIME_MACHINE',
];

export function isSecondaryMode(mode: MapMode): boolean {
  return SECONDARY_MODES.includes(mode);
}

// ── Overlays (spec §30) ────────────────────────────────────────────────────────

/** Sheets that open OVER a mode. Orthogonal to mode by construction (D2). */
export const MAP_OVERLAYS = ['INTENT', 'LAYERS', 'FILTERS', 'SEARCH'] as const;
export type MapOverlay = (typeof MAP_OVERLAYS)[number];

export function isMapOverlay(value: unknown): value is MapOverlay {
  return typeof value === 'string' && (MAP_OVERLAYS as readonly string[]).includes(value);
}

// ── Camera (spec §30) ──────────────────────────────────────────────────────────

export const CAMERA_STATES = [
  'FOLLOW_USER',
  'FREE_EXPLORE',
  'FOCUS_PLACE',
  'FOCUS_AREA',
  'FOCUS_ROUTE',
  'FOCUS_TRIP',
  'FOCUS_GROUP',
  'COMPASS_RECOMMENDATIONS',
] as const;

export type CameraState = (typeof CAMERA_STATES)[number];

/**
 * THE MODE -> CAMERA COUPLING TABLE.
 *
 * Entering a mode always implies a camera framing. Encoded as data so it is
 * inspectable (and so a test can assert it is total over `MAP_MODES`).
 *
 *   LIVE            FOLLOW_USER              §3 "where the user is"
 *   PLACE_SELECTED  FOCUS_PLACE              §8 one place, right now
 *   COMPASS         COMPASS_RECOMMENDATIONS  §14 the 3-5 best next moves
 *   TRIP            FOCUS_TRIP               §11 itinerary + crew + routes
 *   CROWD_FLOW      FOCUS_AREA               §10 aggregate, never individual
 *   LOCATE_FRIENDS  FOCUS_GROUP              §12 group-scoped coordination
 *   TIME_MACHINE    FOCUS_AREA               §15 city/place state over time
 *
 * FOCUS_ROUTE is intentionally absent: no mode implies it. It is reached only
 * by START_NAVIGATION or by focusing a route-shaped object, because §5 makes
 * active navigation a cross-cutting precedence, not a mode.
 */
export const MODE_CAMERA: Record<MapMode, CameraState> = {
  LIVE: 'FOLLOW_USER',
  PLACE_SELECTED: 'FOCUS_PLACE',
  COMPASS: 'COMPASS_RECOMMENDATIONS',
  TRIP: 'FOCUS_TRIP',
  CROWD_FLOW: 'FOCUS_AREA',
  LOCATE_FRIENDS: 'FOCUS_GROUP',
  TIME_MACHINE: 'FOCUS_AREA',
};

/**
 * THE OBJECT-KIND -> CAMERA REFINEMENT TABLE.
 *
 * Selecting or focusing an object frames it. The spec's plain case is
 * "selecting an object implies FOCUS_PLACE", and that is the default; this
 * table only refines the kinds where framing a point would be a lie:
 *
 *   - zone-shaped kinds (activity_zone, social_zone, buddy_zone, crowd_flow,
 *     prediction) are aggregates, so they get FOCUS_AREA — framing them as a
 *     pin would imply a precision §23 never granted;
 *   - `crew_member` gets FOCUS_GROUP for the same reason: §23 says default
 *     public rendering aggregates social presence, so the camera frames the
 *     group context rather than zooming onto a person.
 */
export const OBJECT_KIND_CAMERA: Record<MapObjectKind, CameraState> = {
  place: 'FOCUS_PLACE',
  event: 'FOCUS_PLACE',
  hidden_gem: 'FOCUS_PLACE',
  trip_stop: 'FOCUS_PLACE',
  meeting_point: 'FOCUS_PLACE',
  memory: 'FOCUS_PLACE',
  safety_notice: 'FOCUS_PLACE',
  activity_zone: 'FOCUS_AREA',
  social_zone: 'FOCUS_AREA',
  buddy_zone: 'FOCUS_AREA',
  crowd_flow: 'FOCUS_AREA',
  prediction: 'FOCUS_AREA',
  crew_member: 'FOCUS_GROUP',
};

export function cameraForMode(mode: MapMode): CameraState {
  return MODE_CAMERA[mode] ?? 'FOLLOW_USER';
}

/** The camera framing implied by selecting/focusing an object of this kind. */
export function cameraForObjectKind(kind: MapObjectKind): CameraState {
  return OBJECT_KIND_CAMERA[kind] ?? 'FOCUS_PLACE';
}

function isMapObjectKind(value: unknown): value is MapObjectKind {
  return typeof value === 'string' && (MAP_OBJECT_KINDS as readonly string[]).includes(value);
}

// ── Capability gating (D5) ─────────────────────────────────────────────────────

export const MAP_CAPABILITY_KEYS = [
  'COMPASS',
  'TRIP',
  'CROWD_FLOW',
  'LOCATE_FRIENDS',
  'TIME_MACHINE',
] as const;

export type MapCapabilityKey = (typeof MAP_CAPABILITY_KEYS)[number];

/**
 * Which capability flag a mode requires, or `null` for modes that are always
 * available. LIVE and PLACE_SELECTED are ungated: the shell must always have
 * somewhere to be, and BACK must always have somewhere to land.
 */
export const MODE_CAPABILITY: Record<MapMode, MapCapabilityKey | null> = {
  LIVE: null,
  PLACE_SELECTED: null,
  COMPASS: 'COMPASS',
  TRIP: 'TRIP',
  CROWD_FLOW: 'CROWD_FLOW',
  LOCATE_FRIENDS: 'LOCATE_FRIENDS',
  TIME_MACHINE: 'TIME_MACHINE',
};

/**
 * A flag record, not a permission check. Missing keys mean "not available" —
 * `Partial` is deliberate so a caller cannot be forced to invent a value for a
 * surface it has never heard of.
 */
export type MapCapabilities = Partial<Record<MapCapabilityKey, boolean>>;

/**
 * Today's shipping reality (§36 phasing): Compass and Trip exist; Crowd Flow,
 * Locate My Friends and Time Machine are specified but unbuilt.
 */
export const DEFAULT_MAP_CAPABILITIES: MapCapabilities = {
  COMPASS: true,
  TRIP: true,
  CROWD_FLOW: false,
  LOCATE_FRIENDS: false,
  TIME_MACHINE: false,
};

/**
 * Fail-closed mode gate. Only a literal `true` opens a gated surface; an
 * unknown mode, an unknown/missing capability, `undefined`, `null` and truthy
 * non-booleans all deny.
 */
export function canEnterMode(mode: MapMode, capabilities: MapCapabilities | null | undefined): boolean {
  if (!isMapMode(mode)) return false;
  const key = MODE_CAPABILITY[mode];
  if (key === null) return true;
  if (capabilities == null || typeof capabilities !== 'object') return false;
  return capabilities[key] === true;
}

/** The subset of modes reachable right now — handy for rendering the mode rail. */
export function enterableModes(capabilities: MapCapabilities | null | undefined): MapMode[] {
  return MAP_MODES.filter((mode) => canEnterMode(mode, capabilities));
}

// ── Layers (spec §16) ──────────────────────────────────────────────────────────

/**
 * §16's core layers, plus `relevant_places` for individual place pins (§16's
 * defaults line names "Relevant Places" and §31's ladder names "Relevant
 * Place", so the pin layer needs a first-class id — it is the thing CROWD_FLOW
 * suppresses).
 *
 * NOTE FOR THE LEAD: `src/features/map/layers/layerModel.ts` (built in parallel)
 * declares the SAME vocabulary as `MAP_LAYER_IDS` — identical ids, including
 * `relevant_places`, which this list was aligned to. When the two land
 * together, delete this constant and `isMapLayerId` here and re-export
 * layerModel's; `MODE_LAYER_POLICY` below is the only part of the layer story
 * this file actually owns.
 */
// features/map/layers/layerModel.ts is the owner: it holds §16's core/extra
// split, the tri-state defaults and the legend. This module only needs the
// vocabulary to key MODE_LAYER_POLICY by, so it imports rather than restates —
// two lists of the same twelve ids is exactly how one of them silently loses a
// layer.
export { isMapLayerId, type MapLayerId };
export const MAP_LAYERS = MAP_LAYER_IDS;

/**
 * §16 suggested defaults: "Live Activity on, Events on, Relevant Places on,
 * Saved on; People/Trip/Crowd Flow contextual; Buddies and Memories off."
 * `safety` is not listed because it is not optional (see ALWAYS_ON_LAYERS).
 */
export const DEFAULT_ENABLED_LAYERS: readonly MapLayerId[] = ['live_activity', 'relevant_places', 'events', 'saved'];

/**
 * §5: "Safety and active navigation always take visual precedence over
 * popularity or activity." A mode may not suppress safety, and a user
 * preference may not switch it off.
 */
export const ALWAYS_ON_LAYERS: readonly MapLayerId[] = ALWAYS_ON_LAYER_IDS;

export interface ModeLayerPolicy {
  /** Shown in this mode even if the user has the layer toggled off. */
  readonly force: readonly MapLayerId[];
  /** Hidden in this mode even if the user has the layer toggled on. */
  readonly suppress: readonly MapLayerId[];
}

/**
 * §16's "automatic relevance", as data. `force` and `suppress` are disjoint
 * per mode (asserted by a test) so their relative precedence never actually
 * arbitrates anything — but it is defined anyway: suppress wins.
 *
 * Rationale per mode:
 *   LIVE / PLACE_SELECTED  the default world; force the two layers §3 needs to
 *                          answer "what is happening nearby".
 *   COMPASS                §14 "reduces visual noise and highlights
 *                          approximately three to five best next moves" — so
 *                          suppress the ambient/social noise layers.
 *   TRIP                   §11 trip objects are the subject; crowd flow and
 *                          memories are noise against an itinerary.
 *   CROWD_FLOW             §10 is aggregate movement and "must never expose
 *                          individual routes" — suppress every individual-pin
 *                          layer. Events stay on because §10 requires observed
 *                          movement and its inferred cause to be separately
 *                          represented, and events are the cause.
 *   LOCATE_FRIENDS         §12 is group coordination on a venue/event map:
 *                          force people, suppress discovery clutter (gems,
 *                          buddies, saved, memories, flow). Places and events
 *                          stay so the group has venue context.
 *   TIME_MACHINE           §15 is historical/predicted PLACE state. Presence
 *                          layers are suppressed outright: §23 forbids
 *                          replaying where individuals were.
 */
export const MODE_LAYER_POLICY: Record<MapMode, ModeLayerPolicy> = {
  LIVE: { force: ['live_activity', 'relevant_places'], suppress: [] },
  PLACE_SELECTED: { force: ['live_activity', 'relevant_places'], suppress: [] },
  COMPASS: { force: ['relevant_places'], suppress: ['crowd_flow', 'memories', 'buddies', 'people', 'transport'] },
  TRIP: { force: ['trip', 'relevant_places'], suppress: ['crowd_flow', 'memories', 'buddies'] },
  CROWD_FLOW: {
    force: ['crowd_flow', 'live_activity'],
    suppress: ['relevant_places', 'hidden_gems', 'saved', 'memories', 'buddies', 'people', 'trip'],
  },
  LOCATE_FRIENDS: {
    force: ['people'],
    suppress: ['hidden_gems', 'buddies', 'crowd_flow', 'memories', 'saved'],
  },
  TIME_MACHINE: { force: ['live_activity'], suppress: ['people', 'buddies', 'trip', 'memories'] },
};

/**
 * The EFFECTIVE layer set for a mode, given the user's stored preferences.
 *
 * Pure projection (D6): `enabled` is read and never written, so the user's
 * toggles survive any number of mode round-trips. Unknown ids in `enabled` are
 * dropped rather than passed through. The result is in canonical `MAP_LAYERS`
 * order so two equal sets always render in the same order.
 *
 * Precedence: always-on > mode suppress > mode force > user preference.
 */
export function visibleLayersFor(
  mode: MapMode,
  enabled: readonly MapLayerId[] | null | undefined,
): MapLayerId[] {
  const effective = new Set<MapLayerId>();

  const preferred: readonly unknown[] = Array.isArray(enabled) ? enabled : [];
  for (const layer of preferred) {
    if (isMapLayerId(layer)) effective.add(layer);
  }

  // An unknown mode gets the user's preferences plus the always-on floor —
  // never a blank map.
  const policy = MODE_LAYER_POLICY[mode];
  if (policy) {
    for (const layer of policy.force) effective.add(layer);
    for (const layer of policy.suppress) effective.delete(layer);
  }

  for (const layer of ALWAYS_ON_LAYERS) effective.add(layer);

  return MAP_LAYERS.filter((layer) => effective.has(layer));
}

/**
 * Bridge to the layer vocabulary the existing `src/stores/mapStore` already
 * persists (`ToggleableEntityType[]`). Lets the lead call the §16 policy from
 * the current store without migrating the stored preference shape first.
 *
 * `friends` maps to §16's "People" layer; `gems` to "Hidden Gems"; `trips` to
 * "Trip". Legacy has no id for live activity, saved, safety, transport,
 * memories or crowd flow, so layers forced on by a mode that have no legacy
 * counterpart simply do not appear in the legacy result — the legacy array can
 * only ever describe the five toggles it knows about.
 */
export const LEGACY_LAYER_TO_MAP_LAYER: Record<ToggleableEntityType, MapLayerId> = {
  buddies: 'buddies',
  events: 'events',
  gems: 'hidden_gems',
  trips: 'trip',
  friends: 'people',
};

/**
 * `visibleLayersFor` expressed over the store's current `enabledLayers` array.
 * Returns a new array in `TOGGLEABLE_LAYERS` order; never mutates the input.
 */
export function visibleLegacyLayersFor(
  mode: MapMode,
  enabled: readonly ToggleableEntityType[] | null | undefined,
): ToggleableEntityType[] {
  const list: readonly ToggleableEntityType[] = Array.isArray(enabled)
    ? (enabled as readonly ToggleableEntityType[])
    : [];
  const canonicalEnabled: MapLayerId[] = [];
  for (const legacy of list) {
    const canonical = LEGACY_LAYER_TO_MAP_LAYER[legacy];
    if (canonical) canonicalEnabled.push(canonical);
  }
  const visible = new Set(visibleLayersFor(mode, canonicalEnabled));
  return TOGGLEABLE_LAYERS.filter((legacy) => visible.has(LEGACY_LAYER_TO_MAP_LAYER[legacy]));
}

// ── Time Machine offset (spec §15) ─────────────────────────────────────────────

/**
 * Minutes relative to now. 0 is NOW; positive is forecast (§15's +30/+60/+120);
 * negative is historical (§15's "Yesterday", "Last Friday"). Bounded so a
 * fat-fingered scrubber cannot ask the projection for the year 1904.
 *
 * A non-finite or non-numeric offset is malformed rather than "very far away",
 * so it falls back to NOW (0) — §37: never let a forecast read as an
 * observation, and never render a time the projection could not have served.
 * In-range values are truncated to whole minutes; out-of-range values clamp.
 */
export const TIME_OFFSET_MIN_MINUTES = -7 * 24 * 60;
export const TIME_OFFSET_MAX_MINUTES = 24 * 60;

export function clampTimeOffsetMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  const whole = Math.trunc(minutes);
  if (whole < TIME_OFFSET_MIN_MINUTES) return TIME_OFFSET_MIN_MINUTES;
  if (whole > TIME_OFFSET_MAX_MINUTES) return TIME_OFFSET_MAX_MINUTES;
  return whole;
}

// ── State ──────────────────────────────────────────────────────────────────────

export interface MapSelection {
  objectId: string;
  objectKind: MapObjectKind;
}

export interface MapNavigation {
  routeId: string;
  /** The object being navigated to, when the route was started from one. */
  destinationObjectId: string | null;
}

export interface MapMachineState {
  /** Which primary experience the shell is in (§30). */
  mode: MapMode;
  /**
   * Open overlays (§30). Invariant: length <= 1 — see D1. Kept as an array
   * rather than a `Set` so the value stays serializable and shallow-comparable
   * for React memoization.
   */
  overlays: readonly MapOverlay[];
  /** What the camera is doing (§30). */
  camera: CameraState;
  /**
   * The id the camera is framing — which trip, which group, which route,
   * which place. `null` for FOLLOW_USER and FREE_EXPLORE, which frame no
   * object. The `camera` value says what KIND of thing this id refers to.
   */
  cameraTargetId: string | null;
  /** The selected map object, if any (§8's Live Place subject). */
  selection: MapSelection | null;
  /** Active turn-by-turn, which §5 gives standing visual precedence. */
  navigation: MapNavigation | null;
  /** §15 Time Machine offset in minutes; 0 = NOW. */
  timeOffsetMinutes: number;
  /** Fail-closed gate record for the unbuilt surfaces (D5). */
  capabilities: MapCapabilities;
}

export function createInitialMapMachineState(
  capabilities: MapCapabilities = DEFAULT_MAP_CAPABILITIES,
): MapMachineState {
  return {
    mode: HOME_MODE,
    overlays: [],
    camera: cameraForMode(HOME_MODE),
    cameraTargetId: null,
    selection: null,
    navigation: null,
    timeOffsetMinutes: 0,
    capabilities: { ...capabilities },
  };
}

/**
 * Replace the capability record (flags usually arrive asynchronously after the
 * shell has already mounted). Deliberately NOT an event: §30's event surface
 * is about navigation, and capabilities are configuration.
 *
 * If the current mode becomes unreachable under the new capabilities, the
 * machine evacuates to LIVE rather than sitting on a dead surface (D5).
 */
export function withCapabilities(
  state: MapMachineState,
  capabilities: MapCapabilities,
): MapMachineState {
  const next: MapMachineState = { ...state, capabilities: { ...capabilities } };
  if (!canEnterMode(next.mode, next.capabilities)) {
    return {
      ...next,
      mode: HOME_MODE,
      camera: cameraForMode(HOME_MODE),
      cameraTargetId: null,
      selection: null,
    };
  }
  return next;
}

// ── Selectors ──────────────────────────────────────────────────────────────────

export function activeOverlay(state: MapMachineState): MapOverlay | null {
  return state.overlays.length > 0 ? state.overlays[0] : null;
}

export function isOverlayOpen(state: MapMachineState, overlay?: MapOverlay): boolean {
  if (overlay === undefined) return state.overlays.length > 0;
  return state.overlays.includes(overlay);
}

/** True when the user has manual control of the camera (D4). */
export function isCameraUserControlled(state: MapMachineState): boolean {
  return state.camera === 'FREE_EXPLORE';
}

/** The effective layer set for the current mode, given the user's preferences. */
export function visibleLayers(
  state: MapMachineState,
  enabled: readonly MapLayerId[] | null | undefined,
): MapLayerId[] {
  return visibleLayersFor(state.mode, enabled);
}

// ── Events (spec §30) ──────────────────────────────────────────────────────────

export type MapMachineEvent =
  /** A map object was tapped. Promotes LIVE -> PLACE_SELECTED (D3). */
  | { type: 'SELECT_OBJECT'; objectId: string; objectKind: MapObjectKind }
  /** The sheet was dismissed / the basemap was tapped. */
  | { type: 'CLEAR_SELECTION' }
  /** Enter a primary mode. Gated by `canEnterMode` (D5). */
  | { type: 'ENTER_MODE'; mode: MapMode; targetId?: string | null }
  /** Leave the current mode for LIVE. */
  | { type: 'EXIT_MODE' }
  /** Open a sheet over the current mode (D1, D2). */
  | { type: 'OPEN_OVERLAY'; overlay: MapOverlay }
  /** Close the open sheet. With `overlay`, closes only if that one is open. */
  | { type: 'CLOSE_OVERLAY'; overlay?: MapOverlay }
  /** The user dragged the map. Camera -> FREE_EXPLORE, nothing else (D4). */
  | { type: 'USER_PANNED' }
  /** The recenter control. Camera -> FOLLOW_USER; mode untouched. */
  | { type: 'RECENTER' }
  /** Frame an object WITHOUT selecting it (carousel scroll, Compass card). */
  | { type: 'FOCUS_OBJECT'; objectId: string; objectKind: MapObjectKind }
  /** Turn-by-turn started; §5 gives it standing precedence. */
  | { type: 'START_NAVIGATION'; routeId: string; destinationObjectId?: string | null }
  | { type: 'END_NAVIGATION' }
  /** §15 scrubber. Never changes mode — the scrubber can live on any surface. */
  | { type: 'SET_TIME_OFFSET'; minutes: number }
  /** Hardware/gesture back. See `resolveBack`. */
  | { type: 'BACK' };

// ── Internal transition helpers ────────────────────────────────────────────────

const NO_OVERLAYS: readonly MapOverlay[] = [];

/** Close every overlay, preserving referential identity when already closed. */
function closeAllOverlays(state: MapMachineState): MapMachineState {
  return state.overlays.length === 0 ? state : { ...state, overlays: NO_OVERLAYS };
}

/**
 * Move to `mode` and recompute the camera from the coupling table. Used by
 * ENTER_MODE, EXIT_MODE and BACK's exit rung — the three events that express
 * explicit mode intent, and therefore reclaim the camera even from
 * FREE_EXPLORE (D4).
 */
function toMode(
  state: MapMachineState,
  mode: MapMode,
  targetId: string | null,
  selection: MapSelection | null,
): MapMachineState {
  const camera = mode === 'PLACE_SELECTED' && selection
    ? cameraForObjectKind(selection.objectKind)
    : cameraForMode(mode);
  const nextTargetId = mode === 'PLACE_SELECTED' && selection ? selection.objectId : targetId;

  const unchanged =
    state.mode === mode &&
    state.camera === camera &&
    state.cameraTargetId === nextTargetId &&
    state.selection === selection &&
    state.overlays.length === 0;

  if (unchanged) return state;

  return {
    ...state,
    mode,
    overlays: NO_OVERLAYS,
    camera,
    cameraTargetId: nextTargetId,
    selection,
  };
}

// ── BACK semantics (spec §2) ───────────────────────────────────────────────────

/**
 * What a BACK press did, and — crucially — whether the machine consumed it.
 *
 * §2 calls these coordinated states of one system, so Back must unwind those
 * states in a single predictable order before the router is allowed to pop the
 * screen. The screen dispatches BACK, then reads `handled`: `false` means the
 * shell was already at LIVE with nothing open and the ROUTER should pop.
 */
export type MapBackOutcome =
  | {
      handled: true;
      /** Which rung of the ladder consumed the press. */
      effect: 'close_overlay' | 'clear_selection' | 'exit_mode';
      state: MapMachineState;
    }
  | {
      handled: false;
      effect: 'pop_route';
      /** Unchanged — the machine had nothing left to unwind. */
      state: MapMachineState;
    };

/**
 * The BACK ladder, highest rung first:
 *
 *   1. An overlay is open            -> close it, stay in the same mode.
 *   2. Something is selected         -> clear the selection. If the mode was
 *                                       PLACE_SELECTED it also returns to LIVE;
 *                                       if the selection was made inside a
 *                                       secondary mode (D3) the mode survives.
 *   3. A secondary mode is active    -> return to LIVE.
 *   4. Nothing left                  -> not handled; the router should pop.
 *
 * Navigation is deliberately NOT a rung: ending turn-by-turn is an explicit
 * decision with its own control, and a stray Back must never silently drop the
 * user out of active navigation (§5 gives navigation standing precedence).
 */
export function resolveBack(state: MapMachineState): MapBackOutcome {
  // Rung 1 — overlay.
  if (state.overlays.length > 0) {
    return { handled: true, effect: 'close_overlay', state: { ...state, overlays: NO_OVERLAYS } };
  }

  // Rung 2 — selection.
  if (state.selection !== null) {
    const mode = state.mode === 'PLACE_SELECTED' ? HOME_MODE : state.mode;
    const camera = state.camera === 'FREE_EXPLORE' ? 'FREE_EXPLORE' : cameraForMode(mode);
    return {
      handled: true,
      effect: 'clear_selection',
      state: {
        ...state,
        mode,
        selection: null,
        camera,
        cameraTargetId: camera === 'FREE_EXPLORE' ? state.cameraTargetId : null,
      },
    };
  }

  // Rung 3 — secondary mode (PLACE_SELECTED with no selection lands here too,
  // which is the correct repair for that impossible state).
  if (state.mode !== HOME_MODE) {
    return {
      handled: true,
      effect: 'exit_mode',
      state: {
        ...toMode(state, HOME_MODE, null, null),
        timeOffsetMinutes: state.mode === 'TIME_MACHINE' ? 0 : state.timeOffsetMinutes,
      },
    };
  }

  // Rung 4 — nothing to unwind.
  return { handled: false, effect: 'pop_route', state };
}

// ── Reducer ────────────────────────────────────────────────────────────────────

/**
 * The pure transition function. Every branch either returns the SAME state
 * reference (so a React `useReducer` bails out of the re-render) or a new
 * object; no branch mutates its input.
 *
 * Any event that cannot be applied — an unknown mode, an ungated surface, a
 * malformed object kind, PLACE_SELECTED with nothing selected — is a no-op
 * returning the same reference. The machine never enters an invalid state and
 * never throws at a user's thumb.
 */
export function mapMachineReducer(state: MapMachineState, event: MapMachineEvent): MapMachineState {
  switch (event?.type) {
    // ── Selection ────────────────────────────────────────────────────────────
    case 'SELECT_OBJECT': {
      const { objectId, objectKind } = event;
      if (typeof objectId !== 'string' || objectId === '') return state;
      if (!isMapObjectKind(objectKind)) return state;

      // D3: LIVE is promoted to PLACE_SELECTED; a secondary mode survives.
      const mode = state.mode === HOME_MODE ? 'PLACE_SELECTED' : state.mode;
      const camera = cameraForObjectKind(objectKind);

      if (
        state.mode === mode &&
        state.camera === camera &&
        state.cameraTargetId === objectId &&
        state.selection !== null &&
        state.selection.objectId === objectId &&
        state.selection.objectKind === objectKind &&
        state.overlays.length === 0
      ) {
        return state;
      }

      return {
        ...state,
        mode,
        // Picking something off the map dismisses whatever sheet was over it
        // (notably: tapping a SEARCH result).
        overlays: NO_OVERLAYS,
        camera,
        cameraTargetId: objectId,
        selection: { objectId, objectKind },
      };
    }

    case 'CLEAR_SELECTION': {
      if (state.selection === null && state.mode !== 'PLACE_SELECTED') return state;
      const mode = state.mode === 'PLACE_SELECTED' ? HOME_MODE : state.mode;
      // D4: an incidental event does not steal the camera back from the user.
      const camera = state.camera === 'FREE_EXPLORE' ? 'FREE_EXPLORE' : cameraForMode(mode);
      return {
        ...state,
        mode,
        selection: null,
        camera,
        cameraTargetId: camera === 'FREE_EXPLORE' ? state.cameraTargetId : null,
      };
    }

    // ── Modes ────────────────────────────────────────────────────────────────
    case 'ENTER_MODE': {
      const { mode } = event;
      if (!isMapMode(mode)) return state;
      // D5: fail closed on an unbuilt surface.
      if (!canEnterMode(mode, state.capabilities)) return state;

      // PLACE_SELECTED is not enterable on its own — it is what SELECT_OBJECT
      // produces. Entering it with nothing selected would be a mode with no
      // subject, so it is refused.
      if (mode === 'PLACE_SELECTED' && state.selection === null) return state;

      const targetId = typeof event.targetId === 'string' ? event.targetId : null;
      const selection = mode === 'PLACE_SELECTED' ? state.selection : null;
      const moved = toMode(state, mode, targetId, selection);

      // §15: arriving at Time Machine always starts at NOW.
      if (mode === 'TIME_MACHINE' && moved.timeOffsetMinutes !== 0) {
        return { ...moved, timeOffsetMinutes: 0 };
      }
      return moved;
    }

    case 'EXIT_MODE': {
      if (state.mode === HOME_MODE && state.selection === null) return state;
      const moved = toMode(state, HOME_MODE, null, null);
      // Leaving Time Machine puts the world back to NOW; a stale offset must
      // never leak into LIVE and make forecasts read as observations (§37).
      if (state.mode === 'TIME_MACHINE' && moved.timeOffsetMinutes !== 0) {
        return { ...moved, timeOffsetMinutes: 0 };
      }
      return moved;
    }

    // ── Overlays ─────────────────────────────────────────────────────────────
    case 'OPEN_OVERLAY': {
      const { overlay } = event;
      if (!isMapOverlay(overlay)) return state;
      if (state.overlays.length === 1 && state.overlays[0] === overlay) return state;
      // D1: mutual exclusion — opening one closes the others.
      // D2: mode and camera are untouched.
      return { ...state, overlays: [overlay] };
    }

    case 'CLOSE_OVERLAY': {
      if (state.overlays.length === 0) return state;
      if (event.overlay !== undefined && !state.overlays.includes(event.overlay)) return state;
      return closeAllOverlays(state);
    }

    // ── Camera ───────────────────────────────────────────────────────────────
    case 'USER_PANNED': {
      // D4: the mode, the selection and the overlay all survive a pan.
      if (state.camera === 'FREE_EXPLORE' && state.cameraTargetId === null) return state;
      return { ...state, camera: 'FREE_EXPLORE', cameraTargetId: null };
    }

    case 'RECENTER': {
      if (state.camera === 'FOLLOW_USER' && state.cameraTargetId === null) return state;
      return { ...state, camera: 'FOLLOW_USER', cameraTargetId: null };
    }

    case 'FOCUS_OBJECT': {
      const { objectId, objectKind } = event;
      if (typeof objectId !== 'string' || objectId === '') return state;
      if (!isMapObjectKind(objectKind)) return state;
      const camera = cameraForObjectKind(objectKind);
      if (state.camera === camera && state.cameraTargetId === objectId) return state;
      // Framing is not selecting: mode, selection and overlays are untouched.
      return { ...state, camera, cameraTargetId: objectId };
    }

    // ── Navigation ───────────────────────────────────────────────────────────
    case 'START_NAVIGATION': {
      const { routeId } = event;
      if (typeof routeId !== 'string' || routeId === '') return state;
      const destinationObjectId =
        typeof event.destinationObjectId === 'string' ? event.destinationObjectId : null;
      return {
        ...state,
        overlays: NO_OVERLAYS,
        navigation: { routeId, destinationObjectId },
        camera: 'FOCUS_ROUTE',
        cameraTargetId: routeId,
      };
    }

    case 'END_NAVIGATION': {
      if (state.navigation === null) return state;
      // D4: if the user had panned away, leave them where they are.
      const camera = state.camera === 'FREE_EXPLORE' ? 'FREE_EXPLORE' : cameraForMode(state.mode);
      return {
        ...state,
        navigation: null,
        camera,
        cameraTargetId: camera === 'FREE_EXPLORE' ? state.cameraTargetId : null,
      };
    }

    // ── Time ─────────────────────────────────────────────────────────────────
    case 'SET_TIME_OFFSET': {
      const minutes = clampTimeOffsetMinutes(event.minutes);
      if (state.timeOffsetMinutes === minutes) return state;
      // Scrubbing time changes neither mode nor camera: §15's NOW/+30/+60/+120
      // control is available wherever the surface chooses to render it, and
      // entering TIME_MACHINE is a separate, capability-gated decision.
      return { ...state, timeOffsetMinutes: minutes };
    }

    // ── Back ─────────────────────────────────────────────────────────────────
    case 'BACK':
      // The screen should call `resolveBack` so it can read `handled`;
      // dispatching BACK applies the same transition and is always safe.
      return resolveBack(state).state;

    default:
      return state;
  }
}

/*
 * FOLDING INTO src/stores/mapStore.tsx
 * ====================================
 * The lead owns that file; this is the intended shape of the fold.
 *
 * 1. STATE. Add one nested slice rather than eleven flat fields:
 *
 *        export interface MapStoreState {
 *          ...existing fields...
 *          machine: MapMachineState;   // from createInitialMapMachineState()
 *        }
 *
 *    Nesting keeps every existing identity bailout in `reducer` untouched and
 *    makes the machine's own bailouts (same reference in, same reference out)
 *    compose: `state.machine === next.machine` short-circuits the whole slice.
 *
 * 2. ACTIONS. Add exactly one action that forwards to this reducer:
 *
 *        | { type: 'MAP_EVENT'; payload: MapMachineEvent }
 *
 *        case 'MAP_EVENT': {
 *          const machine = mapMachineReducer(state.machine, action.payload);
 *          if (machine === state.machine) return state;             // bailout
 *          return {
 *            ...state,
 *            machine,
 *            // keep the legacy field in sync for existing consumers:
 *            selectedEntityId: machine.selection?.objectId ?? null,
 *          };
 *        }
 *
 * 3. NAME COLLISIONS. There are none: every existing action is `SET_*` /
 *    `UPDATE_*`; none of the thirteen event names collides.
 *
 * 4. THE ONE REAL CONFLICT — `selectedEntityId`. Two writers for one fact.
 *    Preferred fix: make `selectedEntityId` DERIVED (as in step 2) and turn
 *    `setSelectedEntityId(id)` into a thin adapter that dispatches
 *    `SELECT_OBJECT` / `CLEAR_SELECTION`, so no caller has to change:
 *
 *        setSelectedEntityId(id) =>
 *          id === null
 *            ? dispatch({ type: 'MAP_EVENT', payload: { type: 'CLEAR_SELECTION' } })
 *            : dispatch({ type: 'MAP_EVENT',
 *                payload: { type: 'SELECT_OBJECT', objectId: id, objectKind: kindOf(id) } });
 *
 *    `SELECT_OBJECT` needs the object's `kind`, which `setSelectedEntityId`
 *    does not have. Either widen the callback to
 *    `setSelectedEntityId(id, kind = 'place')`, or keep `SET_SELECTED_ENTITY_ID`
 *    as a legacy action that also writes `machine.selection` with kind
 *    `'place'`. `'place'` is the safe default: `cameraForObjectKind('place')`
 *    is `FOCUS_PLACE`, which is the spec's stated behaviour for selection.
 *
 * 5. CAMERA FIELDS. `cameraCenter` / `cameraZoom` are the map SDK's LAST KNOWN
 *    numbers; `machine.camera` is the INTENT behind them. They do not overlap
 *    and both should stay. The map component reads `machine.camera` to decide
 *    whether to drive the SDK, and writes `cameraCenter` / `cameraZoom` back
 *    as the SDK reports them. The SDK's own `onRegionChange(isGesture: true)`
 *    should dispatch `USER_PANNED` — and nothing else, so an SDK-driven
 *    animation never mistakes itself for a user gesture.
 *
 * 6. LAYERS. `enabledLayers` stays exactly as it is — the machine never writes
 *    it. Render from `visibleLegacyLayersFor(state.machine.mode,
 *    state.enabledLayers)`; the Layers sheet keeps toggling `enabledLayers`
 *    directly, so the user's preferences survive every mode round-trip.
 *
 * 7. BACK. The screen (not the store) calls `resolveBack(state.machine)`,
 *    dispatches `BACK` when `handled` is true, and lets Expo Router pop
 *    otherwise.
 *
 * 8. CAPABILITIES. Seed with `createInitialMapMachineState(flags)` if flags are
 *    ready at mount; otherwise add a `SET_MAP_CAPABILITIES` store action that
 *    calls `withCapabilities(state.machine, flags)` when they load.
 */
