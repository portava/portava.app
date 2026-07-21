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
    }
    return res;
  }, [userId]);

  const accept = useCallback(async (): Promise<FriendResult<any>> => {
    if (!requestId) return { ok: false, data: null, errorKind: 'config_error' };
    const res = await acceptFriendRequest(requestId);
    if (res.ok) { setStatus('friends'); setRequestId(undefined); }
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

  const accept = useCallback(async (requestId: string) => {
    const res = await acceptFriendRequest(requestId);
    if (res.ok) setData((prev) => prev.filter((r) => r.requestId !== requestId));
    return res;
  }, []);

  const decline = useCallback(async (requestId: string) => {
    const res = await declineFriendRequest(requestId);
    if (res.ok) setData((prev) => prev.filter((r) => r.requestId !== requestId));
    return res;
  }, []);

  return { data, loading, error, reload, accept, decline };
}

/** Current user's friends list. */
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

  return { data, loading, error, reload };
}
