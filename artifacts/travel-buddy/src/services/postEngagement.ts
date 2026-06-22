/**
 * Post engagement service — Like, Comment, Share
 *
 * All mutations go through the API server (bearer token auth).
 * Mirrors the pattern from posts.ts: never call supabase directly.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

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
}

export interface LikeResult {
  likedByMe: boolean;
  likeCount: number;
}

export interface CommentResult {
  comment: EngagementComment;
  commentCount: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
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
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
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
      return { ok: false, message: err?.message ?? `HTTP ${res.status}` };
    }
    if (res.status === 204) return { ok: true, data: null as unknown as T };
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    if (isNetworkError(e)) return { ok: false, message: 'Network unavailable' };
    return { ok: false, message: e instanceof Error ? e.message : 'Unknown error' };
  }
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
): Promise<CommentResult | null> {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > 1000) return null;
  const res = await apiCall<CommentResult>('POST', `/api/posts/${postId}/comments`, {
    body: trimmed,
  });
  return res.ok ? res.data : null;
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
