/**
 * Shared map style constant for all MapLibre consumers.
 *
 * Priority:
 *   1. MapTiler Streets when EXPO_PUBLIC_MAPTILER_KEY is a non-empty string.
 *   2. OpenFreeMap Liberty — free, no API key, reliable CDN — as fallback.
 *
 * NOTE: The Replit secret EXPO_PUBLIC_MAPTILER_KEY overrides the .env file
 * at Metro bundle time. If the map shows a 403 error, re-enter your MapTiler
 * API key in the Replit Secrets panel to sync it with the .env value.
 */

const MAPTILER_KEY = (process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '').trim();

/**
 * Returns the MapLibre style URL to use for all maps in the app.
 * Prefer this over hardcoding the URL in individual components.
 */
export function getMapStyleUrl(): string {
  return MAPTILER_KEY
    ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
    : 'https://tiles.openfreemap.org/styles/liberty';
}

/** Pre-computed constant for components that evaluate at module load time. */
export const MAP_STYLE_URL = getMapStyleUrl();
