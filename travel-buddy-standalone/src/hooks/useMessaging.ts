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
  getOutgoingRequestStatus,
  acceptMessageRequest,
  declineMessageRequest,
  getMyThreads,
  getUnreadCounts,
  markThreadRead,
  markHighlightsViewed,
  getThreadMessages,
  sendMessage,
  sendTyping,
  retryTranslation,
  getMyLanguageSettings,
  updateMyLanguageSettings,
  type MessageVerdict,
  type MessagePermissionResult,
  type MessageRequest,
  type ThreadSummary,
  type Message,
  type LanguageSettings,
} from '../services/messaging.ts';
import {
  telegraphRealtime,
  type TelegraphEvent,
} from '../services/telegraphRealtimeService.ts';
import { useSession } from '../context/SessionContext.tsx';
import { useSnapshotCache } from './useSnapshotCache.ts';

// When realtime is connected we lean on pushed events and poll only as a slow
// safety net. When realtime is unavailable the service reports 'polling' and
// these intervals carry the full load.
const THREAD_POLL_MS = 3_000;
const INBOX_POLL_MS = 7_000;
const UNREAD_POLL_MS = 15_000;

/** How long a peer is shown as "typing" before we auto-clear it. */
const TYPING_TTL_MS = 6_000;

function makeClientId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

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

// ── Outgoing request status (for sender-side "Waiting for reply" state) ───────

export function useOutgoingRequestStatus(otherUserId: string | null | undefined) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!otherUserId) return;
    setLoading(true);
    const res = await getOutgoingRequestStatus(otherUserId);
    if (res.ok && res.data) setPending(res.data.pending);
    setLoading(false);
  }, [otherUserId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { pending, loading, reload };
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
  // Cache key bumped to v2: pre-fix snapshots could carry threads whose
  // otherMembers profile join silently failed (BP), painting "Unknown" from
  // a locally-cached copy even after the server-side fix shipped. The v2 key
  // makes every client fetch fresh data once instead of trusting old bytes.
  const { snapshot, save: saveSnapshot, clear: clearSnapshot } = useSnapshotCache<ThreadSummary[]>('messages_v2');
  const [data, setData] = useState<ThreadSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  // True once the first network response has been applied; prevents snapshot
  // from overwriting fresher network data if AsyncStorage is unusually slow.
  const networkFetchedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());

  // Paint snapshot immediately when AsyncStorage read completes (second open).
  useEffect(() => {
    if (snapshot === null) return;
    if (networkFetchedRef.current) return; // network already painted fresher data
    setData(snapshot);
    setLoading(false);
    if (__DEV__) {
      const elapsed = Date.now() - mountedAtRef.current;
      // eslint-disable-next-line no-console
      console.log(`[PerfTiming] Messages second=${elapsed}ms`);
    }
  }, [snapshot]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getMyThreads();
    if (res.ok) {
      const threads: ThreadSummary[] = (res.data as any)?.threads ?? [];
      setData(threads);
      saveSnapshot(threads); // persist first page for next open
    } else {
      setError(res.message ?? 'Failed to load threads');
    }
    networkFetchedRef.current = true;
    setLoading(false);
  }, [saveSnapshot]);

  /**
   * Pull-to-refresh: wipe the snapshot so the next mount starts fresh, then
   * do a full network reload.
   */
  const refresh = useCallback(async () => {
    clearSnapshot();
    networkFetchedRef.current = false;
    setRefreshing(true);
    setError(null);
    const res = await getMyThreads();
    if (res.ok) {
      const threads: ThreadSummary[] = (res.data as any)?.threads ?? [];
      setData(threads);
      saveSnapshot(threads);
    } else {
      setError(res.message ?? 'Failed to load threads');
    }
    networkFetchedRef.current = true;
    setRefreshing(false);
  }, [clearSnapshot, saveSnapshot]);

  const silentPoll = useCallback(async () => {
    if (appStateRef.current !== 'active') return;
    const res = await getMyThreads();
    if (res.ok && res.data) {
      const threads: ThreadSummary[] = (res.data as any).threads ?? [];
      setData(threads);
      saveSnapshot(threads);
    }
  }, [saveSnapshot]);

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

  // Realtime: refresh the inbox immediately when a relevant event arrives.
  useEffect(() => {
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (
        evt.type === 'message.created' ||
        evt.type === 'thread.updated' ||
        evt.type === 'member.left' ||
        evt.type === 'request.accepted'
      ) {
        void silentPoll();
      }
    });
    return unsub;
  }, [silentPoll]);

  return { data, loading, refreshing, error, reload, refresh };
}

// ── Thread chat (with message polling) ────────────────────────────────────────

export function useThreadMessages(threadId: string | null) {
  const { userId } = useSession();
  // Use a stable placeholder key when threadId is null so the hook call is unconditional.
  const snapshotKey = threadId ? `messages:thread:${threadId}` : 'messages:thread:__none__';
  const { snapshot, save: saveSnapshot, clear: clearSnapshot } = useSnapshotCache<Message[]>(snapshotKey);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const sendingRef = useRef(false);
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);
  // True once the first network response has been applied for the current thread;
  // prevents the snapshot from overwriting fresher network data if AsyncStorage is slow.
  const networkFetchedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  // Tracks the thread currently on screen so fetches started for a previous
  // thread can discard their results instead of interleaving two conversations.
  const activeThreadIdRef = useRef(threadId);
  activeThreadIdRef.current = threadId;

  // Reset per-thread tracking whenever the thread changes.
  useEffect(() => {
    networkFetchedRef.current = false;
    mountedAtRef.current = Date.now();
    // Clear the previous thread's messages immediately — otherwise they stay
    // visible (and mergeable) until the new thread's fetch resolves.
    setMessages([]);
    setLoading(true);
    setError(null);
  }, [threadId]);

  // Paint snapshot immediately when AsyncStorage read completes (second open).
  useEffect(() => {
    if (snapshot === null) return;
    if (networkFetchedRef.current) return; // network already painted fresher data
    setMessages(snapshot);
    setLoading(false);
    if (__DEV__) {
      const elapsed = Date.now() - mountedAtRef.current;
      // eslint-disable-next-line no-console
      console.log(`[PerfTiming] Thread second=${elapsed}ms`);
    }
  }, [snapshot]);

  const reload = useCallback(async () => {
    if (!threadId) return;
    setLoading(true);
    setError(null);
    const res = await getThreadMessages(threadId);
    // Fence: the user switched threads while this fetch was in flight — the
    // result belongs to the old thread, so drop it.
    if (activeThreadIdRef.current !== threadId) return;
    if (res.ok && res.data) {
      const msgs = [...(res.data.messages ?? [])].reverse();
      setMessages(msgs);
      // Only cache confirmed server messages — exclude optimistic entries.
      const toCache = msgs.filter(
        (m) => m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed',
      );
      saveSnapshot(toCache);
    } else {
      setError(res.message ?? 'Failed to load messages');
    }
    networkFetchedRef.current = true;
    setLoading(false);
  }, [threadId, saveSnapshot]);

  const silentPoll = useCallback(async () => {
    if (!threadId || appStateRef.current !== 'active' || sendingRef.current) return;
    const res = await getThreadMessages(threadId);
    // Fence: discard results that arrive after the user switched threads.
    if (activeThreadIdRef.current !== threadId) return;
    if (!res.ok || !res.data) return;
    const incoming = [...(res.data.messages ?? [])].reverse();
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const incomingById = new Map(incoming.map((m) => [m.id, m]));
      const existingIds = new Set(prev.map((m) => m.id));
      const fresh = incoming.filter((m) => !existingIds.has(m.id));

      // Merge translation updates for existing messages whose status resolved
      // since the last render (pending → translated/failed/skipped).
      // Only replace the entry when status actually changes to avoid flicker.
      let hasTranslationUpdate = false;
      const updated = prev.map((m) => {
        if (m.translationStatus === 'pending') {
          const refreshed = incomingById.get(m.id);
          if (refreshed && refreshed.translationStatus !== 'pending') {
            hasTranslationUpdate = true;
            return refreshed;
          }
        }
        return m;
      });

      if (fresh.length === 0 && !hasTranslationUpdate) return prev;
      if (fresh.length === 0) return updated;
      return [...updated, ...fresh];
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

  // Realtime: react to events scoped to this thread.
  useEffect(() => {
    if (!threadId) return;
    const clearTyping = (uid: string) => {
      const t = typingTimers.current.get(uid);
      if (t) { clearTimeout(t); typingTimers.current.delete(uid); }
      setTypingUserIds((prev) => prev.filter((id) => id !== uid));
    };

    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      if (evt.threadId && evt.threadId !== threadId) return;

      switch (evt.type) {
        case 'message.created':
        case 'message.updated':
        case 'message.translated':
        case 'read.updated':
          void silentPoll();
          break;
        case 'typing.started': {
          const uid = (evt.payload?.userId as string) ?? '';
          if (!uid) break;
          const existing = typingTimers.current.get(uid);
          if (existing) clearTimeout(existing);
          typingTimers.current.set(uid, setTimeout(() => clearTyping(uid), TYPING_TTL_MS));
          setTypingUserIds((prev) => (prev.includes(uid) ? prev : [...prev, uid]));
          break;
        }
        case 'typing.stopped': {
          const uid = (evt.payload?.userId as string) ?? '';
          if (uid) clearTyping(uid);
          break;
        }
        default:
          break;
      }
    });

    const timers = typingTimers.current;
    return () => {
      unsub();
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      setTypingUserIds([]);
    };
  }, [threadId, silentPoll]);

  /** Optimistically append a message, then reconcile with the server response. */
  const send = useCallback(
    async (body: string, opts?: { msgType?: string; subtype?: string; replyToId?: string; replyToBody?: string | null; replyToSenderName?: string | null }) => {
      const trimmed = body.trim();
      if (!threadId || !trimmed) return;
      const clientId = makeClientId();
      const optimistic: Message = {
        id: clientId,
        clientId,
        threadId,
        senderId: userId ?? '',
        senderHandle: null,
        senderName: null,
        senderAvatarUrl: null,
        body: trimmed,
        deleted: false,
        createdAt: new Date().toISOString(),
        editedAt: null,
        displayBody: trimmed,
        originalBody: trimmed,
        originalLanguage: null,
        translated: false,
        translationStatus: null,
        translationLabel: null,
        canShowOriginal: false,
        msgType: opts?.msgType ?? 'text',
        subtype: opts?.subtype ?? null,
        replyToId: opts?.replyToId ?? null,
        replyToBody: opts?.replyToBody ?? null,
        replyToSenderName: opts?.replyToSenderName ?? null,
        deliveryStatus: 'sending',
      };

      sendingRef.current = true;
      setSending(true);
      setMessages((prev) => [...prev, optimistic]);

      const res = await sendMessage(threadId, trimmed, { ...opts, clientId });
      if (res.ok && res.data) {
        const server = res.data as Message;
        setMessages((prev) => {
          // Replace the optimistic placeholder; drop if the real one already
          // arrived via realtime/poll to avoid duplicates.
          const withoutTemp = prev.filter((m) => m.clientId !== clientId);
          if (withoutTemp.some((m) => m.id === server.id)) return withoutTemp;
          return [...withoutTemp, { ...server, deliveryStatus: 'sent' as const }];
        });
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientId === clientId ? { ...m, deliveryStatus: 'failed' as const } : m,
          ),
        );
      }
      setSending(false);
      sendingRef.current = false;
      return res;
    },
    // userId must be a dep: a stale null senderId makes the optimistic
    // message render as incoming instead of outgoing.
    [threadId, userId],
  );

  /** Resend a previously-failed optimistic message (matched by its clientId). */
  const retrySend = useCallback(
    async (clientId: string) => {
      if (!threadId) return;
      const failed = messages.find((m) => m.clientId === clientId);
      if (!failed || !failed.body) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.clientId === clientId ? { ...m, deliveryStatus: 'sending' as const } : m,
        ),
      );
      const res = await sendMessage(threadId, failed.body, {
        msgType: failed.msgType,
        subtype: failed.subtype ?? undefined,
        clientId,
      });
      if (res.ok && res.data) {
        const server = res.data as Message;
        setMessages((prev) => {
          const withoutTemp = prev.filter((m) => m.clientId !== clientId);
          if (withoutTemp.some((m) => m.id === server.id)) return withoutTemp;
          return [...withoutTemp, { ...server, deliveryStatus: 'sent' as const }];
        });
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.clientId === clientId ? { ...m, deliveryStatus: 'failed' as const } : m,
          ),
        );
      }
      return res;
    },
    [threadId, messages],
  );

  /** Relay a typing indicator, throttled so we send at most one ping / 2 s. */
  const notifyTyping = useCallback(
    (isTyping: boolean) => {
      if (!threadId) return;
      if (!isTyping) {
        lastTypingSentRef.current = 0;
        void sendTyping(threadId, false);
        return;
      }
      const now = Date.now();
      if (now - lastTypingSentRef.current < 2_000) return;
      lastTypingSentRef.current = now;
      void sendTyping(threadId, true);
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

  /**
   * Pull-to-refresh: wipe the per-thread snapshot so the next mount starts
   * fresh, then do a full network reload.
   */
  const refresh = useCallback(async () => {
    if (!threadId) return;
    clearSnapshot();
    networkFetchedRef.current = false;
    setLoading(true);
    setError(null);
    const res = await getThreadMessages(threadId);
    // Fence: discard results that arrive after the user switched threads.
    if (activeThreadIdRef.current !== threadId) return;
    if (res.ok && res.data) {
      const msgs = [...(res.data.messages ?? [])].reverse();
      setMessages(msgs);
      const toCache = msgs.filter(
        (m) => m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed',
      );
      saveSnapshot(toCache);
    } else {
      setError(res.message ?? 'Failed to load messages');
    }
    networkFetchedRef.current = true;
    setLoading(false);
  }, [threadId, clearSnapshot, saveSnapshot]);

  return {
    messages,
    loading,
    error,
    sending,
    typingUserIds,
    reload,
    refresh,
    send,
    retrySend,
    notifyTyping,
    retry,
  };
}

// ── Unread counts (for tab badge) ─────────────────────────────────────────────

/**
 * Each useUnreadCounts() caller holds independent state (the tab badge in
 * (tabs)/_layout.tsx is its own instance), so a screen that stamps counts as
 * viewed (e.g. the Activity Center calling markNotificationsRead) cannot reach
 * the badge's state directly. This module-level broadcast lets it optimistically
 * patch every mounted instance (pass a partial counts object) or ask them all
 * to refetch from the server (pass null).
 */
type UnreadCountsPatch = Partial<{
  messages: number;
  notifications: number;
  meetups: number;
  newHighlights: number;
}>;
const unreadCountsListeners = new Set<(patch: UnreadCountsPatch | null) => void>();

export function broadcastUnreadCounts(patch: UnreadCountsPatch | null): void {
  unreadCountsListeners.forEach((listener) => listener(patch));
}

export function useUnreadCounts() {
  const [messages, setMessages] = useState(0);
  const [notifications, setNotifications] = useState(0);
  const [meetups, setMeetups] = useState(0);
  const [newHighlights, setNewHighlights] = useState(0);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  const refresh = useCallback(async () => {
    const res = await getUnreadCounts();
    if (res.ok && res.data) {
      setMessages(res.data.messages ?? 0);
      setNotifications(res.data.notifications ?? 0);
      setMeetups(res.data.meetups ?? 0);
      setNewHighlights(res.data.newHighlights ?? 0);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Cross-instance sync: apply optimistic patches / refetch requests sent via
  // broadcastUnreadCounts (e.g. the Activity Center zeroing the notifications
  // badge the moment it gains focus).
  useEffect(() => {
    const listener = (patch: UnreadCountsPatch | null) => {
      if (patch === null) {
        void refresh();
        return;
      }
      if (patch.messages !== undefined) setMessages(patch.messages);
      if (patch.notifications !== undefined) setNotifications(patch.notifications);
      if (patch.meetups !== undefined) setMeetups(patch.meetups);
      if (patch.newHighlights !== undefined) setNewHighlights(patch.newHighlights);
    };
    unreadCountsListeners.add(listener);
    return () => { unreadCountsListeners.delete(listener); };
  }, [refresh]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      appStateRef.current = next;
      if (next === 'active') refresh();
    });
    const timer = setInterval(() => {
      if (appStateRef.current === 'active') refresh();
    }, UNREAD_POLL_MS);
    return () => {
      sub.remove();
      clearInterval(timer);
    };
  }, [refresh]);

  return { messages, notifications, meetups, newHighlights, refresh };
}

export { markThreadRead, markHighlightsViewed };

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
