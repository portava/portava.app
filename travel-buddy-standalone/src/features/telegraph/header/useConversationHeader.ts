/**
 * Telegraph §2.2 — read the conversation header's availability and safe
 * presence once per thread open.
 *
 * ONE READ, NOT A POLL. §4.3 says repeated refreshes must not become a
 * movement-tracking side channel, and safe presence carries a coarse venue
 * label. A header that re-read every few seconds would turn opening a chat into
 * a movement trace of the person on the other end, so this hook reads when the
 * thread is opened and does not poll. That is a client-side property and not a
 * guarantee — the server has no refresh budget — which is why §4.3's T26 stays
 * unbuilt rather than being claimed here.
 *
 * A FAILED READ DISCLOSES NOTHING. There is no fallback string: when the read
 * fails the header shows the name alone, exactly as it does when the server
 * legitimately has nothing to say. The two are indistinguishable on purpose —
 * the alternative leaks that the person HAS presence the viewer may not see.
 */
import { useEffect, useState } from 'react';
import { fetchConversationHeader } from '../sharedContext/api.ts';
import type {
  ConversationHeaderParticipant,
  ConversationHeaderResponse,
} from '../sharedContext/types.ts';

export interface ConversationHeaderState {
  loading: boolean;
  response: ConversationHeaderResponse | null;
  /** The single other participant, for a direct thread. Null for groups. */
  other: ConversationHeaderParticipant | null;
}

export function useConversationHeader(
  threadId: string | null | undefined,
): ConversationHeaderState {
  const [state, setState] = useState<ConversationHeaderState>({
    loading: false,
    response: null,
    other: null,
  });

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    void (async () => {
      const r = await fetchConversationHeader(threadId);
      if (cancelled) return;
      if (!r.ok) {
        setState({ loading: false, response: null, other: null });
        return;
      }
      const participants = r.data.participants ?? [];
      setState({
        loading: false,
        response: r.data,
        // A group header describes the crew, not one member; only a
        // two-person thread has "the other person" to describe.
        other: participants.length === 1 ? participants[0] : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  return state;
}
