/**
 * FeedModeSwitcher — the persistent For You / Following control (Wall spec §5/§35).
 *
 * Simple, always-present, near the feed start. For You is the ranked/exploratory
 * default; Following is the strict-chronology trust anchor. The control never
 * disappears, so the user can always choose predictable chronology (spec §40
 * non-negotiable #3). Focus order is logical for screen readers (spec §36).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../../../theme/tokens.ts';
import type { WallMode } from '../types/wallProjection.ts';

const MODES: { key: WallMode; label: string }[] = [
  { key: 'for_you', label: 'For You' },
  { key: 'following', label: 'Following' },
];

export function FeedModeSwitcher({
  mode,
  onChange,
}: {
  mode: WallMode;
  onChange: (mode: WallMode) => void;
}) {
  return (
    <View style={s.container} accessibilityRole="tablist">
      {MODES.map(({ key, label }) => {
        const active = key === mode;
        return (
          <Pressable
            key={key}
            testID={`wall-mode-${key}`}
            style={[s.tab, active && s.tabActive]}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
          >
            <Text style={[s.label, active && s.labelActive]}>{label}</Text>
            {active ? <View style={s.underline} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: color.paper,
    borderBottomWidth: 1,
    borderBottomColor: color.haze,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.md,
  },
  tabActive: {},
  label: { ...t.bodyStrong, color: color.faint, fontWeight: '600' },
  labelActive: { color: color.ink, fontWeight: '800' },
  underline: {
    position: 'absolute',
    bottom: 0,
    height: 2,
    width: '46%',
    borderRadius: radius.pill,
    backgroundColor: color.signal,
  },
});
