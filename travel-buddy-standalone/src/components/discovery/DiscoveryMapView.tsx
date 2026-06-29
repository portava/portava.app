/**
 * DiscoveryMapView — renders Discovery venue pins on a MapLibre Map.
 * Metro automatically selects DiscoveryMapView.web.tsx on web, so this file
 * is only compiled for native (iOS / Android).
 *
 * The Map is ALWAYS mounted in map mode — even when there are zero places.
 * A "no pins" overlay is shown on top of the tiles when no mappable places
 * are available. This ensures the toggle is visually meaningful and the
 * native MapLibre module is exercised regardless of data state.
 */
import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, LayoutChangeEvent } from 'react-native';
import { Map, Camera, Marker } from '@maplibre/maplibre-react-native';
import { MapPin } from 'lucide-react-native';
import type { DiscoveryPlace } from '../../services/discovery';
import { color, space, radius, type as t } from '../../theme/tokens';

// ── Map tile style ─────────────────────────────────────────────────────────────

const MAPTILER_KEY = process.env.EXPO_PUBLIC_MAPTILER_KEY ?? '';
const MAP_STYLE = MAPTILER_KEY
  ? `https://api.maptiler.com/maps/streets/style.json?key=${MAPTILER_KEY}`
  : 'https://demotiles.maplibre.org/style.json';

const STYLE_HOST = (() => {
  try { return new URL(MAP_STYLE).hostname; } catch { return '(parse error)'; }
})();

// ── Debug logger (stripped in production) ─────────────────────────────────────

function dbg(msg: string, data?: Record<string, unknown>) {
  if (!__DEV__) return;
  if (data) {
    console.log(`[TravelBuddyMapDebug] ${msg}`, data);
  } else {
    console.log(`[TravelBuddyMapDebug] ${msg}`);
  }
}

// ── Fallback viewport (Fort Lauderdale) when no places have coordinates ────────

const FALLBACK_CENTER: [number, number] = [-80.1373, 26.1224]; // [lng, lat]
const FALLBACK_ZOOM = 12;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DiscoveryMapViewProps {
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

export function DiscoveryMapView({ places, onSelectPlace }: DiscoveryMapViewProps) {
  const mappable = useMemo(
    () => places.filter((p) => p.lat != null && p.lng != null),
    [places],
  );
  const viewport = useMemo(() => computeViewport(mappable), [mappable]);

  const [containerWidth, setContainerWidth]   = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [mapLoaded, setMapLoaded]             = useState(false);
  const [styleLoaded, setStyleLoaded]         = useState(false);
  const [mapError, setMapError]               = useState<string | null>(null);

  // ── mount log ──────────────────────────────────────────────────────────────
  useEffect(() => {
    dbg('Map component mounted', {
      pinCount: mappable.length,
      hasViewport: viewport !== null,
      styleURLBuilt: Boolean(MAP_STYLE),
      styleHost: STYLE_HOST,
      maptilerKeyPresent: Boolean(MAPTILER_KEY),
      platform: Platform.OS,
    });
    return () => {
      dbg('Map component unmounted');
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setContainerWidth(width);
    setContainerHeight(height);
    dbg('container dimensions measured', { width, height, usable: width > 0 && height > 0 });
  }, []);

  const handleMapLoaded = useCallback(() => {
    setMapLoaded(true);
    dbg('MapLibre fired map-loaded event');
  }, []);

  const handleStyleLoaded = useCallback(() => {
    setStyleLoaded(true);
    dbg('MapLibre fired style-loaded event');
  }, []);

  const handleMapError = useCallback(() => {
    const msg = 'map failed to load';
    setMapError(msg);
    dbg('MapLibre error', { message: msg });
  }, []);

  const center  = viewport?.center ?? FALLBACK_CENTER;
  const zoom    = viewport?.zoom   ?? FALLBACK_ZOOM;
  const noPins  = mappable.length === 0;
  const noSize  = containerWidth === 0 || containerHeight === 0;

  return (
    <View style={s.root} onLayout={handleLayout}>
      {/* ── Map always mounts ─────────────────────────────────────────────── */}
      <Map
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logo={false}
        attribution={false}
        onDidFinishLoadingMap={handleMapLoaded}
        onDidFinishLoadingStyle={handleStyleLoaded}
        onDidFailLoadingMap={handleMapError}
      >
        <Camera
          initialViewState={{
            center,
            zoom,
          }}
        />
        {mappable.map((place) => (
          <Marker
            key={place.id}
            lngLat={[place.lng!, place.lat!]}
          >
            <Pressable onPress={() => onSelectPlace(place)}>
              <View style={[s.pin, { backgroundColor: CAT_COLOR[place.category] ?? color.signal }]}>
                <MapPin size={10} color="#fff" />
              </View>
            </Pressable>
          </Marker>
        ))}
      </Map>

      {/* ── No-size warning overlay (layout error) ────────────────────────── */}
      {noSize && containerWidth + containerHeight > 0 && (
        <View style={s.warnBanner}>
          <Text style={s.warnText}>Map container has no usable size.</Text>
        </View>
      )}

      {/* ── No-pins overlay (shown on top of tiles) ───────────────────────── */}
      {noPins && !noSize && (
        <View style={s.noPinsOverlay} pointerEvents="none">
          <View style={s.emptyIcon}>
            <MapPin size={22} color={color.faint} />
          </View>
          <Text style={s.emptyTitle}>No pins available</Text>
          <Text style={s.emptyBody}>
            These places don't have coordinates yet.{'\n'}Try a different search area or category.
          </Text>
        </View>
      )}

      {/* ── Pin count badge (shown when there are pins) ───────────────────── */}
      {!noPins && (
        <View style={s.badge}>
          <MapPin size={10} color="#fff" />
          <Text style={s.badgeText}>
            {mappable.length} {mappable.length === 1 ? 'place' : 'places'}
          </Text>
        </View>
      )}

      {/* ── DEV-only diagnostic overlay ───────────────────────────────────── */}
      {__DEV__ && (
        <View style={s.debug} pointerEvents="none">
          <Text style={s.debugTitle}>MapDebug</Text>
          <Text style={s.debugLine}>mapMode: map</Text>
          <Text style={s.debugLine}>MapLibre mounted: true</Text>
          <Text style={s.debugLine}>containerWidth: {containerWidth.toFixed(0)}</Text>
          <Text style={s.debugLine}>containerHeight: {containerHeight.toFixed(0)}</Text>
          <Text style={s.debugLine}>styleURL exists: {Boolean(MAP_STYLE) ? 'yes' : 'NO'}</Text>
          <Text style={s.debugLine}>styleURL host: {STYLE_HOST}</Text>
          <Text style={s.debugLine}>MAPTILER_KEY exists: {Boolean(MAPTILER_KEY) ? 'yes' : 'NO ⚠'}</Text>
          <Text style={s.debugLine}>pinCount: {mappable.length}</Text>
          <Text style={s.debugLine}>platform: {Platform.OS}</Text>
          <Text style={s.debugLine}>mapLoaded: {mapLoaded ? 'yes' : 'no'}</Text>
          <Text style={s.debugLine}>styleLoaded: {styleLoaded ? 'yes' : 'no'}</Text>
          {mapError && (
            <Text style={[s.debugLine, s.debugError]}>error: {mapError}</Text>
          )}
          {!MAPTILER_KEY && (
            <Text style={[s.debugLine, s.debugError]}>MapTiler key missing — using demo tiles</Text>
          )}
        </View>
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root: {
    flex: 1,
    position: 'relative',
    minHeight: 300,
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
  noPinsOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xxl,
  },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    ...t.title,
    fontSize: 15,
    color: '#333',
    backgroundColor: 'rgba(255,255,255,0.85)',
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  emptyBody: {
    ...t.body,
    fontSize: 12,
    color: '#555',
    textAlign: 'center',
    backgroundColor: 'rgba(255,255,255,0.80)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badge: {
    position: 'absolute',
    bottom: 20,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  warnBanner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: '#f00',
    padding: 6,
    alignItems: 'center',
  },
  warnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  debug: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderRadius: 8,
    padding: 8,
    gap: 2,
    maxWidth: 220,
  },
  debugTitle: {
    color: '#0f0',
    fontSize: 10,
    fontWeight: '800',
    marginBottom: 3,
    letterSpacing: 1,
  },
  debugLine: {
    color: '#eee',
    fontSize: 9,
    fontFamily: 'monospace',
  },
  debugError: {
    color: '#f88',
    fontWeight: '700',
  },
});
