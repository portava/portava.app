import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { CalendarClock, ChevronRight } from 'lucide-react-native';
import type { AvailabilityStatus } from '../types/models.ts';
import { STATUS_LABEL } from '../lib/availability.ts';
import { color, space, radius, type as t, dot } from '../theme/tokens.ts';

/**
 * Compact availability status card. Display-only this pass.
 * Edit routes to a safe placeholder until the editor screen exists.
 */
export function AvailabilityCard({ status }: { status: AvailabilityStatus }) {
  const notSet = status === 'not_set';
  const live = status === 'open_tonight' || status === 'trip_active';
  return (
    <Pressable style={styles.card} onPress={() => router.push('/availability')}>
      <View style={[styles.dot, { backgroundColor: live ? color.signal : notSet ? color.faint : color.deep }]} />
      <CalendarClock size={16} color={color.ink} />
      <View style={{ flex: 1 }}>
        <Text style={styles.label}>{STATUS_LABEL[status]}</Text>
        <Text style={styles.cta}>{notSet ? 'Set your availability' : 'Edit availability'}</Text>
      </View>
      <ChevronRight size={16} color={color.mute} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paperRaised, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.md,
    marginTop: space.sm,
  },
  dot: { width: dot.s8, height: dot.s8, borderRadius: dot.s8 / 2 },
  label: { ...t.bodyStrong, color: color.ink },
  cta: { ...t.small, color: color.mute, marginTop: 1 },
});
