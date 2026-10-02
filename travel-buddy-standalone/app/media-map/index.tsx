/**
 * /media-map — the §4 / §21 Media Map screen (census-media §19).
 *
 * ADDITIVE, like /media-world: it is reached from the World shell and by deep
 * link, and nothing on the existing Watch/Grid/Gems tab changes. The viewport
 * centre is the viewer's coarse active location; with none, the screen lists
 * places by perspective count and says why nothing is placed.
 *
 * Opening a cluster stages the §14 MAP entry context — "current geographic
 * cluster" — and routes to the contextual perspective viewer
 * (`openClusterPerspectives`).
 */
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { color } from '../../src/theme/tokens.ts';
import { useActiveLocation } from '../../src/hooks/useActiveLocation.ts';
import { MediaMapScreen } from '../../src/features/media/screens/MediaMapScreen.tsx';
import { openClusterPerspectives } from '../../src/features/media/services/perspectiveOpeners.ts';

export default function MediaMapRoute() {
  const { locationState } = useActiveLocation();
  const center = locationState.ok && locationState.coords
    ? { lat: locationState.coords.lat, lng: locationState.coords.lng }
    : null;
  const city = locationState.place?.city ?? locationState.place?.name ?? null;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <MediaMapScreen
          city={city}
          center={center}
          includeGems
          onOpenCluster={(cluster) => void openClusterPerspectives(cluster)}
          onOpenGem={(gemId) => router.push(`/gems/${encodeURIComponent(gemId)}` as never)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ink },
  body: { flex: 1 },
});
