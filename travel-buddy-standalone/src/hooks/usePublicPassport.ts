/**
 * usePublicPassport — loads a public passport by username.
 * Returns { profile, postcards, loading, error, isPrivate, notFound, isBlocked, blockedTargetId }.
 *
 * Sentinel shapes from GET /api/users/:username/passport:
 *   { unavailable: true }                → notFound: true  (deleted / deactivated / banned)
 *   { blocked: true, targetId?: string } → isBlocked: true (block relationship either direction)
 *   { visibility: "private", ... }       → isPrivate: true (limited_preview for non-follower)
 *   { ...full profile }                  → profile set, normal render
 */
import { useState, useEffect } from 'react';
import type { PublicProfile, PassportPostcard } from '../types/models.ts';
import { getPublicPassport, getPublicPostcards } from '../services/profile.ts';

export interface PublicPassportState {
  profile: PublicProfile | null;
  postcards: PassportPostcard[];
  loading: boolean;
  error: string | null;
  isPrivate: boolean;
  notFound: boolean;
  isBlocked: boolean;
  blockedTargetId: string | null;
}

export function usePublicPassport(username: string): PublicPassportState {
  const [state, setState] = useState<PublicPassportState>({
    profile: null, postcards: [], loading: true, error: null,
    isPrivate: false, notFound: false, isBlocked: false, blockedTargetId: null,
  });

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setState({
      profile: null, postcards: [], loading: true, error: null,
      isPrivate: false, notFound: false, isBlocked: false, blockedTargetId: null,
    });

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

      const d = res.data as any;

      // Sentinel: deleted / deactivated / banned account.
      if (d && d.unavailable === true) {
        setState((s) => ({ ...s, loading: false, notFound: true }));
        return;
      }

      // Sentinel: blocked relationship (either direction).
      // isBlocked: true lets the screen show the block UI.
      // blockedTargetId is used by handleUnblock; the screen's loadSocial
      // also independently resolves the direction (iBlockedThem) via getBlockStatus.
      if (d && d.blocked === true) {
        setState((s) => ({
          ...s,
          loading: false,
          isBlocked: true,
          blockedTargetId: typeof d.targetId === 'string' ? d.targetId : null,
        }));
        return;
      }

      // Sentinel: private profile (passport endpoint returns visibility: "private").
      // Also handles the legacy { private: true } shape for forwards-compat.
      if (d && (d.visibility === 'private' || d.private === true)) {
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
