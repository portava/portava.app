/**
 * Shared map style constant for all MapLibre consumers.
 *
 * Uses MapTiler Streets v2 when EXPO_PUBLIC_MAPTILER_KEY is set,
 * falling back to the public MapLibre demo tiles so the map always
 * renders even without a key.
 */

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';

/**
 * Returns the MapLibre style URL to use for all maps in the app.
 * Prefer this over hardcoding the URL in individual components.
 */
export function getMapStyleUrl(): string {
  return MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
    : 'https://demotiles.maplibre.org/style.json';
}

/** Pre-computed constant for components that evaluate at module load time. */
export const MAP_STYLE_URL = getMapStyleUrl();
