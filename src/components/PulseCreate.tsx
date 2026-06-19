import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
  X, Check, Plus, PenLine, HelpCircle, CalendarPlus, Gem, Image as ImageIcon,
} from 'lucide-react-native';
import { PULSE_FILTERS } from '../types/models';
import type { PulseFilter } from '../types/models';
import { color, space, radius, type as t, shadow, layout } from '../theme/tokens';

/* ── Filter bottom sheet ── */
export function PulseFilterSheet({
  visible, active, onToggle, onClear, onClose,
}: {
  visible: boolean;
  active: PulseFilter[];
  onToggle: (f: PulseFilter) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={fs.backdrop} onPress={onClose} />
      <View style={fs.sheet}>
        <View style={fs.grab} />
        <View style={fs.head}>
          <Text style={fs.title}>Filter Pulse</Text>
          <View style={{ flex: 1 }} />
          {active.length > 0 && (
            <Pressable onPress={onClear} hitSlop={layout.hitSlop}><Text style={fs.clear}>Clear ({active.length})</Text></Pressable>
          )}
          <Pressable onPress={onClose} hitSlop={layout.hitSlop} style={fs.x}><X size={18} color={color.ink} /></Pressable>
        </View>
        <ScrollView contentContainerStyle={fs.chips}>
          {PULSE_FILTERS.map((f) => {
            const on = active.includes(f);
            return (
              <Pressable key={f} style={[fs.chip, on && fs.chipOn]} onPress={() => onToggle(f)}>
                {on ? <Check size={14} color={color.onInk} /> : null}
                <Text style={[fs.chipText, on && fs.chipTextOn]}>{f}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable style={fs.apply} onPress={onClose}>
          <Text style={fs.applyText}>Show results</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/* ── Floating create button + menu ── */
export function PulseCreateMenu({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const items = [
    { label: 'Post Update', icon: <PenLine size={18} color={color.signal} />, go: '/create' },
    { label: 'Ask Question', icon: <HelpCircle size={18} color={color.deep} />, go: '/create' },
    { label: 'Create Plan', icon: <CalendarPlus size={18} color={color.success} />, go: '/trip/new' },
    { label: 'Share Hidden Gem', icon: <Gem size={18} color={color.success} />, go: '/create' },
    { label: 'Share a Moment', icon: <ImageIcon size={18} color={color.warn} />, go: '/create' },
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={cm.backdrop} onPress={onClose}>
        <View style={cm.menu}>
          {items.map((it) => (
            <Pressable key={it.label} style={({ pressed }) => [cm.item, pressed && { opacity: layout.pressedOpacity }]}
              onPress={() => { onClose(); router.push(it.go as any); }}>
              <View style={cm.itemIcon}>{it.icon}</View>
              <Text style={cm.itemText}>{it.label}</Text>
            </Pressable>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

export function PulseFAB({ onPress }: { onPress: () => void }) {
  return (
    <Pressable style={({ pressed }) => [fab.btn, pressed && { opacity: layout.pressedOpacity }]} onPress={onPress}>
      <Plus size={26} color={color.onInk} />
    </Pressable>
  );
}

const fs = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: color.paper, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: space.xxl, gap: space.md, ...shadow.float },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: color.haze },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...t.title, color: color.ink, fontSize: 19 },
  clear: { ...t.small, color: color.signal, fontWeight: '700' },
  x: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, borderWidth: 1, borderColor: color.haze, backgroundColor: color.paperRaised },
  chipOn: { backgroundColor: color.signal, borderColor: color.signal },
  chipText: { ...t.small, fontWeight: '700', color: color.ink },
  chipTextOn: { color: color.onInk },
  apply: { backgroundColor: color.ink, borderRadius: radius.md, paddingVertical: space.md, alignItems: 'center' },
  applyText: { ...t.bodyStrong, color: color.onInk },
});

const cm = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(17,17,15,0.4)', justifyContent: 'flex-end', padding: space.lg, paddingBottom: 96 },
  menu: { backgroundColor: color.paper, borderRadius: radius.lg, overflow: 'hidden', ...shadow.float },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, borderBottomWidth: 1, borderBottomColor: color.haze },
  itemIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: color.paperRaised, borderWidth: 1, borderColor: color.haze, alignItems: 'center', justifyContent: 'center' },
  itemText: { ...t.bodyStrong, color: color.ink },
});

const fab = StyleSheet.create({
  btn: { position: 'absolute', right: space.lg, bottom: space.xl, width: 58, height: 58, borderRadius: 29, backgroundColor: color.signal, alignItems: 'center', justifyContent: 'center', ...shadow.float },
});
