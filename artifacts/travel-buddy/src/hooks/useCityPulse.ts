/**
 * useAvailability + useCityPulse — data seams.
 * Availability reads from the session store (editable); events fetch from
 * /api/events?city=... with empty-state fallback (mockEvents in __DEV__ only).
 *
 * Pure fetch/map helpers live in ./cityPulseUtils so they can be unit-tested
 * without pulling in React, Expo, or Supabase.
 *
 * City-switching behaviour:
 *   • Stale events are cleared immediately when the city slug changes.
 *   • A 150 ms debounce absorbs rapid city-switch taps before fetching.
 *   • After a successful fetch a TTL timer fires a background re-fetch so
 *     events stay fresh without the user pulling to refresh.
 */
import { useMemo, useState, useEffect } from 'react';
import type { CityEvent, PulseBuckets, Interest } from '../types/models';
import { mockEvents } from '../data/events';
import { filterPulse } from '../lib/recommend';
import { resolveStatus } from '../lib/availability';
import { useAvailabilityStore } from '../context/AvailabilityStore';
import { freshToken } from '../services/apiToken';
export { mapApiEvent, fetchCityEvents, resolveEventsOnSuccess, resolveEventsOnError } from './cityPulseUtils';
import { fetchCityEvents, resolveEventsOnSuccess, resolveEventsOnError } from './cityPulseUtils';

/** How long fetched events are considered fresh before a background re-fetch fires. */
const TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How long to wait for the city slug to settle before firing a fetch request.
 * Absorbs rapid picker changes without hammering the API. */
const DEBOUNCE_MS = 150;

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';


export function useAvailability() {
  const { availability } = useAvailabilityStore();
  return { availability, loading: false, error: null };
}

export function useCityPulse({
  currentCitySlug,
  interests,
  categoryAffinities,
  ttlMs = TTL_MS,
}: {
  currentCitySlug?: string;
  interests?: Interest[];
  /**
   * Learned category affinities from the Telegraph preference engine.
   * Pass the `inferred.categoryAffinities` value from GET /api/me/preferences.
   * When provided, these nudge ranking for each visit after the user has
   * interacted with recommendations — making the pulse improve over time.
   */
  categoryAffinities?: Record<string, number>;
  /**
   * How long fetched events are considered fresh before a background re-fetch
   * fires automatically. Defaults to TTL_MS (5 minutes). Pass a shorter value
   * in tests or high-frequency contexts; pass a longer value to reduce traffic
   * when events are unlikely to change (e.g. late-night hours).
   */
  ttlMs?: number;
}) {
  const { availability } = useAvailability();
  // Production: start with empty list and show real events only.
  // Dev only: fall back to mockEvents so the screen isn't blank during development.
  const [events, setEvents] = useState<CityEvent[]>([]);

  useEffect(() => {
    const city = currentCitySlug?.replace(/-/g, ' ') ?? '';
    if (!city) return;
    const base = apiBase();
    if (!base) {
      if (__DEV__) setEvents(mockEvents);
      return;
    }

    // Clear stale events immediately so the previous city's events are never
    // shown under the new city's name while the debounce or fetch is in flight.
    setEvents([]);

    let cancelled = false;
    let ttlTimer: ReturnType<typeof setTimeout>;

    function doFetch() {
      freshToken().then((token) => {
        if (!token || cancelled) {
          if (__DEV__) setEvents(mockEvents);
          return;
        }
        fetchCityEvents(base, token, city, currentCitySlug ?? '')
          .then((fetched) => {
            if (cancelled) return;
            setEvents(resolveEventsOnSuccess(fetched));
            // Schedule a background re-fetch once the TTL expires so events
            // stay fresh without requiring the user to pull-to-refresh.
            ttlTimer = setTimeout(doFetch, ttlMs);
          })
          .catch(() => {
            if (cancelled) return;
            setEvents(resolveEventsOnError(__DEV__, mockEvents));
          });
      });
    }

    // Debounce: wait before triggering the fetch so rapid city-slug changes
    // (e.g. scrolling through a city picker) only trigger one request for the
    // final settled value.
    const debounceTimer = setTimeout(doFetch, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(debounceTimer);
      clearTimeout(ttlTimer);
    };
  }, [currentCitySlug, ttlMs]);

  const buckets: PulseBuckets = useMemo(
    () => filterPulse(events, {
      availability,
      currentCitySlug,
      interests,
      categoryAffinities,
    }),
    [events, availability, currentCitySlug, interests, categoryAffinities],
  );

  const status = resolveStatus(availability, new Date().toISOString(), currentCitySlug);
  return { buckets, availability, status, loading: false, error: null };
}
