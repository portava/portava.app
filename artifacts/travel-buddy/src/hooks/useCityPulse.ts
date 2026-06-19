/**
 * useAvailability + useCityPulse — data seams.
 * Availability now reads from the session store (editable); events still mock.
 * Swap event body for API GET later (same shapes).
 */
import { useMemo } from 'react';
import type { CityEvent, PulseBuckets, Interest } from '../types/models';
import { mockEvents } from '../data/events';
import { filterPulse } from '../lib/recommend';
import { resolveStatus } from '../lib/availability';
import { useAvailabilityStore } from '../context/AvailabilityStore';

export function useAvailability() {
  // Reads from the in-memory session store (seeded from mock). Edits propagate live.
  const { availability } = useAvailabilityStore();
  return { availability, loading: false, error: null };
}

export function useCityPulse(opts: { currentCitySlug?: string; interests?: Interest[] }) {
  const { availability } = useAvailability();
  // TODO(backend): GET /pulse/events?city=...
  const events: CityEvent[] = mockEvents;

  const buckets: PulseBuckets = useMemo(
    () => filterPulse(events, { availability, currentCitySlug: opts.currentCitySlug, interests: opts.interests }),
    [events, availability, opts.currentCitySlug, opts.interests]
  );

  const status = resolveStatus(availability, new Date().toISOString(), opts.currentCitySlug);
  return { buckets, availability, status, loading: false, error: null };
}
