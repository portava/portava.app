/**
 * app/passport/plans.tsx
 *
 * Route wrapper for the standalone Plans Passport surface (spec §16).
 * The screen implementation lives in src/features/passport/PlansScreen.tsx;
 * this file resolves the viewed passport (`userId`/`username` param, absent for
 * the owner's own plans) and the signed-in viewer, then mounts the screen. The
 * root Stack renders headerShown:false, so PlansScreen draws its own header.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import PlansScreen from '../../src/features/passport/PlansScreen.tsx';
import { useSession } from '../../src/context/SessionContext.tsx';

export default function PlansRoute() {
  const params = useLocalSearchParams<{ userId?: string; username?: string }>();
  const { userId: viewerUserId } = useSession();

  const rawTarget = params.userId ?? params.username ?? null;
  // Accept either a UUID or an @handle; the projection endpoint resolves both.
  const targetUserId = rawTarget ? String(rawTarget).replace(/^@/, '') : null;

  return <PlansScreen targetUserId={targetUserId} viewerUserId={viewerUserId} />;
}
