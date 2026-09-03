/**
 * app/passport/my-world.tsx
 *
 * Route wrapper for the standalone "My World" Passport surface (spec §26).
 * The screen implementation lives in src/features/passport/MyWorldScreen.tsx;
 * this file only mounts it as an Expo-Router screen. The root Stack renders
 * with headerShown: false, so MyWorldScreen draws its own header.
 */
import React from 'react';
import MyWorldScreen from '../../src/features/passport/MyWorldScreen.tsx';

export default function MyWorldRoute() {
  return <MyWorldScreen />;
}
