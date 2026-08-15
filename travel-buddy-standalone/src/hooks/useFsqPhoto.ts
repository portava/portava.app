import { useEffect, useState } from 'react';
import { lookupFsqPhoto } from '../services/fsqPhotoLookup.ts';
import { lookupGooglePhoto } from '../services/googlePhotoLookup.ts';

/**
 * Deferred real-photo fallback chain for place cards: Foursquare first, then
 * Google Places (New) via the server proxy, then null (the card falls back
 * to category-appropriate artwork — never a bare icon with no treatment).
 *
 * Returns `existingUrl` immediately when one is already present — no network
 * request fires. Otherwise fires the chain after 500 ms (same pattern as the
 * live-status hook) to skip cards flung past while scrolling without
 * blocking the initial list render.
 *
 * Each link fails silently and falls through to the next; the hook never
 * throws.
 */
export function useFsqPhoto(
  name: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  existingUrl?: string | null,
  /**
   * Place identity (e.g. an OSM `node/123`). When supplied, the server serves
   * and stores the canonical resolved photo for this place, so the chain below
   * is paid once for the place rather than once per viewer. Optional: omitting
   * it reproduces the previous behaviour exactly.
   */
  placeKey?: string | null,
): string | null {
  const [photoUrl, setPhotoUrl] = useState<string | null>(existingUrl ?? null);

  useEffect(() => {
    // Reset immediately so a recycled card never shows the previous place's
    // photo while the deferred lookup is in flight.
    setPhotoUrl(existingUrl ?? null);

    if (existingUrl) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      lookupFsqPhoto(name, lat, lng, placeKey)
        .then((url) => {
          if (cancelled) return null;
          if (url) { setPhotoUrl(url); return null; }
          // FSQ came up empty — try the Google fallback before giving up.
          return lookupGooglePhoto(name, lat, lng, placeKey);
        })
        .then((googleUrl) => {
          if (!cancelled && googleUrl) setPhotoUrl(googleUrl);
        })
        .catch(() => {});
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, lat, lng, existingUrl, placeKey]);

  return photoUrl;
}
