/**
 * clientProjection — projects the layers that do NOT yet come through the Map
 * Intelligence Gateway into the same MapObject contract (Map spec §18, §19).
 *
 * WHY THIS FILE EXISTS AT ALL
 * ===========================
 * Spec §19 wants one server-side projection. Three layers reach that today —
 * travelers, hidden gems and events — because each has an extractable,
 * privacy-complete server function that GET /api/map/projection can call. The
 * other three (buddies, trips, friends/circle) do not: their privacy logic
 * lives inline inside route handlers, and lifting it out is a separate change
 * that deserves its own tests rather than being done in passing.
 *
 * So those three keep their existing, already-correct per-layer transport, and
 * this module normalizes their payloads into `MapObject` at the client edge.
 * The renderer therefore sees ONE uniform stream today, and when each layer
 * moves server-side its projector here is deleted rather than rewritten.
 *
 * WHAT THIS MODULE MAY AND MAY NOT DO
 * ===================================
 * MAY: shape, and record the privacy rung the source already applied.
 * MAY NOT: invent freshness or a confidence band (spec §37 — those come only
 * from the intel pipeline, server-side), or sharpen a coordinate. Every
 * projector here leaves `confidence` and `freshness` undefined, because none of
 * these three sources carries evidence about "what is true here right now".
 *
 * Pure: no React, no network, no storage. Fully unit-testable.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';

// ── Buddies (Rent-a-Buddy availability) ───────────────────────────────────────

/**
 * A buddy's `meetupBaseLat/Lng` is already an area-rounded meetup base, not a
 * home address — MeetupAreaPreview renders it as a ~100 m area for exactly that
 * reason. It is therefore `approximate`, never `place_level`.
 */
export const BUDDY_PRIVACY_CLASS: PrivacyClass = 'approximate';

export function projectBuddy(buddy: any): MapObject | null {
  const lat = buddy?.meetupBaseLat ?? null;
  const lng = buddy?.meetupBaseLng ?? null;
  if (lat == null || lng == null) return null;

  return {
    id: `buddy:${buddy.id}`,
    kind: 'buddy_zone',
    geometry: point(Number(lat), Number(lng)),
    title: buddy.displayName ?? buddy.handle ?? 'Buddy',
    subtitle: joinParts([buddy.city, buddy.headline], ' · '),
    privacyClass: BUDDY_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.buddy_zone,
    interaction: {
      actions: ['view', 'book', 'message', 'report'],
      detailRoute: `/(rent-a-buddy)/buddy/${buddy.id}`,
      opensSheet: true,
    },
    payload: buddy,
  };
}

// ── Trips ─────────────────────────────────────────────────────────────────────

/**
 * A trip pin sits on its destination — a city or venue the user chose to record,
 * not a live position. `place_level` is the honest rung.
 */
export const TRIP_PRIVACY_CLASS: PrivacyClass = 'place_level';

export function projectTrip(trip: any): MapObject | null {
  const lat = trip?.destinationLat ?? null;
  const lng = trip?.destinationLng ?? null;
  if (lat == null || lng == null) return null;

  return {
    id: `trip:${trip.id}`,
    kind: 'trip_stop',
    geometry: point(Number(lat), Number(lng)),
    title: trip.title ?? trip.destination ?? 'Trip',
    subtitle: joinParts([trip.destination, dateRange(trip.startDate, trip.endDate)], ' · '),
    privacyClass: TRIP_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.trip_stop,
    interaction: {
      actions: ['view', 'share', 'navigate'],
      detailRoute: `/trip/${trip.id}`,
      opensSheet: true,
    },
    payload: trip,
  };
}

// ── Friends / circle ──────────────────────────────────────────────────────────

/**
 * Circle member positions arrive already opt-in-filtered by the server, and
 * `useMapEntities` additionally applies deterministic ±0.01° area jitter before
 * anything is rendered. Both facts put these at `approximate` — spec §23's rung
 * where a RING, not an avatar, is the correct treatment (§6).
 *
 * The caller must pass ALREADY-COARSENED coordinates. This projector does not
 * coarsen, because a projector that could also sharpen is a projector that will
 * eventually sharpen.
 */
export const FRIEND_PRIVACY_CLASS: PrivacyClass = 'approximate';

export function projectFriend(loc: any): MapObject | null {
  if (loc?.lat == null || loc?.lng == null) return null;

  return {
    id: `friend:${loc.userId}`,
    kind: 'crew_member',
    geometry: point(Number(loc.lat), Number(loc.lng)),
    title: loc.displayName ?? loc.handle ?? 'Friend',
    subtitle: loc.city ?? undefined,
    privacyClass: FRIEND_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.crew_member,
    interaction: {
      // No detailRoute: circle members are reached through thread resolution,
      // not a static route.
      actions: ['message', 'follow', 'report', 'block'],
      opensSheet: true,
    },
    payload: loc,
  };
}

// ── Legacy fallback projectors ────────────────────────────────────────────────
//
// Used ONLY when the gateway is unavailable (flag off, or the call failed) and
// the hook falls back to the legacy per-layer fetchers. They must produce the
// same shape the server would, so the renderer cannot tell which path ran.

/** Mirrors the server's `projectGem`. */
export function projectGemLocal(gem: any): MapObject | null {
  if (gem?.lat == null || gem?.lng == null) return null;
  if (gem.status && gem.status !== 'active') return null;

  return {
    id: `gem:${gem.id}`,
    kind: 'hidden_gem',
    geometry: point(Number(gem.lat), Number(gem.lng)),
    title: gem.name ?? 'Hidden gem',
    subtitle: joinParts([gem.category, gem.city], ' · '),
    // Fails closed to `approximate` exactly like the server: only an explicit
    // 'exact' from the privacy guard earns `place_level`.
    privacyClass: gem.coordsPrecision === 'exact' ? 'place_level' : 'approximate',
    renderingPriority: KIND_DEFAULT_PRIORITY.hidden_gem,
    interaction: {
      actions: ['view', 'save', 'share', 'navigate', 'add_to_trip', 'ask_compass', 'report'],
      detailRoute: `/gems/${gem.id}`,
      opensSheet: true,
      contributable: true,
    },
    payload: gem,
  };
}

/** Mirrors the server's `projectEvent`. */
export function projectEventLocal(ev: any, now: number = Date.now()): MapObject | null {
  const lat = ev?.locationLat ?? null;
  const lng = ev?.locationLng ?? null;
  if (lat == null || lng == null) return null;

  const startsAtMs = ev.startsAt ? new Date(ev.startsAt).getTime() : NaN;
  const active = Number.isFinite(startsAtMs) && startsAtMs <= now;

  return {
    id: `event:${ev.id}`,
    kind: 'event',
    geometry: point(Number(lat), Number(lng)),
    title: ev.title ?? 'Event',
    subtitle: joinParts([ev.locationName, ev.startsAt ? String(ev.startsAt).slice(0, 10) : null], ' · '),
    privacyClass: 'place_level',
    renderingPriority: active
      ? KIND_DEFAULT_PRIORITY.event
      : KIND_DEFAULT_PRIORITY.event - 5,
    interaction: {
      actions: ['view', 'join', 'share', 'navigate', 'add_to_trip', 'meet_here', 'report'],
      detailRoute: `/event/${ev.id}`,
      opensSheet: true,
      contributable: true,
    },
    payload: ev,
  };
}

// ── shared ────────────────────────────────────────────────────────────────────

function joinParts(parts: (string | null | undefined)[], sep: string): string | undefined {
  const s = parts.filter((p) => p != null && String(p).trim() !== '').join(sep);
  return s === '' ? undefined : s;
}

function dateRange(from: string | null | undefined, to: string | null | undefined): string | null {
  if (!from && !to) return null;
  const a = from ? String(from).slice(0, 10) : '?';
  const b = to ? String(to).slice(0, 10) : '?';
  return `${a} → ${b}`;
}
