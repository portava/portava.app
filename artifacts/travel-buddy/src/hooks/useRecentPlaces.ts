/**
 * useRecentPlaces — fetch and save recent place selections for the authed user.
 * Falls back to a module-level in-memory list if the user is not authed or
 * the server is unavailable.
 */
import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Place } from '../lib/location/placeTypes';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data } = await supabase.auth.refreshSession();
  const session = data?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

/** Module-level cache so recents survive across modal open/close within a session */
let localCache: Place[] = [];

export function useRecentPlaces() {
  const [recents, setRecents] = useState<Place[]>(localCache);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const token = await freshToken();
      if (!token) return;
      const res = await fetch(`${apiBase()}/api/me/recent-places`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const body = await res.json();
      const places: Place[] = (body.places ?? []);
      localCache = places;
      setRecents(places);
    } catch {
      // network error — use local cache
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const saveRecent = useCallback(async (place: Place, usedFor?: string) => {
    // Optimistic local update
    localCache = [place, ...localCache.filter((p) => p.id !== place.id)].slice(0, 10);
    setRecents([...localCache]);

    try {
      const token = await freshToken();
      if (!token) return;
      await fetch(`${apiBase()}/api/me/recent-places`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ place, usedFor }),
      });
    } catch {
      // fire and forget
    }
  }, []);

  return { recents, loading, saveRecent, reload: load };
}
