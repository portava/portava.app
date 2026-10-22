/**
 * Start a Discovery Trail (owner decision 2026-10-04). The behaviour is
 * TrailCreateForm's; a created Trail opens in place of this screen.
 *
 * Lead ruling D-66: POST /api/v1/discovery/trails refuses every proposal while
 * `trail_creation_enabled` is off (it is off in production, 2026-10-22). The
 * traveller filled the whole form before learning that, so with the flag off
 * the screen says so up front instead of offering the form.
 */
import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';

import { AppHeader } from '../../src/components/ui/AppHeader';
import { firstParam } from '../../src/lib/routeParams.ts';
import { TrailCreateForm } from '../../src/features/discovery/trails/TrailCreateForm.tsx';
import { ds } from '../../src/features/discovery/shared/discoveryStyles.ts';
import { useFeatureFlags } from '../../src/context/FeatureFlagsContext.tsx';
import { color, space } from '../../src/theme/tokens';

export default function NewTrailScreen() {
  const params = useLocalSearchParams<{ destination?: string | string[] }>();
  const { isEnabled, loading } = useFeatureFlags();
  return (
    <View style={s.root}>
      <AppHeader variant="detail" title="Start a Trail" onBack={router.back} />
      {loading ? (
        <ActivityIndicator style={{ margin: space.xl }} color={color.signal} testID="trail-create-flags-loading" />
      ) : !isEnabled('trail_creation_enabled') ? (
        <Text style={ds.notice} testID="trail-create-off">Starting a Trail isn&apos;t available yet.</Text>
      ) : (
        <TrailCreateForm
          initialDestination={firstParam(params.destination) ?? null}
          onCreated={(trail) => router.replace(`/trails/${encodeURIComponent(trail.id)}` as never)}
        />
      )}
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: color.paper } });
