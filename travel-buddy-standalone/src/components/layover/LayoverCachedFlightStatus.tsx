/**
 * LayoverCachedFlightStatus — §16 "Flight/gate: cache last confirmed values with
 * stale indicator" (census-layover L153), drawn inside the offline plan card.
 *
 * Draws what `layoverPlanCache` kept from the bundle: the onward flight's last
 * RECORDED observation with who recorded it and when, and the stale line once
 * the server's `staleAfter` has passed — never renewed on this side. A record
 * written before the field existed (`undefined`/`null`) and the feature being
 * off (`no_flight_feed`) draw nothing, exactly as before; every other "no" is
 * said. Text colours: `mute` / `warn` as the plan card's own lines.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { color, type as t } from '../../theme/tokens.ts';
import type { LayoverOfflineFlightStatus, OfflineCapability } from '../../services/layover.ts';
import { describeRecordedFlight, noRecordedFlightSentence } from './layoverRecordedFlight.ts';

export function LayoverCachedFlightStatus({ cap, timezone, nowMs }: {
  cap: OfflineCapability<LayoverOfflineFlightStatus> | null | undefined;
  timezone: string | null;
  nowMs: number;
}) {
  if (!cap) return null;
  if (!cap.available || !cap.value) {
    const sentence = noRecordedFlightSentence(cap.reason);
    return sentence ? <Text style={styles.line} testID="layover-cached-plan-flight-none">{sentence}</Text> : null;
  }
  const copy = describeRecordedFlight(cap.value, { timezone, nowMs, staleAfter: cap.value.staleAfter });
  return (
    <View testID="layover-cached-plan-flight">
      {copy.lines.map((l, i) => <Text key={i} style={styles.line} testID={`layover-cached-plan-flight-${i}`}>{l}</Text>)}
      {copy.staleLine ? <Text style={styles.stale} testID="layover-cached-plan-flight-stale">{copy.staleLine}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line:  { ...t.small, color: color.mute, flexShrink: 1 },
  stale: { ...t.small, color: color.warn, fontWeight: '700' },
});
