import { Linking, Platform } from 'react-native';

export interface MapsPlace {
  name: string;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * openMapsNavigation — opens a place in the device's native maps app.
 *
 * Web has no `maps:`/`geo:` URI handler — those schemes silently fail (or open
 * a blank tab) in a browser, so web always goes straight to the Google Maps
 * web URL, same as Discovery's "Directions" fix.
 *
 * Coordinate path (native only, when lat/lng are present):
 *   iOS     → maps:?q=lat,lng  (Apple Maps), fallback Google Maps web
 *   Android → geo:lat,lng       (Android system handler), fallback Google Maps web
 *
 * Name-search path (native only, no coords — media feed items never carry raw
 * coordinates by design; see mediaFeedItem.ts's location privacy rule):
 *   iOS     → maps:?q=encodedName (Apple Maps search)
 *   Android → geo:0,0?q=encodedName (Android's documented "search, no anchor"
 *             syntax — the literal 0,0 is expected here, not a bug)
 */
export function openMapsNavigation(place: MapsPlace): void {
  const query = [place.name, place.city].filter(Boolean).join(', ');
  const encoded = encodeURIComponent(query);
  const hasCoords = place.lat != null && place.lng != null;

  if (Platform.OS === 'web') {
    const webUrl = hasCoords
      ? `https://maps.google.com/?q=${place.lat},${place.lng}`
      : `https://maps.google.com/?q=${encoded}`;
    Linking.openURL(webUrl).catch(() => {});
    return;
  }

  if (hasCoords) {
    const { lat, lng } = place;
    if (Platform.OS === 'ios') {
      Linking.openURL(`maps:?q=${lat},${lng}`).catch(() => {
        Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
      });
    } else {
      Linking.openURL(`geo:${lat},${lng}?q=${lat},${lng}`).catch(() => {
        Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
      });
    }
  } else {
    if (Platform.OS === 'ios') {
      Linking.openURL(`maps:?q=${encoded}`).catch(() => {
        Linking.openURL(`https://maps.google.com/search?q=${encoded}`).catch(() => {});
      });
    } else {
      Linking.openURL(`geo:0,0?q=${encoded}`).catch(() => {
        Linking.openURL(`https://maps.google.com/search?q=${encoded}`).catch(() => {});
      });
    }
  }
}

/**
 * Turn-by-turn DIRECTIONS to a point, computed by the platform's own maps app —
 * census-layover L120 ("at RETURN_NOW … prioritise airport route"). Portava has
 * no routing provider; the OS maps app does, and it routes from where the
 * traveller IS, which this app never reads. PURE, so each platform's URL is a
 * unit case.
 *   iOS     → maps://?daddr=lat,lng (Apple Maps directions)
 *   Android → Google Maps' documented directions URL, which the app handles
 *   web     → the same Google Maps directions URL
 */
export function directionsUrl(platform: string, lat: number, lng: number): string {
  if (platform === 'ios') return `maps://?daddr=${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

/** Open directions to `lat,lng`; iOS falls back to the web URL if Apple Maps cannot open. */
export function openDirectionsTo(lat: number, lng: number): void {
  const url = directionsUrl(Platform.OS, lat, lng);
  Linking.openURL(url).catch(() => {
    if (Platform.OS === 'ios') Linking.openURL(directionsUrl('web', lat, lng)).catch(() => {});
  });
}

