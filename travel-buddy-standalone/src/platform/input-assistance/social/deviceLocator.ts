/**
 * Global Input Intelligence — "where am I, coarsely" for §54's Share current
 * Place (flow GII-F10).
 *
 * The eligibility half of that candidate lives on the device because only the
 * device knows it: whether Portava may read the location, and where the phone
 * is. The server never guesses a sender's position.
 *
 * The label is COARSE by construction (district / city from the existing
 * server-side reverse geocoder, `POST /api/location/reverse-geocode`) and the
 * composer opens it at "Approximate area" (Telegraph §4.3). A position that
 * cannot be named is reported as a failure, never replaced with a placeholder.
 *
 * `expo-location` is loaded on first use, so a screen that only mounts the
 * action bar does not touch the location module.
 */
import { freshToken } from '../../../services/apiToken.ts';

export type LocationPermission = 'granted' | 'undetermined' | 'denied';

export interface DeviceLocator {
  permission(): Promise<LocationPermission>;
  request(): Promise<boolean>;
  /** A coarse, human label for where the device is, or null when it cannot be named. */
  currentLabel(): Promise<string | null>;
}

type ExpoLocation = typeof import('expo-location');
let locationModule: Promise<ExpoLocation> | null = null;
const loadLocation = () => (locationModule ??= import('expo-location'));

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export const expoDeviceLocator: DeviceLocator = {
  async permission() {
    const L = await loadLocation();
    const p = await L.getForegroundPermissionsAsync();
    if (p.status === 'granted') return 'granted';
    return p.canAskAgain === false || p.status === 'denied' ? 'denied' : 'undetermined';
  },
  async request() {
    const L = await loadLocation();
    const p = await L.requestForegroundPermissionsAsync();
    return p.status === 'granted';
  },
  async currentLabel() {
    const L = await loadLocation();
    const pos = await L.getCurrentPositionAsync({ accuracy: L.Accuracy.Balanced });
    const token = await freshToken();
    if (!token || !apiBase()) return null;
    const res = await fetch(`${apiBase()}/api/location/reverse-geocode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { place?: { city?: string | null; district?: string | null } } | null;
    const p = body?.place;
    const label = [p?.district, p?.city].filter((x): x is string => typeof x === 'string' && x.trim().length > 0).join(', ');
    return label || null;
  },
};
