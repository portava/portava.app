/**
 * DatePickerField (web) — browser-native date/time picker fallback.
 *
 * Renders an HTML <input type="date"> (or type="time") so web users get the
 * browser's built-in picker instead of typing raw text. Value stays an ISO
 * string ("YYYY-MM-DD" or "HH:MM") so callers are unchanged from native.
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Calendar, Clock, X } from 'lucide-react-native';
import { color, space, radius } from '../theme/tokens';

export interface DatePickerFieldProps {
  value: string;
  onChange: (dateStr: string) => void;
  placeholder?: string;
  style?: object;
  mode?: 'date' | 'time';
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

export function DatePickerField({ value, onChange, style, mode = 'date' }: DatePickerFieldProps) {
  const Icon = mode === 'time' ? Clock : Calendar;
  return (
    <View style={[dp.field, style]}>
      <Icon size={15} color={value ? color.ink : color.faint} />
      <input
        type={mode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={inputStyle}
        aria-label={mode === 'time' ? 'Select time' : 'Select date'}
      />
      {value ? (
        <Pressable hitSlop={8} onPress={() => onChange('')} accessibilityLabel="Clear">
          <X size={14} color={color.mute} />
        </Pressable>
      ) : null}
    </View>
  );
}

const dp = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
});
