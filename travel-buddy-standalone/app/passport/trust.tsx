/**
 * app/passport/trust.tsx
 *
 * Route wrapper for the Passport "Trust & Credentials" surface (spec §9/§10/§11).
 * The screen implementation lives in src/features/passport/TrustScreen.tsx; this
 * file resolves the viewed passport (`userId`/`username` param, absent for the
 * owner's own trust) and mounts it. The root Stack renders headerShown:false, so
 * TrustScreen draws its own header. `GET /passport/:userId/projection` already
 * does the per-viewer trust projection (§4/§30), so a viewer sees only what the
 * server permits.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import TrustScreen from '../../src/features/passport/TrustScreen.tsx';
import { readViewerUserParam } from '../../src/features/passport/passportNav.ts';

export default function TrustRoute() {
  const params = useLocalSearchParams<{ userId?: string; username?: string }>();
  const targetUserId = readViewerUserParam(params.userId ?? params.username);
  return <TrustScreen userId={targetUserId ?? undefined} />;
}
