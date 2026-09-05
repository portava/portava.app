import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { JourneyDecisionPanel } from '../../src/components/map/JourneyDecisionPanel.tsx';

/**
 * Trip → "Deciding together" (Map spec §36 Phase 6).
 *
 * A thin wrapper, like app/trip/chat.tsx: the shortlist, the accept/decline and
 * the recovery list all live in the panel, and every decision they render was
 * made on the server behind `map_journey_intelligence_enabled` (OFF by default,
 * migration 2296).
 */
export default function TripJourneyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tripId = id ?? '';

  return (
    <View style={s.root}>
      <JourneyDecisionPanel tripId={tripId} />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
});
