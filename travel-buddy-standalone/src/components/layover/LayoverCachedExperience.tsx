import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { readCachedExperience, type OfflineExperiencePlan } from '../../lib/layoverExperienceCache.ts';

/** Timetable facts remain readable when stale; they never authorize a new departure offline. */
export function LayoverCachedExperience({ sessionId, nowMs }: { sessionId: string | undefined; nowMs: number }) {
  const [plan, setPlan] = useState<OfflineExperiencePlan | null>(null);
  useEffect(() => { let active = true; setPlan(null); if (sessionId) void readCachedExperience(sessionId).then(p => { if (active) setPlan(p); }); return () => { active = false; }; }, [sessionId]);
  if (!plan) return null;
  const c = plan.contract;
  return <View testID="layover-cached-experience">
    <Text>Saved experience timetable</Text>
    <Text>{nowMs >= Date.parse(c.expiresAt) ? 'Timing is stale. Do not start from this saved plan.' : 'Offline copy — refresh before starting.'}</Text>
    <Text>Return deadline: {c.hardReturnBy} (UTC)</Text>
    <Text>Leave the activity by: {c.leaveActivityBy} (UTC)</Text>
    {c.itinerary.map((hop, i) => <Text key={i}>{hop.kind === 'experience' ? 'Experience' : hop.kind === 'return' ? 'Return to airport' : 'Travel'}{hop.mode ? ` · ${hop.mode}` : ''}: {hop.startsAt} – {hop.endsAt}</Text>)}
    <Text>{c.insideAirport ? 'Remain inside the airport.' : 'If timing worsens, return to the airport.'} Street navigation is not saved.</Text>
  </View>;
}
