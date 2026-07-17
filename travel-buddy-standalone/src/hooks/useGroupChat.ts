/**
 * useGroupChat — fetch and send messages in trip or circle group threads.
 *
 * Handles all 5 states:
 *   loading, empty (no messages), no-access (left/removed), pending-invite, error
 *
 * Translation display hook: shows translated body when available;
 * otherwise shows original_body. No-op until Task #7 populates translation rows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getTripChat,
  getCircleChat,
  sendMessage,
  editMessage,
  deleteMessage,
  getThreadMessages,
  sendTyping,
  type GroupThread,
  type Message,
} from '../services/messaging.ts';
import { useSession } from '../context/SessionContext.tsx';
import {
  telegraphRealtime,
  type TelegraphEvent,
} from '../services/telegraphRealtimeService.ts';

function makeClientId(): string {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TYPING_TTL_MS = 4_000;

export type GroupChatState =
  | 'loading'
  | 'active'
  | 'no_access'
  | 'pending_invite'
  | 'error';

export interface GroupChatData {
  state: GroupChatState;
  thread: GroupThread | null;
  messages: Message[];
  sending: boolean;
  errorMessage: string | null;
  typingUserIds: string[];
  reload: () => void;
  send: (body: string, replyToId?: string) => Promise<{ ok: boolean }>;
  retrySend: (clientId: string) => Promise<void>;
  notifyTyping: (isTyping: boolean) => void;
  edit: (messageId: string, body: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useGroupChat(
  type: 'trip' | 'circle',
  id: string | null | undefined,
): GroupChatData {
  const { userId } = useSession();
  const [state, setState] = useState<GroupChatState>('loading');
  const [thread, setThread] = useState<GroupThread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = thread?.id ?? null;
  const typingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const lastTypingSentRef = useRef(0);

  const load = useCallback(async () => {
    if (!id) return;
    setState('loading');
    setErrorMessage(null);

    const res = type === 'trip'
      ? await getTripChat(id)
      : await getCircleChat(id);

    if (!res.ok) {
      if (res.errorKind === 'forbidden') {
        const errMsg = (res as any).message ?? '';
        if (errMsg.includes('pending') || errMsg.includes('invite')) {
          setState('pending_invite');
        } else {
          setState('no_access');
        }
        return;
      }
      setState('error');
      setErrorMessage(res.message ?? 'Failed to load chat');
      return;
    }

    const d = res.data!;
    setThread(d.thread);
    setMessages(d.messages ?? []);

    if (d.thread.memberAccess === 'removed') {
      setState('no_access');
    } else {
      setState('active');
    }
  }, [type, id]);

  useEffect(() => {
    if (id) load();
  }, [load, id]);

  // Silent refetch — merges new/updated messages without flipping to 'loading'.
  const silentRefresh = useCallback(async () => {
    const tid = threadIdRef.current;
    if (!tid) return;
    const res = await getThreadMessages(tid);
    if (!res.ok || !res.data) return;
    const incoming = res.data.messages ?? [];
    setMessages((prev) => {
      // Replace any confirmed incoming messages; keep still-pending optimistic ones
      const confirmedIds = new Set(incoming.map((m) => m.id));
      const byId = new Map<string, Message>();
      for (const m of prev) {
        // Drop optimistic 'sending'/'failed' messages that were confirmed server-side
        if (!m.clientId || !confirmedIds.has(m.id)) byId.set(m.id, m);
      }
      let changed = false;
      for (const m of incoming) {
        if (!byId.has(m.id)) changed = true;
        byId.set(m.id, m);
      }
      if (!changed && byId.size === prev.length) return prev;
      return Array.from(byId.values()).sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
      );
    });
  }, []);

  // Helper: clear a user from typing list
  const clearTyping = useCallback((uid: string) => {
    typingTimers.current.delete(uid);
    setTypingUserIds((prev) => prev.filter((u) => u !== uid));
  }, []);

  // Realtime: refresh on message events; handle typing events
  useEffect(() => {
    const unsub = telegraphRealtime.subscribe((evt: TelegraphEvent) => {
      const tid = threadIdRef.current;
      if (!tid || (evt.threadId && evt.threadId !== tid)) return;

      if (
        evt.type === 'message.created' ||
        evt.type === 'message.updated' ||
        evt.type === 'message.translated'
      ) {
        void silentRefresh();
        return;
      }

      const uid = evt.payload?.userId as string | undefined;
      if (!uid) return;

      if (evt.type === 'typing.started') {
        setTypingUserIds((prev) => prev.includes(uid) ? prev : [...prev, uid]);
        const existing = typingTimers.current.get(uid);
        if (existing) clearTimeout(existing);
        typingTimers.current.set(uid, setTimeout(() => clearTyping(uid), TYPING_TTL_MS));
      } else if (evt.type === 'typing.stopped') {
        const t = typingTimers.current.get(uid);
        if (t) { clearTimeout(t); typingTimers.current.delete(uid); }
        setTypingUserIds((prev) => prev.filter((u) => u !== uid));
      }
    });
    return () => {
      unsub();
      for (const t of typingTimers.current.values()) clearTimeout(t);
      typingTimers.current.clear();
    };
  }, [silentRefresh, clearTyping]);

  const send = useCallback(async (body: string, replyToId?: string): Promise<{ ok: boolean }> => {
    if (!thread || !body.trim()) return { ok: false };
    const clientId = makeClientId();
    const optimistic: Message = {
      id: clientId,
      clientId,
      threadId: thread.id,
      senderId: userId ?? '',
      body: body.trim(),
      originalBody: body.trim(),
      displayBody: body.trim(),
      createdAt: new Date().toISOString(),
      editedAt: null,
      deleted: false,
      msgType: 'text',
      subtype: null,
      deliveryStatus: 'sending',
      translationStatus: null,
      translationLabel: null,
      translated: false,
      canShowOriginal: false,
      senderName: null,
      senderHandle: null,
      senderAvatarUrl: null,
    } as unknown as Message;
    setSending(true);
    setMessages((prev) => [...prev, optimistic]);
    const res = await sendMessage(thread.id, body.trim(), { clientId, ...(replyToId ? { replyToId } : {}) });
    if (res.ok && res.data) {
      setMessages((prev) => {
        const withoutOptimistic = prev.filter((m) => m.clientId !== clientId);
        return [...withoutOptimistic, { ...(res.data as Message), deliveryStatus: 'sent' as const }];
      });
    } else {
      setMessages((prev) =>
        prev.map((m) =>
          m.clientId === clientId ? { ...m, deliveryStatus: 'failed' as const } : m,
        ),
      );
    }
    setSending(false);
    return { ok: res.ok };
  }, [thread]);

  const retrySend = useCallback(async (clientId: string) => {
    const failed = messages.find((m) => m.clientId === clientId);
    if (!failed || !thread) return;
    setMessages((prev) =>
      prev.map((m) =>
        m.clientId === clientId ? { ...m, deliveryStatus: 'sending' as const } : m,
      ),
    );
    const res = await sendMessage(thread.id, failed.body ?? '', { clientId });
    if (res.ok && res.data) {
      setMessages((prev) => {
        const withoutOptimistic = prev.filter((m) => m.clientId !== clientId);
        return [...withoutOptimistic, { ...(res.data as Message), deliveryStatus: 'sent' as const }];
      });
    } else {
      setMessages((prev) =>
        prev.map((m) =>
          m.clientId === clientId ? { ...m, deliveryStatus: 'failed' as const } : m,
        ),
      );
    }
  }, [messages, thread]);

  const notifyTyping = useCallback((isTyping: boolean) => {
    const tid = threadIdRef.current;
    if (!tid) return;
    if (!isTyping) {
      lastTypingSentRef.current = 0;
      void sendTyping(tid, false);
      return;
    }
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2_000) return;
    lastTypingSentRef.current = now;
    void sendTyping(tid, true);
  }, []);

  const edit = useCallback(async (messageId: string, body: string) => {
    const res = await editMessage(messageId, body);
    if (res.ok && res.data) {
      const updated = res.data as any;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, body: updated.body, editedAt: updated.editedAt }
            : m,
        ),
      );
    }
  }, []);

  const remove = useCallback(async (messageId: string) => {
    const res = await deleteMessage(messageId);
    if (res.ok) {
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, deleted: true, body: null } : m)),
      );
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!thread || messages.length === 0) return;
    const oldest = messages[0];
    const res = await getThreadMessages(thread.id, oldest.createdAt);
    if (res.ok && res.data) {
      const older = [...(res.data.messages ?? [])].reverse();
      setMessages((prev) => [...older, ...prev]);
    }
  }, [thread, messages]);

  return { state, thread, messages, sending, errorMessage, typingUserIds, reload: load, send, retrySend, notifyTyping, edit, remove, loadMore };
}
