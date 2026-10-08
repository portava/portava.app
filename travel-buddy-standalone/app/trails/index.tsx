/**
 * Trails — browse and search Discovery Trails (owner decision 2026-10-04:
 * Trails are a user-facing feature). The behaviour is TrailsBrowser's.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppHeader } from '../../src/components/ui/AppHeader';
import { firstParam } from '../../src/lib/routeParams.ts';
import { TrailsBrowser } from '../../src/features/discovery/trails/TrailsBrowser.tsx';
import { color } from '../../src/theme/tokens';

export default function TrailsScreen() {
  const params = useLocalSearchParams<{ destination?: string | string[] }>();
  const destination = firstParam(params.destination) ?? null;
  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Trails" onBack={router.back} />
      <TrailsBrowser
        initialDestination={destination}
        onOpen={(id) => router.push(`/trails/${encodeURIComponent(id)}` as never)}
        onCreate={(d) => router.push((d ? `/trails/new?destination=${encodeURIComponent(d)}` : '/trails/new') as never)}
      />
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: color.paper } });
