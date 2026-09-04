/**
 * app/passport/travel-identity.tsx
 *
 * Route wrapper for the standalone "Travel Identity" Passport surface (spec §19).
 * The screen implementation lives in src/features/passport/TravelIdentityScreen.tsx;
 * this file only mounts it as an Expo-Router screen. The root Stack renders
 * with headerShown: false, so TravelIdentityScreen draws its own header.
 */
import React from 'react';
import TravelIdentityScreen from '../../src/features/passport/TravelIdentityScreen.tsx';

export default function TravelIdentityRoute() {
  return <TravelIdentityScreen />;
}
