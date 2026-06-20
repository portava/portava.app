/**
 * Messaging hooks — same {data, loading, error, reload} shape as other hooks.
 * All reads/writes go through src/services/messaging.ts → API server.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  getMessagePermission,
  sendMessageRequest,
  getIncomingMessageRequests,
  acceptMessageRequest,
  declineMessageRequest,
  getMyThreads,
  getThreadMessages,
  sendMessage,
  type MessageVerdict,
  type MessagePermissionResult,
  type MessageRequest,
  type ThreadSummary,
  type Message,
} from '../services/messaging';

// ── Message permission (for profile / passport) ───────────────────────────────

export function useMessagePermission(userId: string | null | undefined) {
  const [verdict, setVerdict] = useState<MessageVerdict | null>(null);
  const [result, setResult] = useState<MessagePermissionResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    setError(null);
    const res = await getMessagePermission(userId);
    if (res.ok && res.data) {
      setResult(res.data);
      setVerdict((res.data as MessagePermissionResult).verdict);
    } else {
      setError(res.message ?? 'Failed to load message permission');
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const send = useCallback(
    async (previewText?: string) => {
      if (!userId) return { ok: false, data: null, errorKind: 'config_error' as const };
      const res = await sendMessageRequest(userId, previewText);
      return res;
    },
    [userId],
  );

  return { verdict, result, loading, error, reload, send };
}

// ── Incoming message requests (for Request Inbox) ─────────────────────────────

export function useIncomingMessageRequests() {
  const [data, setData] = useState<MessageRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getIncomingMessageRequests();
    if (res.ok) setData((res.data as any)?.requests ?? []);
    else setError(res.message ?? 'Failed to load message requests');
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const accept = useCallback(async (requestId: string) => {
    const res = await acceptMessageRequest(requestId);
    if (res.ok) setData((prev) => prev.filter((r) => r.requestId !== requestId));
    return res;
  }, []);

  const decline = useCallback(async (requestId: string) => {
    const res = await declineMessageRequest(requestId);
    if (res.ok) setData((prev) => prev.filter((r) => r.requestId !== requestId));
    return res;
  }, []);

  return { data, loading, error, reload, accept, decline };
}

// ── Threads list ──────────────────────────────────────────────────────────────

export function useMyThreads() {
  const [data, setData] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyThreads();
    if (res.ok) setData((res.data as any)?.threads ?? []);
    else setError(res.message ?? 'Failed to load threads');
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, reload };
}

// ── Thread chat ───────────────────────────────────────────────────────────────

export function useThreadMessages(threadId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const reload = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    setError(null);
    const res = await getThreadMessages(threadId);
    if (res.ok && res.data) {
      // Messages arrive newest-first from the API; reverse for display.
      setMessages([...(res.data.messages ?? [])].reverse());
    } else {
      setError(res.message ?? 'Failed to load messages');
    }
    setLoading(false);
  }, [threadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const send = useCallback(
    async (body: string) => {
      if (!threadId || !body.trim()) return;
      setSending(true);
      const res = await sendMessage(threadId, body.trim());
      if (res.ok && res.data) {
        setMessages((prev) => [...prev, res.data as Message]);
      }
      setSending(false);
      return res;
    },
    [threadId],
  );

  return { messages, loading, error, sending, reload, send };
}
