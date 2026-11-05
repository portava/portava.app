import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import type { Memory } from './memories.ts';

export const POST_REFERENCE_MEDIA_TYPE = 'application/vnd.portava.post-reference+json';
const PREFIX = 'portava-post-reference:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function postReferenceId(mediaType?: string | null, uri?: string | null): string | null {
  if (mediaType !== POST_REFERENCE_MEDIA_TYPE || !uri?.startsWith(PREFIX)) return null;
  const id = uri.slice(PREFIX.length); return UUID.test(id) ? id : null;
}
/** Operation ids deduplicate one user's intent; they are not bearer credentials. */
export function newPostDestinationOperation(): string {
  const runtime = globalThis as { crypto?: { randomUUID?: () => string } };
  if (runtime.crypto?.randomUUID) return runtime.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
    const random = Math.floor(Math.random() * 16); return (ch === 'x' ? random : (random & 3) | 8).toString(16);
  });
}
export type PostDestination = 'memory' | 'highlight';
export type PostDestinationResult = { referenceId: string; memoryId: string | null; highlightId: string | null; replayed?: boolean };
export type PostReferenceView = { available: true; postId: string; author: string; text: string } | { available: false };
type Result<T> = { ok: true; data: T } | { ok: false; message: string };
export type DestinationIntent = { operationId: string; destination: PostDestination; memoryId?: string | null; title?: string | null;
  note?: string | null; visibility?: 'only_me' | 'friends_only' | 'public' | 'private' };

async function request<T>(path: string, owner: MessagingOwnerRequest, body?: unknown, signal?: AbortSignal): Promise<Result<T>> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, 12000);
  try {
    const token = await messagingOwnerToken(owner);
    if (!token || !owner.isCurrent() || signal?.aborted) return { ok: false, message: 'Your signed-in session changed. Reopen this screen.' };
    const response = await fetch(`${process.env.EXPO_PUBLIC_API_BASE_URL ?? ''}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: abort.signal,
    });
    if (!owner.isCurrent() || signal?.aborted) return { ok: false, message: 'Your signed-in session changed. Reopen this screen.' };
    const data = await response.json();
    if (!owner.isCurrent() || signal?.aborted) return { ok: false, message: 'Your signed-in session changed. Reopen this screen.' };
    return response.ok ? { ok: true, data } : { ok: false, message: data.message || 'This action could not be completed. Try again.' };
  } catch { return { ok: false, message: 'Could not connect. Try again.' }; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
export async function savePostToDestination(postId: string, intent: DestinationIntent, owner: MessagingOwnerRequest): Promise<Result<PostDestinationResult>> {
  const result = await request<PostDestinationResult>(`/posts/${encodeURIComponent(postId)}/destinations`, owner, intent);
  if (!result.ok) return result;
  const row = result.data;
  if (!row || !UUID.test(row.referenceId) || (intent.destination === 'memory'
    ? !row.memoryId || !UUID.test(row.memoryId) || row.highlightId != null
    : !row.highlightId || !UUID.test(row.highlightId) || row.memoryId != null)) return { ok: false, message: 'The save could not be confirmed. Try again.' };
  return result;
}
export async function listPostDestinationMemories(owner: MessagingOwnerRequest, cursor?: string | null, signal?: AbortSignal): Promise<Result<{ memories: Memory[]; nextCursor: string | null }>> {
  const query = new URLSearchParams({ limit: '30' }); if (cursor) query.set('cursor', cursor);
  const result = await request<{ memories: Memory[]; nextCursor: string | null }>(`/users/${owner.ownerId}/memories?${query}`, owner, undefined, signal);
  if (!result.ok) return result;
  if (!Array.isArray(result.data?.memories) || result.data.memories.some(row => !row || typeof row.id !== 'string' || row.ownerId !== owner.ownerId || typeof row.visibility !== 'string')
    || (result.data.nextCursor != null && typeof result.data.nextCursor !== 'string')) return { ok: false, message: 'Your Memories could not be loaded. Try again.' };
  return result;
}
export async function readPostReference(referenceId: string, owner: MessagingOwnerRequest, signal?: AbortSignal): Promise<Result<PostReferenceView>> {
  const result = await request<PostReferenceView>(`/post-references/${encodeURIComponent(referenceId)}`, owner, undefined, signal);
  if (!result.ok) return result;
  const row = result.data;
  if (!row || (row.available !== false && (row.available !== true || !UUID.test(row.postId) || typeof row.author !== 'string' || typeof row.text !== 'string')))
    return { ok: false, message: 'This saved post could not be checked. Try again.' };
  return result;
}
export { captureMessagingOwnerRequest as capturePostDestinationOwner };
