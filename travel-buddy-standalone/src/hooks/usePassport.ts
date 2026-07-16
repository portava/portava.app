/**
 * usePassport — loads the owner's full passport data.
 * Calls GET /api/me/profile + GET /api/me/passport/postcards + GET /api/me/stamps
 * + GET /api/me/passport/memories + GET /api/me/passport/suggestions in parallel.
 * Falls back to mock data if backend is not configured.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { OwnProfile, PassportPostcard, PassportStamp } from '../types/models.ts';
import type { PassportMemory } from '../services/passportStamps.ts';
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
}

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

  const reload = useCallback(() => setTick((t) => t + 1), []);

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
    }).catch(() => {
      if (!alive) return;
      hadErrorRef.current = true;
      setError('Failed to load passport');
      setLoading(false);
    });

    return () => { alive = false; };
  }, [tick]);

  return { profile, postcards, stamps, memories, suggestions, loading, error, reload };
}
