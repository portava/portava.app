/**
 * GlobalTimePicker — app-wide time picker with quick presets.
 *
 * Shows a bottom sheet with preset options (Now, Morning, Afternoon, Evening…)
 * and a "Custom" option that opens the native time picker.
 *
 * Props:
 *   visible    — sheet visibility
 *   value      — currently selected time as "HH:mm" (24h, local)
 *   onChange   — called with "HH:mm" string (or null to clear)
 *   onClose    — dismiss sheet
 *   title      — optional sheet title
 *   presets    — override preset list
 *   allowClear — show a "No time" option (default false)
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ScrollView, Platform,
} from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { X, Clock } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../../theme/tokens';
import { fromHHmm, toHHmm, formatDisplayTime } from '../../lib/dateTime/formatters';

export interface TimePreset {
  label: string;
  value: string;
  sub?: string;
}

const DEFAULT_PRESETS: TimePreset[] = [
  { label: 'Morning', value: '08:00', sub: '8:00 AM' },
  { label: 'Noon', value: '12:00', sub: '12:00 PM' },
  { label: 'Afternoon', value: '14:00', sub: '2:00 PM' },
  { label: 'Evening', value: '18:00', sub: '6:00 PM' },
  { label: 'Tonight', value: '21:00', sub: '9:00 PM' },
  { label: 'Late Night', value: '23:00', sub: '11:00 PM' },
];

interface Props {
  visible: boolean;
  value?: string | null;
  onChange: (value: string | null) => void;
  onClose: () => void;
  title?: string;
  presets?: TimePreset[];
  allowClear?: boolean;
}

export function GlobalTimePicker({
  visible, value, onChange, onClose, title, presets, allowClear = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const list = presets ?? DEFAULT_PRESETS;

  const [showNative, setShowNative] = useState(false);
  const [nativeDate, setNativeDate] = useState<Date>(new Date());
  const [pendingValue, setPendingValue] = useState<string | null>(value ?? null);

  useEffect(() => {
    if (visible) {
      setPendingValue(value ?? null);
      setShowNative(false);
      const d = value ? fromHHmm(value) : new Date();
      setNativeDate(d ?? new Date());
    }
  }, [visible]);

  function pickPreset(preset: TimePreset) {
    setPendingValue(preset.value);
    onChange(preset.value);
    onClose();
  }

  function pickNow() {
    const now = new Date();
    const hhmm = toHHmm(now);
    setPendingValue(hhmm);
    onChange(hhmm);
    onClose();
  }

  function openCustom() {
    const d = pendingValue ? fromHHmm(pendingValue) : new Date();
    setNativeDate(d ?? new Date());
    setShowNative(true);
  }

  function handleNativeChange(event: DateTimePickerEvent, selectedDate?: Date) {
    if (Platform.OS === 'android') {
      setShowNative(false);
      if (event.type === 'set' && selectedDate) {
        const hhmm = toHHmm(selectedDate);
        setPendingValue(hhmm);
        onChange(hhmm);
        onClose();
      }
    } else {
      if (selectedDate) {
        setNativeDate(selectedDate);
        const hhmm = toHHmm(selectedDate);
        setPendingValue(hhmm);
      }
    }
  }

  function confirmCustom() {
    const hhmm = toHHmm(nativeDate);
    onChange(hhmm);
    setShowNative(false);
    onClose();
  }

  const selectedLabel = pendingValue
    ? (() => { const d = fromHHmm(pendingValue); return d ? formatDisplayTime(d) : pendingValue; })()
    : null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.overlay}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.header}>
            <Text style={s.title}>{title ?? 'Select Time'}</Text>
            <Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {selectedLabel && (
            <View style={s.currentRow}>
              <Clock size={14} color={color.signal} />
              <Text style={s.currentText}>{selectedLabel}</Text>
            </View>
          )}

          <ScrollView style={s.scroll} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {/* Now */}
            <Pressable style={s.row} onPress={pickNow}>
              <Text style={s.rowLabel}>Now</Text>
              <Text style={s.rowSub}>{formatDisplayTime(new Date())}</Text>
            </Pressable>

            {/* Presets */}
            {list.map((p) => (
              <Pressable
                key={p.value}
                style={[s.row, pendingValue === p.value && s.rowSelected]}
                onPress={() => pickPreset(p)}
              >
                <Text style={[s.rowLabel, pendingValue === p.value && s.rowLabelSelected]}>
                  {p.label}
                </Text>
                {p.sub && (
                  <Text style={[s.rowSub, pendingValue === p.value && s.rowSubSelected]}>
                    {p.sub}
                  </Text>
                )}
              </Pressable>
            ))}

            {/* Custom */}
            <Pressable style={s.row} onPress={openCustom}>
              <Text style={s.rowLabel}>Custom…</Text>
              <Text style={s.rowSub}>Choose any time</Text>
            </Pressable>

            {/* Clear */}
            {allowClear && (
              <Pressable style={s.row} onPress={() => { onChange(null); onClose(); }}>
                <Text style={[s.rowLabel, { color: color.mute }]}>No time</Text>
              </Pressable>
            )}
          </ScrollView>

          {/* Web fallback: browser-native time input for custom */}
          {showNative && Platform.OS === 'web' && (
            <View style={s.webPickerRow}>
              <input
                type="time"
                value={toHHmm(nativeDate)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const d = fromHHmm(v);
                  if (d) setNativeDate(d);
                }}
                style={webInputStyle}
                aria-label="Select time"
              />
              <Pressable style={s.doneBtn} onPress={confirmCustom}>
                <Text style={s.doneBtnText}>Done</Text>
              </Pressable>
            </View>
          )}

          {/* Native time picker for custom */}
          {showNative && Platform.OS !== 'web' && (
            <>
              <DateTimePicker
                mode="time"
                value={nativeDate}
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={handleNativeChange}
              />
              {Platform.OS === 'ios' && (
                <Pressable style={s.doneBtn} onPress={confirmCustom}>
                  <Text style={s.doneBtnText}>Done</Text>
                </Pressable>
              )}
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const webInputStyle: React.CSSProperties = {
  flex: 1,
  border: `1px solid ${color.haze}`,
  borderRadius: radius.md,
  background: color.paper,
  fontSize: 15,
  fontFamily: 'inherit',
  color: color.ink,
  padding: '8px 12px',
  minWidth: 0,
};

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.5)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.md,
    maxHeight: '75%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.xl, paddingBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { padding: 4 },
  currentRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.xl, paddingBottom: space.md,
  },
  currentText: { ...t.bodyStrong, color: color.signal },
  scroll: { flex: 1 },
  list: { paddingHorizontal: space.xl, paddingBottom: space.lg },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.haze,
  },
  rowSelected: { backgroundColor: `${color.signal}10` },
  rowLabel: { ...t.body, color: color.ink, fontWeight: '600' },
  rowLabelSelected: { color: color.signal },
  rowSub: { ...t.small, color: color.mute },
  rowSubSelected: { color: color.signal },
  webPickerRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.xl, paddingVertical: space.md,
  },
  doneBtn: {
    alignItems: 'flex-end', paddingHorizontal: space.xl, paddingVertical: space.md,
  },
  doneBtnText: { ...t.bodyStrong, color: color.signal, fontWeight: '700' },
});
