import { Linking, Platform } from 'react-native';

/**
 * openInMaps — opens a lat/lng coordinate in the device's native maps app.
 *
 * Web has no `geo:` URI handler — that scheme silently fails (or opens a
 * blank tab) in a browser, so web always goes straight to the Google Maps
 * web URL, same as the fix applied to openMapsNavigation.
 *
 * Native: tries the geo: URI scheme first (Android / system handler), then
 * falls back to Google Maps web URL so iOS (and any device without a
 * registered geo: handler) still opens a usable map.
 *
 * Extracted from GemMapPreview.tsx so it can be shared across GemMapPreview,
 * MapEntityActionRow, and any future card that needs a "Directions" button.
 */
export function openInMaps(lat: number, lng: number): void {
  if (Platform.OS === 'web') {
    Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
    return;
  }
  Linking.openURL(`geo:${lat},${lng}`).catch(() => {
    Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
  });
}
