/**
 * Telegraph §13.1 ADD_REACTION / REMOVE_REACTION, client side (census T370).
 *
 *   POST /api/telegraph/commands  { type: 'ADD_REACTION' | 'REMOVE_REACTION', conversationId, params: { messageId, emoji } }
 *     -> 200 { ok: true, command, data } | 200 { ok: false, command, reason }
 *
 * The thread read serves each message's `reactions: [{ emoji, count, mine }]` (or `null` when they
 * could not be read). This module only asks; the server decides who may react (the shared write guard:
 * membership, blocks, restrictions, E2EE) and the screen re-reads after a change, so what is drawn is
 * always the server's count, never a local guess.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

/** The reactions offered in the picker. A bounded set: a reaction is a mark, not a second message body. */
export const REACTION_CHOICES: readonly string[] = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface MessageReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

export type ReactionResult = { ok: true } | { ok: false; reason: string; message: string };

const NOT_CHANGED = 'Your reaction was not changed. Please try again.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

/** The wire's reactions, or null when they are not reactions (never guessed into []). Pure. */
export function parseReactions(v: unknown): MessageReaction[] | null {
  if (!Array.isArray(v)) return null;
  const out: MessageReaction[] = [];
  for (const r of v) {
    const x = r as Record<string, unknown> | null;
    if (!x || typeof x.emoji !== 'string' || !x.emoji || !Number.isInteger(x.count) || (x.count as number) < 1 || typeof x.mine !== 'boolean') return null;
    out.push({ emoji: x.emoji, count: x.count as number, mine: x.mine });
  }
  return out;
}

/** Add the caller's reaction, or take it back when it is already theirs. */
export async function toggleReaction(threadId: string, messageId: string, emoji: string, alreadyMine: boolean): Promise<ReactionResult> {
  if (!threadId || !messageId || !emoji) return { ok: false, reason: 'malformed', message: NOT_CHANGED };
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, reason: 'unconfigured', message: NOT_CHANGED };
  const token = await freshToken();
  if (!token) return { ok: false, reason: 'unauthenticated', message: NOT_CHANGED };
  try {
    const res = await fetch(`${apiBase()}/api/telegraph/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: alreadyMine ? 'REMOVE_REACTION' : 'ADD_REACTION', conversationId: threadId, params: { messageId, emoji } }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.ok && body?.ok === true) return { ok: true };
    return { ok: false, reason: String(body?.reason ?? body?.error ?? res.status), message: typeof body?.message === 'string' && body.message ? body.message : NOT_CHANGED };
  } catch {
    return { ok: false, reason: 'network', message: NOT_CHANGED };
  }
}
