import React, { useState } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, Platform,
} from 'react-native';
import { Calendar, X } from 'lucide-react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { color, space, radius, type as t } from '../theme/tokens';

export interface DatePickerFieldProps {
  value: string;
  onChange: (dateStr: string) => void;
  placeholder?: string;
  style?: object;
}

function toDate(dateStr: string): Date {
  if (!dateStr) return new Date();
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? new Date() : d;
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function toYMD(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function DatePickerField({ value, onChange, placeholder = 'Select date', style }: DatePickerFieldProps) {
  const [showPicker, setShowPicker] = useState(false);
  const [tempDate, setTempDate] = useState<Date>(toDate(value));

  const handleOpen = () => {
    setTempDate(toDate(value));
    setShowPicker(true);
  };

  const handleAndroidChange = (event: DateTimePickerEvent, selectedDate?: Date) => {
    setShowPicker(false);
    if (event.type === 'dismissed' || !selectedDate) return;
    onChange(toYMD(selectedDate));
  };

  const handleIOSChange = (_event: DateTimePickerEvent, selectedDate?: Date) => {
    if (selectedDate) setTempDate(selectedDate);
  };

  const handleIOSConfirm = () => {
    setShowPicker(false);
    onChange(toYMD(tempDate));
  };

  const handleIOSCancel = () => {
    setShowPicker(false);
  };

  return (
    <>
      <View style={[dp.field, style]}>
        <Pressable
          style={dp.inner}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={value ? fmtDate(value) : placeholder}
        >
          <Calendar size={15} color={value ? color.ink : color.faint} />
          <Text style={[dp.fieldText, !value && dp.placeholder]} numberOfLines={1}>
            {value ? fmtDate(value) : placeholder}
          </Text>
        </Pressable>
        {value ? (
          <Pressable hitSlop={8} onPress={() => onChange('')} accessibilityLabel="Clear date">
            <X size={14} color={color.mute} />
          </Pressable>
        ) : null}
      </View>

      {showPicker && Platform.OS === 'android' && (
        <DateTimePicker
          value={toDate(value)}
          mode="date"
          display="default"
          onChange={handleAndroidChange}
        />
      )}

      {showPicker && Platform.OS === 'ios' && (
        <Modal transparent animationType="slide" onRequestClose={handleIOSCancel}>
          <Pressable style={dp.overlay} onPress={handleIOSCancel} />
          <View style={dp.iosSheet}>
            <View style={dp.iosBar}>
              <Pressable onPress={handleIOSCancel} hitSlop={8}>
                <Text style={dp.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={handleIOSConfirm} hitSlop={8}>
                <Text style={dp.doneText}>Done</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={tempDate}
              mode="date"
              display="spinner"
              onChange={handleIOSChange}
              style={{ height: 200 }}
            />
          </View>
        </Modal>
      )}
    </>
  );
}

const dp = StyleSheet.create({
  field: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderColor: color.haze, borderRadius: radius.md,
    paddingHorizontal: space.md, paddingVertical: space.sm,
    backgroundColor: color.paperRaised,
  },
  inner: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldText: { ...t.body, color: color.ink, flex: 1 },
  placeholder: { color: color.faint },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  iosSheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingBottom: 34,
  },
  iosBar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space.lg, paddingVertical: space.md,
    borderBottomWidth: 1, borderBottomColor: color.haze,
  },
  cancelText: { ...t.body, color: color.mute },
  doneText: { ...t.bodyStrong, color: color.signal },
});
