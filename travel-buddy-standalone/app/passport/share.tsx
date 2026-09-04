/**
 * app/passport/share.tsx
 *
 * Route wrapper for the Passport Share surface (spec §25). The screen
 * implementation lives in src/features/passport/PassportShareScreen.tsx; this
 * file only mounts it as an Expo-Router screen. The root Stack renders with
 * headerShown: false, so the share sheet draws its own chrome.
 */
import React from 'react';
import PassportShareScreen from '../../src/features/passport/PassportShareScreen.tsx';

export default function PassportShareRoute() {
  return <PassportShareScreen />;
}
