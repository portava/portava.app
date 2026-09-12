/**
 * §18 offline on the client — the bundle stored, the queue kept, the replay
 * on reconnect. census-trips TR334 (the client's half), TR343, TR349,
 * TR421, TR432.
 *
 * WHAT THE CLIENT KEEPS AND WHAT IT MAY SAY
 * ==========================================
 * The server issues a signed, versioned bundle (§18.1); the client stores it
 * as issued — signature and all — and never re-signs or edits it, because
 * the server checks that signature on replay. What the client can judge is
 * the bundle's age and version, with the same rule the server uses
 * (`bundleStaleness`, a mirror of TripOfflineBundle.ts): expired, or behind
 * the trip's current version, is STALE, said as such, and still shown —
 * §18.1: the last certified context beats no context, as long as it is not
 * drawn as current.
 *
 * THE QUEUE IS §18.3'S, NOT A RETRY LOOP
 * ======================================
 * A queued operation carries its own idempotency key and the trip version it
 * was made against. On reconnect the server decides per operation — replay,
 * revalidate, reject — and the client applies THAT decision: a replayed or
 * duplicate operation leaves the queue as done; a rejected one leaves it
 * with the server's reason; a conflicted one (TRIP_VERSION_CONFLICT) leaves
 * it as a conflict the user must look at, never as an overwrite; one the
 * server asks to revalidate stays, marked, until the user confirms it
 * against the current trip; one refused because the kernel is off stays,
 * unmarked, for a later reconnect. Nothing is replayed twice by the client
 * on its own authority.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';

/* ── types, the server's ────────────────────────────────────────────────── */

export interface BundleContents {
  nextCommitments: { id: string; type: string; title: string | null; startsAt: string | null; requiredArrivalAt: string | null; placeName: string | null }[];
  activePlan: { id: string; title: string; status: string; dayDate: string | null; startsAt: string | null; endsAt: string | null; locationName: string | null } | null;
  plans: { id: string; title: string; status: string; dayDate: string | null; startsAt: string | null; endsAt: string | null; locationName: string | null }[];
  meetingPoints: { id: string; label: string; lat: number; lng: number; meetAt: string | null; purpose: string; myArrivalState: string | null }[];
  criticalAddresses: { kind: string; id: string; title: string; address: string; at: string | null }[];
  certifiedContext: { sourceTripVersion: number; certifiedAt: string; reading: string };
}
export interface TripOfflineBundle {
  bundleSchemaVersion: number;
  tripId: string;
  sourceTripVersion: number;
  generatedAt: string;
  expiresAt: string;
  contents: BundleContents;
  notCarried: Record<string, string>;
}
export interface SignedBundle { bundle: TripOfflineBundle; signature: string; algorithm: string; readings?: Record<string, string> }

export type BundleRead =
  | { state: 'ok'; signed: SignedBundle }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string; reason?: string };

export interface BundleStaleness { stale: boolean; because: 'expired' | 'version_behind' | null; detail: string }

/** The server's rule, mirrored (TripOfflineBundle.ts bundleStaleness). */
export function bundleStaleness(b: Pick<TripOfflineBundle, 'sourceTripVersion' | 'generatedAt' | 'expiresAt'>, now: number, currentTripVersion: number | null): BundleStaleness {
  const expires = Date.parse(b.expiresAt);
  if (!Number.isFinite(expires) || now > expires) {
    return { stale: true, because: 'expired', detail: `the offline copy expired at ${b.expiresAt}; it is the last certified context, not the current one` };
  }
  if (currentTripVersion !== null && b.sourceTripVersion < currentTripVersion) {
    return { stale: true, because: 'version_behind', detail: `the offline copy was read at trip version ${b.sourceTripVersion} and the trip is at ${currentTripVersion}; something changed while you were away` };
  }
  return { stale: false, because: null, detail: `the offline copy is current: read at version ${b.sourceTripVersion}, valid until ${b.expiresAt}` };
}

function looksLikeSigned(b: unknown): b is SignedBundle {
  const s = b as Partial<SignedBundle> | null;
  const bd = s?.bundle as Partial<TripOfflineBundle> | undefined;
  return !!s && typeof s === 'object' && typeof s.signature === 'string' && !!bd && typeof bd.tripId === 'string'
    && typeof bd.sourceTripVersion === 'number' && typeof bd.generatedAt === 'string' && typeof bd.expiresAt === 'string'
    && !!bd.contents && Array.isArray(bd.contents.plans) && Array.isArray(bd.contents.criticalAddresses);
}

export async function fetchOfflineBundle(tripId: string): Promise<BundleRead> {
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/offline-bundle`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; reason?: string; message?: string } | null;
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    const body: unknown = await res.json().catch(() => null);
    if (!looksLikeSigned(body)) return { state: 'unavailable', detail: 'unreadable response' };
    return { state: 'ok', signed: body };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/* ── storage, injectable ────────────────────────────────────────────────── */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
let _store: KeyValueStore | null = null;
/** Test seam: a store to use instead of AsyncStorage; null restores. */
export function _setStore(s: KeyValueStore | null): void { _store = s; }
export function memoryStore(): KeyValueStore {
  const m = new Map<string, string>();
  return { async getItem(k) { return m.get(k) ?? null; }, async setItem(k, v) { m.set(k, v); }, async removeItem(k) { m.delete(k); } };
}
async function store(): Promise<KeyValueStore> {
  if (_store) return _store;
  const mod = await import('@react-native-async-storage/async-storage');
  return (mod.default ?? mod) as unknown as KeyValueStore;
}
const KEY_VER = 'v1';
const bundleKey = (tripId: string) => `trips:offline:bundle:${KEY_VER}:${tripId}`;
const queueKey = (tripId: string) => `trips:offline:queue:${KEY_VER}:${tripId}`;

export interface StoredBundle { signed: SignedBundle; storedAt: string }

export async function storeBundle(tripId: string, signed: SignedBundle, now = Date.now()): Promise<StoredBundle> {
  const rec: StoredBundle = { signed, storedAt: new Date(now).toISOString() };
  await (await store()).setItem(bundleKey(tripId), JSON.stringify(rec));
  return rec;
}
export async function loadStoredBundle(tripId: string): Promise<StoredBundle | null> {
  const raw = await (await store()).getItem(bundleKey(tripId));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as StoredBundle;
    return looksLikeSigned(rec?.signed) && typeof rec.storedAt === 'string' ? rec : null;
  } catch { return null; }
}

/* ── the queue ──────────────────────────────────────────────────────────── */

export interface QueuedTripOperation {
  operationId: string;
  tripId: string;
  expectedTripVersion: number | null;
  type: string;
  payload: Record<string, unknown>;
  clientOccurredAt: string;
  idempotencyKey: string;
}
export type QueuedState = 'pending' | 'revalidate' | 'held';
export interface QueuedEntry { op: QueuedTripOperation; state: QueuedState; note: string | null }
export interface SettledEntry { op: QueuedTripOperation; outcome: 'replayed' | 'duplicate' | 'rejected' | 'conflict'; reasonCode: string | null; detail: string | null }

export const QUEUE_MAX_OPERATIONS = 50;

function uuid(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

export async function loadQueue(tripId: string): Promise<QueuedEntry[]> {
  const raw = await (await store()).getItem(queueKey(tripId));
  if (!raw) return [];
  try { const q = JSON.parse(raw); return Array.isArray(q) ? (q as QueuedEntry[]) : []; } catch { return []; }
}
async function saveQueue(tripId: string, q: QueuedEntry[]): Promise<void> {
  await (await store()).setItem(queueKey(tripId), JSON.stringify(q));
}

/**
 * Queue an operation to replay on reconnect. The version it was made against
 * comes from the stored bundle when one exists — §18.4's canonical version as
 * the client last saw it — so a later replay can be a conflict, never an
 * overwrite. Refused, not truncated, past the server's queue limit.
 */
export async function enqueueOperation(
  tripId: string,
  input: { type: string; payload?: Record<string, unknown>; idempotencyKey?: string; expectedTripVersion?: number | null; now?: number; operationId?: string },
): Promise<{ ok: true; entry: QueuedEntry } | { ok: false; reason: 'QUEUE_FULL'; detail: string }> {
  const q = await loadQueue(tripId);
  if (q.length >= QUEUE_MAX_OPERATIONS) return { ok: false, reason: 'QUEUE_FULL', detail: `the queue holds ${QUEUE_MAX_OPERATIONS} operations; reconnect before queuing more` };
  const stored = input.expectedTripVersion === undefined ? await loadStoredBundle(tripId) : null;
  const op: QueuedTripOperation = {
    operationId: input.operationId ?? uuid(), tripId, type: input.type, payload: input.payload ?? {},
    expectedTripVersion: input.expectedTripVersion !== undefined ? input.expectedTripVersion : (stored?.signed.bundle.sourceTripVersion ?? null),
    clientOccurredAt: new Date(input.now ?? Date.now()).toISOString(),
    idempotencyKey: input.idempotencyKey ?? `offline:${tripId}:${input.operationId ?? uuid()}`,
  };
  const entry: QueuedEntry = { op, state: 'pending', note: null };
  await saveQueue(tripId, [...q, entry]);
  return { ok: true, entry };
}

export interface ReplayOutcome {
  state: 'replayed';
  currentVersion: number | null;
  counts: Record<string, number>;
  settled: SettledEntry[];
  /** Still in the queue after the server's decisions, with why. */
  remaining: QueuedEntry[];
  reading: string | null;
}
export type ReplayResult = ReplayOutcome | { state: 'nothing_queued' } | { state: 'off' } | { state: 'unavailable'; detail: string; reason?: string };

interface ServerResult { operationId: string; type: string; decision: 'replay' | 'revalidate' | 'reject'; ok?: boolean; duplicate?: boolean; reasonCode?: string | null; detail?: string | null; version?: number }

/** Apply the server's per-operation decisions to the queue — pure, pinned. */
export function applyReplayResults(queue: QueuedEntry[], results: ServerResult[]): { remaining: QueuedEntry[]; settled: SettledEntry[] } {
  const byId = new Map(results.map((r) => [r.operationId, r]));
  const remaining: QueuedEntry[] = []; const settled: SettledEntry[] = [];
  for (const e of queue) {
    const r = byId.get(e.op.operationId);
    if (!r) { remaining.push(e); continue; }
    if (r.decision === 'replay' && r.ok) { settled.push({ op: e.op, outcome: r.duplicate ? 'duplicate' : 'replayed', reasonCode: null, detail: r.detail ?? null }); continue; }
    if (r.decision === 'reject') { settled.push({ op: e.op, outcome: 'rejected', reasonCode: r.reasonCode ?? 'TRIP_OFFLINE_QUEUE_REJECTED', detail: r.detail ?? null }); continue; }
    if (r.decision === 'revalidate') { remaining.push({ ...e, state: 'revalidate', note: r.detail ?? 'the server asks you to confirm this against the current trip' }); continue; }
    if (r.reasonCode === 'TRIP_VERSION_CONFLICT') { settled.push({ op: e.op, outcome: 'conflict', reasonCode: r.reasonCode, detail: r.detail ?? null }); continue; }
    if (r.reasonCode === 'TRIP_KERNEL_UNAVAILABLE') { remaining.push({ ...e, state: 'held', note: r.detail ?? 'held until the kernel is on' }); continue; }
    settled.push({ op: e.op, outcome: 'rejected', reasonCode: r.reasonCode ?? null, detail: r.detail ?? null });
  }
  return { remaining, settled };
}

/** Replay the queue through POST /operations with the stored bundle, and keep what the server said to keep. */
export async function replayQueue(tripId: string, opts: { onlyPending?: boolean } = {}): Promise<ReplayResult> {
  const queue = await loadQueue(tripId);
  const toSend = queue.filter((e) => (opts.onlyPending ?? true) ? e.state !== 'revalidate' : true);
  if (toSend.length === 0) return { state: 'nothing_queued' };
  if (!isConfigured() || !apiBase()) return { state: 'off' };
  const token = await bearerToken();
  if (!token) return { state: 'off' };
  const stored = await loadStoredBundle(tripId);
  try {
    const res = await fetch(`${apiBase()}/api/trips/${tripId}/operations`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: toSend.map((e) => e.op), ...(stored ? { bundle: { bundle: stored.signed.bundle, signature: stored.signed.signature } } : {}) }),
    });
    const body = (await res.json().catch(() => null)) as { results?: ServerResult[]; currentVersion?: number; counts?: Record<string, number>; reading?: string; error?: string; reason?: string; message?: string } | null;
    if (!res.ok) {
      if (res.status === 404 && (body?.error === 'feature_disabled' || body?.reason === 'FEATURE_DISABLED')) return { state: 'off' };
      return { state: 'unavailable', detail: body?.message ?? `HTTP ${res.status}`, reason: body?.reason };
    }
    if (!body || !Array.isArray(body.results)) return { state: 'unavailable', detail: 'unreadable response' };
    const { remaining, settled } = applyReplayResults(queue, body.results);
    await saveQueue(tripId, remaining);
    return { state: 'replayed', currentVersion: typeof body.currentVersion === 'number' ? body.currentVersion : null, counts: body.counts ?? {}, settled, remaining, reading: body.reading ?? null };
  } catch (e: any) {
    return { state: 'unavailable', detail: String(e?.message ?? 'network error') };
  }
}

/** A revalidated operation is re-queued as pending with the version the user confirmed against. */
export async function revalidateOperation(tripId: string, operationId: string, currentTripVersion: number): Promise<boolean> {
  const q = await loadQueue(tripId);
  let found = false;
  const next = q.map((e) => e.op.operationId === operationId ? (found = true, { op: { ...e.op, expectedTripVersion: currentTripVersion }, state: 'pending' as const, note: null }) : e);
  if (found) await saveQueue(tripId, next);
  return found;
}
