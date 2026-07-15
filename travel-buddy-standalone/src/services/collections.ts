/**
 * Collections & Saves service
 *
 * Wraps the /api/saves and /api/users/me/collections endpoints.
 * Saves are private — content owners are never notified.
 */
import { supabase, isSupabaseConfigured } from '../lib/supabase';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function freshToken(): Promise<string | null> {
  const { data: refreshed } = await supabase.auth.refreshSession();
  const session = refreshed?.session ?? (await supabase.auth.getSession()).data.session;
  return session?.access_token ?? null;
}

async function authHeaders(): Promise<Record<string, string> | null> {
  const token = await freshToken();
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export type EntityType =
  | 'post' | 'event' | 'trip' | 'memory' | 'highlight'
  | 'place' | 'profile' | 'hashtag';

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

export async function getCollections(): Promise<Collection[]> {
  if (!isSupabaseConfigured || !apiBase()) return [];
  const headers = await authHeaders();
  if (!headers) return [];
  try {
    const res = await fetch(`${apiBase()}/api/users/me/collections`, { headers });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.collections ?? []) as Collection[];
  } catch {
    return [];
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
    const res = await fetch(`${apiBase()}/api/users/me/collections`, {
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
    const res = await fetch(
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
    const res = await fetch(
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
): Promise<{ items: CollectionItem[]; hasMore: boolean; nextCursor: string | null }> {
  if (!isSupabaseConfigured || !apiBase()) return { items: [], hasMore: false, nextCursor: null };
  const headers = await authHeaders();
  if (!headers) return { items: [], hasMore: false, nextCursor: null };
  try {
    const params = new URLSearchParams({ limit: '40' });
    if (cursor) params.set('before', cursor);
    const res = await fetch(
      `${apiBase()}/api/users/me/collections/${encodeURIComponent(collectionId)}/items?${params}`,
      { headers },
    );
    if (!res.ok) return { items: [], hasMore: false, nextCursor: null };
    const body = await res.json();
    return {
      items:      (body.items ?? []) as CollectionItem[],
      hasMore:    body.hasMore ?? false,
      nextCursor: body.nextCursor ?? null,
    };
  } catch {
    return { items: [], hasMore: false, nextCursor: null };
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
      const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(entityId)}/save`, {
        method: 'POST',
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(`${apiBase()}/api/saves`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, collection_id: collectionId }),
    });
    if (res.ok) return true;
    if (collectionId && (res.status === 404 || res.status === 400)) {
      const retry = await fetch(`${apiBase()}/api/saves`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ entity_type: entityType, entity_id: entityId }),
      });
      return retry.ok;
    }
    return false;
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
      const res = await fetch(`${apiBase()}/api/posts/${encodeURIComponent(entityId)}/save`, {
        method: 'DELETE',
        headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  try {
    const res = await fetch(`${apiBase()}/api/saves`, {
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
): Promise<{ saved: boolean; collectionIds: string[] }> {
  if (!isSupabaseConfigured || !apiBase()) return { saved: false, collectionIds: [] };
  const headers = await authHeaders();
  if (!headers) return { saved: false, collectionIds: [] };
  try {
    const params = new URLSearchParams({ entity_type: entityType, entity_id: entityId });
    const res = await fetch(`${apiBase()}/api/users/me/saves?${params}`, { headers });
    if (!res.ok) return { saved: false, collectionIds: [] };
    const body = await res.json();
    return { saved: body.saved ?? false, collectionIds: body.collectionIds ?? [] };
  } catch {
    return { saved: false, collectionIds: [] };
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
    const res = await fetch(`${apiBase()}/api/users/me/saved-hashtags`, { headers });
    if (!res.ok) return [];
    const body = await res.json();
    return (body.hashtags ?? []) as SavedHashtag[];
  } catch {
    return [];
  }
}
