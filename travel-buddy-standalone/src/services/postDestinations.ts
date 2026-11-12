import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';
import type { Memory } from './memories.ts';

import { POST_REFERENCE_MEDIA_TYPE, POST_REFERENCE_PREFIX as PREFIX, POST_UUID as UUID } from '../constants/postReference.ts';
export { POST_REFERENCE_MEDIA_TYPE } from '../constants/postReference.ts';
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
export type PostDestination = 'memory' | 'highlight' | 'profile';
export type PostDestinationResult = { referenceId: string; memoryId: string | null; highlightId: string | null; profilePostId?: string | null; replayed?: boolean };
export type ReferenceMedia = { type: 'image' | 'video'; uri: string; thumbnailUri: string | null };
export type PostReferenceView = { available: true; postId: string; author: string; text: string; media?: ReferenceMedia[] } | { available: false };
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
    const data = await response.json().catch(() => null);
    if (!owner.isCurrent() || signal?.aborted) return { ok: false, message: 'Your signed-in session changed. Reopen this screen.' };
    if (!response.ok) return { ok: false, message: typeof data?.message === 'string' && data.message.trim()
      ? data.message : 'Sharing is temporarily unavailable. Please try again shortly.' };
    if (!data) return { ok: false, message: 'The save could not be confirmed. Try again.' };
    return { ok: true, data };
  } catch { return { ok: false, message: 'Could not connect. Try again.' }; }
  finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}
export async function savePostToDestination(postId: string, intent: DestinationIntent, owner: MessagingOwnerRequest): Promise<Result<PostDestinationResult>> {
  const result = await request<PostDestinationResult>(`/posts/${encodeURIComponent(postId)}/destinations`, owner, intent);
  if (!result.ok) return result;
  const row = result.data;
  const destinations = { memory: row?.memoryId, highlight: row?.highlightId, profile: row?.profilePostId };
  if (!row || !UUID.test(row.referenceId) || !UUID.test(destinations[intent.destination] ?? '')
    || Object.entries(destinations).some(([key, value]) => key !== intent.destination && value != null)) {
    return { ok: false, message: 'The save could not be confirmed. Try again.' };
  }
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
function validMediaUri(uri: unknown): uri is string {
  if (typeof uri !== 'string' || /[\u0000-\u001f\\?#]/.test(uri)) return false;
  const [bucket, owner, ...parts] = uri.split('/');
  return bucket === 'post-media' && !!owner && owner !== '.' && owner !== '..'
    && parts.length > 0 && parts.every(part => part !== '' && part !== '.' && part !== '..');
}
async function readCheckedPost(path: string, owner: MessagingOwnerRequest, signal?: AbortSignal): Promise<Result<PostReferenceView>> {
  const result = await request<PostReferenceView>(path, owner, undefined, signal);
  if (!result.ok) return result;
  const row = result.data;
  if (row?.available === false) return { ok: true, data: { available: false } };
  if (row?.available !== true || !UUID.test(row.postId) || typeof row.author !== 'string' || typeof row.text !== 'string'
    || (row.media != null && (!Array.isArray(row.media) || row.media.some(item => !item || !['image', 'video'].includes(item.type)
      || !validMediaUri(item.uri) || (item.thumbnailUri != null && !validMediaUri(item.thumbnailUri)))))) {
    return { ok: false, message: 'This shared post could not be checked. Try again.' };
  }
  return result;
}
export function readPostReference(referenceId: string, owner: MessagingOwnerRequest, signal?: AbortSignal) {
  return readCheckedPost(`/post-references/${encodeURIComponent(referenceId)}`, owner, signal);
}
export function readPostSharePreview(postId: string, owner: MessagingOwnerRequest, signal?: AbortSignal) {
  return readCheckedPost(`/posts/${encodeURIComponent(postId)}/share-preview`, owner, signal);
}
export { captureMessagingOwnerRequest as capturePostDestinationOwner };
