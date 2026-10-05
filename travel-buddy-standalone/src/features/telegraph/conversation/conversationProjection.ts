/**
 * Telegraph §24 / §14.1 — what the conversation screen may offer, ASKED of the
 * server rather than worked out from raw tables.
 *
 *   GET /api/threads/:id/capabilities   §14.1's ten capabilities + two facts
 *
 * §24's closing rule: "Mobile clients consume server-built projections instead
 * of independently joining raw tables and reimplementing authorization/business
 * logic." The thread screen used to read `message_thread_members` twice (a head
 * count, and the caller's own row as an "accepted member" gate) and
 * `message_threads.is_e2ee` once — three client bypass sites (census T295).
 * They now come from here.
 *
 * NOT A GATE. Every action the screen offers is re-authorized by the route that
 * performs it. These answers decide only what is OFFERED, so each one has a
 * defined "not known" reading, chosen on the side that offers less:
 *
 *   - canSendMessage unknown (loading, failed, degraded) → do not offer the
 *     plan-a-meetup control.
 *   - isE2ee unknown → treat as encrypted for the EDIT affordance (an E2EE
 *     thread refuses edits server-side; offering one that will be refused is
 *     the wrong default), and never draw the "encrypted" badge on a guess.
 *   - memberCount unknown → the header says what kind of thread it is, never
 *     a number nobody measured.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export interface ConversationProjectionWire {
  conversationId: string;
  conversationType: string;
  capabilities: Record<string, boolean>;
  reasons: Record<string, string | null>;
  degraded: boolean;
  conversation?: { memberCount: number | null; isE2ee: boolean | null; degraded: boolean };
}

export type ConversationProjectionState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | {
      status: 'ready';
      canSendMessage: boolean;
      /** True when the server said its own answer rests on a failed read. */
      degraded: boolean;
      memberCount: number | null;
      isE2ee: boolean | null;
    };

/** Fold the wire answer into the screen's state. Pure. */
export function toProjectionState(wire: ConversationProjectionWire | null): ConversationProjectionState {
  if (!wire || typeof wire !== 'object' || !wire.capabilities) return { status: 'unavailable' };
  const facts = wire.conversation ?? null;
  return {
    status: 'ready',
    canSendMessage: wire.capabilities.canSendMessage === true,
    degraded: wire.degraded === true || facts?.degraded === true,
    memberCount: typeof facts?.memberCount === 'number' ? facts.memberCount : null,
    isE2ee: typeof facts?.isE2ee === 'boolean' ? facts.isE2ee : null,
  };
}

/** Offer the plan-a-meetup control only on an affirmative, non-degraded answer. */
export function offersPlanControl(state: ConversationProjectionState): boolean {
  return state.status === 'ready' && state.canSendMessage && !state.degraded;
}

/** For the EDIT affordance: unknown is treated as encrypted (offer less). */
export function treatAsE2eeForEdit(state: ConversationProjectionState): boolean {
  return !(state.status === 'ready' && state.isE2ee === false);
}

/** For the "encrypted" badge: only an affirmative answer draws it. */
export function showsE2eeBadge(state: ConversationProjectionState): boolean {
  return state.status === 'ready' && state.isE2ee === true;
}

/** The group header's member count, or null when it was not measured. */
export function memberCountOf(state: ConversationProjectionState): number | null {
  return state.status === 'ready' ? state.memberCount : null;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function fetchConversationProjection(
  threadId: string,
): Promise<ConversationProjectionWire | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const token = await freshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${apiBase()}/api/threads/${threadId}/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as ConversationProjectionWire;
  } catch {
    return null;
  }
}
