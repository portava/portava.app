import { useEffect, useState } from 'react';
import { lookupFsqPhoto } from '../services/fsqPhotoLookup.ts';

/**
 * Deferred Foursquare photo hook for place cards.
 *
 * Returns `existingUrl` immediately when one is already present — no network
 * request fires. Otherwise fires a Foursquare Places Search after 500 ms
 * (same pattern as the live-status hook) to skip cards flung past while
 * scrolling without blocking the initial list render.
 *
 * Falls back to null on any error; the card then shows its category artwork.
 */
export function useFsqPhoto(
  name: string,
  lat: number | null | undefined,
  lng: number | null | undefined,
  existingUrl?: string | null,
): string | null {
  const [photoUrl, setPhotoUrl] = useState<string | null>(existingUrl ?? null);

  useEffect(() => {
    if (existingUrl) {
      setPhotoUrl(existingUrl);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      lookupFsqPhoto(name, lat, lng)
        .then((url) => { if (!cancelled) setPhotoUrl(url); })
        .catch(() => {});
    }, 500);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, lat, lng, existingUrl]);

  return photoUrl;
}
