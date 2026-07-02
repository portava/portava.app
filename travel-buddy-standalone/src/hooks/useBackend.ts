/**
 * Backend hooks. Same {data, loading, error} shape as the existing mock hooks.
 * When Supabase isn't configured these return empty/false so the app still runs.
 */
import { useEffect, useState, useCallback } from 'react';
import { isSupabaseConfigured } from '../lib/supabase';
import { getSessionUserId, onAuthChange } from '../services/auth';
import {
  listMyTrips, getTrip,
  getPendingTripInvites, listIncomingJoinRequests,
  listTripMembers, listTripNotes, listTripChecklists, getTripBudget, getTripActivity,
  type TripRow, type TripInvite, type JoinRequest,
  type TripMember, type TripNote, type TripChecklist, type TripBudget, type TripActivityEntry,
} from '../services/trips';

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

export function usePendingTripInvites() {
  const [invites, setInvites] = useState<TripInvite[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setInvites(await getPendingTripInvites());
    } catch {
      setInvites([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { invites, loading, reload };
}

export function useIncomingJoinRequests() {
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRequests(await listIncomingJoinRequests());
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { requests, loading, reload };
}

export function useTripMembers(tripId: string | undefined) {
  const [members, setMembers] = useState<TripMember[]>([]);
  const [invited, setInvited] = useState<TripMember[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    setLoading(true);
    try {
      const result = await listTripMembers(tripId);
      setMembers(result.members);
      setInvited(result.invited);
    } catch {
      setMembers([]); setInvited([]);
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { reload(); }, [reload]);

  return { members, invited, loading, reload };
}

export function useTripNotes(tripId: string | undefined) {
  const [notes, setNotes] = useState<TripNote[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    setLoading(true);
    try { setNotes(await listTripNotes(tripId)); }
    catch { setNotes([]); }
    finally { setLoading(false); }
  }, [tripId]);

  useEffect(() => { reload(); }, [reload]);

  return { notes, loading, reload };
}

export function useTripChecklists(tripId: string | undefined) {
  const [checklists, setChecklists] = useState<TripChecklist[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tripId) { setLoading(false); return; }
    setLoading(true);
    try { setChecklists(await listTripChecklists(tripId)); }
    catch { setChecklists([]); }
    finally { setLoading(false); }
  }, [tripId]);

  useEffect(() => { reload(); }, [reload]);

  return { checklists, loading, reload };
}

export function useTripBudget(tripId: string | undefined, canView = true) {
  const [budget, setBudget] = useState<TripBudget | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tripId || !canView) { setLoading(false); return; }
    setLoading(true);
    try { setBudget(await getTripBudget(tripId)); }
    catch { setBudget(null); }
    finally { setLoading(false); }
  }, [tripId, canView]);

  useEffect(() => { reload(); }, [reload]);

  return { budget, loading, reload };
}

export function useTripActivity(tripId: string | undefined, canView = true) {
  const [activity, setActivity] = useState<TripActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!tripId || !canView) { setLoading(false); return; }
    setLoading(true);
    try { setActivity(await getTripActivity(tripId)); }
    catch { setActivity([]); }
    finally { setLoading(false); }
  }, [tripId, canView]);

  useEffect(() => { reload(); }, [reload]);

  return { activity, loading, reload };
}
