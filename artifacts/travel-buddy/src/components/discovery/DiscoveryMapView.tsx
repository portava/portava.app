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
import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
import { Layers, MapPin, Navigation, Star } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Map tile style ─────────────────────────────────────────────────────────────

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Which layer of pins to show on the map. */
export type MapFilter = 'all' | 'traveler' | 'osm';

export interface DiscoveryMapViewProps {
  userLat?: number | null;
  userLng?: number | null;
  fallbackLat?: number | null;
  fallbackLng?: number | null;
  fallbackZoom?: number;
  places: DiscoveryPlace[];
  onSelectPlace: (place: DiscoveryPlace) => void;
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

const FILTER_STORAGE_KEY = 'discovery_map_filter';
const VALID_FILTERS = new Set<string>(['all', 'traveler', 'osm']);

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

export function DiscoveryMapView({ places, onSelectPlace, fallbackLat, fallbackLng, fallbackZoom, userLat, userLng }: DiscoveryMapViewProps) {
  const [filter, setFilterRaw] = useState<MapFilter>('all');
  const [legendOpen, setLegendOpen] = useState(false);
  const [resetToast, setResetToast] = useState(false);
  const resetToastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Restore the last-used filter from AsyncStorage on mount.
  // Unrecognised or missing values fall back to 'all' silently.
  useEffect(() => {
    AsyncStorage.getItem(FILTER_STORAGE_KEY)
      .then((stored) => {
        if (stored && VALID_FILTERS.has(stored)) {
          setFilterRaw(stored as MapFilter);
        }
      })
      .catch(() => {}); // fail-open — show 'all' if storage is unavailable
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
    AsyncStorage.setItem(FILTER_STORAGE_KEY, f).catch(() => {}); // fire-and-forget
  };

  // Long-pressing the active filter button resets to 'all' and clears the
  // persisted preference, giving travelers an escape hatch if they end up
  // with a filter that shows no pins in the current city.
  const handleFilterReset = () => {
    setFilterRaw('all');
    AsyncStorage.removeItem(FILTER_STORAGE_KEY).catch(() => {});
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
  const cameraRef = useRef<any>(null);
  const hasUser = userLat != null && userLng != null;

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
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
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
        {hasUser && (
          <Marker key="me-marker" lngLat={[userLng as number, userLat as number]}>
            <View style={s.meDotOuter}>
              <View style={s.meDot} />
            </View>
          </Marker>
        )}
      </Map>

      {/* ── Filter toggle ──────────────────────────────────────────────────── */}
      <View style={s.filterRow}>
        {FILTER_OPTIONS.map((opt) => {
          const active = filter === opt.key;
          return (
            <Pressable
              key={opt.key}
              style={[s.filterBtn, active && s.filterBtnActive]}
              onPress={() => setFilter(opt.key)}
              onLongPress={active ? handleFilterReset : undefined}
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
        <View style={s.resetToast} pointerEvents="none">
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
      </View>

      {hasUser && (
        <Pressable style={s.recenterBtn} onPress={recenterOnMe} hitSlop={8}>
          <Navigation size={18} color={color.signal} />
        </Pressable>
      )}

      {/* ── Legend button ───────────────────────────────────────────────────── */}
      <Pressable
        style={s.legendBtn}
        onPress={() => setLegendOpen((o) => !o)}
        hitSlop={8}
      >
        <Layers size={18} color={legendOpen ? color.signal : color.mute} />
      </Pressable>

      {/* ── Legend dismiss overlay + panel ──────────────────────────────────── */}
      {legendOpen && (
        <>
          {/* Transparent overlay — tap anywhere outside the panel to close */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setLegendOpen(false)} />

          <View style={s.legendPanel}>
            {/* Traveler picks entry listed first per spec */}
            <View style={s.legendRow}>
              <View style={[s.legendDot, { backgroundColor: DB_PIN_COLOR }]}>
                <Star size={8} color="#fff" fill="#fff" />
              </View>
              <Text style={s.legendLabel}>⭐ Traveler picks</Text>
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
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  meDotOuter: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(45,127,249,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  meDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#2D7FF9',
    borderWidth: 2,
    borderColor: '#fff',
  },
  recenterBtn: {
    position: 'absolute',
    right: 14,
    bottom: 14,
    width: 44,
    height: 44,
    borderRadius: 22,
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
    width: 30,
    height: 30,
    borderRadius: 15,
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
    width: 34,
    height: 34,
    borderRadius: 17,
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
    width: 56,
    height: 56,
    borderRadius: 28,
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
    width: 36,
    height: 36,
    borderRadius: 18,
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
    width: 18,
    height: 18,
    borderRadius: 9,
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
