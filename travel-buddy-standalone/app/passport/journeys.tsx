/**
 * app/passport/journeys.tsx
 *
 * Route wrapper for the standalone "Journeys" Passport surface (spec §14).
 * The screen implementation lives in src/features/passport/JourneysScreen.tsx;
 * this file only mounts it as an Expo-Router screen. The root Stack renders
 * with headerShown: false, so JourneysScreen draws its own header.
 */
import React from 'react';
import JourneysScreen from '../../src/features/passport/JourneysScreen.tsx';

export default function JourneysRoute() {
  return <JourneysScreen />;
}
