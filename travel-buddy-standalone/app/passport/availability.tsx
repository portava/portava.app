/**
 * app/passport/availability.tsx
 *
 * Route wrapper for the Passport Availability editor (spec §6/§7/§8).
 * The screen implementation lives in src/features/passport/AvailabilityScreen.tsx;
 * this file only mounts it as an Expo-Router screen. The root Stack renders with
 * headerShown: false, so AvailabilityScreen draws its own header.
 */
import React from 'react';
import AvailabilityScreen from '../../src/features/passport/AvailabilityScreen.tsx';

export default function AvailabilityRoute() {
  return <AvailabilityScreen />;
}
