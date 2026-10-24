/**
 * Telegraph §30A.9 — forwarding one message into another conversation, client side (census T406).
 *
 *   POST /api/threads/:targetThreadId/forward   { sourceMessageId }  -> 201 { id, forwarded: { provenance } }
 *
 * The server decides everything: whether the caller can see the source, whether its author allowed it
 * (ALLOW / NO_FORWARD / SOURCE_POLICY / EXPIRES_WITH_SOURCE), and what the copy is — FORWARDED for a
 * person's words, RESHARED_FROM_SOURCE for a Portava object, which every recipient re-resolves under
 * their own authorization. The new audience is told the word "Forwarded" and nothing about where it
 * came from; the lineage stays server-side. A refusal is the server's sentence, shown as it came.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export const FORWARDING_FLAG = 'telegraph_forwarding_enabled';

export type ForwardProvenance = 'FORWARDED' | 'RESHARED_FROM_SOURCE';

export type ForwardResult =
  | { ok: true; messageId: string; provenance: ForwardProvenance | null }
  | { ok: false; error: string; message: string };

const NOT_FORWARDED = 'The message was not forwarded. Nothing was sent.';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export async function forwardMessage(targetThreadId: string, sourceMessageId: string): Promise<ForwardResult> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured', message: NOT_FORWARDED };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated', message: NOT_FORWARDED };
  try {
    const res = await fetch(`${apiBase()}/api/threads/${targetThreadId}/forward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sourceMessageId }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      return {
        ok: false,
        error: String(body?.error ?? res.status),
        message: typeof body?.message === 'string' && body.message.length > 0 ? body.message : NOT_FORWARDED,
      };
    }
    if (typeof body?.id !== 'string' || body.id.length === 0) return { ok: false, error: 'malformed_response', message: NOT_FORWARDED };
    const p = body?.forwarded?.provenance;
    return { ok: true, messageId: body.id, provenance: p === 'FORWARDED' || p === 'RESHARED_FROM_SOURCE' ? p : null };
  } catch {
    return { ok: false, error: 'network', message: NOT_FORWARDED };
  }
}

/** Where a message may be forwarded: any other live conversation of the caller's. Pure. */
export function forwardTargets<T extends { id: string; status?: string | null; archivedAt?: string | null }>(
  threads: readonly T[],
  sourceThreadId: string | null,
): T[] {
  return threads.filter((t) => t.id !== sourceThreadId && (t.status ?? 'active') === 'active' && !t.archivedAt);
}
