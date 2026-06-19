/**
 * Backend hooks. Same {data, loading, error} shape as the existing mock hooks,
 * so screens can swap import source with minimal churn. When Supabase isn't
 * configured these return empty/false so the app still runs on mock screens.
 */
import { useEffect, useState, useCallback } from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import { getSessionUserId, onAuthChange } from '../services/auth';
import { listMyTrips, getTrip, type TripRow } from '../services/trips';

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

export function useMyTrips() {
  const [data, setData] = useState<TripRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await listMyTrips());
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load trips');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

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

  return { data, loading, error };
}
