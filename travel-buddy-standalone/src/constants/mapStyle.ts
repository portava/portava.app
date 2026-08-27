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
