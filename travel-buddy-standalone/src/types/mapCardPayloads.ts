/**
 * mapCardPayloads — the typed payloads the map's card renderers may read.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * `MapEntity.payload` is `unknown` by declaration, and every card used to reach
 * into it with a cast (`entity.payload as BuddyProfile`). That made the compiler
 * agree with whatever the card claimed, so when the producers switched to
 * emitting `MapObject` (spec §18/§19) nothing failed to compile — the cards just
 * read fields that were no longer there, and two of them threw at runtime
 * (`trip.visibility.replace`, `buddy.categories.slice`).
 *
 * So the casts are gone and every payload a card may read is declared here with
 * a RUNTIME guard beside it. A guard that fails means the card renders its
 * reduced form (title + subtitle, which every `MapObject` guarantees) instead of
 * crashing — degrade, never throw.
 *
 * THE THREE SHAPES A CARD CAN SEE
 * ===============================
 *   1. `MapObject` — everything that came through a projector: the Map
 *      Intelligence Gateway (server lib/mapProjection.ts) or its client mirror
 *      (features/map/projection/clientProjection.ts). This is the normal case.
 *   2. `DiscoveryPlace` — the 'places' layer, built directly in app/map/index.tsx
 *      and never projected.
 *   3. `PassportCountryPayload` — passport-mode country pins, built by
 *      buildPassportEntities in app/map/index.tsx.
 *
 * WHAT A CARD MAY READ OFF A `MapObject`
 * ======================================
 * `title`, `subtitle` and `payload` — and nothing else about the source row.
 * Spec §19: "Never place raw database rows directly on the map." The projector
 * decides what crosses the boundary; a card that reaches past `payload` for a
 * field the projection dropped is re-creating the raw-row coupling this layer
 * exists to remove.
 *
 * GEM AND EVENT PAYLOADS MIRROR THE SERVER
 * ========================================
 * `GemCardPayload` and `EventCardPayload` are the shapes
 * artifacts/api-server/src/lib/mapProjection.ts already emits. The client's
 * fallback projectors mirror them exactly, so a card cannot tell whether the
 * gateway or the `map_projection_enabled`-off rollback path produced an object.
 * Fields the server does not send are NOT available to a card — see
 * docs/map-card-projection-gaps.md for the ones the cards used to show.
 */
import type { MapObject } from './mapObjects.ts';
import { MAP_OBJECT_KINDS } from './mapObjects.ts';

// ── Is this envelope a projected object at all? ───────────────────────────────

/**
 * Structural test for a contract `MapObject`. Checks the three fields that are
 * REQUIRED by the contract and absent from every legacy payload — `kind` against
 * the closed set, `geometry`, and `privacyClass`.
 */
export function isMapObject(value: unknown): value is MapObject {
  if (value == null || typeof value !== 'object') return false;
  const o = value as { kind?: unknown; geometry?: unknown; privacyClass?: unknown };
  return (
    typeof o.kind === 'string' &&
    (MAP_OBJECT_KINDS as readonly string[]).includes(o.kind) &&
    typeof o.geometry === 'object' &&
    o.geometry !== null &&
    typeof o.privacyClass === 'string'
  );
}

/** The projected object behind an entity, or null for a non-projected producer. */
export function objectOf(entity: { payload: unknown }): MapObject | null {
  return isMapObject(entity.payload) ? entity.payload : null;
}

// ── Per-kind card payloads ────────────────────────────────────────────────────

/**
 * Hidden gem. MIRRORS the server's `projectGem` payload exactly — do not add a
 * field here without adding it there, or the gateway path and the rollback path
 * stop agreeing.
 */
export interface GemCardPayload {
  category: string | null;
  city: string | null;
  thumbnailUrl: string | null;
  verificationLevel: string | null;
  coordsPrecision: string | null;
  /** The canonical place a gem reconciles to — the live-claim subject id. */
  canonicalPlaceId: string | null;
}

/** Event. MIRRORS the server's `projectEvent` payload exactly. */
export interface EventCardPayload {
  locationName: string | null;
  startsAt: string | null;
  coverUrl: string | null;
  visibility: string | null;
  /**
   * Whether the event has already started, decided by the PROJECTOR against its
   * own clock. The card renders the LIVE treatment off this rather than
   * recomputing it — spec §19: "The mobile client should not independently
   * reconstruct Portava intelligence rules."
   */
  hasStarted: boolean;
}

/**
 * Rent-a-Buddy availability. Client-side projection only (the gateway does not
 * serve `buddy_zone` yet), so this shape is `projectBuddy`'s to define.
 */
export interface BuddyCardPayload {
  /** The buddy LISTING id — the save payload key. Never the prefixed object id
   *  (`buddy:…`), which is the map's id, not the domain's. */
  buddyId: string | null;
  /** The buddy's user id, for message / follow / block. */
  userId: string | null;
  categories: string[];
  city: string | null;
  country: string | null;
  coverPhotoUrl: string | null;
  hourlyRateUsd: number | null;
  averageRating: number | null;
  reviewCount: number | null;
  responseTimeH: number | null;
  languages: string[];
  bio: string | null;
}

/** A trip pin. Client-side projection only. */
export interface TripCardPayload {
  destinationCity: string | null;
  destinationCountry: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  visibility: string | null;
}

/** A circle member. Client-side projection only. */
export interface FriendCardPayload {
  /** Required for the Message CTA: /messages/[id] takes a THREAD id, which is
   *  resolved from this user id. */
  userId: string;
  /**
   * Null means "has not opted into showing a real name" — the circle-locations
   * reader gates this behind each member's name-visibility setting. A card must
   * fall back to a generic label, never to a handle the server withheld.
   */
  name: string | null;
  avatarUrl: string | null;
  city: string | null;
  country: string | null;
}

/**
 * Canonical place. MIRRORS the server's `projectPlace` payload
 * (artifacts/api-server/src/lib/mapProjectPlace.ts) exactly — pinned by
 * src/features/map/projection/__tests__/serverMirror.test.ts.
 *
 * There is deliberately NO client-side projector for this kind. A canonical
 * place reaches the map only through the gateway, where §24 protection, §31
 * aggregation and §7 enrichment act on it; when the gateway is unavailable the
 * map shell keeps its legacy Discovery path, which hands the cards a
 * `DiscoveryPlace` envelope and never a `MapObject`. A client projector would
 * be a second producer of `place` objects that skips all three stages.
 */
export interface PlaceCardPayload {
  category: string | null;
  city: string | null;
  neighborhood: string | null;
  countryCode: string | null;
  /**
   * `public.places.id` — the live-claim subject (intel_state_snapshots
   * .subject_id → places.id). Never a Discovery or OSM id.
   */
  canonicalPlaceId: string;
  /**
   * The Discovery-SERVED id, `db/<places.id>`: the key the bookmark / wishlist
   * flow and placeIdBridge accept, so a place saved from a projected pin lands
   * under the SAME key the legacy Discovery path used. Saving under the bare
   * uuid or the `place:` object id would split one place into two saves.
   */
  discoveryId: string;
}

// ── Runtime guards ────────────────────────────────────────────────────────────
//
// `kind` alone is not enough: it says which projector SHOULD have produced the
// object, not that this one did. Each guard therefore checks a field the card
// actually consumes, so a producer that changes shape again degrades the card to
// title + subtitle rather than throwing inside a render.

function payloadObject(obj: MapObject): Record<string, unknown> | null {
  const p = obj.payload;
  return p != null && typeof p === 'object' ? (p as Record<string, unknown>) : null;
}

export function gemCardPayload(obj: MapObject | null): GemCardPayload | null {
  if (!obj || obj.kind !== 'hidden_gem') return null;
  const p = payloadObject(obj);
  if (!p || !('category' in p)) return null;
  return {
    category: asStr(p.category),
    city: asStr(p.city),
    thumbnailUrl: asStr(p.thumbnailUrl),
    verificationLevel: asStr(p.verificationLevel),
    coordsPrecision: asStr(p.coordsPrecision),
    canonicalPlaceId: asStr(p.canonicalPlaceId),
  };
}

export function eventCardPayload(obj: MapObject | null): EventCardPayload | null {
  if (!obj || obj.kind !== 'event') return null;
  const p = payloadObject(obj);
  if (!p || typeof p.hasStarted !== 'boolean') return null;
  return {
    locationName: asStr(p.locationName),
    startsAt: asStr(p.startsAt),
    coverUrl: asStr(p.coverUrl),
    visibility: asStr(p.visibility),
    hasStarted: p.hasStarted,
  };
}

export function buddyCardPayload(obj: MapObject | null): BuddyCardPayload | null {
  if (!obj || obj.kind !== 'buddy_zone') return null;
  const p = payloadObject(obj);
  // `projectBuddy` passes the public buddy DTO through (minus the
  // marketplace-only `distanceKm`), so `categories` is the field that is always
  // present and always this layer's — a good discriminator without pinning the
  // guard to a field the projector might legitimately drop.
  if (!p || !('categories' in p)) return null;
  return {
    buddyId: asStr(p.id),
    userId: asStr(p.userId),
    categories: asStrArray(p.categories),
    city: asStr(p.city),
    country: asStr(p.country),
    coverPhotoUrl: asStr(p.coverPhotoUrl),
    hourlyRateUsd: asNum(p.hourlyRateUsd),
    averageRating: asNum(p.averageRating),
    reviewCount: asNum(p.reviewCount),
    responseTimeH: asNum(p.responseTimeH),
    languages: asStrArray(p.languages),
    bio: asStr(p.bio),
  };
}

export function tripCardPayload(obj: MapObject | null): TripCardPayload | null {
  if (!obj || obj.kind !== 'trip_stop') return null;
  const p = payloadObject(obj);
  // The six fields `projectTrip` emits, deliberately narrower than TripRow so a
  // card cannot render on the rollback path something the gateway cannot supply.
  // NOTE there is no trip id here — the detail route comes from
  // `interaction.detailRoute`, which the projector already built.
  if (!p || !('visibility' in p)) return null;
  return {
    destinationCity: asStr(p.destinationCity),
    destinationCountry: asStr(p.destinationCountry),
    startDate: asStr(p.startDate),
    endDate: asStr(p.endDate),
    status: asStr(p.status),
    visibility: asStr(p.visibility),
  };
}

export function friendCardPayload(obj: MapObject | null): FriendCardPayload | null {
  if (!obj || obj.kind !== 'crew_member') return null;
  const p = payloadObject(obj);
  if (!p || typeof p.userId !== 'string') return null;
  return {
    userId: p.userId,
    name: asStr(p.name),
    avatarUrl: asStr(p.avatarUrl),
    city: asStr(p.city),
    country: asStr(p.country),
  };
}

export function placeCardPayload(obj: MapObject | null): PlaceCardPayload | null {
  if (!obj || obj.kind !== 'place') return null;
  const p = payloadObject(obj);
  // Both ids are load-bearing: one keys live claims, the other keys saves. An
  // object missing either is not a gateway place and gets the reduced card.
  if (!p || typeof p.canonicalPlaceId !== 'string' || p.canonicalPlaceId === '') return null;
  if (typeof p.discoveryId !== 'string' || p.discoveryId === '') return null;
  return {
    category: asStr(p.category),
    city: asStr(p.city),
    neighborhood: asStr(p.neighborhood),
    countryCode: asStr(p.countryCode),
    canonicalPlaceId: p.canonicalPlaceId,
    discoveryId: p.discoveryId,
  };
}

// ── Legacy (non-projected) payloads ───────────────────────────────────────────

/**
 * Passport country pin. Produced by buildPassportEntities, which never goes
 * through a projector — passport mode is a local view over the user's own
 * stamps, not a map projection.
 */
export function passportCardPayload(
  value: unknown,
): { country: string; stampCount: number; cities: string[] } | null {
  if (value == null || typeof value !== 'object') return null;
  const p = value as Record<string, unknown>;
  if (typeof p.country !== 'string') return null;
  return {
    country: p.country,
    stampCount: typeof p.stampCount === 'number' ? p.stampCount : 0,
    cities: asStrArray(p.cities),
  };
}

// ── Coercion helpers ──────────────────────────────────────────────────────────
//
// Every projector writes `?? null` for absent values, so these only ever have to
// turn "wrong type or missing" into the card's neutral value. They never invent
// one: an unreadable number is null, not 0.

function asStr(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStrArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
