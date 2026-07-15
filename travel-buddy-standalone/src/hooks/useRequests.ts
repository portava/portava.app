/**
 * Request hooks — unified inbox (friend requests, circle invites, trip invites).
 * useRequests splits data into incoming/outgoing for two-tab display.
 * useRequestCount includes an AppState listener so the nav badge stays fresh.
 */
import { useEffect, useState, useCallback } from 'react';
import { AppState } from 'react-native';
import { getMyRequests, getRequestCount, type InboxItem } from '../services/requests';

export function useRequests() {
  const [incoming, setIncoming] = useState<InboxItem[]>([]);
  const [outgoing, setOutgoing] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyRequests();
    if (res.ok) {
      const items: InboxItem[] = (res.data as any)?.items ?? [];
      setIncoming(items.filter((i) => i.direction === 'incoming'));
      setOutgoing(items.filter((i) => i.direction === 'outgoing'));
    } else {
      setError(res.message ?? 'Failed to load requests');
    }
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { incoming, outgoing, loading, error, reload };
}

export function useRequestCount() {
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await getRequestCount();
    if (res.ok && res.data) setCount((res.data as { count: number }).count ?? 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') reload();
    });
    return () => sub.remove();
  }, [reload]);

  return { count, loading, reload };
}
