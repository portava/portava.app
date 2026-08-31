/**
 * Shared map style constant for all MapLibre consumers.
 *
 * Primary style: OpenFreeMap Liberty — zero API key, Cloudflare CDN, reliable.
 *
 * MapTiler Streets v2 was previously the primary when EXPO_PUBLIC_MAPTILER_KEY
 * was set, but the key consistently returned HTTP 403 on the /styles endpoint
 * even when valid for other MapTiler APIs (tile proxy, geocoding). Every map
 * open logged a native error toast before the onDidFailLoadingMap fallback
 * recovered. Switching the primary to OpenFreeMap eliminates the toast entirely.
 *
 * To re-enable MapTiler as primary, replace getMapStyleUrl()'s body with:
 *   const key = (process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '').trim();
 *   return key
 *     ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${key}`
 *     : FALLBACK_MAP_STYLE_URL;
 *
 * The onDidFailLoadingMap handlers on each Map instance remain as a safety net
 * for future style-load failures.
 */

/**
 * Primary style — OpenFreeMap Liberty. Free, no API key, Cloudflare-backed CDN.
 */
const PRIMARY_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Fallback style — MapLibre's own demo style, keyless, on separate infrastructure.
 *
 * This MUST be a different provider than the primary: every map's
 * onDidFailLoadingMap handler does `if (mapStyle !== FALLBACK_MAP_STYLE_URL)
 * setMapStyle(FALLBACK_MAP_STYLE_URL)`, and when fallback === primary that
 * condition was always false — the documented "safety net" was dead code, so an
 * OpenFreeMap outage/rate-limit (e.g. an HTTP 403) had nothing to recover to.
 */
export const FALLBACK_MAP_STYLE_URL = 'https://demotiles.maplibre.org/style.json';

/**
 * Returns the MapLibre style URL for all maps in the app.
 * Currently always returns OpenFreeMap Liberty (see module comment above).
 */
export function getMapStyleUrl(): string {
  return PRIMARY_MAP_STYLE_URL;
}

/** Pre-computed constant for components that evaluate at module load time. */
export const MAP_STYLE_URL = PRIMARY_MAP_STYLE_URL;

/* ────────────────────────────────────────────────────────────────────────────
 * Portava Dark — the §4 base map
 * ──────────────────────────────────────────────────────────────────────────── */

import type { LayerSpecification, StyleSpecification } from '@maplibre/maplibre-react-native';
import { mapBase } from '../theme/mapChrome.ts';

/**
 * OpenFreeMap's own dark style. Keyless, verified HTTP 200 (2026-08-31).
 *
 * Kept as a URL-shaped escape hatch for any surface that can only pass a
 * string (and as the honest record that this endpoint EXISTS — it is not in
 * OpenFreeMap's front-page list next to `liberty`/`bright`/`positron`, and
 * `dark-matter` — the name it is usually called elsewhere — 404s here).
 *
 * It is NOT the primary, for three reasons measured against spec §4:
 *   1. It is neutral grey (background `rgb(12,12,12)`), not near-black NAVY.
 *   2. Its water fill is `rgb(27,27,29)` against a `rgb(12,12,12)` ground —
 *      a ~6% luminance step. §4 requires "recognizable water"; that is not
 *      recognizable. Its `water_name` layer is worse: black text
 *      (`hsla(0,0%,0%,0.7)`) with a lighter halo, i.e. inverted and
 *      effectively invisible on a dark base.
 *   3. It is a third party's file. It can change under us, and we cannot tune
 *      the base against the chrome in theme/mapChrome.ts.
 *
 * What it gets RIGHT — and what PORTAVA_DARK_MAP_STYLE below copies from it —
 * is the layer inventory: zero POI layers, and symbol layers limited to water
 * names, motorway refs, one road-name layer and place labels. That is §4's
 * "minimal native POI clutter" already.
 */
export const DARK_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

/**
 * Where the vector tiles come from. OpenFreeMap's OpenMapTiles-schema planet.
 *
 * Verified 2026-08-31: the TileJSON at this URL returns HTTP 200 and resolves
 * to `https://tiles.openfreemap.org/planet/<build>/{z}/{x}/{y}.pbf`. This is
 * the exact source every OpenFreeMap style uses, so shipping our own PAINT on
 * top of it costs nothing extra in tile traffic or reliability — we are on the
 * same CDN and the same tiles the app already downloads today.
 */
const OFM_VECTOR_TILES = 'https://tiles.openfreemap.org/planet';

/**
 * Glyph endpoint. Verified 2026-08-31.
 *
 * Only two stacks were confirmed to resolve: `Noto Sans Regular` (HTTP 200)
 * and `Noto Sans Bold` (HTTP 200). `Noto Sans Medium` 404s — do not reach for
 * it; a missing glyph stack drops the whole label layer at runtime with only
 * a native warning.
 */
const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const FONT_REGULAR = ['Noto Sans Regular'];
const FONT_BOLD = ['Noto Sans Bold'];

/**
 * Label text: prefer the English/local latin name, fall back to the raw name.
 * Lifted from the OpenFreeMap styles so multi-script places behave the same.
 */
/**
 * The `text-field` slot of a symbol layer, derived from the style spec rather
 * than hand-written: a bare array literal widens to `(string | string[])[]`
 * and stops being assignable the moment it is hoisted out of a layer object.
 */
type TextFieldSpec = NonNullable<
  NonNullable<Extract<LayerSpecification, { type: 'symbol' }>['layout']>['text-field']
>;

const NAME_FIELD: TextFieldSpec = ['coalesce', ['get', 'name_en'], ['get', 'name']];

/**
 * Portava Dark — the map spec §4 base style.
 *
 * ## Why a local style object rather than a third-party style URL
 *
 * §4 is a list of things a base map must NOT do ("avoid a Google Maps-style
 * wall of labels and POIs", "minimal native POI clutter", "low-saturation
 * streets and buildings") plus two it must ("recognizable water and major road
 * labels"). Those are properties of the LAYER LIST, and the layer list is
 * exactly what a style URL hands to somebody else. Every keyless dark style we
 * could find only approximates them, and none can be tuned against the chrome
 * palette in theme/mapChrome.ts — which is the actual §4 requirement, since
 * "the geographic base should visually recede behind Portava intelligence" is
 * a statement about the RELATIONSHIP between base and overlay, not about the
 * base alone.
 *
 * So: keep OpenFreeMap's free vector TILES (same CDN, same reliability, still
 * keyless — see OFM_VECTOR_TILES) and author the paint ourselves.
 *
 * ## What is deliberately absent
 *
 * There is no `poi` layer, no `poi_label`, no `aerodrome_label`, no
 * `mountain_peak`, no housenumbers and no `sprite` (nothing here uses an
 * icon-image, so the ~119KB sprite sheet is never fetched). Symbol layers are
 * limited to: water names, motorway refs, major road names, and place labels
 * that thin out by zoom. That is the whole of §4's label budget — everything
 * else on the map is supposed to be a Portava object.
 *
 * ## Layer order == spec §5 levels 0-1
 *
 * ground → land → green → water → building → roads → rail → boundaries →
 * labels. Portava overlays (levels 2-7) are rendered by React components ABOVE
 * this style, so nothing here may compete with them for colour.
 */
export const PORTAVA_DARK_MAP_STYLE: StyleSpecification = {
  version: 8,
  name: 'Portava Dark',
  glyphs: OFM_GLYPHS,
  sources: {
    openmaptiles: { type: 'vector', url: OFM_VECTOR_TILES },
  },
  layers: [
    // ── Level 0: ground ──────────────────────────────────────────────────────
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': mapBase.ground },
    },
    {
      id: 'landuse-built',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landuse',
      filter: ['match', ['get', 'class'], ['residential', 'suburb', 'neighbourhood'], true, false],
      paint: { 'fill-color': mapBase.land, 'fill-opacity': 0.6 },
    },
    {
      id: 'landuse-green',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'park',
      paint: { 'fill-color': mapBase.green, 'fill-opacity': 0.9 },
    },
    {
      id: 'landcover-wood',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'landcover',
      filter: ['match', ['get', 'class'], ['wood', 'grass'], true, false],
      paint: { 'fill-color': mapBase.green, 'fill-opacity': 0.7 },
    },

    // ── Level 1: water ───────────────────────────────────────────────────────
    // §4 "recognizable water": this is the one geographic feature allowed a
    // clear luminance step off the ground, because a coastline the user cannot
    // find makes every overlay above it harder to place.
    {
      id: 'water',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'water',
      filter: ['!=', ['get', 'brunnel'], 'tunnel'],
      paint: { 'fill-color': mapBase.water, 'fill-antialias': true },
    },
    {
      id: 'waterway',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'waterway',
      paint: {
        'line-color': mapBase.waterway,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 9, 0.6, 18, 4],
      },
    },

    // ── Level 1: buildings ───────────────────────────────────────────────────
    {
      id: 'building',
      type: 'fill',
      source: 'openmaptiles',
      'source-layer': 'building',
      minzoom: 13,
      paint: {
        'fill-color': mapBase.building,
        'fill-outline-color': mapBase.buildingOutline,
        'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 15, 1],
      },
    },

    // ── Level 1: roads ───────────────────────────────────────────────────────
    // Minor roads appear late (z13) and stay near the ground colour: §4's
    // "low-saturation streets". The casing/inner pair on major roads is what
    // keeps junctions readable without raising overall brightness.
    {
      id: 'road-minor',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 13,
      filter: ['match', ['get', 'class'], ['minor', 'service', 'track'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': mapBase.roadMinor,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, 0.8, 20, 14],
      },
    },
    {
      id: 'road-major-casing',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 11,
      filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false],
      layout: { 'line-cap': 'butt', 'line-join': 'miter' },
      paint: {
        'line-color': mapBase.roadCasing,
        'line-opacity': 0.5,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 11, 2.4, 20, 20],
      },
    },
    {
      id: 'road-major',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 8,
      filter: ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': mapBase.roadMajor,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 8, 0.5, 11, 1.6, 20, 17],
      },
    },
    {
      id: 'road-motorway-casing',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 7,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'butt', 'line-join': 'miter' },
      paint: {
        'line-color': mapBase.roadCasing,
        'line-opacity': 0.55,
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 7, 2, 20, 26],
      },
    },
    {
      id: 'road-motorway',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 5,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': mapBase.roadMotorway,
        'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 5, 0.5, 7, 1.4, 20, 22],
      },
    },
    {
      id: 'rail',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'transportation',
      minzoom: 13,
      filter: ['all', ['==', ['get', 'class'], 'rail'], ['!', ['has', 'service']]],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': mapBase.rail,
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 13, 0.8, 20, 4],
      },
    },

    // ── Level 1: districts / admin ───────────────────────────────────────────
    {
      id: 'boundary-country',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      filter: ['==', ['get', 'admin_level'], 2],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': mapBase.boundary,
        'line-width': ['interpolate', ['exponential', 1.1], ['zoom'], 3, 0.7, 12, 2.2],
      },
    },
    {
      id: 'boundary-state',
      type: 'line',
      source: 'openmaptiles',
      'source-layer': 'boundary',
      minzoom: 4,
      filter: ['==', ['get', 'admin_level'], 4],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': mapBase.boundary,
        'line-opacity': 0.6,
        'line-dasharray': [2, 2],
        'line-width': ['interpolate', ['exponential', 1.3], ['zoom'], 4, 0.5, 14, 1.6],
      },
    },

    // ── Labels — the entire §4 label budget ──────────────────────────────────
    {
      id: 'label-water',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'water_name',
      minzoom: 6,
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 500,
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-rotation-alignment': 'map',
        'text-size': 12,
        'text-letter-spacing': 0.1,
      },
      paint: {
        'text-color': mapBase.labelWater,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.2,
      },
    },
    // "Major road labels" per §4 — motorway refs and named primary/trunk only.
    // Secondary/tertiary/residential names are the wall-of-labels §4 rules out.
    {
      id: 'label-road-motorway',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      minzoom: 8,
      filter: ['==', ['get', 'class'], 'motorway'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 350,
        'text-field': ['to-string', ['get', 'ref']],
        'text-font': FONT_BOLD,
        'text-rotation-alignment': 'viewport',
        'text-pitch-alignment': 'viewport',
        'text-size': 10,
      },
      paint: {
        'text-color': mapBase.label,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'label-road-major',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'transportation_name',
      minzoom: 14,
      filter: ['match', ['get', 'class'], ['primary', 'trunk'], true, false],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 400,
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-max-angle': 30,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'text-size': 10,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.12,
      },
      paint: {
        'text-color': mapBase.label,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.2,
      },
    },
    // Districts/neighbourhoods (spec §17: the City and District zoom bands).
    {
      id: 'label-place-suburb',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      minzoom: 11,
      maxzoom: 16,
      filter: ['match', ['get', 'class'], ['suburb', 'neighbourhood'], true, false],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': 11,
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.14,
      },
      paint: {
        'text-color': mapBase.label,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'label-place-town',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      maxzoom: 13,
      filter: ['match', ['get', 'class'], ['town', 'village'], true, false],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_REGULAR,
        'text-size': 11,
      },
      paint: {
        'text-color': mapBase.label,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.2,
      },
    },
    {
      id: 'label-place-city',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      maxzoom: 13,
      filter: ['==', ['get', 'class'], 'city'],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 15],
      },
      paint: {
        'text-color': mapBase.labelStrong,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'label-place-country',
      type: 'symbol',
      source: 'openmaptiles',
      'source-layer': 'place',
      maxzoom: 8,
      filter: ['==', ['get', 'class'], 'country'],
      layout: {
        'text-field': NAME_FIELD,
        'text-font': FONT_BOLD,
        'text-size': ['interpolate', ['linear'], ['zoom'], 1, 10, 6, 13],
        'text-transform': 'uppercase',
        'text-letter-spacing': 0.16,
      },
      paint: {
        'text-color': mapBase.labelStrong,
        'text-halo-color': mapBase.labelHalo,
        'text-halo-width': 1.6,
      },
    },
  ],
};

/**
 * The style the Portava Map Shell should render.
 *
 * Mirrors `getMapStyleUrl()` for surfaces that want a function rather than the
 * constant. NOTE the return type: this is a StyleSpecification OBJECT, so it
 * goes to `<Map mapStyle={...} />`, not `styleURL`. `getMapStyleUrl()` above
 * is unchanged and still serves every embedded mini-map.
 */
export function getPortavaMapStyle(): StyleSpecification {
  return PORTAVA_DARK_MAP_STYLE;
}
