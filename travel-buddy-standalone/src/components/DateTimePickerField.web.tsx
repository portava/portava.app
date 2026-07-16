/**
 * DateTimePickerField (web) — browser-native fallback for the Date-based
 * DatePickerField. Renders an HTML <input type="date"> / <input type="time">
 * so web users get a real picker instead of the native module (which is
 * unavailable on web). onChange still emits a Date, matching the native API.
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { CalendarClock, X } from 'lucide-react-native';
import { color, space, radius } from '../theme/tokens.ts';

interface Props {
  value: Date | null;
  onChange: (date: Date) => void;
  onClear?: () => void;
  minimumDate?: Date;
  placeholder?: string;
  mode?: 'date' | 'time';
}

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  fontSize: 14,
  fontFamily: 'inherit',
  color: color.ink,
  padding: 0,
  minWidth: 0,
};

export function DatePickerField({
  value, onChange, onClear, minimumDate, mode = 'date',
}: Props) {
  const str = value ? (mode === 'time' ? toHHMM(value) : toYMD(value)) : '';
  return (
    <View style={s.row}>
      <View style={s.field}>
        <CalendarClock size={14} color={value ? color.signal : color.faint} />
        <input
          type={mode}
          value={str}
          min={mode === 'date' && minimumDate ? toYMD(minimumDate) : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const d = mode === 'time'
              ? new Date(`1970-01-01T${v}:00`)
              : new Date(`${v}T00:00:00`);
            if (!isNaN(d.getTime())) onChange(d);
          }}
          style={inputStyle}
          aria-label={mode === 'time' ? 'Select time' : 'Select date'}
        />
      </View>
      {value && onClear ? (
        <Pressable hitSlop={8} onPress={onClear} accessibilityRole="button" accessibilityLabel="Clear" style={s.clearBtn}>
          <X size={15} color={color.mute} />
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  field: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm,
    backgroundColor: color.paper, borderRadius: radius.md,
    borderWidth: 1, borderColor: color.haze,
    paddingHorizontal: space.md, paddingVertical: space.sm + 2,
  },
  clearBtn: { padding: 4 },
});
