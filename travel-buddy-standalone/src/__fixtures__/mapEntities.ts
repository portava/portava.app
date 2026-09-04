/**
 * mapEntities — map card fixtures, PRODUCED BY THE REAL PROJECTORS.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * Every map card test used to hand-write its own `payload` object literal. That
 * is what let the card renderers keep reading a shape their producer had stopped
 * emitting: the tests built the OLD shape, so they stayed green while the real
 * path threw. The same failure has now recurred six times in this repo —
 * `headline`, `displayName`, `destination`, `claimType: "crowd"`, singular search
 * types, and this one.
 *
 * So fixtures here are built the way the app builds them:
 *
 *     typed service DTO  →  the real projector  →  the real mapObjectToEntity
 *
 * Two properties follow, and both are the point:
 *
 *   1. The DTOs are TYPED (`BuddyProfile`, `TripRow`, …). A fixture field that
 *      the DTO does not have is a compile error, so a test can no longer invent
 *      a `headline` the service never sends.
 *   2. The entities come from the PRODUCTION projectors. If a projector changes
 *      what it puts on `payload`, every card test moves with it — which is the
 *      only arrangement in which a card test proves anything about the app.
 *
 * BOTH PATHS
 * ==========
 * `map_projection_enabled` decides whether events and gems arrive from the
 * gateway or from the client's fallback projectors. The fallback projectors are
 * specified to emit the same payload shape as the server's (see
 * clientProjection.ts and the mirror guard in
 * src/features/map/projection/__tests__/serverMirror.test.ts), so ONE fixture
 * covers both — a card that renders correctly from these renders correctly on
 * either path.
 */
import type { BuddyProfile } from '../services/rentABuddy.ts';
import type { TripRow } from '../services/trips.ts';
import type { CircleMemberLocation } from '../services/map.ts';
import type { HiddenGem } from '../services/hiddenGems.ts';
import type { EventListItem } from '../services/events.ts';
import type { MapObject } from '../types/mapObjects.ts';
import type { MapEntity } from '../types/mapTypes.ts';
import { mapObjectToEntity } from '../types/mapTypes.ts';
import {
  projectBuddy,
  projectEventLocal,
  projectFriend,
  projectGemLocal,
  projectTrip,
} from '../features/map/projection/clientProjection.ts';

/** Fixed clock so "has this event started" is never wall-clock dependent. */
export const FIXTURE_NOW = Date.parse('2026-08-31T21:00:00.000Z');

// ── Typed service DTOs ────────────────────────────────────────────────────────

export const buddyDto: BuddyProfile = {
  id: 'b1',
  userId: 'user-b1',
  displayName: 'Ana Costa',
  tagline: 'Lisbon local',
  bio: 'Grew up in Alfama, happy to show you the quiet streets.',
  languages: ['Portuguese', 'English'],
  city: 'Lisbon',
  country: 'Portugal',
  categories: ['food', 'culture'],
  hourlyRateUsd: 45,
  status: 'active',
  verified: true,
  verifiedAt: '2026-01-01T00:00:00Z',
  averageRating: 4.8,
  reviewCount: 22,
  responseTimeH: 1,
  coverPhotoUrl: null,
  galleryUrls: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  meetupBaseLat: 38.71,
  meetupBaseLng: -9.14,
};

export const tripDto: TripRow = {
  id: 't1',
  ownerId: 'user-t1',
  title: 'Songkran',
  destinationCity: 'Chiang Mai',
  destinationCountry: 'Thailand',
  neighborhoods: [],
  startDate: '2026-04-12',
  endDate: '2026-04-16',
  status: 'upcoming',
  visibility: 'buddies',
  travelStyle: null,
  openToMeet: true,
  coverUrl: null,
  coverMediaType: null,
  progress: 0,
  tripType: null,
  timezone: null,
  destinationLat: 18.79,
  destinationLng: 98.98,
  destinationPlaceId: null,
  tripNotes: null,
  showOnProfile: true,
  showInDiscovery: true,
  allowFriendSuggestions: true,
  allowTripCrewInvites: true,
  allowJoinRequests: true,
  showExactDates: true,
  showDestinationCity: true,
  delayedPostingDefault: false,
  preciseLocationVisible: false,
  planEditPermission: null,
  showHeaderPublicly: false,
};

export const friendDto: CircleMemberLocation = {
  userId: 'u9',
  name: 'Rui',
  avatarUrl: null,
  lat: 35.68,
  lng: 139.76,
  city: 'Tokyo',
  country: 'Japan',
  updatedAt: '2026-08-31T11:00:00.000Z',
};

export const gemDto: HiddenGem = {
  id: 'g1',
  name: 'Rooftop stairwell',
  category: 'viewpoint',
  city: 'Da Nang',
  country: 'Vietnam',
  neighborhood: 'An Hai',
  description: 'Quiet stairwell with a river view.',
  lat: 16.06,
  lng: 108.21,
  coordsPrecision: 'exact',
  vibeTags: ['quiet', 'sunset'],
  priceRange: '$',
  safetyNotes: null,
  bestTimeToGo: 'Golden hour',
  localEtiquette: null,
  layoverSafe: true,
  minimumLayoverMinutes: null,
  sensitivityLevel: 'public',
  verificationLevel: 'community',
  status: 'active',
  submittedBy: 'user-g1',
  imageUrl: 'https://cdn.example/gem.jpg',
  canonicalPlaceId: null,
  saveCount: 12,
  visitCount: 30,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  gemState: null,
  gemConfidence: null,
};

export const eventDto: EventListItem = {
  id: 'e1',
  hostId: 'user-e1',
  hostName: 'Alfama Jazz Club',
  hostHandle: 'alfamajazz',
  hostAvatarUrl: null,
  title: 'Evening Jazz at Alfama',
  description: 'Live trio, no cover.',
  locationName: 'Han River',
  locationLat: 16.07,
  locationLng: 108.22,
  // Before FIXTURE_NOW, so the projector marks this one started.
  startsAt: '2026-08-31T20:00:00.000Z',
  endsAt: '2026-08-31T23:00:00.000Z',
  coverUrl: null,
  coverMediaType: null,
  maxAttendees: null,
  ageMin: null,
  ageMax: null,
  trustScoreMin: null,
  verifiedOnly: false,
  visibility: 'public',
  state: 'open',
  chatEnabled: false,
  chatThreadId: null,
  waitlistEnabled: false,
  priceType: 'free',
  priceUrl: null,
  rsvpOptions: ['going'],
  goingCount: 42,
  waitlistCount: 0,
  category: 'music',
  city: 'Da Nang',
  country: 'Vietnam',
  rsvpClosed: false,
  showExactLocation: true,
  isHost: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  myRsvp: null,
};

// ── Projected MapObjects ──────────────────────────────────────────────────────

export function buddyObject(over: Partial<BuddyProfile> = {}): MapObject {
  return projectBuddy({ ...buddyDto, ...over })!;
}
export function tripObject(over: Partial<TripRow> = {}): MapObject {
  return projectTrip({ ...tripDto, ...over })!;
}
export function friendObject(over: Partial<CircleMemberLocation> = {}): MapObject {
  return projectFriend({ ...friendDto, ...over })!;
}
export function gemObject(over: Partial<HiddenGem> = {}): MapObject {
  return projectGemLocal({ ...gemDto, ...over })!;
}
export function eventObject(
  over: Partial<EventListItem> = {},
  now: number = FIXTURE_NOW,
): MapObject {
  return projectEventLocal({ ...eventDto, ...over }, now)!;
}

// ── Projected MapEntities (what a card actually receives) ─────────────────────

/** The one downcast the app performs, applied to a projected object. */
function toEntity(obj: MapObject): MapEntity<MapObject> {
  const e = mapObjectToEntity(obj);
  if (!e) throw new Error(`fixture object ${obj.id} has no renderable centroid`);
  return e;
}

export function buddyEntity(over: Partial<BuddyProfile> = {}): MapEntity<MapObject> {
  return toEntity(buddyObject(over));
}
export function tripEntity(over: Partial<TripRow> = {}): MapEntity<MapObject> {
  return toEntity(tripObject(over));
}
export function friendEntity(over: Partial<CircleMemberLocation> = {}): MapEntity<MapObject> {
  return toEntity(friendObject(over));
}
export function gemEntity(over: Partial<HiddenGem> = {}): MapEntity<MapObject> {
  return toEntity(gemObject(over));
}
export function eventEntity(
  over: Partial<EventListItem> = {},
  now: number = FIXTURE_NOW,
): MapEntity<MapObject> {
  return toEntity(eventObject(over, now));
}
