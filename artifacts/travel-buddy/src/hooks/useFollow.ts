/**
 * useFollow — manages follow state and toggle for a single user.
 * Pass the target userId (null while loading); the hook fetches status
 * on mount and provides an optimistic toggle.
 *
 * Options:
 *   initialIsFollowing — when provided (e.g. from a persisted store), this
 *     value is used immediately as the starting `isFollowing` state so the
 *     icon is correct before the getFollowStatus round-trip completes.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { followUser, unfollowUser, getFollowStatus } from '../services/follows.ts';

export interface FollowState {
  isFollowing: boolean;
  followsYou: boolean;
  followersCount: number;
  followingCount: number;
  loading: boolean;
  toggling: boolean;
  /** Returns true if the toggle succeeded, false if it was reverted. */
  toggle: () => Promise<boolean>;
}

export interface UseFollowOptions {
  /**
   * When provided, pre-seeds `isFollowing` before the server fetch resolves.
   * Useful for restoring persisted follow state (e.g. from the map store) so
   * the icon shows the correct value instantly on remount.
   */
  initialIsFollowing?: boolean;
}

const IDLE: Omit<FollowState, 'toggle'> = {
  isFollowing: false,
  followsYou: false,
  followersCount: 0,
  followingCount: 0,
  loading: false,
  toggling: false,
};

export function useFollow(userId: string | null, options?: UseFollowOptions): FollowState {
  const [state, setState] = useState<Omit<FollowState, 'toggle'>>(() => ({
    ...IDLE,
    loading: Boolean(userId),
    // Pre-seed from the store override if available so the icon is instant.
    isFollowing: options?.initialIsFollowing ?? false,
  }));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!userId) {
      setState({ ...IDLE });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    getFollowStatus(userId).then((res) => {
      if (!alive || !mounted.current) return;
      if (res.ok && res.data) {
        setState({
          isFollowing: res.data.isFollowing,
          followsYou: res.data.followsYou ?? false,
          followersCount: res.data.followersCount,
          followingCount: res.data.followingCount,
          loading: false,
          toggling: false,
        });
      } else {
        setState((s) => ({ ...s, loading: false }));
      }
    }).catch(() => {
      if (alive && mounted.current) setState((s) => ({ ...s, loading: false }));
    });
    return () => { alive = false; };
  }, [userId]);

  const toggle = useCallback(async (): Promise<boolean> => {
    if (!userId || state.toggling) return false;
    const wasFollowing = state.isFollowing;

    setState((s) => ({
      ...s,
      toggling: true,
      isFollowing: !wasFollowing,
      followersCount: wasFollowing ? Math.max(0, s.followersCount - 1) : s.followersCount + 1,
    }));

    const res = wasFollowing ? await unfollowUser(userId) : await followUser(userId);
    if (!mounted.current) return false;

    if (!res.ok) {
      setState((s) => ({
        ...s,
        toggling: false,
        isFollowing: wasFollowing,
        followersCount: wasFollowing ? s.followersCount + 1 : Math.max(0, s.followersCount - 1),
      }));
      return false;
    } else {
      setState((s) => ({ ...s, toggling: false }));
      return true;
    }
  }, [userId, state.isFollowing, state.toggling]);

  return { ...state, toggle };
}
