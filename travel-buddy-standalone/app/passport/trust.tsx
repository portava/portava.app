/**
 * app/passport/trust.tsx
 *
 * Route wrapper for the Passport "Trust & Credentials" surface (spec §9/§10/§11).
 * The screen implementation lives in src/features/passport/TrustScreen.tsx; this
 * file only mounts it as an Expo-Router screen. The root Stack renders with
 * headerShown: false, so TrustScreen draws its own header.
 */
import React from 'react';
import TrustScreen from '../../src/features/passport/TrustScreen.tsx';

export default function TrustRoute() {
  return <TrustScreen />;
}
