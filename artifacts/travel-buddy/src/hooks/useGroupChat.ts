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
  type GroupThread,
  type Message,
} from '../services/messaging';
import {
  telegraphRealtime,
  type TelegraphEvent,
} from '../services/telegraphRealtimeService';

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
  reload: () => void;
  send: (body: string) => Promise<{ ok: boolean }>;
  edit: (messageId: string, body: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  loadMore: () => Promise<void>;
}

export function useGroupChat(
  type: 'trip' | 'circle',
  id: string | null | undefined,
): GroupChatData {
  const [state, setState] = useState<GroupChatState>('loading');
  const [thread, setThread] = useState<GroupThread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const threadIdRef = useRef<string | null>(null);
  threadIdRef.current = thread?.id ?? null;

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
      const byId = new Map(prev.map((m) => [m.id, m]));
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

  // Realtime: refresh on message events scoped to this group thread.
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
      }
    });
    return unsub;
  }, [silentRefresh]);

  const send = useCallback(async (body: string): Promise<{ ok: boolean }> => {
    if (!thread || !body.trim()) return { ok: false };
    setSending(true);
    const res = await sendMessage(thread.id, body.trim());
    if (res.ok && res.data) {
      setMessages((prev) => [...prev, res.data as Message]);
    }
    setSending(false);
    return { ok: res.ok };
  }, [thread]);

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

  return { state, thread, messages, sending, errorMessage, reload: load, send, edit, remove, loadMore };
}
