/**
 * One Discovery Trail (owner decision 2026-10-04). The behaviour is
 * TrailDetailView's; this screen supplies the id and navigation.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppHeader } from '../../src/components/ui/AppHeader';
import { firstParam } from '../../src/lib/routeParams.ts';
import { TrailDetailView } from '../../src/features/discovery/trails/TrailDetailView.tsx';
import { color } from '../../src/theme/tokens';

export default function TrailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = firstParam(params.id) ?? '';
  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Trail" onBack={router.back} />
      {id ? <TrailDetailView trailId={id} onNavigate={(href) => router.push(href as never)} /> : null}
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: color.paper } });
