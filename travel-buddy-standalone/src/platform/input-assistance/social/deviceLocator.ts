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
import { withServiceRequest } from '../../../services/serviceRequest.ts';

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

export function createDeviceLocator(load: () => Promise<ExpoLocation> = loadLocation): DeviceLocator {
  return {
  async permission() {
    const L = await load();
    const p = await L.getForegroundPermissionsAsync();
    if (p.status === 'granted') return 'granted';
    return p.canAskAgain === false || p.status === 'denied' ? 'denied' : 'undetermined';
  },
  async request() {
    const L = await load();
    const p = await L.requestForegroundPermissionsAsync();
    return p.status === 'granted';
  },
  async currentLabel() {
    try {
      const base = apiBase();
      if (!base || /[\s\\?#@]/.test(base)) return null;
      const origin = new URL(base);
      if (origin.protocol !== 'https:' || origin.pathname !== '/') return null;
      return await withServiceRequest(async (request) => {
        const token = await request.token(freshToken);
        if (!token) return null;
        const L = await request.wait(load);
        const permission = await request.wait(() => L.getForegroundPermissionsAsync());
        if (permission.status !== 'granted') return null;
        const pos = await request.wait(() => L.getCurrentPositionAsync({ accuracy: L.Accuracy.Balanced }));
        const { latitude: lat, longitude: lng } = pos.coords;
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
        const res = await request.fetch(`${origin.origin}/api/location/reverse-geocode`, {
          method: 'POST', credentials: 'omit', cache: 'no-store',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ lat, lng }),
        });
        if (!res.ok) return null;
        const body = await request.wait(() => res.json()) as { place?: { city?: string | null; district?: string | null } } | null;
        const label = [body?.place?.district, body?.place?.city]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .map((value) => value.trim()).join(', ');
        return label && label.length <= 240 ? label : null;
      });
    } catch { return null; }
  },
  };
}

export const expoDeviceLocator = createDeviceLocator();
