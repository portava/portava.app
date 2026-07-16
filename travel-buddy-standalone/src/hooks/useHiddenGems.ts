/**
 * useHiddenGems — React hooks for the Hidden Gems feature.
 * All hooks poll/cache via useState + useEffect; no external state library needed.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  listGems,
  getGem,
  getSavedGems,
  saveGem,
  unsaveGem,
  verifyGemVisit,
  reportGem,
  getTripcityGems,
  getLayoverGems,
  type HiddenGem,
  type ListGemsOptions,
  type GuideProfile,
} from '../services/hiddenGems.ts';

// ── useGemList ─────────────────────────────────────────────────────────────────

export function useGemList(opts: ListGemsOptions = {}) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const key = JSON.stringify(opts);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGems(await listGems(opts));
    } catch (e: any) {
      setError(e.message ?? 'Failed to load gems');
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
}

// ── useGemDetail ───────────────────────────────────────────────────────────────

export function useGemDetail(gemId: string, tripId?: string) {
  const [gem, setGem]                 = useState<HiddenGem | null>(null);
  const [savedByMe, setSavedByMe]     = useState(false);
  const [guideProfile, setGuideProfile] = useState<GuideProfile | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!gemId) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getGem(gemId, tripId);
      setGem(data.gem);
      setSavedByMe(data.savedByMe);
      setGuideProfile(data.guideProfile);
    } catch (e: any) {
      setError(e.message ?? 'Failed to load gem');
    } finally {
      setLoading(false);
    }
  }, [gemId, tripId]);

  useEffect(() => { load(); }, [load]);

  const toggleSave = useCallback(async () => {
    if (!gem) return;
    try {
      if (savedByMe) {
        await unsaveGem(gem.id);
        setSavedByMe(false);
        setGem((g) => g ? { ...g, saveCount: Math.max(0, g.saveCount - 1) } : g);
      } else {
        await saveGem(gem.id);
        setSavedByMe(true);
        setGem((g) => g ? { ...g, saveCount: g.saveCount + 1 } : g);
      }
    } catch { /* ignore */ }
  }, [gem, savedByMe]);

  return { gem, savedByMe, guideProfile, loading, error, refresh: load, toggleSave };
}

// ── useSavedGems ───────────────────────────────────────────────────────────────

export function useSavedGems() {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setGems(await getSavedGems()); }
    catch (e: any) { setError(e.message ?? 'Failed to load saved gems'); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
}

// ── useTripCityGems ────────────────────────────────────────────────────────────

export function useTripCityGems(tripId: string) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tripId) return;
    setLoading(true);
    setError(null);
    try { setGems(await getTripcityGems(tripId)); }
    catch (e: any) { setError(e.message ?? 'Failed to load trip gems'); }
    finally { setLoading(false); }
  }, [tripId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
}

// ── useLayoverGems ─────────────────────────────────────────────────────────────

export function useLayoverGems(availableMinutes: number, city?: string) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!availableMinutes) return;
    setLoading(true);
    getLayoverGems(availableMinutes, city)
      .then(setGems)
      .catch(() => setGems([]))
      .finally(() => setLoading(false));
  }, [availableMinutes, city]);

  return { gems, loading };
}

// ── useGemCheckin ──────────────────────────────────────────────────────────────

export function useGemCheckin() {
  const [loading, setLoading]   = useState(false);
  const [result, setResult]     = useState<Awaited<ReturnType<typeof verifyGemVisit>> | null>(null);

  const checkin = useCallback(async (
    gemId: string,
    lat: number,
    lng: number,
    tripId?: string,
  ) => {
    setLoading(true);
    try {
      const r = await verifyGemVisit(gemId, lat, lng, tripId);
      setResult(r);
      return r;
    } finally {
      setLoading(false);
    }
  }, []);

  return { checkin, loading, result };
}

// ── useGemReport ───────────────────────────────────────────────────────────────

export function useGemReport() {
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);

  const report = useCallback(async (gemId: string, reason: string, notes?: string) => {
    setLoading(true);
    try {
      await reportGem(gemId, reason, notes);
      setDone(true);
    } finally {
      setLoading(false);
    }
  }, []);

  return { report, loading, done };
}
