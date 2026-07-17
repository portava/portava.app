import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';

/** Passport section navigation — Postcards / Trips / Stamps / Map / About. */

export type PassportTabKey = 'postcards' | 'trips' | 'stamps' | 'map' | 'about';

export const PASSPORT_TABS: { key: PassportTabKey; label: string }[] = [
  { key: 'postcards', label: 'Postcards' },
  { key: 'trips', label: 'Trips' },
  { key: 'stamps', label: 'Stamps' },
  { key: 'map', label: 'Map' },
  { key: 'about', label: 'About' },
];

const ACTIVE = '#6945D8';
const INACTIVE = '#475467';

export function PassportTabsBar({
  active,
  onChange,
}: {
  active: PassportTabKey;
  onChange: (tab: PassportTabKey) => void;
}) {
  return (
    <View style={styles.bar}>
      {PASSPORT_TABS.map((t) => {
        const isActive = t.key === active;
        return (
          <Pressable
            key={t.key}
            style={styles.item}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={t.label}
          >
            <Text style={[styles.label, isActive && styles.labelActive]}>{t.label}</Text>
            {isActive ? <View style={styles.indicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 52,
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#EAECF0',
    marginTop: 14,
  },
  item: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 13, fontWeight: '500', color: INACTIVE },
  labelActive: { color: ACTIVE, fontWeight: '600' },
  indicator: {
    position: 'absolute', bottom: 0, height: 3, width: '64%',
    borderRadius: 2, backgroundColor: ACTIVE,
  },
});
