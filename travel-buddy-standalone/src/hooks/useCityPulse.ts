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

export function useCityPulse(opts: {
  currentCitySlug?: string;
  interests?: Interest[];
  /**
   * Learned category affinities from the Telegraph preference engine.
   * Pass the `inferred.categoryAffinities` value from GET /api/me/preferences.
   * When provided, these nudge ranking for each visit after the user has
   * interacted with recommendations — making the pulse improve over time.
   */
  categoryAffinities?: Record<string, number>;
}) {
  const { availability } = useAvailability();
  // TODO(backend): GET /pulse/events?city=...
  const events: CityEvent[] = mockEvents;

  const buckets: PulseBuckets = useMemo(
    () => filterPulse(events, {
      availability,
      currentCitySlug: opts.currentCitySlug,
      interests: opts.interests,
      categoryAffinities: opts.categoryAffinities,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, availability, opts.currentCitySlug, opts.interests, opts.categoryAffinities]
  );

  const status = resolveStatus(availability, new Date().toISOString(), opts.currentCitySlug);
  return { buckets, availability, status, loading: false, error: null };
}
