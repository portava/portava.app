/**
 * (tabs)/wall — the Wall route (Wall spec §3/§29).
 *
 * Mounts the canonical Wall client shell; availability is decided by the server.
 *
 * This route file owns the two environment dependencies (safe-area insets and
 * the current city from LocationContext) and passes them to WallScreen, which
 * stays free of those so it can be unit-tested in isolation.
 */

import React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import { WallScreen } from '../../src/features/wall/components/WallScreen.tsx';
import { useLocationContext } from '../../src/context/LocationContext';
import { usePlanPicker } from '../../src/components/PlanPickerController.tsx';

export default function WallRoute() {
  const active = useIsFocused();
  const insets = useSafeAreaInsets();
  const { locationState } = useLocationContext();
  const city = locationState.place.city ?? null;
  const { open: openPlanPicker } = usePlanPicker();

  return (
    <ScreenErrorBoundary>
      <WallScreen active={active} city={city} topInset={insets.top} openPlanPicker={openPlanPicker} />
    </ScreenErrorBoundary>
  );
}
