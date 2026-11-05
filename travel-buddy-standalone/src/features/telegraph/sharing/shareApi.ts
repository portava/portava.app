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
import { captureMessagingOwnerRequest, messagingOwnerToken, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';
import type { TelegraphAction, TelegraphObjectType } from '../sharedContext/types.ts'; import { shareProjectionHeaders } from '../negotiation/clientCapabilities.ts'; // census-telegraph T431

export type UnavailableReason = 'deleted' | 'private' | 'unauthorized' | 'not_found' | 'unknown';

export interface TelegraphShareProjection {
  objectType: TelegraphObjectType;
  objectId: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  projectionVersion: string | null;
  deepLink: string; /** census-telegraph T265: on a PLACE, Discovery's own why-now and its validity, when Discovery would serve one. */ liveIntelligence?: PlaceLiveIntelligenceWire | null;
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

async function post<T>(path: string, body: unknown, owner?: MessagingOwnerRequest, extraHeaders?: Record<string, string>): Promise<ShareResult<T>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const token = owner ? await messagingOwnerToken(owner) : await freshToken();
  if (!token || (owner && !owner.isCurrent())) return { ok: false, error: 'unauthenticated' };
  try {
    const res = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(extraHeaders ?? {}) },
      body: JSON.stringify(body),
    });
    if (owner && !owner.isCurrent()) return { ok: false, error: 'unauthenticated' };
    if (!res.ok) {
      const parsed = await res.json().catch(() => ({}) as any);
      if (owner && !owner.isCurrent()) return { ok: false, error: 'unauthenticated' };
      return { ok: false, error: String(parsed?.error ?? res.status) };
    }
    const data = (await res.json()) as T;
    if (owner && !owner.isCurrent()) return { ok: false, error: 'unauthenticated' };
    return { ok: true, data };
  } catch (e) {
    if (owner && !owner.isCurrent()) return { ok: false, error: 'unauthenticated' };
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
  return post<ResolveResponse>(`/api/threads/${threadId}/share-projections`, { refs }, undefined, shareProjectionHeaders()); // §30A.16 (T431): the card's schemas and the actions it can offer
}

export async function shareObjectIntoThread(
  threadId: string,
  objectType: TelegraphObjectType,
  objectId: string,
  caption?: string | null,
): Promise<ShareResult<{ id: string; msgType: string; subtype: string }>> {
  if (!isSupabaseConfigured || !apiBase()) return { ok: false, error: 'unconfigured' };
  const owner = captureMessagingOwnerRequest();
  if (!owner) return { ok: false, error: 'unauthenticated' };
  return post(`/api/threads/${threadId}/share`, { objectType, objectId, caption: caption ?? null }, owner);
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

/**
 * census-telegraph T448 / T359 / T445 (lane w-tg-cardtruth, 2026-10-14) — the
 * SERVER's truth about a legacy shared card, carried on the message as `card`
 * (`artifacts/api-server/src/services/telegraph/sharedCardTruth.ts`).
 *
 * Every server reader now re-resolves a card's source for the viewer in one
 * batch and serves the card's body accordingly: the live projection in the
 * card's own shape, or the reference and the sender's caption with nothing from
 * the source. `card` says which, so a card that has it needs no request of its
 * own — the per-card round trip `useShareRevocation` used to make is the N+1
 * this replaces. A server too old to send it leaves the field absent, and the
 * card resolves for itself exactly as before.
 */
export type SharedCardTruth =
  | {
      kind: string;
      state: 'live';
      objectType: TelegraphObjectType;
      objectId: string;
      status: string;
      projection: TelegraphShareProjection;
      actions: TelegraphAction[];
      deepLink: string;
    }
  | {
      kind: string;
      state: 'unavailable';
      objectType: TelegraphObjectType;
      objectId: string;
      reason: UnavailableReason;
      deepLink: string;
    }
  | { kind: string; state: 'withheld'; reason: 'no_source' };

/**
 * A Compass card's reference — `cardType` + `id` as GET /compass/telegraph
 * projects a Compass item: an event is a bare id, a hidden gem `gem:<id>`.
 * Mirrors the server's `compassCardRef`. A `place:` id names a
 * `discovery_places` row, which no §5 family reads, so it maps to nothing and
 * the card is shown as a reference — never as the sender's snapshot.
 */
export function compassCardRef(
  card: { id?: unknown; cardType?: unknown } | null | undefined,
): { objectType: TelegraphObjectType; objectId: string } | null {
  if (!card) return null;
  const id = typeof card.id === 'string' ? card.id.trim() : '';
  const cardType = typeof card.cardType === 'string' ? card.cardType : '';
  if (!id) return null;
  if (cardType === 'event') return id.includes(':') ? null : { objectType: 'EVENT' as TelegraphObjectType, objectId: id };
  if (cardType === 'hidden_gem' && id.startsWith('gem:') && id.length > 4) {
    return { objectType: 'HIDDEN_GEM' as TelegraphObjectType, objectId: id.slice(4) };
  }
  return null;
}

/** The one sentence a card the server could not vouch for may say. Names nothing from the source. */
export const SHARED_CARD_UNVERIFIABLE_COPY = 'This shared item can’t be shown right now.';

/**
 * Fix round 1 (verifier F1) — a legacy card's source id in its canonical form,
 * mirroring the server's `normalizeSourceId` (services/telegraph/sharedCardTruth.ts).
 * The Discovery feed serves a canonical place as `db/<uuid>` and the For-You tab
 * shares that id; every §5 family keys its source by uuid. So `db/` is stripped,
 * and an id that is then not a uuid names nothing to resolve (null).
 */
export function normalizeLegacySourceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  const id = t.startsWith('db/') ? t.slice(3) : t;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

import type { PlaceLiveIntelligenceWire } from './placeLiveIntelligence.ts'; // census-telegraph T265 (appended so cited lines keep their numbers)
