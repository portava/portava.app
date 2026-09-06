/**
 * layerModel — Map spec §16, "Layers and Progressive Disclosure".
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ====================================
 *   "Complexity should be managed with explicit layers plus automatic
 *    relevance. Do not turn every layer on simultaneously."
 *
 * So a layer is NOT a boolean. §16 gives three kinds of default —
 *
 *   Live Activity on, Events on, Relevant Places on, Saved on;
 *   People / Trip / Crowd Flow contextual;
 *   Buddies and Memories off.
 *
 * — and "contextual" is a real third state, not a boolean someone flipped for
 * the user. A contextual layer has NO stored value; it resolves to on/off from
 * the current context (zoom band, mode, trip state, Compass state, density)
 * every time the map re-resolves. The moment the user makes an explicit choice
 * that choice is stored and OUTRANKS the automatic resolution — and, because
 * the stored choice lives in `LayerPreferences` and the automatic resolution
 * lives in `LayerContext`, it necessarily survives every context change. There
 * is no code path that can silently clear a user choice when context moves.
 *
 * SAFETY IS NOT A LAYER YOU CAN TURN OFF
 * ======================================
 * Spec §5: "Safety and active navigation always take visual precedence over
 * popularity or activity." §24: "Safety and access warnings take precedence
 * over activity ranking." A user-disableable Safety layer would let a tap hide
 * a hazard notice, so Safety is excluded from the preference type itself
 * (`ToggleableLayerId` = every layer EXCEPT the always-on ones). A caller
 * cannot even name it in `LayerPreferences`; `setLayerChoice` will not accept
 * it; and `resolveLayers` force-resolves it to visible regardless of what a
 * hand-edited / migrated / untyped preferences blob claims.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ============================
 * A layer being VISIBLE is not the same as an object being DRAWN. This module
 * answers only "is this layer switched on right now?". Zoom-band render
 * thresholds, clustering and collision (§17, §31) belong to the render lane
 * (`features/map/render`), which consumes this module's answer. Zoom appears in
 * `LayerContext` only because §16 lists it as an input to automatic relevance
 * for the contextual layers — not because this file decides render detail.
 *
 * Pure: no I/O, no React, no clock, no persistence. Serialization helpers are
 * pure string<->object; the component owns AsyncStorage.
 */

import {
  MAP_MODES,
  ZOOM_BANDS,
  isMapMode,
  isZoomBand,
  type MapMode,
  type ZoomBand,
} from '../vocabulary.ts';
import {
  MAP_OBJECT_KINDS,
  type MapObjectKind,
} from '../../../types/mapObjects.ts';

// ── Layer identity (§16) ───────────────────────────────────────────────────────

/**
 * §16's "Core layers" line, verbatim and in the spec's own order:
 *   Live Activity, People, Events, Trip, Buddies, Saved, Crowd Flow,
 *   Hidden Gems, Safety, Transport, Memories.
 */
export const CORE_LAYER_IDS = [
  'live_activity',
  'people',
  'events',
  'trip',
  'buddies',
  'saved',
  'crowd_flow',
  'hidden_gems',
  'safety',
  'transport',
  'memories',
] as const;

export type CoreLayerId = (typeof CORE_LAYER_IDS)[number];

/**
 * §16's "Suggested defaults" line names one layer its "Core layers" line does
 * not: "Relevant Places on". It is a real layer — it is the one that carries
 * `kind: 'place'`, the single most common object on the map — so it is modelled
 * here rather than quietly folded into Live Activity. It is kept OUT of
 * `CORE_LAYER_IDS` so that constant stays a faithful quote of the spec.
 *
 * `world_intelligence` and `my_cities` are the §36 PHASE 7 layers, added
 * 2026-09-05 on the owner's approval (docs/map/scope-ruling-phases-6-7.md
 * AMENDMENT). They are here for the same reason `relevant_places` is: they are
 * real layers carrying real kinds, and §16's "Core layers" line is a quote that
 * must stay a quote.
 *
 * They are TWO layers, not one, because they answer to two different consent
 * regimes and one toggle could not honestly govern both. `world_intelligence`
 * carries the three PUBLIC aggregates (world_pulse, traveler_flow, city_model);
 * `my_cities` carries `personal_city`, which is the viewer's OWN history and
 * therefore defaults OFF like Memories, the other private layer.
 */
export const EXTRA_LAYER_IDS = [
  'relevant_places',
  'world_intelligence',
  'my_cities',
] as const;

export const MAP_LAYER_IDS = [...CORE_LAYER_IDS, ...EXTRA_LAYER_IDS] as const;

export type MapLayerId = (typeof MAP_LAYER_IDS)[number];

/**
 * Layers no user choice may switch off (§5, §24). Structural, not advisory:
 * `ToggleableLayerId` subtracts these, so a preferences object that names one
 * does not type-check.
 */
export const ALWAYS_ON_LAYER_IDS = ['safety'] as const;
export type AlwaysOnLayerId = (typeof ALWAYS_ON_LAYER_IDS)[number];

/** Every layer the user is permitted to have an opinion about. */
export type ToggleableLayerId = Exclude<MapLayerId, AlwaysOnLayerId>;

export const TOGGLEABLE_LAYER_IDS: readonly ToggleableLayerId[] = MAP_LAYER_IDS.filter(
  (id): id is ToggleableLayerId => !(ALWAYS_ON_LAYER_IDS as readonly string[]).includes(id),
);

export function isAlwaysOnLayer(id: MapLayerId): id is AlwaysOnLayerId {
  return (ALWAYS_ON_LAYER_IDS as readonly string[]).includes(id);
}

export function isMapLayerId(value: unknown): value is MapLayerId {
  return typeof value === 'string' && (MAP_LAYER_IDS as readonly string[]).includes(value);
}

// ── The three default states (§16) ─────────────────────────────────────────────

/**
 * `contextual` is the third state §16 asks for. `always_on` is the fourth, and
 * exists only so Safety cannot be expressed as "on, by default" — which would
 * imply "and therefore off, by choice".
 */
export const LAYER_DEFAULT_STATES = ['on', 'off', 'contextual', 'always_on'] as const;
export type LayerDefaultState = (typeof LAYER_DEFAULT_STATES)[number];

/**
 * §16 verbatim:
 *   "Suggested defaults: Live Activity on, Events on, Relevant Places on,
 *    Saved on; People/Trip/Crowd Flow contextual; Buddies and Memories off."
 *
 * Transport and Hidden Gems are named in "Core layers" but assigned no default.
 * §16's governing rule — "Do not turn every layer on simultaneously" — makes
 * `off` the only safe reading of an unassigned layer, so both stay off until
 * the user asks for them. Inventing a contextual rule for a layer the spec left
 * unassigned would be this module deciding product policy. Safety is
 * `always_on` per §5/§24.
 */
export const LAYER_DEFAULTS: Record<MapLayerId, LayerDefaultState> = {
  live_activity: 'on',
  events: 'on',
  relevant_places: 'on',
  saved: 'on',

  people: 'contextual',
  trip: 'contextual',
  crowd_flow: 'contextual',

  buddies: 'off',
  memories: 'off',
  hidden_gems: 'off',
  transport: 'off',

  safety: 'always_on',

  // §36 Phase 7. `world_intelligence` is contextual on the §17 zoom model: its
  // kinds only EXIST at the world/continent and city bands (collision.ts
  // BAND_INTRODUCES), so an `on` default would be a permanently-empty layer at
  // every zoom a traveller actually uses. `my_cities` follows Memories: it is
  // the viewer's own history and is shown only when they ask for it.
  world_intelligence: 'contextual',
  my_cities: 'off',
};

// ── The user's explicit choice ─────────────────────────────────────────────────

/**
 * A stored, deliberate user decision. There is no `'contextual'` member: a user
 * cannot choose "be automatic", they RETURN to automatic by clearing the choice
 * (`clearLayerChoice`). Absence of a key is the automatic state.
 */
export const LAYER_CHOICES = ['on', 'off'] as const;
export type LayerChoice = (typeof LAYER_CHOICES)[number];

/** Only toggleable layers may appear. Safety is not expressible here. */
export type LayerPreferences = Readonly<Partial<Record<ToggleableLayerId, LayerChoice>>>;

export const EMPTY_LAYER_PREFERENCES: LayerPreferences = Object.freeze({});

/** Set an explicit choice. Safety is rejected by the type, not by a runtime if. */
export function setLayerChoice(
  prefs: LayerPreferences,
  layerId: ToggleableLayerId,
  choice: LayerChoice,
): LayerPreferences {
  return Object.freeze({ ...prefs, [layerId]: choice });
}

/** Return a layer to automatic (default / contextual) resolution. */
export function clearLayerChoice(
  prefs: LayerPreferences,
  layerId: ToggleableLayerId,
): LayerPreferences {
  if (!(layerId in prefs)) return prefs;
  const next: Partial<Record<ToggleableLayerId, LayerChoice>> = { ...prefs };
  delete next[layerId];
  return Object.freeze(next);
}

/**
 * The tri-state control value for a row in the Layers sheet: the user's choice
 * if they made one, otherwise the word `auto`.
 */
export type LayerControlValue = LayerChoice | 'auto';

export function layerControlValue(
  prefs: LayerPreferences,
  layerId: MapLayerId,
): LayerControlValue | 'locked' {
  if (isAlwaysOnLayer(layerId)) return 'locked';
  const choice = (prefs as Partial<Record<MapLayerId, LayerChoice>>)[layerId];
  return choice ?? 'auto';
}

// ── Context: the inputs to automatic relevance (§16) ───────────────────────────

/**
 * §17's zoom ladder. Declared here (rather than imported from the render lane)
 * because §16 lists zoom as an input to LAYER resolution, which is a different
 * question from render detail. The names are §17's own, so the two lanes agree
 * by construction; if the render lane exports an identical union the lead
 * should alias one to the other rather than keep two spellings.
 */
// Both vocabularies live in features/map/vocabulary.ts, a leaf module — see
// its header. `LayerZoomBand` is kept as an ALIAS rather than a second union so
// existing callers keep compiling while there is exactly one set of band names
// in the codebase. Modes are UPPERCASE because §30 writes them that way; the
// lowercase spelling this file used to declare would silently mismatch any
// Record<MapMode, ...> built against the machine's spelling.
export {
  ZOOM_BANDS as LAYER_ZOOM_BANDS,
  MAP_MODES,
  isMapMode,
  isZoomBand,
  type MapMode,
};
export type LayerZoomBand = ZoomBand;

/** Viewport crowding, as measured by the projection/aggregation layer. */
export const LAYER_DENSITY_LEVELS = ['sparse', 'moderate', 'dense', 'very_dense'] as const;
export type LayerDensity = (typeof LAYER_DENSITY_LEVELS)[number];

export interface LayerContext {
  /** §17 band the camera currently sits in. */
  zoomBand: LayerZoomBand;
  /** §30 primary mode. */
  mode: MapMode;
  /** Is a trip in progress / open on this device right now? */
  tripActive: boolean;
  /** Has Compass produced geographic recommendations for this viewport? */
  compassActive: boolean;
  /** How crowded the viewport is after server aggregation (§31). */
  density: LayerDensity;
  /**
   * How many crew/circle members are currently sharing presence in view.
   * Absent (or 0) means the People layer has nothing to show, so automatic
   * relevance must not switch it on.
   */
  sharingPresenceCount?: number;
}

/** A neutral context, useful for tests and for the very first render. */
export const DEFAULT_LAYER_CONTEXT: LayerContext = Object.freeze({
  zoomBand: 'city',
  mode: 'LIVE',
  tripActive: false,
  compassActive: false,
  density: 'moderate',
  sharingPresenceCount: 0,
});

// ── Resolution ─────────────────────────────────────────────────────────────────

/**
 * Why a layer ended up visible or hidden. Surfaced in the sheet so the user is
 * never left guessing why an "automatic" layer is or is not drawing.
 */
export const LAYER_RESOLUTION_SOURCES = ['forced', 'user', 'default', 'context'] as const;
export type LayerResolutionSource = (typeof LAYER_RESOLUTION_SOURCES)[number];

export interface LayerResolution {
  layerId: MapLayerId;
  visible: boolean;
  /** Which rule decided it. `forced` outranks everything (§5/§24 safety). */
  source: LayerResolutionSource;
  /** The layer's declared default, for rendering the control's neutral state. */
  defaultState: LayerDefaultState;
  /** Human-readable justification, e.g. "Trip in progress". */
  reason: string;
}

export type LayerResolutionMap = Record<MapLayerId, LayerResolution>;

/**
 * The automatic half of §16 ("explicit layers PLUS automatic relevance").
 * Only consulted for layers whose default is `contextual` and for which the
 * user has expressed no opinion.
 */
function resolveContextual(
  layerId: MapLayerId,
  ctx: LayerContext,
): { visible: boolean; reason: string } {
  switch (layerId) {
    case 'people': {
      // §12 Locate My Friends is the mode built for this layer.
      if (ctx.mode === 'LOCATE_FRIENDS') {
        return { visible: true, reason: 'Locate My Friends is active' };
      }
      // §17: World and City render neighbourhoods and zones, not individuals.
      const sharing = ctx.sharingPresenceCount ?? 0;
      if (sharing > 0 && (ctx.zoomBand === 'district' || ctx.zoomBand === 'street' || ctx.zoomBand === 'venue')) {
        return { visible: true, reason: 'People are sharing presence nearby' };
      }
      if (sharing > 0) {
        return { visible: false, reason: 'Zoom in to see people sharing presence' };
      }
      return { visible: false, reason: 'Nobody is sharing presence here' };
    }

    case 'trip': {
      if (ctx.mode === 'TRIP') return { visible: true, reason: 'Trip Map is active' };
      if (ctx.tripActive) return { visible: true, reason: 'Trip in progress' };
      return { visible: false, reason: 'No active trip' };
    }

    case 'crowd_flow': {
      if (ctx.mode === 'CROWD_FLOW') return { visible: true, reason: 'Crowd Flow mode is active' };
      // §17 City band: "major flow". Flow arrows are noise when nothing moves,
      // and unreadable at street/venue scale, so they earn their place only in
      // a crowded city/district viewport.
      const crowded = ctx.density === 'dense' || ctx.density === 'very_dense';
      if (crowded && (ctx.zoomBand === 'city' || ctx.zoomBand === 'district')) {
        return { visible: true, reason: 'Heavy movement in this area' };
      }
      if (crowded) return { visible: false, reason: 'Flow is shown at city and district zoom' };
      return { visible: false, reason: 'Not enough movement to show flow' };
    }

    case 'world_intelligence': {
      // §17: the World band renders "countries visited, upcoming Trips,
      // Passport, major destinations" and the City band "neighborhoods,
      // activity zones, major events, major flow". A continent-scale pulse cell
      // and a city→city edge belong to exactly those two bands and are
      // meaningless below them — a district viewport is smaller than one cell.
      if (ctx.zoomBand === 'world') return { visible: true, reason: 'Zoomed out to the world view' };
      if (ctx.zoomBand === 'city') return { visible: true, reason: 'City view — city rhythm and movement' };
      return { visible: false, reason: 'Zoom out to see world activity' };
    }

    default:
      // Unreachable for the declared defaults; fail closed rather than guess.
      return { visible: false, reason: 'No automatic rule for this layer' };
  }
}

/**
 * Resolve every layer for the current context.
 *
 * Precedence, highest first:
 *   1. `always_on`  — Safety. Nothing can override it (§5, §24).
 *   2. user choice  — an explicit on/off, which survives every context change
 *                     because it lives in `prefs`, not in `context`.
 *   3. default      — `on` / `off` from §16's suggested defaults.
 *   4. context      — automatic relevance for `contextual` layers.
 */
export function resolveLayers(
  prefs: LayerPreferences,
  context: LayerContext,
): LayerResolutionMap {
  // Read through a widened view so a hand-edited or migrated blob that DOES
  // carry a `safety` key is observed and ignored, not trusted.
  const raw = (prefs ?? {}) as Partial<Record<MapLayerId, LayerChoice>>;
  const out = {} as LayerResolutionMap;

  for (const layerId of MAP_LAYER_IDS) {
    const defaultState = LAYER_DEFAULTS[layerId];

    if (defaultState === 'always_on' || isAlwaysOnLayer(layerId)) {
      out[layerId] = {
        layerId,
        visible: true,
        source: 'forced',
        defaultState,
        reason: 'Safety always takes precedence and cannot be switched off',
      };
      continue;
    }

    const choice = raw[layerId];
    if (choice === 'on' || choice === 'off') {
      out[layerId] = {
        layerId,
        visible: choice === 'on',
        source: 'user',
        defaultState,
        reason: choice === 'on' ? 'You turned this on' : 'You turned this off',
      };
      continue;
    }

    if (defaultState === 'contextual') {
      const { visible, reason } = resolveContextual(layerId, context);
      out[layerId] = { layerId, visible, source: 'context', defaultState, reason };
      continue;
    }

    out[layerId] = {
      layerId,
      visible: defaultState === 'on',
      source: 'default',
      defaultState,
      reason: defaultState === 'on' ? 'On by default' : 'Off by default',
    };
  }

  return out;
}

/** Convenience: the ids that resolve visible, in declaration order. */
export function visibleLayerIds(
  prefs: LayerPreferences,
  context: LayerContext,
): MapLayerId[] {
  const resolved = resolveLayers(prefs, context);
  return MAP_LAYER_IDS.filter((id) => resolved[id].visible);
}

// ── Kind → layer (§18 kinds mapped onto §16 layers) ────────────────────────────

/**
 * Every `MapObjectKind` belongs to exactly one layer. `Record<MapObjectKind, …>`
 * makes the mapping TOTAL: adding a kind to the contract without giving it a
 * layer is a compile error here and a test failure in the colocated suite.
 *
 * Two placements worth stating out loud:
 *  - `crew_member` and `meeting_point` sit on TRIP, not People. §11 scopes the
 *    Trip surface to "itinerary, crew, routes and meeting context"; the People
 *    layer is §12's permitted social presence, a different consent regime.
 *  - `prediction` sits on LIVE ACTIVITY. It is the forecast form of the same
 *    claim, and §37 forbids letting a forecast look like an observation — that
 *    is a RENDER distinction (dashed boundary, §6), not a reason to make the
 *    user hunt for a separate toggle to see what is coming.
 */
export const LAYER_FOR_KIND: Record<MapObjectKind, MapLayerId> = {
  place: 'relevant_places',
  event: 'events',
  activity_zone: 'live_activity',
  crowd_flow: 'crowd_flow',
  social_zone: 'people',
  hidden_gem: 'hidden_gems',
  trip_stop: 'trip',
  crew_member: 'trip',
  meeting_point: 'trip',
  buddy_zone: 'buddies',
  safety_notice: 'safety',
  memory: 'memories',
  prediction: 'live_activity',
  saved_place: 'saved',
  // §36 Phase 7. The three PUBLIC aggregates ride one layer; the viewer's own
  // city history rides its own, because a single toggle cannot honestly govern
  // both "show me what the world is doing" and "show me my own history".
  world_pulse: 'world_intelligence',
  traveler_flow: 'world_intelligence',
  city_model: 'world_intelligence',
  personal_city: 'my_cities',
};

export function layerForKind(kind: MapObjectKind): MapLayerId {
  return LAYER_FOR_KIND[kind];
}

/** The kinds a given layer carries. Empty for layers with no object kind. */
export function kindsForLayer(layerId: MapLayerId): MapObjectKind[] {
  return MAP_OBJECT_KINDS.filter((kind) => LAYER_FOR_KIND[kind] === layerId);
}

/** Is an object of this kind currently allowed on the map by layer state? */
export function isKindVisible(
  kind: MapObjectKind,
  prefs: LayerPreferences,
  context: LayerContext,
): boolean {
  return resolveLayers(prefs, context)[layerForKind(kind)].visible;
}

/**
 * Filter a batch of objects by layer state in ONE resolution pass.
 * (`isKindVisible` re-resolves per call; do not use it in a render loop.)
 */
export function filterByLayers<T extends { kind: MapObjectKind }>(
  objects: readonly T[],
  prefs: LayerPreferences,
  context: LayerContext,
): T[] {
  const resolved = resolveLayers(prefs, context);
  return objects.filter((o) => resolved[layerForKind(o.kind)]?.visible === true);
}

// ── Presentation metadata (§6 visual language) ─────────────────────────────────

/**
 * §6's "Map Zones and Semantic Visual Language" table, keyed by layer. `glyph`
 * names the §6 visual so the legend and the renderer quote the same source.
 */
export const LEGEND_GLYPHS = [
  'soft_fill',
  'pulsing_outline',
  'dashed_boundary',
  'arrows',
  'marker',
  'star',
  'gem',
  'event_icon',
  'group_icon',
  'avatar',
  'ring',
  'checkpoint_pin',
  'shield',
  'gold_marker',
  'blue_dot',
] as const;
export type LegendGlyph = (typeof LEGEND_GLYPHS)[number];

/** §6's own words for what each visual means. */
export const LEGEND_MEANINGS: Record<LegendGlyph, string> = {
  soft_fill: 'Current aggregate activity',
  pulsing_outline: 'Meaningful recent change',
  dashed_boundary: 'Predicted state or forecast zone',
  arrows: 'Aggregate crowd flow',
  marker: 'Place',
  star: 'Compass Pick / high-value recommendation',
  gem: 'Hidden Gem',
  event_icon: 'Time-bound event',
  group_icon: 'Aggregate social opportunity',
  avatar: 'Permitted identified presence only',
  ring: 'Approximate location',
  checkpoint_pin: 'Meeting point',
  shield: 'Safety context',
  gold_marker: 'Saved / Passport / Memory',
  blue_dot: 'Current user',
};

export interface LayerMeta {
  id: MapLayerId;
  label: string;
  /** One line explaining what switching this on actually puts on the map. */
  description: string;
  /** Accent colour for the swatch. Dark-mode-first: readable on near-black. */
  accent: string;
  /** The §6 visuals this layer contributes. */
  glyphs: readonly LegendGlyph[];
}

export const LAYER_META: Record<MapLayerId, LayerMeta> = {
  live_activity: {
    id: 'live_activity',
    label: 'Live Activity',
    description: 'Activity zones and what is changing right now',
    accent: '#FF4D2E',
    glyphs: ['soft_fill', 'pulsing_outline', 'dashed_boundary'],
  },
  people: {
    id: 'people',
    label: 'People',
    description: 'Permitted presence — approximate unless shared precisely',
    accent: '#22C55E',
    glyphs: ['group_icon', 'avatar', 'ring'],
  },
  events: {
    id: 'events',
    label: 'Events',
    description: 'Time-bound events happening in view',
    accent: '#FB923C',
    glyphs: ['event_icon'],
  },
  trip: {
    id: 'trip',
    label: 'Trip',
    description: 'Your itinerary, stops, crew and meeting points',
    accent: '#60A5FA',
    glyphs: ['checkpoint_pin', 'marker'],
  },
  buddies: {
    id: 'buddies',
    label: 'Buddies',
    description: 'Areas where local buddies are available',
    accent: '#2DD4BF',
    glyphs: ['group_icon'],
  },
  saved: {
    id: 'saved',
    label: 'Saved',
    description: 'Places you saved and Passport entries',
    accent: '#D4A017',
    glyphs: ['gold_marker'],
  },
  crowd_flow: {
    id: 'crowd_flow',
    label: 'Crowd Flow',
    description: 'Where people are moving, in aggregate',
    accent: '#38BDF8',
    glyphs: ['arrows'],
  },
  hidden_gems: {
    id: 'hidden_gems',
    label: 'Hidden Gems',
    description: 'Community gems, at the precision their sharer allowed',
    accent: '#A78BFA',
    glyphs: ['gem'],
  },
  safety: {
    id: 'safety',
    label: 'Safety',
    description: 'Safety and access context — always shown',
    accent: '#F87171',
    glyphs: ['shield'],
  },
  transport: {
    id: 'transport',
    label: 'Transport',
    description: 'Transit and transport context on the base map',
    accent: '#94A3B8',
    glyphs: ['marker'],
  },
  memories: {
    id: 'memories',
    label: 'Memories',
    description: 'Your own moments, pinned where they happened',
    accent: '#F0A6C6',
    glyphs: ['gold_marker'],
  },
  relevant_places: {
    id: 'relevant_places',
    label: 'Relevant Places',
    description: 'Places Portava thinks are relevant to you now',
    accent: '#F59E0B',
    glyphs: ['marker', 'star'],
  },
  world_intelligence: {
    id: 'world_intelligence',
    label: 'World Pulse',
    description: 'Where the world is active, how travellers move between cities, and a city\u2019s rhythm \u2014 aggregate only',
    accent: '#38BDF8',
    glyphs: ['soft_fill', 'arrows'],
  },
  my_cities: {
    id: 'my_cities',
    label: 'My Cities',
    description: 'Your own history in the cities you have been to \u2014 only you can see this',
    accent: '#FBBF24',
    glyphs: ['gold_marker'],
  },
};

// ── Persistence (pure halves only) ─────────────────────────────────────────────

/** Storage key for the §16 layer preferences. Owned by LayersSheet.tsx. */
export const LAYER_PREFERENCES_STORAGE_KEY = 'map_layer_prefs_v1';

export function serializeLayerPreferences(prefs: LayerPreferences): string {
  return JSON.stringify(prefs ?? {});
}

/**
 * Parse a stored blob, discarding anything that is not a valid toggleable
 * layer with a valid choice — including a `safety` key, which older or
 * hand-edited data could carry and which must never take effect.
 */
export function parseLayerPreferences(raw: string | null | undefined): LayerPreferences {
  if (!raw) return EMPTY_LAYER_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_LAYER_PREFERENCES;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return EMPTY_LAYER_PREFERENCES;
  }
  const out: Partial<Record<ToggleableLayerId, LayerChoice>> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isMapLayerId(key)) continue;
    if (isAlwaysOnLayer(key)) continue;
    if (value !== 'on' && value !== 'off') continue;
    out[key as ToggleableLayerId] = value;
  }
  return Object.freeze(out);
}
