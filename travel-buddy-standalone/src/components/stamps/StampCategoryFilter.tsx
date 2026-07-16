/**
 * stamps/StampCategoryFilter — horizontal pill strip for filtering
 * the stamp grid by category. "All" clears the filter.
 */
import React from 'react';
import { ScrollView, Pressable, Text, StyleSheet, View } from 'react-native';
import { color, space, radius, type as t } from '../../theme/tokens.ts';

export type StampCategory =
  | ''
  | 'location'
  | 'trips'
  | 'events'
  | 'social'
  | 'safety'
  | 'rent_buddy';

const CATEGORIES: { value: StampCategory; label: string }[] = [
  { value: '',           label: 'All' },
  { value: 'location',   label: 'Location' },
  { value: 'trips',      label: 'Trips' },
  { value: 'events',     label: 'Events' },
  { value: 'social',     label: 'Social' },
  { value: 'safety',     label: 'Safety' },
  { value: 'rent_buddy', label: 'Rent a Buddy' },
];

interface Props {
  selected: StampCategory;
  onCategoryChange: (cat: StampCategory) => void;
}

export function StampCategoryFilter({ selected, onCategoryChange }: Props) {
  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {CATEGORIES.map((c) => (
          <Pressable
            key={c.value}
            style={[styles.pill, selected === c.value && styles.pillActive]}
            onPress={() => onCategoryChange(c.value)}
            hitSlop={4}
          >
            <Text style={[styles.pillText, selected === c.value && styles.pillTextActive]}>
              {c.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: space.sm },
  row:  { paddingHorizontal: space.lg, gap: space.xs, alignItems: 'center' },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.haze,
    backgroundColor: color.paper,
  },
  pillActive: {
    borderColor: color.signal,
    backgroundColor: '#FFF0F3',
  },
  pillText:       { ...t.small, color: color.mute, fontWeight: '600' },
  pillTextActive: { color: color.signal },
});
