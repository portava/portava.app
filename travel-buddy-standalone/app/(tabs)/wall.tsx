/**
 * (tabs)/wall — the Wall route (Wall spec §3/§29).
 *
 * Mounts the Wall client shell. The Wall is flag-gated OFF server-side, so this
 * route is added NON-DISRUPTIVELY: it does not replace the Pulse landing tab and
 * its tab-bar entry is hidden (href: null in the tabs layout). It is reachable
 * as a secondary surface (deep-link / push) until the server flag is turned on.
 *
 * This route file owns the two environment dependencies (safe-area insets and
 * the current city from LocationContext) and passes them to WallScreen, which
 * stays free of those so it can be unit-tested in isolation.
 */

import React from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import { WallScreen } from '../../src/features/wall/components/WallScreen.tsx';
import { useLocationContext } from '../../src/context/LocationContext';

export default function WallRoute() {
  const insets = useSafeAreaInsets();
  const { locationState } = useLocationContext();
  const city = locationState.place.city ?? null;

  return (
    <ScreenErrorBoundary>
      <WallScreen city={city} topInset={insets.top} />
    </ScreenErrorBoundary>
  );
}
