/**
 * LayoverReentryCard — §5 `RETURNING → AIRPORT_REENTERED`: "checkpoint confirms
 * re-entry; side effect = stop landside discovery, REFRESH GATE/SECURITY"
 * (census-layover L43), and App B.1 step 9: "gate context replaces exploration".
 *
 * The overview publishes `reentry` only after the traveller's newest check-in is
 * "I'm back at the airport" (or when check-ins could not be read). This card is
 * the gate context: the onward flight's gate, terminal and status as Trips last
 * recorded them, read at that request, with who recorded them and when (and the
 * stale line once the server's `staleAfter` has passed), and the
 * certified answer's own security term. Landside suggestions are already
 * withheld by the recommendations route on the same check-in.
 *
 * Nothing here is computed: every value is the server's, and every "we don't
 * know" is said. A re-entry report never relaxes the deadline — the countdown
 * above stays the certified one. Text colours: `ink` / `mute` / `warn` on
 * `paperRaised`.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Plane } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { fmtClock } from './layoverFormat.ts';
import { describeRecordedFlight } from './layoverRecordedFlight.ts';
import type { LayoverReentryContext, LayoverDepartureFlightRead, LayoverReentrySecurity } from '../../services/layover.ts';

export function reentryFlightLines(flight: LayoverDepartureFlightRead, timezone: string | null, nowMs: number): { lines: string[]; staleLine: string | null } {
  switch (flight.state) {
    case 'observed': {
      const f = flight.flight;
      const copy = describeRecordedFlight(f, { timezone, nowMs, staleAfter: typeof f.staleAfter === 'string' ? f.staleAfter : null });
      return { lines: copy.lines, staleLine: copy.staleLine };
    }
    case 'not_observed':
      return { lines: ['No gate or status has been recorded for your flight yet. Check the departure board.'], staleLine: null };
    case 'not_linked':
      return { lines: ['This layover is not linked to a flight on your trip, so Portava has no gate for it. Check the departure board.'], staleLine: null };
    case 'unreadable':
      return { lines: ['Portava could not read your flight just now. Check the departure board.'], staleLine: null };
    case 'off':
    default:
      return { lines: ['Portava does not have your gate. Check the departure board.'], staleLine: null };
  }
}

export function reentrySecurityLine(security: LayoverReentrySecurity, timezone: string | null): string {
  if (security.state === 'live') {
    const at = security.observedAt ? ` (as of ${fmtClock(security.observedAt, timezone)})` : '';
    return security.extraMinutes > 0
      ? `Security: about ${security.extraMinutes} min longer than usual${at}. Your return time already allows for it.`
      : `Security: no longer than usual${at}.`;
  }
  return "Security: no live reading. Your return time already allows the airport's usual security time.";
}

export function LayoverReentryCard({ reentry, timezone, nowMs }: {
  reentry: LayoverReentryContext | null | undefined;
  timezone: string | null;
  nowMs: number;
}) {
  if (!reentry) return null;
  if (reentry.state !== 'reentered') {
    return (
      <View style={styles.card} testID="layover-reentry-unknown">
        <Text style={styles.mute}>Portava could not check whether you are back at the airport, so it is still showing your plan.</Text>
      </View>
    );
  }
  const flight = reentryFlightLines(reentry.flight, timezone, nowMs);
  return (
    <View style={styles.card} testID="layover-reentry-card">
      <View style={styles.head}>
        <Plane size={16} color={color.ink} />
        <Text style={styles.title}>Back at the airport — your gate</Text>
      </View>
      <Text style={styles.mute} testID="layover-reentry-reported">
        You checked in at {fmtClock(reentry.reportedAt, timezone)}. City suggestions are paused; this was refreshed at {fmtClock(reentry.refreshedAt, timezone)}.
      </Text>
      {flight.lines.map((l, i) => <Text key={i} style={styles.line} testID={`layover-reentry-flight-${i}`}>{l}</Text>)}
      {flight.staleLine ? <Text style={styles.stale} testID="layover-reentry-flight-stale">{flight.staleLine}</Text> : null}
      <Text style={styles.line} testID="layover-reentry-security">{reentrySecurityLine(reentry.security, timezone)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card:  { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  head:  { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.bodyStrong, color: color.ink, flex: 1 },
  line:  { ...t.small, color: color.ink },
  mute:  { ...t.small, color: color.mute },
  stale: { ...t.small, color: color.warn, fontWeight: '700' },
});
