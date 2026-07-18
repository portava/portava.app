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
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, Pressable, StyleSheet, Platform,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MapPin, X as XIcon } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../src/theme/tokens.ts';
import { MapTopControls } from '../../src/components/map/MapTopControls.tsx';
import { AskCompassBar } from '../../src/components/map/AskCompassBar.tsx';
import { useLocationContext } from '../../src/context/LocationContext.tsx';
import { getDiscoveryPlaces } from '../../src/services/discovery.ts';
import type { DiscoveryPlace, DiscoveryCategory } from '../../src/services/discovery.ts';
import { useMapEntities } from '../../src/hooks/useMapEntities.ts';
import {
  MapFilterSheet,
  loadEnabledLayers,
} from '../../src/components/map/MapFilterSheet.tsx';
import type { MapEntity, ToggleableEntityType } from '../../src/types/mapTypes.ts';
import { TOGGLEABLE_LAYERS } from '../../src/types/mapTypes.ts';

// ── Lazy-load native map component only on native ─────────────────────────────
// This avoids importing MapLibre on web where it would crash.

let DiscoveryMapView: React.ComponentType<any> | null = null;
if (Platform.OS !== 'web') {
  // Safe: this branch is never executed on web (tree-shaken by Metro).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  DiscoveryMapView = require('../../src/components/discovery/DiscoveryMapView').DiscoveryMapView;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
        Open the Travel Buddy app on your phone to explore the interactive map.
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
    width: 64,
    height: 64,
    borderRadius: 32,
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
    width: 64,
    height: 64,
    borderRadius: 32,
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

export default function FullScreenMapScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    entityTypes?: string;
    lat?: string;
    lng?: string;
    zoom?: string;
    title?: string;
    category?: string;
  }>();

  // Shared camera ref — forwarded into DiscoveryMapView so the Camera element
  // inside is the same ref that MapTopControls calls setCamera on.
  const cameraRef = useRef<any>(null);
  const { locationState, requireLocation } = useLocationContext();
  // Parse query params — invalid / missing values are silently ignored.
  const paramLat = parseCoord(params.lat);
  const paramLng = parseCoord(params.lng);
  const paramZoom = parseZoom(params.zoom);
  const title = Array.isArray(params.title) ? params.title[0] : (params.title ?? null);
  const entityTypes = Array.isArray(params.entityTypes) ? params.entityTypes[0] : (params.entityTypes ?? '');
  const category = parseCategory(params.category);

  // Resolved camera position: prefer explicit params, fall back to location context.
  const fallbackLat = paramLat ?? (locationState.coords?.lat ?? null);
  const fallbackLng = paramLng ?? (locationState.coords?.lng ?? null);
  const userLat = locationState.coords?.lat ?? null;
  const userLng = locationState.coords?.lng ?? null;

  // ── Discovery places ───────────────────────────────────────────────────────
  // Fetch discovery places when the caller requests the "places" entity layer
  // and a destination city name is available (passed as the `title` param from
  // the discovery tab).  Falls back to an empty array on error so the map
  // still renders — only place pins are missing, not the whole map.
  const [places, setPlaces] = useState<DiscoveryPlace[]>([]);
  const destination = title; // city name string, e.g. "Cebu City"

  useEffect(() => {
    if (!entityTypes.split(',').map((s: string) => s.trim()).includes('places')) return;
    if (!destination) return;

    let cancelled = false;
    getDiscoveryPlaces(
      destination,
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
      if (res.ok && Array.isArray(res.data?.places)) {
        setPlaces(res.data.places);
      }
    }).catch(() => {
      // Non-fatal: map renders without place pins rather than crashing.
    });

    return () => { cancelled = true; };
  }, [destination, category, entityTypes, paramLat, paramLng, userLat, userLng]);

  // ── Entity layer filter state ───────────────────────────────────────────────
  const [enabledLayers, setEnabledLayers] = useState<ToggleableEntityType[]>(
    () => [...TOGGLEABLE_LAYERS],
  );
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  // Restore persisted layer preferences on mount.
  useEffect(() => {
    loadEnabledLayers().then(setEnabledLayers).catch(() => {});
  }, []);

  // ── Entity data fetch ───────────────────────────────────────────────────────
  // `title` is used as the city name — passed in from Discovery / Trips entry points.
  const { entities: defaultEntities } = useMapEntities({
    enabledLayers,
    city: title,
    lat: fallbackLat,
    lng: fallbackLng,
  });

  // ── Compass search override ─────────────────────────────────────────────────
  // When a Compass query is active, compassOverrideEntities replaces defaultEntities
  // for both the marker layers and the carousel.  Cleared via the ✕ dismiss button.
  const [compassOverrideEntities, setCompassOverrideEntities] = useState<MapEntity[] | null>(null);
  const [compassQuery, setCompassQuery] = useState<string | null>(null);

  function handleCompassResults(entities: MapEntity[], query: string) {
    setCompassOverrideEntities(entities);
    setCompassQuery(query);
  }

  function handleCompassClear() {
    setCompassOverrideEntities(null);
    setCompassQuery(null);
  }

  // The active entity list: Compass override takes precedence when set.
  const entities = compassOverrideEntities ?? defaultEntities;

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

  const MapComponent = DiscoveryMapView!;

  return (
    <View style={s.root}>
      {/* Full-screen map — externalCameraRef wires MapTopControls' recenter
          button to the Camera element rendered inside DiscoveryMapView.
          Entity layers (Buddies, Events, Gems, Trips, Friends) are injected
          via entities/enabledEntityLayers props. */}
      <MapComponent
        places={places}
        onSelectPlace={() => {}}
        fallbackLat={fallbackLat}
        fallbackLng={fallbackLng}
        fallbackZoom={paramZoom}
        userLat={userLat}
        userLng={userLng}
        externalCameraRef={cameraRef}
        entities={entities}
        enabledEntityLayers={enabledLayers}
      />

      {/* Floating top controls: Back, Recenter, Filters */}
      <MapTopControls
        cameraRef={cameraRef}
        userLat={userLat != null && Number.isFinite(userLat) ? userLat : null}
        userLng={userLng != null && Number.isFinite(userLng) ? userLng : null}
        fallbackLat={fallbackLat}
        fallbackLng={fallbackLng}
        title={title}
        topInset={insets.top}
        onFiltersPress={() => setFilterSheetOpen(true)}
      />

      {/* ── AskCompassBar + active filter label — floating bottom overlay ── */}
      {/* pointerEvents="box-none" lets map touches pass through the transparent
          areas; the bar and chips capture their own touch events normally. */}
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

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#13213A',
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
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
