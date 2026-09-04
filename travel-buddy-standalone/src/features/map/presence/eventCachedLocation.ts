/**
 * eventCachedLocation — §12's rung 2, "Event-local cached location".
 *
 * WHAT §12 ASKS FOR
 * =================
 * §12's preferred signal sequence is a fallback ladder:
 *
 *     1. Normal network location
 *     2. Event-local cached location   ← this module
 *     3. Local device proximity
 *     4. Peer relay / checkpoint
 *     5. Last-known location
 *     6. Manual checkpoint
 *
 * and §28 ("Offline and Degraded Mode") asks the map to "Cache event map and
 * meeting points" and "Cache Crew last-known state". Rung 2 is where those two
 * meet: a member checks into an event, their last-known fix is CACHED at that
 * moment, and when a live network fix is later unavailable (degraded / offline)
 * the group still sees roughly where they were — clearly as a cached, recent,
 * approximate reading, never as a live dot.
 *
 * THIS IS A PRODUCER, NOT A NEW PIPELINE
 * ======================================
 * The signal it builds is an ordinary `LocateSignal` at the
 * `event_cached_location` rung, fed to the SAME `precisionToPublish` /
 * `publishLocateFriendsPosition` path every other rung uses. It re-derives no
 * ceiling and stores nothing of its own on the wire: the rung's own ceiling
 * (`approximate`) and §23 decay do the coarsening, exactly as for a network fix.
 *
 * THREE THINGS RUNG 2 MUST CARRY, AND WHY EACH IS ENFORCED HERE
 * ============================================================
 *   EXPLICIT CONSENT   Caching a location is a distinct act from publishing a
 *                      live one, so it takes its own yes. `consent` must be
 *                      literally `true`; a missing or falsey value REFUSES to
 *                      build a cache. There is no "implicitly cached" fix.
 *   A BOUNDED TTL      A cached fix is stale by construction, so it must not be
 *                      emittable forever. The cache carries its own `expiresAt`,
 *                      bounded by `EVENT_CACHE_MAX_TTL_MS`, and `eventCachedSignal`
 *                      emits NOTHING once the clock passes it — before the server
 *                      even sees the write. The bound never exceeds the position
 *                      decay horizon, so a cache can never outlive the window in
 *                      which the server would serve its reading anyway.
 *   A VENUE, NOT A PIN A cached fix "names a venue, not a point" (RUNG_POLICY).
 *                      The signal may carry the cached coordinate as evidence,
 *                      but the rung's `approximate` ceiling means the publish
 *                      path drops the raw coordinate and serves the venue LABEL
 *                      — so the group learns the member checked in near a place,
 *                      not their exact location. A test asserts the coordinate
 *                      does not survive `precisionToPublish` at this rung.
 *
 * PURE. No storage, no network, no React, no clock of its own — every
 * time-dependent function takes `now` explicitly, like the rest of presence/*.
 */

import { DECAY_BOUNDARIES_MS } from './presenceLadder.ts';
import type { GeoPoint, LocateSignal } from './locateFriends.ts';

/**
 * The longest a cached check-in fix may remain emittable: §23's 60-minute
 * position decay horizon.
 *
 * A cache TTL longer than this would let `eventCachedSignal` keep producing a
 * signal the server has already decided to refuse (`observed_at` older than the
 * horizon is rejected on write and treated as expired on read), which is retry
 * noise at best. Bounding the cache to the horizon keeps the two agreeing: a
 * cache expires no later than the moment its reading stops being servable.
 */
export const EVENT_CACHE_MAX_TTL_MS = DECAY_BOUNDARIES_MS.last_known;

/**
 * The default cache lifetime when a caller does not choose one.
 *
 * Equal to the maximum: the cache is meant to survive exactly as long as its
 * reading can still be served, and the §23 decay — applied per position on both
 * sides — is what actually coarsens the fix from `recent` toward `last known`
 * inside that window. A shorter default would drop a still-servable fallback for
 * no privacy gain, because decay has already de-escalated it.
 */
export const DEFAULT_EVENT_CACHE_TTL_MS = EVENT_CACHE_MAX_TTL_MS;

/**
 * A last-known fix cached at event check-in.
 *
 * `consent` is `true` and nothing else: the only constructor refuses to build a
 * cache without it, so a value of this type is proof that consent was given.
 */
export interface EventCheckInCache {
  lat: number;
  lng: number;
  /** The event/venue this check-in named, shown as "At {venue}". */
  venueLabel: string | null;
  /** Epoch ms the cached fix was observed (at or just before check-in). */
  capturedAt: number;
  /** Epoch ms the cache stops being emittable. Always ≤ capturedAt + max TTL. */
  expiresAt: number;
  /** Always `true`. Its presence in the type IS the consent record. */
  consent: true;
}

export type EventCacheRejection = 'consent_required' | 'invalid_point' | 'invalid_clock';

export type CacheResult =
  | { ok: true; cache: EventCheckInCache }
  | { ok: false; reason: EventCacheRejection };

export interface CacheEventCheckInInput {
  lat: number;
  lng: number;
  venueLabel?: string | null;
  /** Epoch ms of the fix. Defaults to `now` when omitted. */
  capturedAt?: number;
  /** MUST be `true`. Anything else refuses — caching is its own explicit yes. */
  consent: boolean;
  /** A shorter cache lifetime than the ceiling. Clamped DOWN; never up. */
  ttlMs?: number;
  /** Clock, epoch ms, for the default `capturedAt`. */
  now: number;
}

function isFinitePoint(p: { lat: number; lng: number } | null | undefined): boolean {
  return (
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/** Clamp a requested cache TTL into `(0, EVENT_CACHE_MAX_TTL_MS]`. */
function boundedTtl(requested: number | undefined): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_EVENT_CACHE_TTL_MS;
  }
  return Math.min(EVENT_CACHE_MAX_TTL_MS, requested);
}

/**
 * Build a cached check-in fix, or refuse.
 *
 * The three refusals are the three ways a cache would be illegitimate: no
 * consent, no usable coordinate, or no usable clock. There is no path that
 * produces a cache with `consent` anything but `true`.
 */
export function cacheEventCheckInLocation(input: CacheEventCheckInInput): CacheResult {
  if (input?.consent !== true) return { ok: false, reason: 'consent_required' };
  if (!Number.isFinite(input.now)) return { ok: false, reason: 'invalid_clock' };
  if (!isFinitePoint({ lat: input.lat, lng: input.lng })) {
    return { ok: false, reason: 'invalid_point' };
  }

  const capturedAt =
    typeof input.capturedAt === 'number' && Number.isFinite(input.capturedAt)
      ? input.capturedAt
      : input.now;

  const label =
    typeof input.venueLabel === 'string' && input.venueLabel.trim() !== ''
      ? input.venueLabel.trim().slice(0, 60)
      : null;

  return {
    ok: true,
    cache: {
      lat: input.lat,
      lng: input.lng,
      venueLabel: label,
      capturedAt,
      expiresAt: capturedAt + boundedTtl(input.ttlMs),
      consent: true,
    },
  };
}

/** Whether a cache still has life left in it at `now`. */
export function isEventCacheLive(
  cache: EventCheckInCache | null | undefined,
  now: number,
): boolean {
  if (!cache || cache.consent !== true) return false;
  if (!Number.isFinite(now)) return false;
  return now < cache.expiresAt;
}

/**
 * The §12 rung-2 signal for a cached check-in fix, or `null` when there is
 * nothing to emit.
 *
 * Returns `null` — not a degraded signal — once the cache has expired or was
 * never consented to. A `null` here means "this rung has nothing", and §12's
 * chain simply moves on to the next rung, which is exactly what the ladder is
 * for. The coordinate is CARRIED (it is the evidence), but the rung's
 * `approximate` ceiling means the publish path will drop it and serve the venue
 * label instead — the cache names where the member checked in, not where they
 * are to the metre.
 */
export function eventCachedSignal(
  cache: EventCheckInCache | null | undefined,
  now: number,
): LocateSignal | null {
  if (!isEventCacheLive(cache, now)) return null;
  const c = cache as EventCheckInCache;
  const position: GeoPoint = { lat: c.lat, lng: c.lng };
  return {
    rung: 'event_cached_location',
    observedAt: c.capturedAt,
    position,
    checkpointLabel: c.venueLabel,
  };
}

/**
 * §12's fallback in one function: the fresh network signal if the device has
 * one, otherwise the cached check-in fix, otherwise nothing.
 *
 * This is the shape a live publisher's `sampleSignal` takes when it wants the
 * §28 degraded behaviour — a live fix normally, and the cached event fix when
 * the network cannot answer — without either caller re-deciding the order of
 * §12's chain. `resolvePosition` on the read side re-imposes the same order, so
 * a caller cannot promote the cache above a live fix by returning it here; this
 * only chooses WHICH evidence to offer, never how it ranks.
 */
export function sampleWithEventCacheFallback(
  freshNetworkSignal: LocateSignal | null | undefined,
  cache: EventCheckInCache | null | undefined,
  now: number,
): LocateSignal | null {
  if (freshNetworkSignal) return freshNetworkSignal;
  return eventCachedSignal(cache, now);
}
