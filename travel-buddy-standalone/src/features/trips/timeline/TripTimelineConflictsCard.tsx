/**
 * TripTimelineConflictsCard — §7.3 conflicts on screen. census-trips TR130:
 * "a conflict is not silently rendered as a normal itinerary".
 *
 * The plan section keeps rendering the itinerary; this card, mounted above
 * it, names every day that carries a temporal conflict, the plans in it and
 * the §7.3 kind, in the server's words. A clean timeline renders nothing —
 * that is the one case silence is right, because it was measured. A
 * timeline that could not be read is not a clean one, and says so.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { AlertTriangle, CloudOff } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { fetchTripTimeline, conflictedDays, conflictKindLabel, type TimelineRead } from './tripTimeline.ts';

interface Props {
  tripId: string;
  /** Test seam — the real fetcher by default. */
  load?: typeof fetchTripTimeline;
}

export function TripTimelineConflictsCard({ tripId, load = fetchTripTimeline }: Props) {
  const [read, setRead] = useState<TimelineRead | undefined>(undefined);
  const run = useCallback(async () => {
    setRead(undefined);
    try { setRead(await load(tripId)); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load]);
  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return <View style={s.wrap} testID="trip-conflicts-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-conflicts-unavailable">
        <View style={s.row}>
          <CloudOff size={16} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Conflict check unavailable</Text>
            <Text style={s.detail}>{read.detail}. A timeline that could not be read is not a clean one.</Text>
          </View>
        </View>
      </View>
    );
  }
  const days = conflictedDays(read.timeline);
  // Measured and clean: the one case a card may say nothing.
  if (days.length === 0) return null;

  return (
    <View style={[s.wrap, s.wrapAlarm]} testID="trip-conflicts-card">
      <View style={s.row}>
        <AlertTriangle size={16} color={color.signal} />
        <View style={{ flex: 1 }}>
          <Text style={[s.title, { color: color.signal }]}>
            {days.length === 1 ? '1 day has a conflict' : `${days.length} days have conflicts`}
          </Text>
          {days.map((d) => (
            <View key={d.iso} style={s.day} testID={`trip-conflict-day-${d.iso}`}>
              <Text style={s.dayLabel}>{d.dateLabel}{d.dateSub ? ` · ${d.dateSub}` : ''}</Text>
              <Text style={s.detail}>{d.kinds.map(conflictKindLabel).join('; ')}</Text>
              <Text style={s.detail}>{d.plans.map((p) => p.title).join(' / ')}</Text>
            </View>
          ))}
          <Text style={s.reading}>{read.timeline.atRiskReading}</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  wrapAlarm: { borderColor: color.signal },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  day: { marginTop: space.sm },
  dayLabel: { ...t.small, fontWeight: '600', color: color.ink },
  reading: { ...t.stamp, color: color.faint, marginTop: space.sm },
});
