/**
 * useAvailability + useCityPulse — data seams.
 * Availability reads from the session store (editable); events fetch from
 * /api/events?city=... with empty-state fallback (mockEvents in __DEV__ only).
 */
import { useMemo, useState, useEffect } from 'react';
import type { CityEvent, PulseBuckets, Interest } from '../types/models';
import { mockEvents } from '../data/events';
import { filterPulse } from '../lib/recommend';
import { resolveStatus } from '../lib/availability';
import { useAvailabilityStore } from '../context/AvailabilityStore';
import { supabase } from '../lib/supabase';

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
      const params = new URLSearchParams({ city, state: 'open', limit: '20' });
      fetch(`${base}/api/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((data) => {
          if (cancelled) return;
          const fetched: CityEvent[] = (data?.events ?? []).map((e: any) => ({
            id:          e.id,
            title:       e.title,
            city:        e.city ?? city,
            citySlug:    e.city_slug ?? opts.currentCitySlug ?? '',
            date:        e.start_time,
            startTime:   e.start_time,
            endTime:     e.end_time ?? null,
            category:    e.category ?? 'social',
            tags:        e.tags ?? [],
            attendees:   e.attendee_count ?? 0,
            maxCapacity: e.max_capacity ?? null,
            isOpen:      e.status === 'open',
          }));
          // Only update state when the backend returned actual events.
          // If the backend returns an empty list, show nothing (not mock data) —
          // this is a valid "no events right now" state, not a failure.
          if (fetched.length > 0) {
            setEvents(fetched);
          }
          // else: leave events as [] → empty state UI is shown in production
        })
        .catch(() => {
          // Network / server error — use mockEvents in dev, empty list in prod
          if (__DEV__) setEvents(mockEvents);
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
