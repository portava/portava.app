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
 * Coordinate path (when lat/lng are present):
 *   iOS   → maps:?q=lat,lng  (Apple Maps), fallback Google Maps web
 *   Other → geo:lat,lng       (Android system handler), fallback Google Maps web
 *
 * Name-search path (no coords — or coords unavailable):
 *   iOS   → maps:?q=encodedName (Apple Maps search)
 *   Other → geo:0,0?q=encodedName (Android), fallback Google Maps search
 */
export function openMapsNavigation(place: MapsPlace): void {
  const query = [place.name, place.city].filter(Boolean).join(', ');
  const encoded = encodeURIComponent(query);

  if (place.lat != null && place.lng != null) {
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
