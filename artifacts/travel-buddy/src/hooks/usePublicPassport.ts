/**
 * usePublicPassport — loads a public passport by username.
 * Returns { profile, postcards, loading, error, isPrivate, isFriend,
 *           friendRequestPending, notFound, isBlocked, blockedTargetId }.
 *
 * Sentinel shapes from GET /api/users/:username/passport:
 *   { unavailable: true }                → notFound: true  (deleted / deactivated / banned)
 *   { blocked: true, targetId?: string } → isBlocked: true (block relationship either direction)
 *   { visibility: "private", ... }       → isPrivate: true (limited_preview for non-follower);
 *                                           is_friend / friend_request_pending attached by server
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
  /**
   * True when the server confirmed the viewer is already friends with the
   * target.  In this case the private wall should not be shown even if
   * isPrivate is true (defensive guard — server normally returns the full
   * profile for friends).
   */
  isFriend: boolean;
  /**
   * True when the viewer has already sent a friend request that is still
   * pending.  The private wall shows "Request sent" (disabled) instead of
   * "Send Request" when this is true.
   */
  friendRequestPending: boolean;
  /**
   * The target user's ID extracted from the private sentinel response.
   * Available even when `profile` is null (private wall case) so the UI
   * can call followUser() without waiting for the social profile load.
   */
  privateProfileId: string | null;
  notFound: boolean;
  isBlocked: boolean;
  blockedTargetId: string | null;
}

export function usePublicPassport(username: string): PublicPassportState {
  const [state, setState] = useState<PublicPassportState>({
    profile: null, postcards: [], loading: true, error: null,
    isPrivate: false, isFriend: false, friendRequestPending: false,
    privateProfileId: null, notFound: false, isBlocked: false, blockedTargetId: null,
  });

  useEffect(() => {
    if (!username) return;
    let alive = true;
    setState({
      profile: null, postcards: [], loading: true, error: null,
      isPrivate: false, isFriend: false, friendRequestPending: false,
      privateProfileId: null, notFound: false, isBlocked: false, blockedTargetId: null,
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
      // The server attaches is_friend / friend_request_pending so the client
      // can show the correct CTA without a second round-trip.
      if (d && (d.visibility === 'private' || d.private === true)) {
        setState((s) => ({
          ...s,
          loading: false,
          isPrivate: true,
          isFriend: d.is_friend === true,
          friendRequestPending: d.friend_request_pending === true,
          privateProfileId: typeof d.id === 'string' ? d.id : null,
        }));
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
