/**
 * useHiddenGems — React hooks for the Hidden Gems feature.
 * All hooks poll/cache via useState + useEffect; no external state library needed.
 *
 * census-discovery §112 (DV-83 round 15, D-W11X2-123, D-W11X2-124): every read hook keeps only the answer to its
 * LATEST request (a request id), never shows a previous query's rows while a new one is read, and keeps a failed
 * read as an error — never as an empty list.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  listGems,
  getGem,
  getSavedGems,
  saveGem,
  unsaveGem,
  verifyGemVisit,
  reportGem,
  getTripcityGems,
  getLayoverGems, listNearbyGems, type GemCategory,  // listNearbyGems: census-discovery §113 (D-W11X2-131)
  type HiddenGem,
  type ListGemsOptions,
  type GuideProfile,
} from '../services/hiddenGems.ts';
import { gemListCut } from '../services/gemListCut.ts';  // census-discovery §114 (sweep SW1)

// ── useGemList ─────────────────────────────────────────────────────────────────

export function useGemList(opts: ListGemsOptions = {}) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null); const [truncated, setTruncated] = useState(false);  // census-discovery §114 (sweep SW1): the server cut the list

  const key = JSON.stringify(opts);
  const latest = useRef(0);
  const shownKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const req = ++latest.current;
    if (shownKey.current !== key) { shownKey.current = key; setGems([]); setTruncated(false); }
    setLoading(true);
    setError(null);
    try {
      const next = await listGems(opts);
      if (req === latest.current) { setGems(next); setTruncated(gemListCut(next)); }
    } catch (e: any) {
      if (req === latest.current) setError(e.message ?? 'Failed to load gems');
    } finally {
      if (req === latest.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh, truncated };
}

// ── useGemDetail ───────────────────────────────────────────────────────────────

export function useGemDetail(gemId: string, tripId?: string) {
  const [gem, setGem]                 = useState<HiddenGem | null>(null);
  const [savedByMe, setSavedByMe]     = useState(false);
  const [guideProfile, setGuideProfile] = useState<GuideProfile | null>(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const latest = useRef(0);
  const shownKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!gemId) return;
    const req = ++latest.current;
    const key = `${gemId}|${tripId ?? ''}`;
    if (shownKey.current !== key) { shownKey.current = key; setGem(null); setSavedByMe(false); setGuideProfile(null); }
    setLoading(true);
    setError(null);
    try {
      const data = await getGem(gemId, tripId);
      if (req !== latest.current) return;
      setGem(data.gem);
      setSavedByMe(data.savedByMe);
      setGuideProfile(data.guideProfile);
    } catch (e: any) {
      if (req === latest.current) setError(e.message ?? 'Failed to load gem');
    } finally {
      if (req === latest.current) setLoading(false);
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
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    const req = ++latest.current;
    setLoading(true);
    setError(null);
    try { const next = await getSavedGems(); if (req === latest.current) setGems(next); }
    catch (e: any) { if (req === latest.current) setError(e.message ?? 'Failed to load saved gems'); }
    finally { if (req === latest.current) setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
}

// ── useTripCityGems ────────────────────────────────────────────────────────────

export function useTripCityGems(tripId: string) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const latest = useRef(0);
  const shownKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tripId) return;
    const req = ++latest.current;
    if (shownKey.current !== tripId) { shownKey.current = tripId; setGems([]); }
    setLoading(true);
    setError(null);
    try { const next = await getTripcityGems(tripId); if (req === latest.current) setGems(next); }
    catch (e: any) { if (req === latest.current) setError(e.message ?? 'Failed to load trip gems'); }
    finally { if (req === latest.current) setLoading(false); }
  }, [tripId]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
}

// ── useLayoverGems ─────────────────────────────────────────────────────────────

export function useLayoverGems(availableMinutes: number, city?: string) {
  const [gems, setGems]       = useState<HiddenGem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const latest = useRef(0);

  const refresh = useCallback(async () => {
    if (!availableMinutes) return;
    const req = ++latest.current;
    setLoading(true);
    setError(null);
    try { const next = await getLayoverGems(availableMinutes, city); if (req === latest.current) setGems(next); }
    catch (e: any) {
      // census-discovery §112 (D-W11X2-123): a failed read is an error the screen says, never "no quick gems nearby".
      if (req === latest.current) { setGems([]); setError(e?.message ?? 'Failed to load layover gems'); }
    }
    finally { if (req === latest.current) setLoading(false); }
  }, [availableMinutes, city]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, loading, error, refresh };
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

// ── useNearbyGems ──────────────────────────────────────────────────────────────

/**
 * Gems near the viewer, read from the server (census-discovery §113, DV-83, D-W11X2-131). Idle (no rows, not
 * loading) until there is a position. Like the hooks above it keeps only its latest request's answer, clears the
 * previous position's or category's rows when the query changes, and keeps a failed read as an error. `truncated`
 * says the server cut its scan or its list: the screen must never say "none" over it.
 */
export function useNearbyGems(coords: { lat: number; lng: number } | null, category?: GemCategory, radiusKm = 50) {
  const [gems, setGems]           = useState<HiddenGem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const key = coords ? `${coords.lat}:${coords.lng}:${category ?? ''}:${radiusKm}` : null;
  const latest = useRef(0);
  const shownKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const req = ++latest.current;
    if (shownKey.current !== key) { shownKey.current = key; setGems([]); setTruncated(false); }
    if (!coords) { setLoading(false); setError(null); return; }
    setLoading(true);
    setError(null);
    try {
      const next = await listNearbyGems(coords.lat, coords.lng, radiusKm, category);
      if (req === latest.current) { setGems(next.gems); setTruncated(next.truncated); }
    } catch (e: any) {
      if (req === latest.current) { setGems([]); setTruncated(false); setError(e?.message ?? 'Failed to load gems near you'); }
    } finally {
      if (req === latest.current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => { refresh(); }, [refresh]);

  return { gems, truncated, loading, error, refresh };
}
