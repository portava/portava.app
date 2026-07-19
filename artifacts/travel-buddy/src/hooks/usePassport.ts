/**
 * usePassport — loads the owner's full passport data.
 * Calls GET /api/me/profile + GET /api/me/passport/postcards + GET /api/me/stamps
 * + GET /api/me/passport/memories + GET /api/me/passport/suggestions in parallel.
 * Falls back to mock data if backend is not configured.
 */
import { useState, useEffect, useCallback, useRef, type MutableRefObject } from 'react';
import type { OwnProfile, PassportPostcard, PassportStamp } from '../types/models.ts';
import type { PassportMemory } from '../services/passportStamps.ts';
import { useSnapshotCache } from './useSnapshotCache.ts';
import { getMyProfile, getMyPassportPostcards, getMyStamps } from '../services/profile.ts';
import { getMyPassportMemories, getMyPassportSuggestions } from '../services/passportStamps.ts';
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { mockPassport } from '../data/passport.ts';

export interface PassportState {
  profile: OwnProfile | null;
  postcards: PassportPostcard[];
  stamps: PassportStamp[];
  memories: PassportMemory[];
  suggestions: PassportMemory[];
  loading: boolean;
  error: string | null;
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
  stamps: PassportStamp[];
  memories: PassportMemory[];
};

export function usePassport(): PassportState {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [postcards, setPostcards] = useState<PassportPostcard[]>([]);
  const [stamps, setStamps] = useState<PassportStamp[]>([]);
  const [memories, setMemories] = useState<PassportMemory[]>([]);
  const [suggestions, setSuggestions] = useState<PassportMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

  // Stale-while-revalidate: pre-populate from AsyncStorage so the passport
  // content paints immediately on second+ opens before the network resolves.
  const { snapshot: passportSnapshot, save: savePassportSnapshot } = useSnapshotCache<PassportSnapshot>('passport');

  // Apply snapshot data the first time it arrives from AsyncStorage.
  // Skipped once real data has loaded (hasDataRef.current = true).
  useEffect(() => {
    if (!passportSnapshot || hasDataRef.current) return;
    setProfile(passportSnapshot.profile);
    setPostcards(passportSnapshot.postcards);
    setStamps(passportSnapshot.stamps);
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
          setStamps(mock.stamps ?? []);
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
      getMyStamps(),
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
      setStamps(stRes.ok ? (stRes.data ?? []) : []);
      setMemories(memRes.ok ? memRes.data : []);
      setSuggestions(sugRes.ok ? sugRes.data : []);
      setLoading(false);
      // Persist snapshot for stale-while-revalidate on next open.
      if (pRes.ok && pRes.data) {
        savePassportSnapshot({
          profile: pRes.data as OwnProfile,
          postcards: pcRes.ok ? (pcRes.data ?? []) : [],
          stamps: stRes.ok ? (stRes.data ?? []) : [],
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

  return { profile, postcards, stamps, memories, suggestions, loading, error, reload, lastLoadedAt };
}
