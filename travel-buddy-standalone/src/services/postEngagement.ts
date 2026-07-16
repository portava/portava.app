/**
 * Post engagement service — Like, Comment, Share, Reactions, Owner controls
 *
 * All mutations go through the API server (bearer token auth).
 * Mirrors the pattern from posts.ts: never call supabase directly.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CommentAuthor {
  id: string;
  handle: string;
  name: string;
  avatarUrl: string | null;
}

export interface EngagementComment {
  id: string;
  body: string;
  author: CommentAuthor;
  createdAt: string;
  updatedAt: string | null;
  canDelete: boolean;
  likeCount?: number;
  likedByMe?: boolean;
  /** Saved @mention annotations — whitelist for RichText. */
  tags?: Array<{ type: 'user'; id: string; matchToken: string; startChar: number; endChar: number; isBlocked?: boolean; isDeleted?: boolean }>;
  /** Saved #hashtag annotations — whitelist for RichText. */
  hashtagUsages?: Array<{ slug: string; hashtagId: string; startChar: number; endChar: number; isBlocked?: boolean }>;
}

export interface LikeResult {
  likedByMe: boolean;
  likeCount: number;
}

export interface CommentResult {
  comment: EngagementComment;
  commentCount: number;
}

export interface ReactionCount {
  emoji: string;
  count: number;
}

export interface ReactionsResult {
  reactions: ReactionCount[];
  myReaction: string | null;
  total: number;
}

export interface PostSettings {
  commentsSetting?: 'everyone' | 'friends' | 'circle' | 'trip_crew' | 'verified' | 'disabled';
  likesHidden?: boolean;
  sharingDisabled?: boolean;
  repostingDisabled?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  return freshApiToken();
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('err_address_unreachable') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

async function apiCall<T>(
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
  path: string,
  body?: object,
): Promise<{ ok: true; data: T } | { ok: false; message: string; code?: string }> {
  if (!isSupabaseConfigured || !apiBase()) {
    return { ok: false, message: 'Backend not configured' };
  }
  const token = await freshToken();
  if (!token) return { ok: false, message: 'Please sign in' };

  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { ok: false, message: err?.message ?? `HTTP ${res.status}`, code: err?.error };
    }
    if (res.status === 204) return { ok: true, data: null as unknown as T };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, message: 'Network unavailable' };
    return { ok: false, message: e instanceof Error ? e.message : 'Unknown error' };
  }
}

// ── Liked-posts preload (cache warm-up) ───────────────────────────────────────

/**
 * Fetch the current user's most-recently liked post IDs from the server.
 *
 * Called once on sign-in to pre-warm the likedPostsCache so feed rows render
 * with the correct heart state from the first paint, without waiting for the
 * feed API response.
 *
 * Uses GET /api/posts/liked-by-me which is backed by the
 * idx_posts_likes_user_created index from migration 0123.
 *
 * Returns an empty array on any error so the caller can treat it as a no-op.
 */
export async function fetchMyLikedPostIds(limit = 500): Promise<string[]> {
  const res = await apiCall<{ postIds: string[] }>(
    'GET',
    `/api/posts/liked-by-me?limit=${limit}`,
  );
  return res.ok ? (res.data.postIds ?? []) : [];
}

// ── Saved-posts preload (cache warm-up) ───────────────────────────────────────

/**
 * Fetch the current user's most-recently saved post IDs from the server.
 *
 * Called once on sign-in to pre-warm the savedPostsCache so feed rows render
 * with the correct bookmark indicator from the first paint, without waiting
 * for the feed API response.
 *
 * Uses GET /api/posts/saved-by-me which queries post_saves ordered by
 * created_at DESC (fast user-scoped scan via the user_id index).
 *
 * Returns an empty array on any error so the caller can treat it as a no-op.
 */
export async function fetchMySavedPostIds(limit = 500): Promise<string[]> {
  const res = await apiCall<{ postIds: string[] }>(
    'GET',
    `/api/posts/saved-by-me?limit=${limit}`,
  );
  return res.ok ? (res.data.postIds ?? []) : [];
}

// ── Like / Unlike ─────────────────────────────────────────────────────────────

export async function likePost(postId: string): Promise<LikeResult | null> {
  const res = await apiCall<LikeResult>('POST', `/api/posts/${postId}/like`);
  return res.ok ? res.data : null;
}

export async function unlikePost(postId: string): Promise<LikeResult | null> {
  const res = await apiCall<LikeResult>('DELETE', `/api/posts/${postId}/like`);
  return res.ok ? res.data : null;
}

// ── Reactions ─────────────────────────────────────────────────────────────────

export async function getReactions(postId: string): Promise<ReactionsResult | null> {
  const res = await apiCall<ReactionsResult>('GET', `/api/posts/${postId}/reactions`);
  return res.ok ? res.data : null;
}

export async function reactToPost(
  postId: string,
  emoji: string,
): Promise<ReactionsResult | null> {
  const res = await apiCall<ReactionsResult>('POST', `/api/posts/${postId}/reactions`, { emoji });
  return res.ok ? res.data : null;
}

export async function removeReaction(postId: string): Promise<ReactionsResult | null> {
  const res = await apiCall<ReactionsResult>('DELETE', `/api/posts/${postId}/reactions`);
  return res.ok ? res.data : null;
}

// ── Comments ──────────────────────────────────────────────────────────────────

export async function listComments(postId: string): Promise<EngagementComment[]> {
  const res = await apiCall<{ ok: boolean; comments: EngagementComment[] }>(
    'GET',
    `/api/posts/${postId}/comments`,
  );
  return res.ok ? (res.data.comments ?? []) : [];
}

export async function addComment(
  postId: string,
  body: string,
): Promise<CommentResult | null | { error: 'comments_disabled' | 'comments_limited' }> {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 1000) return null;
  const res = await apiCall<CommentResult>('POST', `/api/posts/${postId}/comments`, {
    body: trimmed,
  });
  if (res.ok) return res.data;
  if (!res.ok && (res as any).code === 'comments_disabled') return { error: 'comments_disabled' };
  if (!res.ok && (res as any).code === 'comments_limited') return { error: 'comments_limited' };
  return null;
}

export async function deleteComment(
  postId: string,
  commentId: string,
): Promise<{ commentCount: number } | null> {
  const res = await apiCall<{ ok: boolean; commentCount: number }>(
    'DELETE',
    `/api/posts/${postId}/comments/${commentId}`,
  );
  return res.ok ? { commentCount: res.data.commentCount } : null;
}

// ── Comment Likes ─────────────────────────────────────────────────────────────

export async function likeComment(
  postId: string,
  commentId: string,
): Promise<{ likedByMe: boolean; likeCount: number } | null> {
  const res = await apiCall<{ ok: boolean; likedByMe: boolean; likeCount: number }>(
    'POST',
    `/api/posts/${postId}/comments/${commentId}/like`,
  );
  return res.ok ? { likedByMe: res.data.likedByMe, likeCount: res.data.likeCount } : null;
}

export async function unlikeComment(
  postId: string,
  commentId: string,
): Promise<{ likedByMe: boolean; likeCount: number } | null> {
  const res = await apiCall<{ ok: boolean; likedByMe: boolean; likeCount: number }>(
    'DELETE',
    `/api/posts/${postId}/comments/${commentId}/like`,
  );
  return res.ok ? { likedByMe: res.data.likedByMe, likeCount: res.data.likeCount } : null;
}

// ── Post Settings (owner controls) ───────────────────────────────────────────

export async function updatePostSettings(
  postId: string,
  settings: PostSettings,
): Promise<boolean> {
  const res = await apiCall<{ ok: boolean }>('PATCH', `/api/posts/${postId}/settings`, settings);
  return res.ok;
}

// ── Archive ───────────────────────────────────────────────────────────────────

export async function archivePost(postId: string): Promise<boolean> {
  const res = await apiCall<{ ok: boolean }>('POST', `/api/posts/${postId}/archive`);
  return res.ok;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deletePost(postId: string): Promise<boolean> {
  const res = await apiCall<null>('DELETE', `/api/posts/${postId}`);
  return res.ok;
}

// ── Share ─────────────────────────────────────────────────────────────────────

export type ShareTarget = 'dm' | 'group_chat' | 'trip_crew' | 'circle' | 'external' | 'copy_link';

export async function recordShare(
  postId: string,
  target: ShareTarget,
): Promise<boolean> {
  const res = await apiCall<{ ok: boolean }>('POST', `/api/posts/${postId}/share`, { target });
  return res.ok;
}

// ── Threaded Replies ──────────────────────────────────────────────────────────

export interface EngagementReply extends EngagementComment {
  parentCommentId: string;
}

export async function listReplies(
  postId: string,
  commentId: string,
): Promise<EngagementReply[]> {
  const res = await apiCall<{ ok: boolean; replies: EngagementReply[] }>(
    'GET',
    `/api/posts/${postId}/comments/${commentId}/replies`,
  );
  return res.ok ? (res.data.replies ?? []) : [];
}

export async function addReply(
  postId: string,
  commentId: string,
  body: string,
): Promise<{ reply: EngagementReply } | null | { error: 'comments_disabled' | 'comments_limited' }> {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 1000) return null;
  const res = await apiCall<{ ok: boolean; reply: EngagementReply }>(
    'POST',
    `/api/posts/${postId}/comments/${commentId}/replies`,
    { body: trimmed },
  );
  if (res.ok) return { reply: res.data.reply };
  if (!res.ok && (res as any).code === 'comments_disabled') return { error: 'comments_disabled' };
  if (!res.ok && (res as any).code === 'comments_limited') return { error: 'comments_limited' };
  return null;
}

// ── Edit History ──────────────────────────────────────────────────────────────

export interface EditHistoryEntry {
  id: string;
  oldContent: string | null;
  newContent: string | null;
  editedAt: string;
}

export async function getEditHistory(postId: string): Promise<EditHistoryEntry[]> {
  const res = await apiCall<{ ok: boolean; edits: EditHistoryEntry[] }>(
    'GET',
    `/api/posts/${postId}/edit-history`,
  );
  return res.ok ? (res.data.edits ?? []) : [];
}
