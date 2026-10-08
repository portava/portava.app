/**
 * Trending — what is gaining travel relevance in a city now (owner decision
 * 2026-10-04: Trending is a user-facing feature). The behaviour is
 * TrendingView's; behind the server's two trending flags, it says Trending is
 * not available until they are on.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppHeader } from '../src/components/ui/AppHeader';
import { firstParam } from '../src/lib/routeParams.ts';
import { TrendingView } from '../src/features/discovery/trending/TrendingView.tsx';
import { color } from '../src/theme/tokens';

export default function TrendingScreen() {
  const params = useLocalSearchParams<{ destination?: string | string[] }>();
  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Trending" onBack={router.back} />
      <TrendingView initialDestination={firstParam(params.destination) ?? null} onNavigate={(href) => router.push(href as never)} />
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: color.paper } });
