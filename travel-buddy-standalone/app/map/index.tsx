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
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useFocusEffect } from 'expo-router';
import { router } from 'expo-router';
import { AlertTriangle } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, X as XIcon } from 'lucide-react-native';
import { color, space, radius, type as t, icon, avatar } from '../../src/theme/tokens.ts';
import { MapTopControls } from '../../src/components/map/MapTopControls.tsx';
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
import { TOGGLEABLE_LAYERS } from '../../src/types/mapTypes.ts';
import { MapCarousel } from '../../src/components/map/MapCarousel.tsx';
import type { MapCarouselRef } from '../../src/components/map/MapCarousel.tsx';
import { MapStoreProvider, useMapStore } from '../../src/stores/mapStore.tsx';
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
  acceptProposal,
  dismissProposal,
  type TripStop,
  type OptimizeProposal,
} from '../../src/features/map/trip/tripMapModel.ts';
import { fetchTripPlanMap } from '../../src/services/tripPlan.ts';
import { submitMapObservation } from '../../src/services/mapObservations.ts';
import { MapSearchSheet } from '../../src/components/map/MapSearchSheet.tsx';
import { MapLongPressMenu } from '../../src/components/map/MapLongPressMenu.tsx';
import {
  coordinateTarget,
  objectTarget,
  coordinateOf,
  type LongPressTarget,
} from '../../src/features/map/interaction/longPress.ts';
import { TimeMachineControl } from '../../src/components/map/TimeMachineControl.tsx';
import {
  EMPTY_LAYER_PREFERENCES,
  DEFAULT_LAYER_CONTEXT,
  type LayerPreferences,
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
import type { MapObject } from '../../src/types/mapObjects.ts';
import {
  prepareForRender,
  zoomRenderBand,
  isKindVisibleAtBand,
} from '../../src/features/map/render/collision.ts';
import { filterByLayers } from '../../src/features/map/layers/layerModel.ts';
import { isZoneKind } from '../../src/features/map/render/zoneStyle.ts';
import {
  selectCompassPicks,
  toMapObjects as compassPicksToMapObjects,
  type CompassMapCandidate,
} from '../../src/features/map/compass/compassMapModel.ts';
import { toTemporalObjects } from '../../src/features/map/time/timeMachine.ts';
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
  const mode = Array.isArray(params.mode) ? params.mode[0] : (params.mode ?? null);

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
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const params = useLocalSearchParams<{
    entityTypes?: string;
    lat?: string;
    lng?: string;
    zoom?: string;
    title?: string;
    category?: string;
    focusId?: string;
    mode?: string;
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
  const title = Array.isArray(params.title) ? params.title[0] : (params.title ?? null);
  const entityTypes = Array.isArray(params.entityTypes) ? params.entityTypes[0] : (params.entityTypes ?? '');
  const category = parseCategory(params.category);
  /** focusId: if set, carousel + camera will snap to the matching entity on first load. */
  const focusId = Array.isArray(params.focusId) ? params.focusId[0] : (params.focusId ?? null);
  /** mode: 'passport' | 'circle' | undefined — controls layer presets and UI. */
  const mode = Array.isArray(params.mode) ? params.mode[0] : (params.mode ?? null);

  // Resolved camera position: prefer explicit params, then fall back through the
  // full 3-tier cascade (GPS → last-known session → profile home) via resolvedLocation.
  const fallbackLat = paramLat ?? (resolvedLocation.coords?.lat ?? null);
  const fallbackLng = paramLng ?? (resolvedLocation.coords?.lng ?? null);
  // userLat/userLng = actual live GPS position (for proximity sorting only).
  const userLat = locationState.coords?.lat ?? null;
  const userLng = locationState.coords?.lng ?? null;

  // ── Discovery places ───────────────────────────────────────────────────────
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

  // Zero-results state: fetch completed, no error, but the list is empty.
  // placesFetchedRef guards against the initial false-positive before the
  // first fetch settles (setPlacesLoading(false) triggers the re-render that
  // reads this ref, so it is always current when evaluated).
  const placesEmpty =
    placesLayerActive && placesFetchedRef.current && !placesLoading && !placesError && places.length === 0;

  useEffect(() => {
    if (!placesLayerActive) return;

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destination, category, entityTypes, paramLat, paramLng, userLat, userLng, placesRetryCount]);

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
  // passportEntities — React hooks cannot be called conditionally.
  const {
    entities: defaultEntities,
    objects: defaultObjects,
    liveEnrichment,
    staleness,
  } = useMapEntities({
    enabledLayers: mode === 'passport' ? [] : enabledLayers,
    city: mode === 'passport' ? null : title,
    lat: fallbackLat,
    lng: fallbackLng,
    zoom: cameraZoom ?? paramZoom,
  });

  // ── §11 Trip Map ────────────────────────────────────────────────────────────
  // "Trip Map renders the current Trip geographically without duplicating or
  // replacing Trip ownership." The itinerary is read, never written: the plan
  // stays canonical in Trips (§20), and Optimize Today produces a PROPOSAL the
  // user must accept.
  //
  // WHAT IS DELIBERATELY ABSENT. §11 also names crew, meeting points, routes,
  // saved ideas and Safe Return context. Crew cannot be projected: getCrewMap
  // returns CrewMemberCard, which carries an AREA LABEL and no coordinates —
  // the server declines to give the client crew positions, and inventing them
  // from the area label would be exactly the §23 violation that design prevents.
  // The others have no reachable source on this screen today. They are left out
  // rather than faked; tripToMapObjects omits any section it is not given.
  const tripId = Array.isArray(params.tripId) ? params.tripId[0] : (params.tripId ?? null);
  const [tripStops, setTripStops] = useState<TripStop[]>([]);
  const [proposal, setProposal] = useState<OptimizeProposal | null>(null);

  useEffect(() => {
    if (!tripId) return;
    let cancelled = false;
    void (async () => {
      const items = await fetchTripPlanMap(tripId).catch(() => []);
      if (cancelled) return;
      const stops: TripStop[] = items
        .filter((i) => i.lat != null && i.lng != null && !i.locationIsPrivate)
        .map((i) => ({
          id: i.id,
          title: i.title,
          subtitle: i.locationName ?? undefined,
          lat: i.lat as number,
          lng: i.lng as number,
          // The CANONICAL ordering. tripMapModel never renumbers it — a
          // proposal reorders the array, not these values.
          orderIndex: i.sortOrder,
          // 'fixed' is the hard anchor the optimizer may not move; 'flexible'
          // and 'optional' are both revisable, so neither becomes a reservation.
          reservationAt: i.lockType === 'fixed' ? i.startsAt : null,
          eventStartsAt: i.startsAt,
          eventEndsAt: i.endsAt,
          plannedArrivalTime: i.startsAt,
        }));
      setTripStops(stops);
    })();
    return () => { cancelled = true; };
  }, [tripId]);

  const tripObjects = useMemo(
    () =>
      tripId && tripStops.length > 0
        ? (tripToMapObjects({ tripId, stops: tripStops }, { now: new Date().toISOString() }) as MapObject[])
        : null,
    [tripId, tripStops],
  );

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

  // ── §16 layer preferences (tri-state; separate from the legacy boolean set) ──
  const [layerPrefs, setLayerPrefs] = useState<LayerPreferences>(EMPTY_LAYER_PREFERENCES);
  useEffect(() => {
    loadLayerPreferences().then(setLayerPrefs).catch(() => {});
  }, []);

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
      entry: mode ?? 'direct',
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
      const obj = (e.payload as MapObject | undefined) ?? undefined;
      return {
        id: e.id.includes(':') ? e.id.slice(e.id.indexOf(':') + 1) : e.id,
        title: obj?.title ?? String((e.payload as any)?.title ?? 'Suggestion'),
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
      places
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
    [places],
  );

  // The active entity list.  Priority order:
  //   1. Compass override (active search result)
  //   2. Passport entities when mode=passport
  //   3. Default hook-sourced entities + place entities
  const entities = compassOverrideEntities ?? (
    mode === 'passport' ? passportEntities : [...defaultEntities, ...placeEntities]
  );

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

  const layerContext = useMemo(
    () => ({ ...DEFAULT_LAYER_CONTEXT, mode: machine.mode }),
    [machine.mode],
  );

  // ── §17 / §31 render pipeline ───────────────────────────────────────────────
  // Order matters and follows §19: layers decide what MAY be drawn, the zoom
  // band decides what is legible at this scale, Time Machine coerces forecasts
  // so they cannot look like observations, and only then does §31 collision
  // decide what actually fits.
  const activeZoom = cameraZoom ?? paramZoom;
  const zoomBand = zoomRenderBand(activeZoom);

  const objects: MapObject[] = useMemo(() => {
    // §14 — while a Compass query is active the map shows the picks and nothing
    // else. That IS the mode: "reduces visual noise and highlights approximately
    // three to five best next moves".
    const base = compassPickObjects ?? (tripObjects ?? defaultObjects);
    // 1. §16 layers, then §3's chip. homeVisibleObjects composes them in that
    //    order so a chip can only ever narrow what the layers already permit —
    //    a chip must never switch a layer back on.
    const permitted = homeVisibleObjects(base, homeFilter, layerPrefs, layerContext);
    // 2. §17 — no POI pins at world zoom; individual places only from district in.
    const legible = permitted.filter((o) => isKindVisibleAtBand(o.kind, zoomBand));
    // 3. §15 — a forecast becomes kind 'prediction' and loses any live
    //    freshness, so zoneStyle gives it the dashed treatment (§37).
    return toTemporalObjects(legible, timeOffset) as unknown as MapObject[];
  }, [
    defaultObjects,
    compassPickObjects,
    tripObjects,
    homeFilter,
    layerPrefs,
    layerContext,
    zoomBand,
    timeOffset,
  ]);

  // Badge counts must use the same layer-aware path as the objects themselves,
  // or a chip can advertise results the map will not draw.
  const chipCounts = useMemo(
    () => homeChipCounts(compassPickObjects ?? defaultObjects, layerPrefs, layerContext),
    [compassPickObjects, defaultObjects, layerPrefs, layerContext],
  );

  // §5 levels 2-3: zones render beneath everything and skip collision.
  const zoneObjects = useMemo(() => objects.filter((o) => isZoneKind(o.kind)), [objects]);

  // §31 — collision only among the point-shaped markers. `dropped` is surfaced
  // rather than swallowed: a hidden object the user cannot reach is a silent
  // truncation, and the count is what an "N more" affordance needs.
  const renderResult = useMemo(
    () =>
      prepareForRender(
        objects.filter((o) => !isZoneKind(o.kind)),
        {
          viewport: {
            zoom: activeZoom,
            center: {
              lat: cameraCenter?.lat ?? fallbackLat ?? 0,
              lng: cameraCenter?.lng ?? fallbackLng ?? 0,
            },
            width: windowWidth,
            height: windowHeight,
          },
          promotion: {
            selectedId: machine.selection?.objectId ?? null,
            navigationTargetId: machine.navigation?.destinationObjectId ?? null,
          },
        },
      ),
    [
      objects,
      activeZoom,
      cameraCenter,
      fallbackLat,
      fallbackLng,
      machine.selection?.objectId,
      machine.navigation,
      windowWidth,
      windowHeight,
    ],
  );
  const hiddenByCollision = renderResult.collisionDroppedCount ?? 0;

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

  const overlayOpen = (o: 'INTENT' | 'LAYERS' | 'FILTERS' | 'SEARCH') =>
    machine.overlays.includes(o);

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
        places={places}
        onSelectPlace={handleSelectPlace}
        fallbackLat={cameraCenter?.lat ?? fallbackLat}
        fallbackLng={cameraCenter?.lng ?? fallbackLng}
        fallbackZoom={cameraZoom ?? paramZoom}
        userLat={userLat}
        userLng={userLng}
        externalCameraRef={cameraRef}
        entities={entities}
        zoneObjects={zoneObjects}
        enabledEntityLayers={enabledLayers}
        onSelectEntity={handleSelectEntity}
        selectedEntityId={selectedEntityId}
        filterRowOffset={mapHeaderStackOffset(insets.top) + MAP_FILTER_CHIPS_HEIGHT + 8}
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
      />

      {/* Places loading indicator — small spinner overlay while getDiscoveryPlaces
          is in-flight.  Rendered over the map (not in the carousel) so the user
          sees immediate feedback even before the carousel area appears. */}
      {placesLayerActive && placesLoading ? (
        <View style={s.placesLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : null}

      {/* Bottom carousel — floats above the AskCompassBar; z-index below MapTopControls */}
      <MapCarousel
        ref={carouselRef}
        entities={entities}
        activeIndex={activeIndex}
        onIndexChange={handleCarouselIndexChange}
        onFiltersPress={() => setFilterSheetOpen(true)}
        onBeforeNavigate={() => { pushedToDetailRef.current = true; }}
        passportLoading={mode === 'passport' ? passportLoading : undefined}
        passportError={mode === 'passport' ? passportError : undefined}
        onPassportRetry={mode === 'passport' ? handlePassportRetry : undefined}
        placesLoading={placesLayerActive ? placesLoading : undefined}
        placesError={placesLayerActive ? placesError : undefined}
        placesEmpty={placesLayerActive ? placesEmpty : undefined}
        onPlacesRetry={placesLayerActive ? handlePlacesRetry : undefined}
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
            const cam = cameraRef.current;
            const lat = cameraCenter?.lat ?? fallbackLat;
            const lng = cameraCenter?.lng ?? fallbackLng;
            if (cam && typeof cam.easeTo === 'function' && lat != null && lng != null) {
              cam.easeTo({
                center: [lng, lat],
                zoom: Math.min((cameraZoom ?? paramZoom) + 1.5, 18),
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
          onAction={(action, obj) => {
            if (action === 'contribute') setContributeObject(obj);
          }}
        />
      ) : null}

      {/* ── §8 Live Place sheet ─────────────────────────────────────────────
          Replaces the legacy preview card for objects whose contract says they
          open a sheet. The map stays visible behind Peek and Half (§32). */}
      {selectedObject?.interaction?.opensSheet ? (
        <LivePlaceSheet
          object={selectedObject}
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
          confidence (§22, §37). Submission is the caller's seam. */}
      <MapContributionSheet
        visible={contributeObject !== null}
        object={contributeObject}
        onClose={() => setContributeObject(null)}
        onSubmit={(contribution) => {
          if (!contributeObject) return;
          const obj = contributeObject;
          emitMapEvent('contribution_submitted', {
            ref: describeMapObject(obj),
            contributionKind: contribution.kind,
            prompt: 'sheet',
          });
          // Fire-and-forget: §22 is a LOW-FRICTION capture surface, so the tap
          // must not wait on the network. The server owns consent, validation
          // and idempotency, and dedupes a double tap on its own.
          void submitMapObservation(obj.id, obj.kind, contribution);
          setContributeObject(null);
        }}
      />

      {/* ── §11 Optimize Today ──────────────────────────────────────────────
          A PROPOSAL, never a rewrite: acceptProposal/dismissProposal return
          data, and persisting it is the caller's job. §11: "the map should not
          silently rewrite the canonical Trip." */}
      {tripId && tripStops.length > 1 ? (
        <Pressable
          style={[s2.optimizeChip, { bottom: insets.bottom + 240 }]}
          onPress={() =>
            setProposal(
              optimizeToday(tripStops, { now: new Date().toISOString() }),
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
          const change = acceptProposal(p, new Date().toISOString());
          // `persisted: false` — the write is a Trips concern (§20), and this
          // screen does not own the itinerary. Reorder locally so the map
          // reflects the accepted plan; the durable write belongs to TripPage.
          const byId = new Map(tripStops.map((st) => [st.id, st]));
          setTripStops(
            change.orderedStopIds
              .map((id) => byId.get(id))
              .filter((st): st is TripStop => st != null),
          );
          setProposal(null);
        }}
      />

      {/* ── §25 long-press menu ─────────────────────────────────────────────
          Seven actions, always all seven, disabled-with-reason rather than
          hidden so the menu cannot reflow between targets. */}
      <MapLongPressMenu
        target={longPress?.target ?? null}
        visible={longPress != null}
        anchor={longPress?.anchor}
        context={{ checkpointScopeId: null, now: Date.now() }}
        onClose={() => setLongPress(null)}
        onSelect={(action, target) => {
          setLongPress(null);
          if (action === 'report' && target.kind === 'object') {
            setContributeObject(target.object);
            return;
          }
          if (action === 'ask_compass') {
            const pt = coordinateOf(target);
            if (pt) void geocodeAndFly(`${pt.lat.toFixed(3)},${pt.lng.toFixed(3)}`);
          }
        }}
      />

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
