/**
 * Memories service — wraps /api/memories endpoints.
 */
import { freshToken as freshApiToken } from './apiToken.ts';

function apiBase(): string {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await freshApiToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

/* ============================================================================
 * §19 — CLIENT OPERATION IDS
 *
 * Highlights/Memories Development Architecture Spec v1 §19 ("Offline and
 * Multi-Device Behavior"): a sync command carries a CLIENT operation id and the
 * server is idempotent on it. Census H175.
 *
 * The server half exists. `lib/memoryCommandBus.ts:584#readMemoryCommandEnvelope`
 * reads the `idempotency-key` header on every Memory write route, and
 * `routes/memories.ts:344#requireIdempotencyKey` refuses a malformed one with
 * 400. What it does when the header is ABSENT is the whole reason this block
 * exists — it mints `randomUUID()`, and its own comment says why: "an unaware
 * client is not given a dedup window keyed on something it did not choose."
 * Until now this client was that unaware client. Every Memory write it sent was
 * keyed on a value the server invented one microsecond before using it, so no
 * retry could ever match a previous attempt.
 *
 * WHAT IS HONESTLY DELIVERED HERE, AND WHAT IS NOT. The key now crosses the
 * wire and is stable across a blind retry (below). The server-side DEDUP it
 * would trigger lives in `memory_command_receipts` (migration 2710) behind
 * `memory_kernel_enabled`, which reads FALSE in the committed production
 * snapshot — so on the deployed API a replayed key currently produces a second
 * write and only a log line records the key. That is a deployment fact, not a
 * client gap, and it is why nothing here claims a replay is safe.
 *
 * WHY THE DEFAULT KEY IS NOT A FRESH UUID PER CALL. A key minted per call is
 * exactly as useless as the server minting one: the second attempt at the same
 * user intent carries a different key and is therefore a different command. The
 * screens that call this module retry by calling the same function again with
 * the same arguments — they hold no operation id — so a default that survives
 * that retry has to be derived from the call itself. Hence: same verb, same
 * subject, same payload, inside a short window, is the same operation. Outside
 * the window it is a new one, because a person who makes the identical edit two
 * minutes later meant it.
 *
 * A caller that knows better passes `operationId` and this guessing stops.
 * ========================================================================== */

/** The header the API server reads. `lib/memoryCommandBus.ts:578`. */
const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/**
 * How long a blind retry is still "the same operation".
 *
 * Long enough to cover a person tapping Save again after a spinner and a failed
 * request; short enough that a deliberate second identical edit is its own
 * command. Not a spec number — §19 names no window — so it is stated as a
 * product choice rather than smuggled in as one.
 */
const OPERATION_ID_REUSE_MS = 90_000;

/** Bounded so a long session cannot grow this map without limit. */
const OPERATION_ID_MAX_ENTRIES = 200;

const operationIds = new Map<string, { id: string; at: number }>();

/**
 * A fresh §19 operation id.
 *
 * The shape matches what the server accepts (1–200 characters, any content); it
 * prefers a real UUID where the runtime has one and composes from time plus
 * entropy where it does not, so no crypto polyfill is required on native. Same
 * approach as `services/intelCapture.ts:57#makeIdempotencyKey`, which solved
 * this for the Intel capture route first.
 */
export function newMemoryOperationId(prefix = 'mem'): string {
  const g: any = globalThis as any;
  const uuid: string | null =
    typeof g?.crypto?.randomUUID === 'function' ? g.crypto.randomUUID() : null;
  const body = uuid ?? `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e12).toString(36)}`;
  return `${prefix}-${body}`.slice(0, 200);
}

/** Order-independent, so `{a,b}` and `{b,a}` are one operation, not two. */
function fingerprint(payload: unknown): string {
  const stable = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(stable);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = stable(v[k]);
    return out;
  };
  const json = JSON.stringify(stable(payload)) ?? 'undefined';
  // FNV-1a, 32-bit. Not a security hash and never used as one — a collision
  // costs a shared dedup window between two of ONE user's own writes in the
  // same 90 seconds, and the key never authorizes anything.
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * The operation id for one write: the caller's, or the one a blind retry of
 * this exact call would also get.
 */
function operationIdFor(
  explicit: string | null | undefined,
  verb: string,
  subjectId: string,
  payload: unknown,
  now = Date.now(),
): string {
  if (explicit) return explicit;
  const key = `${verb}:${subjectId}:${fingerprint(payload)}`;
  const seen = operationIds.get(key);
  if (seen && now - seen.at < OPERATION_ID_REUSE_MS) {
    // Deliberately NOT refreshed. The window runs from the FIRST attempt, so a
    // person retrying every 80 seconds cannot hold one operation id open
    // indefinitely.
    return seen.id;
  }
  const id = newMemoryOperationId();
  if (operationIds.size >= OPERATION_ID_MAX_ENTRIES) {
    // Oldest-first eviction. Map iteration order is insertion order and an
    // entry is never re-inserted while it is live, so the first key is the
    // least recently minted.
    const oldest = operationIds.keys().next();
    if (!oldest.done) operationIds.delete(oldest.value);
  }
  operationIds.set(key, { id, at: now });
  return id;
}

/** Test seam. Nothing under `app/` calls this. */
export function _resetMemoryOperationIds(): void {
  operationIds.clear();
}

/* ============================================================================
 * §19 — THE REFUSALS A MEMORY WRITE CAN RECEIVE
 *
 * Census H178: "concurrent edits resolve at command/field level, not blind row
 * last-write-wins". The server built that half — `routes/memories.ts:1795`
 * answers `conflict` (409) when a PATCH is judged against a lifecycle state
 * that changed underneath it, rather than letting the losing command win
 * silently. Every function in this module used to flatten that 409 into
 * `{ok: false, message}`, identical in shape to a dropped connection, so no
 * caller could tell "somebody else changed this" from "the network died" and
 * neither could offer the right recovery.
 *
 * `kind` is ADDITIVE. Every existing caller destructures `ok` and `message`,
 * keeps compiling and keeps behaving identically; `message` still carries the
 * server's own sentence, which for `conflict` is already the one a person needs
 * ("This Memory changed while you were editing it. Reload it and try again.")
 * and reaches `app/memory/edit.tsx:135` unchanged.
 * ========================================================================== */

export type MemoryWriteErrorKind =
  /** 409. §19's losing command: the row changed while this edit was judged. */
  | 'conflict'
  | 'not_found'
  | 'forbidden'
  | 'invalid_payload'
  | 'unauthenticated'
  /** 503, retryable — the write could not be attempted, not that it failed. */
  | 'degraded_unavailable'
  /** This deployment cannot store what was asked for. Never retry. */
  | 'feature_disabled'
  | 'db_error'
  /** The request never reached a server. */
  | 'network_unreachable';

const KNOWN_WRITE_ERROR_KINDS: readonly MemoryWriteErrorKind[] = [
  'conflict', 'not_found', 'forbidden', 'invalid_payload', 'unauthenticated',
  'degraded_unavailable', 'feature_disabled', 'db_error', 'network_unreachable',
];

/**
 * The server's `{error, message}` envelope (`lib/http.ts:179`), mapped once.
 *
 * An unrecognised code becomes `db_error` rather than being passed through as
 * itself: a client union that silently grows whatever the server sends is a
 * second, undeclared vocabulary. `mapApiError` in `services/highlights.ts` made
 * the same choice for the same reason.
 */
function writeErrorKind(status: number, body: any): MemoryWriteErrorKind {
  const code = body?.error;
  if (typeof code === 'string' && (KNOWN_WRITE_ERROR_KINDS as readonly string[]).includes(code)) {
    return code as MemoryWriteErrorKind;
  }
  if (status === 409) return 'conflict';
  if (status === 404) return 'not_found';
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthenticated';
  if (status === 400) return 'invalid_payload';
  if (status === 503) return 'degraded_unavailable';
  return 'db_error';
}

function isNetworkError(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes('failed to fetch') ||
    m.includes('network request failed') ||
    m.includes('networkerror') ||
    m.includes('load failed')
  );
}

function thrownKind(e: unknown): MemoryWriteErrorKind {
  return isNetworkError(e) ? 'network_unreachable' : 'db_error';
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
 * Upload a local media URI through the canonical server-side processing
 * pipeline (POST /api/media/upload) and return the storage URL.
 *
 * Routing through the API server ensures EXIF/GPS metadata is stripped and
 * images are re-encoded before storage, matching the privacy guarantees of
 * the main post-media path. A direct client-to-bucket write bypasses this
 * processing and leaves raw originals (potentially carrying capture
 * coordinates) permanently retrievable at a guessable public URL.
 *
 * Returns null on failure.
 */
export async function uploadMemoryMedia(
  localUri: string,
  mediaType: string,
): Promise<string | null> {
  try {
    const token = await freshApiToken();
    if (!token) return null;

    const response = await fetch(localUri);
    const blob = await response.blob();

    const uploadRes = await fetch(`${apiBase()}/api/media/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': mediaType,
        Authorization: `Bearer ${token}`,
      },
      body: blob,
    });

    if (!uploadRes.ok) return null;
    const json = await uploadRes.json();
    return typeof json?.url === 'string' ? json.url : null;
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
  /**
   * §19. The caller's own operation id, reused verbatim across retries of the
   * same intent. Omit it and one is derived — see the §19 block at the top of
   * this file for exactly what "derived" means and what it does not promise.
   */
  operationId?: string | null;
}

/**
 * `operationId` is OPTIONAL ON THE SUCCESS BRANCH AND REQUIRED ON THE FAILURE
 * BRANCH, and the asymmetry is deliberate rather than an oversight.
 *
 * Every function below sets it on both branches, always. It is declared
 * optional on success because `app/memory/[id].tsx:178` narrows the settled
 * results of `addMemoryItem` with a HAND-WRITTEN type predicate spelled
 * `PromiseFulfilledResult<{ ok: true; item: MemoryItem }>`, and a predicate's
 * type must be assignable to its parameter's. Making the field required there
 * would have made that file stop compiling — and this lane does not own it, so
 * the choice was "break a file I may not fix" or "declare the field the way a
 * caller can already satisfy". Retry logic keys on the FAILURE branch, where it
 * is required and narrowing nothing.
 */
export type MemoryWriteResult<T> =
  | ({ ok: true; operationId?: string } & T)
  | { ok: false; message: string; kind: MemoryWriteErrorKind; operationId: string };

export async function createMemory(
  input: CreateMemoryInput,
): Promise<MemoryWriteResult<{ memory: Memory }>> {
  const body = {
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
  };
  // §17 CREATE_MEMORY. The subject is the empty string because the Memory does
  // not exist yet — the payload IS the identity of this intent.
  const operationId = operationIdFor(input.operationId, 'CREATE_MEMORY', '', body);
  try {
    const headers = {
      ...(await authHeader()),
      'Content-Type': 'application/json',
      [IDEMPOTENCY_KEY_HEADER]: operationId,
    };
    const res = await fetch(`${apiBase()}/api/memories`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return {
        ok: false,
        message: j.message ?? `HTTP ${res.status}`,
        kind: writeErrorKind(res.status, j),
        operationId,
      };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory, operationId };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error', kind: thrownKind(e), operationId };
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
  opts?: { operationId?: string | null },
): Promise<MemoryWriteResult<{ item: MemoryItem }>> {
  const body = {
    mediaUrl,
    mediaType,
    caption: caption ?? null,
    position: position ?? 0,
  };
  // §17 ADD_MEDIA. §19 names media enqueue as the sync command that most needs
  // an operation id: a retried upload registration is the classic duplicate.
  const operationId = operationIdFor(opts?.operationId, 'ADD_MEDIA', memoryId, body);
  try {
    const headers = {
      ...(await authHeader()),
      'Content-Type': 'application/json',
      [IDEMPOTENCY_KEY_HEADER]: operationId,
    };
    const res = await fetch(`${apiBase()}/api/memories/${memoryId}/items`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return {
        ok: false,
        message: j.message ?? `HTTP ${res.status}`,
        kind: writeErrorKind(res.status, j),
        operationId,
      };
    }
    const json = await res.json();
    return { ok: true, item: json.item, operationId };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error', kind: thrownKind(e), operationId };
  }
}

export async function addMemoryItem(
  memoryId: string,
  localUri: string,
  mediaType: string,
  caption?: string | null,
  position?: number,
  opts?: { operationId?: string | null },
): Promise<MemoryWriteResult<{ item: MemoryItem }>> {
  const mediaUrl = await uploadMemoryMedia(localUri, mediaType);
  if (!mediaUrl) {
    // The upload never produced a URL, so no command was ever formed. The
    // operation id is minted anyway so the failure has the same shape as every
    // other refusal and a caller can retry under one id.
    return {
      ok: false,
      message: 'Upload failed. Check your connection and try again.',
      kind: 'network_unreachable',
      operationId: operationIdFor(opts?.operationId, 'ADD_MEDIA', memoryId, { localUri, mediaType }),
    };
  }
  return addMemoryItemFromUrl(memoryId, mediaUrl, mediaType, caption, position, opts);
}

// ── Delete item ───────────────────────────────────────────────────────────────

export async function deleteMemoryItem(
  memoryId: string,
  itemId: string,
  opts?: { operationId?: string | null },
): Promise<{ ok: boolean; message?: string; kind?: MemoryWriteErrorKind; operationId: string }> {
  // §17 REMOVE_MEDIA. The item id is the subject: removing item A and item B
  // from the same Memory are two operations, not one repeated.
  const operationId = operationIdFor(opts?.operationId, 'REMOVE_MEDIA', `${memoryId}/${itemId}`, null);
  try {
    const headers = { ...(await authHeader()), [IDEMPOTENCY_KEY_HEADER]: operationId };
    const res = await fetch(`${apiBase()}/api/memories/${memoryId}/items/${itemId}`, {
      method: 'DELETE',
      headers,
    });
    if (res.status === 204) return { ok: true, operationId };
    const j = await res.json().catch(() => ({}));
    return {
      ok: false,
      message: j.message ?? `HTTP ${res.status}`,
      kind: writeErrorKind(res.status, j),
      operationId,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error', kind: thrownKind(e), operationId };
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
  /** §19. See `CreateMemoryInput.operationId`. */
  operationId?: string | null;
}

export async function updateMemory(
  id: string,
  input: UpdateMemoryInput,
): Promise<MemoryWriteResult<{ memory: Memory }>> {
  // The operation id is NOT part of the patch. Splitting it out here also keeps
  // it out of the fingerprint, so passing an explicit id and omitting one
  // describe the same edit.
  const { operationId: explicitId, ...patch } = input;
  const operationId = operationIdFor(explicitId, 'PATCH_MEMORY', id, patch);
  try {
    const headers = {
      ...(await authHeader()),
      'Content-Type': 'application/json',
      [IDEMPOTENCY_KEY_HEADER]: operationId,
    };
    const res = await fetch(`${apiBase()}/api/memories/${id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return {
        ok: false,
        message: j.message ?? `HTTP ${res.status}`,
        kind: writeErrorKind(res.status, j),
        operationId,
      };
    }
    const json = await res.json();
    return { ok: true, memory: json.memory, operationId };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? 'Network error', kind: thrownKind(e), operationId };
  }
}

// ── Delete memory ─────────────────────────────────────────────────────────────

export async function deleteMemory(
  id: string,
  opts?: { operationId?: string | null },
): Promise<{ ok: boolean; kind?: MemoryWriteErrorKind; operationId: string }> {
  const operationId = operationIdFor(opts?.operationId, 'DELETE_MEMORY', id, null);
  try {
    const headers = { ...(await authHeader()), [IDEMPOTENCY_KEY_HEADER]: operationId };
    const res = await fetch(`${apiBase()}/api/memories/${id}`, {
      method: 'DELETE',
      headers,
    });
    if (res.status === 204) return { ok: true, operationId };
    const j = await res.json().catch(() => ({}));
    return { ok: false, kind: writeErrorKind(res.status, j), operationId };
  } catch (e) {
    return { ok: false, kind: thrownKind(e), operationId };
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
