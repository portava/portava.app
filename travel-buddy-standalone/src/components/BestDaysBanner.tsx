/**
 * BestDaysBanner — shows up to 3 days where the most members are free.
 * Hidden when bestDays is empty or fewer than 2 members overlap.
 * Tapping a chip calls onDayPress(date) — the parent opens the day-summary modal.
 */
import React from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Sparkles } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

export interface BestDay { date: string; count: number; }

function formatChipDate(date: string): string {
  return new Date(date + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

interface BestDaysBannerProps {
  bestDays: BestDay[];
  totalMembers: number;
  onDayPress: (date: string) => void;
}

export function BestDaysBanner({ bestDays, totalMembers, onDayPress }: BestDaysBannerProps) {
  if (bestDays.length === 0) return null;

  return (
    <View style={b.wrap}>
      <View style={b.headerRow}>
        <Sparkles size={13} color={color.signal} />
        <Text style={b.heading}>Best days to meet</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={b.chips}>
        {bestDays.map((d) => (
          <Pressable key={d.date} style={b.chip} onPress={() => onDayPress(d.date)}>
            <Text style={b.chipDate}>{formatChipDate(d.date)}</Text>
            <Text style={b.chipCount}>{d.count}/{totalMembers} free</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const b = StyleSheet.create({
  wrap: {
    backgroundColor: color.signal + '0D',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.signal + '33',
    paddingTop: space.sm + 2,
    paddingBottom: space.sm,
    paddingHorizontal: space.md,
    gap: space.xs ?? 4,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  heading: { ...t.small, color: color.signal, fontWeight: '700', fontSize: 12 },
  chips: { flexDirection: 'row', gap: space.sm, paddingTop: space.xs ?? 4 },
  chip: {
    backgroundColor: color.paperRaised,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.signal + '44',
    paddingHorizontal: space.md,
    paddingVertical: space.xs ?? 4,
    gap: 1,
  },
  chipDate:  { ...t.small, color: color.ink, fontWeight: '700', fontSize: 12 },
  chipCount: { ...t.small, color: color.signal, fontWeight: '600', fontSize: 10 },
});
