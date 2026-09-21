/**
 * Trips spec §10.3 — navigation callbacks (census-trips TR169).
 *
 * §10.3 names five sensing inputs to prefer BEFORE constant GPS: geofences,
 * significant location changes, NAVIGATION CALLBACKS, semantic checkpoints and
 * explicit user actions. Four of the five have had a producer since §40–§52.
 * The fifth had none: the app never handed a traveller to navigation and never
 * learned anything when they came back, so `trip_presence.source =
 * 'navigation'` (2767's vocabulary) was a value nothing could ever write.
 *
 * WHAT A NAVIGATION CALLBACK IS HERE, AND WHAT IT IS NOT
 * =====================================================
 * It is not an SDK and it reads no position. Starting navigation to a plan is
 * an OBSERVATION the traveller made themselves — "I am going there now" — so
 * the handoff reports §10.1 `transiting` with source `navigation`, and the
 * return to the app is the CALLBACK: if the traveller comes back after the
 * plan's start, that is `at_plan`; if they come back before it, they are still
 * transiting and nothing is claimed. Every presence write carries a TTL, as
 * §10.1 requires, so an abandoned handoff expires rather than lingering as a
 * false "on the way".
 *
 * THE THINGS IT REFUSES
 * =====================
 *  - No destination (no coordinates and no place name): no link is opened and
 *    no presence is written. A handoff to nowhere would report a journey that
 *    is not happening.
 *  - A return with no pending handoff: nothing is written. The callback only
 *    speaks about a journey it started.
 *  - A return for a different trip: the pending handoff is kept, not stolen.
 *
 * The presence write goes through the kernel like every other (§19.3), so it
 * is held by `trip_kernel_enabled` on every deployment today and the caller is
 * told which, rather than the handoff quietly doing half of its job.
 */
import type { setMyPresence } from './tripPresence.ts';
import type { TripCommandResult } from '../../../services/tripCommands.ts';

/** Where the traveller is going. One of `lat`/`lng` or `locationName` is required. */
export interface NavigationTarget {
  planItemId: string;
  title?: string | null;
  lat?: number | null;
  lng?: number | null;
  locationName?: string | null;
  /** The plan's start, when known: the callback compares the return against it. */
  startsAt?: string | null;
}

export interface PendingHandoff {
  tripId: string;
  planItemId: string;
  startedAt: string;
  /** The plan's start as known when the handoff began; null when the plan had none. */
  startsAt: string | null;
  url: string;
}

export type HandoffResult =
  | { state: 'started'; url: string; presence: TripCommandResult; pending: PendingHandoff }
  | { state: 'refused'; reason: 'NO_DESTINATION' | 'LINK_UNAVAILABLE'; detail: string };

export type CallbackResult =
  | { state: 'arrived'; planItemId: string; presence: TripCommandResult }
  | { state: 'still_transiting'; planItemId: string; detail: string }
  | { state: 'nothing_pending' };

/**
 * How long a handoff's `transiting` claim is allowed to stand. A traveller who
 * never comes back should stop reading as "on the way" within the hour; the
 * kernel expires the row, nobody has to remember to clear it.
 */
export const HANDOFF_TTL_SECONDS = 60 * 60;

/* ── seams ──────────────────────────────────────────────────────────────── */

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
let _store: KeyValueStore | null = null;
/** Test seam: a store to use instead of AsyncStorage; null restores. */
export function _setStore(s: KeyValueStore | null): void { _store = s; }
async function store(): Promise<KeyValueStore> {
  if (_store) return _store;
  const mod = await import('@react-native-async-storage/async-storage');
  return (mod.default ?? mod) as unknown as KeyValueStore;
}

/**
 * The presence writer, injected the way `TripCrewPresenceCard` injects it.
 * The default is the real `setMyPresence`, loaded LAZILY: importing it at
 * module load would pull `services/tripCommands.ts` → `lib/supabase.ts` →
 * `expo-secure-store` → `react-native`, which node:test cannot load, and this
 * module would then be untestable outside jest (see `shared/auth.ts` for the
 * same wall and the same answer).
 */
export type PresenceWriter = typeof setMyPresence;
async function writePresence(...args: Parameters<PresenceWriter>): Promise<TripCommandResult> {
  const { setMyPresence: real } = await import('./tripPresence.ts');
  return real(...args);
}

type Opener = (url: string) => Promise<unknown>;
let _open: Opener | null = null;
/** Test seam: an opener to use instead of React Native's Linking; null restores. */
export function _setOpener(o: Opener | null): void { _open = o; }
async function openUrl(url: string): Promise<void> {
  if (_open) { await _open(url); return; }
  const { Linking } = await import('react-native');
  await Linking.openURL(url);
}

const KEY_VER = 'v1';
const pendingKey = (tripId: string) => `trips:navigation:pending:${KEY_VER}:${tripId}`;

/* ── the link ───────────────────────────────────────────────────────────── */

/**
 * The platform's own directions link. Coordinates when the plan has them —
 * a name can be ambiguous and a wrong destination is worse than none — else
 * the place name, which is how every other card in this app links to a map.
 */
export function navigationUrl(target: NavigationTarget): string | null {
  const { lat, lng } = target;
  if (typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)) {
    return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
  const name = (target.locationName ?? '').trim();
  if (name.length > 0) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(name)}`;
  return null;
}

/* ── the handoff ────────────────────────────────────────────────────────── */

export async function startNavigation(
  tripId: string,
  target: NavigationTarget,
  opts: { now?: () => number; idempotencyKey?: string; setPresence?: PresenceWriter } = {},
): Promise<HandoffResult> {
  const url = navigationUrl(target);
  if (!url) {
    return {
      state: 'refused', reason: 'NO_DESTINATION',
      detail: `${target.title ?? 'this plan'} has neither coordinates nor a place name; there is nowhere to navigate to and no journey to report`,
    };
  }
  const now = opts.now?.() ?? Date.now();
  const startedAt = new Date(now).toISOString();
  try {
    await openUrl(url);
  } catch (e: any) {
    return { state: 'refused', reason: 'LINK_UNAVAILABLE', detail: String(e?.message ?? 'the maps app could not be opened') };
  }
  const pending: PendingHandoff = { tripId, planItemId: target.planItemId, startedAt, startsAt: target.startsAt ?? null, url };
  const s = await store();
  await s.setItem(pendingKey(tripId), JSON.stringify(pending));
  const presence = await (opts.setPresence ?? writePresence)(tripId, {
    state: 'transiting',
    source: 'navigation',
    observedAt: startedAt,
    ttlSeconds: HANDOFF_TTL_SECONDS,
    idempotencyKey: opts.idempotencyKey ?? `nav-start:${target.planItemId}:${startedAt}`,
  });
  return { state: 'started', url, presence, pending };
}

/** The pending handoff for this trip, if the traveller left and has not been seen back. */
export async function pendingHandoff(tripId: string): Promise<PendingHandoff | null> {
  const s = await store();
  const raw = await s.getItem(pendingKey(tripId));
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as PendingHandoff;
    return p && p.tripId === tripId && typeof p.planItemId === 'string' ? p : null;
  } catch { return null; }
}

/**
 * The callback: the traveller is back in the app. Returning AFTER the plan's
 * start is the arrival this whole path exists to notice without GPS; returning
 * before it says only that they looked at their phone.
 */
export async function resolveNavigationReturn(
  tripId: string,
  opts: { now?: () => number; idempotencyKey?: string; setPresence?: PresenceWriter } = {},
): Promise<CallbackResult> {
  const pending = await pendingHandoff(tripId);
  if (!pending) return { state: 'nothing_pending' };
  const now = opts.now?.() ?? Date.now();
  const startsAt = pending.startsAt ? Date.parse(pending.startsAt) : NaN;
  if (Number.isFinite(startsAt) && now < startsAt) {
    return {
      state: 'still_transiting', planItemId: pending.planItemId,
      detail: `back in the app before ${pending.startsAt} — still on the way, and nothing is claimed about arriving`,
    };
  }
  const observedAt = new Date(now).toISOString();
  const presence = await (opts.setPresence ?? writePresence)(tripId, {
    state: 'at_plan',
    source: 'navigation',
    observedAt,
    ttlSeconds: HANDOFF_TTL_SECONDS,
    idempotencyKey: opts.idempotencyKey ?? `nav-return:${pending.planItemId}:${pending.startedAt}`,
  });
  const s = await store();
  await s.removeItem(pendingKey(tripId));
  return { state: 'arrived', planItemId: pending.planItemId, presence };
}

/** Give up on a handoff without claiming an arrival (the traveller said they are not going). */
export async function cancelNavigationHandoff(tripId: string): Promise<void> {
  const s = await store();
  await s.removeItem(pendingKey(tripId));
}
