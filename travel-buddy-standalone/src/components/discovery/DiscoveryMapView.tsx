/**
 * DiscoveryMapView — renders Discovery venue pins on a MapLibre Map.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 *
 * DB places (id prefixed "db/" or "comm/") are rendered as gold star pins so
 * travelers can distinguish them from OSM-sourced venues at a glance.
 *
 * A three-way segmented filter (All / Traveler Picks / Venues) floats at the
 * top of the map and re-renders visible pins without any network request.
 * The chosen filter is persisted to AsyncStorage (key: "discovery_map_filter")
 * and restored on the next mount, so power users don't have to re-tap every
 * session. Unrecognised stored values fall back to 'all' gracefully.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, Text, Pressable, StyleSheet } from 'react-native';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import { Layers, MapPin, Navigation, Star, Users } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery.ts';
import { MAP_STYLE_URL, FALLBACK_MAP_STYLE_URL } from '../../constants/mapStyle.ts';
import { color, space, radius, type as t, avatar, icon, dot } from '../../theme/tokens.ts';
import {
  loadMapFilter,
  saveMapFilter,
  removeMapFilter,
  getCachedFilter,
  type MapFilter,
} from './discoverMapFilterStorage.ts';
import { useMapTravelers } from '../../hooks/useMapTravelers.ts';
import { TravelerClusterMarkers } from './TravelerMapLayer.tsx';
import { TravelerPreviewCard } from './TravelerPreviewCard.tsx';
import type { MapTraveler } from '../../services/mapTravelers.ts';
export type { MapFilter } from './discoverMapFilterStorage.ts';

/** AsyncStorage key for the travelers-layer toggle ('1' on / '0' off). */
const TRAVELERS_TOGGLE_KEY = 'discovery_map_travelers';

// ── Map tile style ─────────────────────────────────────────────────────────────

// Use the SHARED style, not a local copy. constants/mapStyle.ts documents why:
// EXPO_PUBLIC_MAPTILER_KEY returns HTTP 403 on MapTiler's /styles endpoint even
// when valid for its other APIs, so the shared module returns OpenFreeMap
// Liberty unconditionally.
//
// The copy that used to live here diverged twice over: it bypassed that
// decision AND pinned `maps/streets` — the v1 style id — where the shared
// module's own re-enable instructions specify `streets-v2`. Its `else` branch
// pointed at demotiles.maplibre.org, a grey country-outline debug basemap with
// no streets, which is what a 403 actually produced on this surface.
//
// This is the flagship map (app/map/index.tsx renders this component), so it
// was the one surface not using the shared style and the one most likely to be
// judged as "the map looks broken".

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryMapViewProps {
  userLat?: number | null;
  userLng?: number | null;
  fallbackLat?: number | null;
  fallbackLng?: number | null;
  fallbackZoom?: number;
  places: DiscoveryPlace[];
  onSelectPlace: (place: DiscoveryPlace) => void;
  /** Pixels to shift map-overlay UI down so it clears a floating header/tab bar. */
  topInset?: number;
  /**
   * Optional camera ref forwarded from a parent screen (e.g. the full-screen
   * /map route) so an external Recenter button can call setCamera directly.
   * When omitted, DiscoveryMapView manages its own internal camera ref.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  externalCameraRef?: React.RefObject<any>;
}

// ── Category pin colours ──────────────────────────────────────────────────────

const CAT_COLOR: Record<string, string> = {
  food:        '#E76F51',
  nightlife:   '#7A4DBF',
  places:      '#3A7CA5',
  activities:  '#2A9D5C',
  events:      '#D4A017',
  beaches:     '#0096C7',
  transport:   '#888888',
  for_you:     '#4A90D9',
};

/** DB-sourced places (id starts with "db/") and community-submitted places
 * (id starts with "comm/") get a gold pin with a Star icon. */
const DB_PIN_COLOR = '#F59E0B';

function isDbPlace(id: string): boolean {
  return id.startsWith('db/') || id.startsWith('comm/');
}

// ── Legend entries — order determines display order in the panel ───────────────

const LEGEND_ENTRIES: { key: string; color: string; label: string }[] = [
  { key: 'food',       color: CAT_COLOR.food,       label: 'Food & Drink' },
  { key: 'nightlife',  color: CAT_COLOR.nightlife,  label: 'Nightlife' },
  { key: 'places',     color: CAT_COLOR.places,     label: 'Places' },
  { key: 'activities', color: CAT_COLOR.activities, label: 'Activities' },
  { key: 'events',     color: CAT_COLOR.events,     label: 'Events' },
  { key: 'beaches',    color: CAT_COLOR.beaches,    label: 'Beaches' },
  { key: 'transport',  color: CAT_COLOR.transport,  label: 'Transport' },
  { key: 'for_you',    color: CAT_COLOR.for_you,    label: 'For You' },
];

// ── Filter options + persistence ───────────────────────────────────────────────

const FILTER_OPTIONS: { key: MapFilter; label: string }[] = [
  { key: 'all',      label: 'All' },
  { key: 'traveler', label: '⭐ Picks' },
  { key: 'osm',      label: '📍 Venues' },
];

// ── Viewport helper ───────────────────────────────────────────────────────────

function computeViewport(places: DiscoveryPlace[]) {
  if (places.length === 0) return null;
  const lats = places.map((p) => p.lat!);
  const lngs = places.map((p) => p.lng!);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latDelta = Math.max((maxLat - minLat) * 1.5, 0.05);
  const lngDelta = Math.max((maxLng - minLng) * 1.5, 0.05);
  return {
    center: [(minLng + maxLng) / 2, (minLat + maxLat) / 2] as [number, number],
    zoom: Math.min(
      Math.log2(360 / lngDelta),
      Math.log2(180 / latDelta),
    ) - 0.5,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DiscoveryMapView({ places, onSelectPlace, fallbackLat, fallbackLng, fallbackZoom, userLat, userLng, topInset = 0, externalCameraRef }: DiscoveryMapViewProps) {
  // Lazy initialiser reads the module-level memory cache synchronously so
  // remounts (e.g. Expo Router tab navigation) start with the correct filter
  // value and never flash to 'all' while waiting for AsyncStorage to resolve.
  // Style is state, not a constant, so onDidFailLoadingMap can swap to the
  // fallback exactly as MapTab, RouteMinimapView, RouteFullMapModal and
  // itinerary/MapView already do. This component had no failure handler at all,
  // so a style-load failure had nothing to recover to.
  const [mapStyle, setMapStyle] = useState<string>(MAP_STYLE_URL);
  const [filter, setFilterRaw] = useState<MapFilter>(() => getCachedFilter() ?? 'all');
  const [legendOpen, setLegendOpen] = useState(false);
  const [resetToast, setResetToast] = useState(false);
  const resetToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks whether onLongPress just fired so onPress can be suppressed for that gesture.
  const didLongPress = useRef(false);

  // Restore the last-used filter from AsyncStorage on mount.
  // Unrecognised or missing values fall back to 'all' silently.
  useEffect(() => {
    loadMapFilter(AsyncStorage).then(setFilterRaw);
  }, []);

  // Clean up the toast timer when the component unmounts.
  useEffect(() => {
    return () => {
      if (resetToastTimer.current) clearTimeout(resetToastTimer.current);
    };
  }, []);

  // Persist filter selection and update local state.
  const setFilter = (f: MapFilter) => {
    setFilterRaw(f);
    saveMapFilter(AsyncStorage, f);
  };

  // Long-pressing the active filter button resets to 'all' and clears the
  // persisted preference, giving travelers an escape hatch if they end up
  // with a filter that shows no pins in the current city.
  const handleFilterReset = () => {
    setFilterRaw('all');
    removeMapFilter(AsyncStorage); // clears cache + storage atomically
    setResetToast(true);
    if (resetToastTimer.current) clearTimeout(resetToastTimer.current);
    resetToastTimer.current = setTimeout(() => setResetToast(false), 1500);
  };

  // All places that have coordinates — used for viewport + empty-state check.
  const mappable = useMemo(
    () => places.filter((p) => p.lat != null && p.lng != null),
    [places],
  );

  // Subset of mappable based on the active filter — what actually gets pinned.
  const visiblePlaces = useMemo(() => {
    if (filter === 'traveler') return mappable.filter((p) => isDbPlace(p.id));
    if (filter === 'osm')      return mappable.filter((p) => !isDbPlace(p.id));
    return mappable;
  }, [mappable, filter]);

  const viewport = useMemo(() => computeViewport(mappable), [mappable]);

  const fallback = (fallbackLat != null && fallbackLng != null)
    ? { center: [fallbackLng, fallbackLat] as [number, number], zoom: fallbackZoom ?? 11 }
    : null;
  const vp = viewport ?? fallback;

  const travelerCount = useMemo(() => mappable.filter((p) => isDbPlace(p.id)).length, [mappable]);
  const internalCameraRef = useRef<any>(null);
  // Prefer the external ref forwarded from the parent screen (e.g. FullScreenMapScreen)
  // so MapTopControls can call setCamera on it. Fall back to the internal ref when
  // DiscoveryMapView is embedded without an external ref (e.g. in the Discover tab).
  const cameraRef = externalCameraRef ?? internalCameraRef;
  const hasUser = userLat != null && userLng != null;

  // ── Travelers layer (users sharing their location in discovery) ──────────
  const [travelersOn, setTravelersOnRaw] = useState(true);
  const [zoom, setZoom] = useState<number | null>(null);
  // Camera centre as the user pans, rounded to ~1km so small drags don't
  // re-render or re-trigger the fetch hook. [lng, lat] (MapLibre order).
  const [mapCenter, setMapCenter] = useState<[number, number] | null>(null);
  const zoomAt = useRef(0);
  const [selectedTraveler, setSelectedTraveler] = useState<MapTraveler | null>(null);
  const [emptyHint, setEmptyHint] = useState(false);
  const emptyHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(TRAVELERS_TOGGLE_KEY)
      .then((v) => { if (v === '0') setTravelersOnRaw(false); })
      .catch(() => {});
    return () => { if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current); };
  }, []);

  const { travelers, loading: travelersLoading } = useMapTravelers({
    lat: mapCenter ? mapCenter[1] : vp ? vp.center[1] : null,
    lng: mapCenter ? mapCenter[0] : vp ? vp.center[0] : null,
    radiusKm: 50,
    enabled: travelersOn,
  });

  const setTravelersOn = (on: boolean) => {
    setTravelersOnRaw(on);
    if (!on) setSelectedTraveler(null);
    AsyncStorage.setItem(TRAVELERS_TOGGLE_KEY, on ? '1' : '0').catch(() => {});
    if (on) {
      // Brief "no travelers here yet" hint so an empty layer doesn't look broken.
      setEmptyHint(true);
      if (emptyHintTimer.current) clearTimeout(emptyHintTimer.current);
      emptyHintTimer.current = setTimeout(() => setEmptyHint(false), 4000);
    }
  };

  // Throttled camera tracking (250ms): zoom feeds cluster bucketing, centre
  // feeds the travelers fetch so panning to a new city loads its travelers.
  const handleRegionChange = (e: any) => {
    const now = Date.now();
    if (now - zoomAt.current <= 250) return;
    zoomAt.current = now;
    const z = e?.nativeEvent?.zoom;
    if (typeof z === 'number') setZoom(z);
    const c = e?.nativeEvent?.center;
    if (Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number') {
      setMapCenter((prev) => {
        const next: [number, number] = [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100];
        return prev && prev[0] === next[0] && prev[1] === next[1] ? prev : next;
      });
    }
  };

  const recenterOnMe = () => {
    if (hasUser && cameraRef.current) {
      cameraRef.current.setCamera({
        centerCoordinate: [userLng as number, userLat as number],
        zoomLevel: 14,
        animationDuration: 600,
      });
    }
  };

  if (!vp) {
    return (
      <View style={s.empty}>
        <View style={s.emptyIcon}><MapPin size={28} color={color.faint} /></View>
        <Text style={s.emptyTitle}>No location set</Text>
        <Text style={s.emptyBody}>Pick a city to see it on the map.</Text>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={mapStyle}
        onDidFailLoadingMap={() => {
          if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL);
        }}
        logo={false}
        attribution={false}
        onRegionDidChange={handleRegionChange}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: vp.center,
            zoom: vp.zoom,
          }}
        />
        {visiblePlaces.map((place) => {
          const db = isDbPlace(place.id);
          const pinBg = db ? DB_PIN_COLOR : (CAT_COLOR[place.category] ?? color.signal);
          return (
            <Marker
              key={place.id}
              lngLat={[place.lng!, place.lat!]}
            >
              <Pressable onPress={() => onSelectPlace(place)}>
                <View style={[s.pin, db && s.dbPin, { backgroundColor: pinBg }]}>
                  {db
                    ? <Star size={10} color="#fff" fill="#fff" />
                    : <MapPin size={10} color="#fff" />
                  }
                </View>
              </Pressable>
            </Marker>
          );
        })}
        {travelersOn && travelers.length > 0 && (
          <TravelerClusterMarkers
            travelers={travelers}
            zoom={zoom ?? vp.zoom}
            onPressTraveler={setSelectedTraveler}
            onPressCluster={(c) => {
              cameraRef.current?.setCamera({
                centerCoordinate: [c.lng, c.lat],
                zoomLevel: Math.min((zoom ?? vp.zoom) + 1.8, 17),
                animationDuration: 450,
              });
            }}
          />
        )}
        {hasUser && (
          <Marker key="me-marker" lngLat={[userLng as number, userLat as number]}>
            <View style={s.meDotOuter}>
              <View style={s.meDot} />
            </View>
          </Marker>
        )}
      </Map>

      {/* ── Filter toggle ──────────────────────────────────────────────────── */}
      <View style={[s.filterRow, { top: 14 + topInset }]}>
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.key;
          return (
            <Pressable
              key={opt.key}
              style={[s.filterBtn, active && s.filterBtnActive]}
              onPress={() => {
                // Suppress the onPress that React Native fires after onLongPress.
                if (didLongPress.current) { didLongPress.current = false; return; }
                setFilter(opt.key);
              }}
              onLongPress={active ? () => { didLongPress.current = true; handleFilterReset(); } : undefined}
              hitSlop={4}
            >
              <Text style={[s.filterBtnText, active && s.filterBtnTextActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── Reset toast ────────────────────────────────────────────────────── */}
      {resetToast && (
        <View style={[s.resetToast, { top: 62 + topInset }]} pointerEvents="none">
          <Text style={s.resetToastText}>Filter reset</Text>
        </View>
      )}

      {/* ── Badge row ──────────────────────────────────────────────────────── */}
      <View style={s.badgeRow}>
        <View style={s.badge}>
          <MapPin size={10} color="#fff" />
          <Text style={s.badgeText}>
            {visiblePlaces.length} {visiblePlaces.length === 1 ? 'place' : 'places'}
          </Text>
        </View>
        {travelerCount > 0 && filter !== 'osm' && (
          <View style={[s.badge, s.dbBadge]}>
            <Star size={10} color="#fff" fill="#fff" />
            <Text style={s.badgeText}>
              {filter === 'traveler' ? visiblePlaces.length : travelerCount}{' '}
              traveler {(filter === 'traveler' ? visiblePlaces.length : travelerCount) === 1 ? 'pick' : 'picks'}
            </Text>
          </View>
        )}
        {travelersOn && travelersLoading && (
          <View style={s.badge}>
            <Users size={10} color="#fff" />
            <Text style={s.badgeText}>Finding travelers…</Text>
          </View>
        )}
        {travelersOn && !travelersLoading && travelers.length > 0 && (
          <View style={s.badge}>
            <Users size={10} color="#fff" />
            <Text style={s.badgeText}>
              {travelers.length} {travelers.length === 1 ? 'traveler' : 'travelers'}
            </Text>
          </View>
        )}
        {travelersOn && !travelersLoading && travelers.length === 0 && emptyHint && (
          <View style={s.badge}>
            <Users size={10} color="#fff" />
            <Text style={s.badgeText}>No travelers sharing here yet</Text>
          </View>
        )}
      </View>

      {hasUser && (
        <Pressable style={s.recenterBtn} onPress={recenterOnMe} hitSlop={8}>
          <Navigation size={18} color={color.signal} />
        </Pressable>
      )}

      {/* ── Legend button ───────────────────────────────────────────────────── */}
      <Pressable
        style={[s.legendBtn, { top: 14 + topInset }]}
        onPress={() => setLegendOpen((o) => !o)}
        hitSlop={8}
      >
        <Layers size={18} color={legendOpen ? color.signal : color.mute} />
      </Pressable>

      {/* ── Travelers layer toggle ──────────────────────────────────────────── */}
      <Pressable
        style={[s.travelersBtn, { top: 58 + topInset }]}
        onPress={() => setTravelersOn(!travelersOn)}
        hitSlop={8}
        accessibilityLabel={travelersOn ? 'Hide travelers on map' : 'Show travelers on map'}
      >
        <Users size={18} color={travelersOn ? color.signal : color.faint} />
      </Pressable>

      {/* ── Legend dismiss overlay + panel ──────────────────────────────────── */}
      {legendOpen && (
        <>
          {/* Transparent overlay — tap anywhere outside the panel to close */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setLegendOpen(false)} />

          <View style={[s.legendPanel, { top: 102 + topInset }]}>
            {/* Traveler picks entry listed first per spec */}
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: DB_PIN_COLOR }]}>
                <Star size={8} color="#fff" fill="#fff" />
              </View>
              <Text style={s.legendLabel}>⭐ Traveler picks</Text>
            </View>
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: color.deep }]}>
                <Users size={8} color="#fff" />
              </View>
              <Text style={s.legendLabel}>Travelers sharing location</Text>
            </View>
            {LEGEND_ENTRIES.map((entry) => (
              <View key={entry.key} style={s.legendRow}>
                <View style={[s.legendDot, { backgroundColor: entry.color }]} />
                <Text style={s.legendLabel}>{entry.label}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      {/* ── Traveler preview card ───────────────────────────────────────────── */}
      {travelersOn && selectedTraveler && (
        <TravelerPreviewCard
          traveler={selectedTraveler}
          onClose={() => setSelectedTraveler(null)}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  meDotOuter: {
    width: icon.s22, height: icon.s22,
    borderRadius: icon.s22 / 2,
    backgroundColor: 'rgba(45,127,249,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meDot: {
    width: dot.s12,
    height: dot.s12,
    borderRadius: dot.s12 / 2,
    backgroundColor: '#2D7FF9',
    borderWidth: 2,
    borderColor: '#fff',
  },
  recenterBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    width: avatar.s44, height: avatar.s44,
    borderRadius: avatar.s44 / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  root: {
    flex: 1,
    position: 'relative',
  },
  pin: {
    width: avatar.s30, height: avatar.s30,
    borderRadius: avatar.s30 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  dbPin: {
    width: avatar.s34, height: avatar.s34,
    borderRadius: avatar.s34 / 2,
    borderWidth: 2.5,
    borderColor: '#fffbeb',
    shadowOpacity: 0.3,
    shadowRadius: 5,
    elevation: 5,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
    paddingVertical: space.xxxl,
  },
  emptyIcon: {
    width: avatar.s56, height: avatar.s56,
    borderRadius: avatar.s56 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.title,
    fontSize: 16,
    color: color.mute,
  },
  emptyBody: {
    ...t.body,
    color: color.faint,
    textAlign: 'center',
    maxWidth: 260,
  },
  filterRow: {
    position: 'absolute',
    top: 14,
    alignSelf: 'center',
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: radius.pill,
    padding: 3,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
    gap: 2,
  },
  filterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  filterBtnActive: {
    backgroundColor: color.signal,
  },
  filterBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: color.mute,
  },
  filterBtnTextActive: {
    color: '#fff',
  },
  badgeRow: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dbBadge: {
    backgroundColor: 'rgba(180,120,0,0.85)',
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  legendBtn: {
    position: 'absolute',
    top: 14,
    right: 14,
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  travelersBtn: {
    position: 'absolute',
    top: 58,
    right: 14,
    width: avatar.s36, height: avatar.s36,
    borderRadius: avatar.s36 / 2,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  legendPanel: {
    position: 'absolute',
    top: 58,
    right: 14,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    minWidth: 164,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  legendDot: {
    width: icon.s18, height: icon.s18,
    borderRadius: icon.s18 / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  legendLabel: {
    fontSize: 12,
    fontWeight: '500',
    color: '#111827',
  },
  resetToast: {
    position: 'absolute',
    top: 62,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  resetToastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
