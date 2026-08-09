/**
 * ActiveLayoverPill — floating "resume layover" pill shown on the home tab
 * while a layover session is active.
 *
 * Geometry constants are exported so `useLayoverAwareBottomInset` can compute
 * the exact feed clearance needed when the pill is visible.
 */

// Re-export geometry constants so callers can import from either file.
export { LAYOVER_PILL_BOTTOM_OFFSET, LAYOVER_PILL_HEIGHT } from './layoverPillGeometry.ts';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronRight, Plane } from 'lucide-react-native';
import { color, space, type as t, dot } from '../../theme/tokens.ts';
import { useLayoverSessionContext } from '../../context/LayoverSessionContext.tsx';
import { fmtClock } from './layoverFormat.ts';

export function ActiveLayoverPill() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, airport } = useLayoverSessionContext();

  if (!session) return null;
  const label = airport?.iataCode ?? session.manualIata ?? 'Layover';
  const depLocal = fmtClock(session.departureTime, airport?.timezone);

  return (
    <View style={[styles.wrap, { bottom: insets.bottom + 74 }]} pointerEvents="box-none">
      <Pressable style={styles.pill} onPress={() => router.push(`/layover/${session.id}` as any)}>
        <View style={styles.pulseDot} />
        <Plane size={14} color={color.onInk} />
        <Text style={styles.text} numberOfLines={1}>
          {label} layover · flight at {depLocal}
        </Text>
        <ChevronRight size={15} color={color.onInkMute} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 40 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    backgroundColor: color.ink, borderRadius: 999,
    paddingHorizontal: space.lg, paddingVertical: 10,
    shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
    elevation: 6, maxWidth: '86%',
  },
  pulseDot: { width: dot.s7, height: dot.s7, borderRadius: dot.s7 / 2, backgroundColor: color.signal },
  text: { ...t.small, fontWeight: '700', color: color.onInk, flexShrink: 1 },
});
