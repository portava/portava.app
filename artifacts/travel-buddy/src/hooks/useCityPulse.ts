/**
 * useAvailability + useCityPulse — data seams.
 * Availability reads from the session store (editable); events fetch from
 * /api/events?city=... with empty-state fallback (mockEvents in __DEV__ only).
 *
 * Pure fetch/map helpers live in ./cityPulseUtils so they can be unit-tested
 * without pulling in React, Expo, or Supabase.
 */
import { useMemo, useState, useEffect } from 'react';
import type { CityEvent, PulseBuckets, Interest } from '../types/models';
import { mockEvents } from '../data/events';
import { filterPulse } from '../lib/recommend';
import { resolveStatus } from '../lib/availability';
import { useAvailabilityStore } from '../context/AvailabilityStore';
import { supabase } from '../lib/supabase';
export { mapApiEvent, fetchCityEvents, resolveEventsOnSuccess, resolveEventsOnError } from './cityPulseUtils';
import { fetchCityEvents, resolveEventsOnSuccess, resolveEventsOnError } from './cityPulseUtils';

const apiBase = () => process.env.EXPO_PUBLIC_API_BASE_URL ?? '';

async function freshToken(): Promise<string | null> {
  try {
    const { data: refreshed } = await supabase.auth.refreshSession();
    const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
    return session?.access_token ?? null;
  } catch {
    return null;
  }
}

export function useAvailability() {
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
  // Production: start with empty list and show real events only.
  // Dev only: fall back to mockEvents so the screen isn't blank during development.
  const [events, setEvents] = useState<CityEvent[]>([]);

  useEffect(() => {
    const city = opts.currentCitySlug?.replace(/-/g, ' ') ?? '';
    if (!city) return;
    const base = apiBase();
    if (!base) {
      if (__DEV__) setEvents(mockEvents);
      return;
    }

    let cancelled = false;
    freshToken().then((token) => {
      if (!token || cancelled) {
        if (__DEV__) setEvents(mockEvents);
        return;
      }
      fetchCityEvents(base, token, city, opts.currentCitySlug ?? '')
        .then((fetched) => {
          if (cancelled) return;
          setEvents(resolveEventsOnSuccess(fetched));
        })
        .catch(() => {
          if (cancelled) return;
          setEvents(resolveEventsOnError(__DEV__, mockEvents));
        });
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.currentCitySlug]);

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
