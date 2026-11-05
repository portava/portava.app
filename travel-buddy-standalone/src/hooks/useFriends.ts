/**
 * Friend hooks — same {data, loading, error, reload} shape as other hooks.
 * All reads/writes go through src/services/friends.ts → API server.
 */
import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  getFriendStatus,
  getIncomingFriendRequests,
  getMyFriends,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  removeFriend,
  resolveSendFriendRequestOutcome,
  type FriendStatus,
  type FriendRequest,
  type FriendRow,
  type FriendResult,
} from '../services/friends.ts';
import { onFriendsChanged, emitFriendsChanged } from '../lib/friendEvents.ts';
import { bumpSocialVersion } from './useSocialVersion.ts';
import { useInputAccountEpoch } from '../platform/input-assistance/hooks/useInputAccountEpoch.ts';
import { currentDiscoveryScope, isCurrentDiscoveryScope } from '../services/discoveryViewerScope.ts';

/** Friend status for a single user (e.g., on their profile page). */
export function useFriendStatus(userId: string | null | undefined) {
  const epoch = useInputAccountEpoch();
  const context = useMemo(() => ({ active: false, scope: currentDiscoveryScope(), revision: 0, mutating: false }), [userId, epoch]);
  const [state, setState] = useState({
    context, status: 'none' as FriendStatus, requestId: undefined as string | undefined,
    loading: !!userId, error: null as string | null,
  });
  const view = state.context === context ? state : {
    context, status: 'none' as FriendStatus, requestId: undefined, loading: !!userId, error: null,
  };
  const current = useCallback(() => context.active && isCurrentDiscoveryScope(context.scope), [context]);

  const reload = useCallback(async () => {
    if (!userId || !current() || context.mutating) return;
    const revision = ++context.revision;
    setState((prev) => ({ ...prev, context, loading: true, error: null }));
    try {
      const res = await getFriendStatus(userId);
      if (!current() || revision !== context.revision) return;
      if (res.ok && res.data) {
        setState({ context, status: res.data.status, requestId: res.data.requestId, loading: false, error: null });
      } else {
        setState((prev) => ({ ...prev, loading: false, error: res.message ?? 'Failed to load friend status' }));
      }
    } catch {
      if (current() && revision === context.revision) {
        setState((prev) => ({ ...prev, loading: false, error: 'Failed to load friend status. Please try again.' }));
      }
    }
  }, [userId, context, current]);

  useEffect(() => {
    context.active = true;
    setState({ context, status: 'none', requestId: undefined, loading: !!userId, error: null });
    void reload();
    const off = onFriendsChanged(reload);
    return () => { context.active = false; context.revision++; off(); };
  }, [context, userId, reload]);

  const mutate = useCallback(async (
    operation: () => Promise<FriendResult<any>>,
    success: (data: any) => { status: FriendStatus; requestId?: string; notify?: boolean; social?: boolean },
  ): Promise<FriendResult<any>> => {
    if (!current() || context.mutating) return { ok: false, data: null, errorKind: 'config_error', message: 'Please wait and try again.' };
    context.mutating = true;
    const revision = ++context.revision; // A read started before this write cannot undo it.
    setState((prev) => ({ ...prev, context, loading: false, error: null }));
    try {
      const res = await operation();
      if (!current() || revision !== context.revision) return { ok: false, data: null, errorKind: 'config_error', message: 'The profile or account changed. Please try again.' };
      if (res.ok) {
        const next = success(res.data);
        setState({ context, status: next.status, requestId: next.requestId, loading: false, error: null });
        if (next.social) bumpSocialVersion();
        if (next.notify) emitFriendsChanged();
      } else {
        setState((prev) => ({ ...prev, error: res.message ?? 'Could not update friendship. Please try again.' }));
      }
      return res;
    } catch {
      const message = 'Could not update friendship. Please try again.';
      if (current() && revision === context.revision) setState((prev) => ({ ...prev, error: message }));
      return { ok: false, data: null, errorKind: 'network_unreachable', message };
    } finally {
      context.mutating = false;
    }
  }, [context, current]);

  const unavailable = (): Promise<FriendResult<any>> => Promise.resolve({ ok: false, data: null, errorKind: 'config_error' });
  const send = useCallback(() => userId ? mutate(() => sendFriendRequest(userId), (data) => {
    const outcome = resolveSendFriendRequestOutcome(data);
    return { ...outcome, notify: outcome.autoAccepted };
  }) : unavailable(), [userId, mutate]);
  const requestId = view.requestId;
  const accept = useCallback(() => requestId ? mutate(() => acceptFriendRequest(requestId), () => ({ status: 'friends', notify: true })) : unavailable(), [requestId, mutate]);
  const decline = useCallback(() => requestId ? mutate(() => declineFriendRequest(requestId), () => ({ status: 'none' })) : unavailable(), [requestId, mutate]);
  const cancel = useCallback(() => requestId ? mutate(() => cancelFriendRequest(requestId), () => ({ status: 'none' })) : unavailable(), [requestId, mutate]);
  const remove = useCallback(() => userId ? mutate(() => removeFriend(userId), () => ({ status: 'none', notify: true, social: true })) : unavailable(), [userId, mutate]);

  return { status: view.status, requestId, loading: view.loading, error: view.error, reload, send, accept, decline, cancel, remove };
}

/** Incoming friend requests for the notification/inbox surface. */
export function useIncomingFriendRequests() {
  const [data, setData] = useState<FriendRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getIncomingFriendRequests();
    if (res.ok) setData((res.data as any)?.requests ?? []);
    else setError(res.message ?? 'Failed to load requests');
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Refresh when a friendship changes elsewhere (e.g. auto-accepted request).
  useEffect(() => onFriendsChanged(reload), [reload]);

  const accept = useCallback(async (requestId: string) => {
    const res = await acceptFriendRequest(requestId);
    if (res.ok) {
      setData((prev) => prev.filter((r) => r.requestId !== requestId));
      emitFriendsChanged();
    }
    return res;
  }, []);

  const decline = useCallback(async (requestId: string) => {
    const res = await declineFriendRequest(requestId);
    if (res.ok) setData((prev) => prev.filter((r) => r.requestId !== requestId));
    return res;
  }, []);

  return { data, loading, error, reload, accept, decline };
}

/**
 * Current user's friends list.
 *
 * Includes a `remove(friendId)` callback that unfriends the given user,
 * optimistically removes them from local state, and signals all mounted
 * social surfaces via `bumpSocialVersion()` and `emitFriendsChanged()`.
 */
export function useMyFriends() {
  const [data, setData] = useState<FriendRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyFriends();
    if (res.ok) setData((res.data as any)?.friends ?? []);
    else setError(res.message ?? 'Failed to load friends');
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Refresh when a friendship changes elsewhere (e.g. auto-accepted request).
  useEffect(() => onFriendsChanged(reload), [reload]);

  const remove = useCallback(async (friendId: string): Promise<FriendResult<any>> => {
    const res = await removeFriend(friendId);
    if (res.ok) {
      setData((prev) => prev.filter((f) => f.id !== friendId));
      bumpSocialVersion();   // keeps passport follower counts in sync
      emitFriendsChanged();  // refreshes other mounted friend surfaces
    }
    return res;
  }, []);

  return { data, loading, error, reload, remove };
}
