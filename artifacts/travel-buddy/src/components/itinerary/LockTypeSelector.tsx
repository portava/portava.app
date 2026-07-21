import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { TripPlanLockType } from '../../types/models.ts';
import { color, radius, type as t } from '../../theme/tokens.ts';

// ── Lock type metadata (shared by selector + badges) ──────────────────────────

export const LOCK_LABEL: Record<TripPlanLockType, string> = {
  fixed:    'Fixed',
  flexible: 'Flexible',
  optional: 'Optional',
};

/** Short explanation of what each lock type means for Autopilot. */
export const LOCK_HINT: Record<TripPlanLockType, string> = {
  fixed:    'Autopilot never moves or replaces this item.',
  flexible: 'Autopilot may reschedule this item to fix conflicts.',
  optional: 'Autopilot may drop or swap this item if plans change.',
};

export const LOCK_STYLE: Record<TripPlanLockType, { bg: string; fg: string }> = {
  fixed:    { bg: '#E2EDF0', fg: color.deep },
  flexible: { bg: color.haze, fg: color.mute },
  optional: { bg: '#F5F0E8', fg: '#8B6914' },
};

export const LOCK_OPTIONS: TripPlanLockType[] = ['fixed', 'flexible', 'optional'];

// ── Selector ──────────────────────────────────────────────────────────────────

export interface LockTypeSelectorProps {
  value: TripPlanLockType;
  onChange: (next: TripPlanLockType) => void;
}

/**
 * Fixed / Flexible / Optional chip row with a hint describing what the
 * selected type means for Autopilot.
 */
export function LockTypeSelector({ value, onChange }: LockTypeSelectorProps) {
  return (
    <View style={ls.wrap}>
      <View style={ls.row}>
        {LOCK_OPTIONS.map((lt) => {
          const active = value === lt;
          return (
            <Pressable
              key={lt}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[ls.chip, active && ls.chipActive]}
              onPress={() => onChange(lt)}
            >
              <Text style={[ls.chipText, active && ls.chipTextActive]}>{LOCK_LABEL[lt]}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={ls.hint}>{LOCK_HINT[value]}</Text>
    </View>
  );
}

const ls = StyleSheet.create({
  wrap:           { gap: 4 },
  row:            { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip:           { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.haze },
  chipActive:     { backgroundColor: color.deep },
  chipText:       { ...t.small, color: color.mute, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  hint:           { ...t.small, color: color.faint },
});
