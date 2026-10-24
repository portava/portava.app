/**
 * census-layover L153 — the control a traveller uses to record the departure gate they see, on the Trips layover card.
 *
 * The offline bundle caches the onward flight's last RECORDED observation, with who recorded it and when, and badges
 * it stale from the observation instant (server: services/airport/LayoverDepartureFlight.ts). Until this control the
 * only producer a traveller could reach was the disruption report (status and times); a gate could be recorded only
 * by a feed. The route existed (POST /trips/:tripId/flight-segments/:segmentId/status); no screen called it.
 *
 * It shows the gate the server holds (or that none is recorded), takes what the traveller types, sends it, and on
 * success asks the card to re-read: the value shown is always the server's, never this field's.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { writeFailureText, type ApiWrite } from '../shared/tripApi.ts';
import { gateEntryProblem, recordTripFlightGate, type TripFlight } from './tripLayoverConnections.ts';

interface Props {
  tripId: string;
  flight: Pick<TripFlight, 'id' | 'designator' | 'departureGate'>;
  /** Test seam. */
  record?: typeof recordTripFlightGate;
  /** Called after the server recorded the gate, so the card re-reads it. */
  onRecorded?: () => void;
}

export function TripFlightGateControl({ tripId, flight, record = recordTripFlightGate, onRecorded }: Props) {
  const [gate, setGate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ApiWrite<unknown> | null>(null);
  const id = flight.id;

  async function onSave() {
    const p = gateEntryProblem({ departureGate: gate });
    setProblem(p);
    if (p) return;
    setSaving(true);
    setResult(null);
    const w = await record(tripId, id, { departureGate: gate });
    setSaving(false);
    setResult(w);
    if (w.state === 'done') {
      setGate('');
      onRecorded?.();
    }
  }

  return (
    <View style={s.wrap} testID={`trip-flight-gate-${id}`}>
      <Text style={s.detail} testID={`trip-flight-gate-current-${id}`}>
        {flight.departureGate ? `Gate ${flight.departureGate} (as last recorded)` : 'Gate not recorded yet'}
      </Text>
      <View style={s.row}>
        <TextInput
          value={gate}
          onChangeText={setGate}
          placeholder="Gate on the board, e.g. B4"
          autoCapitalize="characters"
          maxLength={40}
          style={s.input}
          testID={`trip-flight-gate-input-${id}`}
          accessibilityLabel={`Departure gate for ${flight.designator ?? 'this flight'}`}
        />
        <Pressable onPress={() => void onSave()} disabled={saving} style={s.button} testID={`trip-flight-gate-save-${id}`} accessibilityRole="button">
          <Text style={s.buttonText}>{saving ? 'Saving…' : 'Save gate'}</Text>
        </Pressable>
      </View>
      {problem ? <Text style={s.problem} testID={`trip-flight-gate-problem-${id}`}>{problem}</Text> : null}
      {result && result.state !== 'done' ? <Text style={s.problem} testID={`trip-flight-gate-not-saved-${id}`}>{writeFailureText(result)}</Text> : null}
      {result && result.state === 'done' ? <Text style={s.detail} testID={`trip-flight-gate-saved-${id}`}>Gate saved. Departure boards change: check it again before you head back.</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: space.xs, marginTop: space.xs },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'center' },
  detail: { ...t.stamp, color: color.mute },
  problem: { ...t.stamp, color: color.ink, fontWeight: '600' },
  input: { ...t.small, flex: 1, color: color.ink, borderWidth: 1, borderColor: color.haze, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: space.xs },
  button: { paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze },
  buttonText: { ...t.small, color: color.ink },
});
