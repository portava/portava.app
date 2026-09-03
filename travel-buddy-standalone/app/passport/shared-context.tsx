/**
 * app/passport/shared-context.tsx
 *
 * Route wrapper for the "Shared Context · YOU TWO" Passport surface (spec
 * §17/§18). Unlike the owner-only My World screen, this screen is about the
 * viewer's relationship to ANOTHER traveler, so it takes that other traveler's
 * id as a query param (`?userId=…`, optional `?name=…` for the header/CTA).
 *
 * The screen implementation lives in
 * src/features/passport/SharedContextScreen.tsx; this file only mounts it as an
 * Expo-Router screen. The root Stack renders with headerShown: false, so the
 * screen draws its own header.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import SharedContextScreen from '../../src/features/passport/SharedContextScreen.tsx';

export default function SharedContextRoute() {
  const { userId, name } = useLocalSearchParams<{ userId?: string; name?: string }>();
  return (
    <SharedContextScreen
      userId={typeof userId === 'string' ? userId : undefined}
      otherName={typeof name === 'string' ? name : undefined}
    />
  );
}
