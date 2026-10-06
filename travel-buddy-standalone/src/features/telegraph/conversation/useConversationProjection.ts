/**
 * Hook over `fetchConversationProjection` — one read per thread open, and again
 * when the thread changes. The answer is stored WITH the thread id it is for,
 * and an answer for any other thread reads as `loading`, so one conversation's
 * permissions are never drawn on another's screen (and an answer that arrives
 * after the thread changed is simply never shown).
 */
import { useEffect, useState } from 'react';
import {
  fetchConversationProjection,
  toProjectionState,
  type ConversationProjectionState,
} from './conversationProjection.ts';

export function useConversationProjection(threadId: string | null | undefined): ConversationProjectionState {
  const [answer, setAnswer] = useState<{ threadId: string; state: ConversationProjectionState } | null>(null);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void (async () => {
      const wire = await fetchConversationProjection(threadId);
      if (!cancelled) setAnswer({ threadId, state: toProjectionState(wire) });
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (!threadId) return { status: 'unavailable' };
  if (!answer || answer.threadId !== threadId) return { status: 'loading' };
  return answer.state;
}
