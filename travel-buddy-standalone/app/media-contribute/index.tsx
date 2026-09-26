/**
 * /media-contribute?placeId=… — the §4 Media Contribution screen (census-media §19).
 *
 * ADDITIVE: reached from a place's current view in the World shell ("Add your
 * view") and by deep link. The device fix is handed over only when it is a
 * fresh GPS reading, and only as the private verification pair the post write
 * never projects.
 */
import React, { useCallback } from 'react';
import { StatusBar } from 'expo-status-bar';
import { View, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';

import { color } from '../../src/theme/tokens.ts';
import { useActiveLocation } from '../../src/hooks/useActiveLocation.ts';
import { useMediaPicker } from '../../src/hooks/useMediaPicker.ts';
import { MediaContributionScreen } from '../../src/features/media/screens/MediaContributionScreen.tsx';
import { LensStateView } from '../../src/features/media/components/LensStateView.tsx';

export default function MediaContributeRoute() {
  const { placeId } = useLocalSearchParams<{ placeId?: string }>();
  const { locationState } = useActiveLocation();
  const { pickMedia } = useMediaPicker();

  const deviceGps =
    locationState.ok && locationState.coords && locationState.source === 'gps_fresh'
      ? { lat: locationState.coords.lat, lng: locationState.coords.lng }
      : null;

  const pick = useCallback(async () => {
    const assets = await pickMedia({ title: 'Add your view', mediaTypes: ['images', 'videos'], videoMaxDuration: 60 });
    const a = assets?.[0];
    if (!a) return null;
    return {
      uri: a.uri,
      mimeType: a.mimeType ?? null,
      type: a.type ?? null,
      fileName: a.fileName ?? null,
      fileSize: a.fileSize ?? null,
      duration: a.duration != null ? a.duration / 1000 : null,
    };
  }, [pickMedia]);

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <StatusBar style="light" />
      <View style={styles.body}>
        {typeof placeId === 'string' && placeId ? (
          <MediaContributionScreen placeId={placeId} deviceGps={deviceGps} pickMedia={pick} onDone={() => router.back()} />
        ) : (
          <LensStateView status="error" title="No place to add to" message="Open a place first, then add your view of it." />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.ink },
  body: { flex: 1 },
});
