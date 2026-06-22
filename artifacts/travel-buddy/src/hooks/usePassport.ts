/**
 * usePassport — loads the owner's full passport data.
 * Calls GET /api/me/profile + GET /api/me/passport/postcards + GET /api/me/stamps in parallel.
 * Falls back to mock data if backend is not configured.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { OwnProfile, PassportPostcard, PassportStamp } from '../types/models';
import { getMyProfile, getMyPassportPostcards, getMyStamps } from '../services/profile';
import { isSupabaseConfigured } from '../lib/supabase';
import { mockPassport } from '../data/passport';

export interface PassportState {
  profile: OwnProfile | null;
  postcards: PassportPostcard[];
  stamps: PassportStamp[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function usePassport(): PassportState {
  const [profile, setProfile] = useState<OwnProfile | null>(null);
  const [postcards, setPostcards] = useState<PassportPostcard[]>([]);
  const [stamps, setStamps] = useState<PassportStamp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Ref tracks whether we already have data — always current, no stale closure.
  const hasDataRef = useRef(false);
  if (profile !== null) hasDataRef.current = true;

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let alive = true;
    // Only show the full-screen spinner on initial load — subsequent reloads
    // refresh silently so PassportContent stays mounted and avoids an infinite
    // focus-effect → reload → unmount → mount → focus-effect loop.
    if (!hasDataRef.current) setLoading(true);
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
        verifiedAt: null,
        openToMeet: mock.user.openToMeet,
        isPrivate: mock.user.isPrivate,
        passportVisibility: 'public',
        coverPhotoUrl: null,
        usernameUpdatedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
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
      };
      setTimeout(() => {
        if (alive) {
          setProfile(mockProfile);
          setPostcards([]);
          setStamps(mock.stamps ?? []);
          setLoading(false);
        }
      }, 0);
      return () => { alive = false; };
    }

    Promise.all([getMyProfile(), getMyPassportPostcards(), getMyStamps()]).then(([pRes, pcRes, stRes]) => {
      if (!alive) return;
      if (pRes.ok && pRes.data) setProfile(pRes.data as OwnProfile);
      else setError(pRes.message ?? 'Could not load profile');
      setPostcards(pcRes.ok ? (pcRes.data ?? []) : []);
      setStamps(stRes.ok ? (stRes.data ?? []) : []);
      setLoading(false);
    }).catch(() => {
      if (!alive) return;
      setError('Failed to load passport');
      setLoading(false);
    });

    return () => { alive = false; };
  }, [tick]);

  return { profile, postcards, stamps, loading, error, reload };
}
