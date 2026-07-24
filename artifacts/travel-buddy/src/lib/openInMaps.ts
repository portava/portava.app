import { Linking } from 'react-native';

/**
 * openInMaps — opens a lat/lng coordinate in the device's native maps app.
 *
 * Tries the geo: URI scheme first (Android / system handler), then falls back
 * to Google Maps web URL so iOS (and any device without a registered geo:
 * handler) still opens a usable map.
 *
 * Extracted from GemMapPreview.tsx so it can be shared across GemMapPreview,
 * MapEntityActionRow, and any future card that needs a "Directions" button.
 */
export function openInMaps(lat: number, lng: number): void {
  Linking.openURL(`geo:${lat},${lng}`).catch(() => {
    Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(() => {});
  });
}
