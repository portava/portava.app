/**
 * DurationPicker — bottom-sheet duration/timer selector.
 *
 * Used for: highlight expiration, countdown timers, activity length,
 * session windows, and any "how long" field.
 *
 * value / onChange work in SECONDS.
 *
 * Props:
 *   visible     — sheet visibility
 *   value       — selected duration in seconds (null = none)
 *   onChange    — called with seconds (or null)
 *   onClose     — dismiss
 *   title       — sheet title
 *   options     — override the default chip list
 *   allowClear  — show "No duration" option
 */
import React, { useState, useEffect } from 'react';
import {
  View, Text, Pressable, Modal, StyleSheet, ScrollView,
} from 'react-native';
import { X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { color, space, radius, type as t } from '../../theme/tokens.ts';
import { formatDuration } from '../../lib/dateTime/formatters.ts';

export interface DurationOption {
  label: string;
  seconds: number;
  sub?: string;
}

const HOURS = 3600;

export const HIGHLIGHT_EXPIRY_OPTIONS: DurationOption[] = [
  { label: '3 h', seconds: 3 * HOURS, sub: 'Short story' },
  { label: '6 h', seconds: 6 * HOURS, sub: 'Half day' },
  { label: '12 h', seconds: 12 * HOURS },
  { label: '24 h', seconds: 24 * HOURS, sub: 'Default' },
  { label: '48 h', seconds: 48 * HOURS },
];

export const DEFAULT_DURATION_OPTIONS: DurationOption[] = [
  { label: '15 min', seconds: 15 * 60 },
  { label: '30 min', seconds: 30 * 60 },
  { label: '1 h', seconds: HOURS },
  { label: '2 h', seconds: 2 * HOURS },
  { label: '3 h', seconds: 3 * HOURS },
  { label: '6 h', seconds: 6 * HOURS },
  { label: '12 h', seconds: 12 * HOURS },
  { label: '24 h', seconds: 24 * HOURS },
  { label: '48 h', seconds: 48 * HOURS },
];

interface Props {
  visible: boolean;
  value?: number | null;
  onChange: (seconds: number | null) => void;
  onClose: () => void;
  title?: string;
  options?: DurationOption[];
  allowClear?: boolean;
  showChips?: boolean;
}

export function DurationPicker({
  visible, value, onChange, onClose, title, options, allowClear = false, showChips = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const list = options ?? DEFAULT_DURATION_OPTIONS;
  const [selected, setSelected] = useState<number | null>(value ?? null);

  useEffect(() => {
    if (visible) setSelected(value ?? null);
  }, [visible]);

  function pick(s: number) {
    setSelected(s);
    onChange(s);
    onClose();
  }

  if (showChips) {
    return (
      <View style={chips.container}>
        {list.map((o) => (
          <Pressable
            key={o.seconds}
            style={[chips.chip, selected === o.seconds && chips.chipSelected]}
            onPress={() => pick(o.seconds)}
          >
            <Text style={[chips.chipText, selected === o.seconds && chips.chipTextSelected]}>
              {o.label}
            </Text>
            {o.sub && (
              <Text style={[chips.chipSub, selected === o.seconds && chips.chipSubSelected]}>
                {o.sub}
              </Text>
            )}
          </Pressable>
        ))}
        {allowClear && selected !== null && (
          <Pressable style={chips.chip} onPress={() => { setSelected(null); onChange(null); onClose(); }}>
            <Text style={chips.chipText}>Clear</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.overlay}>
        <Pressable style={s.backdrop} onPress={onClose} />
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.header}>
            <Text style={s.title}>{title ?? 'Select Duration'}</Text>
            <Pressable onPress={onClose} style={s.closeBtn} hitSlop={12}>
              <X size={18} color={color.mute} />
            </Pressable>
          </View>

          {selected !== null && (
            <Text style={s.current}>{formatDuration(selected)} selected</Text>
          )}

          <ScrollView style={s.scroll} contentContainerStyle={s.list} showsVerticalScrollIndicator={false}>
            {list.map((o) => (
              <Pressable
                key={o.seconds}
                style={[s.row, selected === o.seconds && s.rowSelected]}
                onPress={() => pick(o.seconds)}
              >
                <Text style={[s.rowLabel, selected === o.seconds && s.rowLabelSelected]}>
                  {o.label}
                </Text>
                {o.sub && (
                  <Text style={[s.rowSub, selected === o.seconds && s.rowSubSelected]}>
                    {o.sub}
                  </Text>
                )}
              </Pressable>
            ))}

            {allowClear && (
              <Pressable style={s.row} onPress={() => { onChange(null); onClose(); }}>
                <Text style={[s.rowLabel, { color: color.mute }]}>No duration</Text>
              </Pressable>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(17,17,15,0.5)' },
  sheet: {
    backgroundColor: color.paper,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingTop: space.md,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: space.xl, paddingBottom: space.md,
  },
  title: { ...t.heading, color: color.ink, flex: 1 },
  closeBtn: { padding: 4 },
  current: { ...t.small, color: color.signal, fontWeight: '600', paddingHorizontal: space.xl, paddingBottom: space.sm },
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
});

const chips = StyleSheet.create({
  container: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    paddingHorizontal: space.md, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze,
    backgroundColor: color.paperRaised, alignItems: 'center',
  },
  chipSelected: { borderColor: color.signal, backgroundColor: `${color.signal}18` },
  chipText: { ...t.small, color: color.ink, fontWeight: '600' },
  chipTextSelected: { color: color.signal },
  chipSub: { ...t.small, color: color.mute, fontSize: 10 },
  chipSubSelected: { color: color.signal },
});
