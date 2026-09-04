/**
 * app/passport/journeys.tsx
 *
 * Route wrapper for the standalone "Journeys" Passport surface (spec §14).
 * The screen implementation lives in src/features/passport/JourneysScreen.tsx;
 * this file resolves the viewed passport (`userId`/`username` param, absent for
 * the owner's own journeys) and mounts it. The root Stack renders
 * headerShown:false, so JourneysScreen draws its own header. The journeys
 * endpoint (`GET /passport/:userId/journeys`) does the per-viewer privacy
 * projection, so a viewer sees only the permitted history.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import JourneysScreen from '../../src/features/passport/JourneysScreen.tsx';
import { readViewerUserParam } from '../../src/features/passport/passportNav.ts';

export default function JourneysRoute() {
  const params = useLocalSearchParams<{ userId?: string; username?: string }>();
  const targetUserId = readViewerUserParam(params.userId ?? params.username);
  return <JourneysScreen targetUserId={targetUserId} />;
}
