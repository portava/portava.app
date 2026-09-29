/**
 * TRIP-F25 — a trip's saved places, synced to the trip (WP-10).
 *
 * Before this file the trip wishlist lived only on the device
 * (services/discoveryBookmarks.ts, AsyncStorage, `listId` = trip id) and in
 * the viewer's own /api/wishlist; GET/POST/DELETE /api/trips/:id/saved-places
 * had no caller, so a crew never saw each other's saves. The trip's list is
 * `trip_saved_places`: one row per (trip, member, place), a SET (census-trips
 * TR350, TR347: SAVE_IDEA / UNSAVE_IDEA are §18.3 set operations, not kernel
 * commands — the route is the architecture's write path for this table).
 *
 * THE MERGE RULE (decision WP10-D1, census-trips §77)
 * ==================================================
 * A device-only save is PENDING until the server acknowledges it — a 201
 * (created) or a 409 (this member already saved this place) — or until the
 * server list already carries it under THIS member. Then:
 *
 *   1. Pending saves are pushed on every sync, union only. The first sync of
 *      a trip therefore pushes every save the device holds for it, and a push
 *      that fails leaves the save pending, shown and counted, for the next
 *      sync. Nothing on the device is deleted by a first sync. No save is lost.
 *   2. Once acknowledged, the server is authoritative for that place: if it is
 *      later absent from the member's rows (removed on another device, or by
 *      the owner), the device copy is dropped rather than pushed back.
 *   3. Only the member's OWN rows acknowledge. A crewmate saving the same
 *      place does not, so their later removal cannot take this member's save
 *      with it.
 *   4. An unreadable server list decides nothing: no push, no drop.
 *
 * The acknowledged set is kept per account per trip on the device
 * (`@travel_buddy/trip_saved_places_acked_v1:<account>:<trip>`). Losing it (a
 * reinstall) only returns saves to rule 1 — pushed again, answered 409,
 * acknowledged — so it can cost a request, never a save.
 */
import { isConfigured, apiBase, bearerToken } from '../shared/auth.ts';
import { readTripJson, sendTripWrite, type ApiWrite } from '../shared/tripApi.ts';
import type { BookmarkedPlace } from '../../../services/discoveryBookmarks.ts';

export interface ServerSavedPlace {
  id: string; place_id: string | null; place_name: string; place_type: string | null;
  lat: number | null; lng: number | null; notes: string | null; user_id: string; saved_at: string;
}

export interface TripSavedPlace extends BookmarkedPlace {
  /** The trip_saved_places row id; null while the save is pending on this device. */
  entryId: string | null;
  /** Who saved it (user id); null when unknown. */
  savedBy: string | null;
  /** True when it is this member's save. */
  mine: boolean;
  /** True when it exists only on this device so far. */
  pending: boolean;
}

export type TripSavesSync =
  | { state: 'ok'; places: TripSavedPlace[]; pending: number }
  | { state: 'off' }
  | { state: 'unavailable'; detail: string };

interface Deps {
  accountId(): Promise<string | null>;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  /** Drop the device copy of a save for this trip. */
  removeLocal(placeId: string, tripId: string): Promise<void>;
  /** Make sure the device holds a copy (a pending save, or a rolled-back unsave). Adds only; never toggles. */
  ensureLocal(place: BookmarkedPlace, tripId: string): Promise<void>;
}
let _testDeps: Deps | null = null;
/** Test seam; null restores the real account, storage and bookmark store. */
export function _setTestDeps(d: Deps | null): void { _testDeps = d; }

async function deps(): Promise<Deps> {
  if (_testDeps) return _testDeps;
  const [{ getCurrentAccountId }, s, bm] = await Promise.all([
    import('../../../services/accountId.ts'),
    import('@react-native-async-storage/async-storage'),
    import('../../../services/discoveryBookmarks.ts'),
  ]);
  const storage = s.default;
  return {
    accountId: getCurrentAccountId,
    getItem: (k) => storage.getItem(k),
    setItem: (k, v) => storage.setItem(k, v),
    removeLocal: (id, tripId) => bm.removeSavedFromList(id, tripId),
    ensureLocal: (p, tripId) => bm.ensureSavedInList(p, tripId),
  };
}

const ackKey = (account: string, tripId: string) => `@travel_buddy/trip_saved_places_acked_v1:${account}:${tripId}`;

async function readAcked(d: Deps, key: string): Promise<Set<string>> {
  try {
    const raw = await d.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x: unknown): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
async function writeAcked(d: Deps, key: string, acked: Set<string>): Promise<void> {
  try { await d.setItem(key, JSON.stringify([...acked])); } catch { /* next sync re-derives it from 409s */ }
}

/** Signed in, configured, and whose account? null = off. */
async function context(): Promise<{ d: Deps; account: string } | null> {
  if (!isConfigured() || !apiBase()) return null;
  if (!(await bearerToken())) return null;
  const d = await deps();
  const account = await d.accountId();
  return account ? { d, account } : null;
}

function readServer(tripId: string) {
  return readTripJson<{ savedPlaces: ServerSavedPlace[] }>(
    `/api/trips/${tripId}/saved-places`,
    (b) => Array.isArray(b?.savedPlaces) && b.savedPlaces.every((r: any) => r && typeof r.id === 'string' && typeof r.user_id === 'string'),
  );
}

function pushBody(p: BookmarkedPlace) {
  return {
    placeId: p.id,
    placeName: p.name,
    ...(p.category ? { placeType: p.category } : {}),
    lat: typeof p.lat === 'number' ? p.lat : null,
    lng: typeof p.lng === 'number' ? p.lng : null,
  };
}

/** 201 or 409 acknowledges; anything else leaves the save pending. */
async function push(tripId: string, p: BookmarkedPlace): Promise<ServerSavedPlace | 'acked' | null> {
  const w = await sendTripWrite<ServerSavedPlace>('POST', `/api/trips/${tripId}/saved-places`, pushBody(p));
  if (w.state === 'done') return w.data && typeof w.data.id === 'string' ? w.data : 'acked';
  if (w.state === 'refused' && w.status === 409) return 'acked';
  return null;
}

function fromServer(r: ServerSavedPlace, tripId: string, account: string): TripSavedPlace {
  return {
    id: r.place_id ?? `entry:${r.id}`,
    name: r.place_name,
    category: r.place_type ?? 'other',
    type: null,
    address: null,
    savedAt: Date.parse(r.saved_at) || 0,
    lat: r.lat,
    lng: r.lng,
    listId: tripId,
    entryId: r.id,
    savedBy: r.user_id,
    mine: r.user_id === account,
    pending: false,
  };
}

/**
 * Read the trip's list, apply the merge rule to this device's saves for the
 * trip, and return what to show: the crew's saves (one per place, the
 * member's own row preferred) plus anything still pending here.
 */
export async function syncTripSavedPlaces(tripId: string, localForTrip: readonly BookmarkedPlace[]): Promise<TripSavesSync> {
  const ctx = await context();
  if (!ctx) return { state: 'off' };
  const { d, account } = ctx;
  const read = await readServer(tripId);
  if (read.state === 'off') return { state: 'off' };
  if (read.state === 'unavailable') return { state: 'unavailable', detail: read.detail };
  const rows = [...read.data.savedPlaces];

  const key = ackKey(account, tripId);
  const acked = await readAcked(d, key);
  const before = JSON.stringify([...acked].sort());
  const mine = new Set(rows.filter((r) => r.user_id === account && r.place_id).map((r) => r.place_id as string));
  const pending: BookmarkedPlace[] = [];

  for (const p of localForTrip) {
    if ((p.listId ?? tripId) !== tripId) continue;
    if (mine.has(p.id)) { acked.add(p.id); continue; }              // rule 3: only my rows acknowledge
    if (acked.has(p.id)) {                                          // rule 2: removed on the server
      acked.delete(p.id);
      try { await d.removeLocal(p.id, tripId); } catch { /* dropped next time */ }
      continue;
    }
    const pushed = await push(tripId, p);                           // rule 1: union
    if (pushed === null) {
      // Kept on the device until acknowledged, whatever else rewrote the device list meanwhile.
      pending.push(p);
      try { await d.ensureLocal(p, tripId); } catch { /* still in `pending` for this read */ }
      continue;
    }
    acked.add(p.id);
    if (pushed !== 'acked') rows.push(pushed);
  }
  // Every row of mine is acknowledged, wherever it was saved from.
  for (const id of mine) acked.add(id);
  if (JSON.stringify([...acked].sort()) !== before) await writeAcked(d, key, acked);

  const byPlace = new Map<string, TripSavedPlace>();
  for (const r of rows) {
    const t = fromServer(r, tripId, account);
    const prev = byPlace.get(t.id);
    if (!prev || (!prev.mine && t.mine)) byPlace.set(t.id, t);
  }
  for (const p of pending) {
    if (!byPlace.has(p.id)) byPlace.set(p.id, { ...p, listId: tripId, entryId: null, savedBy: account, mine: true, pending: true });
  }
  const places = [...byPlace.values()].sort((a, b) => b.savedAt - a.savedAt);
  return { state: 'ok', places, pending: pending.length };
}

/** Remove a save from the trip: DELETE its row (own, or any as the owner); a pending one exists only here. */
export async function removeTripSavedPlace(tripId: string, place: TripSavedPlace): Promise<ApiWrite<null>> {
  if (!place.entryId) return { state: 'done', data: null, status: 204 };
  const w = await sendTripWrite<null>('DELETE', `/api/trips/${tripId}/saved-places/${place.entryId}`);
  if (w.state === 'done') {
    const ctx = await context();
    if (ctx) {
      const key = ackKey(ctx.account, tripId);
      const acked = await readAcked(ctx.d, key);
      if (acked.delete(place.id)) await writeAcked(ctx.d, key, acked);
    }
  }
  return w;
}

export type ToggleSync = { state: 'synced' } | { state: 'pending' } | { state: 'off' } | { state: 'failed'; detail: string };

/**
 * The picker's toggle, after it changed the device copy: carry the change to
 * the trip. A save that cannot be pushed stays pending (rule 1). An unsave
 * the server did not take is rolled back on the device, so the picker never
 * shows removed what the crew still sees.
 */
export async function applyTripSaveToggle(tripId: string, place: BookmarkedPlace, added: boolean): Promise<ToggleSync> {
  const ctx = await context();
  if (!ctx) return { state: 'off' };
  const key = ackKey(ctx.account, tripId);
  if (added) {
    const pushed = await push(tripId, place);
    if (pushed === null) return { state: 'pending' };
    const acked = await readAcked(ctx.d, key);
    acked.add(place.id);
    await writeAcked(ctx.d, key, acked);
    return { state: 'synced' };
  }
  const rollback = async (detail: string): Promise<ToggleSync> => {
    try { await ctx.d.ensureLocal(place, tripId); } catch { /* the next sync restores it from the server */ }
    return { state: 'failed', detail };
  };
  const read = await readServer(tripId);
  if (read.state !== 'ok') return rollback(read.state === 'unavailable' ? read.detail : 'not signed in');
  const entry = read.data.savedPlaces.find((r) => r.user_id === ctx.account && r.place_id === place.id);
  if (entry) {
    const w = await sendTripWrite<null>('DELETE', `/api/trips/${tripId}/saved-places/${entry.id}`);
    if (w.state !== 'done') return rollback(w.detail);
  }
  const acked = await readAcked(ctx.d, key);
  if (acked.delete(place.id)) await writeAcked(ctx.d, key, acked);
  return { state: 'synced' };
}
