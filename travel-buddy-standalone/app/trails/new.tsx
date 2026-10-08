/**
 * Start a Discovery Trail (owner decision 2026-10-04). The behaviour is
 * TrailCreateForm's; a created Trail opens in place of this screen.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppHeader } from '../../src/components/ui/AppHeader';
import { firstParam } from '../../src/lib/routeParams.ts';
import { TrailCreateForm } from '../../src/features/discovery/trails/TrailCreateForm.tsx';
import { color } from '../../src/theme/tokens';

export default function NewTrailScreen() {
  const params = useLocalSearchParams<{ destination?: string | string[] }>();
  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Start a Trail" onBack={router.back} />
      <TrailCreateForm
        initialDestination={firstParam(params.destination) ?? null}
        onCreated={(trail) => router.replace(`/trails/${encodeURIComponent(trail.id)}` as never)}
      />
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: color.paper } });
