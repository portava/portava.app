/**
 * Backend hooks. Same {data, loading, error} shape as the existing mock hooks,
 * so screens can swap import source with minimal churn. When Supabase isn't
 * configured these return empty/false so the app still runs on mock screens.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { getSessionUserId, onAuthChange } from '../services/auth.ts';
import { listMyTrips, getTrip, type TripRow, getPendingTripInvites, type TripInvite } from '../services/trips.ts';

export function useSession() {
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getSessionUserId().then((uid) => { if (active) { setUserId(uid); setLoading(false); } });
    const unsub = onAuthChange((uid) => { if (active) setUserId(uid); });
    return () => { active = false; unsub(); };
  }, []);

  return { userId, isAuthed: Boolean(userId), loading, configured: isSupabaseConfigured };
}

export function useMyTrips({ enabled = true }: { enabled?: boolean } = {}) {
  const generation = useRef(0);
  const [data, setData] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const request = ++generation.current;
    // Waiting for authentication is not a completed empty read. Keep consumers
    // from replacing their snapshot until an enabled request actually finishes.
    if (!enabled) { setData([]); setError(null); setLoading(true); return; }
    setLoading(true); setError(null);
    try {
      const trips = await listMyTrips();
      if (request === generation.current) setData(trips);
    } catch (e: any) {
      if (request === generation.current) setError(e?.message ?? 'Failed to load trips');
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => { void reload(); return () => { generation.current += 1; }; }, [reload]);

  return { data, loading, error, reload };
}

export function useTrip(id: string | undefined) {
  const [data, setData] = useState<TripRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!id) { setLoading(false); return; }
    setLoading(true); setError(null);
    getTrip(id)
      .then((t) => { if (active) setData(t); })
      .catch((e) => { if (active) setError(e?.message ?? 'Failed to load trip'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id]);

  const reload = useCallback(() => {
    if (!id) return;
    setLoading(true); setError(null);
    getTrip(id)
      .then((t) => setData(t))
      .catch((e) => setError(e?.message ?? 'Failed to load trip'))
      .finally(() => setLoading(false));
  }, [id]);

  return { data, loading, error, reload };
}

export function usePendingTripInvites() {
  const [invites, setInvites] = useState<TripInvite[]>([]);
  const [loading, setLoading] = useState(true);
  // `error` exists because `invites: []` is a claim — "nobody has invited you"
  // — and this hook used to make it out of a request that failed. The two
  // states are now distinct and a consumer that shows an empty state has to
  // check which one it is looking at.
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setInvites(await getPendingTripInvites());
    } catch (e: any) {
      setInvites([]);
      setError(e?.message ?? 'Could not load your trip invites');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { invites, loading, error, reload };
}
