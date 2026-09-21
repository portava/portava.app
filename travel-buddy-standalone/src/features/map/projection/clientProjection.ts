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
  type MapObjectKind,
  type PrivacyClass,
} from '../../../types/mapObjects.ts';
import type { ToggleableEntityType } from '../../../types/mapTypes.ts';

// ── The place_intel cache identity (§28, §33) ───────────────────────────
//
// THESE TWO FUNCTIONS ARE A PRIVACY BOUNDARY, NOT A PERFORMANCE TUNING KNOB.
//
// `useMapEntities` used to write its whole merged object list into the
// `place_intel` cache under the bare CITY NAME:
//
//     if (city && merged.length > 0) mapCache.write('place_intel', city, merged)
//
// `merged` contains the viewer's own trip stops (`trips` -> trip_stop) and
// crew members (`friends` -> crew_member), plus, when the §16 options are on,
// their saved places, memory pins and personal-city objects. The key's only
// variable was the city.
//
// THE BLAST RADIUS IS ONE DEVICE, AND IT IS WORTH STATING PRECISELY. The store
// is AsyncStorage, so nothing here is reachable over the network and no server
// ever serves one account's entry to another. What it is, is a cross-account
// leak BETWEEN THE ACCOUNTS THAT USE THE SAME PHONE: an account switch, a
// sign-out and sign-in (which does not clear this store — SessionContext's
// clearScopedStorageForUser enumerates a fixed prefix list the map cache is
// not on), or a shared handset. The next account to open the map in the same
// city was seeded from the previous account's private objects, and
// `mapObjectsToEntities` rendered them as if the gateway had just served them.
// A city name is not an identity.
//
// The fix is both halves together, because each alone is insufficient:
//
//   `mapProjectionCacheScope` puts the ACCOUNT in the key, so one viewer's
//   entry can never be read back as another's. It also puts the camera, zoom,
//   radius and layer set in the key, because a city label does not describe a
//   viewport: coordinate-only deep links all collapsed onto the single scope
//   `'unknown'`, and two cameras in the same city requesting different layers
//   rehydrated each other's object sets.
//
//   `isPlaceIntelCacheSafe` keeps viewer-scoped objects OUT of a
//   cross-session store at all, so the blast radius of any future keying
//   mistake is public place intelligence rather than somebody's trip.
//
// MAP_CACHE_VERSION is bumped to 'v2' in the same change, because every v1
// `place_intel` entry already on a device was written under the old key and
// must be discarded rather than re-read under the new one.

/**
 * The kinds that may enter the cross-session `place_intel` cache.
 *
 * An ALLOWLIST, deliberately. A denylist of viewer-scoped kinds would mean
 * every kind added to MAP_OBJECT_KINDS later is cached by default, and the
 * failure mode of forgetting to add one is a privacy leak that nothing fails
 * on. With an allowlist the failure mode of forgetting is a cache miss.
 *
 * Everything here describes A PLACE rather than a person or a plan: it is the
 * same answer for every viewer standing in the same viewport, so nothing about
 * who asked can be recovered from a cached copy.
 */
export const PLACE_INTEL_CACHEABLE_KINDS: readonly MapObjectKind[] = [
  'place',
  'event',
  'activity_zone',
  'crowd_flow',
  'hidden_gem',
  'safety_notice',
  'world_pulse',
  'traveler_flow',
  'city_model',
];

/**
 * Deliberately EXCLUDED, each for a stated reason — kept beside the allowlist
 * so a future reader can tell "considered and refused" from "forgotten":
 *
 *   crew_member, social_zone, buddy_zone  people, resolved against the
 *                                         viewer's own block list
 *   trip_stop, meeting_point              the viewer's own itinerary
 *   memory, saved_place, personal_city    the viewer's own history
 *   prediction                            derived from the above; fail-closed
 */
export function isPlaceIntelCacheSafe(object: { kind: MapObjectKind }): boolean {
  return PLACE_INTEL_CACHEABLE_KINDS.includes(object.kind);
}

/**
 * Stable cache identity for ONE projected viewport, for ONE account — or
 * `null`, meaning THIS PROJECTION MAY NOT BE CACHED AT ALL.
 *
 * NULL WHEN THERE IS NO ACCOUNT, AND THAT IS THE IMPORTANT CASE.
 * ==============================================================
 * The obvious alternative is to fold a missing id into a literal `anonymous`
 * bucket. That is wrong here, and not only for signed-out viewers:
 * SessionContext initialises `userId` to null and resolves it asynchronously,
 * so EVERY signed-in viewer is momentarily identity-less on a cold mount. A
 * shared `anonymous` scope would therefore be written by one account during
 * its hydration window and read by the next account during theirs — the
 * original defect, restored precisely when identity is least certain.
 *
 * So there is no fallback bucket. No account, no key, no cache; the map simply
 * paints from the network, which is what it does today on a cache miss. This
 * matches hooks/useSnapshotCache.ts, which builds `snap:v1:<key>:<userId>` and
 * refuses to build a key at all without a `userId`, and callers must honour the
 * null on BOTH the read and the write.
 *
 * Coordinates are rounded to 3 decimals (~110 m) so that a camera that has not
 * meaningfully moved still hits its own entry; callers should pass the
 * QUANTISED camera they actually fetched with, not the raw one.
 */
export function mapProjectionCacheScope(input: {
  accountId: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  zoom: number;
  radiusKm: number;
  enabledLayers: readonly ToggleableEntityType[];
  /**
   * The §16 layers that ride BESIDE `enabledLayers` on their own options.
   * They change which kinds the gateway is asked for, so two viewports that
   * differ only in these are different answers and must not share an entry.
   */
  optionalLayers?: readonly string[];
}): string | null {
  const account = input.accountId?.trim();
  if (!account) return null;
  const place =
    input.lat != null && input.lng != null
      ? `${input.lat.toFixed(3)},${input.lng.toFixed(3)}`
      : (input.city?.trim().toLowerCase() || 'unknown');
  // Sorted, so a caller reordering its layer array is not a different cache
  // entry for an identical request.
  const layers = [...input.enabledLayers].sort().join(',');
  const optional = [...(input.optionalLayers ?? [])].sort().join(',');
  return (
    `account:${account}|${place}|z${input.zoom.toFixed(1)}` +
    `|r${input.radiusKm.toFixed(1)}|${layers}|${optional}`
  );
}

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
 * A projector RECORDS the rung its source already applied, and Compass states
 * none — so these are the narrowest rung each kind is rendered at anywhere else
 * in the map, never a widening. Person-shaped kinds sit at `approximate` (where
 * §6 draws a ring rather than an avatar-precision pin) and travelers at
 * `aggregate_only`, matching the server's `travelerPrivacyClass` default.
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
  saved_place: 'place_level',
  // §36 Phase 7. Compass never produces these — no projector emits them — but
  // the table is total, so each gets the narrowest rung it is served at
  // anywhere. The three aggregates are aggregate_only by construction;
  // personal_city describes the viewer's own city history to the viewer, so it
  // sits where `memory` sits rather than at a venue rung.
  world_pulse: 'aggregate_only',
  traveler_flow: 'aggregate_only',
  city_model: 'aggregate_only',
  personal_city: 'aggregate_only',
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
 * The §14 "Matches current intent" payload carried on a Compass map object.
 *
 * The SERVER decides the match (CompassTemporaryIntent.itemMatchesIntent, the
 * same predicate the ranking boost is built on), so the map never re-derives it
 * — §19: the client does not reconstruct Portava intelligence rules. It is
 * surfaced here so compassMapModel can populate a CompassMapCandidate's
 * `matchesIntent` / `intentLabel` and buildWhyLines can emit the line.
 */
export interface CompassIntentMatchPayload {
  matchesIntent: boolean;
  intentLabel: string | null;
}

/**
 * Project one Compass recommendation into the contract.
 *
 * Compass returns a RANKED ANSWER, not an observation, so nothing here carries
 * freshness, confidence or activity — §37: "Do not let Compass invent live
 * conditions." It carries no per-kind DETAIL payload, so a card renders this
 * from `title` and `subtitle` and shows no type-specific chips, which is honest
 * about how little Compass sent. The one thing `payload` may carry is the §14
 * intent-match datum (`matchesIntent` / `intentLabel`), and only when the server
 * actually decided it — that is a ranking fact Compass DID send, not live state
 * this projector invented.
 *
 * Before this existed, AskCompassBar handed the raw `CompassRecommendation`
 * through as `entity.payload` — a THIRD shape the cards had to guess at, and the
 * one that made a Compass buddy or trip result hit `categories.slice` /
 * `visibility.replace` and take the card down.
 */
export function projectCompassResult(rec: CompassResultLike): MapObject | null {
  const kind = COMPASS_KIND[rec?.type ?? ''];
  if (!kind) return null;

  const lat = numberOrNull(rec.data?.lat);
  const lng = numberOrNull(rec.data?.lng);
  if (lat == null || lng == null) return null;

  const title = firstNonEmpty([rec.title, rec.category]) ?? 'Suggestion';

  const obj: MapObject<CompassIntentMatchPayload> = {
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

  // §14 "Matches current intent". Carried ONLY when the server actually decided
  // it (i.e. the request had a live §13 intent) — a boolean is server truth, so
  // its ABSENCE must not read as "false". The label is the intent's own name
  // ("Party"), coerced to string|null so a why-line can render "Matches current
  // Party intent" or the bare fallback.
  const matches = rec.data?.matchesIntent;
  if (typeof matches === 'boolean') {
    const rawLabel = rec.data?.intentLabel;
    obj.payload = {
      matchesIntent: matches,
      intentLabel: typeof rawLabel === 'string' && rawLabel.trim() !== '' ? rawLabel : null,
    };
  }

  return obj;
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
    // The server's five fields, not the whole HiddenGem. "Mirrors the server's
    // projectGem" is only true if `payload` mirrors it too — a wider payload
    // here is what let a gem card render vibe tags and a save count with the
    // flag OFF and nothing with it ON. Enforced by serverMirror.test.ts.
    payload: {
      category: gem.category ?? null,
      city: gem.city ?? null,
      thumbnailUrl: gem.imageUrl ?? null,
      verificationLevel: gem.verificationLevel ?? null,
      coordsPrecision: gem.coordsPrecision ?? null,
      // The live-claim subject bridge the server also emits: a gem's own id is
      // in the hidden_gems id space, not places'. Carried here so the rollback
      // path cannot lose a subject the gateway path has.
      canonicalPlaceId: gem.canonicalPlaceId ?? null,
    },
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
    // The server's five fields. `hasStarted` is the projector's own verdict on
    // its own clock — a card reading it does not re-derive "is this live now",
    // which spec §19 puts server-side.
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
