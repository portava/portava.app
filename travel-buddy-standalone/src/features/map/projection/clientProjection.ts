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
 * PAYLOADS ARE ENUMERATED, NEVER PASSED THROUGH
 * =============================================
 * Each projector lists the fields it puts on `payload` (types in
 * src/types/mapCardPayloads.ts). It used to hand the whole service DTO through
 * instead, which read as harmless — the card found its fields either way — but
 * it made the client projectors and the SERVER projectors emit different shapes
 * for the same kind, so a card silently rendered differently depending on
 * whether `map_projection_enabled` was on. Enumerating the fields is what makes
 * the two paths indistinguishable, which is the only property that makes the
 * flag a real rollback.
 *
 * The inputs are typed (`BuddyProfile`, `TripRow`, …) rather than `any` for the
 * same reason: an `any` input is how `buddy.headline`, `trip.destination` and
 * `loc.displayName` — three fields that do not exist on their DTOs — got read
 * here without the compiler saying a word.
 *
 * Pure: no React, no network, no storage. Fully unit-testable.
 */
import {
  KIND_DEFAULT_PRIORITY,
  point,
  type MapObject,
  type MapObjectKind,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';
import type {
  BuddyCardPayload,
  EventCardPayload,
  FriendCardPayload,
  GemCardPayload,
  TripCardPayload,
} from '../../../types/mapCardPayloads.ts';
import type { BuddyProfile } from '../../../services/rentABuddy.ts';
import type { TripRow } from '../../../services/trips.ts';
import type { CircleMemberLocation } from '../../../services/map.ts';
import type { HiddenGem } from '../../../services/hiddenGems.ts';
import type { EventListItem } from '../../../services/events.ts';

// ── Buddies (Rent-a-Buddy availability) ───────────────────────────────────────

/**
 * A buddy's `meetupBaseLat/Lng` is already an area-rounded meetup base, not a
 * home address — MeetupAreaPreview renders it as a ~100 m area for exactly that
 * reason. It is therefore `approximate`, never `place_level`.
 */
export const BUDDY_PRIVACY_CLASS: PrivacyClass = 'approximate';

export function projectBuddy(buddy: BuddyProfile): MapObject<BuddyCardPayload> | null {
  const lat = buddy?.meetupBaseLat ?? null;
  const lng = buddy?.meetupBaseLng ?? null;
  if (lat == null || lng == null) return null;

  return {
    id: `buddy:${buddy.id}`,
    kind: 'buddy_zone',
    geometry: point(Number(lat), Number(lng)),
    title: buddy.displayName ?? 'Buddy',
    // `tagline` is the buddy's one-line pitch. This read used to be
    // `buddy.headline`, which BuddyProfile has never had — so every buddy pin's
    // subtitle silently collapsed to just the city.
    subtitle: joinParts([buddy.city, buddy.tagline], ' · '),
    privacyClass: BUDDY_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.buddy_zone,
    interaction: {
      actions: ['view', 'book', 'message', 'report'],
      detailRoute: `/(rent-a-buddy)/buddy/${buddy.id}`,
      opensSheet: true,
    },
    payload: {
      buddyId: buddy.id,
      userId: buddy.userId ?? null,
      categories: buddy.categories ?? [],
      city: buddy.city ?? null,
      country: buddy.country ?? null,
      coverPhotoUrl: buddy.coverPhotoUrl ?? null,
      hourlyRateUsd: buddy.hourlyRateUsd ?? null,
      averageRating: buddy.averageRating ?? null,
      reviewCount: buddy.reviewCount ?? null,
      responseTimeH: buddy.responseTimeH ?? null,
      languages: buddy.languages ?? [],
      bio: buddy.bio ?? null,
    },
  };
}

// ── Trips ─────────────────────────────────────────────────────────────────────

/**
 * A trip pin sits on its destination — a city or venue the user chose to record,
 * not a live position. `place_level` is the honest rung.
 */
export const TRIP_PRIVACY_CLASS: PrivacyClass = 'place_level';

export function projectTrip(trip: TripRow): MapObject<TripCardPayload> | null {
  const lat = trip?.destinationLat ?? null;
  const lng = trip?.destinationLng ?? null;
  if (lat == null || lng == null) return null;

  return {
    id: `trip:${trip.id}`,
    kind: 'trip_stop',
    geometry: point(Number(lat), Number(lng)),
    title: trip.title ?? 'Trip',
    // `destinationCity` — this read used to be `trip.destination`, which TripRow
    // has never had, so the subtitle was only ever the date range.
    subtitle: joinParts(
      [destinationLabel(trip), dateRange(trip.startDate, trip.endDate)],
      ' · ',
    ),
    privacyClass: TRIP_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.trip_stop,
    interaction: {
      actions: ['view', 'share', 'navigate'],
      detailRoute: `/trip/${trip.id}`,
      opensSheet: true,
    },
    payload: {
      tripId: trip.id,
      destinationCity: trip.destinationCity ?? null,
      destinationCountry: trip.destinationCountry ?? null,
      startDate: trip.startDate ?? null,
      endDate: trip.endDate ?? null,
      coverUrl: trip.coverUrl ?? null,
      visibility: trip.visibility ?? null,
    },
  };
}

function destinationLabel(trip: TripRow): string | null {
  const city = trip.destinationCity;
  if (!city) return null;
  return trip.destinationCountry ? `${city}, ${trip.destinationCountry}` : city;
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

export function projectFriend(loc: CircleMemberLocation): MapObject<FriendCardPayload> | null {
  if (loc?.lat == null || loc?.lng == null) return null;
  if (!loc.userId) return null;

  return {
    id: `friend:${loc.userId}`,
    kind: 'crew_member',
    geometry: point(Number(loc.lat), Number(loc.lng)),
    // `name` — this read used to be `loc.displayName ?? loc.handle`, neither of
    // which CircleMemberLocation has, so EVERY circle pin was titled "Friend".
    title: loc.name ?? 'Circle member',
    subtitle: loc.city ?? undefined,
    privacyClass: FRIEND_PRIVACY_CLASS,
    renderingPriority: KIND_DEFAULT_PRIORITY.crew_member,
    interaction: {
      // No detailRoute: circle members are reached through thread resolution,
      // not a static route.
      actions: ['message', 'follow', 'report', 'block'],
      opensSheet: true,
    },
    payload: {
      userId: loc.userId,
      avatarUrl: loc.avatarUrl ?? null,
      city: loc.city ?? null,
    },
  };
}

// ── Compass recommendations ───────────────────────────────────────────────────

/**
 * Which contract kind a Compass result stands for. Compass answers in its own
 * vocabulary; anything not listed here has no map representation and is dropped
 * rather than rendered as an untyped dot.
 */
const COMPASS_KIND: Record<string, MapObjectKind> = {
  event: 'event',
  place: 'place',
  gem: 'hidden_gem',
  hidden_gem: 'hidden_gem',
  buddy: 'buddy_zone',
  traveler: 'social_zone',
  user: 'social_zone',
  trip: 'trip_stop',
  friend: 'crew_member',
};

/**
 * FAIL-CLOSED privacy rungs for Compass results.
 *
 * A projector is supposed to RECORD the rung its source already applied, and
 * Compass states none — so these are the narrowest rung each kind is rendered at
 * anywhere else in the map, never a widening. Person-shaped kinds sit at
 * `approximate` (the rung `projectBuddy`/`projectFriend` use, where §6 draws a
 * ring rather than an avatar-precision pin) and travelers at `aggregate_only`,
 * matching the server's `travelerPrivacyClass` default.
 */
const COMPASS_PRIVACY: Record<MapObjectKind, PrivacyClass> = {
  place: 'place_level',
  event: 'place_level',
  hidden_gem: 'approximate',
  trip_stop: 'place_level',
  buddy_zone: 'approximate',
  crew_member: 'approximate',
  social_zone: 'aggregate_only',
  activity_zone: 'aggregate_only',
  crowd_flow: 'aggregate_only',
  meeting_point: 'place_level',
  safety_notice: 'place_level',
  memory: 'aggregate_only',
  prediction: 'aggregate_only',
};

/** The fields of a Compass recommendation this projector reads. */
export interface CompassResultLike {
  id: string;
  type?: string | null;
  category?: string | null;
  title?: string | null;
  reason?: string | null;
  city?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * Project one Compass recommendation into the contract.
 *
 * Compass returns a RANKED ANSWER, not an observation, so nothing here carries
 * freshness, confidence or activity — §37: "Do not let Compass invent live
 * conditions." It also carries no per-kind detail payload, so `payload` is
 * deliberately absent: a card renders this from `title` and `subtitle` and shows
 * no type-specific chips, which is honest about how little Compass sent.
 *
 * Coordinates are read from `data.lat`/`data.lng` and never invented — a result
 * without real coordinates is dropped, because placing it at the user's own dot
 * makes the camera fly-to look broken and puts a result where nothing is.
 */
export function projectCompassResult(rec: CompassResultLike): MapObject | null {
  const kind = COMPASS_KIND[rec?.type ?? ''];
  if (!kind) return null;

  const lat = numberOrNull(rec.data?.lat);
  const lng = numberOrNull(rec.data?.lng);
  if (lat == null || lng == null) return null;

  const title = firstNonEmpty([rec.title, rec.category]) ?? 'Suggestion';

  return {
    id: rec.id,
    kind,
    geometry: point(lat, lng),
    title,
    subtitle: joinParts([rec.reason, rec.city], ' · '),
    privacyClass: COMPASS_PRIVACY[kind],
    renderingPriority: KIND_DEFAULT_PRIORITY[kind],
    interaction: {
      actions: ['view'],
      detailRoute: kind === 'place' && rec.id ? `/place/${encodeURIComponent(rec.id)}` : undefined,
      opensSheet: true,
    },
  };
}

function numberOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function firstNonEmpty(parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    if (p != null && String(p).trim() !== '') return String(p);
  }
  return null;
}

// ── Legacy fallback projectors ────────────────────────────────────────────────
//
// Used ONLY when the gateway is unavailable (flag off, or the call failed) and
// the hook falls back to the legacy per-layer fetchers. They must produce the
// same shape the server would, so the renderer cannot tell which path ran —
// including `payload`, field for field. See the server's `projectGem` and
// `projectEvent` in artifacts/api-server/src/lib/mapProjection.ts.

/** Mirrors the server's `projectGem`. */
export function projectGemLocal(gem: HiddenGem): MapObject<GemCardPayload> | null {
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
    payload: {
      category: gem.category ?? null,
      city: gem.city ?? null,
      thumbnailUrl: gem.imageUrl ?? null,
      verificationLevel: gem.verificationLevel ?? null,
      coordsPrecision: gem.coordsPrecision ?? null,
    },
  };
}

/** Mirrors the server's `projectEvent`. */
export function projectEventLocal(
  ev: EventListItem,
  now: number = Date.now(),
): MapObject<EventCardPayload> | null {
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
    expiresAt: ev.endsAt ? String(ev.endsAt) : undefined,
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
    payload: {
      locationName: ev.locationName ?? null,
      startsAt: ev.startsAt ?? null,
      coverUrl: ev.coverUrl ?? null,
      visibility: ev.visibility ?? null,
      hasStarted: active,
    },
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
