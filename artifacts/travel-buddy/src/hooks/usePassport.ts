/**
 * usePassport — loads the owner's full passport data.
 * Calls GET /api/me/profile + GET /api/me/passport/postcards + GET /api/stamps/me
 * + GET /api/me/passport/memories + GET /api/me/passport/suggestions in parallel.
 *
 * Stamps: a SINGLE paginated pipeline (GET /api/stamps/me) feeds every stamp
 * consumer on the passport screen — the Stamps grid (v2 shape with artwork),
 * the stamp-collection preview and full view (legacy shape via toLegacyStamp),
 * and the Destinations grouping. This replaces the old dual pipeline where
 * usePassport paged /api/me/passport/stamps while StampsTab separately paged
 * /api/stamps/me, downloading the same stamps twice.
 *
 * Falls back to mock data if backend is not configured.
 */
import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import type { OwnProfile, PassportPostcard, PassportStamp } from '../types/models.ts';
import type { PassportMemory, PassportStampNew } from '../services/passportStamps.ts';
import { useSnapshotCache } from './useSnapshotCache.ts';
import { getMyProfile, getMyPassportPostcards } from '../services/profile.ts';
import { getMyPassportMemories, getMyPassportSuggestions, getMyPassportStamps } from '../services/passportStamps.ts';
import { toLegacyStamp } from '../services/passportStampMappers.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { mockPassport } from '../data/passport.ts';

export interface PassportState {
  profile: OwnProfile | null;
  postcards: PassportPostcard[];
  /** Legacy-shaped stamps derived from stampsNew (single fetch pipeline). */
  stamps: PassportStamp[];
  /** v2 stamps (with definitions/artwork) — the canonical fetched list. */
  stampsNew: PassportStampNew[];
  memories: PassportMemory[];
  suggestions: PassportMemory[];
  loading: boolean;
  error: string | null;
  /** Server-reported total stamp count — the pagination sentinel. */
  stampsTotal: number;
  /** True while a next-page stamps fetch is in flight. */
  loadingMoreStamps: boolean;
  /** Fetch the next page of stamps (no-op when all loaded or already fetching). */
  loadMoreStamps: () => void;
  /** Replace one stamp in the shared list (e.g. after a visibility change). */
  updateStamp: (updated: PassportStampNew) => void;
  reload: () => void;
  /** Ref stamped with Date.now() only after a successful fetch. Stays 0 until
   *  the first successful load. Screens use this for focus-TTL guards so that
   *  a failed reload does NOT silence subsequent retry attempts. */
  lastLoadedAt: MutableRefObject<number>;
}

/** Shape stored in the AsyncStorage snapshot for stale-while-revalidate. */
type PassportSnapshot = {
  profile: OwnProfile;
  postcards: PassportPostcard[];
  /** v2 stamps — legacy shape is derived on apply. */
  stamps: PassportStampNew[];
  memories: PassportMemory[];
};

export function usePassport(): PassportState {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [postcards, setPostcards] = useState<PassportPostcard[]>([]);
  const [stamps, setStamps] = useState<PassportStamp[]>([]);
  const [stampsNew, setStampsNew] = useState<PassportStampNew[]>([]);
  const [memories, setMemories] = useState<PassportMemory[]>([]);
  const [suggestions, setSuggestions] = useState<PassportMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stampsTotal, setStampsTotal] = useState(0);
  const [loadingMoreStamps, setLoadingMoreStamps] = useState(false);
  // Refs mirror stamps/total so loadMoreStamps has no stale closures and can
  // guard against concurrent fetches.
  const stampsRef = useRef<PassportStampNew[]>([]);
  const stampsTotalRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const [tick, setTick] = useState(0);
  // Ref tracks whether we already have data — always current, no stale closure.
  const hasDataRef = useRef(false);
  if (profile !== null) hasDataRef.current = true;
  // Ref tracks whether a previous fetch attempt ended in an error.
  // Once set, subsequent reload()s do NOT show the full-screen loading spinner —
  // the error-branch PassportContent stays mounted so useFocusEffect cannot
  // trigger an unmount→mount→focus cycle that would create an infinite loop.
  const hadErrorRef = useRef(false);
  // Stamped with Date.now() only after a successful profile fetch so focus-TTL
  // guards can't be silenced by a failed reload.
  const lastLoadedAt = useRef(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  /** Single place the stamp list is written — keeps the v2 list, the derived
   *  legacy list, and the pagination ref in lockstep. */
  const applyStamps = useCallback((list: PassportStampNew[]) => {
    stampsRef.current = list;
    setStampsNew(list);
    setStamps(list.map(toLegacyStamp));
  }, []);

  const updateStamp = useCallback((updated: PassportStampNew) => {
    applyStamps(stampsRef.current.map((s) => (s.id === updated.id ? updated : s)));
  }, [applyStamps]);

  const loadMoreStamps = useCallback(() => {
    if (loadingMoreRef.current) return;
    // Sentinel: server-reported total. When we already have everything, stop.
    if (stampsRef.current.length >= stampsTotalRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMoreStamps(true);
    getMyPassportStamps({ offset: stampsRef.current.length })
      .then((res) => {
        if (res.ok && res.data && res.data.length > 0) {
          applyStamps([...stampsRef.current, ...res.data]);
        }
        if (typeof res.total === 'number') {
          stampsTotalRef.current = res.total;
          setStampsTotal(res.total);
        } else if (!res.ok || !res.data || res.data.length === 0) {
          // Defensive: an empty/failed page without a total would otherwise
          // retry forever — clamp the sentinel to what we have.
          stampsTotalRef.current = stampsRef.current.length;
          setStampsTotal(stampsRef.current.length);
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMoreStamps(false);
      });
  }, [applyStamps]);

  // Stale-while-revalidate: pre-populate from AsyncStorage so the passport
  // content paints immediately on second+ opens before the network resolves.
  // Key bumped to passport-v2 when the snapshot's stamps switched to the v2
  // shape — old `passport` snapshots (legacy-shaped stamps) are ignored.
  const { snapshot: passportSnapshot, save: savePassportSnapshot } = useSnapshotCache<PassportSnapshot>('passport-v2');

  // Apply snapshot data the first time it arrives from AsyncStorage.
  // Skipped once real data has loaded (hasDataRef.current = true).
  useEffect(() => {
    if (!passportSnapshot || hasDataRef.current) return;
    setProfile(passportSnapshot.profile);
    setPostcards(passportSnapshot.postcards);
    applyStamps(passportSnapshot.stamps);
    stampsTotalRef.current = passportSnapshot.stamps.length;
    setStampsTotal(passportSnapshot.stamps.length);
    setMemories(passportSnapshot.memories);
    setLoading(false);
  }, [passportSnapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    // Only show the full-screen spinner on the very first load attempt.
    // Subsequent reloads (focus events) and retries after an error refresh
    // silently in the background — PassportContent stays mounted throughout.
    if (!hasDataRef.current && !hadErrorRef.current) setLoading(true);
    setError(null);

    if (!isSupabaseConfigured) {
      // No backend: return mock data so UI still works.
      const mock = mockPassport;
      const mockProfile: OwnProfile = {
        id: mock.user.id,
        handle: mock.user.handle,
        name: mock.user.name,
        displayName: mock.user.name,
        username: mock.user.handle,
        bio: mock.user.bio ?? null,
        avatarUrl: mock.user.avatarUrl,
        homeCity: mock.user.homeCity,
        homeCountry: mock.user.homeCountry,
        currentCity: mock.user.currentCity ?? null,
        travelStyle: mock.user.travelStyle,
        interests: mock.user.interests,
        verified: mock.user.verified,
        verificationStatus: mock.user.verified ? 'verified' : 'unverified',
        verifiedAt: mock.user.verified ? '2026-06-01T00:00:00Z' : null,
        openToMeet: mock.user.openToMeet,
        isPrivate: mock.user.isPrivate,
        passportVisibility: 'public',
        coverPhotoUrl: null,
        usernameUpdatedAt: null,
        createdAt: '2024-05-01T00:00:00Z',
        spokenLanguages: [],
        defaultLanguage: null,
        travelStyles: [],
        travelPace: null,
        budgetStyle: null,
        travelGroupStyle: [],
        lookingFor: [],
        comfortLevel: null,
        availabilityTags: [],
        planningStyle: null,
        publicSocialLinks: {},
        preferredLanguage: null,
        dateOfBirth: null,
        dobVerified: false,
        trustScore: mock.user.verified ? 92 : null,
        trustLabel: mock.user.verified ? 'Trusted Traveler' : null,
        verificationLevel: mock.user.verified ? 'trusted_traveler' : 'none',
        idVerifiedAt: mock.user.verified ? '2026-06-01T00:00:00Z' : null,
        selfieVerifiedAt: mock.user.verified ? '2026-06-01T00:00:00Z' : null,
        homeCountryVerifiedAt: mock.user.verified ? '2026-06-01T00:00:00Z' : null,
        safetyFlagsCount: 0,
        followersCount: 420,
        followingCount: 180,
        tripCount: 78,
        hostVerifiedAt: null,
        buddyVerifiedAt: null,
      };
      setTimeout(() => {
        if (alive) {
          setProfile(mockProfile);
          setPostcards([]);
          // Mock stamps are legacy-shaped; there is no v2 mock data.
          setStamps(mock.stamps ?? []);
          setStampsNew([]);
          stampsRef.current = [];
          stampsTotalRef.current = 0;
          setStampsTotal((mock.stamps ?? []).length);
          setMemories([]);
          setSuggestions([]);
          lastLoadedAt.current = Date.now();
          setLoading(false);
        }
      }, 0);
      return () => { alive = false; };
    }

    Promise.all([
      getMyProfile(),
      getMyPassportPostcards(),
      getMyPassportStamps(),
      getMyPassportMemories(),
      getMyPassportSuggestions(),
    ]).then(([pRes, pcRes, stRes, memRes, sugRes]) => {
      if (!alive) return;
      if (pRes.ok && pRes.data) {
        hadErrorRef.current = false;
        lastLoadedAt.current = Date.now();
        setProfile(pRes.data as OwnProfile);
      } else {
        hadErrorRef.current = true;
        setError(pRes.message ?? 'Could not load profile');
      }
      setPostcards(pcRes.ok ? (pcRes.data ?? []) : []);
      const firstPage = stRes.ok ? (stRes.data ?? []) : [];
      applyStamps(firstPage);
      const total = stRes.ok && typeof stRes.total === 'number' ? stRes.total : firstPage.length;
      stampsTotalRef.current = total;
      setStampsTotal(total);
      setMemories(memRes.ok ? memRes.data : []);
      setSuggestions(sugRes.ok ? sugRes.data : []);
      setLoading(false);
      // Persist snapshot for stale-while-revalidate on next open.
      if (pRes.ok && pRes.data) {
        savePassportSnapshot({
          profile: pRes.data as OwnProfile,
          postcards: pcRes.ok ? (pcRes.data ?? []) : [],
          stamps: firstPage,
          memories: memRes.ok ? memRes.data : [],
        });
      }
    }).catch(() => {
      if (!alive) return;
      hadErrorRef.current = true;
      setError('Failed to load passport');
      setLoading(false);
    });

    return () => { alive = false; };
  }, [tick]);

  return { profile, postcards, stamps, stampsNew, memories, suggestions, loading, error, stampsTotal, loadingMoreStamps, loadMoreStamps, updateStamp, reload, lastLoadedAt };
}
