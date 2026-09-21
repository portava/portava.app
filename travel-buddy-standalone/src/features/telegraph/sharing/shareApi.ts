/**
 * Telegraph §5 API client — the share contract, client side.
 *
 *   POST /api/threads/:id/share               share an object into a thread
 *   POST /api/threads/:id/share-projections   §5.2 layer three, resolved NOW
 *
 * §5.3 is a client-side rule as much as a server one: a card must never render
 * the sender's snapshot once the server says the source is gone. So a failed
 * resolve returns `unknown`, and the caller keeps the card in its pre-existing
 * behaviour rather than guessing in either direction — guessing "available"
 * is the backdoor, and guessing "revoked" would blank every card during a
 * network blip.
 */
import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { freshToken } from '../../../services/apiToken.ts';
import type { TelegraphAction, TelegraphObjectType } from '../sharedContext/types.ts';

export type UnavailableReason = 'deleted' | 'private' | 'unauthorized' | 'not_found' | 'unknown';

export interface TelegraphShareProjection {
  objectType: TelegraphObjectType;
  objectId: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  projectionVersion: string | null;
  deepLink: string;
}

export type ResolvedShare =
  | {
      objectType: TelegraphObjectType;
      objectId: string;
      messageId: string | null;
      available: true;
      status: string;
      projection: TelegraphShareProjection;
      actions: TelegraphAction[];
      deepLink: string;
    }
  | {
      objectType: TelegraphObjectType;
      objectId: string;
      messageId: string | null;
      available: false;
      status: string;
      reason: UnavailableReason;
      projection: null;
      actions: [];
      deepLink: string;
    };

export interface ShareRef {
  objectType: TelegraphObjectType;
  objectId: string;
  messageId?: string | null;
}

export interface ResolveResponse {
  threadId: string;
  projections: ResolvedShare[];
  unsupported: Array<{ objectType: string; objectId: string }>;
}

export type ShareResult<T> = { ok: true; data: T } | { ok: false; error: string };

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function post<T>(path: string, body: unknown): Promise<ShareResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = await freshToken();
  if (!token) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}) as any);
      return { ok: false, error: String(parsed?.error ?? res.status) };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network' };
  }
}

export async function resolveShareProjections(
  threadId: string,
  refs: ShareRef[],
): Promise<ShareResult<ResolveResponse>> {
  if (refs.length === 0) {
    return { ok: true, data: { threadId, projections: [], unsupported: [] } };
  }
  return post<ResolveResponse>(`/api/threads/${threadId}/share-projections`, { refs });
}

export async function shareObjectIntoThread(
  threadId: string,
  objectType: TelegraphObjectType,
  objectId: string,
  caption?: string | null,
): Promise<ShareResult<{ id: string; msgType: string; subtype: string }>> {
  return post(`/api/threads/${threadId}/share`, { objectType, objectId, caption: caption ?? null });
}

/**
 * The body a §6.2 PORTAVA_OBJECT message carries — a reference, never a copy.
 * Mirrors `artifacts/api-server/src/services/telegraph/shareables.ts`.
 */
export interface PortavaObjectBody {
  kind: 'PORTAVA_OBJECT';
  objectType: TelegraphObjectType;
  objectId: string;
  caption: string | null;
  shareProjectionVersion: '1';
}

export function parsePortavaObjectBody(body: string | null | undefined): PortavaObjectBody | null {
  if (typeof body !== 'string' || body.length === 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || parsed.kind !== 'PORTAVA_OBJECT') return null;
  if (parsed.shareProjectionVersion !== '1') return null;
  if (typeof parsed.objectType !== 'string' || typeof parsed.objectId !== 'string') return null;
  return {
    kind: 'PORTAVA_OBJECT',
    objectType: parsed.objectType as TelegraphObjectType,
    objectId: parsed.objectId,
    caption: typeof parsed.caption === 'string' ? parsed.caption : null,
    shareProjectionVersion: '1',
  };
}

/**
 * The legacy `discovery_card` / `post_card` bodies carry a `sourceType` string
 * that predates the §5 vocabulary. Mapping it is how an OLD card becomes
 * revocable without rewriting the rows: a type this cannot map returns null
 * and the card keeps its pre-§5 behaviour rather than being silently blanked.
 */
export function legacySourceTypeToObjectType(sourceType: unknown): TelegraphObjectType | null {
  if (typeof sourceType !== 'string') return null;
  switch (sourceType.toLowerCase()) {
    case 'hidden_gem':
    case 'gem':
      return 'HIDDEN_GEM';
    case 'place':
    case 'venue':
      return 'PLACE';
    case 'post':
      return 'POST';
    case 'trip':
      return 'TRIP';
    case 'event':
      return 'EVENT';
    case 'meetup':
      return 'MEETUP';
    case 'memory':
      return 'MEMORY';
    default:
      return null;
  }
}
