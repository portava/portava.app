/**
 * /media-timeline — the §4 "Media Timeline / Time Rail" screen (census-media §19).
 *
 * ADDITIVE. With `placeId` (a canonical place UUID) the rail is place-scoped —
 * Now / Typical / Likely-Next can populate; without one it is the world's
 * observed Earlier / Now rail. The same screen is the Time mode of the World
 * shell's NOW and PLACES lenses.
 */
import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { color } from '../../src/theme/tokens.ts';
import { MediaTimelineScreen } from '../../src/features/media/screens/MediaTimelineScreen.tsx';

export default function MediaTimelineRoute() {
  const { placeId, label } = useLocalSearchParams<{ placeId?: string; label?: string }>();
  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <MediaTimelineScreen
          placeId={typeof placeId === 'string' ? placeId : null}
          label={typeof label === 'string' ? label : null}
          onOpenMedia={(m) => router.push(`/media-viewer/${encodeURIComponent(m.id)}` as never)}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ink },
  body: { flex: 1 },
});
