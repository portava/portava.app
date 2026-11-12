import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { sendTyping } from '../../../services/messaging.ts';
import { telegraphRealtime } from '../../../services/telegraphRealtimeService.ts';

export const TYPING_IDLE_MS = 2_500;
export const TYPING_TTL_MS = 4_000;
/** Ephemeral presence belongs to one foreground viewer and one conversation. */
export function useConversationTyping(threadId: string | null, viewerId: string | null) {
  const identity = `${viewerId ?? ''}:${threadId ?? ''}`;
  const current = useRef({ identity, viewerId }); current.current = { identity, viewerId };
  const [peers, setPeers] = useState<{ identity: string; ids: string[] }>({ identity, ids: [] });
  const notify = useRef<(typing: boolean) => void>(() => {});
  useEffect(() => {
    let active = true;
    let foreground = AppState.currentState === 'active';
    let told = false;
    let lastSent = -Infinity;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let writing = false;
    let pending: boolean | undefined;
    const enqueue = (typing: boolean) => {
      pending = typing;
      if (writing) return;
      writing = true;
      void (async () => {
        try {
          while (pending !== undefined) {
            const next = pending; pending = undefined;
            if (current.current.viewerId !== viewerId || !threadId) break;
            if (next && (!active || current.current.identity !== identity || !foreground)) continue;
            // Coalesce while in flight; a final stop never overtakes its start.
            await sendTyping(threadId, next, viewerId);
          }
        } finally { writing = false; }
      })();
    };
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const valid = () => active && current.current.identity === identity && !!threadId && !!viewerId;
    const stop = () => {
      if (idle) clearTimeout(idle);
      idle = undefined;
      // Never send an old account's stop through the new account's token.
      if (told && current.current.viewerId === viewerId && threadId) enqueue(false);
      told = false;
    };
    const clearPeers = () => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); setPeers({ identity, ids: [] }); };
    const remove = (uid: string) => {
      const timer = timers.get(uid); if (timer) clearTimeout(timer); timers.delete(uid);
      if (valid()) setPeers(previous => ({ identity, ids: previous.identity === identity ? previous.ids.filter(id => id !== uid) : [] }));
    };
    setPeers({ identity, ids: [] });
    notify.current = (typing) => {
      if (!valid()) return;
      if (!typing || !foreground) { stop(); return; }
      if (idle) clearTimeout(idle);
      idle = setTimeout(stop, TYPING_IDLE_MS);
      const now = Date.now();
      if (now - lastSent < 2_000) return;
      lastSent = now; told = true;
      enqueue(true);
    };
    const unsubscribe = telegraphRealtime.subscribe(evt => {
      if (!valid() || !foreground) return;
      if (evt.type === 'access.revoked' || (evt.threadId === threadId && evt.type === 'member.left' && evt.payload?.userId === viewerId)) { stop(); clearPeers(); return; }
      if (evt.threadId !== threadId) return;
      const uid = evt.payload?.userId;
      if (typeof uid !== 'string' || !uid || uid === viewerId) return;
      if (evt.type === 'typing.stopped') remove(uid);
      if (evt.type === 'typing.started') {
        const timer = timers.get(uid); if (timer) clearTimeout(timer);
        timers.set(uid, setTimeout(() => remove(uid), TYPING_TTL_MS));
        setPeers(previous => ({ identity, ids: previous.identity === identity ? [...new Set([...previous.ids, uid])] : [uid] }));
      }
    });
    const subscription = AppState.addEventListener('change', state => {
      foreground = state === 'active';
      if (!foreground) { stop(); clearPeers(); }
    });
    return () => { active = false; stop(); for (const timer of timers.values()) clearTimeout(timer); unsubscribe(); subscription?.remove?.(); };
  }, [identity, threadId, viewerId]);
  const notifyTyping = useCallback((typing: boolean) => notify.current(typing), []);
  return { notifyTyping, typingUserIds: peers.identity === identity ? peers.ids : [] };
}
