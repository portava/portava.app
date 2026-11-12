import { fetchOwnedApi, type OwnedApiContext } from './ownedApiRequest.ts';
import type { EngagementComment, EngagementReply } from './postEngagement.ts';

function validRow(row: unknown): row is EngagementComment {
  if (!row || typeof row !== 'object') return false;
  const value = row as Partial<EngagementComment>;
  return typeof value.id === 'string' && value.id.length > 0 && typeof value.body === 'string'
    && typeof value.author?.id === 'string' && (value.author.handle == null || typeof value.author.handle === 'string')
    && (value.author.name == null || typeof value.author.name === 'string') && typeof value.createdAt === 'string'
    && typeof value.canDelete === 'boolean';
}

function normalizeAuthor<T extends EngagementComment>(row: T): T {
  // Older valid profiles may have no display name or handle. Keep their
  // authoritative ID and let the UI's existing identity fallback render them.
  return {...row, author: {...row.author, handle: row.author.handle ?? '', name: row.author.name ?? ''}};
}

export type CommentSnapshot = { ok: true; comments: EngagementComment[] } | { ok: false; denied: boolean };
export async function readLiveComments(postId: string, context: OwnedApiContext): Promise<CommentSnapshot> {
  try {
    const response = await fetchOwnedApi(`/api/posts/${encodeURIComponent(postId)}/comments`, context);
    if (!response.ok) return { ok: false, denied: [401, 403, 404, 410].includes(response.status) };
    const data = await response.json();
    if (data?.ok === false || !Array.isArray(data?.comments) || !data.comments.every(validRow)) return { ok: false, denied: false };
    return { ok: true, comments: data.comments.map(normalizeAuthor) };
  } catch { return { ok: false, denied: false }; }
}

export async function readLiveReplies(postId: string, commentId: string, context: OwnedApiContext): Promise<{ ok: true; replies: EngagementReply[] } | { ok: false; denied: boolean }> {
  try {
    const response = await fetchOwnedApi(`/api/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/replies`, context);
    if (!response.ok) return { ok: false, denied: [401, 403, 404, 410].includes(response.status) };
    const data = await response.json();
    if (data?.ok === false || !Array.isArray(data?.replies) || !data.replies.every(validRow)) return { ok: false, denied: false };
    return { ok: true, replies: data.replies.map(normalizeAuthor) };
  } catch { return { ok: false, denied: false }; }
}
