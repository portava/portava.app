/**
 * Engagement likers service — fetch users who liked / reacted to content.
 *
 * Backed by GET /api/engagement/likes.
 * Supports cursor-based pagination for large like counts.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LikeTargetType =
  | 'post_like'
  | 'post_reaction'
  | 'comment_like'
  | 'highlight_like'
  | 'memory_like';

export interface LikerUser {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  isFollowing: boolean;
  followsYou: boolean;
  likedAt: string;
}

export interface LikersPage {
  users: LikerUser[];
  nextCursor: string | null;
  hasMore: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface GetLikersOpts {
  reactionType?: string;
  cursor?: string;
  limit?: number;
  q?: string;
}

/**
 * Fetch a page of users who liked or reacted to a piece of content.
 *
 * @param targetType  The type of engagement to query.
 * @param targetId    UUID of the target entity (post, comment, etc.).
 * @param opts.reactionType  For `post_reaction`: filter to a specific emoji.
 * @param opts.cursor        ISO timestamp cursor from the previous page's `nextCursor`.
 * @param opts.limit         Page size, 1–50 (default 20).
 * @param opts.q             Search query for filtering by name/handle.
 * @returns `LikersPage` on success, `null` on error.
 */
export async function getLikers(
  targetType: LikeTargetType,
  targetId: string,
  opts: GetLikersOpts = {},
): Promise<LikersPage | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;

  const token = await freshToken();
  if (!token) return null;

  const params = new URLSearchParams({ targetType, targetId });
  if (opts.reactionType) params.set('reactionType', opts.reactionType);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.q) params.set('q', opts.q);

  try {
    const res = await fetch(`${apiBase()}/api/engagement/likes?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.ok) return null;
    return {
      users: data.users ?? [],
      nextCursor: data.nextCursor ?? null,
      hasMore: data.hasMore ?? false,
    };
  } catch {
    return null;
  }
}
