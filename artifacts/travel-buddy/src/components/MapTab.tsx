import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Image, StyleSheet, ActivityIndicator } from 'react-native';
import type { PassportPostcard } from '../types/models';
import { color, space, type as t } from '../theme/tokens';
import { HighlightRing } from './HighlightRing';
import { HighlightViewer } from './HighlightViewer';
import { useHighlightRingState } from '../hooks/useHighlightRingState';
import { listNearbyUsers, type NearbyUser } from '../services/map';

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

interface MapTabProps {
  postcards: PassportPostcard[];
  currentCity?: string | null;
  currentUserId?: string | null;
}

/** Map tab — placeholder with city-level location grid. No exact GPS exposed. */
export function MapTab({ postcards, currentCity, currentUserId }: MapTabProps) {
  const withLocation = postcards.filter((c) => c.locationCity || c.locationName);
  const cities = [...new Map(withLocation.map((c) => [c.locationCity ?? c.locationName, c])).entries()];

  const [nearbyUsers, setNearbyUsers] = useState<NearbyUser[]>([]);
  const [loadingNearby, setLoadingNearby] = useState(false);

  useEffect(() => {
    if (!currentCity || !currentUserId) return;
    setLoadingNearby(true);
    listNearbyUsers(currentCity, currentUserId)
      .then(setNearbyUsers)
      .catch(() => setNearbyUsers([]))
      .finally(() => setLoadingNearby(false));
  }, [currentCity, currentUserId]);

  const showNearby = loadingNearby || nearbyUsers.length > 0;

  return (
    <View style={mp.wrap}>
      <View style={mp.placeholder}>
        <Text style={mp.placeholderIcon}>🗺️</Text>
        <Text style={mp.placeholderText}>Interactive map coming soon</Text>
        <Text style={mp.placeholderSub}>City-level only — exact GPS is never shown</Text>
      </View>

      {/* Nearby Travelers strip — only shown when there's real data or loading */}
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

      {cities.length > 0 && (
        <>
          <Text style={mp.citiesLabel}>Postcard cities ({cities.length})</Text>
          <View style={mp.chips}>
            {cities.map(([city, card]) => (
              <View key={city} style={[mp.cityChip, card.locationVerified && mp.chipVerified]}>
                <Text style={mp.chipText}>{city}</Text>
                {card.locationVerified && <Text style={mp.chipBadge}>✓</Text>}
              </View>
            ))}
          </View>
        </>
      )}
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
});
