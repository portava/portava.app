/**
 * MemoryTypePicker — §4 `MemoryType` on the Memory composer (census H40).
 *
 * Renders NOTHING until GET /api/memory-types answers `enabled: true`: while
 * memory_type_enabled is off the server refuses a type, and a picker for a
 * choice that would be refused is not offered. A failed check is treated the
 * same way — the composer works exactly as it did before this existed.
 *
 * One chip per type; tapping the selected chip clears it. "Not chosen" on a new
 * Memory means the server's default (MOMENT, open owner question Q-H40), and the
 * hint says so; on an existing Memory it means "no type".
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, space, type as t } from '../../../theme/tokens.ts';
import { fetchMemoryTypes, MEMORY_TYPE_LABELS, type MemoryType } from './memoryCanonical.ts';

/** `enabled` once the server has said so; `types` in the server's order. */
export function useMemoryTypes(): { enabled: boolean; types: MemoryType[]; defaultType: MemoryType | null } {
  const [state, setState] = useState<{ enabled: boolean; types: MemoryType[]; defaultType: MemoryType | null }>({ enabled: false, types: [], defaultType: null });
  useEffect(() => {
    let cancelled = false;
    void fetchMemoryTypes().then((r) => {
      if (cancelled || !r.ok) return;
      setState({ enabled: r.enabled && r.types.length > 0, types: r.types, defaultType: r.defaultType });
    });
    return () => { cancelled = true; };
  }, []);
  return state;
}

export function MemoryTypePicker({
  value, onChange, disabled = false, mode,
}: {
  value: MemoryType | null;
  onChange: (next: MemoryType | null) => void;
  disabled?: boolean;
  /** `create`: not chosen = the server's default. `edit`: not chosen = no type. */
  mode: 'create' | 'edit';
}) {
  const { enabled, types, defaultType } = useMemoryTypes();
  if (!enabled) return null;
  return (
    <View style={s.section} testID="memory-type-picker">
      <Text style={s.label}>What kind of memory is this?</Text>
      <View style={s.row}>
        {types.map((type) => {
          const active = value === type;
          return (
            <Pressable
              key={type}
              onPress={() => onChange(active ? null : type)}
              disabled={disabled}
              style={[s.chip, active && s.chipActive]}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={MEMORY_TYPE_LABELS[type]}
              testID={`memory-type-${type}`}
            >
              <Text style={[s.chipText, active && s.chipTextActive]}>{MEMORY_TYPE_LABELS[type]}</Text>
            </Pressable>
          );
        })}
      </View>
      {value === null ? (
        <Text style={s.hint} testID="memory-type-hint">
          {mode === 'create' && defaultType
            ? `Not chosen: it will be saved as ${MEMORY_TYPE_LABELS[defaultType]}.`
            : 'Not chosen.'}
        </Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  section: { gap: space.sm },
  label: { ...(t.bodyStrong as object), color: color.ink },
  hint: { ...(t.small as object), color: color.mute },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // The same chip the composer's §10 precision row uses (app/memory/new.tsx), so the two rows read as one control family.
  chip: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.pill,
    paddingHorizontal: space.md, paddingVertical: space.xs + 2, backgroundColor: color.paperRaised,
  },
  chipActive: { borderColor: color.signal, backgroundColor: '#FFF0F3' },
  chipText: { ...(t.small as object), color: color.ink },
  chipTextActive: { color: color.signal, fontWeight: '700' },
});
