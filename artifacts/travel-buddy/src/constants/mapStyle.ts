/**
 * Shared map style constant for all MapLibre consumers.
 *
 * Priority:
 *   1. MapTiler Streets v2 when EXPO_PUBLIC_MAPTILER_KEY is a non-empty string.
 *   2. OpenFreeMap Liberty — free, no API key, reliable CDN — as fallback.
 *
 * Runtime 403 recovery: components should pass FALLBACK_MAP_STYLE_URL to
 * the Map component's onDidFailLoadingMap handler so a bad/expired MapTiler
 * key never leaves the map permanently blank.
 */

const MAPTILER_KEY = (process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '').trim();

/**
 * Zero-key fallback style — OpenFreeMap Liberty.
 * Free, no API key, Cloudflare-backed CDN. Always reliable.
 */
export const FALLBACK_MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * Returns the MapLibre style URL to use for all maps in the app.
 * Prefer this over hardcoding the URL in individual components.
 */
export function getMapStyleUrl(): string {
  return MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_KEY}`
    : FALLBACK_MAP_STYLE_URL;
}

/** Pre-computed constant for components that evaluate at module load time. */
export const MAP_STYLE_URL = getMapStyleUrl();
