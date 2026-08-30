/**
 * Pure viewport computation for RouteMinimapView.
 *
 * Extracted so it can be unit-tested without a React Native renderer.
 * RouteMinimapView imports computeViewport from here, so the test binds to the
 * SHIPPED algorithm — center/zoom output, 1.6 padding factor, 0.02 min-delta —
 * rather than a hand-copied "region" helper that used different constants and a
 * different return shape (and therefore tested nothing in the component).
 */

/** Minimal stop shape the viewport math reads. */
export interface ViewportStop {
  structuredLocation?: { lat?: number | null; lng?: number | null } | null;
}

export interface Viewport {
  center: [number, number];
  zoom: number;
}

export function computeViewport(stops: readonly ViewportStop[]): Viewport | null {
  const points = stops
    .map((s) => ({ lat: s.structuredLocation?.lat, lng: s.structuredLocation?.lng }))
    .filter((p) => p.lat != null && p.lng != null) as { lat: number; lng: number }[];

  if (points.length === 0) return null;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.6, 0.02);
  const lngDelta = Math.max((maxLng - minLng) * 1.6, 0.02);

  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
    zoom: Math.min(
      Math.log2(360 / lngDelta),
      Math.log2(180 / latDelta),
    ) - 0.5,
  };
}
