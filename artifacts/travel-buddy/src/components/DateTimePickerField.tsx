/**
 * DateTimePickerField — a pressable date/time-picker input for Expo / React Native.
 *
 * Renders a tappable button showing the selected date or time.
 * On press it surfaces the native @react-native-community/datetimepicker:
 *   iOS     → inline spinner below the button + "Done" to dismiss
 *   Android → system dialog (auto-dismisses on selection or cancel)
 *
 * Props:
 *   value       — selected Date (null = nothing selected yet)
 *   onChange    — called with the newly selected Date
 *   onClear     — optional; when provided a × button appears to clear the value
 *   minimumDate — earliest selectable date (optional, date mode only)
 *   placeholder — string shown when value is null
 *   mode        — 'date' (default) | 'time'
 */
import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { CalendarClock, X } from 'lucide-react-native';
import { color, space, radius, type as t } from '../theme/tokens';

interface Props {
  value: Date | null;
  onChange: (date: Date) => void;
  /** When provided, a × button appears next to the field to reset the value to null. */
  onClear?: () => void;
  minimumDate?: Date;
  placeholder?: string;
  mode?: 'date' | 'time';
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month:   'short',
    day:     'numeric',
    year:    'numeric',
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DatePickerField({
  value, onChange, onClear, minimumDate, placeholder = 'Pick a date', mode = 'date',
}: Props) {
  const [show, setShow] = useState(false);

  function handleChange(event: DateTimePickerEvent, selectedDate?: Date) {
    if (Platform.OS === 'android') {
      setShow(false);
      if (event.type === 'set' && selectedDate) onChange(selectedDate);
    } else {
      if (selectedDate) onChange(selectedDate);
    }
  }

  return (
    <View>
      {/* Field row: picker button + optional clear */}
      <View style={s.row}>
        <Pressable
          style={[s.field, show && s.fieldOpen]}
          onPress={() => setShow((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel={value
            ? (mode === 'time' ? `Time: ${formatTime(value)}` : `Date: ${formatDate(value)}`)
            : placeholder}
        >
          <CalendarClock size={14} color={value ? color.signal : color.faint} />
          <Text style={[s.fieldText, !value && s.placeholder]}>
            {value ? (mode === 'time' ? formatTime(value) : formatDate(value)) : placeholder}
          </Text>
        </Pressable>

        {value && onClear ? (
          <Pressable
            hitSlop={8}
            onPress={() => { setShow(false); onClear(); }}
            accessibilityRole="button"
            accessibilityLabel="Clear"
            style={s.clearBtn}
          >
            <X size={15} color={color.mute} />
          </Pressable>
        ) : null}
      </View>

      {/* Native picker (expands below field on iOS, dialog on Android) */}
      {show && (
        <>
          <DateTimePicker
            mode={mode}
            value={value ?? (mode === 'time' ? new Date() : (minimumDate ?? new Date()))}
            minimumDate={mode === 'date' ? minimumDate : undefined}
            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
            onChange={handleChange}
          />
          {Platform.OS === 'ios' && (
            <Pressable style={s.doneBtn} onPress={() => setShow(false)}>
              <Text style={s.doneBtnText}>Done</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    backgroundColor: color.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.haze,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
  },
  fieldOpen: {
    borderColor: color.signal,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  fieldText: {
    ...t.body,
    color: color.ink,
    flex: 1,
  },
  placeholder: {
    color: color.faint,
  },
  clearBtn: {
    padding: 4,
  },
  doneBtn: {
    alignItems: 'flex-end',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: color.signal,
    borderBottomLeftRadius: radius.md,
    borderBottomRightRadius: radius.md,
    backgroundColor: color.paper,
  },
  doneBtnText: {
    ...t.bodyStrong,
    color: color.signal,
    fontWeight: '700',
  },
});
