/**
 * Memory social and browse calls — testing mode WP-06.
 *
 * The server routes were built and unreached: participant tags (§17 ADD_PERSON
 * consent / REMOVE_PERSON), save, the share gate, the saved shelf, and the
 * owner-private projections (§18 MemoryTimelineProjection, PlaceMemoryProjection,
 * PeopleMemoryProjection, TripMemoryProjection). This module is their client.
 *
 * Every function answers `{ ok: true, ... }` or `{ ok: false, kind, message }`.
 * A read that failed is NEVER returned as an empty list: the server refuses with
 * `degraded_unavailable` precisely so "we could not build your timeline" and
 * "you have no memories" stay different sentences (DV-83), and this client keeps
 * them different.
 *
 * Kept apart from `memories.ts` so that file's cited lines do not move; the one
 * helper it shares (`newMemoryOperationId`) is imported, not copied.
 */
import { freshToken } from './apiToken.ts';
import { newMemoryOperationId, type Memory, type MemoryWriteErrorKind } from './memories.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

export type MemorySocialErrorKind = MemoryWriteErrorKind;

export type MemorySocialResult<T> =
  | ({ ok: true } & T)
  | { ok: false; kind: MemorySocialErrorKind; message: string };

const KNOWN: readonly MemorySocialErrorKind[] = [
  'conflict', 'not_found', 'forbidden', 'invalid_payload', 'unauthenticated',
  'degraded_unavailable', 'feature_disabled', 'db_error', 'network_unreachable',
];

function kindOf(status: number, body: unknown): MemorySocialErrorKind {
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && (KNOWN as readonly string[]).includes(code)) return code as MemorySocialErrorKind;
  if (status === 409) return 'conflict';
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid_payload';
  if (status === 503) return 'degraded_unavailable';
  return 'db_error';
}

const FALLBACK_MESSAGE: Record<MemorySocialErrorKind, string> = {
  conflict: 'This changed while you were looking at it. Reload and try again.',
  not_found: 'This is not available.',
  forbidden: 'You cannot do that here.',
  invalid_payload: 'That request was not valid.',
  unauthenticated: 'Please sign in again.',
  degraded_unavailable: 'This could not be loaded right now. Please try again.',
  feature_disabled: 'This is not available yet.',
  db_error: 'Something went wrong. Please try again.',
  network_unreachable: 'You appear to be offline. Check your connection and try again.',
};

function fail(kind: MemorySocialErrorKind, message?: unknown): { ok: false; kind: MemorySocialErrorKind; message: string } {
  return { ok: false, kind, message: typeof message === 'string' && message ? message : FALLBACK_MESSAGE[kind] };
}

/**
 * One request. `pick` turns a 200 body into the success payload, or null when
 * the body is not the shape this route promises — a malformed 200 is an error,
 * not an empty result.
 */
async function call<T extends object>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  pick: (body: any) => T | null,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<MemorySocialResult<T>> {
  try {
    const token = await freshToken();
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts?.headers ?? {}),
    };
    const res = await fetch(`${apiBase()}${path}`, {
      method,
      headers,
      ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) return fail(kindOf(res.status, json), (json as { message?: unknown } | null)?.message);
    const picked = json === null ? null : pick(json);
    if (picked === null) return fail('db_error', 'The server answered in a shape this app does not understand.');
    return { ok: true, ...picked };
  } catch (e) {
    const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
    const offline = m.includes('network request failed') || m.includes('failed to fetch')
      || m.includes('networkerror') || m.includes('load failed');
    return fail(offline ? 'network_unreachable' : 'db_error');
  }
}

const enc = encodeURIComponent;

// ── Save (HM-F13) ─────────────────────────────────────────────────────────────

export function saveMemory(memoryId: string): Promise<MemorySocialResult<{ savedByMe: boolean }>> {
  return call('POST', `/api/memories/${enc(memoryId)}/save`, (b) => (typeof b.savedByMe === 'boolean' ? { savedByMe: b.savedByMe } : null));
}

export function unsaveMemory(memoryId: string): Promise<MemorySocialResult<{ savedByMe: boolean }>> {
  return call('DELETE', `/api/memories/${enc(memoryId)}/save`, (b) => (typeof b.savedByMe === 'boolean' ? { savedByMe: b.savedByMe } : null));
}

/** The caller's saved shelf. Every row was re-judged readable by the server. */
export function getSavedMemories(): Promise<MemorySocialResult<{ memories: Memory[]; truncated: boolean }>> {
  return call('GET', '/api/me/saved-memories', (b) => (Array.isArray(b.memories) ? { memories: b.memories, truncated: b.truncated === true } : null));
}

// ── Share gate (HM-F13) ───────────────────────────────────────────────────────

export interface MemoryShareReference {
  objectType: 'MEMORY';
  objectId: string;
  deepLink: string;
  /** True when the Memory is public, so a link outside Portava can open it. */
  public: boolean;
}

/**
 * Ask the server whether this caller may share this Memory, and get the
 * Telegraph §5 object reference to share. The share itself goes into a thread
 * as a REFERENCE (resolved per reader at read time), never as a snapshot.
 */
export function prepareMemoryShare(memoryId: string): Promise<MemorySocialResult<{ share: MemoryShareReference }>> {
  return call('POST', `/api/memories/${enc(memoryId)}/share`, (b) => {
    const s = b?.share;
    if (!s || s.objectType !== 'MEMORY' || typeof s.objectId !== 'string' || typeof s.deepLink !== 'string') return null;
    return { share: { objectType: 'MEMORY', objectId: s.objectId, deepLink: s.deepLink, public: s.public === true } };
  });
}

// ── Participants (HM-F12) ─────────────────────────────────────────────────────

export type MemoryTagStatus = 'pending' | 'approved' | 'removed' | string;

/** One participant as the server discloses them to THIS viewer (§10 rungs). */
export interface MemoryParticipant {
  userId: string;
  status: MemoryTagStatus | null;
  rung: string;
  name: string | null;
  handle: string | null;
}

export function getMemoryTags(memoryId: string): Promise<MemorySocialResult<{ tags: MemoryParticipant[]; anonymousParticipants: number }>> {
  return call('GET', `/api/memories/${enc(memoryId)}/tags`, (b) => (Array.isArray(b.tags)
    ? { tags: b.tags as MemoryParticipant[], anonymousParticipants: typeof b.anonymousParticipants === 'number' ? b.anonymousParticipants : 0 }
    : null));
}

/**
 * §17 ADD_PERSON as consent ('approve', the tagged person only) or
 * REMOVE_PERSON ('remove', the tagged person or the Memory's owner). The server
 * and the kernel decide who may; this only carries the decision.
 */
export function respondToMemoryTag(
  memoryId: string,
  userId: string,
  action: 'approve' | 'remove',
  opts?: { operationId?: string | null },
): Promise<MemorySocialResult<{ status: MemoryTagStatus }>> {
  const operationId = opts?.operationId || newMemoryOperationId('tag');
  return call('PATCH', `/api/memories/${enc(memoryId)}/tags/${enc(userId)}`,
    (b) => (typeof b.status === 'string' ? { status: b.status } : null),
    { body: { action }, headers: { 'Idempotency-Key': operationId } });
}

// ── Owner-private browse projections (HM-F11) ─────────────────────────────────

/** A §18 MemoryTimelineProjection row (the server's field whitelist). */
export interface MemoryTimelineRow {
  memory_id: string;
  occurred_at: string;
  ended_at?: string | null;
  title: string | null;
  caption?: string | null;
  place_id?: string | null;
  location_city: string | null;
  location_country: string | null;
  trip_id?: string | null;
  media_count?: number | null;
  people?: string[] | null;
  visibility?: string | null;
  state?: string | null;
  significance_tier?: string | null;
}

/** PlaceMemoryProjection: the owner's own visits to one place. */
export interface MemoryPlaceHistoryRow {
  memory_id: string;
  occurred_at: string;
  title: string | null;
  location_city: string | null;
  location_country: string | null;
  visit_index: number | null;
}

/** PeopleMemoryProjection: the owner's Memories one person APPROVED a tag on. */
export interface MemoryPeopleHistoryRow {
  memory_id: string;
  occurred_at: string;
  title: string | null;
  location_city: string | null;
  location_country: string | null;
}

/** TripMemoryProjection: a trip's recap as this crew member may see it. */
export interface TripRecapRow {
  memory_id: string;
  occurred_at: string;
  title: string | null;
  place_id?: string | null;
  location_city: string | null;
  location_country: string | null;
  media_count: number | null;
  people: string[] | null;
}

function rowsOf<R>(container: any): { rows: R[]; truncated: boolean } | null {
  if (!container || !Array.isArray(container.rows)) return null;
  return { rows: container.rows as R[], truncated: container.truncated === true };
}

export function getMemoryTimeline(): Promise<MemorySocialResult<{ rows: MemoryTimelineRow[]; truncated: boolean }>> {
  return call('GET', '/api/memories/timeline', (b) => rowsOf<MemoryTimelineRow>(b.timeline));
}

export function getMemoryPlaceHistory(placeId: string): Promise<MemorySocialResult<{ rows: MemoryPlaceHistoryRow[]; truncated: boolean }>> {
  return call('GET', `/api/memories/places/${enc(placeId)}`, (b) => rowsOf<MemoryPlaceHistoryRow>(b.history));
}

export function getMemoryPeopleHistory(personId: string): Promise<MemorySocialResult<{ rows: MemoryPeopleHistoryRow[]; truncated: boolean }>> {
  return call('GET', `/api/memories/people/${enc(personId)}`, (b) => rowsOf<MemoryPeopleHistoryRow>(b.sharedHistory));
}

// ── Trip recap (HM-F15) ───────────────────────────────────────────────────────

export function getTripMemoryRecap(tripId: string): Promise<MemorySocialResult<{ rows: TripRecapRow[] }>> {
  return call('GET', `/api/trips/${enc(tripId)}/memories/recap`,
    (b) => (b?.recap && Array.isArray(b.recap.rows) ? { rows: b.recap.rows as TripRecapRow[] } : null));
}

/** `GET /memories/:id` also carries the participants disclosed to this viewer. */
export type MemoryWithParticipants = Memory & { tags?: MemoryParticipant[]; anonymousParticipants?: number };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id `GET /memories/places/:placeId` can answer for: the canonical location
 * when there is one, else a place id that is a uuid. Anything else has no
 * place history to ask for.
 */
export function memoryPlaceHistoryId(m: Pick<Memory, 'canonicalLocationId' | 'placeId'>): string | null {
  if (m.canonicalLocationId && UUID_RE.test(m.canonicalLocationId)) return m.canonicalLocationId;
  if (m.placeId && UUID_RE.test(m.placeId)) return m.placeId;
  return null;
}
