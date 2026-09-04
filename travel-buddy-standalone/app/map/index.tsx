/**
 * Full-screen map — shared route for Discovery, Trips, and Passport entry points.
 *
 * Query params:
 *   entityTypes — comma-separated list of layers to show (e.g. "places,travelers")
 *   lat         — initial camera latitude (city/destination)
 *   lng         — initial camera longitude
 *   zoom        — initial zoom level (default 11)
 *   title       — label shown in the top control bar
 *
 * On web, renders a static "not available" placeholder with a Back button.
 * When location permission is denied, shows an inline prompt card.
 *
 * Metro selects this file for native. The web platform fallback is handled
 * inline via Platform.OS checks so we avoid a separate .web.tsx route file.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CameraRef } from '@maplibre/maplibre-react-native';
import {
  View, Text, Pressable, StyleSheet, Platform, ActivityIndicator, AppState, BackHandler,
  useWindowDimensions, Share, Alert,
} from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { router } from 'expo-router';
import { AlertTriangle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, X as XIcon } from 'lucide-react-native';
import { color, space, radius, type as t, icon, avatar } from '../../src/theme/tokens.ts';
import { MapTopControls } from '../../src/components/map/MapTopControls.tsx';
import { MapFloatingControls } from '../../src/components/map/MapFloatingControls.tsx';
import { pruneBaseMapRegions } from '../../src/features/map/cache/offlineBaseMap.ts';
import { AskCompassBar } from '../../src/components/map/AskCompassBar.tsx';
import { useLocationContext } from '../../src/context/LocationContext.tsx';
import { getDiscoveryPlaces } from '../../src/services/discovery.ts';
import type { DiscoveryPlace, DiscoveryCategory } from '../../src/services/discovery.ts';
import { getPassportMap } from '../../src/services/passportStamps.ts';
import type { PassportMapMarker } from '../../src/services/passportStamps.ts';
import { COUNTRY_CENTROIDS } from '../../src/lib/countryCentroids.ts';
import { useMapEntities } from '../../src/hooks/useMapEntities.ts';
import {
  MapFilterSheet,
  loadEnabledLayers,
} from '../../src/components/map/MapFilterSheet.tsx';
import type { MapEntity, ToggleableEntityType, PassportCountryPayload } from '../../src/types/mapTypes.ts';
import { objectOf, placeCardPayload } from '../../src/types/mapCardPayloads.ts';
import { TOGGLEABLE_LAYERS, KIND_TO_ENTITY_TYPE } from '../../src/types/mapTypes.ts';
import { MapCarousel } from '../../src/components/map/MapCarousel.tsx';
import type { MapCarouselRef } from '../../src/components/map/MapCarousel.tsx';
import { MapStoreProvider, useMapStore, deriveMapCapabilities } from '../../src/stores/mapStore.tsx';
import { resolveBack } from '../../src/features/map/state/mapMachine.ts';
import { activeIntent } from '../../src/features/map/intent/intentModel.ts';
import { NOW_OFFSET } from '../../src/features/map/time/timeMachine.ts';
import { IntentSheet } from '../../src/components/map/IntentSheet.tsx';
import { LayersSheet, loadLayerPreferences } from '../../src/components/map/LayersSheet.tsx';
import { LivePlaceSheet } from '../../src/components/map/LivePlaceSheet.tsx';
import { WhyShownSheet } from '../../src/components/map/WhyShownSheet.tsx';
import { MapContributionSheet } from '../../src/components/map/MapContributionSheet.tsx';
import { MapBottomActions } from '../../src/components/map/MapBottomActions.tsx';
import { LivePulseCard } from '../../src/components/map/LivePulseCard.tsx';
import { MapHeader, mapHeaderStackOffset } from '../../src/components/map/MapHeader.tsx';
import { MapFilterChips, MAP_FILTER_CHIPS_HEIGHT } from '../../src/components/map/MapFilterChips.tsx';
import { homeVisibleObjects, homeChipCounts } from '../../src/features/map/home/homeFilters.ts';
import { getLivePulseItems, type LivePulseItem } from '../../src/services/livePulse.ts';
import { OptimizeTodaySheet } from '../../src/components/map/OptimizeTodaySheet.tsx';
import {
  tripToMapObjects,
  optimizeToday,
  dismissProposal,
  type TripStop,
  type OptimizeProposal,
} from '../../src/features/map/trip/tripMapModel.ts';
import {
  composeTripMap,
  persistOptimizeAcceptance,
  type ComposedTripMap,
} from '../../src/features/map/trip/tripMapSources.ts';
import { fetchTripPlanMap, reorderPlanItems, createPlanItem } from '../../src/services/tripPlan.ts';
import { listSaved } from '../../src/services/discoveryBookmarks.ts';
import { getCrewMap } from '../../src/services/tripCrewLocation.ts';
import { fetchTripRoutePlan } from '../../src/services/routePlan.ts';
import { getActiveSession } from '../../src/services/safeReturn.ts';
import { fetchCompassRecommendations } from '../../src/services/compass.ts';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import type { MapMediaAsset } from '../../src/features/map/truth/contributionFlow.ts';
import type { MediaKind } from '../../src/features/map/truth/liveTruth.ts';
import { openInMaps } from '../../src/lib/openInMaps.ts';
import { centroidOf } from '../../src/types/mapObjects.ts';
import { MapSearchSheet } from '../../src/components/map/MapSearchSheet.tsx';
import { MeetHereSheet } from '../../src/components/map/MeetHereSheet.tsx';
import { LocateFriendsPanel } from '../../src/components/map/LocateFriendsPanel.tsx';
import {
  startLocateFriendsSession,
  publishManualCheckpoint,
  sharePermittedLocation,
  LOCATE_FRIENDS_PUBLISH_INTERVAL_MS,
} from '../../src/services/locateFriends.ts';
import {
  DEFAULT_LOCATE_FRIENDS_TTL_MINUTES,
  LOCATE_FRIENDS_TTL_OPTIONS,
  isTtlWithinBound,
} from '../../src/features/map/presence/locateFriendsTtl.ts';
import { useSession } from '../../src/context/SessionContext.tsx';
import { proposeMeetHere, type MeetTarget } from '../../src/features/map/meet/meetHereModel.ts';
import { countBucket, durationBucketMs } from '../../src/features/map/telemetry/mapTelemetry.ts';
import { deriveMapEntryPoint } from '../../src/features/map/telemetry/mapTelemetry.ts';
import { firstParam } from '../../src/lib/routeParams.ts';
import type { MapEntryPoint } from '../../src/features/map/telemetry/mapTelemetry.ts';
import { MapLongPressMenu } from '../../src/components/map/MapLongPressMenu.tsx';
import {
  coordinateTarget,
  objectTarget,
  coordinateOf,
  describeTarget,
  resolveShareBound,
  type LongPressTarget,
} from '../../src/features/map/interaction/longPress.ts';
import { longPressTargetAt } from '../../src/features/map/interaction/pressTarget.ts';
import { TimeMachineControl } from '../../src/components/map/TimeMachineControl.tsx';
import {
  EMPTY_LAYER_PREFERENCES,
  DEFAULT_LAYER_CONTEXT,
  isAlwaysOnLayer,
  layerForKind,
  type LayerPreferences,
  type MapLayerId,
  type ToggleableLayerId,
} from '../../src/features/map/layers/layerModel.ts';
import {
  createFetchTelemetryTransport,
  describeMapObject,
  emitMapEvent,
  endMapSession,
  notifyMapAppStateChange,
  setMapTelemetryTransport,
} from '../../src/features/map/telemetry/mapTelemetry.ts';
import { freshToken } from '../../src/services/apiToken.ts';
import {
  MAP_OBJECT_KINDS,
  precisionRank,
  type MapObject,
  type MapObjectKind,
  type MapAction,
} from '../../src/types/mapObjects.ts';
import { canonicalUrl } from '../../src/constants/canonicalUrl.ts';
import { rsvpEvent } from '../../src/services/events.ts';
import { openDirectThread } from '../../src/services/messaging.ts';
import { followUser } from '../../src/services/follows.ts';
import { blockUser } from '../../src/services/blocks.ts';
import type { ModerationSubjectType } from '../../src/services/moderation.ts';
import { ReportSheet } from '../../src/components/ReportSheet.tsx';
import { TripWishlistPicker } from '../../src/components/discovery/TripWishlistPicker.tsx';
import type { AddToTripPayload } from '../../src/components/discovery/TripWishlistPicker.tsx';
import {
  prepareForRender,
  zoomRenderBand,
  isKindVisibleAtBand,
  compassRecommendationIdsOf,
} from '../../src/features/map/render/collision.ts';
import { filterByLayers } from '../../src/features/map/layers/layerModel.ts';
import { isZoneKind } from '../../src/features/map/render/zoneStyle.ts';
import {
  selectCompassPicks,
  toMapObjects as compassPicksToMapObjects,
  type CompassMapCandidate,
} from '../../src/features/map/compass/compassMapModel.ts';
import { toTemporalObjects, offsetsEqual } from '../../src/features/map/time/timeMachine.ts';
import { buildTemporalView } from '../../src/features/map/time/temporalView.ts';
import { useTemporalEntities } from '../../src/hooks/useTemporalEntities.ts';
import type { DiscoveryMapViewProps } from '../../src/components/discovery/DiscoveryMapView.tsx';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext.tsx';

// ── Lazy-load native map component only on native ─────────────────────────────
// This avoids importing MapLibre on web where it would crash.

// `import type` is erased at compile time — it emits no require, so naming the
// props type here does NOT pull MapLibre into the web bundle. That is what lets
// this be typed properly instead of `any`.
//
// It was `React.ComponentType<any>`, and `any` silently ate four real props:
// entities, enabledEntityLayers, onSelectEntity and filterRowOffset were passed
// below and dropped, because DiscoveryMapViewProps declared none of them and
// `any` accepts anything. With the real props type, TypeScript checks this JSX.
let DiscoveryMapView: React.ComponentType<DiscoveryMapViewProps> | null = null;
if (Platform.OS !== 'web') {
  // Safe: this branch is never executed on web (tree-shaken by Metro).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  DiscoveryMapView = (
    require('../../src/components/discovery/DiscoveryMapView') as {
      DiscoveryMapView: React.ComponentType<DiscoveryMapViewProps>;
    }
  ).DiscoveryMapView;
}

// ── Passport helpers ──────────────────────────────────────────────────────────

/**
 * Collapse city-level passport markers into one country-centroid entity per
 * visited country.  Markers without a known centroid are silently skipped.
 */
function buildPassportEntities(
  markers: PassportMapMarker[],
): MapEntity<PassportCountryPayload>[] {
  // Group by country: accumulate stamp count + unique city list.
  const byCountry = new Map<string, { stampCount: number; cities: Set<string> }>();
  for (const m of markers) {
    if (!m.country) continue;
    if (!byCountry.has(m.country)) {
      byCountry.set(m.country, { stampCount: 0, cities: new Set() });
    }
    const entry = byCountry.get(m.country)!;
    entry.stampCount += m.stampCount;
    if (m.city) entry.cities.add(m.city);
  }

  const entities: MapEntity<PassportCountryPayload>[] = [];
  for (const [country, data] of byCountry.entries()) {
    const centroid = COUNTRY_CENTROIDS[country];
    if (!centroid) continue; // skip unknown countries
    entities.push({
      id: `stamp:${country}`,
      type: 'stamps',
      lat: centroid[0],
      lng: centroid[1],
      payload: {
        country,
        stampCount: data.stampCount,
        cities: Array.from(data.cities),
      },
    });
  }
  return entities;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng pairs. */
function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Camera zoom per entity type. */
/**
 * The legacy Discovery place list while the PROJECTED path is live. Module-level
 * so it is referentially stable: `placeEntities` and DiscoveryMapView's viewport
 * fit both key on it.
 */
const EMPTY_PLACES: DiscoveryPlace[] = [];

function zoomForEntity(type: MapEntity['type']): number {
  if (type === 'trips') return 10;
  if (type === 'gems' || type === 'places') return 15;
  return 14; // buddies, events, friends, travelers
}

/** Parse a query param string to a finite number, or return null. */
function parseCoord(v: string | string[] | undefined): number | null {
  const raw = Array.isArray(v) ? v[0] : v;
  if (!raw) return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

function parseZoom(v: string | string[] | undefined): number {
  const n = parseCoord(v);
  return n != null ? Math.max(1, Math.min(22, n)) : 11;
}

// ── §16 layers ↔ the legacy layer toggle ──────────────────────────────────────

/**
 * Which §16 layers a legacy `MapFilterSheet` toggle speaks for.
 *
 * DERIVED from the two canonical tables (`KIND_TO_ENTITY_TYPE` maps a contract
 * kind to its legacy layer; `layerForKind` maps the same kind to its §16 layer)
 * rather than written out, because a third hand-maintained vocabulary of the
 * same twelve ids is exactly how one of them silently loses a layer. A kind
 * added to the contract flows through here automatically.
 *
 * `safety` is skipped: §5/§24 make it always-on, and it is not expressible as a
 * user choice.
 */
const LAYERS_FOR_LEGACY_TOGGLE: Record<ToggleableEntityType, ToggleableLayerId[]> = (() => {
  const out = {} as Record<ToggleableEntityType, ToggleableLayerId[]>;
  for (const legacy of TOGGLEABLE_LAYERS) out[legacy] = [];
  for (const kind of MAP_OBJECT_KINDS) {
    const legacy = KIND_TO_ENTITY_TYPE[kind];
    if (!(TOGGLEABLE_LAYERS as readonly string[]).includes(legacy)) continue;
    const layer: MapLayerId = layerForKind(kind);
    if (isAlwaysOnLayer(layer)) continue;
    const bucket = out[legacy as ToggleableEntityType];
    if (!bucket.includes(layer)) bucket.push(layer);
  }
  return out;
})();

/**
 * The bare id behind a projected object id (`event:abc` -> `abc`).
 *
 * Every projector — client and server — prefixes with its own slug, and the
 * services that act on an object (RSVP, save) want the canonical row id. Same
 * rule the Compass candidate mapping below already used; stated once.
 */
function rawObjectId(id: string): string {
  const at = id.indexOf(':');
  return at >= 0 ? id.slice(at + 1) : id;
}

/**
 * §25 `save` — the same `AddToTripPayload` shape `MapEntityActionRow` builds,
 * from a `MapObject` instead of the legacy envelope, so both surfaces hand
 * `TripWishlistPicker` the same thing.
 *
 * The privacy rule that file's header states is honoured here rather than
 * re-derived: coordinates are carried ONLY at `place_level` or better. An
 * approximate zone contributes its name and nothing else, so saving a "roughly
 * around here" object cannot quietly persist a precise point nobody published.
 */
function savePayloadForObject(obj: MapObject): AddToTripPayload {
  const c = centroidOf(obj.geometry);
  const precise = precisionRank(obj.privacyClass) >= precisionRank('place_level');
  // A projected canonical place is saved under its Discovery-SERVED id
  // (`db/<places.id>`), the key the legacy Discovery path and placeIdBridge
  // already use — never the bare `places.id`, which would file the same place
  // under a second key (the saved_places→discovery_places→places bridge).
  const placeSaveId = placeCardPayload(obj)?.discoveryId ?? null;
  return {
    id: placeSaveId ?? rawObjectId(obj.id),
    name: obj.title,
    category: obj.kind === 'hidden_gem' ? 'hidden_gem' : KIND_TO_ENTITY_TYPE[obj.kind],
    lat: precise ? (c?.lat ?? null) : null,
    lng: precise ? (c?.lng ?? null) : null,
  };
}

/**
 * §8/§25 `share`. Same message and same origin helper `MapEntityActionRow`
 * uses, so a link shared from the map sheet and one shared from a carousel card
 * are byte-identical rather than two builders drifting apart.
 */
async function shareMapObject(obj: MapObject): Promise<void> {
  try {
    await Share.share({
      message: `Check out ${obj.title} on Portava!\n${canonicalUrl(obj.interaction?.detailRoute ?? '')}`,
    });
  } catch {
    // Cancelled, or sharing unavailable — silent, exactly as the action row.
  }
}

/**
 * §25 `join`.
 *
 * There IS a real implementation: joining is an event RSVP, and `event` is the
 * only kind `clientProjection` offers the action on. So it is wired to
 * `rsvpEvent` rather than dropped — but ONLY for events, because for anything
 * else "join" has no meaning and a button that reports success against nothing
 * would be worse than one that is not offered.
 *
 * §35 `plan_joined` fires on the CONFIRMED branch alone — a waitlist placement
 * is not a join. This screen is the SECOND producer of that event
 * (`MapEntityActionRow` is the first), which `mapTelemetryCardinality`'s
 * allow-list permits with a stated reason: one join, two surfaces — the
 * carousel action row, and the map rail / Live Place sheet. A user joins once,
 * from whichever is in front of them, so the count is not inflated; the same
 * pair `route_started` is already exempted for.
 */
async function joinMapObject(
  obj: MapObject,
  discovery: 'map' | 'compass',
): Promise<void> {
  if (obj.kind !== 'event') return;
  const res = await rsvpEvent(rawObjectId(obj.id), 'going');
  if (!res.ok) {
    Alert.alert('Could not RSVP', (res as { message?: string }).message ?? 'Please try again.');
    return;
  }
  const data = res.data as { status?: string; position?: number } | null;
  if (data?.status === 'waitlisted') {
    // A waitlist placement is not a join, and must not be reported as one —
    // hence the early return BEFORE the emit below.
    const posText = data.position != null ? ` You are #${data.position} on the waitlist.` : '';
    Alert.alert(
      "You're on the waitlist",
      `The event is full.${posText} We'll notify you if a spot opens up.`,
    );
    return;
  }
  emitMapEvent('plan_joined', {
    ref: describeMapObject(obj),
    planKind: 'event',
    // The joiner is definitionally a participant. A floor of one, not an
    // invented total — the projection carries no attendee count.
    participants: countBucket(1),
    discovery,
  });
  Alert.alert("You're going!", 'Your RSVP has been confirmed.');
}

// ── §25 person-subject actions ────────────────────────────────────────
//
// `message`, `follow` and `block` act on a PERSON, not on a location. Only two
// kinds carry one, and an object with no user id is not a person with a missing
// field — it is a place. So each of these resolves the subject FIRST and does
// nothing without it, rather than falling back to the object's own id and
// mutating the wrong row.

/** Kinds standing for a real person. `MapEntityActionRow`'s PERSON_TYPES, in MapObject vocabulary. */
const PERSON_KINDS: readonly MapObject['kind'][] = ['crew_member', 'buddy_zone'];

/** The user behind a person-bearing object; null for everything else. */
function personUserId(obj: MapObject): string | null {
  if (!PERSON_KINDS.includes(obj.kind)) return null;
  const raw = (obj.payload as { userId?: unknown } | undefined)?.userId;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * What a report about this object is filed against. The same mapping
 * `MapEntityActionRow` uses: a buddy pin is a LISTING and a circle member is a
 * USER, and moderation treats those differently — filing one as the other sends
 * a harassment report to a marketplace queue.
 */
function moderationSubjectOf(obj: MapObject): ModerationSubjectType {
  switch (obj.kind) {
    case 'event':
      return 'event';
    case 'buddy_zone':
      return 'buddy_listing';
    case 'crew_member':
      return 'user';
    default:
      return 'post';
  }
}

/** Display name for a confirmation prompt. Never an id — the user did not pick an id. */
function displayNameOf(obj: MapObject): string {
  return obj.title && obj.title !== '' ? obj.title : 'this person';
}

/**
 * §25 `message`. Opens (or reuses) the direct thread, then navigates — the same
 * two steps, with the same query params, that `MapEntityActionRow` performs, so
 * both surfaces land on one thread screen rather than two drifting routes.
 */
async function messageMapObject(obj: MapObject): Promise<void> {
  const userId = personUserId(obj);
  if (!userId) return;
  const res = await openDirectThread(userId);
  if (!res.ok || !res.data?.threadId) {
    Alert.alert('Could not open conversation', 'Please try again.');
    return;
  }
  router.push(
    `/messages/${res.data.threadId}?threadType=direct&otherUserId=${encodeURIComponent(userId)}` as never,
  );
}

/**
 * §25 `follow`.
 *
 * The §8 sheet's button is a STATIC "Follow" — unlike the carousel row it
 * carries no follow state — so this follows rather than toggles. Following
 * someone already followed is idempotent; a toggle against a state this surface
 * has never read is the version that could silently UNfollow.
 */
async function followMapObject(obj: MapObject): Promise<void> {
  const userId = personUserId(obj);
  if (!userId) return;
  const res = await followUser(userId);
  if (!res.ok) {
    Alert.alert('Could not follow', res.message ?? 'Please try again.');
    return;
  }
  // A private account answers a follow with a REQUEST, not a follow. Saying
  // "Following" there would claim access the user does not have yet.
  Alert.alert(
    res.data?.following ? 'Following' : 'Request sent',
    res.data?.following
      ? `You now follow ${displayNameOf(obj)}.`
      : 'They will see your request and can approve it.',
  );
}

/**
 * §25 `block`. Destructive and not self-evidently reversible from here, so it
 * confirms first — the same prompt shape `MapEntityActionRow` and
 * `CircleMemberRow` both use.
 */
function blockMapObject(obj: MapObject): void {
  const userId = personUserId(obj);
  if (!userId) return;
  Alert.alert(`Block ${displayNameOf(obj)}?`, 'They will no longer be able to contact you.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Block',
      style: 'destructive',
      onPress: () => {
        void (async () => {
          const res = await blockUser(userId);
          if (!res.ok) Alert.alert('Could not block', res.error ?? 'Please try again.');
        })();
      },
    },
  ]);
}


// ── Web placeholder ───────────────────────────────────────────────────────────

function WebPlaceholder() {
  return (
    <View style={p.root}>
      <View style={p.iconCircle}>
        <MapPin size={28} color={color.faint} />
      </View>
      <Text style={p.title}>Full-screen map is not available in the browser</Text>
      <Text style={p.body}>
        Open the Portava app on your phone to explore the interactive map.
      </Text>
      <Pressable style={p.backBtn} onPress={() => router.back()}>
        <Text style={p.backBtnText}>Go back</Text>
      </Pressable>
    </View>
  );
}

const p = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    backgroundColor: color.paper,
  },
  iconCircle: {
    width: avatar.s64,
    height: avatar.s64,
    borderRadius: avatar.s64 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
    textAlign: 'center',
  },
  body: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 300,
  },
  backBtn: {
    marginTop: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  backBtnText: {
    ...t.bodyStrong,
    color: '#fff',
  },
});

// ── Permission prompt ─────────────────────────────────────────────────────────

function PermissionPrompt({ onRequest }: { onRequest: () => void }) {
  return (
    <View style={pp.root}>
      <View style={pp.iconCircle}>
        <MapPin size={28} color={color.signal} />
      </View>
      <Text style={pp.title}>Location access needed</Text>
      <Text style={pp.body}>
        Allow location access so the map can center on where you are.
        You can still browse the map without it.
      </Text>
      <Pressable style={pp.btn} onPress={onRequest}>
        <Text style={pp.btnText}>Allow location</Text>
      </Pressable>
      <Pressable style={pp.skip} onPress={() => router.back()} hitSlop={8}>
        <Text style={pp.skipText}>Not now</Text>
      </Pressable>
    </View>
  );
}

const pp = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    backgroundColor: color.paper,
  },
  iconCircle: {
    width: avatar.s64,
    height: avatar.s64,
    borderRadius: avatar.s64 / 2,
    backgroundColor: color.signal + '18',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: {
    ...t.title,
    fontSize: 17,
    color: color.ink,
    textAlign: 'center',
  },
  body: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
    maxWidth: 300,
  },
  btn: {
    marginTop: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    backgroundColor: color.signal,
    borderRadius: radius.md,
  },
  btnText: {
    ...t.bodyStrong,
    color: '#fff',
  },
  skip: {
    paddingVertical: space.sm,
  },
  skipText: {
    ...t.small,
    color: color.mute,
  },
});

// ── Main screen ───────────────────────────────────────────────────────────────

/** Valid discovery category keys — mirrors the union in services/discovery.ts */
const VALID_CATEGORIES: DiscoveryCategory[] = [
  'for_you', 'places', 'food', 'nightlife', 'activities', 'events', 'beaches', 'transport',
];

function parseCategory(v: string | string[] | undefined): DiscoveryCategory {
  const raw = Array.isArray(v) ? v[0] : v;
  return (raw && (VALID_CATEGORIES as string[]).includes(raw))
    ? (raw as DiscoveryCategory)
    : 'for_you';
}

/**
 * FullScreenMapScreen — public default export.
 *
 * Wraps the inner implementation with MapStoreProvider so all child components
 * can access shared map state without prop-drilling. Existing tests that render
 * this default export automatically get the store provider.
 */
export default function FullScreenMapScreen() {
  const params = useLocalSearchParams<{ mode?: string }>();
  const mode = firstParam(params.mode);

  // Pre-select enabled layers based on mode so MapStoreProvider gets the right
  // initial value — circle mode pre-selects friends only.
  const initialLayers = mode === 'circle' ? (['friends'] as const) : undefined;

  return (
    <MapStoreProvider initialEnabledLayers={initialLayers as any}>
      <FullScreenMapScreenInner />
    </MapStoreProvider>
  );
}

/** Inner implementation — reads map state from the store via useMapStore(). */
function FullScreenMapScreenInner() {
  const insets = useSafeAreaInsets();
  // §22's eighth prompt needs a camera, and this screen is where one lives.
  // The shared picker is used rather than a map-specific one so the capture
  // rules (Take Photo / Library, permissions, quality) stay one implementation.
  const { pickMedia } = useMediaPicker();

  /**
   * §22 media capture for the contribution sheet.
   *
   * Picking ONLY. The upload goes through the app's existing
   * `services/media.uploadMedia` (POST /api/media/upload, which strips
   * EXIF/GPS) inside the sheet, and the observation the photo attaches to is
   * submitted before it — §21's order. Nothing here reads a location: a §22
   * artifact is evidence for an observation, not a position, and
   * `intel_evidence` must not become a second location store.
   */
  const requestContributionMedia = useCallback(
    async (kind: MediaKind): Promise<MapMediaAsset | null> => {
      const assets = await pickMedia({
        title: kind === 'video' ? 'Add video' : 'Add photo',
        mediaTypes: kind === 'video' ? ['videos'] : ['images'],
      });
      const asset = assets?.[0];
      if (!asset?.uri) return null;
      return {
        uri: asset.uri,
        mimeType: asset.mimeType ?? null,
        fileSize: asset.fileSize ?? null,
        duration: asset.duration != null ? asset.duration / 1000 : null,
        type: kind === 'video' ? 'video' : 'image',
      };
    },
    [pickMedia],
  );
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const { userId } = useSession();
  const params = useLocalSearchParams<{
    entityTypes?: string;
    lat?: string;
    lng?: string;
    zoom?: string;
    title?: string;
    category?: string;
    focusId?: string;
    mode?: string;
    /**
     * §35 entry point, for `map_opened.entry`. Declared so a caller CAN state
     * where the user came from; validated against MAP_ENTRY_POINTS before it
     * is published, because a query param is user-controllable and `entry` is
     * an enumerated telemetry dimension.
     */
    entry?: string;
    /** §11: render ONE trip's itinerary rather than every trip's destination. */
    tripId?: string;
  }>();

  const { isEnabled: isFlagEnabled } = useFeatureFlags();

  const {
    enabledLayers,
    setEnabledLayers,
    carouselIndex: activeIndex,
    setCarouselIndex: setActiveIndex,
    selectedEntityId,
    setSelectedEntityId,
    cameraCenter,
    cameraZoom,
    setCameraCenter,
    setCameraZoom,
    machine,
    dispatchMapEvent,
    setMapCapabilities,
    intent,
    setIntent,
    clearIntent,
    timeOffset,
    setTimeOffset,
    homeFilter,
    setHomeFilter,
  } = useMapStore();

  // Shared camera ref — forwarded into DiscoveryMapView so the Camera element
  // inside is the same ref that MapTopControls calls easeTo on.
  // Typed as CameraRef (maplibre-react-native v11 imperative handle); null until Camera mounts.
  const cameraRef = useRef<CameraRef | null>(null);
  const { locationState, requireLocation, resolvedLocation } = useLocationContext();
  // Parse query params — invalid / missing values are silently ignored.
  const paramLat = parseCoord(params.lat);
  const paramLng = parseCoord(params.lng);
  const paramZoom = parseZoom(params.zoom);
  const title = firstParam(params.title);
  const entityTypes = firstParam(params.entityTypes) ?? '';
  const category = parseCategory(params.category);
  /** focusId: if set, carousel + camera will snap to the matching entity on first load. */
  const focusId = firstParam(params.focusId);
  /** mode: 'passport' | 'circle' | undefined — controls layer presets and UI. */
  const mode = firstParam(params.mode);

  /**
   * §35 `map_opened.entry` — WHERE the user came from. A different vocabulary
   * from `mode` above, which is a MAP MODE.
   *
   * This was `mode ?? 'direct'`, and every production path emitted a value
   * outside MapEntryPoint: 'circle' and 'passport' are modes, and 'direct' is
   * not in the union at all — so a plain tab open, the commonest case of all,
   * published an invalid entry point. Nothing caught it because `mode` was
   * `any` (see firstParam above), so an arbitrary deep-link string could also
   * be published into an enumerated dimension.
   *
   * Derived only from what is knowable here: an explicit, VALIDATED `entry`
   * param when a caller supplies one, else `tab` for a bare open and
   * `deeplink` for a URL carrying anything. No information is lost — the same
   * payload already reports `mode` from the state machine.
   */
  const entryPoint: MapEntryPoint = deriveMapEntryPoint(params);

  // Resolved camera position: prefer explicit params, then fall back through the
  // full 3-tier cascade (GPS → last-known session → profile home) via resolvedLocation.
  const fallbackLat = paramLat ?? (resolvedLocation.coords?.lat ?? null);
  const fallbackLng = paramLng ?? (resolvedLocation.coords?.lng ?? null);
  // userLat/userLng = actual live GPS position (for proximity sorting only).
  const userLat = locationState.coords?.lat ?? null;
  const userLng = locationState.coords?.lng ?? null;


  // ── Passport stamp entities ────────────────────────────────────────────────
  // In passport mode, fetch country-level stamp data and synthesise MapEntities.
  // The regular entity hooks are bypassed — stamp data replaces them entirely.
  const [passportEntities, setPassportEntities] = useState<MapEntity<PassportCountryPayload>[]>([]);
  const [passportLoading, setPassportLoading] = useState(false);
  const [passportError, setPassportError] = useState<string | null>(null);
  // Increment to re-trigger the passport fetch (retry mechanism).
  const [passportRetryCount, setPassportRetryCount] = useState(0);

  const handlePassportRetry = useCallback(() => {
    setPassportRetryCount((n) => n + 1);
  }, []);

  useEffect(() => {
    if (mode !== 'passport') return;
    let cancelled = false;
    setPassportError(null);

    // Only show the loading card if the fetch takes longer than 150 ms.
    // This prevents a one-frame flicker when stamps resolve quickly.
    const loadingTimer = setTimeout(() => {
      if (!cancelled) setPassportLoading(true);
    }, 150);

    getPassportMap().then((res) => {
      clearTimeout(loadingTimer);
      if (cancelled) return;
      setPassportLoading(false);
      if (res.ok) {
        setPassportEntities(buildPassportEntities(res.data.markers));
        setPassportError(null);
      } else {
        setPassportError(res.message ?? 'Could not load your stamps');
      }
    }).catch((e: unknown) => {
      clearTimeout(loadingTimer);
      if (cancelled) return;
      setPassportLoading(false);
      setPassportError(e instanceof Error ? e.message : 'Network error');
    });
    return () => {
      cancelled = true;
      clearTimeout(loadingTimer);
    };
  // passportRetryCount is intentionally included to allow retry on demand.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, passportRetryCount]);

  // ── Entity layer filter state ───────────────────────────────────────────────
  // enabledLayers now lives in the store (initialised by FullScreenMapScreen
  // wrapper which passes the mode-aware initial value to MapStoreProvider).
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Restore persisted layer preferences on mount — skipped in circle/passport mode
  // so the preset is not overwritten by stored prefs.
  useEffect(() => {
    if (mode === 'circle' || mode === 'passport') return;
    loadEnabledLayers().then(setEnabledLayers).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Entity data fetch ───────────────────────────────────────────────────────
  // `title` is used as the city name — passed in from Discovery / Trips entry points.
  // In passport mode the hook still runs but its output is discarded in favour of
  // ── §16 layer preferences (tri-state; separate from the legacy boolean set) ──
  //
  // Declared HERE, above useMapEntities, and that position is load-bearing.
  // §16 gives crowd_flow a `contextual` default whose two automatic triggers
  // are both circular — `density` is measured by the projection layer (a
  // property of the response) and CROWD_FLOW mode is gated on a capability
  // derived from flows having already arrived. §16's EXPLICIT user choice is
  // the only non-circular trigger, and it lives in this state, so the hook
  // cannot ask for the kind unless this is resolved before it runs.
  const [layerPrefs, setLayerPrefs] = useState<LayerPreferences>(EMPTY_LAYER_PREFERENCES);
  useEffect(() => {
    loadLayerPreferences().then(setLayerPrefs).catch(() => {});
  }, []);

  /**
   * §16 Relevant Places through the gateway (spec §19; server
   * lib/mapProjectPlace.ts). `relevant_places` defaults to `on`, so the kind is
   * requested unless the viewer has switched the layer off in the Layers sheet.
   * Passport mode asks for nothing at all. The §16 pipeline below still applies
   * mode forcing/suppression to whatever arrives; this is only the REQUEST.
   */
  const placesWanted = mode !== 'passport' && layerPrefs.relevant_places !== 'off';

  // ── §34 live camera ──────────────────────────────────────────────────────────
  // Where the camera actually SETTLED, reported by DiscoveryMapView through its
  // onCameraChange prop. Declared above useMapEntities because the hook now
  // takes it as the §34 re-query source: it used to be kept out of the fetch
  // key because "a float that changes on every pinch would refetch the
  // projection continuously" — the hook now QUANTISES it to a zoom band + a
  // coarse centre grid and only re-queries after the §34 settle debounce, so a
  // pan inside the viewport never re-queries and crossing into a new area does
  // exactly once. It still also drives §17 bands and the §31 collision viewport
  // (activeZoom / zoomBand, below).
  const [liveCamera, setLiveCamera] =
    useState<{ zoom: number; lat: number; lng: number } | null>(null);
  const handleCameraChange = useCallback(
    (cam: { zoom: number; center: { lat: number; lng: number } }) => {
      setLiveCamera((prev) =>
        prev && prev.zoom === cam.zoom && prev.lat === cam.center.lat && prev.lng === cam.center.lng
          ? prev
          : { zoom: cam.zoom, lat: cam.center.lat, lng: cam.center.lng },
      );
    },
    [],
  );

  // passportEntities — React hooks cannot be called conditionally.
  const {
    entities: defaultEntities,
    objects: defaultObjects,
    liveEnrichment,
    staleness,
    source: entitiesSource,
    stage: entitiesStage,
  } = useMapEntities({
    enabledLayers: mode === 'passport' ? [] : enabledLayers,
    city: mode === 'passport' ? null : title,
    lat: fallbackLat,
    lng: fallbackLng,
    zoom: cameraZoom ?? paramZoom,
    // §34: once the camera settles, the viewport intelligence is fetched for
    // where the user is actually looking, not where the shell last aimed. Null
    // in passport mode, which fetches nothing regardless.
    camera: mode === 'passport' ? null : liveCamera,
    // §16 explicit choice only. Passport mode asks for nothing at all, so it
    // must not smuggle a flow request past that intent.
    crowdFlow: mode !== 'passport' && layerPrefs.crowd_flow === 'on',
    places: placesWanted,
    // §16 Saved (default on): requested unless the viewer switched it off — the
    // on-by-default twin of `places`.
    saved: mode !== 'passport' && layerPrefs.saved !== 'off',
    // §16 Memories (default off): explicit opt-in only.
    memories: mode !== 'passport' && layerPrefs.memories === 'on',
    // §5/§24 Safety (always on): a hazard notice cannot be switched off, so it
    // is requested on every non-passport load. The §16 pipeline still force-
    // resolves the layer visible; this is only the REQUEST.
    safety: mode !== 'passport',
    // §11/§16 Trip meeting points (trip layer, contextual): requested when a
    // trip is on the map — trip mode, or the legacy Trips pin that seeds the
    // §16 trip layer on. Downstream §16 filtering owns final visibility.
    meetingPoints: mode !== 'passport' && (machine.mode === 'TRIP' || enabledLayers.includes('trips')),
  });

  // ── Places: projected through the gateway, or the legacy Discovery fetch ───
  //
  // Map spec §19: canonical places enter the map through the projection, where
  // §24 protection, §31 aggregation and §7 enrichment act on them. They arrive
  // in `defaultObjects` above as `kind: 'place'` and take the same road as
  // every other kind — the §16 pipeline, the §31 collision pass, the §8 sheet
  // and the §25 rail. `useMapEntities` reports `source === 'gateway'` when the
  // projection answered, and ONLY then is this the live path.
  //
  // The legacy path — GET /api/discovery/places, MapEntity<DiscoveryPlace>
  // envelopes, DiscoveryMapView's own pin loop — is kept byte-for-byte as the
  // rollback for `map_projection_enabled` off (or the gateway failing), exactly
  // as every other layer's rollback works. It is NOT run while the gateway's
  // first verdict is still pending: firing it and then discarding the result
  // would flash unprotected pins for the duration of the projection call, and
  // the §33 stage ladder only leaves `cached_geography` once a network verdict
  // — gateway or rollback — has actually arrived.
  const projectedPlacesActive = placesWanted && entitiesSource === 'gateway';
  const gatewayVerdictPending =
    placesWanted && entitiesSource !== 'gateway' && entitiesStage === 'cached_geography';

  // Fetch discovery places when the caller requests the "places" entity layer
  // and a destination city name is available (passed as the `title` param from
  // the discovery tab).  Tracks loading / error / empty states so the map can
  // surface meaningful feedback instead of a silent blank pin layer.
  const [places, setPlaces] = useState<DiscoveryPlace[]>([]);
  const [placesLoading, setPlacesLoading] = useState(false);
  const [placesError, setPlacesError] = useState<string | null>(null);
  // Increment to re-trigger the places fetch (retry mechanism).
  const [placesRetryCount, setPlacesRetryCount] = useState(0);
  // Tracks whether at least one places fetch has settled (success or error).
  // Uses a ref so flipping it never causes an extra render; the accompanying
  // setPlacesLoading(false) call provides the re-render trigger.
  const placesFetchedRef = useRef(false);

  const handlePlacesRetry = useCallback(() => {
    setPlacesRetryCount((n) => n + 1);
  }, []);

  const destination = title; // city name string, e.g. "Cebu City"

  // Whether the places layer has been requested and a destination is available.
  const placesLayerActive =
    entityTypes.split(',').map((s: string) => s.trim()).includes('places') && !!destination;
  /** The legacy Discovery fetch is live: requested, and the projection is not serving places. */
  const legacyPlacesActive = placesLayerActive && !projectedPlacesActive && !gatewayVerdictPending;
  /**
   * What the legacy renderer and envelopes see. Empty while the projected path
   * is live, so a list fetched before the gateway's verdict (or on a previous
   * verdict) can never be drawn beside the projected objects.
   */
  const legacyPlaces = projectedPlacesActive ? EMPTY_PLACES : places;

  // Zero-results state: fetch completed, no error, but the list is empty.
  // placesFetchedRef guards against the initial false-positive before the
  // first fetch settles (setPlacesLoading(false) triggers the re-render that
  // reads this ref, so it is always current when evaluated).
  const placesEmpty =
    legacyPlacesActive && placesFetchedRef.current && !placesLoading && !placesError && legacyPlaces.length === 0;

  useEffect(() => {
    if (!legacyPlacesActive) return;

    let cancelled = false;
    setPlacesError(null);
    setPlacesLoading(true);

    getDiscoveryPlaces(
      destination!,
      category,
      { radiusKm: 10, openNow: false, minRating: null },
      1,
      null,
      null,
      null,
      null,
      paramLat,
      paramLng,
      userLat,
      userLng,
    ).then((res) => {
      if (cancelled) return;
      placesFetchedRef.current = true;
      setPlacesLoading(false);
      if (res.ok && Array.isArray(res.data?.places)) {
        setPlaces(res.data.places);
        setPlacesError(null);
      } else {
        setPlaces([]);
        setPlacesError((!res.ok && res.error) ? res.error : 'Could not load nearby places');
      }
    }).catch((e: unknown) => {
      if (cancelled) return;
      placesFetchedRef.current = true;
      setPlaces([]); // clear any stale pins so the error card is visible
      setPlacesLoading(false);
      setPlacesError(e instanceof Error ? e.message : 'Network error');
    });

    return () => { cancelled = true; };
  // placesRetryCount is intentionally included to allow retry on demand.
  // legacyPlacesActive folds in entityTypes, the destination and the gateway
  // verdict, so a verdict arriving after mount starts (or never starts) it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, category, legacyPlacesActive, paramLat, paramLng, userLat, userLng, placesRetryCount]);

  // ── §11 Trip Map ────────────────────────────────────────────────────────────
  // "Trip Map renders the current Trip geographically without duplicating or
  // replacing Trip ownership." Every §11 element is read from its OWNING system
  // (§20) and composed by `composeTripMap`; the plan stays canonical in Trips.
  //
  //   lodging / stops / meeting points  ← the trip's plan-map items
  //   saved ideas                       ← the trip's wishlist (listSaved)
  //   crew                              ← getCrewMap, as COARSE AREA LABELS ONLY
  //                                       (§23) — no coordinates are ever invented
  //   routes                            ← the viewer's route plan for the trip
  //   Safe Return                       ← the active Safe Return session
  //   Compass alternatives              ← recommendations for the next stop
  //
  // Each source is fetched independently and a failure is swallowed to [] / null,
  // so one unreachable system never blanks the map (§33). Optimize Today is a
  // PROPOSAL the user must accept; acceptance persists through the Trips write
  // path (`persistOptimizeAcceptance`), never a silent rewrite.
  const tripId = firstParam(params.tripId);
  const tripCity = title;
  const [composedTrip, setComposedTrip] = useState<ComposedTripMap | null>(null);
  const [proposal, setProposal] = useState<OptimizeProposal | null>(null);

  const buildComposedTrip = useCallback(async (): Promise<ComposedTripMap | null> => {
    if (!tripId) return null;
    const nowIso = new Date().toISOString();
    const [planItems, savedPlaces, crewRes, routePlan, safeRes, compassRes] = await Promise.all([
      fetchTripPlanMap(tripId).catch(() => []),
      listSaved(tripId).catch(() => []),
      getCrewMap(tripId).catch(() => ({ ok: false as const, error: 'unavailable' })),
      fetchTripRoutePlan(tripId).catch(() => null),
      getActiveSession().catch(() => ({ session: null })),
      fetchCompassRecommendations({ surface: 'trip', tripId, city: tripCity ?? undefined }).catch(
        () => ({ ok: false as const, error: 'unavailable' }),
      ),
    ]);
    // Safe Return is only this trip's context when the active session is bound
    // to this trip (§24 purpose-bound); an unrelated session is not projected.
    const safeReturnSession =
      safeRes.session && safeRes.session.tripId === tripId ? safeRes.session : null;
    return composeTripMap({
      tripId,
      planItems,
      savedPlaces,
      crew: crewRes.ok ? crewRes.data.members : [],
      routePlan,
      safeReturnSession,
      compassRecommendations: compassRes.ok ? (compassRes.data?.recommendations ?? []) : [],
      now: nowIso,
    });
  }, [tripId, tripCity]);

  useEffect(() => {
    let cancelled = false;
    void buildComposedTrip().then((c) => { if (!cancelled) setComposedTrip(c); });
    return () => { cancelled = true; };
  }, [buildComposedTrip]);

  // The day's stops, in canonical order, for Optimize Today. Never renumbered —
  // a proposal reorders the array, not the orderIndex values.
  const tripStops = useMemo<readonly TripStop[]>(
    () => composedTrip?.source.stops ?? [],
    [composedTrip],
  );

  const tripObjects = useMemo(() => {
    if (!tripId || !composedTrip) return null;
    const objs = tripToMapObjects(composedTrip.source, { now: new Date().toISOString() }) as MapObject[];
    return objs.length > 0 ? objs : null;
  }, [tripId, composedTrip]);

  // ── §30 capabilities ────────────────────────────────────────────────────────
  // `canEnterMode` fails closed, and nothing in the app ever called
  // `setMapCapabilities`, so the record the machine was created with was also
  // the record it died with: three surfaces were gated by a switch that had no
  // hand on it. The record is now DERIVED from what this session can actually
  // see — see `deriveMapCapabilities` for what each answer rests on.
  //
  // The derivation runs against the objects the gateway returned, NOT against
  // the post-layer/post-zoom projection: whether the world contains aggregate
  // movement is a fact about the data, not about what the user has switched on.
  const crowdFlowObjectCount = useMemo(
    () => defaultObjects.reduce((n, o) => (o.kind === 'crowd_flow' ? n + 1 : n), 0),
    [defaultObjects],
  );
  const capabilities = useMemo(
    () =>
      deriveMapCapabilities({
        crowdFlowObjectCount,
        locateFriendsFlagEnabled: isFlagEnabled('locate_friends_enabled'),
        // §12 is group-scoped: the only scope this screen can name is the trip
        // it was opened for. No trip, no session to start, no mode to enter.
        locateFriendsScopeId: tripId,
        viewerId: userId ?? null,
        // §15 — the temporal producer rides the SAME gateway flag the NOW
        // projection does, so "the gateway answered for this session" is the
        // honest presence check that the per-offset source is reachable. Legacy
        // (per-layer) means the gateway is off/unreachable → no source to scrub.
        timeMachineProducerEnabled: entitiesSource !== 'legacy',
      }),
    [crowdFlowObjectCount, isFlagEnabled, tripId, userId, entitiesSource],
  );
  useEffect(() => {
    // The store bails out when the record says the same thing, so this settles
    // after one dispatch instead of re-rendering on every pass.
    setMapCapabilities(capabilities);
  }, [capabilities, setMapCapabilities]);

  // ── §15 Time Machine — the per-offset payload ────────────────────────────────
  // When the user scrubs to a non-NOW offset, the map shows a DIFFERENT instant
  // fetched from GET /api/map/projection/temporal — real predictions/history, not
  // the NOW map relabelled (§37). At NOW this fetches nothing; the screen keeps
  // using the useMapEntities objects for the present.
  const temporal = useTemporalEntities({
    lat: fallbackLat,
    lng: fallbackLng,
    zoom: cameraZoom ?? paramZoom,
    offset: timeOffset,
    active: capabilities.TIME_MACHINE === true,
  });

  // ── §3 / §26 Live Pulse ─────────────────────────────────────────────────────
  // "Bottom Live Pulse card summarizes the most important nearby change." The
  // card itself decides WHICH item is most important, via the pure
  // selectHeadlinePulseItem, so that choice is deterministic and testable rather
  // than baked into this screen.
  const [pulseItems, setPulseItems] = useState<LivePulseItem[]>([]);
  useEffect(() => {
    if (mode === 'passport') return;
    let cancelled = false;
    void (async () => {
      const res = await getLivePulseItems({}).catch(() => null);
      if (!cancelled && res && res.ok) setPulseItems(res.items);
    })();
    return () => { cancelled = true; };
  }, [mode]);

  // ── §35 telemetry ───────────────────────────────────────────────────────────
  // Transport is installed once per map session. Without one the emitter keeps
  // queueing rather than discarding, so boot-time events survive.
  useEffect(() => {
    setMapTelemetryTransport(
      createFetchTelemetryTransport({
        baseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? '',
        getToken: freshToken,
      }),
    );
    const sub = AppState.addEventListener('change', notifyMapAppStateChange);
    emitMapEvent('map_opened', {
      entry: entryPoint,
      mode: machine.mode,
      zoom: cameraZoom ?? paramZoom,
      hasTripContext: entityTypes.includes('trips'),
      hasCrewContext: entityTypes.includes('friends'),
    });
    return () => {
      sub.remove();
      endMapSession();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── §28 offline base-map hygiene ─────────────────────────────────────────────
  // "Clearly label stale cached intelligence" applies to cached geography too:
  // drop offline base-map packs past the base_map_region TTL (and any beyond the
  // class's entry cap) whenever the map opens. Fire-and-forget and fails soft —
  // it downloads nothing, only prunes, and reports `offline_unavailable` on a
  // build without the native OfflineManager (web / Jest). Creating a pack is a
  // deliberate act a §28 "download this area" surface owns; this is the upkeep
  // that keeps whatever exists inside policy.
  useEffect(() => {
    void pruneBaseMapRegions().catch(() => {});
  }, []);

  // ── §30 Back ladder ─────────────────────────────────────────────────────────
  // Overlay -> selection -> secondary mode -> let the router pop. Navigation is
  // deliberately NOT a rung: a stray back must not drop the user out of
  // turn-by-turn.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const outcome = resolveBack(machine);
      if (!outcome.handled) return false;
      dispatchMapEvent({ type: 'BACK' });
      return true;
    });
    return () => sub.remove();
  }, [machine, dispatchMapEvent]);

  // ── §30 END_NAVIGATION on return from external routing ───────────────────────
  // Navigate hands off to the device's maps app (see handleMapAction), which
  // backgrounds Portava. There is no in-app turn-by-turn to "finish", so the
  // honest end of the navigation framing is the moment the user comes BACK: the
  // app returns to the foreground. This listener is mounted ONLY while a
  // navigation is active, so a plain background/foreground with nothing routing
  // dispatches nothing, and END_NAVIGATION on a null navigation is a machine
  // no-op regardless. On return the destination pin's §5 promotion is released.
  const hasNavigation = machine.navigation !== null;
  useEffect(() => {
    if (!hasNavigation) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') dispatchMapEvent({ type: 'END_NAVIGATION' });
    });
    return () => sub.remove();
  }, [hasNavigation, dispatchMapEvent]);

  // ── Compass search override ─────────────────────────────────────────────────
  // When a Compass query is active, compassOverrideEntities replaces defaultEntities
  // for both the marker layers and the carousel.  Cleared via the ✕ dismiss button.
  const [compassOverrideEntities, setCompassOverrideEntities] = useState<MapEntity[] | null>(null);
  const [compassQuery, setCompassQuery] = useState<string | null>(null);
  /**
   * §14: Compass Map Mode "reduces visual noise and highlights approximately
   * three to five best next moves". These are the picks as MapObjects, carrying
   * RENDERING_PRIORITY.compass_recommendation and the §6 star treatment.
   */
  const [compassPickObjects, setCompassPickObjects] = useState<MapObject[] | null>(null);

  // ── Geocode-and-fly ──────────────────────────────────────────────────────────
  // Converts a free-text query to coordinates via Nominatim (free, no API key)
  // then flies the camera there.  Runs independently of entity coordinates so
  // the map moves even when Compass returns results without lat/lng.
  const geocodeAndFly = useCallback(async (query: string) => {
    try {
      const url =
        `https://nominatim.openstreetmap.org/search` +
        `?q=${encodeURIComponent(query)}&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'TravelBuddyApp/1.0 (map-search)' },
      });
      if (!res.ok) {
        console.debug('[Map] geocode: HTTP', res.status, 'for', query);
        return;
      }
      const hits: Array<{ lat: string; lon: string; display_name: string }> = await res.json();
      if (!hits[0]) {
        console.debug('[Map] geocode: no results for', query);
        return;
      }
      const lat = parseFloat(hits[0].lat);
      const lng = parseFloat(hits[0].lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      console.debug('[Map] geocode succeeded', { query, lat, lng, place: hits[0].display_name });
      if (cameraRef.current && typeof cameraRef.current.easeTo === 'function') {
        console.debug('[Map] geocode: calling easeTo → center', [lng, lat]);
        cameraRef.current.easeTo({ center: [lng, lat], zoom: 11, duration: 700 });
      } else {
        console.debug('[Map] geocode: camera ref not ready');
      }
    } catch (err) {
      console.debug('[Map] geocode error', err);
    }
    // cameraRef is a stable React ref — intentionally excluded from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCompassResults(entities: MapEntity[], query: string) {
    setCompassOverrideEntities(entities);
    setCompassQuery(query);

    // §14 — run the results through the Compass map model rather than rendering
    // them raw. It enforces the 3-5 bound, builds the "WHY THIS OPTION" lines,
    // and (the part that matters) is structurally unable to upgrade a
    // recommendation's confidence or freshness beyond its source: a Compass pick
    // over a stale place stays stale. §37: "Do not let Compass invent live
    // conditions."
    const candidates: CompassMapCandidate[] = entities.map((e) => {
      // AskCompassBar projects its results (projectCompassResult), so `payload`
      // is a MapObject here just as it is for every other producer.
      const obj = objectOf(e) ?? undefined;
      return {
        id: rawObjectId(e.id),
        // AskCompassBar projects its results now, so `obj` is always present
        // here and the raw-payload fallback this used to carry is unreachable.
        title: obj?.title ?? 'Suggestion',
        subtitle: obj?.subtitle,
        lat: e.lat,
        lng: e.lng,
        kind: obj?.kind,
        // Carry-through only — never a value this screen invented.
        source: obj
          ? { confidence: obj.confidence, freshness: obj.freshness, activity: obj.activity }
          : undefined,
        // matchesIntent is deliberately absent: whether a candidate matches the
        // §13 intent is a RANKING judgement, and §14 says Compass "reasons over
        // structured state produced elsewhere". The screen cannot know it, and
        // guessing would put a "Matches current intent" line under something
        // nothing verified. buildWhyLines omits the line when the input is absent.
        privacyClass: obj?.privacyClass,
        provenance: obj?.provenance,
        sourceRefs: obj?.sourceRefs,
        detailRoute: obj?.interaction?.detailRoute ?? e.detailRoute,
        distanceKm: obj?.distanceKm ?? null,
        raw: e.payload,
      };
    });
    // A new question starts a new round count — "show me something else" is
    // scoped to one decision, not to the session.
    alternativeRoundRef.current = 0;
    const picked = selectCompassPicks(candidates);
    // `ok:false` means fewer than the §14 minimum survived. Render what there
    // is rather than nothing — but do not pad the list to reach three.
    setCompassPickObjects(
      picked.picks.length > 0 ? (compassPicksToMapObjects(picked.picks) as MapObject[]) : null,
    );
    // Fly the camera to the queried location regardless of entity coordinates.
    // toMapEntity (AskCompassBar) now skips results without real lat/lng, so for
    // city/region queries the camera would otherwise stay unless we geocode here.
    void geocodeAndFly(query);
  }

  function handleCompassClear() {
    setCompassOverrideEntities(null);
    setCompassQuery(null);
    setCompassPickObjects(null);
  }

  // ── Place entities ──────────────────────────────────────────────────────────
  // Convert fetched DiscoveryPlace objects into MapEntity envelopes so they
  // participate in the carousel / handleSelectEntity flow (same as buddies,
  // events, gems, etc.).  EntityMapLayers filters 'places' out (not a
  // ToggleableEntityType), so the DiscoveryMapView's own visiblePlaces loop
  // remains the sole renderer for place pins — no double rendering.
  const placeEntities = useMemo(
    (): MapEntity<DiscoveryPlace>[] =>
      legacyPlaces
        .filter((p) => p.lat != null && p.lng != null)
        .map((p) => ({
          id: `place:${p.id}`,
          type: 'places' as const,
          lat: p.lat as number,
          lng: p.lng as number,
          payload: p,
          // detailRoute drives navigation in MapCarousel and MapEntityPreviewCard;
          // without it the card falls back to the Discover tab stub.
          // Canonical rows route by their bare uuid so the full place page (living
          // surface + Quick Signal) loads; discovery/OSM rows keep the payload route.
          detailRoute: `/place/${encodeURIComponent(p.canonicalPlaceId ?? p.id)}?placeJson=${encodeURIComponent(JSON.stringify(p))}`,
          actionCapabilities: ['save', 'directions', 'add_to_trip', 'share'] as import('../../src/types/mapTypes.ts').MapActionCapability[],
        })),
    [legacyPlaces],
  );

  // ── §16 / §19 the one layer decision on this screen ─────────────────────────
  // Declared here rather than beside the render pipeline below because the
  // MARKERS need it too: `filterByLayers` was imported and never called, so the
  // Layers sheet wrote preferences that could not reach a drawn pin.
  //
  // `liveCamera` (declared above, before useMapEntities) is where the camera
  // ENDED UP. It takes precedence over cameraZoom/cameraCenter, which are
  // written when the screen COMMANDS a camera move (a carousel swipe, a marker
  // tap) and describe where the camera was SENT. When the two disagree the
  // camera is the authority.
  const activeZoom = liveCamera?.zoom ?? cameraZoom ?? paramZoom;
  const zoomBand = zoomRenderBand(activeZoom);

  const layerContext = useMemo(
    () => ({
      ...DEFAULT_LAYER_CONTEXT,
      mode: machine.mode,
      // §16 names zoom and trip state as inputs to automatic relevance, and the
      // screen already knows both — passing the defaults instead told the
      // contextual layers the map was always at city zoom with no trip.
      zoomBand,
      tripActive: tripId != null,
    }),
    [machine.mode, zoomBand, tripId],
  );

  /**
   * The §16 preferences, composed with the legacy `MapFilterSheet` toggle set.
   *
   * Two layer controls coexist (they have different storage keys — see the
   * LayersSheet comment below), and only the legacy one was reaching markers.
   * Now both do, composed so that:
   *
   *   - a legacy toggle that is ON asserts an explicit `on` for the §16 layers
   *     it speaks for. Without this the §16 DEFAULTS (Hidden Gems off, Buddies
   *     off, Trip contextual) would silently delete gem, buddy, trip and crew
   *     pins the user never asked to hide — including from the Gems and Circle
   *     entry points, which would then open onto an empty map;
   *   - an explicit LayersSheet choice OUTRANKS that seed, because it is the
   *     newer and more specific control and `layerPrefs` only ever contains
   *     keys the user actually touched (§16: an explicit choice outranks the
   *     automatic resolution).
   *
   * A legacy toggle that is OFF asserts nothing: `EntityMapLayers` already
   * drops those pins, so the §16 default is left to speak for the layer.
   *
   * Net effect on what is drawn: relative to before, this can only ever REMOVE
   * objects, and only ones a user explicitly switched off.
   */
  const effectiveLayerPrefs = useMemo<LayerPreferences>(() => {
    const seeded: Partial<Record<ToggleableLayerId, 'on'>> = {};
    for (const legacy of TOGGLEABLE_LAYERS) {
      if (!enabledLayers.includes(legacy)) continue;
      for (const layer of LAYERS_FOR_LEGACY_TOGGLE[legacy]) seeded[layer] = 'on';
    }
    return { ...seeded, ...layerPrefs };
  }, [enabledLayers, layerPrefs]);

  /**
   * The kinds the user EXPLICITLY ASKED FOR — the trigger for the owner's
   * "cull, but never to empty" ruling (see `CollisionOptions.requestedKinds`).
   *
   * Two signals, and the second is not optional:
   *
   *  1. `?entityTypes=…`. A deep link that names a layer is the clearest form
   *     of the request: `/map?entityTypes=gems` is the Gems tab's "View on
   *     map", and it is the entry point the ruling was written about — it
   *     passes no `zoom`, so it lands at 11, one band below where §17
   *     introduces `hidden_gem`.
   *
   *  2. An explicit `on` in `effectiveLayerPrefs`. The deep link says "show me
   *     gems now"; the layer switch says "show me gems always". They are the
   *     same request through different doors, and honouring only the first
   *     would blank the gem layer for a user who turned Hidden Gems on in the
   *     §16 sheet and then opened the map from anywhere else — the identical
   *     failure, reached by a different route. It also has to be the COMPOSED
   *     preferences, because this screen must not hold two answers to "is this
   *     layer on": the legacy `MapFilterSheet` toggle is a real user-facing
   *     control, and the seed above already treats its ON state as an explicit
   *     `on` that outranks §16's automatic default.
   *
   * What does NOT count: a `LAYER_DEFAULTS` value. `relevant_places` defaults
   * to `on`, and reading a default as a request would arm the guard for
   * `place` — the most common object on the map — for every user on every
   * screen, which would retire §17's "individual places only from district in"
   * altogether. Absence of a key is the automatic state, not a request.
   *
   * `KIND_TO_ENTITY_TYPE` is many-to-one (the zone and forecast kinds all map
   * to `places` because the legacy renderer had nowhere else to put them), so
   * `?entityTypes=places` nominates `memory` and `safety_notice` too. Harmless
   * by construction: §17 introduces both in the `world` row, so they are never
   * band-culled and the waiver can never have anything to do.
   */
  const requestedKinds = useMemo<MapObjectKind[]>(() => {
    const named = new Set(
      entityTypes.split(',').map((s: string) => s.trim()).filter(Boolean),
    );
    return MAP_OBJECT_KINDS.filter((kind) => {
      if (named.has(KIND_TO_ENTITY_TYPE[kind])) return true;
      const layer = layerForKind(kind);
      return !isAlwaysOnLayer(layer) && effectiveLayerPrefs[layer] === 'on';
    });
  }, [entityTypes, effectiveLayerPrefs]);

  /**
   * The objects the §16 decision is made over: the pipeline's INPUT, before any
   * filtering, so a marker can be matched to the object it came from.
   */
  const pipelineBase = compassPickObjects ?? (tripObjects ?? defaultObjects);

  /**
   * Ids the layers say NO to.
   *
   * Deliberately a HIDDEN set rather than a kept set. `useMapEntities` builds
   * its entities from these very objects (`mapObjectsToEntities` preserves
   * `obj.id`), so the two lists match by id — but the entity list ALSO carries
   * things the pipeline never evaluated: discovery places, passport stamps and
   * raw Compass results, none of which have a MapObject here at all (the
   * Compass PICKS are re-keyed to bare ids, so they do not match either).
   * Filtering to a kept set would delete every one of those and blank passport
   * mode outright. An id is dropped only when the pipeline actually looked at
   * it and said no; everything else passes through untouched.
   */
  const layerHiddenIds = useMemo(() => {
    const hidden = new Set<string>();
    if (pipelineBase.length === 0) return hidden;
    const visible = new Set(
      filterByLayers(pipelineBase, effectiveLayerPrefs, layerContext).map((o) => o.id),
    );
    for (const o of pipelineBase) if (!visible.has(o.id)) hidden.add(o.id);
    return hidden;
  }, [pipelineBase, effectiveLayerPrefs, layerContext]);

  // The active entity list.  Priority order:
  //   1. Compass override (active search result)
  //   2. Passport entities when mode=passport
  //   3. Default hook-sourced entities + place entities
  const allEntities = compassOverrideEntities ?? (
    mode === 'passport' ? passportEntities : [...defaultEntities, ...placeEntities]
  );

  // One list drives the markers AND the carousel, so a card can never advertise
  // a pin the map is not drawing. Identity is preserved when nothing is hidden,
  // which keeps the compass/passport branches referentially stable exactly as
  // before.
  const entities = layerHiddenIds.size === 0
    ? allEntities
    : allEntities.filter((e) => !layerHiddenIds.has(e.id));

  // ── Carousel state ──────────────────────────────────────────────────────────
  // activeIndex / setActiveIndex come from the map store (carouselIndex / setCarouselIndex).
  const carouselRef = useRef<MapCarouselRef>(null);
  // Tracks whether focusId has already been applied — only snap once on first load.
  const focusAppliedRef = useRef(false);
  // "first mount only" guard — initialization effects (proximity selection,
  // focusId snap) must not run again when the screen re-focuses after a detail
  // push/pop. useFocusEffect handles restoration; this guards the entities effect.
  const hasInitializedRef = useRef(false);
  // Set to true immediately before a detail-screen push (via onBeforeNavigate).
  // Lets useFocusEffect distinguish a back-nav re-focus (restore) from a
  // tab-switch re-focus (clear stale selection + re-run proximity).
  const pushedToDetailRef = useRef(false);
  // Guards useFocusEffect from running the tab-switch path on the very first
  // mount — the entities effect already handles proximity on mount, and calling
  // scrollToIndex(_, false) before selection is established breaks the
  // backNavRestoration tests.
  const hasFocusedOnceRef = useRef(false);

  // Auto-select closest entity whenever the entities list changes.
  // If focusId is set and not yet applied, prefer that entity over proximity.
  // On re-focus after back-navigation, selectedEntityId is non-null: if the
  // entity is still in the list, use its index instead of re-computing proximity
  // so the map doesn't flash a reset state.
  useEffect(() => {
    if (entities.length === 0) {
      // Only reset index to 0 on the very first mount, not on every entities
      // update — avoids clobbering the restored index on a re-fetch.
      if (!hasInitializedRef.current) setActiveIndex(0);
      hasInitializedRef.current = true;
      return;
    }

    hasInitializedRef.current = true;

    // focusId snap: find matching entity and center on it (once only).
    // Accepts both the raw ID (e.g. "abc123") and the prefixed form used by
    // useMapEntities (e.g. "event:abc123") so callers can pass either.
    if (focusId && !focusAppliedRef.current) {
      const focusIndex = entities.findIndex(
        (e) => e.id === focusId || e.id.endsWith(`:${focusId}`),
      );
      if (focusIndex >= 0) {
        focusAppliedRef.current = true;
        setActiveIndex(focusIndex);
        carouselRef.current?.scrollToIndex(focusIndex);
        const entity = entities[focusIndex];
        // §30 FOCUS_OBJECT — frame the deep-linked object WITHOUT selecting it.
        // This snap centres the camera on a focusId without opening its sheet
        // (a marker tap does that via SELECT_OBJECT), so the machine's framing
        // event is FOCUS_OBJECT: camera → the kind's framing, cameraTargetId →
        // the object, selection untouched. Kind comes off the entity's own
        // MapObject; the reducer no-ops on a malformed kind, so a payload-less
        // entity simply leaves the machine framing where it was.
        const focusObj = objectOf(entity);
        if (focusObj) {
          dispatchMapEvent({ type: 'FOCUS_OBJECT', objectId: focusObj.id, objectKind: focusObj.kind });
        }
        if (cameraRef.current && typeof cameraRef.current.easeTo === 'function') {
          cameraRef.current.easeTo({
            center: [entity.lng, entity.lat],
            zoom: zoomForEntity(entity.type),
            duration: 400,
          });
        }
        return;
      }
      // focusId not matched — fall through to proximity selection; camera stays on
      // city default (no crash, per robustness requirement).
    }

    // Restoration path: if returning from a detail screen, selectedEntityId is
    // still set in the store. Use that entity's current index so the carousel
    // doesn't jump to a proximity-sorted position after the entity list re-fetches.
    // selectedEntityId is intentionally excluded from deps (we only want this
    // effect to fire when entities changes, not on every selection change).
    if (selectedEntityId) {
      const restoredIndex = entities.findIndex((e) => e.id === selectedEntityId);
      if (restoredIndex >= 0) {
        setActiveIndex(restoredIndex);
        // Camera position is already stored from before the push (Phase 1) —
        // no easeTo needed here.
        return;
      }
    }

    let bestIndex = 0;
    if (userLat != null && userLng != null) {
      let bestDist = Infinity;
      entities.forEach((e, i) => {
        const d = haversineKm(userLat, userLng, e.lat, e.lng);
        if (d < bestDist) { bestDist = d; bestIndex = i; }
      });
    }
    setActiveIndex(bestIndex);
    // Scroll carousel to that card (may not be mounted yet on first render —
    // the FlatList initialScrollIndex handles the initial position instead).
    carouselRef.current?.scrollToIndex(bestIndex);
    // Pan the camera to the selected entity.
    const entity = entities[bestIndex];
    if (entity) {
      if (cameraRef.current && typeof cameraRef.current.easeTo === 'function') {
        cameraRef.current.easeTo({
          center: [entity.lng, entity.lat],
          zoom: zoomForEntity(entity.type),
          duration: 400,
        });
      }
    }
  // Deliberately exclude userLat/userLng and selectedEntityId from deps —
  // fire only when the entity list changes, not on location or selection updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entities]);

  /** Called when the user swipes the carousel to a new card. */
  const handleCarouselIndexChange = useCallback(
    (index: number) => {
      setActiveIndex(index);
      const entity = entities[index];
      if (!entity) return;
      // Keep selectedEntityId on the card the user is actually looking at.
      // mapStore documents this field as "which entity marker / carousel card
      // is active", but only marker taps ever set it, so after a swipe the
      // selected pin stayed on the previously TAPPED entity while the camera
      // and the card moved on — a highlight pointing at the wrong pin. This
      // fires only on real user-driven index changes: handleMomentumScrollEnd
      // guards on clamped !== activeIndex, and the tab-switch and restoration
      // paths call setActiveIndex directly rather than going through here.
      setSelectedEntityId(entity.id);
      const zoom = zoomForEntity(entity.type);
      // Capture camera position in the store so it can be restored on back.
      setCameraCenter({ lat: entity.lat, lng: entity.lng });
      setCameraZoom(zoom);
      if (cameraRef.current && typeof cameraRef.current.easeTo === 'function') {
        cameraRef.current.easeTo({
          center: [entity.lng, entity.lat],
          zoom,
          duration: 400,
        });
      }
    },
    [entities, setCameraCenter, setCameraZoom, setActiveIndex, setSelectedEntityId],
  );

  // ── §17 / §31 render pipeline ───────────────────────────────────────────────
  // Order matters and follows §19: layers decide what MAY be drawn, the zoom
  // band decides what is legible at this scale, Time Machine coerces forecasts
  // so they cannot look like observations, and only then does §31 collision
  // decide what actually fits.
  //
  // `activeZoom` / `zoomBand` / `layerContext` are declared with the marker
  // filter above — the markers need the same decision, and one screen must not
  // hold two answers to "is this layer on".
  //
  // §17 is deliberately NOT applied here any more. It is applied once, inside
  // `prepareForRender` below, because that is where the "cull, but never to
  // empty" ruling can see whether culling a kind would leave it with nothing —
  // a question this stage cannot answer, since the answer depends on what
  // survives collision. `objects` is then re-derived from the verdict.
  const permittedObjects: MapObject[] = useMemo(() => {
    // §14 — while a Compass query is active the map shows the picks and nothing
    // else. That IS the mode: "reduces visual noise and highlights approximately
    // three to five best next moves".
    // 1. §16 layers, then §3's chip. homeVisibleObjects composes them in that
    //    order so a chip can only ever narrow what the layers already permit —
    //    a chip must never switch a layer back on.
    // §15 — at a non-NOW offset the base is the REAL per-offset payload from the
    // temporal producer (predictions / observed history), NOT the NOW map: the
    // old `toTemporalObjects(pipelineBase, offset)` could only relabel today's
    // objects, which is exactly §37's "predictions looking like observations".
    // At NOW `temporal.objects` is empty and this stays byte-identical to before.
    const base = offsetsEqual(timeOffset, NOW_OFFSET) ? pipelineBase : temporal.objects;
    // §16 layers still narrow the per-offset payload. In TIME_MACHINE mode the
    // layer context forces `live_activity` on (predictions map to it) and leaves
    // relevant_places on (historical places map to that), so the real payload
    // survives the filter rather than being silently dropped.
    const permitted = homeVisibleObjects(base, homeFilter, effectiveLayerPrefs, layerContext);
    // 2. §15 — the ONE construction point: a forecast becomes kind 'prediction'
    //    and loses any live freshness, so zoneStyle gives it the dashed treatment
    //    (§37). On the temporal payload this is the enforcement pass (a prediction
    //    stays a prediction); on the NOW map it is a no-op.
    return toTemporalObjects(permitted, timeOffset) as unknown as MapObject[];
  }, [
    pipelineBase,
    temporal.objects,
    homeFilter,
    effectiveLayerPrefs,
    layerContext,
    timeOffset,
  ]);

  // Badge counts must use the same layer-aware path as the objects themselves,
  // or a chip can advertise results the map will not draw.
  const chipCounts = useMemo(
    () => homeChipCounts(compassPickObjects ?? defaultObjects, effectiveLayerPrefs, layerContext),
    [compassPickObjects, defaultObjects, effectiveLayerPrefs, layerContext],
  );

  // §15 — the TimeMachineControl's own view of the offset: the city timeline and
  // a representative forecast confidence, derived from the SAME real per-offset
  // payload the map draws (temporal.objects at a non-NOW offset, the NOW map at
  // NOW). An offset with nothing to show yields an empty timeline, which
  // CityTimeline renders as its honest "no city trend" state — never a blank that
  // reads as "nothing is happening".
  const temporalView = useMemo(() => {
    const source = offsetsEqual(timeOffset, NOW_OFFSET)
      ? (compassPickObjects ?? defaultObjects)
      : temporal.objects;
    return buildTemporalView(source, timeOffset);
  }, [timeOffset, temporal.objects, compassPickObjects, defaultObjects]);

  // §31 — collision only among the point-shaped markers. `dropped` is surfaced
  // rather than swallowed: a hidden object the user cannot reach is a silent
  // truncation, and the count is what an "N more" affordance needs.
  //
  // This is also where §17 band culling happens now, because only here is the
  // "cull, but never to empty" ruling decidable: `requestedKinds` lets the
  // resolver waive the band gate for a kind the user asked for when applying it
  // would leave that kind with nothing on screen. Zones are excluded from the
  // input as before, so a zone kind can never be waived — §17 keeps its full
  // force over Levels 2-3, where the failure the ruling names (a marker layer
  // that goes blank at the band boundary) does not exist.
  const renderResult = useMemo(
    () =>
      prepareForRender(
        permittedObjects.filter((o) => !isZoneKind(o.kind)),
        {
          viewport: {
            zoom: activeZoom,
            center: {
              lat: liveCamera?.lat ?? cameraCenter?.lat ?? fallbackLat ?? 0,
              lng: liveCamera?.lng ?? cameraCenter?.lng ?? fallbackLng ?? 0,
            },
            width: windowWidth,
            height: windowHeight,
          },
          requestedKinds,
          promotion: {
            selectedId: machine.selection?.objectId ?? null,
            navigationTargetId: machine.navigation?.destinationObjectId ?? null,
            // §14/§31 — promoteAll recomputes renderingPriority from each
            // object's KIND, so the Compass rung the pick producer stamped is
            // discarded unless the ids are named here. Without this the picks
            // fall to their kind default and the "3-5 best next moves" lose
            // collisions to ordinary events and live zones.
            compassRecommendationIds: compassRecommendationIdsOf(permittedObjects),
          },
        },
      ),
    [
      permittedObjects,
      requestedKinds,
      activeZoom,
      liveCamera,
      cameraCenter,
      fallbackLat,
      fallbackLng,
      machine.selection?.objectId,
      machine.navigation,
      windowWidth,
      windowHeight,
    ],
  );

  /**
   * Everything §17 says is legible right now — the screen's own view of "what
   * is on the map", kept in step with the resolver's.
   *
   * `bandWaivedKinds` is read back rather than recomputed so there is exactly
   * one answer to "was this kind rescued". Without it a waived gem would be
   * drawn as a pin (from `renderResult.kept`) and simultaneously be absent from
   * `objects` — so `selectedObject` would resolve to null and tapping the pin
   * the ruling exists to preserve would open nothing.
   */
  const objects: MapObject[] = useMemo(() => {
    const waived = renderResult.bandWaivedKinds;
    return permittedObjects.filter(
      (o) => isKindVisibleAtBand(o.kind, zoomBand) || waived.includes(o.kind),
    );
  }, [permittedObjects, zoomBand, renderResult.bandWaivedKinds]);

  // §5 levels 2-3: zones render beneath everything and skip collision.
  //
  // `crowd_flow` is included even though it is NOT a ZoneKind, and that is
  // deliberate rather than sloppy. This array feeds two layers — ActivityZone
  // and CrowdFlowLayer — and each re-filters for what it draws: ActivityZone
  // keeps only isZoneKind, CrowdFlowLayer keeps only 'crowd_flow'. Filtering to
  // ZONE_KINDS here therefore starved the flow layer of every object it exists
  // to render, so §10 would have gone live and drawn nothing.
  //
  // It must NOT be added to ZONE_KINDS to fix that: a flow is a LineString and
  // ActivityZone draws polygons, so widening the kind list would send it to a
  // renderer that cannot draw it. The feed widens; the vocabulary does not.
  const zoneObjects = useMemo(
    () => objects.filter((o) => isZoneKind(o.kind) || o.kind === 'crowd_flow'),
    [objects],
  );

  /**
   * Every id the pipeline above had JURISDICTION over: its own input, minus the
   * zone kinds it never judges. Anything outside this set has no `MapObject`
   * projection at all — discovery place pins, passport stamps, raw Compass
   * envelopes (the Compass PICKS are re-keyed to bare ids, so even those do not
   * match) — so `renderResult` holds no verdict about it and it must pass
   * through untouched. Filtering the markers to `kept` alone would delete every
   * one of them and blank passport mode outright.
   */
  const pipelineJudgedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const o of permittedObjects) if (!isZoneKind(o.kind)) ids.add(o.id);
    return ids;
  }, [permittedObjects]);

  /**
   * What the MARKER LAYER draws: the entities whose object survived §17 and
   * §31, plus everything the pipeline never judged.
   *
   * Until this landed the map was handed the raw `entities` array, so the whole
   * declutter stage was computed and thrown away — and the "+N more nearby"
   * chip counted markers that were still on screen, an affordance offering to
   * reveal what was never hidden.
   *
   * Matched by id because `MapEntity` and `MapObject` are two envelopes over
   * the same object (`mapObjectToEntity` copies `obj.id` verbatim).
   *
   * The CAROUSEL deliberately keeps the full `entities` list: collision.ts is
   * explicit that "a hidden object the user cannot reach is a silent
   * truncation", so a decluttered pin stays reachable as a card.
   */
  const renderedEntities = useMemo(() => {
    if (pipelineJudgedIds.size === 0) return entities;
    const kept = new Set(renderResult.kept.map((o) => o.id));
    return entities.filter((e) => kept.has(e.id) || !pipelineJudgedIds.has(e.id));
  }, [entities, renderResult.kept, pipelineJudgedIds]);

  /**
   * The "+N more nearby" count — only markers that are genuinely not drawn.
   *
   * Two things make that true, and neither was true before:
   *
   *  1. `renderedEntities` above actually removes them. While the map drew the
   *     raw list this number described objects the user could already see: an
   *     affordance offering to reveal what was never hidden.
   *  2. It is read off the FINAL pass, after the emptiness guard has re-admitted
   *     any waived kind and §31 has re-judged it. A pin the guard put back is
   *     not counted as hidden; one that then lost an overlap is.
   *
   * The remaining gap is the other direction — counting an object that has no
   * marker at all. `entities` is not always built from `pipelineBase`: in
   * Compass mode the picks are the objects while the RESULTS are the entities,
   * re-keyed to bare ids, so a §31 verdict on a pick reaches no marker. The
   * chip promises "zoom in to see them", so an object with nothing to reveal
   * must not be counted. Membership is checked against the full `entities`
   * list, which is precisely "a marker for this object exists".
   *
   * Band drops are deliberately NOT counted. The chip is §31's affordance —
   * "N more nearby", i.e. behind this pin. A kind §17 has not introduced yet is
   * not nearby-and-hidden; it is not part of this altitude's vocabulary.
   */
  const hiddenByCollision = useMemo(() => {
    if (renderResult.collisionDroppedCount === 0) return 0;
    const hasMarker = new Set(entities.map((e) => e.id));
    return renderResult.dropped.filter(
      (d) => d.reason === 'collision' && hasMarker.has(d.object.id),
    ).length;
  }, [renderResult, entities]);

  // ── §8 the selected MapObject, and its §30 overlays ─────────────────────────
  const selectedObject = useMemo(
    () => objects.find((o) => o.id === machine.selection?.objectId) ?? null,
    [objects, machine.selection?.objectId],
  );
  const [whyObject, setWhyObject] = useState<MapObject | null>(null);
  // §25 long-press. A press always has a point under it, so the target is a
  // union: an object when one is under the finger, a bare coordinate otherwise.
  const [longPress, setLongPress] = useState<{
    target: LongPressTarget;
    anchor?: { x: number; y: number };
  } | null>(null);
  const [contributeObject, setContributeObject] = useState<MapObject | null>(null);
  /**
   * §25 `report` on a person or a listing. Held as the OBJECT rather than a
   * boolean so the sheet's subject cannot drift from the thing that was
   * reported when the selection changes underneath it.
   */
  const [reportTarget, setReportTarget] = useState<MapObject | null>(null);
  /** §25 `save` — the subject of the wishlist picker, null when it is closed. */
  const [saveTarget, setSaveTarget] = useState<AddToTripPayload | null>(null);
  const [meetTarget, setMeetTarget] = useState<MeetTarget | null>(null);
  const [meetSurface, setMeetSurface] =
    useState<'action_rail' | 'long_press' | 'place_sheet'>('action_rail');

  // ── §12 Locate My Friends ───────────────────────────────────────────────────
  // The session id is the whole mount condition. It is NOT gated on a feature
  // flag: the panel handles `enabled: false` itself, and its Leave control
  // renders unconditionally — gating the mount would reintroduce exactly the
  // stranding bug the un-gated DELETE route was written to prevent.
  const [locateSessionId, setLocateSessionId] = useState<string | null>(null);
  const [locateStarting, setLocateStarting] = useState(false);
  // §12 "temporary and auto-expiring": the session's lifetime is CHOSEN here,
  // not baked in. Defaults to two hours (the length the old frozen chip used)
  // and every offered option is ≤ the server's 12h cap.
  const [locateTtlMinutes, setLocateTtlMinutes] = useState<number>(
    DEFAULT_LOCATE_FRIENDS_TTL_MINUTES,
  );

  const startLocateFriends = useCallback(
    async (scope: { kind: 'trip' | 'circle' | 'event' | 'plan'; id: string }, ttlMinutes: number) => {
      // Last line of defence before a session is started: a TTL outside the
      // server's [1, 720]-minute window never reaches the API. There is no
      // default here — an unusable value is refused, not silently corrected.
      if (!isTtlWithinBound(ttlMinutes)) return;
      setLocateStarting(true);
      const res = await startLocateFriendsSession({
        groupScopeKind: scope.kind,
        groupScopeId: scope.id,
        // §12 "temporary and auto-expiring" — required, never defaulted here.
        ttlMinutes,
      }).catch(() => null);
      setLocateStarting(false);
      if (!res || !res.ok || !res.data.session) return;

      setLocateSessionId(res.data.session.id);
      // §35 crew_locate_started, with the rung ACTUALLY requested after the
      // purpose ceiling was applied — not the one this screen asked for.
      emitMapEvent('crew_locate_started', {
        crewSize: countBucket(0),
        requestedPrecision: res.data.requestedClass,
        ttl: durationBucketMs(ttlMinutes * 60_000),
        source: machine.mode === 'TRIP' ? 'trip_map' : 'action_rail',
      });
    },
    [machine.mode],
  );
  /**
   * §25 "Create checkpoint" — §12's manual rung, into the live group session.
   *
   * The session id is the whole precondition, and it is the SAME value the menu
   * was gated on (`checkpointScopeId` below): with no session there is nobody
   * the checkpoint could reach, which is why the row is disabled rather than
   * this function guessing at a scope.
   *
   * The label comes from `describeTarget` — the object's own title, or the
   * coarsened coordinate for a press on bare map — so the name the group reads
   * is the name the menu showed the user in its header. What is NOT sent is the
   * pressed point; see `publishManualCheckpoint`.
   *
   * A refusal is reported, not swallowed: the ladder can decline (`stored:
   * false`) and so can the transport, and a checkpoint the group never received
   * must not look like one they did.
   */
  const dropCheckpoint = useCallback(
    async (target: LongPressTarget) => {
      if (!locateSessionId) return;
      const label = describeTarget(target);
      const res = await publishManualCheckpoint({ sessionId: locateSessionId, label }).catch(
        () => null,
      );
      if (!res || !res.ok || !res.data.stored) {
        Alert.alert('Could not drop the checkpoint', 'Please try again.');
        return;
      }
      Alert.alert('Checkpoint dropped', `Your group can see “${label}”.`);
    },
    [locateSessionId],
  );

  /** §35 alternative_requested: which round of "show me something else" this is. */
  const alternativeRoundRef = useRef(0);

  const overlayOpen = (o: 'INTENT' | 'LAYERS' | 'FILTERS' | 'SEARCH') =>
    machine.overlays.includes(o);

  /**
   * §25 action dispatch, shared by the persistent rail and the §8 Live Place
   * sheet.
   *
   * EVERY value in `MAP_ACTIONS` is handled here. That is a deliberate
   * invariant, not a coincidence: the rail draws four fixed slots, but the
   * sheet renders `orderedActions(obj)` — whatever the projection declared —
   * so any action a projection offers and this switch omits becomes a rendered
   * button that silently does nothing when pressed. `default` therefore exists
   * only for a null-ish slug at runtime, never as a resting place for an
   * action someone still has to wire. `mapActionDispatch.component.test.tsx`
   * pins the completeness so the next action added to the union cannot land
   * offered-but-inert.
   *
   * Routes to the SAME flows MapEntityActionRow already uses, rather than
   * reimplementing them — two navigate paths would drift.
   */
  const handleMapAction = useCallback(
    (action: MapAction, obj: MapObject | null) => {
      // The rail renders with nothing selected too, so a null subject is a
      // normal state rather than a bug — the action simply has no object.
      if (!obj) return;
      const c = centroidOf(obj.geometry);
      switch (action) {
        case 'navigate':
          // §30 START_NAVIGATION — §5 gives active navigation standing camera
          // precedence, so the machine enters FOCUS_ROUTE and promotes THIS
          // object's pin (renderResult reads navigation.destinationObjectId).
          // Routing itself is the device's maps app (openInMaps), which has no
          // in-app session to observe; END_NAVIGATION fires when the user
          // returns to Portava (the AppState effect below). routeId must be a
          // non-empty string for the reducer to accept it.
          dispatchMapEvent({
            type: 'START_NAVIGATION',
            routeId: `route:${rawObjectId(obj.id)}`,
            destinationObjectId: obj.id,
          });
          if (c) openInMaps(c.lat, c.lng);
          return;
        case 'contribute':
          setContributeObject(obj);
          return;
        case 'ask_compass':
          dispatchMapEvent({ type: 'ENTER_MODE', mode: 'COMPASS' });
          return;
        case 'view':
          if (obj.interaction?.detailRoute) router.push(obj.interaction.detailRoute as never);
          return;
        case 'meet_here':
          setMeetSurface('action_rail');
          setMeetTarget({ kind: 'object', object: obj });
          return;
        case 'add_to_trip':
          // Opens a flow this screen does not own (the plan picker). Navigating
          // to the detail surface is the honest step; a fake confirmation here
          // would be worse than the handoff.
          if (obj.interaction?.detailRoute) router.push(obj.interaction.detailRoute as never);
          return;
        case 'save':
          // The SAME picker MapEntityActionRow opens, given the same payload
          // shape. Offered by livePlaceModel and clientProjection; until now it
          // fell through `default` and the button did nothing.
          setSaveTarget(savePayloadForObject(obj));
          return;
        case 'share':
          void shareMapObject(obj);
          return;
        case 'join':
          void joinMapObject(obj, compassPickObjects !== null ? 'compass' : 'map');
          return;
        case 'message':
          void messageMapObject(obj);
          return;
        case 'follow':
          void followMapObject(obj);
          return;
        case 'block':
          blockMapObject(obj);
          return;
        case 'book':
          // A buddy pin's booking surface IS its detail route — the same push
          // `MapEntityActionRow`'s Book button makes. Reading it off the object
          // rather than rebuilding `/(rent-a-buddy)/buddy/:id` here keeps one
          // definition of where a buddy lives.
          if (obj.interaction?.detailRoute) router.push(obj.interaction.detailRoute as never);
          return;
        case 'report':
          // TWO different things are called `report`, and routing one into the
          // other's flow is the failure that matters. A CONTRIBUTABLE object
          // means "report what is here" — an observation about a place, which is
          // the contribution sheet, exactly as the long-press menu routes it.
          // Anything else is a MODERATION report about a person or a listing,
          // which is the ReportSheet. A harassment report must never land in a
          // place-observation flow.
          if (obj.interaction?.contributable) {
            setContributeObject(obj);
          } else {
            setReportTarget(obj);
          }
          return;
        case 'create_checkpoint':
          // §12: a checkpoint is a manual position report INTO a group or event
          // map. With no session there is nobody to tell — the long-press menu
          // disables the row with this reason, and the sheet has no disabled
          // state, so it is said here rather than failing silently.
          if (!locateSessionId) {
            Alert.alert('No group map active', 'Join a group or event map to drop a checkpoint.');
            return;
          }
          void dropCheckpoint(objectTarget(obj));
          return;
        default:
          return;
      }
    },
    [dispatchMapEvent, compassPickObjects, locateSessionId, dropCheckpoint],
  );

  /**
   * §25 long-press — the gesture that opens the menu.
   *
   * Until this existed, `longPress` was state with no producer: the menu was
   * mounted, its seven rows resolved correctly, and nothing on the map could
   * ever set a target. The native map is the only thing that can report where a
   * press landed on the ground, so the gesture starts there and `pressTarget`
   * turns the point into §25's union.
   *
   * WHAT IS PRESSABLE IS WHAT §31 SAYS IS DRAWN. `renderResult.kept` is the
   * collision-resolved marker set — the same list this screen already counts
   * `hiddenByCollision` against — and `zoneObjects` is Levels 2-3. Testing the
   * press against anything wider would let a finger land on an object the map
   * decided not to show, which is the §31 truncation problem in reverse.
   *
   * The anchor is the press point in the map view's own pixels. The map fills
   * this screen, so that is the window point the menu opens under; the menu
   * clamps it to the viewport itself, and falls back to centred if it is
   * missing.
   */
  const handleMapLongPress = useCallback(
    (press: { lat: number; lng: number; screenX: number; screenY: number }) => {
      const target = longPressTargetAt(
        { markers: renderResult.kept, areas: zoneObjects },
        { lat: press.lat, lng: press.lng, zoom: activeZoom },
      );
      setLongPress({ target, anchor: { x: press.screenX, y: press.screenY } });
    },
    [renderResult.kept, zoneObjects, activeZoom],
  );

  /** Called when the user taps a marker on the map. */
  const handleSelectEntity = useCallback(
    (entity: MapEntity) => {
      const index = entities.findIndex((e) => e.id === entity.id);
      if (index < 0) return;
      setActiveIndex(index);
      setSelectedEntityId(entity.id);
      // Capture camera position so it survives a detail-screen push.
      setCameraCenter({ lat: entity.lat, lng: entity.lng });
      setCameraZoom(zoomForEntity(entity.type));
      carouselRef.current?.scrollToIndex(index);
    },
    [entities, setActiveIndex, setSelectedEntityId, setCameraCenter, setCameraZoom],
  );

  /**
   * Called when the user taps a venue/place pin in DiscoveryMapView.
   * Converts the DiscoveryPlace to its MapEntity ID and delegates to
   * handleSelectEntity so the carousel scrolls to the matching card.
   */
  const handleSelectPlace = useCallback(
    (place: DiscoveryPlace) => {
      const entityId = `place:${place.id}`;
      const entity = entities.find((e) => e.id === entityId);
      if (entity) handleSelectEntity(entity);
    },
    [entities, handleSelectEntity],
  );

  // ── Back-navigation state restoration / tab-switch stale-selection clear ──
  // useFocusEffect fires every time the screen gains focus — both after a
  // back-nav from a detail screen and after a tab switch.
  //
  // We use pushedToDetailRef to tell these two cases apart:
  //   • true  → the focus came from popping a detail push → restore
  //   • false → the focus came from a tab switch (or first mount) → clear
  //
  // IMPORTANT — empty deps / ref-backed values:
  // React Navigation re-fires useFocusEffect whenever the callback reference
  // changes, even while the screen is already focused.  A non-empty dep array
  // would therefore run the stale-selection clear on every selection change or
  // entity refresh — not just on real tab-switch focus events.  All dynamic
  // values are mirrored into refs so the callback is always the same object.
  const _fe_selectedEntityId = useRef(selectedEntityId);
  _fe_selectedEntityId.current = selectedEntityId;
  const _fe_activeIndex = useRef(activeIndex);
  _fe_activeIndex.current = activeIndex;
  const _fe_entities = useRef(entities);
  _fe_entities.current = entities;
  const _fe_userLat = useRef(userLat);
  _fe_userLat.current = userLat;
  const _fe_userLng = useRef(userLng);
  _fe_userLng.current = userLng;
  const _fe_setSelectedEntityId = useRef(setSelectedEntityId);
  _fe_setSelectedEntityId.current = setSelectedEntityId;
  const _fe_setActiveIndex = useRef(setActiveIndex);
  _fe_setActiveIndex.current = setActiveIndex;
  const _fe_setCompassOverrideEntities = useRef(setCompassOverrideEntities);
  _fe_setCompassOverrideEntities.current = setCompassOverrideEntities;
  const _fe_setCompassQuery = useRef(setCompassQuery);
  _fe_setCompassQuery.current = setCompassQuery;

  useFocusEffect(
    useCallback(() => {
      if (!hasFocusedOnceRef.current) {
        hasFocusedOnceRef.current = true;
        // First mount: entities effect owns proximity selection. The only
        // restoration that can happen here is if selectedEntityId was already
        // set in the store before mount (tests simulate this; production always
        // starts null). Never run the tab-switch clear on first mount.
        if (!_fe_selectedEntityId.current) return;
        carouselRef.current?.scrollToIndex(_fe_activeIndex.current, false);
        return;
      }

      if (pushedToDetailRef.current) {
        // Back-nav: restore the previously selected entity's carousel position.
        pushedToDetailRef.current = false;
        if (!_fe_selectedEntityId.current) return;
        carouselRef.current?.scrollToIndex(_fe_activeIndex.current, false);
      } else {
        // Tab-switch: clear any stale selectedEntityId and Compass search state
        // so the map doesn't open with a ghost highlight or stale search results,
        // then snap the carousel to the proximity-nearest entity.
        _fe_setSelectedEntityId.current(null);
        _fe_setCompassOverrideEntities.current(null);
        _fe_setCompassQuery.current(null);
        const ents = _fe_entities.current;
        if (ents.length === 0) return;
        let bestIndex = 0;
        const lat = _fe_userLat.current;
        const lng = _fe_userLng.current;
        if (lat != null && lng != null) {
          let bestDist = Infinity;
          ents.forEach((e, i) => {
            const d = haversineKm(lat, lng, e.lat, e.lng);
            if (d < bestDist) { bestDist = d; bestIndex = i; }
          });
        }
        _fe_setActiveIndex.current(bestIndex);
        carouselRef.current?.scrollToIndex(bestIndex, false);
      }
    // Empty deps — all dynamic values read through refs above. Keeps the
    // callback stable so useFocusEffect fires ONLY on true navigation focus
    // transitions, never on in-focus dep changes (selection updates, entity refreshes).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  // Web: show static placeholder.
  if (Platform.OS === 'web') {
    return <WebPlaceholder />;
  }

  // Permission denied with no coords at all: show prompt card.
  const permDenied = locationState.permissionStatus === 'denied';
  const hasNoCoords = fallbackLat == null && fallbackLng == null;
  if (permDenied && hasNoCoords) {
    return <PermissionPrompt onRequest={() => requireLocation('map')} />;
  }

  // Permission denied but we have city/destination coords — show an inline banner
  // instead of blocking the map entirely.
  const showCityLocationBanner = permDenied && !hasNoCoords;

  const MapComponent = DiscoveryMapView!;

  return (
    <View style={s.root}>
      {/* Full-screen map — externalCameraRef wires MapTopControls' recenter
          button to the Camera element rendered inside DiscoveryMapView.
          Entity layers (Buddies, Events, Gems, Trips, Friends) are injected
          via entities/enabledEntityLayers props. */}
      <MapComponent
        places={legacyPlaces}
        onSelectPlace={handleSelectPlace}
        fallbackLat={cameraCenter?.lat ?? fallbackLat}
        fallbackLng={cameraCenter?.lng ?? fallbackLng}
        fallbackZoom={cameraZoom ?? paramZoom}
        userLat={userLat}
        userLng={userLng}
        externalCameraRef={cameraRef}
        entities={renderedEntities}
        zoneObjects={zoneObjects}
        enabledEntityLayers={enabledLayers}
        onSelectEntity={handleSelectEntity}
        selectedEntityId={selectedEntityId}
        onCameraChange={handleCameraChange}
        // §30: a user drag/pinch hands the camera to the machine (FREE_EXPLORE).
        // Gated inside DiscoveryMapView on the SDK's userInteraction flag, so a
        // programmatic easeTo (recenter, carousel, focus) never lands here.
        onUserPan={() => dispatchMapEvent({ type: 'USER_PANNED' })}
        filterRowOffset={mapHeaderStackOffset(insets.top) + MAP_FILTER_CHIPS_HEIGHT + 8}
        onLongPressMap={handleMapLongPress}
      />

      {/* ── §3 header: menu · city/area · search · layers ─────────────────── */}
      <MapHeader
        topInset={insets.top}
        city={title}
        onMenuPress={() => router.back()}
        onCityPress={() => dispatchMapEvent({ type: 'OPEN_OVERLAY', overlay: 'SEARCH' })}
        onSearchPress={() => dispatchMapEvent({ type: 'OPEN_OVERLAY', overlay: 'SEARCH' })}
        onLayersPress={() => dispatchMapEvent({ type: 'OPEN_OVERLAY', overlay: 'LAYERS' })}
      />

      {/* ── §3 filter chips: For You · Live · People · Events · Gems ────────
          A transient lens over what the layers already permit — never a way to
          switch a layer back on. */}
      <MapFilterChips
        topInset={mapHeaderStackOffset(insets.top)}
        active={homeFilter}
        counts={chipCounts}
        onSelect={setHomeFilter}
      />

      {/* Floating top controls: Back, Recenter, Filters */}
      <MapTopControls
        cameraRef={cameraRef}
        userLat={userLat != null && Number.isFinite(userLat) ? userLat : null}
        userLng={userLng != null && Number.isFinite(userLng) ? userLng : null}
        fallbackLat={fallbackLat}
        fallbackLng={fallbackLng}
        // The header owns the city name now; showing it twice is noise.
        title={null}
        topInset={mapHeaderStackOffset(insets.top) + MAP_FILTER_CHIPS_HEIGHT}
        onFiltersPress={() => dispatchMapEvent({ type: 'OPEN_OVERLAY', overlay: 'LAYERS' })}
        // §30 RECENTER — return camera control to the machine (FOLLOW_USER).
        // The button's own easeTo does the move; this records the intent.
        onRecenter={() => dispatchMapEvent({ type: 'RECENTER' })}
      />

      {/* §3 floating controls: zoom in/out + orientation reset (compass → N).
          Steps from activeZoom — the camera's REAL zoom — so a tap is one level
          from where the map actually is, not from a stale commanded value. */}
      <MapFloatingControls
        cameraRef={cameraRef}
        zoom={activeZoom}
        bottomInset={insets.bottom + 220}
      />

      {/* Places loading indicator — small spinner overlay while getDiscoveryPlaces
          is in-flight.  Rendered over the map (not in the carousel) so the user
          sees immediate feedback even before the carousel area appears. */}
      {legacyPlacesActive && placesLoading ? (
        <View style={s.placesLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : null}

      {/* Bottom carousel — floats above the AskCompassBar; z-index below MapTopControls */}
      <MapCarousel
        ref={carouselRef}
        entities={entities}
        // §35: the carousel cannot infer this. A decisionId stays live across
        // the whole accept -> route -> arrive -> contribute loop, so "a decision
        // is open" is not the same claim as "these cards are that decision's
        // options".
        compassResults={compassOverrideEntities !== null}
        activeIndex={activeIndex}
        onIndexChange={handleCarouselIndexChange}
        onFiltersPress={() => setFilterSheetOpen(true)}
        onBeforeNavigate={() => { pushedToDetailRef.current = true; }}
        passportLoading={mode === 'passport' ? passportLoading : undefined}
        passportError={mode === 'passport' ? passportError : undefined}
        onPassportRetry={mode === 'passport' ? handlePassportRetry : undefined}
        placesLoading={legacyPlacesActive ? placesLoading : undefined}
        placesError={legacyPlacesActive ? placesError : undefined}
        placesEmpty={legacyPlacesActive ? placesEmpty : undefined}
        onPlacesRetry={legacyPlacesActive ? handlePlacesRetry : undefined}
        style={[
          s.carousel,
          { bottom: insets.bottom + 16 },
        ]}
      />

      {/* City-location banner — shown when location permission is denied but
          city/destination coords are available so the map still renders. */}
      {showCityLocationBanner ? (
        <View style={s.cityBanner} pointerEvents="none">
          <AlertTriangle size={12} color="#fff" />
          <Text style={s.cityBannerText}>
            Using city location — enable location for better results
          </Text>
        </View>
      ) : null}

      {/* Passport mode banner */}
      {mode === 'passport' ? (
        <View style={s.modeBanner} pointerEvents="none">
          <Text style={s.modeBannerText}>🗺 Passport map · your travel stamps</Text>
        </View>
      ) : mode === 'circle' ? (
        <View style={s.modeBanner} pointerEvents="none">
          <Text style={s.modeBannerText}>👥 Circle map · friends nearby</Text>
        </View>
      ) : null}

      {/* ── AskCompassBar + active filter label — floating bottom overlay ──
          Only rendered when the map_search_enabled feature flag is on.
          If the flag is off (or unknown / fetch failed), the bar is hidden. */}
      {isFlagEnabled('map_search_enabled') && (
        <View style={s.bottomOverlay} pointerEvents="box-none">
          {/* Active Compass filter label — shown while a query is active */}
          {compassQuery ? (
            <View style={s.filterLabel}>
              <Text style={s.filterLabelText} numberOfLines={1}>
                Showing: {compassQuery}
              </Text>
              <Pressable
                style={s.filterClearBtn}
                onPress={handleCompassClear}
                hitSlop={8}
              >
                <XIcon size={12} color="#fff" />
              </Pressable>
            </View>
          ) : null}

          {/* §13 Intent entry — "tell Portava what you want right now".
              Shows the active intent's label so a live TTL is visible rather
              than silently expiring behind a generic button. */}
          <Pressable
            style={s2.intentChip}
            onPress={() => dispatchMapEvent({ type: 'OPEN_OVERLAY', overlay: 'INTENT' })}
            accessibilityRole="button"
            accessibilityLabel="Set what you want right now"
          >
            <Text style={s2.intentChipText} numberOfLines={1}>
              {activeIntent(intent) ? `Intent: ${activeIntent(intent)!.kind}` : 'What do you want right now?'}
            </Text>
          </Pressable>

          {/* Ask Compass search bar */}
          <AskCompassBar
            city={title ?? ''}
            userLat={userLat}
            userLng={userLng}
            bottomInset={insets.bottom}
            onResults={handleCompassResults}
            onClear={handleCompassClear}
          />
        </View>
      )}

      {/* ── §3 / §26 Live Pulse card ────────────────────────────────────────
          Pulse and Map are two presentations of the SAME intelligence (§26), so
          the tap goes through pulseItemToMapState — the one translation both
          surfaces use — rather than this screen inventing its own routing.
          Hidden while a Compass query or a selection already owns the bottom
          of the screen; §3 says cards must not permanently consume the viewport. */}
      {pulseItems.length > 0 && !compassQuery && !selectedObject ? (
        <LivePulseCard
          items={pulseItems}
          bottomInset={insets.bottom + 96}
          onDeepLink={(deepLink) => {
            if (deepLink.mode) dispatchMapEvent({ type: 'ENTER_MODE', mode: deepLink.mode });
            if (deepLink.selectedObjectId) {
              dispatchMapEvent({
                type: 'SELECT_OBJECT',
                objectId: deepLink.selectedObjectId,
                objectKind: 'place',
              });
            }
            const target = deepLink.cameraTarget;
            const cam = cameraRef.current;
            if (target?.center && cam && typeof cam.easeTo === 'function') {
              cam.easeTo({
                center: [target.center.lng, target.center.lat],
                zoom: target.zoom ?? 14,
                duration: 600,
              });
            }
          }}
          onDismiss={(item) => setPulseItems((prev) => prev.filter((i) => i.id !== item.id))}
        />
      ) : null}

      {/* ── §28 cached-intelligence banner ──────────────────────────────────
          "Clearly label stale cached intelligence with last-updated time."
          rehydrate() has already downgraded each object's freshness, so nothing
          on screen is claiming to be live — this says WHY it looks quiet. */}
      {staleness ? (
        <View style={[s2.cacheBanner, { top: insets.top + 116 }]} pointerEvents="none">
          <Text style={s2.cacheBannerText}>{staleness.label} · showing saved data</Text>
        </View>
      ) : null}

      {/* ── §31 "N more" ────────────────────────────────────────────────────
          Objects hidden by collision. Rendered because the alternative is a
          silent truncation: the user sees a sparse map and has no way to know
          anything was withheld, which reads as "there is nothing here". */}
      {hiddenByCollision > 0 ? (
        <Pressable
          style={[s2.moreChip, { bottom: insets.bottom + 200 }]}
          onPress={() => {
            // easeTo is the v11 replacement for setCamera; guard its existence
            // so a future API change fails soft rather than throwing.
            //
            // Steps up from `activeZoom` — the camera's REAL zoom — not from
            // the store's commanded one. This chip's whole promise is "zoom in
            // to see them", and off the stale value a user already pinched to
            // 16 would be eased to 12.5: a zoom OUT that hides more, not less.
            const cam = cameraRef.current;
            const lat = liveCamera?.lat ?? cameraCenter?.lat ?? fallbackLat;
            const lng = liveCamera?.lng ?? cameraCenter?.lng ?? fallbackLng;
            if (cam && typeof cam.easeTo === 'function' && lat != null && lng != null) {
              cam.easeTo({
                center: [lng, lat],
                zoom: Math.min(activeZoom + 1.5, 18),
                duration: 400,
              });
            }
          }}
          accessibilityRole="button"
          accessibilityLabel={`${hiddenByCollision} more nearby — zoom in to see them`}
        >
          <Text style={s2.moreChipText}>+{hiddenByCollision} more nearby</Text>
        </Pressable>
      ) : null}

      {/* ── §15 Time Machine scrubber ──────────────────────────────────────
          Floating above the carousel. Rendered only when the surface is
          actually enabled — canEnterMode fails closed, so an unbuilt surface
          is unreachable rather than half-present. */}
      {machine.capabilities.TIME_MACHINE ? (
        <TimeMachineControl
          offset={timeOffset}
          onChange={setTimeOffset}
          timeline={temporalView.timeline}
          forecastConfidence={temporalView.forecastConfidence}
          bottomInset={insets.bottom + 140}
        />
      ) : null}

      {/* ── §25 persistent action rail ──────────────────────────────────────
          Ask Compass · Meet Here · Add to Trip · Navigate. Actions are driven
          by the selected object's own interaction config; the rail keeps four
          slots so it never reflows. */}
      {selectedObject ? (
        <MapBottomActions
          selected={selectedObject}
          bottomInset={insets.bottom}
          onAction={handleMapAction}
        />
      ) : null}

      {/* ── §8 Live Place sheet ─────────────────────────────────────────────
          Replaces the legacy preview card for objects whose contract says they
          open a sheet. The map stays visible behind Peek and Half (§32). */}
      {selectedObject?.interaction?.opensSheet ? (
        <LivePlaceSheet
          object={selectedObject}
          openSource={compassPickObjects !== null ? 'compass_pick' : 'marker'}
          onAction={handleMapAction}
          onClose={() => dispatchMapEvent({ type: 'CLEAR_SELECTION' })}
          onWhyPress={(obj) => {
            setWhyObject(obj);
            emitMapEvent('why_shown_opened', {
              ref: describeMapObject(obj),
              lineCount: obj.provenance?.lines.length ?? 0,
              provenanceRefs: obj.sourceRefs,
            });
          }}
          onContribute={setContributeObject}
        />
      ) : null}

      {/* ── §9 "Why Portava says this" ──────────────────────────────────── */}
      <WhyShownSheet
        visible={whyObject !== null}
        object={whyObject}
        onClose={() => setWhyObject(null)}
      />

      {/* ── §22 one-tap contribution ────────────────────────────────────────
          An observation, never a rating — and a reward may never raise
          confidence (§22, §37).

          The sheet owns the submission (see its header): a photo attaches to an
          observation that already exists, so the act is two calls in §21's
          order and only the sheet can show the contributor how both landed.
          `onSubmit` is telemetry, and must not post again. */}
      <MapContributionSheet
        visible={contributeObject !== null}
        object={contributeObject}
        onClose={() => setContributeObject(null)}
        onRequestMedia={requestContributionMedia}
        onSubmit={(contribution) => {
          if (!contributeObject) return;
          emitMapEvent('contribution_submitted', {
            ref: describeMapObject(contributeObject),
            contributionKind: contribution.kind,
            prompt: 'sheet',
          });
        }}
      />

      {/* ── §25 Report ──────────────────────────────────────────────────────
          The moderation sheet MapEntityActionRow already opens, reached from
          the §8 sheet as well as the carousel card. `subjectType` decides which
          queue it lands in, so it is derived from the object's kind rather than
          defaulted — a circle member is a USER and a buddy pin is a LISTING. */}
      <ReportSheet
        visible={reportTarget !== null}
        subjectType={reportTarget ? moderationSubjectOf(reportTarget) : 'post'}
        subjectId={reportTarget ? rawObjectId(reportTarget.id) : ''}
        subjectUserId={reportTarget ? personUserId(reportTarget) : null}
        subjectName={reportTarget ? reportTarget.title : null}
        onClose={() => setReportTarget(null)}
      />

      {/* ── §25 Save ────────────────────────────────────────────────────────
          The picker MapEntityActionRow already opens, reached from the rail and
          the §8 sheet as well as the carousel card. One implementation, one
          storage path — a second "save" would be a second source of truth for
          what the user has saved. */}
      <TripWishlistPicker
        visible={saveTarget !== null}
        place={saveTarget}
        onClose={() => setSaveTarget(null)}
      />

      {/* ── §11 Optimize Today ──────────────────────────────────────────────
          A PROPOSAL, never a rewrite. Acceptance persists through the Trips
          write path (persistOptimizeAcceptance → owner-only batch reorder), so
          the accepted order is durable — not a local-only shuffle. §11: "the
          map should not silently rewrite the canonical Trip." */}
      {tripId && tripStops.length > 1 ? (
        <Pressable
          style={[s2.optimizeChip, { bottom: insets.bottom + 240 }]}
          onPress={() =>
            setProposal(
              optimizeToday(tripStops, {
                now: new Date().toISOString(),
                lodging: composedTrip?.source.lodging ?? null,
                // §11 saved-ideas factor: an idea barely off the route may be
                // proposed as an addition (the sheet shows it; the user accepts).
                savedIdeas: composedTrip?.source.savedIdeas,
                maxSavedIdeaInsertions: 1,
              }),
            )
          }
          accessibilityRole="button"
          accessibilityLabel="Optimize today's plan"
        >
          <Text style={s2.optimizeChipText}>Optimize today</Text>
        </Pressable>
      ) : null}

      <OptimizeTodaySheet
        proposal={proposal}
        onClose={() => setProposal(null)}
        onDismiss={(p) => {
          // Returns the CURRENT ordering — the canonical plan stands.
          dismissProposal(p, new Date().toISOString());
          setProposal(null);
        }}
        onAccept={(p) => {
          const activeTripId = tripId;
          if (!activeTripId) { setProposal(null); return; }
          // Append accepted ideas after the existing stops rather than at
          // sort_order 0 — the batch reorder then places them by the plan.
          let appendOrder =
            (composedTrip?.source.stops ?? []).reduce((m, st) => Math.max(m, st.orderIndex), -1) + 1;
          void (async () => {
            const result = await persistOptimizeAcceptance(p, new Date().toISOString(), {
              // Owner-only batch reorder — the durable Trips write (§20).
              reorder: (ids) => reorderPlanItems(activeTripId, ids),
              // An accepted saved-idea insertion becomes a real plan item via
              // the canonical create path, not a fabricated stop.
              addSavedIdea: async (idea) => {
                const item = await createPlanItem(activeTripId, {
                  title: idea.title,
                  category: 'activity',
                  sourceType: idea.savedIdeaId ? 'place' : 'manual',
                  ...(idea.savedIdeaId ? { sourceId: idea.savedIdeaId } : {}),
                  lat: idea.lat,
                  lng: idea.lng,
                  ...(idea.subtitle ? { locationName: idea.subtitle } : {}),
                  sortOrder: appendOrder++,
                });
                return item.id;
              },
            });
            if (result.persisted) {
              // Durable — re-read the trip so the map reflects the saved order
              // and any added ideas from the canonical source of truth.
              const refreshed = await buildComposedTrip();
              setComposedTrip(refreshed);
            } else {
              // The write did not land: reflect the accepted order locally so
              // the map still shows it, WITHOUT claiming it was saved.
              setComposedTrip((prev) => {
                if (!prev) return prev;
                const byId = new Map((prev.source.stops ?? []).map((st) => [st.id, st]));
                const reordered = result.orderedStopIds
                  .map((id) => byId.get(id))
                  .filter((st): st is TripStop => st != null);
                const rest = (prev.source.stops ?? []).filter(
                  (st) => !result.orderedStopIds.includes(st.id),
                );
                return { ...prev, source: { ...prev.source, stops: [...reordered, ...rest] } };
              });
            }
            setProposal(null);
          })();
        }}
      />

      {/* ── §25 long-press menu ─────────────────────────────────────────────
          Seven actions, always all seven, disabled-with-reason rather than
          hidden so the menu cannot reflow between targets. */}
      <MapLongPressMenu
        target={longPress?.target ?? null}
        visible={longPress != null}
        anchor={longPress?.anchor}
        context={{
          checkpointScopeId: locateSessionId,
          // §25 "Share permitted location" opens onto the active §12 session —
          // the bounded, expiring, revocable channel. Same value as the
          // checkpoint scope: with no live session, neither row has anywhere to go.
          shareChannelSessionId: locateSessionId,
          now: Date.now(),
        }}
        onClose={() => setLongPress(null)}
        onSelect={(action, target) => {
          setLongPress(null);
          if (action === 'report' && target.kind === 'object') {
            setContributeObject(target.object);
            return;
          }
          if (action === 'meet_here') {
            // A long-press can land on empty map, so the target is a union —
            // proposeMeetHere decides whether it can anchor a meeting at all.
            setMeetSurface('long_press');
            setMeetTarget(
              target.kind === 'object'
                ? { kind: 'object', object: target.object }
                : { kind: 'coordinate', lat: target.lat, lng: target.lng },
            );
            return;
          }
          if (action === 'ask_compass') {
            const pt = coordinateOf(target);
            if (pt) void geocodeAndFly(`${pt.lat.toFixed(3)},${pt.lng.toFixed(3)}`);
            return;
          }
          if (action === 'create_checkpoint') {
            void dropCheckpoint(target);
            return;
          }
          // §25 "Share permitted location" opens a bounded, expiring share on
          // the live §12 session — NEVER §8's permanent link (`shareMapObject` /
          // `Share.share`). The bound is recomputed with `resolveShareBound` so
          // the publish is capped on the same numbers the menu was gated on. The
          // menu only enabled this row when a session channel exists, so a null
          // session here would be a contradiction — but it is still checked, and
          // a refusal is reported rather than faked as a success.
          if (action === 'share') {
            const bound = resolveShareBound(target, {
              shareChannelSessionId: locateSessionId,
              now: Date.now(),
            });
            const pt = coordinateOf(target);
            if (!bound || !pt || !locateSessionId) return;
            void sharePermittedLocation({ sessionId: locateSessionId, point: pt, bound })
              .then((res) => {
                if (res.ok && res.data.stored) {
                  Alert.alert(
                    'Location shared with your group',
                    'They can see it until the session ends. Leave the session to stop sharing.',
                  );
                } else {
                  Alert.alert('Could not share your location', 'Please try again.');
                }
              })
              .catch(() => {
                Alert.alert('Could not share your location', 'Please try again.');
              });
            return;
          }
          // `save` and `add_to_trip` reach the flows the rail already owns —
          // the wishlist picker and the detail-surface handoff — rather than a
          // second copy of either. Both need a place record, so the menu
          // disables them for a bare coordinate and only an object gets here.
          if (target.kind === 'object') handleMapAction(action, target.object);
        }}
      />

      {/* ── §12 Locate My Friends ───────────────────────────────────────────
          Mounted on the session id alone. The panel owns its own read and
          publish polls and tears both down with its effect, so a closed screen
          cannot keep publishing someone's position. */}
      {locateSessionId && userId ? (
        <LocateFriendsPanel
          live={{ sessionId: locateSessionId, viewerMemberId: userId }}
          onLeave={() => setLocateSessionId(null)}
          onEndSession={() => setLocateSessionId(null)}
        />
      ) : machine.mode === 'LOCATE_FRIENDS' && tripId ? (
        // §12: the session's bounded lifetime is CHOSEN here rather than baked
        // in. The chips pick a duration (every one ≤ the server's 12h cap); the
        // Start control opens the session with the chosen TTL — required and
        // never defaulted on the wire, so the consent stamp on the membership
        // row is always a stamp on a bounded session.
        <View style={[s2.ttlChooser, { bottom: insets.bottom + 200 }]}>
          <Text style={s2.ttlChooserTitle}>Locate my friends · for how long?</Text>
          <View style={s2.ttlChooserRow}>
            {LOCATE_FRIENDS_TTL_OPTIONS.map((opt) => {
              const selected = opt.minutes === locateTtlMinutes;
              return (
                <Pressable
                  key={opt.minutes}
                  style={[s2.ttlChip, selected && s2.ttlChipSelected]}
                  disabled={locateStarting}
                  onPress={() => setLocateTtlMinutes(opt.minutes)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={opt.accessibilityLabel}
                >
                  <Text style={[s2.ttlChipText, selected && s2.ttlChipTextSelected]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            style={[s2.optimizeChip, s2.ttlStart]}
            disabled={locateStarting}
            onPress={() => void startLocateFriends({ kind: 'trip', id: tripId }, locateTtlMinutes)}
            accessibilityRole="button"
            accessibilityLabel="Start locating friends"
          >
            <Text style={s2.optimizeChipText}>
              {locateStarting ? 'Starting…' : 'Start'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {/* ── §25 Meet Here ───────────────────────────────────────────────────
          The rung the meeting point publishes at is decided by the model from
          the subject, never requested here. An aggregate subject is refused
          with its reason shown rather than silently doing nothing. */}
      <MeetHereSheet
        target={meetTarget}
        surface={meetSurface}
        onClose={() => setMeetTarget(null)}
        onRefused={(info) => {
          const subject =
            meetTarget?.kind === 'object' ? describeMapObject(meetTarget.object) : null;
          // Only an object can be refused — a user's own dropped pin always
          // qualifies — so a null subject here would be a contradiction.
          if (subject) {
            emitMapEvent('meet_here_refused', {
              ref: subject,
              reason: info.reason,
              surface: info.surface,
            });
          }
        }}
        onCreated={(info) => {
          const subject =
            meetTarget?.kind === 'object' ? describeMapObject(meetTarget.object) : null;
          if (subject) {
            emitMapEvent('meet_here_created', {
              ref: subject,
              audience: info.audience,
              invitees: countBucket(info.inviteeCount),
              // The rung it ACTUALLY published at, not the one asked for.
              sharedAs: info.sharedAs,
            });
          }
        }}
      />

      {/* ── §14 "show me something else" ────────────────────────────────────
          The affordance §35's alternative_requested measures. Re-asks Compass
          within the SAME decision, incrementing the round, so a user who
          rejects three suggestions is one decision with three rounds rather
          than three unrelated asks. */}
      {compassQuery && compassPickObjects ? (
        <Pressable
          style={[s2.altChip, { bottom: insets.bottom + 168 }]}
          onPress={() => {
            alternativeRoundRef.current += 1;
            emitMapEvent('alternative_requested', {
              reason: 'not_interested',
              round: alternativeRoundRef.current,
            });
            void geocodeAndFly(compassQuery);
          }}
          accessibilityRole="button"
          accessibilityLabel="Show me something else"
        >
          <Text style={s2.altChipText}>Show me something else</Text>
        </Pressable>
      ) : null}

      {/* ── §27 Search ──────────────────────────────────────────────────────
          "Geographic results should center or frame the relevant map object."
          A result with no geometry yields frame.kind === 'none', and the camera
          deliberately does NOT move — it navigates instead. Flying somewhere
          confident and wrong is the failure this avoids. */}
      <MapSearchSheet
        visible={overlayOpen('SEARCH')}
        onClose={() => dispatchMapEvent({ type: 'CLOSE_OVERLAY', overlay: 'SEARCH' })}
        lat={userLat ?? fallbackLat}
        lng={userLng ?? fallbackLng}
        city={title}
        onSelect={(result, frame) => {
          dispatchMapEvent({ type: 'CLOSE_OVERLAY', overlay: 'SEARCH' });
          const cam = cameraRef.current;
          if (frame.kind === 'none') {
            // No geometry: honour the detail route rather than moving the map.
            if (result.detailRoute) router.push(result.detailRoute as never);
            return;
          }
          if (!cam || typeof cam.easeTo !== 'function') return;
          if (frame.kind === 'center') {
            cam.easeTo({
              center: [frame.center.lng, frame.center.lat],
              zoom: frame.zoom,
              duration: 600,
            });
          } else {
            // An Area FRAMES its bounds rather than centring on a centroid.
            // v11 takes a single [west, south, east, north] tuple; frameFor has
            // already applied its own fractional padding around the subject.
            cam.fitBounds?.(
              [frame.bounds.west, frame.bounds.south, frame.bounds.east, frame.bounds.north],
              { duration: 600 },
            );
          }
        }}
      />

      {/* ── §13 Intent Mode ─────────────────────────────────────────────────
          Temporary context with a TTL — never a preference rewrite. */}
      <IntentSheet
        visible={overlayOpen('INTENT')}
        intent={activeIntent(intent)}
        onChange={setIntent}
        onClear={clearIntent}
        onClose={() => dispatchMapEvent({ type: 'CLOSE_OVERLAY', overlay: 'INTENT' })}
        bottomInset={insets.bottom}
      />

      {/* ── §16 Layers + legend ─────────────────────────────────────────────
          The tri-state sheet over MapObject kinds. The legacy MapFilterSheet
          below still drives the old MapEntity layer set; they use different
          storage keys and coexist until the projection path is the only one. */}
      <LayersSheet
        visible={overlayOpen('LAYERS')}
        onClose={() => dispatchMapEvent({ type: 'CLOSE_OVERLAY', overlay: 'LAYERS' })}
        preferences={layerPrefs}
        onChangePreferences={setLayerPrefs}
        context={layerContext}
      />

      {/* Layer filter bottom sheet */}
      <MapFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        enabledLayers={enabledLayers}
        onChangeEnabledLayers={setEnabledLayers}
      />
    </View>
  );
}

/** Styles for the surfaces added by the Map spec integration. */
const s2 = StyleSheet.create({
  intentChip: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(10,61,74,0.92)',
  },
  intentChipText: {
    color: '#FAF9F6',
    fontSize: 13,
    fontWeight: '600',
  },
  moreChip: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(14,18,22,0.92)',
  },
  moreChipText: {
    color: '#FAF9F6',
    fontSize: 12,
    fontWeight: '600',
  },
  altChip: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(23,28,34,0.94)',
  },
  altChipText: {
    color: '#FAF9F6',
    fontSize: 13,
    fontWeight: '600',
  },
  cacheBanner: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(14,18,22,0.88)',
  },
  optimizeChip: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(10,61,74,0.94)',
  },
  optimizeChipText: {
    color: '#FAF9F6',
    fontSize: 13,
    fontWeight: '700',
  },
  ttlChooser: {
    position: 'absolute',
    alignSelf: 'center',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(11,16,23,0.94)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(250,249,246,0.14)',
  },
  ttlChooserTitle: {
    color: '#FAF9F6',
    fontSize: 12,
    fontWeight: '700',
  },
  ttlChooserRow: {
    flexDirection: 'row',
    gap: 6,
  },
  ttlChip: {
    minWidth: 44,
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(19,26,36,0.96)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(250,249,246,0.14)',
  },
  ttlChipSelected: {
    backgroundColor: 'rgba(10,61,74,0.96)',
    borderColor: 'rgba(84,183,209,0.85)',
  },
  ttlChipText: {
    color: 'rgba(250,249,246,0.72)',
    fontSize: 13,
    fontWeight: '700',
  },
  ttlChipTextSelected: {
    color: '#FAF9F6',
  },
  ttlStart: {
    position: 'relative',
    bottom: undefined,
    marginTop: 2,
  },
  cacheBannerText: {
    color: 'rgba(250,249,246,0.72)',
    fontSize: 11,
    fontWeight: '600',
  },
});

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#13213A',
  },
  // Bottom carousel strip — floats above safe area, below top controls.
  carousel: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 10,
  },
  // Floating bottom overlay — stacked above the map, transparent background
  // so the map is visible through the gaps between the bar and chips.
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    gap: space.xs,
    paddingBottom: space.sm,
  },
  // City-location banner — shown when location denied but city coords available
  cityBanner: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingVertical: 6,
    paddingHorizontal: space.md,
    zIndex: 15,
  },
  cityBannerText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '500',
  },
  // Mode context banner (passport / circle)
  modeBanner: {
    position: 'absolute',
    alignSelf: 'center',
    top: 52,
    zIndex: 15,
    backgroundColor: 'rgba(10,61,74,0.82)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  modeBannerText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  // Places loading indicator — small spinner centered over the map
  placesLoadingOverlay: {
    position: 'absolute',
    top: '50%' as any,
    alignSelf: 'center',
    zIndex: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  // Active filter label chip
  filterLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    backgroundColor: 'rgba(10,61,74,0.92)',
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    gap: space.xs,
    marginBottom: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  filterLabelText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    maxWidth: 260,
  },
  filterClearBtn: {
    width: icon.s18, height: icon.s18,
    borderRadius: icon.s18 / 2,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
