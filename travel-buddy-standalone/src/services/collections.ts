/**
 * Collections & Saves service
 *
 * Wraps the /api/saves and /api/users/me/collections endpoints.
 * Saves are private — content owners are never notified.
 */
import { isSupabaseConfigured } from '../lib/supabase.ts';
import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from './messagingOwnerRequest.ts';

function apiBase(): string { return process.env.EXPO_PUBLIC_API_BASE_URL ?? ''; }
interface OwnedHeaders {
  owner: MessagingOwnerRequest;
  headers: Record<string, string>;
  deadline: number;
  controller: AbortController;
}
function requireCurrent(request: OwnedHeaders): void {
  if (request.controller.signal.aborted || Date.now() >= request.deadline || !request.owner.isCurrent()) {
    request.controller.abort();
    throw new Error('Saved request ended. Reopen Saved and try again.');
  }
}
async function bounded<T>(request: OwnedHeaders, work: () => Promise<T>): Promise<T> {
  requireCurrent(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([work(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { request.controller.abort(); reject(new Error('Saved request timed out.')); }, Math.max(1, request.deadline - Date.now()));
    })]);
    requireCurrent(request);
    return value;
  } finally { if (timer) clearTimeout(timer); }
}
async function authHeaders(): Promise<OwnedHeaders | null> {
  const owner = captureMessagingOwnerRequest();
  if (!owner) return null;
  const request: OwnedHeaders = { owner, headers: {}, deadline: Date.now() + 10_000, controller: new AbortController() };
  try {
    const token = await bounded(request, () => messagingOwnerToken(owner));
    if (!token) return null;
    request.headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    return request;
  } catch { return null; }
}
async function ownedFetch(url: string, init: Omit<RequestInit, 'headers'> & { headers: OwnedHeaders }): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
  const request = init.headers;
  const base = new URL(apiBase());
  const endpoint = new URL(url);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || endpoint.origin !== base.origin || endpoint.hash) throw new Error('A secure Saved API origin is required.');
  const response = await bounded(request, () => fetch(endpoint.href, { ...init, headers: request.headers,
    signal: request.controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }));
  if (response.redirected || response.url && new URL(response.url).href !== endpoint.href) throw new Error('Saved request redirected.');
  return { ok: response.ok, status: response.status, json: () => bounded(request, () => response.json()) };
}

export type EntityType =
  | 'post' | 'event' | 'trip' | 'memory' | 'highlight'
  | 'place' | 'profile' | 'hashtag' | 'gem';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Collection {
  id: string;
  name: string;
  coverUrl: string | null;
  position: number;
  isDefault: boolean;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItem {
  id: string;
  entityType: EntityType;
  entityId: string;
  placeId?: string | null;
  savedAt: string;
  title: string | null;
  coverUrl: string | null;
}

export interface SavedHashtag {
  id: string;
  slug: string;
  name: string;
  usageCount: number;
  savedAt: string | null;
}

// ── Collections CRUD ──────────────────────────────────────────────────────────

export type CollectionsRead = { ok: true; data: Collection[] } | { ok: false; data: [] };

/**
 * The caller's collections, saying whether the read happened. It used to
 * answer a failed read with [] — so the Saved screen said "No collections yet"
 * and offered starter chips that made duplicates of collections that exist.
 */
export async function readCollections(): Promise<CollectionsRead> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, data: [] };
  const headers = await authHeaders();
  if (!headers) return { ok: false, data: [] };
  try {
    const res = await ownedFetch(`${apiBase()}/api/users/me/collections`, { headers });
    if (!res.ok) return { ok: false, data: [] };
    const body = await res.json();
    return Array.isArray(body?.collections) ? { ok: true, data: body.collections as Collection[] } : { ok: false, data: [] };
  } catch {
    return { ok: false, data: [] };
  }
}

export async function createCollection(
  name: string,
  coverUrl?: string,
): Promise<Collection | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const headers = await authHeaders();
  if (!headers) return null;
  try {
    const res = await ownedFetch(`${apiBase()}/api/users/me/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, coverUrl: coverUrl ?? null }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return (body.collection ?? null) as Collection | null;
  } catch {
    return null;
  }
}

export async function updateCollection(
  collectionId: string,
  patch: { name?: string; coverUrl?: string | null; position?: number },
): Promise<Collection | null> {
  if (!isSupabaseConfigured || !apiBase()) return null;
  const headers = await authHeaders();
  if (!headers) return null;
  try {
    const res = await ownedFetch(
      `${apiBase()}/api/users/me/collections/${encodeURIComponent(collectionId)}`,
      { method: 'PATCH', headers, body: JSON.stringify(patch) },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return (body.collection ?? null) as Collection | null;
  } catch {
    return null;
  }
}

export async function deleteCollection(collectionId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  const headers = await authHeaders();
  if (!headers) return false;
  try {
    const res = await ownedFetch(
      `${apiBase()}/api/users/me/collections/${encodeURIComponent(collectionId)}`,
      { method: 'DELETE', headers },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function getCollectionItems(
  collectionId: string,
  cursor?: string,
): Promise<{ ok: true; items: CollectionItem[]; hasMore: boolean; nextCursor: string | null } | { ok: false }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  const headers = await authHeaders();
  if (!headers) return { ok: false };
  try {
    const params = new URLSearchParams({ limit: '40' });
    if (cursor) params.set('before', cursor);
    const res = await ownedFetch(
      `${apiBase()}/api/users/me/collections/${encodeURIComponent(collectionId)}/items?${params}`,
      { headers },
    );
    if (!res.ok) return { ok: false };
    const body = await res.json();
    if (!Array.isArray(body?.items) || typeof body.hasMore !== 'boolean'
      || (body.nextCursor !== null && typeof body.nextCursor !== 'string')
      || (body.hasMore && !body.nextCursor)) return { ok: false };
    return {
      ok: true,
      items: body.items as CollectionItem[],
      hasMore: body.hasMore,
      nextCursor: body.nextCursor,
    };
  } catch {
    return { ok: false };
  }
}

// ── Save / Unsave ─────────────────────────────────────────────────────────────

export async function saveItem(
  entityType: EntityType,
  entityId: string,
  collectionId?: string,
): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  const headers = await authHeaders();
  if (!headers) return false;
  // Posts use the dedicated post_saves table via /api/posts/:id/save
  if (entityType === 'post') {
    try {
      const res = await ownedFetch(`${apiBase()}/api/posts/${encodeURIComponent(entityId)}/save`, {
        method: 'POST',
        headers,
      });
      // post_saves has no collection, and this branch used to return here and
      // drop collectionId — so "Save to collection" on a post saved nothing
      // into the collection. When one is chosen, also file it there below.
      if (!res.ok || !collectionId) return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await ownedFetch(`${apiBase()}/api/saves`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, collection_id: collectionId }),
    });
    // A selected collection is part of the user's intent. Never silently
    // substitute the default collection and report the requested save worked.
    return res.ok;
  } catch {
    return false;
  }
}

export async function unsaveItem(
  entityType: EntityType,
  entityId: string,
): Promise<boolean> {
  if (!isSupabaseConfigured || !apiBase()) return false;
  const headers = await authHeaders();
  if (!headers) return false;
  // Posts use the dedicated post_saves table via /api/posts/:id/save
  if (entityType === 'post') {
    try {
      // A post saved into a collection also has collection rows (saveItem).
      // Clear those first, so an unsave never leaves the post listed in a
      // collection; if this fails nothing has changed and the post stays saved.
      const fromCollections = await ownedFetch(`${apiBase()}/api/saves`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
      });
      if (!fromCollections.ok) return false;
      const res = await ownedFetch(`${apiBase()}/api/posts/${encodeURIComponent(entityId)}/save`, {
        method: 'DELETE',
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await ownedFetch(`${apiBase()}/api/saves`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function checkSaved(
  entityType: EntityType,
  entityId: string,
): Promise<{ saved: boolean; collectionIds: string[]; ok?: boolean }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, saved: false, collectionIds: [] };
  const headers = await authHeaders();
  if (!headers) return { ok: false, saved: false, collectionIds: [] };
  try {
    const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
    const res = await ownedFetch(`${apiBase()}/api/users/me/saves?${params}`, { headers });
    if (!res.ok) return { ok: false, saved: false, collectionIds: [] };
    const body = await res.json();
    if (typeof body?.saved !== 'boolean' || !Array.isArray(body.collectionIds) || !body.collectionIds.every((id: unknown) => typeof id === 'string')) return { ok: false, saved: false, collectionIds: [] };
    return { ok: true, saved: body.saved, collectionIds: body.collectionIds };
  } catch {
    return { ok: false, saved: false, collectionIds: [] };
  }
}

// ── Hashtag saves ─────────────────────────────────────────────────────────────

/** Toggle save state for an entity. Returns the new saved state (true = saved). */
export async function toggleSave(
  entityType: EntityType,
  entityId: string,
  currentlySaved: boolean,
): Promise<boolean> {
  if (currentlySaved) {
    const ok = await unsaveItem(entityType, entityId);
    return ok ? false : true;
  } else {
    const ok = await saveItem(entityType, entityId);
    return ok ? true : false;
  }
}

export async function getSavedHashtags(): Promise<SavedHashtag[]> {
  if (!isSupabaseConfigured || !apiBase()) return [];
  const headers = await authHeaders();
  if (!headers) return [];
  try {
    const res = await ownedFetch(`${apiBase()}/api/users/me/saved-hashtags`, { headers });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.hashtags ?? []) as SavedHashtag[];
  } catch {
    return [];
  }
}

// ── Saved posts ───────────────────────────────────────────────────────────────

/**
 * The caller's saved post ids, newest first (GET /api/posts/saved-by-me, the
 * post_saves table behind every post bookmark).
 *
 * A post save only reaches a collection when one is picked, and the Saved
 * screen listed collections only, so a bookmarked post was nowhere to be
 * found. Unlike fetchMySavedPostIds (a cache warm-up that may fail quietly),
 * this reports a failed read, so the Saved screen can say "couldn't load"
 * instead of showing an empty list.
 */
export async function getMySavedPostIds(): Promise<{ ok: true; postIds: string[] } | { ok: false }> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false };
  const headers = await authHeaders();
  if (!headers) return { ok: false };
  try {
    const res = await ownedFetch(`${apiBase()}/api/posts/saved-by-me`, { headers });
    if (!res.ok) return { ok: false };
    const body = await res.json();
    return Array.isArray(body?.postIds) && body.postIds.every((id: unknown) => typeof id === 'string')
      ? { ok: true, postIds: body.postIds as string[] } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export interface SavedGem { id: string; title: string | null; savedAt: string }
/** Owner-bound legacy + current bookmarks, with current server-side visibility. */
export async function getMySavedGems(before?: string): Promise<{ ok: boolean; gems: SavedGem[]; nextCursor: string | null }> {
  const failed = { ok: false, gems: [], nextCursor: null };
  if (!isSupabaseConfigured || !apiBase()) return failed;
  const headers = await authHeaders(); if (!headers) return failed;
  try {
    const query = before ? `?${new URLSearchParams({ before })}` : '';
    const res = await ownedFetch(`${apiBase()}/api/users/me/saved-gems${query}`, { headers });
    if (!res.ok) return failed;
    const body = await res.json();
    if (!Array.isArray(body?.gems) || !body.gems.every((g: any) => typeof g?.id === 'string' && (g.title === null || typeof g.title === 'string') && typeof g.savedAt === 'string')
      || !(body.nextCursor === null || typeof body.nextCursor === 'string')) return failed;
    return { ok: true, gems: body.gems, nextCursor: body.nextCursor };
  } catch { return failed; }
}
