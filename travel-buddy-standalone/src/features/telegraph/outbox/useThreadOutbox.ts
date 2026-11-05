import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { captureMessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import { postOutboxEntry, type Message } from '../../../services/messaging.ts';
import { messageOutbox } from './runtime.ts';
import { pendingMessage } from './pendingMessages.ts';
export function useThreadOutbox(threadId: string | null, ownerId: string | null | undefined, recovered: (messages: Message[]) => void, replayed: () => void, failed: (message: string) => void) {
  const callbacks = useRef({ recovered, replayed, failed });
  callbacks.current = { recovered, replayed, failed };
  useEffect(() => {
    if (!threadId || !ownerId) return;
    const owner = captureMessagingOwnerRequest();
    if (!owner || owner.ownerId !== ownerId) return;
    let running = false;
    const recover = async () => {
      if (running || !owner.isCurrent() || AppState.currentState !== 'active') return;
      running = true;
      try {
        const entries = await messageOutbox.pending(owner, threadId);
        if (!owner.isCurrent()) return;
        callbacks.current.recovered(entries.map(pendingMessage));
        if (!entries.some((entry) => entry.state !== 'blocked' && entry.nextAttemptAt <= Date.now())) return;
        const count = await messageOutbox.replay(owner, (entry, signal) => postOutboxEntry(entry, owner, signal), threadId);
        if (owner.isCurrent() && count > 0) callbacks.current.replayed();
      } catch {
        if (owner.isCurrent()) callbacks.current.failed('Pending messages could not be restored from secure storage. Retry when this device is unlocked.');
      } finally { running = false; }
    };
    void recover();
    const timer = setInterval(() => void recover(), 10_000);
    const app = AppState.addEventListener('change', (state) => { if (state === 'active') void recover(); });
    return () => { owner.invalidate(); clearInterval(timer); app.remove(); };
  }, [threadId, ownerId]);
}
