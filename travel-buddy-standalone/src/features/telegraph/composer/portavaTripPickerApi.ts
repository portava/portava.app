import { isSupabaseConfigured } from '../../../lib/supabase.ts';
import { messagingOwnerToken, type MessagingOwnerRequest } from '../../../services/messagingOwnerRequest.ts';

export interface PortavaTripIntent {
  readonly generation: number;
  readonly threadId: string;
  readonly owner: MessagingOwnerRequest;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}

export interface OwnedTripChoice { id: string; title: string }
type Failure = { ok: false; reason: 'stale' | 'unavailable' | 'refused' | 'unknown'; message: string };
export type TripChoicesResult = { ok: true; trips: OwnedTripChoice[] } | Failure;
export type TripShareResult = { ok: true; messageId: string } | Failure;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE: Failure = { ok: false, reason: 'stale', message: 'This sharing session changed. Close the picker and reopen it.' };
const UNAVAILABLE: Failure = { ok: false, reason: 'unavailable', message: 'Your trips could not be loaded. Please try again.' };
const UNKNOWN: Failure = { ok: false, reason: 'unknown', message: 'We could not confirm whether this trip was shared. Check the conversation before trying again.' };

function current(intent: PortavaTripIntent): boolean {
  return !intent.signal.aborted && intent.owner.isCurrent() && intent.isCurrent();
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function request(intent: PortavaTripIntent, path: string, body?: unknown): Promise<{ response: Response; data: unknown } | Failure> {
  if (!current(intent)) return STALE;
  const base = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '');
  if (!isSupabaseConfigured || !base) return UNAVAILABLE;
  try {
    const token = await messagingOwnerToken(intent.owner);
    if (!token || !current(intent)) return STALE;
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: intent.signal,
    });
    if (!current(intent)) return STALE;
    const data: unknown = await response.json();
    if (!current(intent)) return STALE;
    return { response, data };
  } catch {
    return !current(intent) ? STALE : body === undefined ? UNAVAILABLE : UNKNOWN;
  }
}

export async function loadOwnedTripChoices(intent: PortavaTripIntent): Promise<TripChoicesResult> {
  const result = await request(intent, '/api/trips/me');
  if ('ok' in result) return result;
  if (!result.response.ok || !record(result.data) || !Array.isArray(result.data.trips)) return UNAVAILABLE;
  const trips = new Map<string, OwnedTripChoice>();
  for (const row of result.data.trips) {
    if (!record(row) || typeof row.ownerId !== 'string') return UNAVAILABLE;
    if (row.ownerId !== intent.owner.ownerId) continue;
    if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.title !== 'string') return UNAVAILABLE;
    trips.set(row.id, { id: row.id, title: row.title.trim() || 'Untitled trip' });
  }
  return { ok: true, trips: [...trips.values()] };
}

export async function shareOwnedTripReference(intent: PortavaTripIntent, tripId: string): Promise<TripShareResult> {
  if (!current(intent)) return STALE;
  if (!UUID.test(intent.threadId) || !UUID.test(tripId)) {
    return { ok: false, reason: 'refused', message: 'This trip could not be shared.' };
  }
  const result = await request(intent, `/api/threads/${encodeURIComponent(intent.threadId)}/share`, {
    objectType: 'TRIP', objectId: tripId, caption: null,
  });
  if ('ok' in result) return result;
  const { response, data } = result;
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500) {
      return { ok: false, reason: 'refused', message: record(data) && typeof data.message === 'string' && data.message.length <= 500
        ? data.message : 'The server did not allow this trip to be shared.' };
    }
    return UNKNOWN;
  }
  if (!record(data) || typeof data.id !== 'string' || !UUID.test(data.id)
    || data.threadId !== intent.threadId || data.senderId !== intent.owner.ownerId
    || data.msgType !== 'portava_object' || data.subtype !== 'trip'
    || !record(data.share) || data.share.kind !== 'PORTAVA_OBJECT' || data.share.objectType !== 'TRIP'
    || data.share.objectId !== tripId || data.share.shareProjectionVersion !== '1' || data.share.caption !== null) return UNKNOWN;
  return { ok: true, messageId: data.id };
}
