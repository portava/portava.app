/**
 * usePublicPassport — loads a public passport by username.
 * Returns { profile, postcards, loading, error, isPrivate, notFound }.
 */
import { useState, useEffect } from 'react';
import type { PublicProfile, PassportPostcard } from '../types/models';
import { getPublicPassport, getPublicPostcards } from '../services/profile';

export interface PublicPassportState {
  profile: PublicProfile | null;
  postcards: PassportPostcard[];
  loading: boolean;
  error: string | null;
  isPrivate: boolean;
  notFound: boolean;
}

export function usePublicPassport(username: string): PublicPassportState {
  const [state, setState] = useState<PublicPassportState>({
    profile: null, postcards: [], loading: true, error: null, isPrivate: false, notFound: false,
  });

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setState({ profile: null, postcards: [], loading: true, error: null, isPrivate: false, notFound: false });

    getPublicPassport(username).then(async (res) => {
      if (!alive) return;
      if (!res.ok) {
        if (res.errorKind === 'not_found') {
          setState((s) => ({ ...s, loading: false, notFound: true }));
        } else {
          setState((s) => ({ ...s, loading: false, error: res.message ?? 'Failed to load passport' }));
        }
        return;
      }
      if (res.data && 'private' in res.data) {
        setState((s) => ({ ...s, loading: false, isPrivate: true }));
        return;
      }
      const profile = res.data as PublicProfile;
      setState((s) => ({ ...s, profile, loading: false }));

      const pcRes = await getPublicPostcards(username);
      if (alive) {
        setState((s) => ({ ...s, postcards: pcRes.ok ? (pcRes.data ?? []) : [] }));
      }
    }).catch(() => {
      if (alive) setState((s) => ({ ...s, loading: false, error: 'Failed to load passport' }));
    });

    return () => { alive = false; };
  }, [username]);

  return state;
}
