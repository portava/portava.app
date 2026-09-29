/**
 * Global Input Intelligence — §54 action candidates above the Telegraph
 * composer (flow GII-F10, census G133 / G362).
 *
 *   type "meet at …" → [Share meeting point] [Share Trip stop] [Share current Place]
 *   → eligibility → tap → the §6.2 LOCATION compose sheet opens PRE-FILLED;
 *   the sender still presses Send. Nothing is sent from this bar.
 *
 * Renders nothing while the draft is not a "meet at" phrase (nothing was asked
 * for). Once asked: a spinner while loading; an error with Retry when the
 * request failed; an ineligible candidate is shown disabled WITH its reason;
 * a partial answer says a source could not be read.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MapPin, Navigation, Route as RouteIcon } from 'lucide-react-native';
import { color, icon as iconToken, radius, space, type as t } from '../../../theme/tokens.ts';
import { useMeetAtActions } from './useMeetAtActions.ts';
import type { MeetAtCandidate, MeetAtShare, TelegraphLocationDraft } from './telegraphMeetAt.ts';
import { expoDeviceLocator, type DeviceLocator, type LocationPermission } from './deviceLocator.ts';

export interface MeetAtActionBarProps {
  draft: string;
  /** Open the LOCATION compose sheet, pre-filled when a draft is given. */
  onPick: (draft: TelegraphLocationDraft | null, share: MeetAtShare) => void;
  /** Injected in tests; defaults to expo-location + the server reverse geocoder. */
  locator?: DeviceLocator;
}

const ICONS: Record<MeetAtShare, typeof MapPin> = { meeting_point: MapPin, trip_stop: RouteIcon, current_place: Navigation };

export function MeetAtActionBar({ draft, onPick, locator = expoDeviceLocator }: MeetAtActionBarProps) {
  const { state, retry } = useMeetAtActions(draft);
  const [permission, setPermission] = useState<LocationPermission | 'unknown'>('unknown');
  const [locating, setLocating] = useState(false);
  const [hereError, setHereError] = useState<string | null>(null);

  const needsDevice = state.phase === 'ready' && state.candidates.some((c) => c.requires === 'device_location');
  useEffect(() => {
    if (!needsDevice) return;
    let live = true;
    locator.permission().then((p) => { if (live) setPermission(p); }, () => { if (live) setPermission('unknown'); });
    return () => { live = false; };
  }, [needsDevice, locator]);

  const candidates = useMemo<MeetAtCandidate[]>(() => {
    if (state.phase !== 'ready') return [];
    return state.candidates.map((c) =>
      c.requires === 'device_location' && permission === 'denied'
        ? { ...c, eligible: false, ineligibleReason: 'Location access is off for Portava.' }
        : c,
    );
  }, [state, permission]);

  if (state.phase === 'idle') return null;

  const pick = async (c: MeetAtCandidate) => {
    if (!c.eligible) return;
    setHereError(null);
    if (c.requires !== 'device_location') {
      onPick(c.draft, c.share);
      return;
    }
    setLocating(true);
    try {
      const granted = permission === 'granted' || (await locator.request());
      if (!granted) {
        setPermission('denied');
        setHereError('Location access is off for Portava.');
        return;
      }
      const label = await locator.currentLabel();
      if (!label) {
        setHereError('Couldn’t work out where you are. Try again, or share a meeting point instead.');
        return;
      }
      onPick({ label, placeId: null, precision: 'area' }, 'current_place');
    } catch {
      setHereError('Couldn’t read your location. Try again.');
    } finally {
      setLocating(false);
    }
  };

  const ineligible = candidates.filter((c) => !c.eligible && c.ineligibleReason);

  return (
    <View style={styles.wrap} testID="meet-at-bar">
      {state.phase === 'loading' ? (
        <View style={styles.row} testID="meet-at-loading">
          <ActivityIndicator size="small" color={color.mute} />
          <Text style={styles.note}>Finding places to meet…</Text>
        </View>
      ) : null}
      {state.phase === 'error' ? (
        <Pressable onPress={retry} accessibilityRole="button" style={styles.row} testID="meet-at-error">
          <Text style={styles.bad}>{state.message} </Text>
          <Text style={styles.link}>Retry</Text>
        </Pressable>
      ) : null}
      {state.phase === 'ready' ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            {candidates.map((c) => {
              const Icon = ICONS[c.share];
              const busy = locating && c.requires === 'device_location';
              return (
                <Pressable
                  key={c.id}
                  onPress={() => pick(c)}
                  disabled={!c.eligible || busy}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !c.eligible || busy, busy }}
                  accessibilityLabel={c.label}
                  accessibilityHint={c.eligible ? undefined : c.ineligibleReason ?? undefined}
                  style={[styles.chip, !c.eligible && styles.chipOff]}
                  testID={`meet-at-${c.id}`}
                >
                  {busy ? <ActivityIndicator size="small" color={color.deep} /> : <Icon size={iconToken.s14} color={c.eligible ? color.deep : color.mute} />}
                  <Text style={[styles.chipText, !c.eligible && styles.chipTextOff]} numberOfLines={1}>{c.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          {ineligible.map((c) => (
            <Text key={`why-${c.id}`} style={styles.note} testID={`meet-at-why-${c.share}`}>{c.ineligibleReason}</Text>
          ))}
          {state.partial ? (
            <Text style={styles.note} testID="meet-at-partial">Some suggestions couldn’t be loaded.</Text>
          ) : null}
          {hereError ? <Text style={styles.bad} accessibilityRole="alert" testID="meet-at-here-error">{hereError}</Text> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.md, paddingTop: space.xs, gap: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chips: { gap: space.sm, paddingVertical: space.xs },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.deep,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    backgroundColor: color.paperRaised,
    maxWidth: 260,
  },
  chipOff: { borderColor: color.haze },
  chipText: { ...t.small, color: color.deep, fontWeight: '600' },
  chipTextOff: { color: color.mute },
  note: { ...t.small, color: color.mute },
  bad: { ...t.small, color: color.ink, fontWeight: '600' },
  link: { ...t.small, color: color.deep, fontWeight: '700' },
});
