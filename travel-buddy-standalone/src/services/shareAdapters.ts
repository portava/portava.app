/**
 * shareAdapters — normalize each shareable domain object into ShareableEntity.
 *
 * ## Rules these functions obey
 *
 * 1. **Pure.** No fetch, no Supabase, no AsyncStorage, no React. An adapter
 *    receives an object the caller already loaded and returns a value. This is
 *    what makes the whole share layer testable without a network.
 * 2. **One path map.** Every URL in this file comes from ENTITY_PATHS below,
 *    through canonicalUrl(). No adapter writes a path literal, and no adapter
 *    writes a domain — canonicalUrl.ts is the only place an origin is decided.
 * 3. **Not a privacy authority.** Adapters do not re-derive visibility or
 *    apply the show-real-name rule. They pass through what the caller's data
 *    layer already decided. Two places deciding who may see a name is how the
 *    two disagree.
 * 4. **Never an empty title.** Every adapter falls back to something
 *    presentable rather than emitting ''.
 * 5. **No destination-tier actions.** No adapter declares copy_link or
 *    share_external. Those are not contextual actions an entity opts into —
 *    they are the sheet's external row, available to anything with a URL.
 *    An entity signals them by having a non-null canonicalUrl, which puts
 *    'external' in allowedDestinations; the sheet asks
 *    resolveDestinationActions() for the row. See shareActionRegistry.ts.
 *
 * ## Two adapters point somewhere else on purpose
 *
 * `toShareablePostcard` emits the *post's* URL, because passport_postcards.
 * post_id is `uuid not null references posts(id) on delete cascade` (verified:
 * 26 rows, 0 nulls) and tapping a postcard in the app has always navigated to
 * /post/:postId. There is no postcard route and there does not need to be.
 *
 * `toShareableCompassRecommendation` emits the *wrapped item's* URL, because a
 * compass recommendation is not an entity — the server's recommendationId is
 * an HMAC token over {userId, itemId, itemType, …}, so it is per-user and
 * cannot be opened by a recipient. What is shareable is the place/event/buddy/
 * post it points at.
 *
 * In both cases `entityType` stays 'postcard' / 'compass_recommendation', so
 * preview copy and analytics still see what was actually shared.
 */
import { canonicalUrl } from '../constants/canonicalUrl.ts';
import type {
  PassportPostcard,
  PublicProfile,
  ShareableEntity,
  ShareableEntityCreator,
  ShareableEntityLocation,
  ShareDestination,
  TripDetail,
} from '../types/models.ts';
import type { CanonicalPlace } from '../types/canonicalPlace.ts';
import type { EventSummary } from './events.ts';
import type { Memory } from './memories.ts';
import type { PassportStampNew } from './passportStamps.ts';
import type { SharedMoment } from './sharedMoments.ts';
import type { BuddyProfile } from './rentABuddy.ts';
import type { CompassRecommendation } from './compass.ts';

// ── The one path map ─────────────────────────────────────────────────────────
//
// Web paths as the app emits them. Note the plural/singular split is real and
// intentional: /posts and /trips are plural on the web while the expo-router
// screens are app/post/[id] and app/trip/[id]. The server landing pages in
// artifacts/api-server/src/routes/wellKnownShare.ts match the forms below.

const enc = encodeURIComponent;

const ENTITY_PATHS = {
  post:         (id: string) => `/posts/${enc(id)}`,
  trip:         (id: string) => `/trips/${enc(id)}`,
  event:        (id: string) => `/event/${enc(id)}`,
  place:        (id: string) => `/place/${enc(id)}`,
  memory:       (id: string) => `/memory/${enc(id)}`,
  stamp:        (id: string) => `/stamp/${enc(id)}`,
  gem:          (id: string) => `/gems/${enc(id)}`,
  sharedMoment: (id: string) => `/shared-moments/${enc(id)}`,
  buddy:        (id: string) => `/buddy/${enc(id)}`,
  plan:         (id: string) => `/plan/${enc(id)}`,
  /** Canonical profile form. NOT /profile/:handle (a redirect) and NOT
   *  /passport/:username (the web presentation of this same route). */
  profile:      (username: string) => `/u/${enc(username)}`,
} as const;

type PathKind = keyof typeof ENTITY_PATHS;

/** Absolute share URL for an entity, or null when the id is missing. */
function entityUrl(kind: PathKind, id: string | null | undefined): string | null {
  const raw = (id ?? '').trim();
  if (!raw) return null;
  return canonicalUrl(ENTITY_PATHS[kind](raw));
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const ALL_DESTINATIONS: readonly ShareDestination[] = [
  'dm', 'group_chat', 'trip_crew', 'circle', 'external',
];

/**
 * Every conversation destination, plus 'external' only when there is a URL to
 * hand to the OS share sheet. An in-app card can be sent without a link; an
 * external share of a linkless entity is just text with nothing to open.
 */
function destinationsFor(url: string | null): ShareDestination[] {
  return url ? [...ALL_DESTINATIONS] : ALL_DESTINATIONS.filter((d) => d !== 'external');
}

/** Collapse whitespace, drop empties, join with a separator. */
function joinParts(sep: string, ...parts: Array<string | null | undefined>): string | null {
  const kept = parts
    .map((p) => (p ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return kept.length ? kept.join(sep) : null;
}

function locationOf(
  city: string | null | undefined,
  country: string | null | undefined,
  name?: string | null,
): ShareableEntityLocation | null {
  const c = (city ?? '').trim() || null;
  const k = (country ?? '').trim() || null;
  const n = (name ?? '').trim() || null;
  if (!c && !k && !n) return null;
  return { city: c, country: k, name: n };
}

/** First non-empty string, or the fallback. Guarantees a usable title. */
function firstText(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    const t = (c ?? '').replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return null;
}

// ── Adapters ─────────────────────────────────────────────────────────────────

/**
 * Postcard → the URL of the post it was cut from.
 *
 * `creator` is a parameter because PassportPostcard carries no owner fields;
 * the passport screens that render postcards already know whose passport it is.
 */
export function toShareablePostcard(
  card: PassportPostcard,
  creator: ShareableEntityCreator | null = null,
): ShareableEntity {
  const url = entityUrl('post', card.postId);
  const where = joinParts(', ', card.locationCity, card.locationCountry);
  return {
    entityType: 'postcard',
    entityId: card.id,
    title: firstText(card.caption, card.locationName, where) ?? 'Postcard',
    subtitle: joinParts(' · ', card.locationName, where),
    description: firstText(card.caption),
    imageUrl: card.mediaUrl ?? null,
    creator,
    location: locationOf(card.locationCity, card.locationCountry, card.locationName),
    canonicalUrl: url,
    metadata: {
      postId: card.postId,
      visibility: card.visibility,
      status: card.status,
      stampEligible: card.stampEligible,
      /** The link points at the post; consumers that care should know. */
      resolvesTo: 'post',
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'share_to_pulse', 'add_to_shared_moment', 'add_to_trip'],
  };
}

export function toShareableTrip(
  trip: TripDetail,
  creator: ShareableEntityCreator | null = null,
): ShareableEntity {
  const url = entityUrl('trip', trip.id);
  const where = joinParts(', ', trip.destinationCity, trip.destinationCountry);
  return {
    entityType: 'trip',
    entityId: trip.id,
    title: firstText(trip.title, where) ?? 'Trip',
    subtitle: where,
    description: firstText(trip.tripNotes),
    imageUrl: trip.coverUrl || null,
    creator,
    location: locationOf(trip.destinationCity, trip.destinationCountry),
    canonicalUrl: url,
    metadata: {
      status: trip.status,
      visibility: trip.visibility,
      startDate: trip.startDate,
      endDate: trip.endDate,
      nights: trip.nights,
      /** The trip's plan is addressable separately; see app/plan/[id].tsx. */
      planUrl: entityUrl('plan', trip.id),
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'share_to_pulse', 'invite_traveler'],
  };
}

/** Places are catalog rows: no owner, so no creator and no user-level report. */
export function toShareablePlace(place: CanonicalPlace): ShareableEntity {
  const url = entityUrl('place', place.id);
  const where = joinParts(', ', place.neighborhood, place.city, place.countryCode);
  return {
    entityType: 'place',
    entityId: place.id,
    title: firstText(place.name) ?? 'Place',
    subtitle: where,
    description: firstText(place.formattedAddress, place.address),
    imageUrl: place.headerImageUrl ?? null,
    creator: null,
    location: locationOf(place.city, place.countryCode, place.name),
    canonicalUrl: url,
    metadata: { category: place.category, status: place.status },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_trip_crew', 'recommend_to_traveler', 'add_to_trip', 'save_to_trip', 'add_to_shared_moment'],
  };
}

/**
 * Profile → /u/:username, the canonical form.
 *
 * A handle-less profile is not shareable: canonicalUrl stays null rather than
 * falling back to /u/<uuid>. The server landing page sanitises the handle with
 * `[^a-z0-9_]`, which strips the dashes out of a uuid and could land on an
 * unrelated handle. In-app navigation may still use the uuid form
 * (UuidHandleRedirect resolves it); a shared link may not.
 */
export function toShareableProfile(profile: PublicProfile): ShareableEntity {
  const url = entityUrl('profile', profile.username);
  const where = joinParts(', ', profile.homeCity, profile.homeCountry);
  const handle = profile.username ? `@${profile.username}` : null;
  return {
    entityType: 'profile',
    entityId: profile.id,
    title: firstText(profile.displayName, handle) ?? 'Traveler',
    subtitle: joinParts(' · ', handle, where),
    description: firstText(profile.bio),
    imageUrl: profile.avatarUrl ?? null,
    creator: {
      id: profile.id,
      username: profile.username,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
    },
    location: locationOf(profile.homeCity, profile.homeCountry),
    canonicalUrl: url,
    metadata: {
      verified: profile.verified,
      passportVisibility: profile.passportVisibility,
      travelStyle: profile.travelStyle,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'recommend_to_traveler', 'invite_to_trip', 'invite_to_plan'],
  };
}

export function toShareableEvent(event: EventSummary): ShareableEntity {
  const url = entityUrl('event', event.id);
  const where = joinParts(', ', event.city, event.country);
  return {
    entityType: 'event',
    entityId: event.id,
    title: firstText(event.title) ?? 'Event',
    subtitle: joinParts(' · ', event.locationName, where),
    description: firstText(event.description),
    imageUrl: event.coverUrl ?? null,
    creator: {
      id: event.hostId,
      username: event.hostHandle,
      displayName: event.hostName,
      avatarUrl: event.hostAvatarUrl,
    },
    location: locationOf(event.city, event.country, event.locationName),
    canonicalUrl: url,
    metadata: {
      state: event.state,
      visibility: event.visibility,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      category: event.category,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'send_to_circle', 'share_to_pulse', 'invite_traveler'],
  };
}

export function toShareableMemory(memory: Memory): ShareableEntity {
  const url = entityUrl('memory', memory.id);
  const where = joinParts(', ', memory.locationCity, memory.locationCountry);
  const owner = memory.owner ?? null;
  return {
    entityType: 'memory',
    entityId: memory.id,
    title: firstText(memory.title, memory.caption, where) ?? 'Memory',
    subtitle: where,
    description: firstText(memory.caption),
    imageUrl: memory.cover?.mediaUrl ?? null,
    creator: owner
      ? {
          id: memory.ownerId,
          username: (owner as { handle?: string | null }).handle ?? null,
          displayName: (owner as { name?: string | null }).name ?? null,
          avatarUrl: (owner as { avatarUrl?: string | null }).avatarUrl ?? null,
        }
      : null,
    location: locationOf(memory.locationCity, memory.locationCountry),
    canonicalUrl: url,
    metadata: {
      state: memory.state,
      visibility: memory.visibility,
      tripId: memory.tripId,
      eventId: memory.eventId,
      startsAt: memory.startsAt,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'report'],
  };
}

/**
 * Stamp → /stamp/:id.
 *
 * The username-bearing variant (/u/:username?stamp=:id) that makeStampShareLinks
 * builds is a different, richer link and stays where it is; this adapter emits
 * the entity's own address, which works with or without a known owner.
 */
export function toShareableStamp(
  stamp: PassportStampNew,
  owner: ShareableEntityCreator | null = null,
): ShareableEntity {
  const url = entityUrl('stamp', stamp.id);
  const where = joinParts(', ', stamp.city, stamp.country);
  const name = firstText(
    stamp.titleOverride,
    stamp.definition?.name,
    where,
    stamp.stampType?.replace(/_/g, ' '),
  );
  return {
    entityType: 'stamp',
    entityId: stamp.id,
    title: name ?? 'Passport stamp',
    subtitle: where,
    description: firstText(stamp.definition?.description),
    imageUrl: stamp.thumbnailUrl ?? stamp.activeArtworkUrl ?? stamp.definition?.universalArtworkUrl ?? null,
    creator: owner,
    location: locationOf(stamp.city, stamp.country, stamp.neighborhood),
    canonicalUrl: url,
    metadata: {
      stampType: stamp.stampType,
      visibility: stamp.visibility,
      isRevoked: stamp.isRevoked,
      earnedAt: stamp.earnedAt,
      rarity: stamp.definition?.rarity ?? null,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'share_image'],
  };
}

export function toShareableSharedMoment(
  moment: SharedMoment,
  creator: ShareableEntityCreator | null = null,
): ShareableEntity {
  const url = entityUrl('sharedMoment', moment.id);
  return {
    entityType: 'shared_moment',
    entityId: moment.id,
    title: firstText(moment.title) ?? 'Shared moment',
    subtitle: null,
    description: firstText(moment.description),
    imageUrl: null,
    creator,
    location: null,
    canonicalUrl: url,
    metadata: {
      status: moment.status,
      joinPolicy: moment.joinPolicy,
      tripId: moment.tripId,
      placeId: moment.placeId,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'report'],
  };
}

/**
 * Which wrapped item types a compass recommendation can resolve to.
 *
 * Observed in production (compass_served_recommendations, 86 rows): event 47,
 * place 18, buddy 17, post 4. `hidden_gem` is emitted by CompassItemHydrator
 * but has not been served yet; `trip` comes from CompassFallbackFeedBuilder.
 *
 * Deliberately absent — CompassFallbackFeedBuilder can also emit 'booking',
 * 'suggestion' and 'message', none of which is a shareable entity. Those fall
 * through to a null canonicalUrl rather than to a guessed route.
 */
const COMPASS_ITEM_PATHS: Readonly<Record<string, PathKind>> = Object.freeze({
  post:       'post',
  event:      'event',
  place:      'place',
  buddy:      'buddy',
  hidden_gem: 'gem',
  gem:        'gem',
  trip:       'trip',
});

/**
 * Compass recommendation → the URL of the thing it recommends.
 *
 * `rec.id` / `rec.type` are the itemId / itemType the server wrapped in the
 * recommendation token. The token itself is per-user and unshareable, so it is
 * carried in metadata for analytics only, never in the URL.
 */
export function toShareableCompassRecommendation(
  rec: CompassRecommendation,
  opts: { recommendationToken?: string | null } = {},
): ShareableEntity {
  const kind = COMPASS_ITEM_PATHS[rec.type];
  const url = kind ? entityUrl(kind, rec.id) : null;
  return {
    entityType: 'compass_recommendation',
    entityId: rec.id,
    title: firstText(rec.title) ?? 'Recommendation',
    subtitle: firstText(rec.city, rec.category),
    description: firstText(rec.reason),
    imageUrl: typeof rec.data?.imageUrl === 'string' ? rec.data.imageUrl : null,
    creator: null,
    location: locationOf(rec.city, null),
    canonicalUrl: url,
    metadata: {
      itemId: rec.id,
      itemType: rec.type,
      category: rec.category,
      /** Per-user HMAC token. Never put this in a URL. */
      recommendationToken: opts.recommendationToken ?? null,
      /** null when rec.type is not a shareable entity (booking/suggestion/message). */
      resolvesTo: kind ?? null,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'add_to_trip', 'save_to_trip'],
  };
}

export function toShareableBuddyProfile(buddy: BuddyProfile): ShareableEntity {
  const url = entityUrl('buddy', buddy.id);
  const where = joinParts(', ', buddy.city, buddy.country);
  return {
    entityType: 'buddy_profile',
    entityId: buddy.id,
    title: firstText(buddy.displayName, where) ?? 'Buddy',
    subtitle: joinParts(' · ', buddy.tagline, where),
    description: firstText(buddy.bio, buddy.tagline),
    imageUrl: buddy.coverPhotoUrl ?? null,
    creator: {
      id: buddy.userId,
      username: null,
      displayName: buddy.displayName,
      avatarUrl: buddy.coverPhotoUrl ?? null,
    },
    location: locationOf(buddy.city, buddy.country),
    canonicalUrl: url,
    metadata: {
      userId: buddy.userId,
      status: buddy.status,
      verified: buddy.verified,
      categories: buddy.categories,
      averageRating: buddy.averageRating,
    },
    allowedDestinations: destinationsFor(url),
    allowedActions: ['send_to_traveler', 'recommend_to_traveler', 'report'],
  };
}

// Exported for tests, and for the (not yet built) sheet to resolve the
// "resolvesTo" hints in metadata. Nothing outside this module should build a
// share path by hand — that is the point of having one map.
export { ENTITY_PATHS, entityUrl };
export type { PathKind };
