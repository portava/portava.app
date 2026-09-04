/**
 * app/passport/travel-identity.tsx
 *
 * Route wrapper for the standalone "Travel Identity" Passport surface (spec §19).
 * The screen implementation lives in src/features/passport/TravelIdentityScreen.tsx;
 * this file resolves the viewed passport (`userId`/`username` param, absent for
 * the owner's own identity) and mounts it. The root Stack renders
 * headerShown:false, so TravelIdentityScreen draws its own header. A viewer
 * projection is read-only — the screen hides the Show/Hide/Not-Me controls
 * (§19/§30); only the owner's own view is editable.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import TravelIdentityScreen from '../../src/features/passport/TravelIdentityScreen.tsx';
import { readViewerUserParam } from '../../src/features/passport/passportNav.ts';

export default function TravelIdentityRoute() {
  const params = useLocalSearchParams<{ userId?: string; username?: string }>();
  const targetUserId = readViewerUserParam(params.userId ?? params.username);
  return <TravelIdentityScreen targetUserId={targetUserId} />;
}
