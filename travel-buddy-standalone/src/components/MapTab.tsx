import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Image, StyleSheet, ActivityIndicator } from 'react-native';
import type { PassportPostcard } from '../types/models.ts';
import type { PassportMapMarker, PassportMapPayload } from '../services/passportStamps.ts';
import { getPassportMap } from '../services/passportStamps.ts';
import { color, space, type as t } from '../theme/tokens.ts';
import { HighlightRing } from './HighlightRing.tsx';
import { HighlightViewer } from './HighlightViewer.tsx';
import { useHighlightRingState } from '../hooks/useHighlightRingState.ts';
import { listNearbyUsers, type NearbyUser } from '../services/map.ts';

/** Single nearby-traveler chip: avatar with HighlightRing + name label. */
function NearbyUserChip({ user }: { user: NearbyUser }) {
  const ringState = useHighlightRingState(user.id);
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <>
      <Pressable
        style={mp.chip}
        onPress={() => {
          if (ringState?.hasActive) setViewerOpen(true);
        }}
      >
        <HighlightRing
          hasActive={ringState?.hasActive ?? false}
          allViewed={ringState?.allViewed ?? false}
          size={44}
          ringWidth={2}
          gap={2}
          onPress={ringState?.hasActive ? () => setViewerOpen(true) : undefined}
        >
          {user.avatarUrl ? (
            <Image source={{ uri: user.avatarUrl }} style={mp.chipAvatar} />
          ) : (
            <View style={[mp.chipAvatar, mp.chipAvatarFallback]}>
              <Text style={mp.chipAvatarInitial}>
                {user.name.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
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

function verificationDot(level: string): string {
  if (level === 'gps') return '📍';
  if (level === 'checkin') return '✅';
  if (level === 'safe_return') return '🛡';
  if (level === 'crew') return '👥';
  return '○';
}

interface StampCityChipProps {
  marker: PassportMapMarker;
}

function StampCityChip({ marker }: StampCityChipProps) {
  return (
    <View style={[mp.cityChip, mp.chipVerified]}>
      <Text style={mp.verDot}>{verificationDot(marker.verificationLevel)}</Text>
      <Text style={mp.chipText}>{marker.city}</Text>
      {marker.stampCount > 1 && (
        <Text style={mp.countBadge}>×{marker.stampCount}</Text>
      )}
    </View>
  );
}

interface MapTabProps {
  postcards: PassportPostcard[];
  currentCity?: string | null;
  currentUserId?: string | null;
}

/** Map tab — city-level stamp markers + nearby traveler strip. Exact GPS is never shown. */
export function MapTab({ postcards, currentCity, currentUserId }: MapTabProps) {
  const [mapPayload, setMapPayload] = useState<PassportMapPayload | null>(null);
  const [mapLoading, setMapLoading] = useState(true);

  const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);

  // Load stamp-based map markers
  useEffect(() => {
    setMapLoading(true);
    getPassportMap()
      .then((res) => {
        if (res.ok) setMapPayload(res.data);
      })
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

  const showNearby = loadingNearby || nearbyUsers.length > 0;

  // Fallback: cities from postcards if API has no stamps yet
  const postcardCities = [...new Map(
    postcards
      .filter((c) => c.locationCity || c.locationName)
      .map((c) => [c.locationCity ?? c.locationName, c])
  ).entries()];

  const hasStampMarkers = (mapPayload?.markers.length ?? 0) > 0;
  const countries = mapPayload?.countries ?? [];
  const cities = mapPayload?.cities ?? [];

  return (
    <View style={mp.wrap}>
      {/* Map placeholder — city-level only, exact GPS never shown */}
      <View style={mp.placeholder}>
        <Text style={mp.placeholderIcon}>🗺️</Text>
        <Text style={mp.placeholderText}>Travel Map</Text>
        <Text style={mp.placeholderSub}>City-level only — exact GPS is never shown</Text>
        {!mapLoading && (countries.length > 0 || cities.length > 0) && (
          <View style={mp.mapSummary}>
            {countries.length > 0 && (
              <Text style={mp.mapStat}>{countries.length} {countries.length === 1 ? 'country' : 'countries'}</Text>
            )}
            {cities.length > 0 && (
              <Text style={mp.mapStat}>{cities.length} {cities.length === 1 ? 'city' : 'cities'}</Text>
            )}
          </View>
        )}
      </View>

      {/* Nearby Travelers strip */}
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

      {/* Stamp-based city markers */}
      {mapLoading && !hasStampMarkers ? (
        <View style={mp.loadingRow}>
          <ActivityIndicator size="small" color={color.signal} />
        </View>
      ) : hasStampMarkers ? (
        <>
          <Text style={mp.citiesLabel}>Stamp cities ({mapPayload!.markers.length})</Text>
          <View style={mp.chips}>
            {mapPayload!.markers.map((marker) => (
              <StampCityChip key={`${marker.country}|${marker.city}`} marker={marker} />
            ))}
          </View>
        </>
      ) : postcardCities.length > 0 ? (
        <>
          <Text style={mp.citiesLabel}>Postcard cities ({postcardCities.length})</Text>
          <View style={mp.chips}>
            {postcardCities.map(([city, card]) => (
              <View key={city} style={[mp.cityChip, card.locationVerified && mp.chipVerified]}>
                <Text style={mp.chipText}>{city}</Text>
                {card.locationVerified && <Text style={mp.chipBadge}>✓</Text>}
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const mp = StyleSheet.create({
  wrap: { paddingHorizontal: space.lg, paddingTop: space.md },
  placeholder: {
    height: 200, backgroundColor: color.paperRaised, borderRadius: 12,
    borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center', gap: 8,
    marginBottom: space.lg,
  },
  placeholderIcon: { fontSize: 48 },
  placeholderText: { ...t.bodyStrong, color: color.ink },
  placeholderSub: { ...t.small, color: color.mute },
  mapSummary: { flexDirection: 'row', gap: 12, marginTop: 4 },
  mapStat: { ...t.small, color: color.signal, fontWeight: '700' },

  sectionLabel: { ...t.heading, color: color.ink, marginBottom: space.sm },
  loadingRow: { height: 72, justifyContent: 'center', alignItems: 'center', marginBottom: space.lg },
  nearbyStrip: { gap: space.md, paddingBottom: space.lg, paddingRight: space.md },
  chip: { alignItems: 'center', gap: 4, width: 60 },
  chipAvatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: color.haze },
  chipAvatarFallback: { justifyContent: 'center', alignItems: 'center', backgroundColor: color.haze },
  chipAvatarInitial: { fontSize: 18, fontWeight: '600', color: color.deep },
  chipName: { ...t.small, color: color.ink, fontWeight: '600', fontSize: 10, textAlign: 'center' },

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
  chipBadge: { fontSize: 10, color: color.success },
  verDot: { fontSize: 11 },
  countBadge: { ...t.small, color: color.mute, fontWeight: '700', fontSize: 10 },
});
