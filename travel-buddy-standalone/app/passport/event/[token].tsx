/**
 * app/passport/event/[token].tsx
 *
 * Route wrapper for a scanned temporary event Passport (spec §25/§31, Phase 8).
 * The opaque share token arrives as the path segment; the screen resolves it
 * server-side, where expiry, revocation, the event's own end and co-attendance
 * are all decided. This file only mounts the screen.
 */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import EventPassportScreen from '../../../src/features/passport/EventPassportScreen.tsx';

export default function EventPassportRoute() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  return <EventPassportScreen token={typeof token === 'string' ? token : undefined} />;
}
