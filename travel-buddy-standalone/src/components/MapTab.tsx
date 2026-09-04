/**
 * MapTab — Passport travel map.
 *
 * Renders a live MapLibre world map with country-level stamp markers.
 * Markers are placed at country centroids — exact GPS is never shown.
 *
 * Requires: @maplibre/maplibre-react-native + EAS dev build.
 * Style: MapTiler Streets when EXPO_PUBLIC_MAPTILER_KEY is set, else demo tiles.
 */
import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, Pressable, ScrollView,
  StyleSheet, ActivityIndicator,
} from 'react-native';
import { Avatar } from './ui/Avatar.tsx';
import { router } from 'expo-router';
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const _ml: any = (() => { try { return require('@maplibre/maplibre-react-native'); } catch { return {}; } })();
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { Map: MapView, Camera, Marker } = _ml as typeof import('@maplibre/maplibre-react-native');
import type { CameraRef, LngLatBounds } from '@maplibre/maplibre-react-native';
import type { PassportPostcard } from '../types/models.ts';
import type { PassportMapPayload } from '../services/passportStamps.ts';
import type { PostcardsSentinel } from '../services/profile.ts';
import { getPassportMap } from '../services/passportStamps.ts';
import { Lock, Ban, EyeOff } from 'lucide-react-native';
import { color, space, radius, type as t, avatar } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { listNearbyUsers, type NearbyUser } from '../services/map.ts';
import { COUNTRY_CENTROIDS } from '../lib/countryCentroids.ts';

// ── Map style ──────────────────────────────────────────────────────────────────

import { MAP_STYLE_URL, FALLBACK_MAP_STYLE_URL } from '../constants/mapStyle.ts';
const MAP_STYLE = MAP_STYLE_URL;

// ── Country-level aggregation ─────────────────────────────────────────────────

interface CountryPinData {
  country: string;
  lat: number;
  lng: number;
  stampCount: number;
  cities: string[];
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NearbyUserChip({ user }: { user: NearbyUser }) {
  const ringState = useHighlightRingState(user.id);
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <>
      <Pressable
        style={mp.chip}
        onPress={() => { if (ringState?.hasActive) setViewerOpen(true); }}
      >
        <HighlightRing
          hasActive={ringState?.hasActive ?? false}
          allViewed={ringState?.allViewed ?? false}
          size={44}
          ringWidth={2}
          gap={2}
          onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
        >
          <Avatar uri={user.avatarUrl} name={user.name} size={44} />
        </HighlightRing>
        <Text style={mp.chipName} numberOfLines={1}>
          {user.name.split(' ')[0]}
        </Text>
      </Pressable>
      {ringState?.highlights && (
        <HighlightViewer
          visible={viewerOpen}
          highlights={ringState.highlights}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}

interface CountryPinBadgeProps {
  count: number;
  selected: boolean;
  onPress: () => void;
}

function CountryPinBadge({ count, selected, onPress }: CountryPinBadgeProps) {
  return (
    <Pressable onPress={onPress} hitSlop={12}>
      <View style={[pin.wrap, selected && pin.selected]}>
        <Text style={[pin.label, selected && pin.labelSelected]}>
          {count > 99 ? '99+' : String(count)}
        </Text>
      </View>
    </Pressable>
  );
}

function verificationDot(level: string): string {
  if (level === 'gps') return '📍';
  if (level === 'checkin') return '✅';
  if (level === 'safe_return') return '🛡';
  if (level === 'crew') return '👥';
  return '○';
}

// ── Main component ────────────────────────────────────────────────────────────

// ── Sentinel copy (mirrors PostcardsTab for consistency) ─────────────────────

const MAP_SENTINEL_COPY: Record<PostcardsSentinel, { Icon: React.ComponentType<any>; title: string; body: string }> = {
  private: {
    Icon: Lock,
    title: 'Private passport',
    body: 'This passport is private. Follow this traveler to see their travel map.',
  },
  blocked: {
    Icon: Ban,
    title: 'Map unavailable',
    body: 'Travel map content is not available.',
  },
  unavailable: {
    Icon: EyeOff,
    title: 'Account unavailable',
    body: 'This account is no longer available.',
  },
};

function MapSentinelView({ kind }: { kind: PostcardsSentinel }) {
  const { Icon, title, body } = MAP_SENTINEL_COPY[kind];
  return (
    <View style={sv.root} accessibilityRole="text" accessibilityLabel={title}>
      <View style={sv.iconWrap}>
        <Icon size={28} color={color.mute} strokeWidth={1.6} />
      </View>
      <Text style={sv.title}>{title}</Text>
      <Text style={sv.body}>{body}</Text>
    </View>
  );
}

export interface MapTabProps {
  postcards: PassportPostcard[];
  currentCity?: string | null;
  currentUserId?: string | null;
  /** Sentinel returned by the postcards endpoint — renders a graceful state instead of the map. */
  sentinel?: PostcardsSentinel;
}

/** Passport travel map — country-level markers, nearby travellers, stamp city list. */
export function MapTab({ postcards, currentCity, currentUserId, sentinel }: MapTabProps) {
  const cameraRef = useRef<CameraRef>(null);
  const [mapPayload, setMapPayload] = useState<PassportMapPayload | null>(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [selectedCountry, setSelectedCountry] = useState<string | null>(null);

  const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);
  const [mapStyle, setMapStyle] = useState(MAP_STYLE);

  // Load stamp-based map markers
  useEffect(() => {
    setMapLoading(true);
    getPassportMap()
      .then((res) => { if (res.ok) setMapPayload(res.data); })
      .catch(() => {})
      .finally(() => setMapLoading(false));
  }, []);

  // Load nearby users
  useEffect(() => {
    if (!currentCity || !currentUserId) return;
    setLoadingNearby(true);
    listNearbyUsers(currentCity, currentUserId)
      .then(setNearbyUsers)
      .catch(() => setNearbyUsers([]))
      .finally(() => setLoadingNearby(false));
  }, [currentCity, currentUserId]);

  // Aggregate markers into one pin per country (with centroid lookup)
  const countryPins = useMemo<CountryPinData[]>(() => {
    if (!mapPayload) return [];
    const byCountry = new Map<string, { stampCount: number; cities: Set<string> }>();
    for (const m of mapPayload.markers) {
      const existing = byCountry.get(m.country) ?? { stampCount: 0, cities: new Set<string>() };
      existing.stampCount += m.stampCount;
      existing.cities.add(m.city);
      byCountry.set(m.country, existing);
    }
    const pins: CountryPinData[] = [];
    for (const [country, data] of byCountry) {
      const centroid = COUNTRY_CENTROIDS[country];
      if (!centroid) continue; // no centroid for this country name — skip silently
      pins.push({
        country,
        lat: centroid[0],
        lng: centroid[1],
        stampCount: data.stampCount,
        cities: [...data.cities].sort(),
      });
    }
    return pins;
  }, [mapPayload]);

  // Fit camera to all country pins whenever they load
  useEffect(() => {
    if (!cameraRef.current || countryPins.length === 0) return;
    const lats = countryPins.map((p) => p.lat);
    const lngs = countryPins.map((p) => p.lng);
    const pad = 10;
    // LngLatBounds = [west, south, east, north]
    const bounds: LngLatBounds = [
      Math.min(...lngs) - pad,
      Math.min(...lats) - pad,
      Math.max(...lngs) + pad,
      Math.max(...lats) + pad,
    ];
    cameraRef.current.fitBounds(
      bounds,
      { padding: { top: 40, right: 20, bottom: 40, left: 20 }, duration: 600 },
    );
  }, [countryPins]);

  const selectedPin = countryPins.find((p) => p.country === selectedCountry) ?? null;
  const showNearby = loadingNearby || nearbyUsers.length > 0;
  const hasMarkers = countryPins.length > 0;

  // Sentinel takes precedence — show a graceful state instead of the map.
  if (sentinel) return <MapSentinelView kind={sentinel} />;

  return (
    <View style={mp.wrap}>

      {/* ── Interactive travel map ─────────────────────────────────────────── */}
      <View style={mp.mapWrap}>
        {/* Full-screen map button */}
        <Pressable
          style={mp.fullMapBtn}
          onPress={() => router.push('/map?entityTypes=stamps&mode=passport&entry=passport' as any)}
          hitSlop={4}
        >
          <Text style={mp.fullMapBtnText}>Open full map</Text>
        </Pressable>
        {mapLoading && (
          <View style={mp.mapLoader}>
            <ActivityIndicator size="small" color={color.signal} />
          </View>
        )}
        <MapView
          mapStyle={mapStyle}
          style={mp.mapView}
          onDidFailLoadingMap={() => { if (mapStyle !== FALLBACK_MAP_STYLE_URL) setMapStyle(FALLBACK_MAP_STYLE_URL); }}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{ center: [10, 20], zoom: 1.2 }}
          />
          {countryPins.map((pin) => (
            <Marker
              key={pin.country}
              lngLat={[pin.lng, pin.lat]}
            >
              <CountryPinBadge
                count={pin.stampCount}
                selected={selectedCountry === pin.country}
                onPress={() =>
                  setSelectedCountry((prev) =>
                    prev === pin.country ? null : pin.country,
                  )
                }
              />
            </Marker>
          ))}
        </MapView>

        {/* Privacy label */}
        <View style={mp.privacyLabel} pointerEvents="none">
          <Text style={mp.privacyText}>City-level only · GPS never shown</Text>
        </View>

        {/* Empty-state overlay */}
        {!mapLoading && !hasMarkers && (
          <View style={mp.emptyOverlay} pointerEvents="none">
            <Text style={mp.emptyIcon}>🗺️</Text>
            <Text style={mp.emptyTitle}>No stamps yet</Text>
            <Text style={mp.emptySub}>Earn stamps to see your travel map</Text>
          </View>
        )}
      </View>

      {/* ── Selected country callout ───────────────────────────────────────── */}
      {selectedPin && (
        <View style={mp.callout}>
          <View style={mp.calloutLeft}>
            <Text style={mp.calloutCountry}>{selectedPin.country}</Text>
            <Text style={mp.calloutDetail}>
              {selectedPin.stampCount} stamp{selectedPin.stampCount !== 1 ? 's' : ''}
              {selectedPin.cities.length > 0
                ? ` · ${selectedPin.cities.slice(0, 3).join(', ')}${selectedPin.cities.length > 3 ? ` +${selectedPin.cities.length - 3}` : ''}`
                : ''}
            </Text>
          </View>
          <Pressable onPress={() => setSelectedCountry(null)} hitSlop={8} style={mp.calloutClose}>
            <Text style={mp.calloutCloseText}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      {!mapLoading && (mapPayload?.countries.length ?? 0) > 0 && (
        <View style={mp.statsRow}>
          <View style={mp.statChip}>
            <Text style={mp.statNum}>{mapPayload!.countries.length}</Text>
            <Text style={mp.statLabel}>
              {mapPayload!.countries.length === 1 ? 'country' : 'countries'}
            </Text>
          </View>
          <View style={mp.statDivider} />
          <View style={mp.statChip}>
            <Text style={mp.statNum}>{mapPayload!.cities.length}</Text>
            <Text style={mp.statLabel}>
              {mapPayload!.cities.length === 1 ? 'city' : 'cities'}
            </Text>
          </View>
        </View>
      )}

      {/* ── Nearby Travelers strip ─────────────────────────────────────────── */}
      {showNearby && (
        <>
          <Text style={mp.sectionLabel}>
            Nearby Travelers{currentCity ? ` in ${currentCity}` : ''}
          </Text>
          {loadingNearby ? (
            <View style={mp.loadingRow}>
              <ActivityIndicator size="small" color={color.deep} />
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={mp.nearbyStrip}
            >
              {nearbyUsers.map((u) => (
                <NearbyUserChip key={u.id} user={u} />
              ))}
            </ScrollView>
          )}
        </>
      )}

      {/* ── Stamp city list ───────────────────────────────────────────────── */}
      {(mapPayload?.markers.length ?? 0) > 0 && (
        <>
          <Text style={mp.citiesLabel}>
            Stamp cities ({mapPayload!.markers.length})
          </Text>
          <View style={mp.chips}>
            {mapPayload!.markers.map((m, i) => (
              <View
                key={`${m.country}-${m.city}-${i}`}
                style={[mp.cityChip, mp.chipVerified]}
              >
                <Text style={mp.verDot}>{verificationDot(m.verificationLevel)}</Text>
                <Text style={mp.chipText}>{m.city}</Text>
                {m.stampCount > 1 && (
                  <Text style={mp.countBadge}>×{m.stampCount}</Text>
                )}
              </View>
            ))}
          </View>
        </>
      )}

    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const sv = StyleSheet.create({
  root: {
    paddingVertical: space.xxxl,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    gap: space.sm,
  },
  iconWrap: {
    width: avatar.s56, height: avatar.s56, borderRadius: avatar.s56 / 2,
    backgroundColor: color.haze,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  title: { ...t.bodyStrong, color: color.ink, textAlign: 'center' },
  body: { ...t.small, color: color.mute, textAlign: 'center', maxWidth: 260 },
});

const pin = StyleSheet.create({
  wrap: {
    minWidth: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.signal,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 4,
  },
  selected: {
    backgroundColor: color.deep,
    minWidth: 36,
    height: 36,
    borderRadius: 18,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  labelSelected: {
    fontSize: 13,
  },
});

const mp = StyleSheet.create({
  wrap: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxl,
  },

  // Map
  mapWrap: {
    height: 280,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: color.haze,
    marginBottom: space.sm,
    backgroundColor: color.paperRaised,
  },
  mapView: {
    flex: 1,
  },
  mapLoader: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
    backgroundColor: `${color.paperRaised}CC`,
  },
  fullMapBtn: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 20,
    backgroundColor: 'rgba(10,61,74,0.82)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  fullMapBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },
  privacyLabel: {
    position: 'absolute',
    bottom: 6,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  privacyText: {
    fontSize: 9,
    color: '#fff',
    fontWeight: '500',
  },
  emptyOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { ...t.bodyStrong, color: color.mute },
  emptySub: { ...t.small, color: color.faint, textAlign: 'center' },

  // Selected country callout
  callout: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.paperRaised,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: 10,
    marginBottom: space.md,
    gap: space.sm,
  },
  calloutLeft: { flex: 1 },
  calloutCountry: { ...t.bodyStrong, color: color.ink, fontSize: 14 },
  calloutDetail: { ...t.small, color: color.mute, marginTop: 1 },
  calloutClose: { padding: 4 },
  calloutCloseText: { fontSize: 14, color: color.faint },

  // Stats row
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
    paddingVertical: space.sm,
    marginBottom: space.sm,
  },
  statChip: { alignItems: 'center' },
  statNum: { ...t.heading, color: color.ink, fontSize: 20 },
  statLabel: { ...t.small, color: color.mute, textTransform: 'uppercase', letterSpacing: 0.5 },
  statDivider: { width: 1, height: 28, backgroundColor: color.haze },

  // Nearby strip
  sectionLabel: { ...t.heading, color: color.ink, marginBottom: space.sm },
  loadingRow: { height: 72, justifyContent: 'center', alignItems: 'center', marginBottom: space.lg },
  nearbyStrip: { gap: space.md, paddingBottom: space.lg, paddingRight: space.md },
  chip: { alignItems: 'center', gap: 4, width: 60 },
  chipName: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 10, textAlign: 'center' },

  // City chips
  citiesLabel: { ...t.heading, color: color.ink, marginBottom: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cityChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: color.paperRaised, borderRadius: 20,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  chipVerified: { borderColor: color.success, backgroundColor: '#E3F1EA' },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  verDot: { fontSize: 11 },
  countBadge: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 10 },
});
