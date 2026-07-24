/**
 * Place detail screen — /place/[id]
 *
 * Fetches the canonical place envelope from the API and renders PlaceCard
 * plus the standard MapEntityActionRow. Behind the `external_places_enabled`
 * flag — when the flag is OFF (or the fetch returns null for any reason) a
 * short "Place not available" message is shown instead.
 */
import React, { useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, ActivityIndicator, Pressable,
} from 'react-native';
import { useLocalSearchParams, useNavigation, Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Flag } from 'lucide-react-native';
import { color, space, type as t } from '../../src/theme/tokens';
import { getCanonicalPlace } from '../../src/services/places';
import { PlaceCard } from '../../src/components/place/PlaceCard';
import { PlaceReportSheet } from '../../src/components/PlaceReportSheet';
import { MapEntityActionRow } from '../../src/components/map/MapEntityActionRow';
import { PlainBottomFiller } from '../../src/hooks/useBottomInset';
import type { CanonicalPlace } from '../../src/types/canonicalPlace';
import type { MapEntity } from '../../src/types/mapTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a synthetic MapEntity from the canonical place envelope so
 * MapEntityActionRow can render Save · Directions · Add to Trip · Share.
 */
function buildMapEntity(place: CanonicalPlace): MapEntity {
  return {
    id:   place.id,
    type: 'places',
    lat:  place.coordinates.lat,
    lng:  place.coordinates.lng,
    payload: {
      id:       place.id,
      name:     place.name,
      category: place.category,
      address:  place.address,
      city:     place.city,
      lat:      place.coordinates.lat,
      lng:      place.coordinates.lng,
      rating:   place.rating ?? null,
    },
    detailRoute: place.detailRoute,
    actionCapabilities: ['save', 'directions', 'add_to_trip', 'share'],
  };
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function PlaceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const [place, setPlace]           = useState<CanonicalPlace | null | undefined>(undefined);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    if (!id) { setPlace(null); return; }
    void getCanonicalPlace(id).then(setPlace);
  }, [id]);

  // Loading
  if (place === undefined) {
    return (
      <>
        <Stack.Screen options={{ title: 'Place' }} />
        <View style={ps.centered}>
          <ActivityIndicator size="large" color={color.signal} />
        </View>
      </>
    );
  }

  // Flag off or not found
  if (place === null) {
    return (
      <>
        <Stack.Screen options={{ title: 'Place' }} />
        <View style={ps.centered}>
          <Text style={ps.notAvailableTitle}>Place not available</Text>
          <Text style={ps.notAvailableSub}>
            This place can't be shown right now.
          </Text>
        </View>
      </>
    );
  }

  const entity = buildMapEntity(place);

  return (
    <>
      <Stack.Screen options={{ title: place.name }} />

      <SafeAreaView style={ps.safeArea} edges={['bottom']}>
        <ScrollView style={ps.scroll} contentContainerStyle={ps.scrollContent}>
          {/* Main place card */}
          <PlaceCard place={place} />

          {/* Action row: Save · Directions · Add to Trip · Share */}
          <View style={ps.actionRowWrap}>
            <MapEntityActionRow entity={entity} />
          </View>

          {/* Report button */}
          <Pressable
            testID="place-detail-report-btn"
            style={ps.reportBtn}
            onPress={() => setReportOpen(true)}
          >
            <Flag size={14} color={color.faint} />
            <Text style={ps.reportBtnLabel}>Report a problem with this place</Text>
          </Pressable>

          <PlainBottomFiller />
        </ScrollView>
      </SafeAreaView>

      {/* Place report sheet */}
      <PlaceReportSheet
        visible={reportOpen}
        onClose={() => setReportOpen(false)}
        placeId={place.id}
        placeName={place.name}
      />
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const ps = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: color.paper,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: space.md,
    paddingBottom: space.xl,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  notAvailableTitle: {
    ...t.bodyStrong,
    fontSize: 18,
    color: color.ink,
    marginBottom: space.sm,
    textAlign: 'center',
  },
  notAvailableSub: {
    ...t.body,
    color: color.mute,
    textAlign: 'center',
  },
  actionRowWrap: {
    backgroundColor: color.paperRaised,
    borderRadius: 12,
    padding: space.md,
    marginBottom: space.md,
  },
  reportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: space.sm,
    alignSelf: 'center',
  },
  reportBtnLabel: {
    ...t.small,
    color: color.faint,
    fontSize: 12,
  },
});
