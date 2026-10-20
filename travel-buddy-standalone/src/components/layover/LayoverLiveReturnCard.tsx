/**
 * LayoverLiveReturnCard — LIVE RETURN ASSISTANCE: adaptive, battery-aware location sensing on the layover surface
 * (census-layover L157, spec §16), inside the L164 boundary ("request location when enabling live return assistance /
 * map context, not solely because Layover exists").
 *
 * WHAT IT DOES
 *   - Nothing at all until the traveller presses "Turn on live return assistance". That press is the ONE place the
 *     permission is asked for, through the location door, with the purpose `live_return_assistance`.
 *   - Once on, it takes ONE-SHOT fixes on a timer chosen by `layoverLiveSensing` from the server's certified rung:
 *     every 10 min (20 when stationary) well before the deadline, every 3 min near the decision boundary (RETURN_SOON),
 *     every 30 s while heading back (RETURN_NOW / CONNECTION_AT_RISK / a session marked returning). Never a watch,
 *     never in the background, and less often and less precisely in low power mode — when the power state is known.
 *   - It shows how far the traveller is from the airport, straight-line, and says when they are back at it. The fix
 *     stays on the phone: nothing here sends a position anywhere.
 *   - "Turn off" stops sampling at once.
 *
 * WHAT IT DOES NOT CLAIM: a straight-line distance is not a route or a travel time (the certified deadline elsewhere on
 * this screen is the answer to "do I have time"). Expo Battery supplies power state on supported devices; older native
 * binaries and unsupported devices retain an explicit unknown state. Real device behavior needs native validation.
 */
import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { Navigation } from 'lucide-react-native';
import { color, radius, space, type as t } from '../../theme/tokens.ts';
import { USER_PRESS_LIVE_RETURN, requestLocationForUserAction } from '../../lib/location/locationRequestDoor.ts';
import { sampleLiveReturnFix } from '../../lib/location/layoverLiveReturnSampler.ts';
import { LAYOVER_STATIONARY_METERS, layoverLiveSensing, metresBetween, type LiveSensingInput } from '../../lib/layoverSensingCadence.ts';
import type { LayoverReturnState } from '../../services/layover.ts';

/** Inside this distance of the airport's point the traveller is told they are back at the airport. */
export const LIVE_RETURN_AT_AIRPORT_METERS = 1_500;
import { useLayoverPowerState } from '../../lib/layoverPowerState.ts';

interface Fix { lat: number; lng: number; atMs: number }

interface Props {
  sessionStatus: string | null | undefined;
  returnState: LayoverReturnState | null | undefined;
  airport: { name: string; lat: number | null; lng: number | null };
  /** Optional explicit power input for a host that already observes it; otherwise read the device. */
  power?: LiveSensingInput['power'];
}

export function LayoverLiveReturnCard({ sessionStatus, returnState, airport, power }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<'granted' | 'denied' | 'undetermined'>('undetermined');
  const [fixes, setFixes] = useState<Fix[]>([]);
  // Rendering this card means the screen is up; only an explicit background/inactive state pauses sensing.
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  const [note, setNote] = useState<string | null>(null);
  /** Bumped after every sample attempt, so the next one-shot timer is armed whether the fix succeeded or failed. */
  const [attempts, setAttempts] = useState(0);
  const live = sessionStatus === 'active' || sessionStatus === 'returning';

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  const last = fixes[fixes.length - 1] ?? null;
  const prev = fixes[fixes.length - 2] ?? null;
  const stationary = last && prev ? metresBetween(last, prev) < LAYOVER_STATIONARY_METERS : null;
  const devicePower = useLayoverPowerState(enabled && appActive && live, attempts); const decision = layoverLiveSensing({ enabled, permission, sessionStatus, returnState, stationary, power: power ?? devicePower, appActive });

  // One timer at a time, re-armed whenever the decision's interval or accuracy changes.
  const generation = useRef(0);
  useEffect(() => {
    if (decision.intervalMs === null || decision.accuracy === null) return;
    const mine = ++generation.current;
    const accuracy = decision.accuracy;
    const timer = setTimeout(() => {
      void sampleLiveReturnFix(accuracy).then((f) => {
        if (mine !== generation.current) return;
        if (f.ok) setFixes((xs) => [...xs.slice(-1), { lat: f.lat, lng: f.lng, atMs: f.atMs }]);
        else if (f.reason === 'permission_not_granted') { setPermission('denied'); setNote('Location permission was turned off, so live return assistance stopped.'); }
        setAttempts((n) => n + 1);
      });
    }, decision.intervalMs);
    return () => { ++generation.current; clearTimeout(timer); };
  }, [decision.intervalMs, decision.accuracy, attempts]);

  async function turnOnLiveReturn() {
    setNote(null);
    const r = await requestLocationForUserAction(USER_PRESS_LIVE_RETURN);
    if (!r.granted) { setPermission('denied'); setNote('Location permission was not given, so nothing is sensed.'); return; }
    setPermission('granted');
    setEnabled(true);
    if (typeof r.lat === 'number' && typeof r.lng === 'number') setFixes([{ lat: r.lat, lng: r.lng, atMs: Date.now() }]);
  }

  if (!live) return null;

  const hasAirportPoint = typeof airport.lat === 'number' && typeof airport.lng === 'number';
  const toAirport = last && hasAirportPoint ? metresBetween(last, { lat: airport.lat as number, lng: airport.lng as number }) : null;

  return (
    <View style={styles.card} testID="layover-live-return">
      <View style={styles.headerRow}>
        <Navigation size={14} color={color.deep} />
        <Text style={styles.heading}>Live return assistance</Text>
      </View>
      {!enabled ? (
        <>
          <Text style={styles.note}>
            Uses your location to show how far you are from {airport.name}, more often as your return gets closer. Off until you turn it on; your position stays on this phone.
          </Text>
          <Pressable testID="layover-live-return-enable" onPress={turnOnLiveReturn} accessibilityRole="button" accessibilityLabel="Turn on live return assistance" style={styles.btn}>
            <Text style={styles.btnText}>Turn on live return assistance</Text>
          </Pressable>
        </>
      ) : (
        <>
          {toAirport !== null ? (
            toAirport <= LIVE_RETURN_AT_AIRPORT_METERS
              ? <Text style={styles.body} testID="layover-live-return-at-airport">You are at {airport.name}.</Text>
              : <Text style={styles.body} testID="layover-live-return-distance">About {(toAirport / 1000).toFixed(1)} km from {airport.name}, in a straight line — not a route or a travel time.</Text>
          ) : (
            <Text style={styles.note}>{hasAirportPoint ? 'Waiting for your first position.' : 'This airport has no position on file, so distance cannot be shown.'}</Text>
          )}
          <Text style={styles.note} testID="layover-live-return-cadence">
            {decision.intervalMs === null ? `Paused: ${decision.reason}.` : `Checking every ${decision.intervalMs >= 60_000 ? `${Math.round(decision.intervalMs / 60_000)} min` : `${Math.round(decision.intervalMs / 1000)} s`} — ${decision.reason}.`}
          </Text>
          <Pressable testID="layover-live-return-disable" onPress={() => { setEnabled(false); setFixes([]); }} accessibilityRole="button" accessibilityLabel="Turn off live return assistance" style={styles.btnSecondary}>
            <Text style={styles.btnSecondaryText}>Turn off</Text>
          </Pressable>
        </>
      )}
      {note ? <Text style={styles.note} testID="layover-live-return-note">{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: color.paperRaised, borderRadius: radius.md, borderWidth: 1, borderColor: color.haze, padding: space.lg, gap: space.sm },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  heading: { ...t.heading, color: color.ink },
  body: { ...t.small, color: color.ink },
  note: { ...t.small, color: color.mute, fontSize: 12 },
  btn: { backgroundColor: color.deep, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.lg, minHeight: 36, alignSelf: 'flex-start', justifyContent: 'center' },
  btnText: { ...t.small, color: color.onInk, fontWeight: '700' },
  btnSecondary: { borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill, paddingVertical: space.sm, paddingHorizontal: space.lg, minHeight: 36, alignSelf: 'flex-start', justifyContent: 'center' },
  btnSecondaryText: { ...t.small, color: color.deep, fontWeight: '600' },
});
