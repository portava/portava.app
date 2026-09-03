/**
 * clientProjection — the ROLLBACK projectors (Map spec §18, §19).
 *
 * WHAT THIS FILE IS NOW
 * =====================
 * Spec §19 wants one server-side projection, and it has one: GET
 * /api/map/projection serves every layer this app draws. `useMapEntities` asks
 * it for all of them, so on the normal path NOTHING here runs.
 *
 * These projectors exist for the one case §19 does not cover: the gateway not
 * answering at all — `map_projection_enabled` off, or the call failing. That
 * makes the flag a real rollback rather than a blank map. They are dead code
 * the day the flag becomes unconditional, and not before.
 *
 * THEY MUST MIRROR THE SERVER, FIELD FOR FIELD
 * ============================================
 * "The renderer cannot tell which path produced an object" is the whole
 * contract, and it is easy to break silently: `projectTrip` read
 * `trip.destination` for both its title fallback and its subtitle, a field
 * `TripRow` has never carried (the API row is `destinationCity`), so every
 * fallback trip subtitle collapsed to the bare date range and every untitled
 * trip read "Trip". Nothing failed — the fixture had a `destination`. Each
 * projector below now names the field the SERVER reads, and
 * __tests__/clientProjection.test.ts pins them against the server's shape
 * rather than against a fixture written to match this file.
 *
 * WHAT THIS MODULE MAY AND MAY NOT DO
 * ===================================
 * MAY: shape, and record the privacy rung the source already applied.
 * MAY NOT: invent freshness or a confidence band (spec §37 — those come only
 * from the intel pipeline, server-side), or sharpen a coordinate. Every
 * projector here leaves `confidence` and `freshness` undefined, because none of
 * these sources carries evidence about "what is true here right now".
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
    // `tagline`, not `headline`: the buddy DTO has never carried a `headline`,
    // so this subtitle silently collapsed to the city alone. There is no
    // `handle` on the DTO either — the fallback must be generic.
    title: buddy.displayName ?? 'Buddy',
    subtitle: joinParts([buddy.city, buddy.tagline], ' · '),
    privacyClass: BUDDY_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.buddy_zone,
    interaction: {
      actions: ['view', 'book', 'message', 'report'],
      detailRoute: `/(rent-a-buddy)/buddy/${buddy.id}`,
      opensSheet: true,
    },
    // The public buddy DTO, minus the marketplace's `distanceKm`. Both paths
    // run the same server mapper (lib/buddyMapRead.mapBuddyPublicProfile);
    // POST /api/rent-a-buddy/search then adds a distance the gateway does not
    // compute, so carrying it would be the one field that betrays which
    // transport ran. Neither path gives a buddy pin a distance today — the
    // contract's own `distanceKm` is populated for gems only.
    payload: stripDistance(buddy),
  };
}

/** Drop the marketplace-only `distanceKm`; everything else passes through. */
function stripDistance(buddy: any): Record<string, unknown> {
  const { distanceKm: _distanceKm, ...rest } = buddy ?? {};
  return rest;
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
    // `destinationCity`, NOT `destination`: `TripRow` (services/trips.ts) has
    // only ever carried `destinationCity`, so the old read was undefined every
    // time — the subtitle silently lost its city and kept only the dates. This
    // is the field the server's projectTrip reads.
    title: trip.title ?? trip.destinationCity ?? 'Trip',
    subtitle: joinParts([trip.destinationCity, dateRange(trip.startDate, trip.endDate)], ' · '),
    privacyClass: TRIP_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.trip_stop,
    interaction: {
      actions: ['view', 'share', 'navigate'],
      detailRoute: `/trip/${trip.id}`,
      opensSheet: true,
    },
    // The server's six fields, not the whole TripRow. A payload wider than the
    // gateway's would let a card render something on the rollback path that it
    // cannot render on the normal one.
    payload: {
      destinationCity: trip.destinationCity ?? null,
      destinationCountry: trip.destinationCountry ?? null,
      startDate: trip.startDate ?? null,
      endDate: trip.endDate ?? null,
      status: trip.status ?? null,
      visibility: trip.visibility ?? null,
    },
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
    // `name`, not `displayName`: the circle-locations reader emits `name`, so
    // this read undefined and EVERY friend pin rendered the fallback. The
    // reader has already gated `name` behind each member's name-visibility
    // setting, so null means "has not opted into showing a real name" — the
    // fallback must therefore be generic, and must never reach for a handle
    // the server deliberately withheld. MapCarousel and MapEntityPreviewCard
    // already read it this way; this projector was the outlier.
    title: loc.name ?? 'Circle member',
    // City AND country, joined with ', ' — the server's projectCircleMember
    // subtitle. This read the city alone, so the same member was labelled
    // differently depending on which transport happened to serve them.
    subtitle: joinParts([loc.city, loc.country], ', '),
    privacyClass: FRIEND_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.crew_member,
    interaction: {
      // No detailRoute: circle members are reached through thread resolution,
      // not a static route.
      actions: ['message', 'follow', 'report', 'block'],
      opensSheet: true,
    },
    // The server's six fields. Note what is NOT among them: `lat`/`lng`. The
    // position belongs in `geometry`, which the §24 protection gate and the
    // §31 aggregator both coarsen; a copy sitting in `payload` would survive
    // both untouched. Mirroring the server here is a narrowing.
    payload: {
      userId: loc.userId,
      name: loc.name ?? null,
      avatarUrl: loc.avatarUrl ?? null,
      city: loc.city ?? null,
      country: loc.country ?? null,
      updatedAt: loc.updatedAt ?? null,
    },
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
