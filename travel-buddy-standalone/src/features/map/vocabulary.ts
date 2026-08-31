/**
 * vocabulary — the map's shared enumerations (Map spec §17, §30).
 *
 * WHY THIS MODULE EXISTS
 * ======================
 * Three modules legitimately need the same two vocabularies, and each has a
 * legitimate claim to owning something the others need:
 *
 *   features/map/state/mapMachine.ts   owns MODE SEMANTICS (transitions, the
 *                                      mode×camera table, Back)
 *   features/map/layers/layerModel.ts  owns LAYERS (defaults, tri-state,
 *                                      legend) and keys them BY MODE
 *   features/map/render/collision.ts   owns ZOOM THRESHOLDS and keys them by
 *                                      BAND
 *
 * Having mapMachine import layers while layerModel imports modes is a runtime
 * import cycle. Rather than paper over it with type-only imports that would
 * break the moment someone needs a value, the two shared *vocabularies* live
 * here in a leaf module that imports nothing. Cycles are then impossible by
 * construction, and each owner still owns its own semantics.
 *
 * THE CASING IS LOAD-BEARING
 * ==========================
 * Modes are UPPERCASE because spec §30 writes them that way, and because two
 * spellings of the same enum is a specific, nasty bug: a
 * `Record<MapMode, ...>` built against one spelling silently accepts the
 * other's keys as excess properties in some positions and mismatches in
 * others, so a lookup returns `undefined` at runtime with no type error. This
 * module exists partly so that can never happen again.
 *
 * Nothing here has behaviour. Enumerations and their guards only.
 */

// ── Map modes (spec §30) ──────────────────────────────────────────────────────

/**
 * §30's primary modes, in the spec's own order and spelling.
 *
 * These are coordinated states of ONE geographic system (§2: "not nine
 * unrelated tabs"), not independent screens. Overlays (INTENT, LAYERS, FILTERS,
 * SEARCH) are orthogonal and live in mapMachine, because an overlay opens
 * *over* a mode rather than replacing it.
 */
export const MAP_MODES = [
  'LIVE',
  'PLACE_SELECTED',
  'COMPASS',
  'TRIP',
  'CROWD_FLOW',
  'LOCATE_FRIENDS',
  'TIME_MACHINE',
] as const;

export type MapMode = (typeof MAP_MODES)[number];

export function isMapMode(value: unknown): value is MapMode {
  return typeof value === 'string' && (MAP_MODES as readonly string[]).includes(value);
}

// ── Zoom bands (spec §17) ─────────────────────────────────────────────────────

/**
 * §17's zoom model, widest first. The ORDER is meaningful — it is the basis of
 * "a kind visible at a wider band is always visible closer in", so reordering
 * this array changes render behaviour rather than just presentation.
 *
 * The numeric zoom thresholds that map a camera zoom onto a band deliberately
 * stay in features/map/render/collision.ts: those are a rendering decision, and
 * this module holds vocabulary, not policy.
 */
export const ZOOM_BANDS = ['world', 'city', 'district', 'street', 'venue'] as const;

export type ZoomBand = (typeof ZOOM_BANDS)[number];

export function isZoomBand(value: unknown): value is ZoomBand {
  return typeof value === 'string' && (ZOOM_BANDS as readonly string[]).includes(value);
}

/** How far in a band is, 0 = widest. Lets callers compare bands without a switch. */
export function zoomBandRank(band: ZoomBand): number {
  return ZOOM_BANDS.indexOf(band);
}
