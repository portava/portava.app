/**
 * useFollow — manages follow state and toggle for a single user.
 * Pass the target userId (null while loading); the hook fetches status
 * on mount and provides an optimistic toggle.
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
  toggle: () => Promise<void>;
}

const IDLE: Omit<FollowState, 'toggle'> = {
  isFollowing: false,
  followsYou: false,
  followersCount: 0,
  followingCount: 0,
  loading: false,
  toggling: false,
};

export function useFollow(userId: string | null): FollowState {
  const [state, setState] = useState<Omit<FollowState, 'toggle'>>({ ...IDLE, loading: Boolean(userId) });
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

  const toggle = useCallback(async () => {
    if (!userId || state.toggling) return;
    const wasFollowing = state.isFollowing;

    setState((s) => ({
      ...s,
      toggling: true,
      isFollowing: !wasFollowing,
      followersCount: wasFollowing ? Math.max(0, s.followersCount - 1) : s.followersCount + 1,
    }));

    const res = wasFollowing ? await unfollowUser(userId) : await followUser(userId);
    if (!mounted.current) return;

    if (!res.ok) {
      setState((s) => ({
        ...s,
        toggling: false,
        isFollowing: wasFollowing,
        followersCount: wasFollowing ? s.followersCount + 1 : Math.max(0, s.followersCount - 1),
      }));
    } else {
      setState((s) => ({ ...s, toggling: false }));
    }
  }, [userId, state.isFollowing, state.toggling]);

  return { ...state, toggle };
}
