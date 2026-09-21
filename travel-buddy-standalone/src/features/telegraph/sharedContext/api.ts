/**
 * Telegraph §3 / §2.2 API client.
 *
 * Two reads, both member-scoped on the server:
 *   GET /api/threads/:id/shared-context      -> §3.4 projection + §11.2 mode
 *   GET /api/threads/:id/conversation-header -> §2.2 availability + safe presence
 *
 * A failed read returns `{ ok: false }` and the rail renders NOTHING rather
 * than an empty rail: "we could not tell" and "you share nothing" are
 * different statements and the surface must not conflate them. The server says
 * the same thing with its `incomplete` flag for a partial result.
 */
import { supabase, isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import type { ConversationHeaderResponse, SharedContextResponse } from './types.ts';

export type TelegraphFetchError =
  | 'unconfigured'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'network'
  | 'server';

export type TelegraphResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: TelegraphFetchError; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function classify(status: number): TelegraphFetchError {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  return 'server';
}

async function get<T>(path: string): Promise<TelegraphResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: classify(res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown';
    if (msg.includes('Network request failed') || msg.includes('fetch')) {
      return { ok: false, error: 'network' };
    }
    return { ok: false, error: 'server', message: msg };
  }
}

export async function fetchSharedContext(threadId: string): Promise<TelegraphResult<SharedContextResponse>> {
  return get<SharedContextResponse>(`/api/threads/${threadId}/shared-context`);
}

export async function fetchConversationHeader(
  threadId: string,
): Promise<TelegraphResult<ConversationHeaderResponse>> {
  return get<ConversationHeaderResponse>(`/api/threads/${threadId}/conversation-header`);
}

/** Re-exported so tests can assert the module is wired to the real supabase flag. */
export const _isConfigured = () => isSupabaseConfigured && Boolean(supabase);
