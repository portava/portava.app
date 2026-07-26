/**
 * Friend hooks — same {data, loading, error, reload} shape as other hooks.
 * All reads/writes go through src/services/friends.ts → API server.
 */
import { useEffect, useState, useCallback } from 'react';
import {
  getFriendStatus,
  getIncomingFriendRequests,
  getMyFriends,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  resolveSendFriendRequestOutcome,
  type FriendStatus,
  type FriendRequest,
  type FriendRow,
  type FriendResult,
} from '../services/friends.ts';
import { onFriendsChanged, emitFriendsChanged } from '../lib/friendEvents.ts';

/** Friend status for a single user (e.g., on their profile page). */
export function useFriendStatus(userId: string | null | undefined) {
  const [status, setStatus] = useState<FriendStatus>('none');
  const [requestId, setRequestId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const res = await getFriendStatus(userId);
    if (res.ok && res.data) {
      setStatus((res.data as any).status ?? 'none');
      setRequestId((res.data as any).requestId ?? undefined);
    } else {
      setError(res.message ?? 'Failed to load friend status');
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { reload(); }, [reload]);

  const send = useCallback(async (): Promise<FriendResult<any>> => {
    if (!userId) return { ok: false, data: null, errorKind: 'config_error' };
    const res = await sendFriendRequest(userId);
    if (res.ok) {
      const outcome = resolveSendFriendRequestOutcome(res.data as any);
      setStatus(outcome.status);
      setRequestId(outcome.requestId);
      // Auto-accepted: a new friendship exists — refresh already-mounted
      // friends/requests surfaces so they don't show stale data.
      if (outcome.autoAccepted) emitFriendsChanged();
    }
    return res;
  }, [userId]);

  const accept = useCallback(async (): Promise<FriendResult<any>> => {
    if (!requestId) return { ok: false, data: null, errorKind: 'config_error' };
    const res = await acceptFriendRequest(requestId);
    if (res.ok) { setStatus('friends'); setRequestId(undefined); emitFriendsChanged(); }
    return res;
  }, [requestId]);

  const decline = useCallback(async (): Promise<FriendResult<any>> => {
    if (!requestId) return { ok: false, data: null, errorKind: 'config_error' };
    const res = await declineFriendRequest(requestId);
    if (res.ok) { setStatus('none'); setRequestId(undefined); }
    return res;
  }, [requestId]);

  const cancel = useCallback(async (): Promise<FriendResult<any>> => {
    if (!requestId) return { ok: false, data: null, errorKind: 'config_error' };
    const res = await cancelFriendRequest(requestId);
    if (res.ok) { setStatus('none'); setRequestId(undefined); }
    return res;
  }, [requestId]);

  return { status, requestId, loading, error, reload, send, accept, decline, cancel };
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
 * CONTRACT: if a "remove friend" / unfriend mutation is added to this hook
 * (or to a new hook in this file), it MUST call `bumpSocialVersion()` from
 * `../hooks/useSocialVersion.ts` on success — the same way the follow/unfollow
 * toggle does.  Skipping the bump leaves the passport follower count stale for
 * any screen that is already mounted when the friendship is removed.
 *
 * Example pattern (add when the API endpoint exists):
 *
 *   import { bumpSocialVersion } from './useSocialVersion.ts';
 *
 *   const remove = useCallback(async (friendId: string) => {
 *     const res = await removeFriend(friendId);          // src/services/friends.ts
 *     if (res.ok) {
 *       setData((prev) => prev.filter((f) => f.id !== friendId));
 *       bumpSocialVersion();   // ← keeps passport follower counts in sync
 *       emitFriendsChanged();  // ← refreshes other mounted friend surfaces
 *     }
 *     return res;
 *   }, []);
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

  return { data, loading, error, reload };
}
