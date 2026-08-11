/**
 * PassportTabReorderSheet — drag-to-reorder the five Passport content tabs.
 *
 * Shows a live preview of the tab bar as the user reorders.
 * Each row has a drag grip (pan responder) plus Move Left / Move Right
 * buttons for full keyboard/accessibility support.
 * Saves via PATCH /me/profile (passportTabOrder). "Reset" restores
 * canonical order (persists null).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, Modal, Pressable, StyleSheet, Animated,
  PanResponder, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { GripVertical, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react-native';
import { updateMyProfile } from '../../services/profile.ts';
import {
  CANONICAL_TAB_ORDER, TAB_LABELS, isCanonicalTabOrder, resolveTabOrder,
  type PassportTabKey,
} from './passportTabs.ts';
import { PP, PP_LABEL } from '../../theme/passportTokens.ts';
import { space, radius, type as t } from '../../theme/tokens.ts';
import { PassportReorderRowIndex } from './PassportReorderRowIndex.tsx';

const ROW_HEIGHT = 56;

interface Props {
  visible: boolean;
  initialOrder: string[] | null | undefined;
  onClose: () => void;
  /** Called with the saved order after a successful save. */
  onSaved: (order: PassportTabKey[]) => void;
}

export function PassportTabReorderSheet({ visible, initialOrder, onClose, onSaved }: Props) {
  const [order, setOrder] = useState<PassportTabKey[]>(() => resolveTabOrder(initialOrder));
  const [dragKey, setDragKey] = useState<PassportTabKey | null>(null);
  const [saving, setSaving] = useState(false);
  const dragY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) setOrder(resolveTabOrder(initialOrder));
  }, [visible, initialOrder]);

  // Refs so PanResponder always sees fresh state.
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragKeyRef = useRef(dragKey);
  dragKeyRef.current = dragKey;
  const startIndexRef = useRef(0);
  const dyOffsetRef = useRef(0);

  const beginDrag = useCallback((key: PassportTabKey) => {
    startIndexRef.current = orderRef.current.indexOf(key);
    dragY.setValue(0);
    setDragKey(key);
  }, [dragY]);

  const endDrag = useCallback(() => {
    setDragKey(null);
    dragY.setValue(0);
  }, [dragY]);

  const makeResponder = useCallback((key: PassportTabKey) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderGrant: () => {
        dyOffsetRef.current = 0;
        beginDrag(key);
      },
      onPanResponderMove: (_e, g) => {
        const key2 = dragKeyRef.current;
        if (!key2) return;
        const dy = g.dy - dyOffsetRef.current;
        dragY.setValue(dy);
        const current = orderRef.current;
        const fromIndex = current.indexOf(key2);
        const targetIndex = Math.min(
          current.length - 1,
          Math.max(0, fromIndex + Math.round(dy / ROW_HEIGHT)),
        );
        if (targetIndex !== fromIndex) {
          const next = current.filter((k) => k !== key2);
          next.splice(targetIndex, 0, key2);
          setOrder(next);
          dyOffsetRef.current += (targetIndex - fromIndex) * ROW_HEIGHT;
          dragY.setValue(g.dy - dyOffsetRef.current);
        }
      },
      onPanResponderRelease: endDrag,
      onPanResponderTerminate: endDrag,
    }), [beginDrag, endDrag, dragY]);

  const moveTab = useCallback((key: PassportTabKey, direction: -1 | 1) => {
    setOrder((prev) => {
      const idx = prev.indexOf(key);
      const next = [...prev];
      const target = idx + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }, []);

  const handleReset = useCallback(() => {
    setOrder([...CANONICAL_TAB_ORDER]);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    const canonical = isCanonicalTabOrder(order);
    const res = await updateMyProfile({ passportTabOrder: canonical ? null : order });
    setSaving(false);
    if (!res.ok) {
      Alert.alert('Could not save tab order', res.message ?? 'Please try again.');
      return;
    }
    onSaved(order);
    onClose();
  }, [order, onSaved, onClose]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={rs.overlay} onPress={onClose} />
      <View style={rs.sheet}>
        <View style={rs.handle} />
        <Text style={rs.title}>Arrange your tabs</Text>
        <Text style={rs.subtitle}>
          Drag or use the arrows to choose the order visitors see your Passport content in.
        </Text>

        {/* ── Live tab bar preview ── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={rs.preview}
          contentContainerStyle={rs.previewContent}
        >
          {order.map((key, i) => (
            <View key={key} style={rs.previewTab}>
              <Text style={rs.previewTabText}>{TAB_LABELS[key].toUpperCase()}</Text>
              {i === 0 && <View style={rs.previewIndicator} />}
            </View>
          ))}
        </ScrollView>

        {/* ── Drag rows ── */}
        <View style={{ height: ROW_HEIGHT * order.length, marginTop: space.md }}>
          {order.map((key, index) => {
            const isDragging = dragKey === key;
            return (
              <Animated.View
                key={key}
                style={[
                  rs.row,
                  { top: index * ROW_HEIGHT },
                  isDragging && {
                    transform: [{ translateY: dragY }],
                    zIndex: 10, elevation: 6,
                    shadowColor: PP.ink, shadowOpacity: 0.18, shadowRadius: 10,
                    backgroundColor: PP.paper,
                  },
                ]}
              >
                <PassportReorderRowIndex index={index} />
                <Text style={rs.rowLabel}>{TAB_LABELS[key]}</Text>

                {/* Accessible move buttons */}
                <Pressable
                  style={rs.arrowBtn}
                  onPress={() => moveTab(key, -1)}
                  disabled={index === 0}
                  hitSlop={8}
                  accessibilityLabel={`Move ${TAB_LABELS[key]} left`}
                >
                  <ChevronLeft size={16} color={index === 0 ? PP.borderLight : PP.inkMuted} />
                </Pressable>
                <Pressable
                  style={rs.arrowBtn}
                  onPress={() => moveTab(key, 1)}
                  disabled={index === order.length - 1}
                  hitSlop={8}
                  accessibilityLabel={`Move ${TAB_LABELS[key]} right`}
                >
                  <ChevronRight size={16} color={index === order.length - 1 ? PP.borderLight : PP.inkMuted} />
                </Pressable>

                {/* Drag grip */}
                <View
                  {...makeResponder(key).panHandlers}
                  style={rs.grip}
                  accessibilityLabel={`Drag to reorder ${TAB_LABELS[key]}`}
                >
                  <GripVertical size={20} color={PP.inkMuted} />
                </View>
              </Animated.View>
            );
          })}
        </View>

        <View style={rs.footer}>
          <Pressable style={rs.resetBtn} onPress={handleReset} disabled={saving}>
            <RotateCcw size={14} color={PP.inkMuted} />
            <Text style={rs.resetText}>Reset</Text>
          </Pressable>
          <Pressable
            style={[rs.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save tab order"
          >
            {saving
              ? <ActivityIndicator size="small" color={PP.paper} />
              : <Text style={rs.saveText}>Save order</Text>}
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const rs = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.32)' },
  sheet: {
    backgroundColor: PP.paper,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: 36,
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: PP.borderLight, alignSelf: 'center', marginBottom: space.md,
  },
  title: { ...t.bodyStrong, color: PP.ink, fontSize: 17, fontWeight: '700', textAlign: 'center' },
  subtitle: {
    ...t.small, color: PP.inkMuted, textAlign: 'center',
    marginTop: 4, lineHeight: 17, paddingHorizontal: space.md,
  },

  // Live preview
  preview: {
    borderBottomWidth: 1,
    borderBottomColor: PP.borderLight,
    marginTop: space.lg,
    marginHorizontal: -space.lg,
  },
  previewContent: {
    flexDirection: 'row',
    paddingHorizontal: space.lg,
  },
  previewTab: {
    paddingHorizontal: 10, alignItems: 'center', paddingVertical: 8, position: 'relative',
  },
  previewTabText: {
    ...PP_LABEL, fontSize: 9, color: PP.inkMuted, letterSpacing: 1,
  },
  previewIndicator: {
    position: 'absolute', bottom: -1, left: '15%', right: '15%',
    height: 2, borderRadius: 1, backgroundColor: PP.ink,
  },

  // Drag rows
  row: {
    position: 'absolute', left: 0, right: 0, height: ROW_HEIGHT,
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: PP.borderLight,
    backgroundColor: PP.paper,
  },

  rowLabel: { ...t.bodyStrong, color: PP.ink, fontSize: 15, flex: 1 },
  arrowBtn: {
    paddingVertical: 10, paddingHorizontal: 4,
  },
  grip: { paddingVertical: 14, paddingLeft: 8, paddingRight: 0 },

  // Footer
  footer: {
    flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.lg,
  },
  resetBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: space.md, paddingVertical: 12,
    borderRadius: radius.pill, borderWidth: 1, borderColor: PP.borderLight,
  },
  resetText: { ...t.small, color: PP.inkMuted, fontWeight: '600' },
  saveBtn: {
    flex: 1, backgroundColor: PP.ink, borderRadius: radius.pill,
    paddingVertical: 13, alignItems: 'center',
  },
  saveText: { ...t.bodyStrong, color: PP.paper, fontWeight: '700' },
});
