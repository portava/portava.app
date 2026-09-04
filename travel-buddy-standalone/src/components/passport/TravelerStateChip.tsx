/**
 * TravelerStateChip — the §5 Current Traveler State pill for the Passport
 * header ("✈ Traveling · Da Nang", "🟢 Open to Plans", "Unavailable").
 *
 * Renders `projection.travelerState` — the SERVER-projected temporary state —
 * and nothing else. It replaces the legacy chip that re-derived a status on
 * the client from the AvailabilityStore, which (a) duplicated policy the
 * server owns (§4/§30) and (b) could not honour the viewer's permissions.
 *
 * §31 EXPIRY, ENFORCED HERE
 *   • Expiry-on-read: a state whose `expiresAt` has passed is never rendered.
 *   • Lapse while visible: the chip arms one timer for `expiresAt` and hides
 *     itself the moment it lapses.
 *   • Either lapse emits `availability_expired` (§32) exactly once per state
 *     instance — the seam's payload is empty, so no id or place leaves the
 *     device.
 *
 * §27: colour is paired with text and an icon; the tone never carries the
 * meaning alone.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import {
  Home,
  Plane,
  Compass,
  Sparkles,
  Ticket,
  Users,
  MoonStar,
} from 'lucide-react-native';
import type { TravelerStateKind, TravelerStateView } from '../../services/passportProjection.ts';
import {
  isTravelerStateExpired,
  msUntilTravelerStateExpiry,
  resolveTravelerStateForRender,
  travelerStateKey,
  travelerStateTone,
  type TravelerStateTone,
} from '../../lib/travelerState.ts';
import { trackAvailabilityExpired } from '../../features/passport/passportTelemetry.ts';
import { dot, icon as iconSize } from '../../theme/tokens.ts';

const GLYPH: Record<TravelerStateKind, React.ComponentType<{ size: number; color: string; strokeWidth?: number }>> = {
  home: Home,
  traveling: Plane,
  exploring: Compass,
  open_to_plans: Sparkles,
  at_event: Ticket,
  with_crew: Users,
  unavailable: MoonStar,
};

const TONES: Record<TravelerStateTone, { bg: string; border: string; text: string; dot: string }> = {
  positive: { bg: '#F0FAF4', border: 'rgba(34,197,94,0.35)', text: '#166534', dot: '#22C55E' },
  social:   { bg: '#EEF6FA', border: 'rgba(14,116,144,0.35)', text: '#155E75', dot: '#0E7490' },
  muted:    { bg: '#F3F1EC', border: 'rgba(28,28,26,0.12)', text: '#6B6257', dot: '#9C9285' },
};

/**
 * The §31 policy as a hook: returns the state to render as current (or null)
 * and emits availability_expired once per lapsed state instance.
 * `now` is injectable for deterministic tests.
 */
export function useCurrentTravelerState(
  state: TravelerStateView | null | undefined,
  now: () => number = Date.now,
): TravelerStateView | null {
  // Re-render trigger when the armed timer fires.
  const [, setLapseTick] = useState(0);
  const emittedRef = useRef<Set<string>>(new Set());

  const nowMs = now();
  const current = resolveTravelerStateForRender(state, nowMs);
  const key = state ? travelerStateKey(state) : null;
  const expiredNow = !!state && isTravelerStateExpired(state, nowMs);

  // Expiry-on-read: the state arrived (from the server or a cache) already lapsed.
  useEffect(() => {
    if (!key || !expiredNow) return;
    if (emittedRef.current.has(key)) return;
    emittedRef.current.add(key);
    trackAvailabilityExpired();
  }, [key, expiredNow]);

  // Lapse while visible: arm exactly one timer for this state instance.
  useEffect(() => {
    if (!state || !key) return;
    const delay = msUntilTravelerStateExpiry(state, now());
    if (delay === null) return;
    const handle = setTimeout(() => {
      if (!emittedRef.current.has(key)) {
        emittedRef.current.add(key);
        trackAvailabilityExpired();
      }
      setLapseTick((n) => n + 1);
    }, delay);
    return () => clearTimeout(handle);
    // `now` is a stable seam; re-arming on it would re-fire timers every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return current;
}

export interface TravelerStateChipProps {
  /** `projection.travelerState` — undefined/null renders nothing. */
  state: TravelerStateView | null | undefined;
  /** Owner: opens the availability editor. Viewer: opens the read-only status sheet. */
  onPress?: () => void;
  testID?: string;
  /** Test seam for the §31 clock. */
  now?: () => number;
}

export function TravelerStateChip({ state, onPress, testID, now }: TravelerStateChipProps) {
  const current = useCurrentTravelerState(state, now);
  if (!current) return null;

  const tone = TONES[travelerStateTone(current.state)];
  const Glyph = GLYPH[current.state];

  return (
    <Pressable
      style={[s.chip, { backgroundColor: tone.bg, borderColor: tone.border }]}
      onPress={onPress}
      disabled={!onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      accessibilityLabel={`Current state: ${current.label}`}
      testID={testID ?? 'traveler-state-chip'}
    >
      <View style={[s.dot, { backgroundColor: tone.dot }]} />
      <Glyph size={iconSize.s14} color={tone.text} strokeWidth={2} />
      <Text style={[s.label, { color: tone.text }]} numberOfLines={1} testID="traveler-state-label">
        {current.label}
      </Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    marginTop: 4,
  },
  dot: {
    width: dot.s7,
    height: dot.s7,
    borderRadius: dot.s7 / 2,
  },
  label: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.1,
    flexShrink: 1,
  },
});
