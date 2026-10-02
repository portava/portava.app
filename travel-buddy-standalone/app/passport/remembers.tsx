/**
 * app/passport/remembers.tsx
 *
 * Route wrapper for "Compass remembers" — the owner's private §12 view of what
 * Portava remembers, with Forget and Correct (testing-mode WP-12, COMP-F16).
 * The screen lives in src/features/passport/CompassRemembersScreen.tsx and
 * draws its own header (the root Stack renders headerShown: false).
 */
import React from 'react';
import CompassRemembersScreen from '../../src/features/passport/CompassRemembersScreen.tsx';

export default function PassportRemembersRoute() {
  return <CompassRemembersScreen />;
}
