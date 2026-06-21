/**
 * Messaging hooks — same {data, loading, error, reload} shape as other hooks.
 * All reads/writes go through src/services/messaging.ts → API server.
 *
 * Polling:
 *   - useMyThreads    — refreshes the inbox every 7 s while the app is active.
 *   - useThreadMessages — merges new messages every 3 s while the app is active.
 *   Both hooks pause polling when AppState leaves 'active' and resume on return.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  getMessagePermission,
  sendMessageRequest,
  getIncomingMessageRequests,
  acceptMessageRequest,
  declineMessageRequest,
  getMyThreads,
  getThreadMessages,
  sendMessage,
  retryTranslation,
  getMyLanguageSettings,
  updateMyLanguageSettings,
  type MessageVerdict,
  type MessagePermissionResult,
  type MessageRequest,
  type ThreadSummary,
  type Message,
  type LanguageSettings,
} from '../services/messaging';

const THREAD_POLL_MS = 3_000;
const INBOX_POLL_MS = 7_000;

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
      setResult(res.data as MessagePermissionResult);
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

// ── Threads list (with inbox polling) ─────────────────────────────────────────

export function useMyThreads() {
  const [data, setData] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyThreads();
    if (res.ok) setData((res.data as any)?.threads ?? []);
    else setError(res.message ?? 'Failed to load threads');
    setLoading(false);
  }, []);

  const silentPoll = useCallback(async () => {
    if (appStateRef.current !== 'active') return;
    const res = await getMyThreads();
    if (res.ok && res.data) {
      setData((res.data as any).threads ?? []);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
    });
    const timer = setInterval(silentPoll, INBOX_POLL_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [silentPoll]);

  return { data, loading, error, reload };
}

// ── Thread chat (with message polling) ────────────────────────────────────────

export function useThreadMessages(threadId: string | null) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const sendingRef = useRef(false);

  const reload = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    setError(null);
    const res = await getThreadMessages(threadId);
    if (res.ok && res.data) {
      setMessages([...(res.data.messages ?? [])].reverse());
    } else {
      setError(res.message ?? 'Failed to load messages');
    }
    setLoading(false);
  }, [threadId]);

  const silentPoll = useCallback(async () => {
    if (!threadId || appStateRef.current !== 'active' || sendingRef.current) return;
    const res = await getThreadMessages(threadId);
    if (!res.ok || !res.data) return;
    const incoming = [...(res.data.messages ?? [])].reverse();
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const existingIds = new Set(prev.map((m) => m.id));
      const fresh = incoming.filter((m) => !existingIds.has(m.id));
      if (fresh.length === 0) return prev;
      return [...prev, ...fresh];
    });
  }, [threadId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
    });
    const timer = setInterval(silentPoll, THREAD_POLL_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [silentPoll]);

  const send = useCallback(
    async (body: string, opts?: { msgType?: string; subtype?: string }) => {
      if (!threadId || !body.trim()) return;
      sendingRef.current = true;
      setSending(true);
      const res = await sendMessage(threadId, body.trim(), opts);
      if (res.ok && res.data) {
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === (res.data as Message).id);
          if (exists) return prev;
          return [...prev, res.data as Message];
        });
      }
      setSending(false);
      sendingRef.current = false;
      return res;
    },
    [threadId],
  );

  const retry = useCallback(
    async (messageId: string) => {
      const res = await retryTranslation(messageId);
      if (res.ok) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId
              ? { ...m, translationStatus: 'pending' as const, translationLabel: null }
              : m,
          ),
        );
      }
      return res;
    },
    [],
  );

  return { messages, loading, error, sending, reload, send, retry };
}

// ── Language settings ─────────────────────────────────────────────────────────

export function useLanguageSettings() {
  const [data, setData] = useState<LanguageSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyLanguageSettings();
    if (res.ok && res.data) setData(res.data as LanguageSettings);
    else setError(res.message ?? 'Failed to load language settings');
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const update = useCallback(
    async (patch: Partial<Omit<LanguageSettings, 'translation_updated_at'>>) => {
      const res = await updateMyLanguageSettings(patch);
      if (res.ok && res.data) setData(res.data as LanguageSettings);
      return res;
    },
    [],
  );

  return { data, loading, error, reload, update };
}
