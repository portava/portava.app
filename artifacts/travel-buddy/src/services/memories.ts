/**
 * Memories service — wraps /api/memories endpoints.
 */
import { supabase } from '../lib/supabase.ts';
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await freshApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type MemoryVisibility =
  | 'public'
  | 'friends_only'
  | 'trip_crew'
  | 'circle_only'
  | 'only_me'
  | 'custom';

export interface MemoryItem {
  id: string;
  mediaUrl: string;
  mediaType: string;
  caption: string | null;
  position: number;
  createdAt: string;
}

export interface MemoryOwner {
  id: string;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

export interface Memory {
  id: string;
  ownerId: string;
  title: string | null;
  caption: string | null;
  visibility: MemoryVisibility;
  allowedUserIds: string[];
  hiddenUserIds: string[];
  tripId: string | null;
  eventId: string | null;
  placeId: string | null;
  locationCity: string | null;
  locationCountry: string | null;
  locationLat: number | null;
  locationLng: number | null;
  canonicalLocationId: string | null;
  startsAt: string | null;
  endsAt: string | null;
  state: string;
  createdAt: string;
  updatedAt: string | null;
  items?: MemoryItem[];
  likeCount?: number;
  likedByMe?: boolean;
  saveCount?: number;
  savedByMe?: boolean;
  cover?: { mediaUrl: string; mediaType: string } | null;
  owner?: MemoryOwner | null;
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Upload a local media URI to Supabase Storage (memories bucket) and return
 * a public URL. Returns null on failure.
 */
export async function uploadMemoryMedia(
  localUri: string,
  mediaType: string,
): Promise<string | null> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;

    const response = await fetch(localUri);
    const blob = await response.blob();

    const ext = mediaType.startsWith('video') ? 'mp4' : 'jpg';
    const path = `memories/${userId}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    const { error } = await supabase.storage
      .from('post-media')
      .upload(path, blob, { contentType: mediaType, upsert: false });

    if (error) return null;

    const { data: urlData } = supabase.storage.from('post-media').getPublicUrl(path);
    return urlData?.publicUrl ?? null;
  } catch {
    return null;
  }
}

// ── Create ────────────────────────────────────────────────────────────────────

export interface CreateMemoryInput {
  title?: string | null;
  caption?: string | null;
  visibility?: MemoryVisibility;
  tripId?: string | null;
  eventId?: string | null;
  placeId?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  canonicalLocationId?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  state?: 'draft' | 'published';
  taggedUserIds?: string[];
}

export async function createMemory(
  input: CreateMemoryInput,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        title: input.title ?? null,
        caption: input.caption ?? null,
        visibility: input.visibility ?? 'friends_only',
        tripId: input.tripId ?? null,
        eventId: input.eventId ?? null,
        placeId: input.placeId ?? null,
        locationCity: input.locationCity ?? null,
        locationCountry: input.locationCountry ?? null,
        locationLat: input.locationLat ?? null,
        locationLng: input.locationLng ?? null,
        canonicalLocationId: input.canonicalLocationId ?? null,
        startsAt: input.startsAt ?? null,
        endsAt: input.endsAt ?? null,
        state: input.state ?? 'published',
        taggedUserIds: input.taggedUserIds ?? [],
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Get single memory ─────────────────────────────────────────────────────────

export async function getMemory(
  id: string,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/memories/${id}`, { headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Discovery feed ────────────────────────────────────────────────────────────

export interface MemoryFeedFilter {
  city?: string | null;
  country?: string | null;
  canonicalLocationId?: string | null;
}

export async function getMemoryFeed(
  limit = 20,
  cursor?: string | null,
  filter?: MemoryFeedFilter | null,
): Promise<{ ok: true; memories: Memory[]; nextCursor: string | null } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (filter?.canonicalLocationId) params.set('canonicalLocationId', filter.canonicalLocationId);
    else if (filter?.city)           params.set('city', filter.city);
    if (filter?.country)             params.set('country', filter.country);
    const res = await fetch(`${apiBase()}/api/memories?${params}`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, memories: json.memories ?? [], nextCursor: json.nextCursor ?? null };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Create from trip ──────────────────────────────────────────────────────────

export async function createTripMemory(
  tripId: string,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/memory`, {
      method: 'POST',
      headers,
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: (j as any).message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Get trip memory ───────────────────────────────────────────────────────────

export async function getTripMemory(
  tripId: string,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/memory`, { headers });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: (j as any).message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Get user memories ─────────────────────────────────────────────────────────

export async function getUserMemories(
  userId: string,
  cursor?: string | null,
): Promise<{ ok: true; memories: Memory[]; nextCursor: string | null } | { ok: false; message: string }> {
  try {
    const headers = await authHeader();
    const params = new URLSearchParams({ limit: '30' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${apiBase()}/api/users/${userId}/memories?${params}`, { headers });
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const json = await res.json();
    return { ok: true, memories: json.memories ?? [], nextCursor: json.nextCursor ?? null };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Add item (upload + register) ──────────────────────────────────────────────

/**
 * Register a memory item using an already-uploaded URL (no re-upload).
 * Use this when the upload has already been performed by `useMediaComposer.uploadAll()`
 * so that upload progress and retry UI work correctly.
 */
export async function addMemoryItemFromUrl(
  memoryId: string,
  mediaUrl: string,
  mediaType: string,
  caption?: string | null,
  position?: number,
): Promise<{ ok: true; item: MemoryItem } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/memories/${memoryId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mediaUrl,
        mediaType,
        caption: caption ?? null,
        position: position ?? 0,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, item: json.item };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

export async function addMemoryItem(
  memoryId: string,
  localUri: string,
  mediaType: string,
  caption?: string | null,
  position?: number,
): Promise<{ ok: true; item: MemoryItem } | { ok: false; message: string }> {
  const mediaUrl = await uploadMemoryMedia(localUri, mediaType);
  if (!mediaUrl) return { ok: false, message: 'Upload failed. Check your connection and try again.' };

  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/memories/${memoryId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mediaUrl,
        mediaType,
        caption: caption ?? null,
        position: position ?? 0,
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, item: json.item };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Delete item ───────────────────────────────────────────────────────────────

export async function deleteMemoryItem(
  memoryId: string,
  itemId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/memories/${memoryId}/items/${itemId}`, {
      method: 'DELETE',
      headers,
    });
    return { ok: res.status === 204 };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Update memory ─────────────────────────────────────────────────────────────

export interface UpdateMemoryInput {
  title?: string | null;
  caption?: string | null;
  visibility?: MemoryVisibility;
  placeId?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  locationLat?: number | null;
  locationLng?: number | null;
  canonicalLocationId?: string | null;
  state?: 'draft' | 'published' | 'archived';
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
): Promise<{ ok: true; memory: Memory } | { ok: false; message: string }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/memories/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return { ok: false, message: j.message ?? `HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error' };
  }
}

// ── Delete memory ─────────────────────────────────────────────────────────────

export async function deleteMemory(id: string): Promise<{ ok: boolean }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/memories/${id}`, {
      method: 'DELETE',
      headers,
    });
    return { ok: res.status === 204 };
  } catch {
    return { ok: false };
  }
}

// ── Like / unlike ─────────────────────────────────────────────────────────────

export async function likeMemory(id: string): Promise<{ ok: boolean; likeCount?: number }> {
  try {
    const headers = { ...(await authHeader()), 'Content-Type': 'application/json' };
    const res = await fetch(`${apiBase()}/api/memories/${id}/like`, { method: 'POST', headers });
    if (!res.ok) return { ok: false };
    const json = await res.json();
    return { ok: true, likeCount: json.likeCount };
  } catch {
    return { ok: false };
  }
}

export async function unlikeMemory(id: string): Promise<{ ok: boolean; likeCount?: number }> {
  try {
    const headers = await authHeader();
    const res = await fetch(`${apiBase()}/api/memories/${id}/like`, { method: 'DELETE', headers });
    if (!res.ok) return { ok: false };
    const json = await res.json();
    return { ok: true, likeCount: json.likeCount };
  } catch {
    return { ok: false };
  }
}
