/**
 * Telegraph §21 — the client side of conversation search.
 *
 * Thin on purpose. Every authorization decision, every exclusion and the whole
 * bucket taxonomy live on the server (`services/telegraphSearch.ts`); this file
 * carries an auth header and parses a response. A client that re-derived any of
 * that would be a second, divergent answer to "what may this person see", and
 * §21's whole requirement is that there is one and that it runs before
 * retrieval rather than after.
 *
 * THE DEGRADED FLAG IS NOT DROPPED
 * ================================
 * `degraded: true` means the result is a FLOOR — some conversations could not
 * be searched. A client that renders a degraded empty result as "no results"
 * tells the user their message does not exist. The screen above this renders
 * the difference, and this service preserves the field rather than normalising
 * it away.
 */
import { supabase, isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import type { SearchBucket, SearchResult } from '../types/index.ts';

export type TelegraphSearchError =
  | 'unauthenticated'
  | 'network_unreachable'
  | 'query_too_short'
  | 'not_configured'
  | 'server_error';

export interface TelegraphSearchOutcome {
  ok: boolean;
  result: SearchResult | null;
  error?: TelegraphSearchError;
}

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

function emptyCounts(): Record<SearchBucket, number> {
  return { MESSAGES: 0, PLACES: 0, MEDIA: 0, PLANS: 0, MEMORIES: 0 };
}

/** An empty result that is explicitly NOT degraded — used for "type more". */
export function emptyResult(query: string): SearchResult {
  return {
    query,
    counts: emptyCounts(),
    hits: [],
    conversationsSearched: 0,
    conversationsBounded: 0,
    degraded: false,
  };
}

/**
 * Search every conversation the caller is authorized to search, or one of them.
 *
 * `conversationId` narrows; it never widens — the server resolves the caller's
 * own membership either way, so passing a thread the caller is not in returns
 * an empty result rather than an error, and that is deliberate (a 403 there
 * would be a thread-existence oracle).
 */
export async function searchTelegraph(
  query: string,
  opts: { conversationId?: string | null; buckets?: SearchBucket[]; limit?: number } = {},
): Promise<TelegraphSearchOutcome> {
  const q = query.trim();
  if (q.length < 2) return { ok: false, result: null, error: 'query_too_short' };
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, result: null, error: 'not_configured' };

  const token = await freshToken();
  if (!token) return { ok: false, result: null, error: 'unauthenticated' };

  const params = new URLSearchParams({ q });
  if (opts.buckets && opts.buckets.length > 0) params.set('types', opts.buckets.join(','));
  if (opts.limit) params.set('limit', String(opts.limit));

  const path = opts.conversationId
    ? `/api/threads/${opts.conversationId}/search?${params.toString()}`
    : `/api/telegraph/search?${params.toString()}`;

  try {
    const res = await fetch(`${apiBase()}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, result: null, error: 'unauthenticated' };
      if (res.status === 400) return { ok: false, result: null, error: 'query_too_short' };
      return { ok: false, result: null, error: 'server_error' };
    }
    const body = (await res.json()) as SearchResult;
    return {
      ok: true,
      result: {
        ...body,
        // Never let a missing bucket key become `undefined` in the UI: §21's
        // mockup prints a line per bucket, including the zeroes.
        counts: { ...emptyCounts(), ...(body.counts ?? {}) },
        hits: body.hits ?? [],
      },
    };
  } catch {
    return { ok: false, result: null, error: 'network_unreachable' };
  }
}

/** §21 "Ask this conversation" — structured plans and places before prose. */
export async function askConversation(
  conversationId: string,
  query: string,
): Promise<{
  ok: boolean;
  structured: SearchResult['hits'];
  prose: SearchResult['hits'];
  degraded: boolean;
  error?: TelegraphSearchError;
}> {
  const q = query.trim();
  if (q.length < 2) return { ok: false, structured: [], prose: [], degraded: false, error: 'query_too_short' };
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, structured: [], prose: [], degraded: false, error: 'not_configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, structured: [], prose: [], degraded: false, error: 'unauthenticated' };

  try {
    const res = await fetch(
      `${apiBase()}/api/threads/${conversationId}/ask?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return { ok: false, structured: [], prose: [], degraded: false, error: 'server_error' };
    const body = await res.json();
    return {
      ok: true,
      structured: body.structured ?? [],
      prose: body.prose ?? [],
      degraded: Boolean(body.degraded),
    };
  } catch {
    return { ok: false, structured: [], prose: [], degraded: false, error: 'network_unreachable' };
  }
}

// `supabase` is imported for the configured-ness check above; referencing it
// here keeps the import honest rather than relying on a side effect.
void supabase;
