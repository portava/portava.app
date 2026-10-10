/**
 * census-layover L120 — the directions URL each platform's maps app is handed.
 * The route is computed by that app from where the traveller is; Portava sends
 * only the destination. (A jest suite: lib/maps.ts imports react-native.)
 */
import { directionsUrl } from '../maps.ts';

test('iOS asks Apple Maps for directions to the point (daddr), not a pin search', () => {
  expect(directionsUrl('ios', 13.69, 100.75)).toBe('maps://?daddr=13.69,100.75');
});

test('Android and web use Google Maps directions to the point', () => {
  for (const p of ['android', 'web']) {
    expect(directionsUrl(p, 25.0797, 121.2342)).toBe('https://www.google.com/maps/dir/?api=1&destination=25.0797,121.2342');
  }
});
