import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { readCachedAbortReturnRoute } from '../../lib/layoverPlanCache.ts';
import type { AbortReturnRoute } from '../../services/layover.ts';
import { RoutedReturnItinerary } from './LayoverRoutedMapPanel.tsx';

/** An abort can happen without a selected plan. Keep its actual way back available in that offline state too. */
export function LayoverCachedAbortRoute({ sessionId, nowMs }: { sessionId: string | undefined; nowMs: number }) {
  const [route, setRoute] = useState<AbortReturnRoute | null>(null);
  useEffect(() => {
    let active = true; setRoute(null);
    if (sessionId) void readCachedAbortReturnRoute(sessionId).then(r => { if (active) setRoute(r); });
    return () => { active = false; };
  }, [sessionId]);
  if (!route) return null;
  return <View testID="layover-cached-abort-route">
    <Text>OFFLINE — last measured return route. Times below are UTC.</Text>
    <RoutedReturnItinerary contract={{ hardReturnBy: route.hardReturnBy, leaveBy: route.leaveBy, route }} timezone="UTC" expiresAt={route.expiresAt} nowMs={nowMs} late={!route.canMeetDeadline} />
  </View>;
}
