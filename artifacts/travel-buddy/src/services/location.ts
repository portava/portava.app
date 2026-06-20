/**
 * Current-GPS capture via expo-location, with graceful fallback. The composer
 * uses this for "Use my current location". If permission is denied or GPS
 * fails, we return a result the composer turns into manual/none — posting is
 * never blocked, and we never fabricate coordinates.
 *
 * The backend decides verification; this only supplies the user's real GPS when
 * available.
 */
import * as Location from 'expo-location';

export interface GpsResult {
  granted: boolean;
  lat: number | null;
  lng: number | null;
  error?: string;
}

export async function getCurrentGps(): Promise<GpsResult> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return { granted: false, lat: null, lng: null, error: 'permission_denied' };
    }
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { granted: true, lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch (e) {
    return { granted: false, lat: null, lng: null, error: e instanceof Error ? e.message : 'gps_failed' };
  }
}

/**
 * Best-effort reverse geocode to city/country for display + tagging. Returns
 * nulls on failure (non-fatal). The tagged coordinates come from GPS; the
 * city/country are labels.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<{ city: string | null; country: string | null; name: string | null }> {
  try {
    const results = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
    const r = results?.[0];
    if (!r) return { city: null, country: null, name: null };
    const city = r.city ?? r.subregion ?? r.region ?? null;
    const country = r.country ?? null;
    const name = [r.name, r.street].filter(Boolean).join(' ') || city || null;
    return { city, country, name };
  } catch {
    return { city: null, country: null, name: null };
  }
}
