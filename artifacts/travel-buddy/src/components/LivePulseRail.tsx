/**
 * LivePulseRail — horizontal strip of live-event cards pinned just below the
 * Pulse header. Renders nothing when there are no live items.
 */
import React from 'react';
import { View } from 'react-native';
import type { UseLivePulseResult } from '../hooks/useLivePulse.ts';

interface LivePulseRailProps {
  pulse: UseLivePulseResult;
}

export function LivePulseRail({ pulse: _pulse }: LivePulseRailProps) {
  // Placeholder: future implementation will render a horizontal FlatList of
  // live-event cards using pulse.items.
  return <View />;
}
