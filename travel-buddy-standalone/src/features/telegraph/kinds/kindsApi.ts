/**
 * Telegraph §6 API client — typed kinds, the content drawer, object-aware
 * search.
 *
 *   POST /api/threads/:id/typed-messages
 *   GET  /api/threads/:id/drawer?tab=…
 *   GET  /api/threads/:id/search?q=…&tab=…
 *   GET  /api/telegraph/message-kinds
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';

export const DRAWER_TABS = ['MEDIA', 'PLACES', 'PORTAVA', 'VOICE', 'GIFS', 'LINKS', 'FILES'] as const;
export type DrawerTab = (typeof DRAWER_TABS)[number];

/** §6.2's kinds this client can send. VOICE is deliberately absent — see the menu. */
export const SENDABLE_KINDS = [
  'MEDIA_ALBUM',
  'GIF',
  'LOCATION',
  'ACTION',
  'ANNOUNCEMENT',
  'SAFETY',
  'MEMORY_NOTE',
] as const;
export type SendableKind = (typeof SENDABLE_KINDS)[number];

export interface DrawerItem {
  id: string;
  senderId: string;
  createdAt: string;
  tab: DrawerTab;
  msgType: string;
  subtype: string | null;
  previewUrl: string | null;
  title: string | null;
  links: string[];
}

export interface DrawerResponse {
  threadId: string;
  tab: DrawerTab | null;
  tabs: readonly DrawerTab[];
  counts: Record<DrawerTab, number>;
  items: DrawerItem[];
  indexOnly: boolean;
  scanned: number;
  truncated: boolean;
}

export interface SearchResult {
  id: string;
  senderId: string;
  createdAt: string;
  msgType: string;
  subtype: string | null;
  tab: DrawerTab | null;
  snippet: string;
}

export interface SearchResponse {
  threadId: string;
  query: string;
  tab: DrawerTab | null;
  results: SearchResult[];
  scanned: number;
}

export type KindsResult<T> = { ok: true; data: T } | { ok: false; error: string; message?: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function call<T>(path: string, init?: RequestInit): Promise<KindsResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(body?.error ?? res.status), message: body?.message };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: 'network', message: e instanceof Error ? e.message : undefined };
  }
}

export async function sendTypedMessage(
  threadId: string,
  kind: SendableKind,
  payload: unknown,
): Promise<KindsResult<{ id: string; msgType: string; subtype: string | null }>> {
  return call(`/api/threads/${threadId}/typed-messages`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}

export async function fetchDrawer(
  threadId: string,
  tab?: DrawerTab | null,
): Promise<KindsResult<DrawerResponse>> {
  const q = tab ? `?tab=${encodeURIComponent(tab)}` : '';
  return call<DrawerResponse>(`/api/threads/${threadId}/drawer${q}`);
}

export async function searchThread(
  threadId: string,
  query: string,
  tab?: DrawerTab | null,
): Promise<KindsResult<SearchResponse>> {
  const params = new URLSearchParams({ q: query });
  if (tab) params.set('tab', tab);
  return call<SearchResponse>(`/api/threads/${threadId}/search?${params.toString()}`);
}

/**
 * The stored envelope for a typed kind — the client mirror of
 * `artifacts/api-server/src/services/telegraph/messageKinds.ts`.
 */
export interface KindEnvelope {
  kind: SendableKind;
  envelopeVersion: '1';
  payload: any;
}

export function parseKindEnvelope(
  msgType: string | null | undefined,
  body: string | null | undefined,
): KindEnvelope | null {
  if (typeof msgType !== 'string' || typeof body !== 'string' || body.length === 0) return null;
  const kind = msgType.toUpperCase() as SendableKind;
  if (!(SENDABLE_KINDS as readonly string[]).includes(kind)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || parsed.kind !== kind || parsed.envelopeVersion !== '1') return null;
  return { kind, envelopeVersion: '1', payload: parsed.payload };
}
