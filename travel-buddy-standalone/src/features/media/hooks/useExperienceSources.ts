/**
 * useExperienceSources — gathers the canonical Event / Trip ids the EXPERIENCES
 * lens resolves (census-media §19; see `state/experienceSources.ts`).
 *
 * Reads three existing canonical client services — nothing new is fetched from
 * Media: `listMyEvents` (hosting + attending), `listMyTrips` (membership, via
 * `GET /api/trips/me`), and `listEvents` near the viewer's coarse location. A
 * source that fails contributes nothing; it never blocks the others, and the
 * lens still resolves whatever ids it has (including a deep-linked one).
 */
import { useEffect, useState } from 'react';
import { listMyEvents, listEvents } from '../../../services/events.ts';
import { listMyTrips } from '../../../services/trips.ts';
import { experienceIdsFrom } from '../state/experienceSources.ts';

const NEARBY_EVENT_RADIUS_KM = 10;

export function useExperienceSources(opts: {
  deepLinkedIds?: readonly string[];
  center?: { lat: number; lng: number } | null;
}): string[] {
  const deepKey = (opts.deepLinkedIds ?? []).join(',');
  const lat = opts.center?.lat ?? null;
  const lng = opts.center?.lng ?? null;
  const [ids, setIds] = useState<string[]>(() => experienceIdsFrom({ deepLinked: opts.deepLinkedIds ?? [] }));

  useEffect(() => {
    let cancelled = false;
    const deepLinked = deepKey ? deepKey.split(',') : [];
    void Promise.allSettled([
      listMyEvents(10),
      listMyTrips(),
      lat != null && lng != null
        ? listEvents({ nearLat: lat, nearLng: lng, nearRadiusKm: NEARBY_EVENT_RADIUS_KM, limit: 5 })
        : Promise.resolve(null),
    ]).then(([mine, trips, nearby]) => {
      if (cancelled) return;
      const myEvents = mine.status === 'fulfilled' && mine.value.ok ? mine.value.data?.events ?? [] : [];
      const myTrips = trips.status === 'fulfilled' ? trips.value : [];
      const nearbyEvents =
        nearby.status === 'fulfilled' && nearby.value && nearby.value.ok ? nearby.value.data?.events ?? [] : [];
      setIds(experienceIdsFrom({ deepLinked, myEvents, myTrips, nearbyEvents }));
    });
    return () => {
      cancelled = true;
    };
  }, [deepKey, lat, lng]);

  return ids;
}
