import React from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { color, space, radius, type as t } from '../theme/tokens';

export interface DatePickerFieldProps {
  value: string;
  onChange: (dateStr: string) => void;
  placeholder?: string;
  style?: object;
}

export function DatePickerField({ value, onChange, style }: DatePickerFieldProps) {
  return (
    <TextInput
      style={[dp.input, style]}
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={color.faint}
      keyboardType="numbers-and-punctuation"
    />
  );
}

const dp = StyleSheet.create({
  input: {
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    ...t.body, color: color.ink, backgroundColor: color.paperRaised,
  },
});
