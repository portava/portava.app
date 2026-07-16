/**
 * LayoverHero — immersive header for the layover dashboard.
 *
 * Flight-information-display aesthetic: huge IATA stamp, airport-local
 * clock, tier chip, live countdown and an arrival→departure timeline with
 * the hard-return marker.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { BadgeCheck, Moon, Plane } from 'lucide-react-native';
import { color, space, radius, type as t } from '../../theme/tokens';
import { fmtClock, fmtDur, remainingMin, tierDotColor } from './layoverFormat';
import type {
  LayoverLocalTimes, LayoverSession, LayoverWindow, PublicAirport,
} from '../../services/layover';

interface Props {
  airport: PublicAirport;
  session: LayoverSession;
  window: LayoverWindow;
  localTimes: LayoverLocalTimes;
  nowMs: number;
}

export function LayoverHero({ airport, session, window: win, localTimes, nowMs }: Props) {
  const tz = airport.timezone;
  const active = session.status === 'active';

  // Countdown target: hard return when leaving is on the table, else departure.
  const leaving = session.wantsToLeave && win.usableMinutes > 0;
  const targetIso = leaving ? win.hardReturnTime : session.departureTime;
  const remainMin = remainingMin(targetIso, nowMs);
  const urgent = leaving && remainMin <= 30;

  // Timeline geometry
  const startMs = new Date(session.arrivalTime).getTime();
  const endMs   = new Date(session.departureTime).getTime();
  const span    = Math.max(1, endMs - startMs);
  const nowPct  = Math.min(100, Math.max(0, ((nowMs - startMs) / span) * 100));
  const hardPct = Math.min(100, Math.max(0, ((new Date(win.hardReturnTime).getTime() - startMs) / span) * 100));

  return (
    <View style={styles.card}>
      <View style={styles.topRow}>
        <View style={{ flex: 1 }}>
          <View style={styles.iataRow}>
            <Text style={styles.iata}>{airport.iataCode}</Text>
            {airport.verified && <BadgeCheck size={18} color={color.onInkMute} />}
          </View>
          <Text style={styles.airportName} numberOfLines={2}>{airport.name}</Text>
          <Text style={styles.cityLine}>{airport.city}{airport.country ? `, ${airport.country}` : ''}</Text>
        </View>
        <View style={styles.clockBox}>
          <Text style={styles.clockLabel}>LOCAL TIME</Text>
          <Text style={styles.clock}>{fmtClock(new Date(nowMs), tz)}</Text>
          <View style={[styles.tierChip]}>
            <View style={[styles.tierDot, { backgroundColor: tierDotColor(win.tier) }]} />
            {win.overnight && <Moon size={11} color={color.onInk} />}
            <Text style={styles.tierText}>{win.tierLabel}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.tierBlurb}>{win.tierBlurb}</Text>

      {/* Countdown */}
      {active && (
        <View style={styles.countRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.countLabel}>
              {leaving ? 'TIME UNTIL YOU MUST HEAD BACK' : 'TIME UNTIL DEPARTURE'}
            </Text>
            <Text style={[styles.countValue, urgent && { color: color.signal }]}>
              {remainMin > 0 ? fmtDur(remainMin) : (leaving ? 'Head back now' : 'Departed')}
            </Text>
          </View>
          {leaving && (
            <View style={styles.hardBox}>
              <Text style={styles.countLabel}>BACK BY</Text>
              <Text style={styles.hardValue}>{fmtClock(win.hardReturnTime, tz)}</Text>
            </View>
          )}
        </View>
      )}

      {/* Timeline */}
      <View style={styles.timeline}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${nowPct}%` }]} />
          <View style={[styles.hardMarker, { left: `${hardPct}%` }]} />
        </View>
        <View style={styles.timelineLabels}>
          <Text style={styles.tlText}>↓ {localTimes.arrivalLocal}</Text>
          <Text style={[styles.tlText, { color: color.signal }]}>return {fmtClock(win.hardReturnTime, tz)}</Text>
          <Text style={styles.tlText}>{localTimes.departureLocal} <Plane size={10} color={color.onInkMute} /></Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card:      { backgroundColor: color.ink, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  topRow:    { flexDirection: 'row', gap: space.md },
  iataRow:   { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  iata:      { fontSize: 44, lineHeight: 48, fontWeight: '800', letterSpacing: 2, color: color.onInk },
  airportName: { ...t.bodyStrong, color: color.onInk, marginTop: 2 },
  cityLine:  { ...t.small, color: color.onInkMute, marginTop: 2 },
  clockBox:  { alignItems: 'flex-end', gap: 6 },
  clockLabel:{ ...t.stamp, color: color.onInkMute },
  clock:     { fontSize: 26, lineHeight: 28, fontWeight: '700', color: color.onInk, fontVariant: ['tabular-nums'] },
  tierChip:  { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(250,249,246,0.14)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  tierDot:   { width: 7, height: 7, borderRadius: 4 },
  tierText:  { ...t.stamp, color: color.onInk },
  tierBlurb: { ...t.small, color: color.onInkMute },

  countRow:  { flexDirection: 'row', alignItems: 'flex-end', gap: space.lg, marginTop: space.xs },
  countLabel:{ ...t.stamp, color: color.onInkMute },
  countValue:{ fontSize: 34, lineHeight: 38, fontWeight: '800', color: color.onInk, fontVariant: ['tabular-nums'] },
  hardBox:   { alignItems: 'flex-end' },
  hardValue: { fontSize: 22, lineHeight: 26, fontWeight: '700', color: color.signal, fontVariant: ['tabular-nums'] },

  timeline:  { marginTop: space.sm, gap: 6 },
  track:     { height: 6, borderRadius: 3, backgroundColor: 'rgba(250,249,246,0.18)', overflow: 'visible' },
  fill:      { height: 6, borderRadius: 3, backgroundColor: color.onInk },
  hardMarker:{ position: 'absolute', top: -3, width: 2, height: 12, backgroundColor: color.signal, borderRadius: 1 },
  timelineLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  tlText:    { ...t.stamp, color: color.onInkMute },
});
