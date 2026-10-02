/**
 * TripTransportPolicyCard — §7.4's transport-mode policy on screen (TRIP-F16, WP-10).
 *
 * The owner says which ways of getting around this trip does NOT use; the
 * feasibility check then asks each hop only by the allowed modes. The current
 * policy is read from the feasibility response it governs. When that response
 * carries no policy the operational gate is off and the policy can be neither
 * read nor set here — the card says so rather than showing every mode as
 * allowed. Crew members see the policy; only the owner edits it (the route's
 * canEditTrip refuses anyone else by name).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { Route, CloudOff, CheckCircle2 } from 'lucide-react-native';

import { color, space, radius, type as t, shadow } from '../../../theme/tokens.ts';
import { fetchTripFeasibility, type FeasibilityRead } from './tripFeasibility.ts';
import {
  POLICY_MODES, MODE_LABEL, policyFromReport, toggleMode, setTransportPolicy,
  type PolicyMode, type TransportPolicy,
} from './tripTransportPolicy.ts';
import { writeFailureText, type ApiWrite } from '../shared/tripApi.ts';

interface Props {
  tripId: string;
  isOwner: boolean;
  /** Test seams. */
  load?: typeof fetchTripFeasibility;
  save?: typeof setTransportPolicy;
}

export function TripTransportPolicyCard({ tripId, isOwner, load = fetchTripFeasibility, save = setTransportPolicy }: Props) {
  const [read, setRead] = useState<FeasibilityRead | undefined>(undefined);
  const [draft, setDraft] = useState<PolicyMode[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<ApiWrite<TransportPolicy> | null>(null);

  const run = useCallback(async () => {
    setRead(undefined);
    setDraft(null);
    try { setRead(await load(tripId)); }
    catch (e: any) { setRead({ state: 'unavailable', detail: String(e?.message ?? 'unexpected error') }); }
  }, [tripId, load]);
  useEffect(() => { void run(); }, [run]);

  if (read === undefined) {
    return <View style={s.wrap} testID="trip-transport-loading"><ActivityIndicator size="small" color={color.signal} style={{ margin: space.lg }} /></View>;
  }
  if (read.state === 'off') return null;
  if (read.state === 'unavailable') {
    return (
      <View style={s.wrap} testID="trip-transport-unavailable">
        <View style={s.row}>
          <CloudOff size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Transport rules unavailable</Text>
            <Text style={s.detail}>We couldn&apos;t read how this trip gets around.</Text>
            <Pressable onPress={() => void run()} style={s.button} testID="trip-transport-retry" accessibilityRole="button">
              <Text style={s.buttonText}>Try again</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const current = policyFromReport(read.report as unknown as { transportPolicy?: unknown });
  if (!current) {
    return (
      <View style={s.wrap} testID="trip-transport-not-here">
        <View style={s.row}>
          <Route size={14} color={color.mute} />
          <View style={{ flex: 1 }}>
            <Text style={s.title}>Transport rules</Text>
            <Text style={s.detail}>Transport rules can&apos;t be read or set on this deployment yet, so travel between plans is checked by every mode.</Text>
          </View>
        </View>
      </View>
    );
  }

  const disallowed = draft ?? current.disallowedModes;
  const dirty = draft !== null && [...draft].sort().join() !== [...current.disallowedModes].sort().join();

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setResult(null);
    const w = await save(tripId, draft, current?.note ?? null);
    setSaving(false);
    setResult(w);
    if (w.state === 'done') { setDraft(null); void run(); }
  }

  return (
    <View style={s.wrap} testID="trip-transport-card">
      <View style={s.row}>
        <Route size={14} color={color.deep} />
        <View style={{ flex: 1 }}>
          <Text style={s.title}>How this trip gets around</Text>
          <Text style={s.detail}>
            {disallowed.length === 0 ? 'Every mode is allowed.' : `Not used: ${disallowed.map((m) => MODE_LABEL[m]).join(', ')}.`}
          </Text>
          <View style={s.buttons}>
            {POLICY_MODES.map((m) => {
              const allowed = !disallowed.includes(m);
              return (
                <Pressable
                  key={m}
                  disabled={!isOwner || saving}
                  onPress={() => setDraft(toggleMode(disallowed, m))}
                  style={[s.button, allowed && s.buttonOn, (!isOwner || saving) && { opacity: 0.6 }]}
                  testID={`trip-transport-mode-${m}`}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: allowed, disabled: !isOwner }}
                >
                  <Text style={[s.buttonText, allowed && s.buttonTextOn]}>{MODE_LABEL[m]}</Text>
                </Pressable>
              );
            })}
          </View>
          {!isOwner ? <Text style={s.detail}>Only the trip owner can change these.</Text> : null}
          {isOwner && dirty ? (
            <Pressable onPress={() => void onSave()} disabled={saving} style={[s.button, s.save]} testID="trip-transport-save" accessibilityRole="button">
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={[s.buttonText, s.buttonTextOn]}>Save transport rules</Text>}
            </Pressable>
          ) : null}
          {result?.state === 'done' ? (
            <View style={s.inline} testID="trip-transport-saved">
              <CheckCircle2 size={12} color={color.success} />
              <Text style={[s.detail, { color: color.success, marginTop: 0 }]}>Saved — the schedule check now uses these rules.</Text>
            </View>
          ) : result ? (
            <Text style={[s.detail, { color: color.signal }]} testID="trip-transport-not-saved">{writeFailureText(result)}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { marginHorizontal: space.lg, marginTop: space.md, backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, ...shadow.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingHorizontal: space.lg, paddingVertical: space.md },
  title: { ...t.small, fontWeight: '600', color: color.ink },
  detail: { ...t.stamp, color: color.mute, marginTop: 2 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  button: { alignSelf: 'flex-start', paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, marginTop: space.xs },
  buttonOn: { backgroundColor: color.deep, borderColor: color.deep },
  buttonText: { ...t.small, color: color.ink },
  buttonTextOn: { color: '#fff' },
  save: { backgroundColor: color.signal, borderColor: color.signal },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.xs },
});
